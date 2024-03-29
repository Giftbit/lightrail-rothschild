import log = require("loglevel");
import Stripe = require("stripe");
import * as cassava from "cassava";
import {
    getAuthBadgeFromStripeCharge,
    getLightrailStripeModeConfig,
    getRootTransactionFromStripeCharge,
    getStripeClient
} from "../../utils/stripeUtils/stripeAccess";
import * as giftbitRoutes from "giftbit-cassava-routes";
import {GiftbitRestError} from "giftbit-cassava-routes";
import {Transaction} from "../../model/Transaction";
import {
    createReverse,
    createVoid,
    getTransactions,
    isCaptured,
    isReversed,
    isReversible,
    isVoidable,
    isVoided
} from "../rest/transactions/transactions";
import {retrieveCharge} from "../../utils/stripeUtils/stripeTransactions";
import {MetricsLogger as metricsLogger} from "../../utils/metricsLogger";
import {AuthorizationBadge} from "giftbit-cassava-routes/dist/jwtauth";
import {freezeLightrailSources} from "../../utils/stripeEventWebhookRouteUtils";

export function installStripeEventWebhookRest(router: cassava.Router): void {
    // These paths are configured in our Stripe account and not publicly known
    // (not that it would do any harm as we verify signatures).
    router.route("/v2/stripeEventWebhook")
        .method("POST")
        .handler(async evt => {
            const lightrailStripeModeConfig = await getLightrailStripeModeConfig(!evt.body.livemode);
            const stripe = await getStripeClient(!evt.body.livemode);

            let event: Stripe.events.IEvent & { account?: string };
            log.info("Verifying Stripe signature for eventId", evt.body.id, "from account", evt.body.account);
            try {
                event = stripe.webhooks.constructEvent(evt.bodyRaw, evt.headersLowerCase["stripe-signature"], lightrailStripeModeConfig.connectWebhookSigningSecret);
                log.info("Stripe signature verified. Event=", JSON.stringify(event));
            } catch (err) {
                log.info(`Event '${evt.body.id}' could not be verified.`);
                throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.UNAUTHORIZED, "The Stripe signature could not be validated");
            }

            if (event.account) {
                await handleConnectedAccountEvent((event as Stripe.events.IEvent & { account: string }));
            } else {
                log.warn("Received event", event.id, "that did not have property 'account'. This endpoint is not configured to handle events from the Lightrail Stripe account.");
            }

            return {
                statusCode: 204,
                body: null
            };
        });
}

async function handleConnectedAccountEvent(event: Stripe.events.IEvent & { account: string }): Promise<void> {
    const stripeAccountId: string = event.account;

    // We need to build an auth badge from the credentials on the event to take any action in our system
    // If this fails because we can't find a corresponding userId in our system, it's unlikely that having Stripe resend the event will fix things so we send back a success response
    // If it fails for some other reason, retrying the event may be worthwhile. Stripe will respond to error responses by retrying the event every 24 hrs for 7 days.
    let auth: AuthorizationBadge;
    let stripeCharge: Stripe.charges.ICharge;
    try {
        stripeCharge = await getStripeChargeFromEvent(event); // todo refactor when we have mapping from Stripe accountId to Lightrail userId: won't need to get charge to get auth badge
        if (!stripeCharge) {
            log.info("Skipping event because it does not contain a charge.");
            return;
        }
        auth = await getAuthBadgeFromStripeCharge(stripeAccountId, stripeCharge, event);
    } catch (e) {
        log.error("Could not build auth badge from webhook event", e);
        if ((e as GiftbitRestError).statusCode === 401) {
            return;
        } else {
            throw new GiftbitRestError(500, "Unexpected server error");
        }
    }

    logEvent(auth, event);
    if (isEventForLoggingOnly(event)) {
        return;
    } else if (isFraudActionEvent(event)) {
        try {
            await handleFraudReverseEvent(auth, event, stripeCharge);
        } catch (e) {
            log.error("Error handling Connected Account:", e);
            throw new GiftbitRestError(500, "Server error");
        }

    } else {
        log.info("Received Connected Account event of type", event.type, "eventId=", event.id, "accountId=", event.account, "This event does not indicate that fraud has occurred: exiting without handling.");
        return;
    }
}

async function handleFraudReverseEvent(auth: giftbitRoutes.jwtauth.AuthorizationBadge, event: Stripe.events.IEvent & { account: string }, stripeCharge: Stripe.charges.ICharge): Promise<void> {
    log.info("Event", event.id, "indicates that fraud has occurred. Reversing corresponding Lightrail Transaction and freezing associated Values.");
    metricsLogger.stripeWebhookFraudEvent(event, auth);

    let lightrailTransaction: Transaction;
    try {
        lightrailTransaction = await getRootTransactionFromStripeCharge(stripeCharge);
    } catch (e) {
        log.error(`Failed to fetch Lightrail Transaction from Stripe charge '${stripeCharge.id}'. Further action is likely required: Stripe charge was flagged as fraudulent; corresponding Lightrail transaction should be reversed and charged sources should be frozen. Exiting and returning success response to Stripe since this is likely a Lightrail problem. Event=${JSON.stringify(event)}`);
        metricsLogger.stripeWebhookHandlerError(event, auth);
        giftbitRoutes.sentry.sendErrorNotification(e);
        return; // allow handler to send success response to Stripe since this is likely a Lightrail issue
    }

    let handlingTransaction: Transaction;
    try {
        handlingTransaction = await reverseOrVoidFraudulentTransaction(auth, (event as Stripe.events.IEvent & { account: string }), stripeCharge, lightrailTransaction);
    } catch (e) {
        log.error(`Encountered error reversing or voiding fraudulent transaction. Will still try to freeze charged Values.`);
        metricsLogger.stripeWebhookHandlerError(event, auth);
        giftbitRoutes.sentry.sendErrorNotification(e);
        // Don't exit or throw a real error here since we still want to try to freeze the Values
    }

    try {
        await freezeLightrailSources(auth, event, stripeCharge, lightrailTransaction, handlingTransaction);
    } catch (e) {
        metricsLogger.stripeWebhookHandlerError(event, auth);
        giftbitRoutes.sentry.sendErrorNotification(e);
        throw e;
    }
}

function isEventForLoggingOnly(event: Stripe.events.IEvent & { account: string }): boolean {
    return event.type === "charge.dispute.created" || (event.type === "charge.refund.updated" && (event.data.object as Stripe.refunds.IRefund).status === "failed");
}

function logEvent(auth: giftbitRoutes.jwtauth.AuthorizationBadge, event: Stripe.events.IEvent & { account: string }): void {
    metricsLogger.stripeWebhookEvent(event, auth);

    if (event.type === "charge.dispute.created") {
        log.info("Event", event.id, "indicates a charge dispute which usually means fraud. Sending metrics data but taking no further action until fraud action confirmed.");
        metricsLogger.stripeWebhookDisputeEvent(event, auth);
        return;
    } else if ((event.type === "charge.refund.updated" && (event.data.object as Stripe.refunds.IRefund).status === "failed")) {
        log.info("Event", event.id, "indicates a refund failure with failure reason", (event.data.object as Stripe.refunds.IRefund).failure_reason, ". Sending error notification and taking no further action. State of Stripe and Lightrail may be inconsistent.");
        giftbitRoutes.sentry.sendErrorNotification(new Error(`Event of type '${event.type}', eventId '${event.id}', accountId '${event.account}' indicates a refund failure with failure reason '${(event.data.object as Stripe.refunds.IRefund).failure_reason}'. State of Stripe and Lightrail may be inconsistent.`));
        return;
    }
}

async function reverseOrVoidFraudulentTransaction(auth: giftbitRoutes.jwtauth.AuthorizationBadge, event: Stripe.events.IEvent & { account: string }, stripeCharge: Stripe.charges.ICharge, lightrailTransaction: Transaction): Promise<Transaction> {
    if (!lightrailTransaction.steps.find(step => step.rail === "stripe" && step.chargeId === stripeCharge.id)) {
        throw new Error(`Property mismatch: Stripe charge '${stripeCharge.id}' should match a charge in Lightrail Transaction '${lightrailTransaction.id}' except for refund details. Transaction='${JSON.stringify(lightrailTransaction)}'`);
    }

    const transactionChain: Transaction[] = (await getTransactions(auth, {rootTransactionId: lightrailTransaction.id}, {
        limit: 1000, after: null, before: null, last: null, maxLimit: 1000, sort: {
            field: "createdDate",
            asc: true
        }
    })).transactions;

    if (!transactionChain || transactionChain.length === 0) {
        log.error("No transactionChain. Exiting.");
        return;
    }

    if (isReversed(lightrailTransaction, transactionChain)) {
        log.info("Transaction", lightrailTransaction.id, "has already been reversed. Fetching existing reverse transaction...");
        const reverseTransaction = transactionChain.find(txn => txn.transactionType === "reverse");
        log.info("Lightrail Transaction", lightrailTransaction.id, "was reversed by Transaction", reverseTransaction.id);
        return reverseTransaction;

    } else if (isReversible(lightrailTransaction, transactionChain)) {
        const reverseTransaction = await createReverse(auth, {
            id: `${lightrailTransaction.id}-webhook-rev`,
            metadata: {
                stripeWebhookTriggeredAction: `Transaction reversed by Lightrail because Stripe charge '${stripeCharge.id}' was refunded as fraudulent. Stripe eventId: '${event.id}', Stripe accountId: '${event.account}'`
            }
        }, lightrailTransaction.id);
        log.info("Lightrail Transaction", lightrailTransaction.id, "was reversed by Transaction", reverseTransaction.id);
        return reverseTransaction;

    } else if (isCaptured(lightrailTransaction, transactionChain)) {
        log.info("Transaction", lightrailTransaction.id, "was pending and has been captured. Reversing capture transaction...");
        const captureTransaction = transactionChain.find(txn => txn.transactionType === "capture");
        const reverseTransaction = await createReverse(auth, {
            id: `${captureTransaction.id}-webhook-rev`,
            metadata: {
                stripeWebhookTriggeredAction: `Transaction reversed by Lightrail because Stripe charge '${stripeCharge.id}' was refunded as fraudulent. Stripe eventId: '${event.id}', Stripe accountId: '${event.account}'`
            }
        }, captureTransaction.id);
        log.info("Transaction", lightrailTransaction.id, "was captured by transaction", captureTransaction.id, "which was reversed by", reverseTransaction.id);
        return reverseTransaction;

    } else if (isVoided(lightrailTransaction, transactionChain)) {
        log.info("Transaction", lightrailTransaction.id, "was pending and has already been voided. Fetching existing void transaction...");
        const voidTransaction = transactionChain.find(txn => txn.transactionType === "void");
        log.info("Transaction", lightrailTransaction.id, "was voided by transaction", voidTransaction.id);
        return voidTransaction;

    } else if (isVoidable(lightrailTransaction, transactionChain)) {
        log.info("Transaction", lightrailTransaction.id, "was pending: voiding...");
        const voidTransaction = await createVoid(auth, {
            id: `${lightrailTransaction.id}-webhook-void`,
            metadata: {
                stripeWebhookTriggeredAction: `Transaction voided by Lightrail because Stripe charge ${stripeCharge.id} was refunded as fraudulent. Stripe eventId: ${event.id}, Stripe accountId: ${event.account}`
            }
        }, lightrailTransaction.id);
        log.info("Voided Transaction", lightrailTransaction.id, "with void transaction", voidTransaction.id);
        return voidTransaction;

    } else {
        throw new Error(`Stripe webhook event '${event.id}' from account '${event.account}' indicated fraud. Corresponding Lightrail Transaction '${lightrailTransaction.id}' could not be reversed or voided and has not already been reversed or voided. Transactions in chain: ${transactionChain.map(txn => txn.id)}.`);
    }
}

function isFraudActionEvent(event: Stripe.events.IEvent & { account?: string }): boolean {
    if (event.type === "charge.refunded") {
        // Stripe supports partial refunds; if even one is marked with 'reason: fraudulent' we'll treat the Transaction as fraudulent
        return ((event.data.object as Stripe.charges.ICharge).refunds.data.find(refund => refund.reason === "fraudulent") !== undefined);
    } else if (event.type === "charge.refund.updated") {
        const refund = event.data.object as Stripe.refunds.IRefund;
        return (refund.reason === "fraudulent");
    } else if (event.type === "review.closed") {
        return ((event.data.object as Stripe.reviews.IReview).reason === "refunded_as_fraud");
    } else if (event.type === "charge.dispute.created") {
        return true;
    } else {
        log.info("This event is not one of ['charge.refunded', 'charge.refund.updated', 'review.closed', 'charge.dispute.created']: taking no action. Event ID=", event.id, "with Stripe connected account ID=", event.account);
        return false;
    }
}

async function getStripeChargeFromEvent(event: Stripe.events.IEvent & { account: string }): Promise<Stripe.charges.ICharge> {
    if (event.data.object.object === "charge") {
        return event.data.object as Stripe.charges.ICharge;
    } else if (event.data.object.object === "refund") {
        const refund = event.data.object as Stripe.refunds.IRefund;
        if (refund.charge == null) {
            // This can happen if payment_intent is set.  Lightrail doesn't support PaymentIntents
            // so this isn't relevant to us.
            return null;
        }
        return typeof refund.charge === "string" ? await retrieveCharge(refund.charge, !event.livemode, event.account) : refund.charge;
    } else if (event.data.object.object === "review") {
        const review = event.data.object as Stripe.reviews.IReview;
        if (review.charge == null) {
            // This can happen if payment_intent is set.  Lightrail doesn't support PaymentIntents
            // so this isn't relevant to us.
            return null;
        }
        return typeof review.charge === "string" ? await retrieveCharge(review.charge, !event.livemode, event.account) : review.charge;
    } else if (event.data.object.object === "dispute") {
        const dispute = event.data.object as Stripe.disputes.IDispute;
        if (dispute.charge == null) {
            // This can happen if payment_intent is set.  Lightrail doesn't support PaymentIntents
            // so this isn't relevant to us.
            return null;
        }
        return typeof dispute.charge === "string" ? await retrieveCharge(dispute.charge, !event.livemode, event.account) : dispute.charge;
    } else {
        throw new Error(`Could not retrieve Stripe charge from event. Event=${JSON.stringify(event)}`);
    }
}
