import * as giftbitRoutes from "giftbit-cassava-routes";
import {GiftbitRestError} from "giftbit-cassava-routes";
import {
    LightrailUpdateTransactionPlanStep,
    StripeChargeTransactionPlanStep,
    StripeRefundTransactionPlanStep,
    TransactionPlan
} from "./TransactionPlan";
import {Transaction} from "../../../model/Transaction";
import {TransactionPlanError} from "./TransactionPlanError";
import {getKnexWrite} from "../../../utils/dbUtils/connection";
import {
    insertInternalTransactionSteps,
    insertLightrailTransactionSteps,
    insertStripeTransactionSteps,
    insertTransaction
} from "./insertTransactions";
import {rollbackStripeChargeSteps} from "../../../utils/stripeUtils/stripeStepOperations";
import {StripeRestError} from "../../../utils/stripeUtils/StripeRestError";
import {MetricsLogger} from "../../../utils/metricsLogger";
import * as cassava from "cassava";
import {Value} from "../../../model/Value";
import {isSystemId} from "../../../utils/isSystemId";
import log = require("loglevel");
import Knex = require("knex");

export interface ExecuteTransactionPlannerOptions {
    allowRemainder: boolean;
    simulate: boolean;
}

/**
 * Calls the planner and executes on the plans created.  If a plan cannot be executed
 * but can be replanned then the planner will be called again.
 */
export async function executeTransactionPlanner(auth: giftbitRoutes.jwtauth.AuthorizationBadge, options: ExecuteTransactionPlannerOptions, planner: () => Promise<TransactionPlan>): Promise<Transaction>;
export async function executeTransactionPlanner(auth: giftbitRoutes.jwtauth.AuthorizationBadge, options: ExecuteTransactionPlannerOptions, planner: () => Promise<TransactionPlan[]>): Promise<Transaction[]>;
export async function executeTransactionPlanner(auth: giftbitRoutes.jwtauth.AuthorizationBadge, options: ExecuteTransactionPlannerOptions, planner: () => Promise<TransactionPlan | TransactionPlan[]>): Promise<Transaction | Transaction[]> {
    let retries = 0;
    while (true) {
        try {

            const fetchedTransactionPlans = await planner();
            const plans: TransactionPlan[] = Array.isArray(fetchedTransactionPlans) ? fetchedTransactionPlans : [fetchedTransactionPlans];

            let insertedTransactions: Transaction[];
            const knex = await getKnexWrite();
            await knex.transaction(async trx => {
                insertedTransactions = await executeTransactionPlans(auth, trx, plans, options);
            });

            return insertedTransactions.length === 1 ? insertedTransactions[0] : insertedTransactions;
        } catch (err) {
            log.warn("Error thrown executing transaction plan.", err);
            if ((err as TransactionPlanError).isTransactionPlanError && (err as TransactionPlanError).isReplanable && retries < 3) {
                retries++;
                log.info("Retrying. It's a TransactionPlanError and is replanable.");
                continue;
            }
            throw err;
        }
    }
}

async function executeTransactionPlans(auth: giftbitRoutes.jwtauth.AuthorizationBadge, trx: Knex, plans: TransactionPlan[], options: ExecuteTransactionPlannerOptions): Promise<Transaction[]> {
    const insertedTransactions: Transaction[] = [];
    let plansIndex: number;
    try {
        for (plansIndex = 0; plansIndex < plans.length; plansIndex++) {
            insertedTransactions.push(await executeTransactionPlan(auth, trx, plans[plansIndex], options));
        }
    } catch (err) {
        log.warn("Error thrown executing transaction plan.", err);
        // rollback transaction plans that have been executed.
        for (let rollbackIndex = 0; rollbackIndex < plansIndex; rollbackIndex++) {
            rollbackTransactionPlan(auth, plans[rollbackIndex], trx, err);
        }
        throw err;
    }
    plans.forEach(plan => MetricsLogger.transaction(plan, auth));
    return insertedTransactions;
}

/**
 * Can be called to execute a Transaction Plan inside an existing knex trx.
 */
export async function executeTransactionPlan(auth: giftbitRoutes.jwtauth.AuthorizationBadge, trx: Knex, plan: TransactionPlan, options: ExecuteTransactionPlannerOptions): Promise<Transaction> {
    auth.requireIds("userId", "teamMemberId");

    validateTransactionPlan(plan, options);

    if (options.simulate) {
        return TransactionPlan.toTransaction(auth, plan, options.simulate);
    }

    await insertTransaction(trx, auth, plan);

    try {
        plan = await insertStripeTransactionSteps(auth, trx, plan);
        plan = await insertLightrailTransactionSteps(auth, trx, plan);
        plan = await insertInternalTransactionSteps(auth, trx, plan);
    } catch (err) {
        log.error(`Error occurred while processing transaction steps: ${err}`);
        await rollbackTransactionPlan(auth, plan, trx, err);

        if ((err as StripeRestError).additionalParams && (err as StripeRestError).additionalParams.stripeError) {
            // Error was returned from Stripe. Passing original error along so that details of Stripe failure can be returned.
            throw err;
        } else if ((err as TransactionPlanError).isTransactionPlanError || (err as GiftbitRestError).isRestError) {
            throw err;
        } else if (err.code === "ER_DUP_ENTRY") {
            log.error(err);
            giftbitRoutes.sentry.sendErrorNotification(err);
            throw new giftbitRoutes.GiftbitRestError(409, `A transaction step in transaction '${plan.id}' already exists. This should not be possible.`, "TransactionStepExists");
        } else {
            log.warn(err);
            giftbitRoutes.sentry.sendErrorNotification(err);
            throw new giftbitRoutes.GiftbitRestError(500, `An error occurred while processing transaction '${plan.id}'.`);
        }
    }

    // Call TransactionPlan.toTransaction again because TransactionSteps may change during execution to fill in results.
    // Note that the top-level Transaction may not change.
    return TransactionPlan.toTransaction(auth, plan);
}

/**
 * Rolls back any parts of the Transaction that won't be undone by rolling back the knex transaction. Primarily, it is just third party requests.
 * @stripeConfig (optional) - added as a small optimization so that stripeConfig doesn't always have to be re-fetched.
 */
async function rollbackTransactionPlan(auth: giftbitRoutes.jwtauth.AuthorizationBadge, plan: TransactionPlan, trx: Knex, err: Error): Promise<void> {
    // rollback charges
    const stripeChargeSteps: StripeChargeTransactionPlanStep[] = plan.steps.filter(step => step.rail === "stripe" && step.type === "charge") as StripeChargeTransactionPlanStep[];
    if (stripeChargeSteps.length > 0) {
        const stripeChargeStepsToRefund = stripeChargeSteps.filter(step => step.chargeResult != null) as StripeChargeTransactionPlanStep[];
        if (stripeChargeStepsToRefund.length > 0) {
            await rollbackStripeChargeSteps(auth, stripeChargeStepsToRefund, "Refunded due to error on the Lightrail side.");
            log.warn(`An error occurred while processing transaction '${plan.id}'. The Stripe charge(s) '${stripeChargeStepsToRefund.map(step => step.chargeResult.id)}' have been refunded.`);
        }
    }

    // You can't undo a refund in Stripe, so check for any refunds and if found throw an exception.
    const stripeRefundSteps: StripeRefundTransactionPlanStep[] = plan.steps.filter(step => step.rail === "stripe" && step.type === "refund") as StripeRefundTransactionPlanStep[];
    if (stripeRefundSteps.length > 0) {
        const stepsSuccessfullyRefunded: StripeRefundTransactionPlanStep[] = stripeRefundSteps.filter(step => step.refundResult != null);
        if (stepsSuccessfullyRefunded.length > 0) {
            const message = `Exception ${JSON.stringify(err)} was thrown while processing steps. There was a refund that was successfully refunded but the exception was thrown after and refunds cannot be undone. This is a bad situation as the Transaction could not be saved.`;
            log.error(message);
            giftbitRoutes.sentry.sendErrorNotification(new Error(message));
            throw new GiftbitRestError(424, `An irrecoverable exception occurred while reversing the Transaction ${plan.previousTransactionId}. The charges ${stepsSuccessfullyRefunded.map(step => step.chargeId).toString()} were refunded in Stripe but an exception occurred after and the Transaction could not be completed. Please review your records in Lightrail and Stripe to adjust for this situation.`);
        } else {
            log.info(`An exception occurred while reversing transaction ${plan.previousTransactionId}. The reverse included refunds in Stripe but they were not successfully refunded. The state of Stripe and Lightrail are consistent.`);
        }
    }
}

function validateTransactionPlan(plan: TransactionPlan, options: ExecuteTransactionPlannerOptions): void {
    if (!isSystemId(plan.currency)) {
        throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.CONFLICT, `Currency '${plan.currency}' does not exist. See the documentation on creating currencies.`, "CurrencyNotFound");
    }
    if (plan.currency.toUpperCase() !== plan.currency) {
        throw new Error(`Transaction plan currency must be upper case, found ${plan.currency}`);
    }

    if ((plan.totals && plan.totals.remainder && !options.allowRemainder) ||
        plan.steps.find(step => step.rail === "lightrail" && step.action === "update" && step.value.balance != null && step.value.balance + step.amount < 0)) {
        throw new giftbitRoutes.GiftbitRestError(409, "Insufficient balance for the transaction.", "InsufficientBalance");
    }
    if (plan.steps.find(step => step.rail === "lightrail" && step.action === "update" && step.value.usesRemaining != null && step.value.usesRemaining + step.uses < 0)) {
        throw new giftbitRoutes.GiftbitRestError(409, "Insufficient usesRemaining for the transaction.", "InsufficientUsesRemaining");
    }

    const lightrailUpdateSteps = plan.steps.filter(s => s.rail === "lightrail" && s.action === "update") as LightrailUpdateTransactionPlanStep[];
    lightrailUpdateSteps.forEach(step => {
        if (valueHasInsufficientBalanceForSteps(step.value, lightrailUpdateSteps)) {
            throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.CONFLICT, `The Value with id '${step.value.id}' cannot be used in this transaction because it has insufficient balance.`, "InsufficientBalance");
        } else if (valueHasInsufficientUsesForSteps(step.value, lightrailUpdateSteps)) {
            throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.CONFLICT, `The Value with id '${step.value.id}' cannot be used in this transaction because it has insufficient usesRemaining.`, "InsufficientUsesRemaining");
        } else {
            // carry on, the value in this step won't be overdrawn
        }
    });
}

function valueHasInsufficientUsesForSteps(value: Value, steps: LightrailUpdateTransactionPlanStep[]): boolean {
    const stepsInvolvingValueWithUses = steps.filter(s => s.value.id === value.id && s.uses);
    if (stepsInvolvingValueWithUses.length === 0 || value.usesRemaining === null) {
        return false;
    } else {
        const totalUses = stepsInvolvingValueWithUses.map(s => s.uses).reduce((acc, curr) => acc + curr);
        return value.usesRemaining + totalUses < 0; // 'uses' is a negative number on drawdown steps
    }
}

function valueHasInsufficientBalanceForSteps(value: Value, steps: LightrailUpdateTransactionPlanStep[]): boolean {
    const stepsInvolvingValueWithAmount = steps.filter(s => s.value.id === value.id && s.amount);
    if (stepsInvolvingValueWithAmount.length === 0 || value.balance === null) {
        return false;
    } else {
        const totalAmount = stepsInvolvingValueWithAmount.map(s => s.amount).reduce((acc, curr) => acc + curr);
        return value.balance + totalAmount < 0; // 'amount' is a negative number on drawdown steps
    }
}
