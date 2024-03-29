import * as cassava from "cassava";
import * as giftbitRoutes from "giftbit-cassava-routes";
import * as kvsAccess from "../kvsAccess";
import {stripeApiVersion, StripeConfig, StripeModeConfig} from "./StripeConfig";
import {StripeAuth} from "./StripeAuth";
import {AuthorizationBadge} from "giftbit-cassava-routes/dist/jwtauth";
import {generateCode} from "../codeGenerator";
import {DbTransaction, Transaction} from "../../model/Transaction";
import {getKnexRead} from "../dbUtils/connection";
import log = require("loglevel");
import Stripe = require("stripe");

let assumeCheckoutToken: Promise<giftbitRoutes.secureConfig.AssumeScopeToken>;

export function initializeAssumeCheckoutToken(tokenPromise: Promise<giftbitRoutes.secureConfig.AssumeScopeToken>): void {
    assumeCheckoutToken = tokenPromise;
}

/**
 * Cache the last used auth with its corresponding StripeAuth.
 */
const cachedMerchantStripeAuth = {
    auth: null as giftbitRoutes.jwtauth.AuthorizationBadge,
    userId: null as string,
    merchantStripeAuth: null as StripeAuth
};

export async function getMerchantStripeAuth(auth: giftbitRoutes.jwtauth.AuthorizationBadge): Promise<StripeAuth> {
    if (cachedMerchantStripeAuth.auth === auth && cachedMerchantStripeAuth.userId === auth.userId) {
        // Auth token is referentially the same and the userId has not changed.
        return cachedMerchantStripeAuth.merchantStripeAuth;
    }

    const authorizeAs = auth.getAuthorizeAsPayload();

    if (!assumeCheckoutToken) {
        throw new Error("AssumeCheckoutToken has not been initialized.");
    }
    log.info("fetching retrieve stripe auth assume token");
    const assumeToken = (await assumeCheckoutToken).assumeToken;
    log.info("got retrieve stripe auth assume token");

    log.info("fetching merchant stripe auth");
    let merchantStripeAuth: StripeAuth;
    try {
        merchantStripeAuth = await kvsAccess.kvsGet(assumeToken, "stripeAuth", authorizeAs);
    } catch (err) {
        log.error("error accessing stripeAuth from KVS", err);
        throw new giftbitRoutes.GiftbitRestError(503, "An internal service is temporarily unavailable.");
    }

    log.info("got merchant stripe auth");
    if (!merchantStripeAuth || !merchantStripeAuth.stripe_user_id) {
        throw new giftbitRoutes.GiftbitRestError(424, "Merchant stripe config stripe_user_id must be set.", "MissingStripeUserId");
    }

    cachedMerchantStripeAuth.auth = auth;
    cachedMerchantStripeAuth.userId = auth.userId;
    cachedMerchantStripeAuth.merchantStripeAuth = merchantStripeAuth;

    return merchantStripeAuth;
}

let lightrailStripeConfig: Promise<StripeConfig>;

export function initializeLightrailStripeConfig(lightrailStripePromise: Promise<StripeConfig>): void {
    lightrailStripeConfig = lightrailStripePromise;
}

/**
 * Get Stripe credentials for test or live mode.  Test mode credentials allow
 * dummy credit cards and skip through stripe connect.
 * @param isTestMode whether to use test account credentials or live credentials
 */
export async function getLightrailStripeModeConfig(isTestMode: boolean): Promise<StripeModeConfig> {
    if (!lightrailStripeConfig) {
        throw new Error("lightrailStripeConfig has not been initialized.");
    }
    return (process.env["TEST_ENV"] || isTestMode) ? (await lightrailStripeConfig).test : (await lightrailStripeConfig).live;
}

/**
 * Get Stripe client for test or live mode.  Test mode clients allow
 * dummy credit cards and skip through stripe connect.
 * @param isTestMode whether to use test account credentials or live credentials
 */
export async function getStripeClient(isTestMode: boolean): Promise<Stripe> {
    const stripeModeConfig = await getLightrailStripeModeConfig(isTestMode);
    if (!stripeModeConfig) {
        throw new Error("Lightrail stripe secretKey could not be loaded from s3 secure config.  stripeModeConfig=null");
    }
    if (!stripeModeConfig.secretKey) {
        throw new Error("Lightrail stripe secretKey could not be loaded from s3 secure config.  stripeModeConfig.secretKey=null");
    }

    let client: Stripe;
    if (process.env["TEST_STRIPE_LOCAL"] === "true") {
        log.warn("Using local Stripe server http://localhost:8000");
        client = new Stripe(stripeModeConfig.secretKey);
        client.setHost("localhost", 8000, "http");
    } else {
        client = new Stripe(stripeModeConfig.secretKey);
    }
    client.setApiVersion(stripeApiVersion);
    client.setMaxNetworkRetries(3); // Retries in case of network errors or 500s or 429s from Stripe. Timeouts do not trigger retries.
    client.setTimeout(27000); // API Gateway has a 29s timeout so we shouldn't let requests run longer than that. Timeouts do not trigger retries.
    return client;
}

/**
 * This is a workaround method until we can get the Lightrail userId directly from the Stripe accountId.
 * When that happens we'll be able to build the badge solely from the accountId and test/live flag on the event.
 */
export async function getAuthBadgeFromStripeCharge(stripeAccountId: string, stripeCharge: Stripe.charges.ICharge, event: Stripe.events.IEvent & { account: string }): Promise<giftbitRoutes.jwtauth.AuthorizationBadge> {
    const lightrailUserId = await getLightrailUserIdFromStripeCharge(stripeAccountId, stripeCharge, !event.livemode);

    return new AuthorizationBadge({
        g: {
            gui: lightrailUserId,
            tmi: "stripe-webhook-event-handler",
        },
        iat: Date.now(),
        jti: `webhook-badge-${generateCode({})}`,
        scopes: ["lightrailV2:transactions:list", "lightrailV2:transactions:reverse", "lightrailV2:transactions:void", "lightrailV2:values:list", "lightrailV2:values:update", "lightrailV2:contacts:list"]
    });
}

/**
 * This is a workaround method. For now, it relies on finding the Lightrail userId by looking up the root Transaction that the Stripe charge is attached to.
 * Stripe resource IDs are globally unique so this is a reasonable temporary method.
 * When the new user service exists and provides a direct mapping from Stripe accountId to Lightrail userId, we'll be able to do a direct lookup without using the Stripe charge.
 * @param stripeAccountId
 * @param stripeCharge
 * @param isTestMode - currently not actually required (lightrailUserId will contain "-TEST" already) but will be for non-workaround method
 */
async function getLightrailUserIdFromStripeCharge(stripeAccountId: string, stripeCharge: Stripe.charges.ICharge, isTestMode: boolean): Promise<string> {
    try {
        const rootTransaction: Transaction = await getRootTransactionFromStripeCharge(stripeCharge);
        return rootTransaction.createdBy;
    } catch (e) {
        log.error(`Could not get Lightrail userId from Stripe accountId ${stripeAccountId} and charge ${stripeCharge.id}. \nError: ${e}`);
        throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.UNAUTHORIZED, `Could not get Lightrail userId from Stripe accountId ${stripeAccountId} and charge ${stripeCharge.id}`);
    }
}

export async function getRootTransactionFromStripeCharge(stripeCharge: Stripe.charges.ICharge): Promise<Transaction> {
    const res = await getDbTransactionsFromStripeCharge(stripeCharge);
    const roots = res.filter(tx => tx.id === tx.rootTransactionId);

    if (roots.length === 1) {
        const dbTransaction = roots[0];
        const [transaction] = await DbTransaction.toTransactionsUsingDb([dbTransaction], dbTransaction.createdBy);
        return transaction;

    } else if (roots.length === 0) {
        throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.NOT_FOUND, `Could not find Lightrail Transaction corresponding to Stripe Charge '${stripeCharge.id}'.`, "TransactionNotFound");

    } else if (roots.length > 1) {
        throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.CONFLICT, `Multiple Lightrail root transactions returned for Stripe chargeId ${stripeCharge.id}`);
    }
}

async function getDbTransactionsFromStripeCharge(stripeCharge: Stripe.charges.ICharge): Promise<DbTransaction[]> {
    const knex = await getKnexRead();
    return await knex("Transactions")
        .join("StripeTransactionSteps", {
            "StripeTransactionSteps.userId": "Transactions.userId",
            "Transactions.id": "StripeTransactionSteps.transactionId",
        })
        .where({"StripeTransactionSteps.chargeId": stripeCharge.id}) // this can return multiple Transactions: refund steps use the chargeId of the charge they refund
        .select("Transactions.*");
}
