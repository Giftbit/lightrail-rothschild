import * as cassava from "cassava";
import {RouterEvent} from "cassava";
import {csvSerializer} from "../../serializers";
import * as giftbitRoutes from "giftbit-cassava-routes";
import {Pagination, PaginationParams} from "../../model/Pagination";
import {getKnexRead} from "../../utils/dbUtils/connection";
import {filterQuery} from "../../utils/dbUtils/filterQuery";
import {filterAndPaginateQuery} from "../../utils/dbUtils";
import {
    DbTransaction,
    InternalTransactionStep,
    LightrailTransactionStep,
    StripeTransactionStep,
    Transaction
} from "../../model/Transaction";
import {getValues} from "./values/values";
import {ReportTransaction} from "./transactions/ReportTransaction";
import {formatObjectsAmountPropertiesForCurrencyDisplay} from "../../model/Currency";
import {Value} from "../../model/Value";

let reportRowLimit: number;

initializeReportRowLimit(10000);

/**
 * The reports endpoints currently only return text/csv responses: reporting data is typically
 * expected to be in csv format. Also, in order to return Transactions & Values in csv format
 * the objects need to be flattened which means they are structured differently from the json
 * returned by the main list endpoints (GET /v2/transactions, /v2/values).
 * Returning json from the reports endpoints would either mean duplication of the main list
 * endpoints or returning differently structured data which would be inconsistent/confusing.
 */
export function installReportsRest(router: cassava.Router): void {
    router.route("/v2/reports/transactions")
        .method("GET")
        .serializers({"text/csv": csvSerializer})
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireIds("userId");
            auth.requireScopes("lightrailV2:transactions:list");

            const transactionResults = await getReportResults<ReportTransaction>(auth, evt, getTransactionsForReport);

            if (evt.queryStringParameters.formatCurrencies === "true") {
                return {
                    headers: Pagination.toHeaders(evt, transactionResults.pagination),
                    body: await formatObjectsAmountPropertiesForCurrencyDisplay(auth, transactionResults.results, [
                        "transactionAmount",
                        "checkout_subtotal",
                        "checkout_tax",
                        "checkout_discountLightrail",
                        "checkout_paidLightrail",
                        "checkout_paidStripe",
                        "checkout_paidInternal",
                        "checkout_remainder",
                        "marketplace_sellerNet",
                        "marketplace_sellerGross",
                        "marketplace_sellerDiscount",
                    ])
                };
            } else {
                return {
                    headers: Pagination.toHeaders(evt, transactionResults.pagination),
                    body: transactionResults.results
                };
            }
        });

    router.route("/v2/reports/values")
        .method("GET")
        .serializers({"text/csv": csvSerializer})
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireIds("userId");
            auth.requireScopes("lightrailV2:values:list");

            const valueResults = await getReportResults<Value>(auth, evt, getValuesForReport);

            if (evt.queryStringParameters.formatCurrencies === "true") {
                return {
                    headers: Pagination.toHeaders(evt, valueResults.pagination),
                    body: await formatObjectsAmountPropertiesForCurrencyDisplay(auth, valueResults.results, [
                        "balance",
                        "genericCodeOptions.perContact.balance"
                    ])
                };
            } else {
                return {
                    headers: Pagination.toHeaders(evt, valueResults.pagination),
                    body: valueResults.results
                };
            }
        });
}

type ReportCallbackFunction<T> = (auth: giftbitRoutes.jwtauth.AuthorizationBadge, filterParams: { [key: string]: string }, pagination: PaginationParams) => Promise<{ results: T[], pagination: Pagination }>;

async function getReportResults<T>(auth: giftbitRoutes.jwtauth.AuthorizationBadge, evt: RouterEvent, fetchObjectsCallback: ReportCallbackFunction<T>): Promise<{ results: T[], pagination: Pagination }> {
    let paginationParams = Pagination.getPaginationParams(evt, {defaultLimit: reportRowLimit});
    paginationParams.limit += 1;
    paginationParams.maxLimit = reportRowLimit + 1;

    const res = await fetchObjectsCallback(auth, evt.queryStringParameters, paginationParams);

    const requestedLimit = +evt.queryStringParameters["limit"] || reportRowLimit;
    const suppressLimitError = evt.queryStringParameters["suppressLimitError"] === "true";
    const limitedResult = await limitReportSize<T>(res.results, suppressLimitError, requestedLimit);

    paginationParams.limit -= 1;
    paginationParams.maxLimit = reportRowLimit;

    return {
        results: limitedResult as T[],
        pagination: paginationParams
    };
}

export const getValuesForReport: ReportCallbackFunction<Value> = async (auth: giftbitRoutes.jwtauth.AuthorizationBadge, filterParams: { [key: string]: string }, pagination: PaginationParams, showCode: boolean = false): Promise<{ results: Value[], pagination: Pagination }> => {
    const res = await getValues(auth, filterParams, pagination, showCode);
    return {
        results: res.values,
        pagination: res.pagination
    };
};

export const getTransactionsForReport: ReportCallbackFunction<ReportTransaction> = async (auth: giftbitRoutes.jwtauth.AuthorizationBadge, filterParams: { [key: string]: string }, pagination: PaginationParams): Promise<{ results: ReportTransaction[], pagination: Pagination }> => {
    auth.requireIds("userId");

    const knex = await getKnexRead();
    let query = knex("Transactions")
        .select("Transactions.*")
        .where("Transactions.userId", "=", auth.userId);

    if (filterParams["programId"] || filterParams["programId.eq"] || filterParams["programId.in"]) {
        query.join("LightrailTransactionSteps", {
            "Transactions.id": "LightrailTransactionSteps.transactionId",
            "Transactions.userId": "LightrailTransactionSteps.userId"
        })
            .join("Values", {
                "LightrailTransactionSteps.valueId": "Values.id"
            });
        [query] = await filterQuery(query, filterParams, {
            properties: {
                "programId": {
                    type: "string",
                    operators: ["eq", "in"],
                    columnName: "Values.programId",
                }
            }
        });
    }

    const res = await filterAndPaginateQuery<DbTransaction>(query, filterParams, {
        properties: {
            "transactionType": {
                type: "string",
                operators: ["eq", "in"]
            },
            "createdDate": {
                type: "Date",
                operators: ["eq", "gt", "gte", "lt", "lte", "ne"],
                columnName: "Transactions.createdDate"
            },
        }
    }, pagination);

    const transactions = await DbTransaction.toTransactions(res.body, auth.userId);

    return {
        results: transactions.map(txn => ({
            id: txn.id,
            createdDate: txn.createdDate,
            transactionType: txn.transactionType,
            currency: txn.currency,
            transactionAmount: addStepAmounts(txn),
            checkout_subtotal: txn.totals && txn.totals.subtotal || 0,
            checkout_tax: txn.totals && txn.totals.tax || 0,
            checkout_discountLightrail: txn.totals && txn.totals.discountLightrail || 0,
            checkout_paidLightrail: txn.totals && txn.totals.paidLightrail || 0,
            checkout_paidStripe: txn.totals && txn.totals.paidStripe || 0,
            checkout_paidInternal: txn.totals && txn.totals.paidInternal || 0,
            checkout_remainder: txn.totals && txn.totals.remainder || 0,
            marketplace_sellerNet: txn.totals && txn.totals.marketplace && txn.totals.marketplace.sellerNet || null,
            marketplace_sellerGross: txn.totals && txn.totals.marketplace && txn.totals.marketplace.sellerGross || null,
            marketplace_sellerDiscount: txn.totals && txn.totals.marketplace && txn.totals.marketplace.sellerDiscount || null,
            stepsCount: txn.steps.length,
            metadata: txn.metadata && JSON.stringify(txn.metadata).replace(",", ";"), // don't create column breaks
        })),
        pagination: res.pagination
    };
};

function limitReportSize<T>(response: T[], suppressLimitError: boolean, requestedLimit: number): T[] {
    if (response.length > requestedLimit) {
        if (suppressLimitError) {
            return response.slice(0, requestedLimit);
        } else {
            throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.UNPROCESSABLE_ENTITY, `Report query returned too many rows. Please modify your request and try again.`);
        }
    } else {
        return response;
    }
}

function addStepAmounts(txn: Transaction): number {
    if (txn.transactionType === "transfer") {
        return getStepAmount(txn.steps.find(s => getStepAmount(s) > 0));
    } else {
        const amounts = txn.steps.map(step => getStepAmount(step));
        return amounts.reduce((acc, amount) => {
            return acc + amount;
        }, 0);
    }
}

function getStepAmount(step: LightrailTransactionStep | StripeTransactionStep | InternalTransactionStep): number {
    if ((step as LightrailTransactionStep).balanceChange !== undefined) {
        return (step as LightrailTransactionStep).balanceChange;
    } else if ((step as StripeTransactionStep).amount !== undefined) {
        return (step as StripeTransactionStep).amount;
    } else if ((step as InternalTransactionStep).balanceChange !== undefined) {
        return (step as InternalTransactionStep).balanceChange;
    } else {
        return 0;
    }
}

export function initializeReportRowLimit(limit: number): void {
    reportRowLimit = limit;
}
