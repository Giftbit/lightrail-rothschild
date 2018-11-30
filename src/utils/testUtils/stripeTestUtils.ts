import * as giftbitRoutes from "giftbit-cassava-routes";
import * as kvsAccess from "../kvsAccess";
import * as sinon from "sinon";
import * as stripe from "stripe";
import {defaultTestUser} from "./index";
import * as stripeTransactions from "../stripeUtils/stripeTransactions";
import {
    CheckoutRequest,
    StripeTransactionParty,
    TransactionParty,
    TransferRequest
} from "../../model/TransactionRequest";
import {StripeRestError} from "../stripeUtils/StripeRestError";

const sinonSandbox = sinon.createSandbox();
let stripeChargeStub: sinon.SinonStub = null;
let stripeRefundStub: sinon.SinonStub = null;

/**
 * Config from stripe test account//pass: integrationtesting+merchant@giftbit.com // x39Rlf4TH3pzn29hsb#
 */
export const stripeTestConfig = {
    secretKey: "sk_test_Fwb3uGyZsIb9eJ5ZQchNH5Em",
    stripeUserId: "acct_1BOVE6CM9MOvFvZK",
    customer: {
        id: "cus_CP4Zd1Dddy4cOH",
        defaultCard: "card_1C0GSUCM9MOvFvZK8VB29qaz",
        nonDefaultCard: "card_1C0ZH9CM9MOvFvZKyZZc2X4Z"
    }
};

const stripeStubbedConfig = {
    secretKey: "test",
    stripeUserId: "test"
};

export function setStubsForStripeTests() {
    const testAssumeToken: giftbitRoutes.secureConfig.AssumeScopeToken = {
        assumeToken: "this-is-an-assume-token"
    };

    let stubFetchFromS3ByEnvVar = sinonSandbox.stub(giftbitRoutes.secureConfig, "fetchFromS3ByEnvVar");
    stubFetchFromS3ByEnvVar.withArgs("SECURE_CONFIG_BUCKET", "SECURE_CONFIG_KEY_ASSUME_RETRIEVE_STRIPE_AUTH").resolves(testAssumeToken);
    stubFetchFromS3ByEnvVar.withArgs("SECURE_CONFIG_BUCKET", "SECURE_CONFIG_KEY_STRIPE").resolves({
        email: "test@test.com",
        test: {
            clientId: "test-client-id",
            secretKey: testStripeLive() ? stripeTestConfig.secretKey : stripeStubbedConfig.secretKey,
            publishableKey: "test-pk",
        },
        live: {}
    });

    let stubKvsGet = sinonSandbox.stub(kvsAccess, "kvsGet");
    stubKvsGet.withArgs(sinon.match(testAssumeToken.assumeToken), sinon.match("stripeAuth"), sinon.match.string).resolves({
        token_type: "bearer",
        stripe_user_id: testStripeLive() ? stripeTestConfig.stripeUserId : stripeStubbedConfig.stripeUserId,
    });
}

export function unsetStubsForStripeTests() {
    sinonSandbox.restore();
    stripeChargeStub = null;
    stripeRefundStub = null;
}

export function testStripeLive(): boolean {
    return !!process.env["TEST_STRIPE_LIVE"];
}

export interface GenerateStripeChargeResponseOptions {
    transactionId: string;
    amount: number;
    currency: string;
    sources?: TransactionParty[];
    metadata?: object;
    additionalProperties?: Partial<stripe.charges.ICharge>;
}

export function generateStripeChargeResponse(options: GenerateStripeChargeResponseOptions): stripe.charges.ICharge {
    const chargeId = (options.additionalProperties && options.additionalProperties.id) || "ch_" + getRandomChars(24);
    return {
        "id": chargeId,
        "object": "charge",
        "amount": options.amount,
        "amount_refunded": 0,
        "application": "ca_D5LfFkNWh8XbFWxIcEx6N9FXaNmfJ9Fr",
        "application_fee": null,
        "balance_transaction": "txn_" + getRandomChars(24),
        "captured": true,
        "created": Math.floor(Date.now() / 1000),
        "currency": options.currency.toLowerCase(),
        "customer": null,
        "description": null,
        "destination": null,
        "dispute": null,
        "failure_code": null,
        "failure_message": null,
        "fraud_details": {},
        "invoice": null,
        "livemode": false,
        "metadata": {
            // This metadata object is tightly coupled to how the code that creates the charge.
            ...options.metadata,
            "lightrailTransactionId": options.transactionId,
            "lightrailTransactionSources": JSON.stringify((options.sources || []).filter(source => source.rail === "lightrail")),
            "lightrailUserId": defaultTestUser.userId
        },
        "on_behalf_of": null,
        "order": null,
        "outcome": {
            "network_status": "approved_by_network",
            "reason": null,
            "risk_level": "normal",
            "seller_message": "Payment complete.",
            "type": "authorized"
        },
        "paid": true,
        "receipt_email": null,
        "receipt_number": null,
        "refunded": false,
        "refunds": {
            "object": "list",
            "data": [],
            "has_more": false,
            "total_count": 0,
            "url": `/v1/charges/${chargeId}/refunds`
        },
        "review": null,
        "shipping": null,
        "source": {
            "id": "card_" + getRandomChars(24),
            "object": "card",
            "address_city": null,
            "address_country": null,
            "address_line1": null,
            "address_line1_check": null,
            "address_line2": null,
            "address_state": null,
            "address_zip": null,
            "address_zip_check": null,
            "brand": "Visa",
            "country": "US",
            "customer": null,
            "cvc_check": null,
            "dynamic_last4": null,
            "exp_month": 7,
            "exp_year": 2019,
            "fingerprint": "LMHNXKv7kEbxUNL9",
            "funding": "credit",
            "last4": "4242",
            "metadata": {},
            "name": null,
            "tokenization_method": null
        },
        "source_transfer": null,
        "statement_descriptor": null,
        "status": "succeeded",
        "transfer_group": null,
        ...options.additionalProperties
    };
}

export interface GenerateStripeRefundResponseOptions {
    amount: number;
    currency: string;
    stripeChargeId: string;
    reason?: string;
    additionalProperties?: Partial<stripe.refunds.IRefund>;
}

export function generateStripeRefundResponse(options: GenerateStripeRefundResponseOptions): stripe.refunds.IRefund {
    const refundId = (options.additionalProperties && options.additionalProperties.id) || "re_" + getRandomChars(24);
    return {
        "id": refundId,
        "object": "refund",
        "amount": options.amount,
        "balance_transaction": "txn_" + getRandomChars(24),
        "charge": options.stripeChargeId,
        "created": Math.floor(Date.now() / 1000),
        "currency": options.currency.toLowerCase(),
        "metadata": {
            "reason": options.reason || "Refunded due to error on the Lightrail side"
        },
        "reason": null,
        "receipt_number": null,
        "source_transfer_reversal": null,
        "transfer_reversal": null,
        "status": "succeeded",
        ...options.additionalProperties
    } as any;
}

export interface GetStripeChargeStubOptions {
    transactionId: string;
    amount?: number;
    currency?: string;
    source?: string;
    customer?: string;
}

export function getStripeChargeStub(options: GetStripeChargeStubOptions): sinon.SinonStub {
    let stub = stripeChargeStub || (stripeChargeStub = sinonSandbox.stub(stripeTransactions, "createCharge").callThrough());

    let param0Matcher = sinon.match.hasNested("metadata.lightrailTransactionId", options.transactionId);
    if (options.amount) {
        param0Matcher = param0Matcher.and(sinon.match.has("amount", options.amount));
    }
    if (options.currency) {
        param0Matcher = param0Matcher.and(sinon.match.has("currency", options.currency));
    }
    if (options.source) {
        param0Matcher = param0Matcher.and(sinon.match.has("source", options.source));
    }
    if (options.customer) {
        param0Matcher = param0Matcher.and(sinon.match.has("customer", options.customer));
    }

    return stub.withArgs(
        param0Matcher,
        sinon.match(stripeStubbedConfig.secretKey),
        sinon.match(stripeStubbedConfig.stripeUserId),
        sinon.match.any
    );
}

export interface GetStripeRefundStubOptions {
    amount: number;
    stripeChargeId: string;
}

export function getStripeRefundStub(options: GetStripeRefundStubOptions): sinon.SinonStub {
    let stub = stripeRefundStub || (stripeRefundStub = sinonSandbox.stub(stripeTransactions, "createRefund").callThrough());

    return stub.withArgs(
        sinon.match.has("amount", options.amount)
            .and(sinon.match.has("chargeId", options.stripeChargeId)),
        sinon.match(stripeStubbedConfig.secretKey),
        sinon.match(stripeStubbedConfig.stripeUserId)
    );
}

export function stubCheckoutStripeCharge(request: CheckoutRequest, stripeStepIx: number, amount: number, additionalProperties?: Partial<stripe.charges.ICharge>): [stripe.charges.ICharge, sinon.SinonStub] {
    if (testStripeLive()) {
        return [null, null];
    }

    if (request.sources[stripeStepIx].rail !== "stripe") {
        throw new Error(`Checkout request source ${stripeStepIx} is not a stripe source.`);
    }
    const stripeSource = request.sources[stripeStepIx] as StripeTransactionParty;

    const response = generateStripeChargeResponse({
            transactionId: request.id,
            amount: amount,
            currency: request.currency,
            sources: request.sources,
            metadata: request.metadata,
            additionalProperties
        }
    );

    const stub = getStripeChargeStub(
        {
            transactionId: request.id,
            amount: amount,
            currency: request.currency,
            source: stripeSource.source,
            customer: stripeSource.customer
        })
        .resolves(response);

    return [response, stub];
}

export function stubTransferStripeCharge(request: TransferRequest, additionalProperties?: Partial<stripe.charges.ICharge>): [stripe.charges.ICharge, sinon.SinonStub] {
    if (testStripeLive()) {
        return [null, null];
    }

    if (request.source.rail !== "stripe") {
        throw new Error(`Checkout request source is not a stripe source.`);
    }

    let amount = request.amount;
    if (request.source.maxAmount && request.source.maxAmount < amount) {
        amount = request.source.maxAmount;
    }

    const response = generateStripeChargeResponse({
            transactionId: request.id,
            amount: amount,
            currency: request.currency,
            sources: [request.destination],
            metadata: request.metadata,
            additionalProperties
        }
    );

    const stub = getStripeChargeStub(
        {
            transactionId: request.id,
            amount: amount,
            currency: request.currency,
            source: request.source.source,
            customer: request.source.customer
        })
        .resolves(response);

    return [response, stub];
}

export function stubCheckoutStripeError(request: CheckoutRequest, stripeStepIx: number, error: StripeRestError): void {
    if (testStripeLive()) {
        return;
    }

    if (request.sources[stripeStepIx].rail !== "stripe") {
        throw new Error(`Checkout request source ${stripeStepIx} is not a stripe source.`);
    }
    const stripeSource = request.sources[stripeStepIx] as StripeTransactionParty;

    getStripeChargeStub(
        {
            transactionId: request.id,
            currency: request.currency,
            source: stripeSource.source,
            customer: stripeSource.customer
        })
        .rejects(error);
}

export function stubTransferStripeError(request: TransferRequest, error: StripeRestError): void {
    if (testStripeLive()) {
        return;
    }

    if (request.source.rail !== "stripe") {
        throw new Error(`Checkout request source is not a stripe source.`);
    }

    getStripeChargeStub(
        {
            transactionId: request.id,
            currency: request.currency,
            source: request.source.source,
            customer: request.source.customer
        })
        .rejects(error);
}

export function stubStripeRefund(charge: stripe.charges.ICharge, additionalProperties?: Partial<stripe.refunds.IRefund>): [stripe.refunds.IRefund, sinon.SinonStub] {
    if (testStripeLive()) {
        return [null, null];
    }

    const response = generateStripeRefundResponse({
        amount: charge.amount,
        currency: charge.currency,
        stripeChargeId: charge.id,
        additionalProperties
    });

    const stub = getStripeRefundStub(
        {
            amount: charge.amount,
            stripeChargeId: charge.id
        })
        .resolves(response);

    return [response, stub];
}

/**
 * Throw an error if Stripe is charged for this transaction request.
 */
export function stubNoStripeCharge(request: { id: string }): void {
    if (testStripeLive()) {
        return;
    }

    getStripeChargeStub({transactionId: request.id})
        .rejects(new Error("The Stripe stub should never be called in this test"));
}

function getRandomChars(length: number): string {
    let res = "";
    const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    for (let i = 0; i < length; i++)
        res += charset.charAt(Math.floor(Math.random() * charset.length));

    return res;
}
