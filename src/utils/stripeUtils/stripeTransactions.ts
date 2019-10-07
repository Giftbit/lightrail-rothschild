import {StripeRestError} from "./StripeRestError";
import * as giftbitRoutes from "giftbit-cassava-routes";
import * as cassava from "cassava";
import {getStripeClient} from "./stripeAccess";
import log = require("loglevel");
import Stripe = require("stripe");
import {GiftbitRestError} from "giftbit-cassava-routes";

export async function createCharge(params: Stripe.charges.IChargeCreationOptions, isTestMode: boolean, merchantStripeAccountId: string, stepIdempotencyKey: string): Promise<Stripe.charges.ICharge> {
    const lightrailStripe = await getStripeClient(isTestMode);
    log.info("Creating Stripe charge", params);

    try {
        const charge = await lightrailStripe.charges.create(params, {
            stripe_account: merchantStripeAccountId,
            idempotency_key: stepIdempotencyKey
        });
        log.info(`Created Stripe charge '${charge.id}'`);
        return charge;
    } catch (err) {
        log.warn("Error charging Stripe:", err);

        checkForStandardStripeErrors(err);
        switch (err.type) {
            case "StripeAPIError":
                throw new StripeRestError(cassava.httpStatusCode.serverError.BAD_GATEWAY, err.message, "StripeAPIError", err);
            case "StripeIdempotencyError":
                throw new StripeRestError(cassava.httpStatusCode.clientError.CONFLICT, `Stripe idempotency error: a charge already exists in Stripe with the idempotency key '${err.headers["idempotency-key"]}'. This key was generated by Lightrail from the checkout transaction ID for the charge '${JSON.stringify(params)}'.`, "StripeIdempotencyError", err);
            case "StripeCardError":
                if (isIdempotentReplayError(err)) {
                    const nextStepIdempotencyKey = getRetryIdempotencyKey(stepIdempotencyKey, err);
                    return createCharge(params, isTestMode, merchantStripeAccountId, nextStepIdempotencyKey);
                }
                if (err.code === "expired_card") {
                    throw new StripeRestError(cassava.httpStatusCode.clientError.CONFLICT, "Your card is expired.", "StripeCardDeclined", err);
                }
                if (err.code === "insufficient_funds") {
                    throw new StripeRestError(cassava.httpStatusCode.clientError.CONFLICT, "Your card has insufficient funds.", "StripeCardDeclined", err);
                }
                throw new StripeRestError(cassava.httpStatusCode.clientError.CONFLICT, "Card declined.", "StripeCardDeclined", err);
            case "StripeInvalidRequestError":
                if (err.code === "amount_too_small") {
                    // 422's
                    throw new StripeRestError(422, `Failed to charge credit card: amount '${params.amount}' for Stripe was too small.`, "StripeAmountTooSmall", err);
                }
                if (err.code === "parameter_missing") {
                    throw new StripeRestError(422, "The stripeCardToken was invalid.", "StripeParameterMissing", err);
                }
                throw new StripeRestError(422, "your request has invalid parameter", "StripeInvalidRequestError", err);
            case "StripeRateLimitError":
                throw new StripeRestError(cassava.httpStatusCode.clientError.TOO_MANY_REQUESTS, err.message, "StripeRateLimitError", err);
            default:
                throw err;
        }
    }
}

export async function createRefund(params: Stripe.refunds.IRefundCreationOptionsWithCharge, isTestMode: boolean, merchantStripeAccountId: string): Promise<Stripe.refunds.IRefund> {
    const lightrailStripe = await getStripeClient(isTestMode);
    log.info("Creating refund for Stripe charge", params);
    try {
        const refund = await lightrailStripe.refunds.create(params, {
            stripe_account: merchantStripeAccountId
        });
        log.info("Created Stripe refund for charge", params.charge, refund);
        return refund;
    } catch (err) {
        log.warn("Error refunding Stripe:", err);

        checkForStandardStripeErrors(err);
        if ((err as Stripe.IStripeError).code === "charge_already_refunded") {
            // Refunds are sorted most recent first, so we only need one.
            const refunds = await lightrailStripe.charges.listRefunds(params.charge, {limit: 1}, {stripe_account: merchantStripeAccountId});
            if (refunds.data.length === 0) {
                throw new Error(`Attempting to refund charge '${params.charge}' resulted in 'charge_already_refunded' but listing refunds returned nothing.`);
            } else {
                return refunds.data[0];
            }
        }
        if ((err as Stripe.IStripeError).code === "charge_disputed") {
            // We could change this behaviour in the future.  For example it seems safe that if the
            // dispute is settled we go ahead with the reverse.  Reversing with an unsettled dispute is
            // less clear.  Accepting the dispute and then reversing is riskier still.
            throw new StripeRestError(409, `Stripe charge '${params.charge}' cannot be refunded because it is disputed.`, "StripeChargeDisputed", err);
        }

        giftbitRoutes.sentry.sendErrorNotification(err);
        throw err;
    }
}

export async function captureCharge(chargeId: string, options: Stripe.charges.IChargeCaptureOptions, isTestMode: boolean, merchantStripeAccountId: string): Promise<Stripe.charges.ICharge> {
    const lightrailStripe = await getStripeClient(isTestMode);
    log.info("Creating capture for Stripe charge", chargeId);
    try {
        const capturedCharge = await lightrailStripe.charges.capture(chargeId, options, {
            stripe_account: merchantStripeAccountId
        });
        log.info("Created Stripe capture for charge", chargeId, capturedCharge);
        return capturedCharge;
    } catch (err) {
        log.warn("Error capturing Stripe charge:", err);

        checkForStandardStripeErrors(err);
        if ((err as Stripe.IStripeError).code === "charge_already_captured") {
            return await lightrailStripe.charges.retrieve(chargeId, {stripe_account: merchantStripeAccountId});
        }
        if ((err as Stripe.IStripeError).code === "charge_already_refunded") {
            throw new StripeRestError(409, `Stripe charge '${chargeId}' cannot be captured because it was refunded.`, "StripeChargeAlreadyRefunded", err);
        }

        giftbitRoutes.sentry.sendErrorNotification(err);
        throw err;
    }
}

export async function updateCharge(chargeId: string, params: Stripe.charges.IChargeUpdateOptions, isTestMode: boolean, merchantStripeAccountId: string): Promise<any> {
    const lightrailStripe = await getStripeClient(isTestMode);
    log.info("Updating Stripe charge", params);
    try {
        const chargeUpdate = await lightrailStripe.charges.update(
            chargeId,
            params, {
                stripe_account: merchantStripeAccountId,
            }
        );
        log.info("Updated Stripe charge", chargeUpdate);
        return chargeUpdate;
    } catch (err) {
        checkForStandardStripeErrors(err);
        log.warn("Error updating Stripe charge:", err);
        giftbitRoutes.sentry.sendErrorNotification(err);
        throw err;
    }
}

export async function retrieveCharge(chargeId: string, isTestMode: boolean, merchantStripeAccountId: string): Promise<Stripe.charges.ICharge> {
    const lightrailStripe = await getStripeClient(isTestMode);
    log.info("Retrieving Stripe charge", chargeId);
    try {
        const charge = await lightrailStripe.charges.retrieve(chargeId, {stripe_account: merchantStripeAccountId});
        log.info("retrieved Stripe charge", charge);
        return charge;
    } catch (err) {
        checkForStandardStripeErrors(err);
        if (err.statusCode === 404) {
            throw new StripeRestError(404, `Charge not found: ${chargeId}`, null, err);
        }
        log.warn("Error retrieving Stripe charge:", err);
        giftbitRoutes.sentry.sendErrorNotification(err);
        throw err;
    }
}

/**
 * So far this has only been used in test code.  It's not clear there will ever be
 * a need in production.
 */
export async function createCustomer(params: Stripe.customers.ICustomerCreationOptions, isTestMode: boolean, merchantStripeAccountId: string): Promise<Stripe.customers.ICustomer> {
    const lightrailStripe = await getStripeClient(isTestMode);
    log.info("Creating Stripe customer", params);

    return await lightrailStripe.customers.create(params, {stripe_account: merchantStripeAccountId});
}

/**
 * So far this has only been used in test code.  It's not clear there will ever be
 * a need in production.
 */
export async function createCustomerSource(customerId: string, params: Stripe.customers.ICustomerSourceCreationOptions, isTestMode: boolean, merchantStripeAccountId: string): Promise<Stripe.IStripeSource> {
    const lightrailStripe = await getStripeClient(isTestMode);
    log.info("Creating Stripe card source", customerId, params);

    return await lightrailStripe.customers.createSource(customerId, params, {stripe_account: merchantStripeAccountId});
}

/**
 * Returns true if the error is an idempotent replay from a previous call.
 */
function isIdempotentReplayError(err: any): boolean {
    return err && err.headers && err.headers["idempotent-replayed"] === "true";
}

function checkForStandardStripeErrors(err: any): void {
    switch (err.type) {
        case "RateLimitError":
            throw new StripeRestError(429, `Service was rate limited by dependent service.`, "DependentServiceRateLimited", err); // technically this is up to us to handle once we're past mvp stage: since we are sending the requests, we should take responsibility for spacing & retrying
        case "StripePermissionError":
            throw new StripeRestError(424, "Application access may have been revoked.", "StripePermissionError", err);
        default:
            // try something for 500s
            if (err.type === "StripeConnectionError") {
                throw new GiftbitRestError(502, "Stripe is not responding.", "StripeConnectionError");
            }
    }
}

function getRetryIdempotencyKey(stepIdempotencyKey: string, originalErr: any): string {
    if (!isIdempotentReplayError(originalErr)) {
        throw new Error("Called with non idempotent replay error");
    }

    let count = 1;
    let originalStepIdempotencyKey = stepIdempotencyKey;
    const retryCountMatcher = /^(.+)-retry-(\d)$/.exec(stepIdempotencyKey);
    if (retryCountMatcher) {
        originalStepIdempotencyKey = retryCountMatcher[1];
        count = +retryCountMatcher[2] + 1;
    }

    if (count > 5) {
        if (originalErr.code === "expired_card") {
            throw new StripeRestError(cassava.httpStatusCode.clientError.CONFLICT, "Your card is expired.", "StripeCardDeclined", originalErr);
        } else if (originalErr.code === "insufficient_funds") {
            throw new StripeRestError(cassava.httpStatusCode.clientError.CONFLICT, "Your card has insufficient funds.", "StripeCardDeclined", originalErr);
        } else {
            throw  new StripeRestError(cassava.httpStatusCode.clientError.CONFLICT, "Card declined.", "StripeCardDeclined", originalErr);
        }
    }

    return originalStepIdempotencyKey + "-retry-" + count;
}
