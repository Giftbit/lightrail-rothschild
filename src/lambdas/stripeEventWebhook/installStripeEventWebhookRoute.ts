import log = require("loglevel");
import Stripe = require("stripe");
import * as cassava from "cassava";
import {getLightrailStripeModeConfig} from "../../utils/stripeUtils/stripeAccess";
import {StripeModeConfig} from "../../utils/stripeUtils/StripeConfig";
import * as giftbitRoutes from "giftbit-cassava-routes";
import {DbTransaction, LightrailTransactionStep, StripeTransactionStep, Transaction} from "../../model/Transaction";
import {AuthorizationBadge} from "giftbit-cassava-routes/dist/jwtauth";
import {createReverse, createVoid, getTransaction} from "../rest/transactions/transactions";
import {getKnexRead, getKnexWrite} from "../../utils/dbUtils/connection";
import {DbValue, Value} from "../../model/Value";
import {stripeLiveLightrailConfig, stripeLiveMerchantConfig} from "../../utils/testUtils/stripeTestUtils";
import {retrieveCharge} from "../../utils/stripeUtils/stripeTransactions";
import {generateCode} from "../../utils/codeGenerator";


export function installStripeEventWebhookRoute(router: cassava.Router): void {
    // These paths are configured in our Stripe account and not publicly known
    // (not that it would do any harm as we verify signatures).
    router.route("/v2/stripeEventWebhook")
        .method("POST")
        .handler(async evt => {
            const testMode: boolean = !evt.body.livemode;
            const lightrailStripeConfig: StripeModeConfig = await getLightrailStripeModeConfig(testMode);
            const stripe = new Stripe(lightrailStripeConfig.secretKey);

            let event: Stripe.events.IEvent & { account?: string };
            log.info("Verifying Stripe signature...");
            try {
                event = stripe.webhooks.constructEvent(evt.bodyRaw, evt.headersLowerCase["stripe-signature"], lightrailStripeConfig.connectWebhookSigningSecret);
                log.info(`Stripe signature verified. Event: ${JSON.stringify(event)}`);
            } catch (err) {
                log.info("Event could not be verified.");
                throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.UNAUTHORIZED, "The Stripe signature could not be validated");
            }

            if (event.account) {
                await handleConnectedAccountEvent((event as any), stripe); // cast to any since event.account definitely exists here
            } else {
                log.warn(`Received event '${event.id}' that did not have property 'account'. This endpoint is not configured to handle events from the Lightrail Stripe account.`);
                return {
                    statusCode: 204,
                    body: null
                };
            }

            return {
                statusCode: 204,
                body: null
            };
        });
}

async function handleConnectedAccountEvent(event: Stripe.events.IEvent & { account: string }, stripe: Stripe) {

    if (checkEventForFraudAction(event)) {
        log.info(`Event ${event.id} indicates that fraud has occurred. Reversing corresponding Lightrail Transaction and freezing associated Values.`);

        const stripeAccountId: string = event.account;
        const stripeCharge: Stripe.charges.ICharge = await getStripeChargeFromEvent(event, stripe);
        const auth = getAuthBadgeFromStripeCharge(stripeAccountId, stripeCharge, event);

        const presumedLightrailTransactionId = stripeCharge.metadata["lightrailTransactionId"];
        let lightrailTransaction: Transaction = await getLightrailTransactionFromStripeCharge(auth, stripeCharge, presumedLightrailTransactionId);
        let handlingTransaction: Transaction;
        try {
            handlingTransaction = await reverseOrVoidFraudulentTransaction(auth, (event as any), stripeCharge);
        } catch (e) {
            // todo metrics on failure
            giftbitRoutes.sentry.sendErrorNotification(e);
        }
        await handleValuesAffectedByFraudulentTransaction(auth, event, stripeCharge, lightrailTransaction, handlingTransaction);
    } else {
        log.info(`Received Connected Account event of type '${event.type}', eventId '${event.id}', accountId '${event.account}'. Exiting without handling.`);
        return;
    }
}

async function getLightrailTransactionFromStripeCharge(auth, stripeCharge, presumedLightrailTransactionId): Promise<Transaction> {
    const transaction: Transaction = await getTransaction(auth, presumedLightrailTransactionId);
    if (checkMatchStripeChargeLightrailTransaction(stripeCharge, transaction)) {
        return transaction;
    } else {
        throw new giftbitRoutes.GiftbitRestError(404, `Could not find Lightrail Transaction corresponding to Stripe Charge '${stripeCharge.id}'.`, "TransactionNotFound");
    }
}

async function reverseOrVoidFraudulentTransaction(auth: giftbitRoutes.jwtauth.AuthorizationBadge, event: Stripe.events.IEvent & { account: string }, stripeCharge: Stripe.charges.ICharge): Promise<Transaction> {
    const presumedLightrailTransactionId = stripeCharge.metadata["lightrailTransactionId"];
    const dbTransactionChain: DbTransaction[] = await getLightrailDbTransactionChainFromStripeCharge(auth, stripeCharge, presumedLightrailTransactionId);
    const dbTransactionToHandle: DbTransaction = dbTransactionChain.find(txn => txn.id === presumedLightrailTransactionId);

    let reverseOrVoidTransaction: Transaction;

    if (isReversed(dbTransactionToHandle, dbTransactionChain)) {
        log.info(`Transaction '${dbTransactionToHandle.id}' has already been reversed. Fetching existing reverse transaction...`);
        const reverseDbTransaction = dbTransactionChain.find(txn => txn.transactionType === "reverse" && txn.rootTransactionId === dbTransactionToHandle.id);
        reverseOrVoidTransaction = await getTransaction(auth, reverseDbTransaction.id);

        log.info(`Lightrail Transaction '${dbTransactionToHandle.id}' was reversed by Transaction '${reverseOrVoidTransaction.id}'`);

    } else if (isReversible(dbTransactionToHandle, dbTransactionChain)) {
        reverseOrVoidTransaction = await createReverse(auth, {
            id: `${dbTransactionToHandle.id}-webhook-rev`,
            metadata: {
                stripeWebhookTriggeredAction: `Transaction reversed by Lightrail because Stripe charge '${stripeCharge.id}' was refunded as fraudulent. Stripe eventId: '${event.id}', Stripe accountId: '${event.account}'`
            }
        }, dbTransactionToHandle.id);

        log.info(`Lightrail Transaction '${dbTransactionToHandle.id}' was reversed by Transaction '${reverseOrVoidTransaction.id}'`);

    } else if (isVoided(dbTransactionToHandle, dbTransactionChain)) {
        log.info(`Transaction '${dbTransactionToHandle.id}' was pending and has already been voided. Fetching existing void transaction...`);

        let voidDbTransaction = dbTransactionChain.find(txn => txn.transactionType === "void" && txn.rootTransactionId === dbTransactionToHandle.id);
        reverseOrVoidTransaction = await getTransaction(auth, voidDbTransaction.id);

        log.info(`Transaction '${dbTransactionToHandle.id}' was voided by transaction '${reverseOrVoidTransaction.id}'`);

    } else if (isVoidable(dbTransactionToHandle, dbTransactionChain)) {
        log.info(`Transaction '${dbTransactionToHandle.id}' was pending: voiding...`);
        reverseOrVoidTransaction = await createVoid(auth, {
            id: `${dbTransactionToHandle.id}-webhook-void`,
            metadata: {
                stripeWebhookTriggeredAction: `Transaction voided by Lightrail because Stripe charge ${stripeCharge.id} was refunded as fraudulent. Stripe eventId: ${event.id}, Stripe accountId: ${event.account}`
            }
        }, dbTransactionToHandle.id);
        log.info(`Voided Transaction '${dbTransactionToHandle.id}' with void transaction '${reverseOrVoidTransaction.id}'`);

    } else {
        throw new Error(`Stripe webhook event '${event.id}' from account '${event.account}' indicated fraud. Corresponding Lightrail Transaction '${dbTransactionToHandle.id}' could not be reversed or voided and has not already been reversed or voided. Transactions in chain: ${dbTransactionChain.map(txn => txn.id)}. Will still try to freeze implicated Values.`);
    }

    return reverseOrVoidTransaction;
}

function checkEventForFraudAction(event: Stripe.events.IEvent & { account?: string }): boolean {
    if (event.type === "charge.refunded") {
        // Stripe supports partial refunds; if even one is marked with 'reason: fraudulent' we'll treat the Transaction as fraudulent
        return ((event.data.object as Stripe.charges.ICharge).refunds.data.find(refund => refund.reason === "fraudulent") !== undefined);
    } else if (event.type === "charge.refund.updated") {
        return ((event.data.object as Stripe.refunds.IRefund).reason === "fraudulent");
    } else if (event.type === "review.closed") {
        return ((event.data.object as Stripe.reviews.IReview).reason === "refunded_as_fraud");
    } else {
        log.info(`This event is not one of ['charge.refunded', 'charge.refund.updated', 'review.closed']: taking no action. Event ID: '${event.id}' with Stripe connected account ID: '${event.account}'`);
        return false;
    }
}

async function getStripeChargeFromEvent(event: Stripe.events.IEvent, stripe: Stripe): Promise<Stripe.charges.ICharge> {
    if (event.data.object.object === "charge") {
        return event.data.object as Stripe.charges.ICharge;
    } else if (event.data.object.object === "refund") {
        const refund = event.data.object as Stripe.refunds.IRefund;
        return typeof refund.charge === "string" ? await retrieveCharge(refund.charge, stripeLiveLightrailConfig.secretKey, stripeLiveMerchantConfig.stripeUserId) : refund.charge;
    } else if (event.data.object.object === "review") {
        const review = event.data.object as Stripe.reviews.IReview;
        return typeof review.charge === "string" ? await retrieveCharge(review.charge, stripeLiveLightrailConfig.secretKey, stripeLiveMerchantConfig.stripeUserId) : review.charge;
    } else {
        throw new Error(`Could not retrieve Stripe charge from event '${event.id}'`);
    }
}

async function getLightrailDbTransactionChainFromStripeCharge(auth: giftbitRoutes.jwtauth.AuthorizationBadge, stripeCharge: Stripe.charges.ICharge, lightrailTransactionId: string): Promise<DbTransaction[]> {
    const knex = await getKnexRead();
    const dbTransactionChain: DbTransaction[] = await knex("Transactions")
        .where("Transactions.userId", "=", auth.userId)
        .andWhere("Transactions.rootTransactionId", "=", lightrailTransactionId);

    const rootTransaction: Transaction = await getTransaction(auth, lightrailTransactionId);
    if (checkMatchStripeChargeLightrailTransaction(stripeCharge, rootTransaction)) {
        return dbTransactionChain;
    } else {
        throw new Error(`Property mismatch: Stripe charge '${stripeCharge.id}' should match a charge in Lightrail Transaction '${lightrailTransactionId}' except for refund details. Transaction='${JSON.stringify(rootTransaction)}'`);
    }
}

function checkMatchStripeChargeLightrailTransaction(stripeCharge: Stripe.charges.ICharge, lightrailTransaction: Transaction): boolean {
    const stripeStep = <StripeTransactionStep>lightrailTransaction.steps.find(step => step.rail === "stripe" && step.chargeId === stripeCharge.id);
    return !!stripeStep && stripeStep.charge.amount === stripeCharge.amount;
}

async function handleValuesAffectedByFraudulentTransaction(auth: giftbitRoutes.jwtauth.AuthorizationBadge, event: Stripe.events.IEvent & { account: string }, stripeCharge: Stripe.charges.ICharge, fraudulentTransaction: Transaction, reverseOrVoidTransaction?: Transaction): Promise<void> {
    // Get list of all Values used in the Transaction and all Values attached to Contacts used in the Transaction
    const lightrailSteps = <LightrailTransactionStep[]>fraudulentTransaction.steps.filter(step => step.rail === "lightrail");
    let affectedValueIds: string[] = lightrailSteps.map(step => step.valueId);
    const affectedContactIds: string[] = fraudulentTransaction.paymentSources.filter(src => src.rail === "lightrail" && src.contactId).map(src => (src as LightrailTransactionStep).contactId);

    log.info(`Freezing implicated Values: '${affectedValueIds}' and all Values attached to implicated Contacts: '${affectedContactIds}'`);

    try {
        await freezeValuesAffectedByFraud(auth, {
            valueIds: affectedValueIds,
            contactIds: affectedContactIds
        }, fraudulentTransaction.id, constructValueFreezeMessage(fraudulentTransaction.id, reverseOrVoidTransaction.id, stripeCharge.id, event));
        log.info("Implicated Values including all Values attached to implicated Contacts frozen.");
    } catch (e) {
        log.error(`Failed to freeze Values '${affectedValueIds}' and/or Values attached to Contacts '${affectedContactIds}'`);
        log.error(e);
        // todo soft alert on failure: metrics & sentry
    }
}

async function freezeValuesAffectedByFraud(auth: giftbitRoutes.jwtauth.AuthorizationBadge, valueIdentifiers: { valueIds?: string[], contactIds?: string[] }, lightrailTransactionId: string, message: string): Promise<void> {
    const knex = await getKnexWrite();
    await knex.transaction(async trx => {
        // Get the master version of the Values and lock them.
        const selectValueRes: DbValue[] = await trx("Values").select()
            .where({
                userId: auth.userId
            })
            .where((builder) => {
                builder.whereIn("id", valueIdentifiers.valueIds)
                    .orWhereIn("contactId", valueIdentifiers.contactIds);
            })
            .andWhereNot("isGenericCode", true)
            .forUpdate();

        if (selectValueRes.length === 0) {
            throw new giftbitRoutes.GiftbitRestError(404, `Values to freeze not found for Transaction '${lightrailTransactionId}' with valueIdentifiers '${valueIdentifiers}'.`, "ValueNotFound");
        }

        const existingValues: Value[] = await Promise.all(selectValueRes.map(async dbValue => await DbValue.toValue(dbValue)));

        const updateRes: number = await trx("Values")
            .where({
                userId: auth.userId,
            })
            .whereIn("id", existingValues.map(value => value.id))
            .update(Value.toDbValueUpdate(auth, {
                frozen: true,
                metadata: {
                    stripeWebhookTriggeredAction: message
                }
            }));
        if (updateRes === 0) {
            throw new cassava.RestError(404);
        }
        if (updateRes < selectValueRes.length) {
            throw new Error(`Illegal UPDATE query. Updated ${updateRes} Values, should have updated ${selectValueRes.length} Values.`);
        }
    });
}

/**
 * This is a workaround method. When we can get the Lightrail userId directly from the Stripe accountId, we won't need to pass in the charge.
 * @param stripeAccountId
 * @param stripeCharge
 */
export function getAuthBadgeFromStripeCharge(stripeAccountId: string, stripeCharge: Stripe.charges.ICharge, event: Stripe.events.IEvent & { account: string }): giftbitRoutes.jwtauth.AuthorizationBadge {
    let lightrailUserId = getLightrailUserIdFromStripeCharge(stripeAccountId, stripeCharge, !event.livemode);

    return new AuthorizationBadge({
        g: {
            gui: lightrailUserId,
            tmi: lightrailUserId,
        },
        iat: Date.now(),
        jti: `webhook-badge-${generateCode({})}`,
        scopes: ["lightrailV2:transactions:list", "lightrailV2:transactions:reverse", "lightrailV2:transactions:void", "lightrailV2:values:list", "lightrailV2:values:update", "lightrailV2:contacts:list"]
    });
}

/**
 * This is a workaround method. For now, it relies on finding the Lightrail userId directly in the charge metadata.
 * This is not reliable or safe as a permanent solution; it's waiting on the new user service to provide a direct mapping
 * from Stripe accountId to Lightrail userId. When that happens, we won't need to pass the charge object in.
 * @param stripeAccountId
 * @param stripeCharge
 * @param testMode - currently not actually required (lightrailUserId written to charge metadata will contain "-TEST" already) but will be for non-workaround method
 */
function getLightrailUserIdFromStripeCharge(stripeAccountId: string, stripeCharge: Stripe.charges.ICharge, testMode: boolean): string {
    if (stripeCharge.metadata["lightrailUserId"] && stripeCharge.metadata["lightrailUserId"].length > 0) {
        return stripeCharge.metadata["lightrailUserId"];
    } else {
        throw new Error(`Could not get Lightrail userId from Stripe accountId ${stripeAccountId} and charge ${stripeCharge.id}`);
    }
}

function constructValueFreezeMessage(lightrailTransactionId: string, lightrailReverseId: string, stripeChargeId: string, stripeEvent: Stripe.events.IEvent & { account: string }): string {
    return `Value frozen by Lightrail because it or an attached Contact was associated with a Stripe charge that was refunded as fraudulent. Lightrail transactionId '${lightrailTransactionId}' with reverse/void transaction '${lightrailReverseId}', Stripe chargeId: '${stripeChargeId}', Stripe eventId: '${stripeEvent.id}', Stripe accountId: '${stripeEvent.account}'`;
}

function isReversible(transaction: DbTransaction, transactionChain: DbTransaction[]): boolean {
    return transaction.transactionType !== "reverse" &&
        !transaction.pendingVoidDate &&
        transaction.transactionType !== "void" &&
        !isReversed(transaction, transactionChain);
}

function isReversed(transaction: DbTransaction, transactionChain: DbTransaction[]): boolean {
    return !!transactionChain.find(txn => txn.transactionType === "reverse" && txn.rootTransactionId === transaction.id);
}

function isVoidable(transaction: DbTransaction, transactionChain: DbTransaction[]): boolean {
    return !!transaction.pendingVoidDate &&
        !isVoided(transaction, transactionChain);
}

function isVoided(transaction: DbTransaction, transactionChain: DbTransaction[]): boolean {
    return !!transaction.pendingVoidDate &&
        !!transactionChain.find(txn => txn.transactionType === "void" && txn.rootTransactionId === transaction.id);
}

