import {httpStatusCode} from "cassava";
import {StripeTransactionPlanStep, TransactionPlan} from "../../lambdas/rest/transactions/TransactionPlan";
import {StripeUpdateChargeParams} from "./StripeUpdateChargeParams";
import {StripeRestError} from "./StripeRestError";
import {LightrailAndMerchantStripeConfig} from "./StripeConfig";
import {StripeTransactionParty} from "../../model/TransactionRequest";
import {TransactionPlanError} from "../../lambdas/rest/transactions/TransactionPlanError";
import {StripeCreateChargeParams} from "./StripeCreateChargeParams";
import log = require("loglevel");
import Stripe = require("stripe");
import IRefund = Stripe.refunds.IRefund;
import ICharge = Stripe.charges.ICharge;

export async function createStripeCharge(params: any, lightrailStripeSecretKey: string, merchantStripeAccountId: string, stepIdempotencyKey: string): Promise<ICharge> {
    const lightrailStripe = require("stripe")(lightrailStripeSecretKey);
    // params.description = "Lightrail Checkout transaction.";  // todo what is this
    log.info(`Creating transaction ${JSON.stringify(params)}.`);

    let charge: ICharge;
    try {
        charge = await lightrailStripe.charges.create(params, {
            stripe_account: merchantStripeAccountId,
            idempotency_key: stepIdempotencyKey
        });
    } catch (err) {
        switch (err.type) {
            case "StripeIdempotencyError":
                throw new StripeRestError(err.statusCode, `Stripe idempotency error: a charge already exists in Stripe with the idempotency key '${err.headers["idempotency-key"]}'. This key was generated by Lightrail from the checkout transaction ID for the charge '${JSON.stringify(params)}'.`, "StripeIdempotencyError", err);
            case "StripeCardError":
                throw new StripeRestError(httpStatusCode.clientError.BAD_REQUEST, "Failed to charge credit card.", "ChargeFailed", err);
            case "StripeInvalidRequestError":
                throw new StripeRestError(httpStatusCode.clientError.BAD_REQUEST, "The stripeCardToken was invalid.", "StripeInvalidRequestError", err);
            case "RateLimitError":
                throw new StripeRestError(httpStatusCode.clientError.TOO_MANY_REQUESTS, `Service was rate limited by dependent service.`, "DependentServiceRateLimited", err); // technically this is up to us to handle once we're past mvp stage: since we are sending the requests, we should take responsibility for spacing & retrying
            default:
                throw new Error(`An unexpected error occurred while attempting to charge card. error ${err}`);
        }
    }
    log.info(`Created charge ${JSON.stringify(charge)}`); // todo is this safe to log?
    return charge;
}

export async function rollbackStripeSteps(lightrailStripeSecretKey: string, merchantStripeAccountId: string, steps: StripeTransactionPlanStep[], reason: string): Promise<void> {
    for (const step of steps) {
        const refund = await createRefund(step, lightrailStripeSecretKey, merchantStripeAccountId, reason);
        log.info(`Refunded charge ${step.chargeResult.id}. Refund: ${JSON.stringify(refund)}.`);
    }
}

export async function createRefund(step: StripeTransactionPlanStep, lightrailStripeSecretKey: string, merchantStripeAccountId: string, reason?: string): Promise<IRefund> {
    const lightrailStripe = require("stripe")(lightrailStripeSecretKey);
    log.info(`Creating refund for charge ${step.chargeResult.id}.`);
    const refund = await lightrailStripe.refunds.create({
        charge: step.chargeResult.id,
        metadata: {reason: reason || "not specified"} /* Doesn't show up in charge in stripe. Need to update charge so that it's obvious as to why it was refunded. */
    }, {
        stripe_account: merchantStripeAccountId
    });
    await updateCharge(step.chargeResult.id, {
        description: reason
    }, lightrailStripeSecretKey, merchantStripeAccountId);
    log.info(JSON.stringify(refund));
    return refund;
}

export async function updateCharge(chargeId: string, params: StripeUpdateChargeParams, lightrailStripeSecretKey: string, merchantStripeAccountId: string): Promise<any> {
    const merchantStripe = require("stripe")(lightrailStripeSecretKey);
    log.info(`Updating charge ${JSON.stringify(params)}.`);
    const chargeUpdate = await merchantStripe.charges.update(
        chargeId,
        params, {
            stripe_account: merchantStripeAccountId,
        }
    );
    // todo make this a DTO.
    log.info(`Updated charge ${JSON.stringify(chargeUpdate)}.`);
    return chargeUpdate;
}


export async function chargeStripeSteps(stripeConfig: LightrailAndMerchantStripeConfig, plan: TransactionPlan) {
    const stripeSteps = plan.steps.filter(step => step.rail === "stripe") as StripeTransactionPlanStep[];

    try {
        for (let stepIx in stripeSteps) {
            const step = stripeSteps[stepIx];
            const stepForStripe = stripeTransactionPlanStepToStripeRequest(step, plan);
            // todo handle edge case: stripeAmount < 50    --> do this in planner

            const charge = await createStripeCharge(stepForStripe, stripeConfig.lightrailStripeConfig.secretKey, stripeConfig.merchantStripeConfig.stripe_user_id, step.idempotentStepId);

            // Update transaction plan with charge details
            step.chargeResult = charge;
            // trace back to the requested payment source that lists the right 'source' and/or 'customer' param
            let stepSource = plan.paymentSources.find(
                source => source.rail === "stripe" &&
                    (step.source ? source.source === step.source : true) &&
                    (step.customer ? source.customer === step.customer : true)
            ) as StripeTransactionParty;
            stepSource.chargeId = charge.id;
        }
        // await doFraudCheck(lightrailStripeConfig, merchantStripeConfig, params, charge, evt, auth);
    } catch (err) {
        // todo: differentiate between stripe errors / db step errors, and fraud check errors once we do fraud checking: rollback if appropriate & make sure message is clear
        if ((err as StripeRestError).additionalParams.stripeError) {
            throw err;
        } else {
            throw new TransactionPlanError(`Transaction execution canceled because there was a problem charging Stripe: ${err}`, {
                isReplanable: false
            });
        }
    }
}

function stripeTransactionPlanStepToStripeRequest(step: StripeTransactionPlanStep, plan: TransactionPlan): StripeCreateChargeParams {
    let stepForStripe: StripeCreateChargeParams = {
        amount: step.amount,
        currency: plan.currency,
        metadata: {
            ...plan.metadata,
            lightrailTransactionId: plan.id
        }
    };
    if (step.source) {
        stepForStripe.source = step.source;
    }
    if (step.customer) {
        stepForStripe.customer = step.customer;
    }

    return stepForStripe;
}