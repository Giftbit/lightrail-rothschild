import * as giftbitRoutes from "giftbit-cassava-routes";
import * as cassava from "cassava";
import {
    InternalTransactionPlanStep,
    LightrailTransactionPlanStep,
    LightrailUpdateTransactionPlanStep,
    StripeTransactionPlanStep,
    TransactionPlan
} from "./TransactionPlan";
import {TransactionPlanError} from "./TransactionPlanError";
import {DbValue, Value} from "../../../model/Value";
import {DbTransaction, Transaction} from "../../../model/Transaction";
import {executeStripeSteps} from "../../../utils/stripeUtils/stripeStepOperations";
import {getSqlErrorColumnName, getSqlErrorConstraintName} from "../../../utils/dbUtils";
import {generateCode} from "../../../utils/codeGenerator";
import {GenerateCodeParameters} from "../../../model/GenerateCodeParameters";
import {StripeDbTransactionStep} from "../../../model/TransactionStep";
import Knex = require("knex");
import log = require("loglevel");

export async function insertTransaction(trx: Knex, auth: giftbitRoutes.jwtauth.AuthorizationBadge, plan: TransactionPlan): Promise<Transaction> {
    if (!plan.rootTransactionId) {
        plan.rootTransactionId = plan.id;
    }

    try {
        const transaction = TransactionPlan.toTransaction(auth, plan);
        const dbTransaction = Transaction.toDbTransaction(auth, transaction, plan.rootTransactionId);
        await trx.into("Transactions")
            .insert(dbTransaction);
        if (plan.previousTransactionId) {
            const updateProperties: { [P in keyof DbTransaction]?: DbTransaction[P] | Knex.Raw } = {
                nextTransactionId: plan.id,
            };
            const updateRes = await trx.into("Transactions")
                .where({
                    userId: auth.userId,
                    id: plan.previousTransactionId,
                    nextTransactionId: null
                }).update(updateProperties);
            if (updateRes !== 1) {
                throw new TransactionPlanError(`Transaction execution canceled because Transaction updated ${updateRes} rows when setting nextTransactionId on previous transaction ${plan.previousTransactionId}. userId=${auth.userId}.`, {
                    isReplanable: true // replanning it will detect that the transaction has already been reversed.
                });
            }
        }
        return transaction;
    } catch (err) {
        log.warn("Error inserting transaction", err);
        const constraint = getSqlErrorConstraintName(err);
        if (constraint === "fk_Transaction_Currencies") {
            throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.CONFLICT, `Currency '${plan.currency}' does not exist. See the documentation on creating currencies.`, "CurrencyNotFound");
        } else if (err.code === "ER_DUP_ENTRY") {
            throw new giftbitRoutes.GiftbitRestError(409, `A Lightrail transaction with transactionId '${plan.id}' already exists.`, "TransactionExists");
        } else {
            giftbitRoutes.sentry.sendErrorNotification(err);
            throw err;
        }
    }
}

export async function insertLightrailTransactionSteps(auth: giftbitRoutes.jwtauth.AuthorizationBadge, trx: Knex, plan: TransactionPlan): Promise<TransactionPlan> {
    const steps = plan.steps.filter(step => step.rail === "lightrail") as LightrailTransactionPlanStep[];
    for (let stepIx = 0; stepIx < steps.length; stepIx++) {
        const step = steps[stepIx];

        switch (step.action) {
            case "insert":
                await insertValue(auth, trx, step.value, step.generateCodeParameters);
                break;
            case "update":
                await updateLightrailValueForStep(auth, trx, step, plan);
                break;
            default:
                throw new Error(`Unexpected step value action. This should not happen.`);
        }

        await trx.into("LightrailTransactionSteps")
            .insert(LightrailTransactionPlanStep.toLightrailDbTransactionStep(step, stepIx, plan, auth));
    }
    return plan;
}

export async function insertValue(auth: giftbitRoutes.jwtauth.AuthorizationBadge, trx: Knex, value: Value, generateCodeParameters: GenerateCodeParameters, retryCount = 0): Promise<DbValue> {
    if (value.balance < 0) {
        throw new Error("balance cannot be negative");
    }
    if (value.usesRemaining < 0) {
        throw new Error("usesRemaining cannot be negative");
    }

    if (generateCodeParameters) {
        value.code = generateCode(generateCodeParameters);
    }

    const dbValue: DbValue = await Value.toDbValue(auth, value);
    try {
        await trx("Values")
            .insert(dbValue);

    } catch (err) {
        log.debug(err);
        const constraint = getSqlErrorConstraintName(err);
        if (constraint === "PRIMARY") {
            throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.CONFLICT, `A Value with id '${value.id}' already exists.`, "ValueIdExists");
        }
        if (constraint === "uq_Values_codeHashed") {
            if (generateCodeParameters != null && retryCount < 2) {
                /*  Retrying twice is an arbitrary number. This may need to be increased if we're still seeing regular failures.
                 *  Unless users are using their own character set there are around 1 billion possible codes.
                 *  It seems unlikely for 3+ retry failures even if users have millions of codes. */
                return insertValue(auth, trx, value, generateCodeParameters, retryCount + 1);
            } else {
                throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.CONFLICT, `A Value with the given code already exists.`, "ValueCodeExists");
            }
        }
        if (constraint === "fk_Values_Currencies") {
            throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.CONFLICT, `Currency '${value.currency}' does not exist. See the documentation on creating currencies.`, "CurrencyNotFound");
        }
        if (constraint === "fk_Values_Contacts") {
            throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.CONFLICT, `Contact '${value.contactId}' does not exist.`, "ContactNotFound");
        }
        throw err;
    }

    return dbValue;
}

async function updateLightrailValueForStep(auth: giftbitRoutes.jwtauth.AuthorizationBadge, trx: Knex, step: LightrailUpdateTransactionPlanStep, plan: TransactionPlan): Promise<void> {
    const updateProperties: { [P in keyof DbValue]?: DbValue[P] | Knex.Raw } = {
        updatedDate: plan.createdDate
    };

    let query = trx<any, number>("Values")
        .where({
            userId: auth.userId,
            id: step.value.id,
            active: true
        });
    if (!step.allowCanceled) {
        query = query.where({canceled: false});
    }
    if (!step.allowFrozen) {
        query = query.where({frozen: false});
    }
    if (step.value.balance != null && step.amount !== 0 && step.amount != null) {
        updateProperties.balance = trx.raw(`balance + ?`, [step.amount]);
        if (step.amount < 0) {
            query = query.where("balance", ">=", -step.amount);
        }
    }
    if (step.value.usesRemaining != null && step.uses !== 0 && step.uses != null) {
        updateProperties.usesRemaining = trx.raw("usesRemaining + ?", [step.uses]);
        if (step.uses < 0) {
            query = query.where("usesRemaining", ">=", -step.uses);
        }
    }
    query = query.update(updateProperties);

    try {
        const updateRes = await query;
        if (updateRes !== 1) {
            throw new TransactionPlanError(`Transaction execution canceled because Value updated ${updateRes} rows.  userId=${auth.userId} value.id=${step.value.id} value.balance=${step.value.balance} value.usesRemaining=${step.value.usesRemaining} step.amount=${step.amount} step.uses=${step.uses}`, {
                isReplanable: updateRes === 0
            });
        }
    } catch (err) {
        if (err.code === "ER_WARN_DATA_OUT_OF_RANGE") {
            const columnName = getSqlErrorColumnName(err);
            if (columnName === "balance") {
                throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.CONFLICT, "This transaction makes a Value's balance greater than the max of 2147483647.", "ValueBalanceTooLarge");
            }
            if (columnName === "usesRemaining") {
                throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.CONFLICT, "This transaction makes a Value's usesRemaining greater than the max of 2147483647.", "ValueUsesRemainingTooLarge");
            }
        }
        throw err;
    }

    const selectRes: DbValue[] = await trx.from("Values")
        .where({
            userId: auth.userId,
            id: step.value.id
        })
        .select();

    if (selectRes.length !== 1) {
        throw new TransactionPlanError(`Transaction execution canceled because the Value that was updated could not be refetched.  This should never happen.  userId=${auth.userId} valueId=${step.value.id}`, {
            isReplanable: false
        });
    }

    /**
     * IMPORTANT: This is for display purposes only. This sets value.balance to be what it was before the transaction was applied.
     * This is important for displaying balanceBefore/After so that the code can work the same way for simulated and real transactions.
     */
    if (step.value.balance != null) {
        step.value.balance = selectRes[0].balance - step.amount;
    }
    if (step.value.usesRemaining != null && step.uses != null) {
        step.value.usesRemaining = selectRes[0].usesRemaining - step.uses;
    }
}

export async function insertStripeTransactionSteps(auth: giftbitRoutes.jwtauth.AuthorizationBadge, trx: Knex, plan: TransactionPlan): Promise<TransactionPlan> {
    await executeStripeSteps(auth, plan);
    const stripeSteps: StripeDbTransactionStep[] = [];
    for (let stepIx = 0; stepIx < plan.steps.length; stepIx++) {
        if (plan.steps[stepIx].rail === "stripe") {
            stripeSteps.push(StripeTransactionPlanStep.toStripeDbTransactionStep(plan.steps[stepIx] as StripeTransactionPlanStep, stepIx, plan, auth));
        }
    }
    if (stripeSteps.length) {
        await trx.into("StripeTransactionSteps").insert(stripeSteps);
    }
    return plan;
}

export async function insertInternalTransactionSteps(auth: giftbitRoutes.jwtauth.AuthorizationBadge, trx: Knex, plan: TransactionPlan): Promise<TransactionPlan> {
    const internalSteps = plan.steps.filter(step => step.rail === "internal")
        .map(step => InternalTransactionPlanStep.toInternalDbTransactionStep(step as InternalTransactionPlanStep, plan, auth));
    await trx.into("InternalTransactionSteps")
        .insert(internalSteps);
    return plan;
}
