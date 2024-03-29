import * as cassava from "cassava";
import chaiExclude from "chai-exclude";
import * as chai from "chai";
import * as Stripe from "stripe";
import * as transactions from "../transactions";
import * as valueStores from "../../values/values";
import * as testUtils from "../../../../utils/testUtils";
import {defaultTestUser, generateId, setCodeCryptographySecrets} from "../../../../utils/testUtils";
import {Value} from "../../../../model/Value";
import {Transaction} from "../../../../model/Transaction";
import {CaptureRequest, CheckoutRequest, VoidRequest} from "../../../../model/TransactionRequest";
import {
    setStubbedStripeUserId,
    setStubsForStripeTests,
    testStripeLive,
    unsetStubsForStripeTests
} from "../../../../utils/testUtils/stripeTestUtils";
import {captureCharge, createRefund} from "../../../../utils/stripeUtils/stripeTransactions";
import {TestUser} from "../../../../utils/testUtils/TestUser";
import {getStripeClient} from "../../../../utils/stripeUtils/stripeAccess";
import {createCurrency} from "../../currencies";
import {nowInDbPrecision} from "../../../../utils/dbUtils";
import {LightrailTransactionStep, StripeTransactionStep} from "../../../../model/TransactionStep";

chai.use(chaiExclude);

describe("/v2/transactions/checkout - pending", () => {

    const router = new cassava.Router();

    before(async () => {
        await testUtils.resetDb();
        router.route(testUtils.authRoute);
        transactions.installTransactionsRest(router);
        valueStores.installValuesRest(router);
        await createCurrency(testUtils.defaultTestUser.auth, {
            code: "CAD",
            name: "Canadian Tire Money",
            symbol: "$",
            decimalPlaces: 2,
            createdDate: nowInDbPrecision(),
            updatedDate: nowInDbPrecision(),
            createdBy: testUtils.defaultTestUser.teamMemberId
        });
        setCodeCryptographySecrets();
        await setStubsForStripeTests();
    });

    after(() => {
        unsetStubsForStripeTests();
    });

    it("can create and void a pending transaction, Lightrail only", async () => {
        const value: Partial<Value> = {
            id: generateId(),
            currency: "CAD",
            balance: 1000,
        };
        const valueRes = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
        chai.assert.equal(valueRes.statusCode, 201, `body=${JSON.stringify(valueRes.body)}`);

        const pendingTx: CheckoutRequest = {
            id: generateId(),
            sources: [
                {
                    rail: "lightrail",
                    valueId: value.id
                }
            ],
            lineItems: [
                {
                    type: "product",
                    productId: "🍌",
                    unitPrice: 50
                }
            ],
            currency: "CAD",
            pending: true
        };
        const pendingTxRes = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", pendingTx);
        chai.assert.equal(pendingTxRes.statusCode, 201, `body=${JSON.stringify(pendingTxRes.body)}`);
        chai.assert.deepEqualExcluding(pendingTxRes.body, {
            id: pendingTx.id,
            transactionType: "checkout",
            currency: "CAD",
            totals: {
                subtotal: 50,
                tax: 0,
                discount: 0,
                discountLightrail: 0,
                payable: 50,
                paidInternal: 0,
                paidLightrail: 50,
                paidStripe: 0,
                remainder: 0,
                forgiven: 0
            },
            lineItems: [
                {
                    type: "product",
                    productId: "🍌",
                    unitPrice: 50,
                    quantity: 1,
                    lineTotal: {
                        subtotal: 50,
                        taxable: 50,
                        tax: 0,
                        discount: 0,
                        payable: 50,
                        remainder: 0
                    }
                }
            ],
            steps: [
                {
                    rail: "lightrail",
                    valueId: value.id,
                    code: null,
                    contactId: null,
                    balanceRule: null,
                    balanceBefore: 1000,
                    balanceAfter: 950,
                    balanceChange: -50,
                    usesRemainingBefore: null,
                    usesRemainingAfter: null,
                    usesRemainingChange: null
                }
            ],
            paymentSources: [
                {
                    rail: "lightrail",
                    valueId: value.id
                }
            ],
            pending: true,
            pendingVoidDate: null,
            metadata: null,
            tax: {
                roundingMode: "HALF_EVEN"
            },
            createdDate: null,
            createdBy: defaultTestUser.auth.teamMemberId
        }, ["createdDate", "pendingVoidDate"]);
        chai.assert.isNotNull(pendingTxRes.body.pendingVoidDate);

        const getPendingTxRes = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${pendingTx.id}`, "GET");
        chai.assert.equal(getPendingTxRes.statusCode, 200, `body=${JSON.stringify(getPendingTxRes.body)}`);
        chai.assert.deepEqual(getPendingTxRes.body, pendingTxRes.body);

        const valuePendingRes = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}`, "GET");
        chai.assert.equal(valuePendingRes.body.balance, 950);

        const voidTx: VoidRequest = {
            id: generateId()
        };
        const voidRes = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${pendingTx.id}/void`, "POST", voidTx);
        chai.assert.equal(voidRes.statusCode, 201, `body=${JSON.stringify(voidRes.body)}`);
        chai.assert.deepEqualExcluding(voidRes.body, {
            id: voidTx.id,
            transactionType: "void",
            currency: "CAD",
            totals: {
                subtotal: -50,
                tax: 0,
                discount: 0,
                discountLightrail: 0,
                payable: -50,
                paidInternal: 0,
                paidLightrail: -50,
                paidStripe: 0,
                remainder: 0,
                forgiven: 0
            },
            lineItems: null,
            steps: [
                {
                    rail: "lightrail",
                    valueId: value.id,
                    code: null,
                    contactId: null,
                    balanceRule: null,
                    balanceBefore: 950,
                    balanceAfter: 1000,
                    balanceChange: 50,
                    usesRemainingBefore: null,
                    usesRemainingAfter: null,
                    usesRemainingChange: null
                }
            ],
            paymentSources: null,
            pending: false,
            metadata: null,
            tax: {
                roundingMode: "HALF_EVEN"
            },
            createdDate: null,
            createdBy: defaultTestUser.auth.teamMemberId
        }, ["createdDate"]);

        const getVoidRes = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${voidRes.body.id}`, "GET");
        chai.assert.equal(getVoidRes.statusCode, 200, `body=${JSON.stringify(getVoidRes.body)}`);
        chai.assert.deepEqual(getVoidRes.body, voidRes.body);

        const valueVoidRes = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}`, "GET");
        chai.assert.equal(valueVoidRes.body.balance, 1000);
    });

    it("can create and capture a pending transaction, Lightrail only", async () => {
        const value: Partial<Value> = {
            id: generateId(),
            currency: "CAD",
            balance: 1000,
        };
        const valueRes = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
        chai.assert.equal(valueRes.statusCode, 201, `body=${JSON.stringify(valueRes.body)}`);

        const pendingTx: CheckoutRequest = {
            id: generateId(),
            sources: [
                {
                    rail: "lightrail",
                    valueId: value.id
                }
            ],
            lineItems: [
                {
                    type: "product",
                    productId: "🍌",
                    unitPrice: 50
                }
            ],
            currency: "CAD",
            pending: true
        };
        const pendingTxRes = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", pendingTx);
        chai.assert.equal(pendingTxRes.statusCode, 201, `body=${JSON.stringify(pendingTxRes.body)}`);
        chai.assert.deepEqualExcluding(pendingTxRes.body, {
            id: pendingTx.id,
            transactionType: "checkout",
            currency: "CAD",
            totals: {
                subtotal: 50,
                tax: 0,
                discount: 0,
                discountLightrail: 0,
                payable: 50,
                paidInternal: 0,
                paidLightrail: 50,
                paidStripe: 0,
                remainder: 0,
                forgiven: 0
            },
            lineItems: [
                {
                    type: "product",
                    productId: "🍌",
                    unitPrice: 50,
                    quantity: 1,
                    lineTotal: {
                        subtotal: 50,
                        taxable: 50,
                        tax: 0,
                        discount: 0,
                        payable: 50,
                        remainder: 0
                    }
                }
            ],
            steps: [
                {
                    rail: "lightrail",
                    valueId: value.id,
                    code: null,
                    contactId: null,
                    balanceRule: null,
                    balanceBefore: 1000,
                    balanceAfter: 950,
                    balanceChange: -50,
                    usesRemainingBefore: null,
                    usesRemainingAfter: null,
                    usesRemainingChange: null
                }
            ],
            paymentSources: [
                {
                    rail: "lightrail",
                    valueId: value.id
                }
            ],
            pending: true,
            pendingVoidDate: null,
            metadata: null,
            tax: {
                roundingMode: "HALF_EVEN"
            },
            createdDate: null,
            createdBy: defaultTestUser.auth.teamMemberId
        }, ["createdDate", "pendingVoidDate"]);
        chai.assert.isNotNull(pendingTxRes.body.pendingVoidDate);

        const getPendingTxRes = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${pendingTx.id}`, "GET");
        chai.assert.equal(getPendingTxRes.statusCode, 200, `body=${JSON.stringify(getPendingTxRes.body)}`);
        chai.assert.deepEqual(getPendingTxRes.body, pendingTxRes.body);

        const valuePendingRes = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}`, "GET");
        chai.assert.equal(valuePendingRes.body.balance, 950);

        const captureTx: CaptureRequest = {
            id: generateId()
        };
        const captureRes = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${pendingTx.id}/capture`, "POST", captureTx);
        chai.assert.equal(captureRes.statusCode, 201, `body=${JSON.stringify(captureRes.body)}`);
        chai.assert.deepEqualExcluding(captureRes.body, {
            id: captureTx.id,
            transactionType: "capture",
            currency: "CAD",
            totals: null,
            lineItems: null,
            steps: [],
            paymentSources: null,
            pending: false,
            metadata: null,
            tax: {
                roundingMode: "HALF_EVEN"
            },
            createdDate: null,
            createdBy: defaultTestUser.auth.teamMemberId
        }, ["createdDate"]);

        const getCaptureRes = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${captureRes.body.id}`, "GET");
        chai.assert.equal(getCaptureRes.statusCode, 200, `body=${JSON.stringify(getCaptureRes.body)}`);
        chai.assert.deepEqual(getCaptureRes.body, captureRes.body);

        const valueCaptureRes = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}`, "GET");
        chai.assert.equal(valueCaptureRes.body.balance, 950);
    });

    it("can create and void a pending transaction, Lightrail and Stripe", async () => {
        const value: Partial<Value> = {
            id: generateId(),
            currency: "CAD",
            balance: 1000,
        };
        const valueRes = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
        chai.assert.equal(valueRes.statusCode, 201, `body=${JSON.stringify(valueRes.body)}`);

        const pendingTx: CheckoutRequest = {
            id: generateId(),
            sources: [
                {
                    rail: "lightrail",
                    valueId: value.id
                },
                {
                    rail: "stripe",
                    source: "tok_visa"
                }
            ],
            lineItems: [
                {
                    type: "product",
                    productId: "🚗",
                    unitPrice: 14286,
                    taxRate: 0.05
                }
            ],
            currency: "CAD",
            pending: true
        };
        const pendingTxRes = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", pendingTx);
        chai.assert.equal(pendingTxRes.statusCode, 201, `body=${JSON.stringify(pendingTxRes.body)}`);
        chai.assert.deepEqualExcluding(pendingTxRes.body, {
            id: pendingTx.id,
            transactionType: "checkout",
            currency: "CAD",
            totals: {
                subtotal: 14286,
                tax: 714,
                discount: 0,
                discountLightrail: 0,
                payable: 15000,
                paidInternal: 0,
                paidLightrail: 1000,
                paidStripe: 14000,
                remainder: 0,
                forgiven: 0
            },
            lineItems: [
                {
                    type: "product",
                    productId: "🚗",
                    unitPrice: 14286,
                    taxRate: 0.05,
                    quantity: 1,
                    lineTotal: {
                        subtotal: 14286,
                        taxable: 14286,
                        tax: 714,
                        discount: 0,
                        payable: 15000,
                        remainder: 0
                    }
                }
            ],
            steps: [
                // only asserted when not live
            ],
            paymentSources: [
                {
                    rail: "lightrail",
                    valueId: value.id
                },
                {
                    rail: "stripe",
                    source: "tok_visa"
                }
            ],
            pending: true,
            pendingVoidDate: null,
            metadata: null,
            tax: {
                roundingMode: "HALF_EVEN"
            },
            createdDate: null,
            createdBy: defaultTestUser.auth.teamMemberId
        }, ["createdDate", "pendingVoidDate", "steps"]);
        chai.assert.isNotNull(pendingTxRes.body.pendingVoidDate);
        chai.assert.equal((pendingTxRes.body.steps[0] as LightrailTransactionStep).balanceBefore, 1000);
        chai.assert.equal((pendingTxRes.body.steps[0] as LightrailTransactionStep).balanceAfter, 0);
        chai.assert.equal((pendingTxRes.body.steps[0] as LightrailTransactionStep).balanceChange, -1000);
        chai.assert.equal((pendingTxRes.body.steps[1] as StripeTransactionStep).amount, -14000);
        chai.assert.isString((pendingTxRes.body.steps[1] as StripeTransactionStep).chargeId);
        chai.assert.isObject((pendingTxRes.body.steps[1] as StripeTransactionStep).charge);
        chai.assert.isFalse(((pendingTxRes.body.steps[1] as StripeTransactionStep).charge as Stripe.charges.ICharge).captured);

        const getPendingTxRes = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${pendingTx.id}`, "GET");
        chai.assert.equal(getPendingTxRes.statusCode, 200, `body=${JSON.stringify(getPendingTxRes.body)}`);
        chai.assert.deepEqual(getPendingTxRes.body, pendingTxRes.body);

        const valuePendingRes = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}`, "GET");
        chai.assert.equal(valuePendingRes.body.balance, 0);

        const voidTx: VoidRequest = {
            id: generateId()
        };
        const voidRes = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${pendingTx.id}/void`, "POST", voidTx);
        chai.assert.equal(voidRes.statusCode, 201, `body=${JSON.stringify(voidRes.body)}`);
        chai.assert.isNotTrue(voidRes.body.pending);
        chai.assert.deepEqualExcluding(voidRes.body, {
            id: voidTx.id,
            transactionType: "void",
            currency: "CAD",
            totals: {
                subtotal: -14286,
                tax: -714,
                discount: 0,
                discountLightrail: 0,
                payable: -15000,
                paidInternal: 0,
                paidLightrail: -1000,
                paidStripe: -14000,
                remainder: 0,
                forgiven: 0
            },
            lineItems: null,
            steps: [],
            paymentSources: null,
            pending: false,
            metadata: null,
            tax: {
                roundingMode: "HALF_EVEN"
            },
            createdDate: null,
            createdBy: defaultTestUser.auth.teamMemberId
        }, ["createdDate", "steps"]);
        chai.assert.equal((voidRes.body.steps[0] as LightrailTransactionStep).balanceBefore, 0);
        chai.assert.equal((voidRes.body.steps[0] as LightrailTransactionStep).balanceAfter, 1000);
        chai.assert.equal((voidRes.body.steps[0] as LightrailTransactionStep).balanceChange, 1000);
        chai.assert.equal((voidRes.body.steps[1] as StripeTransactionStep).amount, 14000);
        chai.assert.isString((voidRes.body.steps[1] as StripeTransactionStep).chargeId);
        chai.assert.isObject((voidRes.body.steps[1] as StripeTransactionStep).charge);  // Is actually the refund object.

        const getVoidRes = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${voidRes.body.id}`, "GET");
        chai.assert.equal(getVoidRes.statusCode, 200, `body=${JSON.stringify(getVoidRes.body)}`);
        chai.assert.deepEqual(getVoidRes.body, voidRes.body);

        const valueVoidRes = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}`, "GET");
        chai.assert.equal(valueVoidRes.body.balance, 1000);
    });

    it("can create and capture a pending transaction, Lightrail and Stripe", async () => {
        const value: Partial<Value> = {
            id: generateId(),
            currency: "CAD",
            balance: 1000,
        };
        const valueRes = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
        chai.assert.equal(valueRes.statusCode, 201, `body=${JSON.stringify(valueRes.body)}`);

        const pendingTx: CheckoutRequest = {
            id: generateId(),
            sources: [
                {
                    rail: "lightrail",
                    valueId: value.id
                },
                {
                    rail: "stripe",
                    source: "tok_visa"
                }
            ],
            lineItems: [
                {
                    type: "product",
                    productId: "🚗",
                    unitPrice: 14286,
                    taxRate: 0.05
                }
            ],
            currency: "CAD",
            pending: true
        };
        const pendingTxRes = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", pendingTx);
        chai.assert.equal(pendingTxRes.statusCode, 201, `body=${JSON.stringify(pendingTxRes.body)}`);
        chai.assert.deepEqualExcluding(pendingTxRes.body, {
            id: pendingTx.id,
            transactionType: "checkout",
            currency: "CAD",
            totals: {
                subtotal: 14286,
                tax: 714,
                discount: 0,
                discountLightrail: 0,
                payable: 15000,
                paidInternal: 0,
                paidLightrail: 1000,
                paidStripe: 14000,
                remainder: 0,
                forgiven: 0
            },
            lineItems: [
                {
                    type: "product",
                    productId: "🚗",
                    unitPrice: 14286,
                    taxRate: 0.05,
                    quantity: 1,
                    lineTotal: {
                        subtotal: 14286,
                        taxable: 14286,
                        tax: 714,
                        discount: 0,
                        payable: 15000,
                        remainder: 0
                    }
                }
            ],
            steps: [
                // only asserted when not live
            ],
            paymentSources: [
                {
                    rail: "lightrail",
                    valueId: value.id
                },
                {
                    rail: "stripe",
                    source: "tok_visa"
                }
            ],
            pending: true,
            pendingVoidDate: null,
            metadata: null,
            tax: {
                roundingMode: "HALF_EVEN"
            },
            createdDate: null,
            createdBy: defaultTestUser.auth.teamMemberId
        }, ["createdDate", "pendingVoidDate", "steps"]);
        chai.assert.isNotNull(pendingTxRes.body.pendingVoidDate);
        chai.assert.equal((pendingTxRes.body.steps[0] as LightrailTransactionStep).balanceBefore, 1000);
        chai.assert.equal((pendingTxRes.body.steps[0] as LightrailTransactionStep).balanceAfter, 0);
        chai.assert.equal((pendingTxRes.body.steps[0] as LightrailTransactionStep).balanceChange, -1000);
        chai.assert.equal((pendingTxRes.body.steps[1] as StripeTransactionStep).amount, -14000);
        chai.assert.isString((pendingTxRes.body.steps[1] as StripeTransactionStep).chargeId);
        chai.assert.isObject((pendingTxRes.body.steps[1] as StripeTransactionStep).charge);
        chai.assert.isFalse(((pendingTxRes.body.steps[1] as StripeTransactionStep).charge as Stripe.charges.ICharge).captured);

        const getPendingTxRes = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${pendingTx.id}`, "GET");
        chai.assert.equal(getPendingTxRes.statusCode, 200, `body=${JSON.stringify(getPendingTxRes.body)}`);
        chai.assert.deepEqual(getPendingTxRes.body, pendingTxRes.body);

        const valuePendingRes = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}`, "GET");
        chai.assert.equal(valuePendingRes.body.balance, 0);

        const captureTx: CaptureRequest = {
            id: generateId()
        };
        const captureRes = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${pendingTx.id}/capture`, "POST", captureTx);
        chai.assert.equal(captureRes.statusCode, 201, `body=${JSON.stringify(captureRes.body)}`);

        chai.assert.deepEqualExcluding(captureRes.body, {
            id: captureTx.id,
            transactionType: "capture",
            currency: "CAD",
            totals: null,
            lineItems: null,
            steps: [],
            paymentSources: null,
            pending: false,
            metadata: null,
            tax: {
                roundingMode: "HALF_EVEN"
            },
            createdDate: null,
            createdBy: defaultTestUser.auth.teamMemberId
        }, ["createdDate", "steps"]);
        chai.assert.equal((captureRes.body.steps[0] as StripeTransactionStep).rail, "stripe");
        chai.assert.equal((captureRes.body.steps[0] as StripeTransactionStep).amount, 0);
        chai.assert.isString((captureRes.body.steps[0] as StripeTransactionStep).chargeId);
        chai.assert.isObject((captureRes.body.steps[0] as StripeTransactionStep).charge);

        const getCaptureRes = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${captureRes.body.id}`, "GET");
        chai.assert.equal(getCaptureRes.statusCode, 200, `body=${JSON.stringify(getCaptureRes.body)}`);
        chai.assert.deepEqual(getCaptureRes.body, captureRes.body);

        const valueCaptureRes = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}`, "GET");
        chai.assert.equal(valueCaptureRes.body.balance, 0);
    });

    it("can create and void a pending transaction, Remainder only", async () => {
        const pendingTx: CheckoutRequest = {
            id: generateId(),
            sources: [
                {
                    rail: "lightrail",
                    code: "this-does-not-exist"
                }
            ],
            lineItems: [
                {
                    type: "product",
                    productId: "🚗",
                    unitPrice: 14286,
                    taxRate: 0.05
                }
            ],
            currency: "CAD",
            allowRemainder: true,
            pending: true
        };
        const pendingTxRes = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", pendingTx);
        chai.assert.equal(pendingTxRes.statusCode, 201, `body=${JSON.stringify(pendingTxRes.body)}`);
        chai.assert.deepEqualExcluding(pendingTxRes.body, {
            id: pendingTx.id,
            transactionType: "checkout",
            currency: "CAD",
            totals: {
                subtotal: 14286,
                tax: 714,
                discount: 0,
                discountLightrail: 0,
                payable: 15000,
                paidInternal: 0,
                paidLightrail: 0,
                paidStripe: 0,
                remainder: 15000,
                forgiven: 0
            },
            lineItems: [
                {
                    type: "product",
                    productId: "🚗",
                    unitPrice: 14286,
                    taxRate: 0.05,
                    quantity: 1,
                    lineTotal: {
                        subtotal: 14286,
                        taxable: 14286,
                        tax: 714,
                        discount: 0,
                        payable: 15000,
                        remainder: 15000
                    }
                }
            ],
            steps: [],
            paymentSources: [
                {
                    rail: "lightrail",
                    code: "…xist"
                }
            ],
            pending: true,
            pendingVoidDate: null,
            metadata: null,
            tax: {
                roundingMode: "HALF_EVEN"
            },
            createdDate: null,
            createdBy: defaultTestUser.auth.teamMemberId
        }, ["createdDate", "pendingVoidDate"]);
        chai.assert.isNotNull(pendingTxRes.body.pendingVoidDate);

        const voidTx: VoidRequest = {
            id: generateId()
        };
        const voidRes = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${pendingTx.id}/void`, "POST", voidTx);
        chai.assert.equal(voidRes.statusCode, 201, `body=${JSON.stringify(voidRes.body)}`);
        chai.assert.isNotTrue(voidRes.body.pending);
        chai.assert.deepEqualExcluding(voidRes.body, {
            id: voidTx.id,
            transactionType: "void",
            currency: "CAD",
            totals: {
                subtotal: -14286,
                tax: -714,
                discount: 0,
                discountLightrail: 0,
                payable: -15000,
                paidInternal: 0,
                paidLightrail: 0,
                paidStripe: 0,
                remainder: -15000,
                forgiven: 0
            },
            lineItems: null,
            steps: [],
            paymentSources: null,
            pending: false,
            metadata: null,
            tax: {
                roundingMode: "HALF_EVEN"
            },
            createdDate: null,
            createdBy: defaultTestUser.auth.teamMemberId
        }, ["createdDate"]);
    });

    it("can create and capture a pending transaction, Remainder only", async () => {
        const pendingTx: CheckoutRequest = {
            id: generateId(),
            sources: [
                {
                    rail: "lightrail",
                    code: "this-does-not-exist"
                }
            ],
            lineItems: [
                {
                    type: "product",
                    productId: "🚗",
                    unitPrice: 14286,
                    taxRate: 0.05
                }
            ],
            currency: "CAD",
            allowRemainder: true,
            pending: true
        };
        const pendingTxRes = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", pendingTx);
        chai.assert.equal(pendingTxRes.statusCode, 201, `body=${JSON.stringify(pendingTxRes.body)}`);
        chai.assert.deepEqualExcluding(pendingTxRes.body, {
            id: pendingTx.id,
            transactionType: "checkout",
            currency: "CAD",
            totals: {
                subtotal: 14286,
                tax: 714,
                discount: 0,
                discountLightrail: 0,
                payable: 15000,
                paidInternal: 0,
                paidLightrail: 0,
                paidStripe: 0,
                remainder: 15000,
                forgiven: 0
            },
            lineItems: [
                {
                    type: "product",
                    productId: "🚗",
                    unitPrice: 14286,
                    taxRate: 0.05,
                    quantity: 1,
                    lineTotal: {
                        subtotal: 14286,
                        taxable: 14286,
                        tax: 714,
                        discount: 0,
                        payable: 15000,
                        remainder: 15000
                    }
                }
            ],
            steps: [],
            paymentSources: [
                {
                    rail: "lightrail",
                    code: "…xist"
                }
            ],
            pending: true,
            pendingVoidDate: null,
            metadata: null,
            tax: {
                roundingMode: "HALF_EVEN"
            },
            createdDate: null,
            createdBy: defaultTestUser.auth.teamMemberId
        }, ["createdDate", "pendingVoidDate"]);
        chai.assert.isNotNull(pendingTxRes.body.pendingVoidDate);

        const captureTx: CaptureRequest = {
            id: generateId()
        };
        const captureRes = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${pendingTx.id}/capture`, "POST", captureTx);
        chai.assert.equal(captureRes.statusCode, 201, `body=${JSON.stringify(captureRes.body)}`);

        chai.assert.deepEqualExcluding(captureRes.body, {
            id: captureTx.id,
            transactionType: "capture",
            currency: "CAD",
            totals: null,
            lineItems: null,
            steps: [],
            paymentSources: null,
            pending: false,
            metadata: null,
            tax: {
                roundingMode: "HALF_EVEN"
            },
            createdDate: null,
            createdBy: defaultTestUser.auth.teamMemberId
        }, ["createdDate"]);
    });

    it("voids Lightrail+Stripe successfully when the Stripe charge was refunded already", async () => {
        const value: Partial<Value> = {
            id: generateId(),
            currency: "CAD",
            balance: 1000,
        };
        const valueRes = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
        chai.assert.equal(valueRes.statusCode, 201, `body=${JSON.stringify(valueRes.body)}`);

        const pendingTx: CheckoutRequest = {
            id: generateId(),
            sources: [
                {
                    rail: "lightrail",
                    valueId: value.id
                },
                {
                    rail: "stripe",
                    source: "tok_visa"
                }
            ],
            lineItems: [
                {
                    type: "product",
                    productId: "🚗",
                    unitPrice: 14286,
                    taxRate: 0.05
                }
            ],
            currency: "CAD",
            pending: true
        };
        const pendingTxRes = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", pendingTx);
        chai.assert.equal(pendingTxRes.statusCode, 201, `body=${JSON.stringify(pendingTxRes.body)}`);
        chai.assert.isTrue(pendingTxRes.body.pending);

        const valuePendingRes = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}`, "GET");
        chai.assert.equal(valuePendingRes.body.balance, 0);

        // Refund the charge manually
        const refund = await createRefund({charge: (pendingTxRes.body.steps[1] as StripeTransactionStep).chargeId}, true, defaultTestUser.stripeAccountId);

        const voidRes = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${pendingTx.id}/void`, "POST", {
            id: generateId()
        });
        chai.assert.equal(voidRes.statusCode, 201, `body=${JSON.stringify(voidRes.body)}`);
        chai.assert.isNotTrue(voidRes.body.pending);
        chai.assert.deepEqual(voidRes.body.steps, [
            {
                rail: "lightrail",
                balanceRule: null,
                balanceAfter: 1000,
                balanceBefore: 0,
                balanceChange: 1000,
                code: null,
                contactId: null,
                usesRemainingAfter: null,
                usesRemainingBefore: null,
                usesRemainingChange: null,
                valueId: value.id
            },
            {
                rail: "stripe",
                chargeId: refund.charge,
                amount: refund.amount,
                charge: refund
            } as StripeTransactionStep
        ]);

        const valueVoidRes = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}`, "GET");
        chai.assert.equal(valueVoidRes.body.balance, 1000);
    });

    it("captures Lightrail+Stripe when the Stripe charge was captured already", async () => {
        const value: Partial<Value> = {
            id: generateId(),
            currency: "CAD",
            balance: 1000,
        };
        const valueRes = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
        chai.assert.equal(valueRes.statusCode, 201, `body=${JSON.stringify(valueRes.body)}`);

        const pendingTx: CheckoutRequest = {
            id: generateId(),
            sources: [
                {
                    rail: "lightrail",
                    valueId: value.id
                },
                {
                    rail: "stripe",
                    source: "tok_visa"
                }
            ],
            lineItems: [
                {
                    type: "product",
                    productId: "🚗",
                    unitPrice: 14286,
                    taxRate: 0.05
                }
            ],
            currency: "CAD",
            pending: true
        };
        const pendingTxRes = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", pendingTx);
        chai.assert.equal(pendingTxRes.statusCode, 201, `body=${JSON.stringify(pendingTxRes.body)}`);
        chai.assert.isTrue(pendingTxRes.body.pending);

        const valuePendingRes = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}`, "GET");
        chai.assert.equal(valuePendingRes.body.balance, 0);

        // Capture the charge manually.
        const capture = await captureCharge((pendingTxRes.body.steps[1] as StripeTransactionStep).chargeId, {}, true, defaultTestUser.stripeAccountId);

        const captureRes = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${pendingTx.id}/capture`, "POST", {
            id: generateId()
        });
        chai.assert.equal(captureRes.statusCode, 201, `body=${JSON.stringify(captureRes.body)}`);
        chai.assert.isNotTrue(captureRes.body.pending);
        chai.assert.deepEqual(captureRes.body.steps, [
            {
                rail: "stripe",
                chargeId: capture.id,
                amount: 0,
                charge: capture
            } as StripeTransactionStep
        ]);

        const valueCaptureRes = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}`, "GET");
        chai.assert.equal(valueCaptureRes.body.balance, 0);
    });

    describe("stripe issues", () => {
        it("can't void on disconnected Stripe account", async function () {
            if (testStripeLive()) {
                // This test relies upon being able to create and delete accounts, which is
                // only supported in the local mock server.
                this.skip();
            }

            const testUser = new TestUser();

            const stripe = await getStripeClient(true);
            const stripeAccount = await stripe.accounts.create({type: "standard"} as any);
            chai.assert.isString(stripeAccount.id, "created Stripe account");
            testUser.stripeAccountId = stripeAccount.id;
            setStubbedStripeUserId(testUser);

            await createCurrency(testUser.auth, {
                code: "CAD",
                name: "Canadian bucks",
                symbol: "$",
                decimalPlaces: 2,
                createdDate: nowInDbPrecision(),
                updatedDate: nowInDbPrecision(),
                createdBy: testUtils.defaultTestUser.teamMemberId
            });

            const stripeCheckoutTx: CheckoutRequest = {
                id: generateId(),
                currency: "cad",
                lineItems: [
                    {
                        type: "product",
                        productId: "human-souls",
                        unitPrice: 1499
                    }
                ],
                sources: [
                    {
                        rail: "stripe",
                        source: "tok_visa"
                    }
                ],
                pending: true
            };
            const stripePendingCheckoutTxRes = await testUser.request<Transaction>(router, "/v2/transactions/checkout", "POST", stripeCheckoutTx);
            chai.assert.equal(stripePendingCheckoutTxRes.statusCode, 201);

            await stripe.accounts.del(stripeAccount.id);

            const failedVoidRes = await testUser.request<any>(router, `/v2/transactions/${stripeCheckoutTx.id}/void`, "POST", {
                id: generateId()
            });
            chai.assert.equal(failedVoidRes.statusCode, 424, `body=${JSON.stringify(failedVoidRes.body)}`);
            chai.assert.equal(failedVoidRes.body.messageCode, "StripePermissionError");
        });

        it("can't capture on disconnected Stripe account", async function () {
            if (testStripeLive()) {
                // This test relies upon being able to create and delete accounts, which is
                // only supported in the local mock server.
                this.skip();
            }

            const testUser = new TestUser();

            const stripe = await getStripeClient(true);
            const stripeAccount = await stripe.accounts.create({type: "standard"} as any);
            chai.assert.isString(stripeAccount.id, "created Stripe account");
            testUser.stripeAccountId = stripeAccount.id;
            setStubbedStripeUserId(testUser);

            await createCurrency(testUser.auth, {
                code: "CAD",
                name: "Canadian bucks",
                symbol: "$",
                decimalPlaces: 2,
                createdDate: nowInDbPrecision(),
                updatedDate: nowInDbPrecision(),
                createdBy: testUtils.defaultTestUser.teamMemberId
            });

            const stripeCheckoutTx: CheckoutRequest = {
                id: generateId(),
                currency: "cad",
                lineItems: [
                    {
                        type: "product",
                        productId: "human-souls",
                        unitPrice: 1499
                    }
                ],
                sources: [
                    {
                        rail: "stripe",
                        source: "tok_visa"
                    }
                ],
                pending: true
            };
            const stripePendingCheckoutTxRes = await testUser.request<Transaction>(router, "/v2/transactions/checkout", "POST", stripeCheckoutTx);
            chai.assert.equal(stripePendingCheckoutTxRes.statusCode, 201);

            await stripe.accounts.del(stripeAccount.id);

            const failedCaptureRes = await testUser.request<any>(router, `/v2/transactions/${stripeCheckoutTx.id}/capture`, "POST", {
                id: generateId()
            });
            chai.assert.equal(failedCaptureRes.statusCode, 424, `body=${JSON.stringify(failedCaptureRes.body)}`);
            chai.assert.equal(failedCaptureRes.body.messageCode, "StripePermissionError");
        });

        it("can't void when Stripe charges are missing", async function () {
            if (testStripeLive()) {
                // This test relies upon a test token only supported in the local mock server.
                this.skip();
            }

            const stripeCheckoutTx: CheckoutRequest = {
                id: generateId(),
                currency: "cad",
                lineItems: [
                    {
                        type: "product",
                        productId: "human-souls",
                        unitPrice: 1499
                    }
                ],
                sources: [
                    {
                        rail: "stripe",
                        source: "tok_forget"    // Mock server will forget about this charge simulating deleted data.
                    }
                ],
                pending: true
            };
            const stripePendingCheckoutTxRes = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", stripeCheckoutTx);
            chai.assert.equal(stripePendingCheckoutTxRes.statusCode, 201);

            const failVoidRes = await testUtils.testAuthedRequest<any>(router, `/v2/transactions/${stripeCheckoutTx.id}/void`, "POST", {
                id: generateId()
            });
            chai.assert.equal(failVoidRes.statusCode, 409, `body=${JSON.stringify(failVoidRes.body)}`);
            chai.assert.equal(failVoidRes.body.messageCode, "StripeChargeNotFound");
        });

        it("can't capture when Stripe charges are missing", async function () {
            if (testStripeLive()) {
                // This test relies upon a test token only supported in the local mock server.
                this.skip();
            }

            const stripeCheckoutTx: CheckoutRequest = {
                id: generateId(),
                currency: "cad",
                lineItems: [
                    {
                        type: "product",
                        productId: "human-souls",
                        unitPrice: 1499
                    }
                ],
                sources: [
                    {
                        rail: "stripe",
                        source: "tok_forget"    // Mock server will forget about this charge simulating deleted data.
                    }
                ],
                pending: true
            };
            const stripePendingCheckoutTxRes = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", stripeCheckoutTx);
            chai.assert.equal(stripePendingCheckoutTxRes.statusCode, 201);

            const failedCaptureRes = await testUtils.testAuthedRequest<any>(router, `/v2/transactions/${stripeCheckoutTx.id}/capture`, "POST", {
                id: generateId()
            });
            chai.assert.equal(failedCaptureRes.statusCode, 409, `body=${JSON.stringify(failedCaptureRes.body)}`);
            chai.assert.equal(failedCaptureRes.body.messageCode, "StripeChargeNotFound");
        });
    });
});
