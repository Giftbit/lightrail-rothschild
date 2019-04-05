import log = require("loglevel");
import Stripe = require("stripe");
import * as giftbitRoutes from "giftbit-cassava-routes";
import {GiftbitRestError} from "giftbit-cassava-routes";
import {LightrailAndMerchantStripeConfig, StripeConfig, StripeModeConfig} from "./StripeConfig";
import {StripeAuth} from "./StripeAuth";
import * as cassava from "cassava";
import {httpStatusCode, RestError} from "cassava";
import * as kvsAccess from "../kvsAccess";
import {AuthorizationBadge} from "giftbit-cassava-routes/dist/jwtauth";
import {generateCode} from "../codeGenerator";
import {DbTransaction} from "../../model/Transaction";
import {getKnexRead} from "../dbUtils/connection";

let assumeCheckoutToken: Promise<giftbitRoutes.secureConfig.AssumeScopeToken>;

export function initializeAssumeCheckoutToken(tokenPromise: Promise<giftbitRoutes.secureConfig.AssumeScopeToken>): void {
    assumeCheckoutToken = tokenPromise;
}

export async function setupLightrailAndMerchantStripeConfig(auth: giftbitRoutes.jwtauth.AuthorizationBadge): Promise<LightrailAndMerchantStripeConfig> {
    const authorizeAs = auth.getAuthorizeAsPayload();

    if (!assumeCheckoutToken) {
        throw new Error("AssumeCheckoutToken has not been initialized.");
    }
    log.info("fetching retrieve stripe auth assume token");
    const assumeToken = (await assumeCheckoutToken).assumeToken;
    log.info("got retrieve stripe auth assume token");

    const lightrailStripeModeConfig = await getLightrailStripeModeConfig(auth.isTestUser());

    log.info("fetching merchant stripe auth");
    const merchantStripeConfig: StripeAuth = await kvsAccess.kvsGet(assumeToken, "stripeAuth", authorizeAs);
    log.info("got merchant stripe auth");
    validateStripeConfig(merchantStripeConfig, lightrailStripeModeConfig);

    return {merchantStripeConfig, lightrailStripeConfig: lightrailStripeModeConfig};
}

let lightrailStripeConfig: Promise<StripeConfig>;

export function initializeLightrailStripeConfig(lightrailStripePromise: Promise<StripeConfig>): void {
    lightrailStripeConfig = lightrailStripePromise;
}

/**
 * Get Stripe credentials for test or live mode.  Test mode credentials allow
 * dummy credit cards and skip through stripe connect.
 * @param testMode whether to use test account credentials or live credentials
 */
export async function getLightrailStripeModeConfig(testMode: boolean): Promise<StripeModeConfig> {
    if (!lightrailStripeConfig) {
        throw new Error("lightrailStripeConfig has not been initialized.");
    }
    return testMode ? (await lightrailStripeConfig).test : (await lightrailStripeConfig).live;
}

function validateStripeConfig(merchantStripeConfig: StripeAuth, lightrailStripeConfig: StripeModeConfig) {
    if (!merchantStripeConfig || !merchantStripeConfig.stripe_user_id) {
        throw new GiftbitRestError(424, "Merchant stripe config stripe_user_id must be set.", "MissingStripeUserId");
    }
    if (!lightrailStripeConfig || !lightrailStripeConfig.secretKey) {
        log.debug("Lightrail stripe secretKey could not be loaded from s3 secure config.");
        throw new RestError(httpStatusCode.serverError.INTERNAL_SERVER_ERROR);
    }
}

/**
 * This is a workaround method until we can get the Lightrail userId directly from the Stripe accountId.
 * When that happens we'll be able to build the badge solely from the accountId and test/live flag on the event.
 */
export async function getAuthBadgeFromStripeCharge(stripeAccountId: string, stripeCharge: Stripe.charges.ICharge, event: Stripe.events.IEvent & { account: string }): Promise<giftbitRoutes.jwtauth.AuthorizationBadge> {
    let lightrailUserId = await getLightrailUserIdFromStripeCharge(stripeAccountId, stripeCharge, !event.livemode);

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
 * This is a workaround method. For now, it relies on finding the Lightrail userId by looking up the root Transaction that the Stripe charge is attached to.
 * Stripe resource IDs are globally unique so this is a reasonable temporary method.
 * When the new user service exists and provides a direct mapping from Stripe accountId to Lightrail userId, we'll be able to do a direct lookup without using the Stripe charge.
 * @param stripeAccountId
 * @param stripeCharge
 * @param testMode - currently not actually required (lightrailUserId will contain "-TEST" already) but will be for non-workaround method
 */
async function getLightrailUserIdFromStripeCharge(stripeAccountId: string, stripeCharge: Stripe.charges.ICharge, testMode: boolean): Promise<string> {
    try {
        const rootTransaction: DbTransaction = await getRootDbTransactionFromStripeCharge(stripeCharge);
        return rootTransaction.createdBy;
    } catch (e) {
        log.error(`Could not get Lightrail userId from Stripe accountId ${stripeAccountId} and charge ${stripeCharge.id}. \nError: ${e}`);
        throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.UNAUTHORIZED, `Could not get Lightrail userId from Stripe accountId ${stripeAccountId} and charge ${stripeCharge.id}`);
    }
}

export async function getRootDbTransactionFromStripeCharge(stripeCharge: Stripe.charges.ICharge): Promise<DbTransaction> {
    try {
        const knex = await getKnexRead();
        const res: DbTransaction[] = await knex("Transactions")
            .join("StripeTransactionSteps", {
                "StripeTransactionSteps.userId": "Transactions.userId",
                "Transactions.id": "StripeTransactionSteps.transactionId",
            })
            .where({"StripeTransactionSteps.chargeId": stripeCharge.id}) // this can return multiple Transactions
            .select("Transactions.*");

        return res.find(tx => tx.id === tx.rootTransactionId);
    } catch (e) {
        throw new giftbitRoutes.GiftbitRestError(404, `Could not find Lightrail Transaction corresponding to Stripe Charge '${stripeCharge.id}'.`, "TransactionNotFound");
    }
}
