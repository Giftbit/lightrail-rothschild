import * as cassava from "cassava";
import * as chai from "chai";
import * as testUtils from "../../../../../utils/testUtils/index";
import {generateId, setCodeCryptographySecrets} from "../../../../../utils/testUtils";
import {installRestRoutes} from "../../../installRestRoutes";
import {createCurrency} from "../../../currencies";
import {Value} from "../../../../../model/Value";
import {Transaction} from "../../../../../model/Transaction";
import {CheckoutRequest, ReverseRequest} from "../../../../../model/TransactionRequest";
import {setStubsForStripeTests, unsetStubsForStripeTests} from "../../../../../utils/testUtils/stripeTestUtils";
import {createRefund} from "../../../../../utils/stripeUtils/stripeTransactions";
import chaiExclude from "chai-exclude";
import {nowInDbPrecision} from "../../../../../utils/dbUtils";
import {
    InternalTransactionStep,
    LightrailTransactionStep,
    StripeTransactionStep
} from "../../../../../model/TransactionStep";

chai.use(chaiExclude);

describe("/v2/transactions/reverse - checkout", () => {

    const router = new cassava.Router();

    before(async function () {
        await testUtils.resetDb();
        router.route(testUtils.authRoute);
        installRestRoutes(router);
        setCodeCryptographySecrets();

        const currency = await createCurrency(testUtils.defaultTestUser.auth, {
            code: "USD",
            name: "US Dollars",
            symbol: "$",
            decimalPlaces: 2,
            createdDate: nowInDbPrecision(),
            updatedDate: nowInDbPrecision(),
            createdBy: testUtils.defaultTestUser.teamMemberId
        });
        chai.assert.equal(currency.code, "USD");
        await setStubsForStripeTests();
    });

    after(() => {
        unsetStubsForStripeTests();
    });

    it("can reverse a checkout with lightrail and 2 stripe payment sources", async () => {
        // create value
        const value: Partial<Value> = {
            id: generateId(),
            currency: "USD",
            balance: 100
        };
        const postValue = await testUtils.testAuthedRequest<Value>(router, `/v2/values`, "POST", value);
        chai.assert.equal(postValue.statusCode, 201);

        // create checkout
        const checkout: CheckoutRequest = {
            id: generateId(),
            lineItems: [{
                unitPrice: 250
            }],
            currency: "USD",
            sources: [
                {
                    rail: "internal",
                    beforeLightrail: true,
                    balance: 1,
                    internalId: "id"
                },
                {
                    rail: "lightrail",
                    valueId: value.id
                },
                {
                    rail: "stripe",
                    source: "tok_visa",
                    maxAmount: 50
                },
                {
                    rail: "stripe",
                    source: "tok_visa",
                    maxAmount: 200
                }
            ]
        };
        const simulate = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", {
            ...checkout,
            simulate: true
        });
        const postCheckout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkout);
        chai.assert.equal(postCheckout.statusCode, 201, `body=${JSON.stringify(postCheckout.body)}`);
        chai.assert.equal((postCheckout.body.steps[0] as InternalTransactionStep).balanceChange, -1, `body=${JSON.stringify(postCheckout.body)}`);
        chai.assert.equal((postCheckout.body.steps[1] as LightrailTransactionStep).balanceChange, -100, `body=${JSON.stringify(postCheckout.body)}`);
        chai.assert.equal((postCheckout.body.steps[2] as StripeTransactionStep).amount, -50, `body=${JSON.stringify(postCheckout.body)}`);
        chai.assert.equal((postCheckout.body.steps[3] as StripeTransactionStep).amount, -99, `body=${JSON.stringify(postCheckout.body)}`);
        chai.assert.deepEqualExcluding(simulate.body, postCheckout.body, ["steps", "simulated", "createdDate"]);

        // lookup chain
        const getChain1 = await testUtils.testAuthedRequest<Transaction[]>(router, `/v2/transactions/${checkout.id}/chain`, "GET");
        chai.assert.equal(getChain1.body.length, 1);

        // create reverse
        const reverse: Partial<ReverseRequest> = {
            id: generateId()
        };
        const postReverse = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${checkout.id}/reverse`, "POST", reverse);
        chai.assert.equal(postReverse.statusCode, 201);
        verifyCheckoutReverseTotals(postCheckout.body, postReverse.body);
        chai.assert.isDefined(postReverse.body.steps.find(step => step.rail === "internal" && step.balanceChange === 1));
        chai.assert.isDefined(postReverse.body.steps.find(step => step.rail === "lightrail" && step.balanceChange === 100));
        chai.assert.isDefined(postReverse.body.steps.find(step => step.rail === "stripe" && step.amount === 50));
        chai.assert.isDefined(postReverse.body.steps.find(step => step.rail === "stripe" && step.amount === 99));

        // check value is same as before
        const getValue = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}`, "GET");
        chai.assert.deepEqualExcluding(postValue.body, getValue.body, "updatedDate");

        // lookup chain2
        const getChain2 = await testUtils.testAuthedRequest<Transaction[]>(router, `/v2/transactions/${checkout.id}/chain`, "GET");
        chai.assert.equal(getChain2.body.length, 2);
        chai.assert.deepEqualExcluding(getChain2.body.find(tx => tx.transactionType === "reverse"), postReverse.body, ["steps"]);
        chai.assert.sameDeepMembers(getChain2.body.find(tx => tx.transactionType === "reverse").steps, postReverse.body.steps);
        chai.assert.deepEqualExcluding(getChain2.body.find(tx => tx.transactionType === "checkout"), postCheckout.body, ["steps"]);
        chai.assert.sameDeepMembers(getChain2.body.find(tx => tx.transactionType === "checkout").steps, postCheckout.body.steps);
    }).timeout(12000);

    it("can reverse a checkout with balanceRule, balance and credit card", async () => {
        // create gift card
        const giftCard: Partial<Value> = {
            id: generateId(),
            currency: "USD",
            balance: 140
        };
        const postGiftCard = await testUtils.testAuthedRequest<Value>(router, `/v2/values`, "POST", giftCard);
        chai.assert.equal(postGiftCard.statusCode, 201);

        // create gift card
        const promotion: Partial<Value> = {
            id: generateId(),
            currency: "USD",
            balanceRule: {
                rule: "currentLineItem.lineTotal.subtotal * 0.05",
                explanation: "5% off all items"
            },
            discount: true
        };
        const postPromotion = await testUtils.testAuthedRequest<Value>(router, `/v2/values`, "POST", promotion);
        chai.assert.equal(postPromotion.statusCode, 201);

        // create checkout
        const checkout: CheckoutRequest = {
            id: generateId(),
            lineItems: [{
                unitPrice: 200
            }],
            currency: "USD",
            sources: [
                {
                    rail: "lightrail",
                    valueId: promotion.id
                },
                {
                    rail: "lightrail",
                    valueId: giftCard.id
                },
                {
                    rail: "stripe",
                    source: "tok_visa",
                    maxAmount: 50
                }
            ]
        };
        const postCheckout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkout);
        chai.assert.equal(postCheckout.statusCode, 201, `body=${JSON.stringify(postCheckout.body)}`);
        chai.assert.equal((postCheckout.body.steps[0] as LightrailTransactionStep).balanceChange, -10, `body=${JSON.stringify(postCheckout.body)}`);
        chai.assert.equal((postCheckout.body.steps[1] as LightrailTransactionStep).balanceChange, -140, `body=${JSON.stringify(postCheckout.body)}`);
        chai.assert.equal((postCheckout.body.steps[2] as StripeTransactionStep).amount, -50, `body=${JSON.stringify(postCheckout.body)}`);

        // lookup chain
        const getChain1 = await testUtils.testAuthedRequest<Transaction[]>(router, `/v2/transactions/${checkout.id}/chain`, "GET");
        chai.assert.equal(getChain1.body.length, 1);

        // create reverse
        const reverse: Partial<ReverseRequest> = {
            id: generateId()
        };
        const postReverse = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${checkout.id}/reverse`, "POST", reverse);
        chai.assert.equal(postReverse.statusCode, 201, `body=${JSON.stringify(postCheckout.body)}`);
        verifyCheckoutReverseTotals(postCheckout.body, postReverse.body);
        chai.assert.isDefined(postReverse.body.steps.find(step => step.rail === "lightrail" && step.balanceChange === 10));
        chai.assert.isDefined(postReverse.body.steps.find(step => step.rail === "lightrail" && step.balanceChange === 140));
        chai.assert.isDefined(postReverse.body.steps.find(step => step.rail === "stripe" && step.amount === 50));

        // check value is same as before
        const getGiftCard = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${giftCard.id}`, "GET");
        chai.assert.deepEqualExcluding(postGiftCard.body, getGiftCard.body, "updatedDate");

        const getPromotion = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${promotion.id}`, "GET");
        chai.assert.deepEqualExcluding(postPromotion.body, getPromotion.body, "updatedDate");

        // lookup chain2
        const getChain2 = await testUtils.testAuthedRequest<Transaction[]>(router, `/v2/transactions/${checkout.id}/chain`, "GET");
        chai.assert.equal(getChain2.body.length, 2);
        chai.assert.deepEqual(getChain2.body.find(tx => tx.transactionType === "reverse"), postReverse.body);
        chai.assert.deepEqual(getChain2.body.find(tx => tx.transactionType === "checkout"), postCheckout.body);
    }).timeout(12000);

    it("can reverse checkout with marketplaceRate set", async () => {
        // create value
        const value: Partial<Value> = {
            id: generateId(),
            currency: "USD",
            balance: 110
        };
        const postValue = await testUtils.testAuthedRequest<Value>(router, `/v2/values`, "POST", value);
        chai.assert.equal(postValue.statusCode, 201);

        // create checkout
        const checkout: CheckoutRequest = {
            id: generateId(),
            lineItems: [{
                unitPrice: 100,
                marketplaceRate: 0.20,
                taxRate: 0.10
            }],
            currency: "USD",
            sources: [
                {
                    rail: "lightrail",
                    valueId: value.id
                }
            ]
        };
        const postCheckout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkout);
        chai.assert.equal(postCheckout.statusCode, 201, `body=${JSON.stringify(postCheckout.body)}`);
        chai.assert.equal((postCheckout.body.steps[0] as LightrailTransactionStep).balanceChange, -110, `body=${JSON.stringify(postCheckout.body)}`);
        chai.assert.deepEqual(postCheckout.body.totals.marketplace, {
            "sellerGross": 80,
            "sellerDiscount": 0,
            "sellerNet": 80
        });

        // create reverse
        const reverse: Partial<ReverseRequest> = {
            id: generateId()
        };
        const postReverse = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${checkout.id}/reverse`, "POST", reverse);
        chai.assert.equal(postReverse.statusCode, 201, `body=${JSON.stringify(postCheckout.body)}`);
        verifyCheckoutReverseTotals(postCheckout.body, postReverse.body);
        chai.assert.isDefined(postReverse.body.steps.find(step => step.rail === "lightrail" && step.balanceChange === 110));
        chai.assert.deepEqual(postReverse.body.totals.marketplace, {
            "sellerGross": -80,
            "sellerDiscount": 0,
            "sellerNet": -80
        });

        // check value is same as before
        const getValue = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}`, "GET");
        chai.assert.deepEqualExcluding(postValue.body, getValue.body, "updatedDate");
    });

    it("can reverse checkout when Stripe charge has been refunded", async () => {
        // create value
        const value: Partial<Value> = {
            id: generateId(),
            currency: "USD",
            balance: 110
        };
        const postValue = await testUtils.testAuthedRequest<Value>(router, `/v2/values`, "POST", value);
        chai.assert.equal(postValue.statusCode, 201);

        // create checkout
        const checkout: CheckoutRequest = {
            id: generateId(),
            lineItems: [{
                unitPrice: 2000,
            }],
            currency: "USD",
            sources: [
                {
                    rail: "lightrail",
                    valueId: value.id
                },
                {
                    rail: "stripe",
                    source: "tok_visa"
                }
            ]
        };
        const postCheckout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkout);
        chai.assert.equal(postCheckout.statusCode, 201, `body=${JSON.stringify(postCheckout.body)}`);
        chai.assert.equal((postCheckout.body.steps[0] as LightrailTransactionStep).balanceChange, -110, `body=${JSON.stringify(postCheckout.body)}`);
        chai.assert.isDefined(postCheckout.body.steps.find(step => step.rail === "stripe"));

        const stripeStep = postCheckout.body.steps.find(step => step.rail === "stripe") as StripeTransactionStep;
        chai.assert.isObject(stripeStep.charge);

        // Manually refund charge.
        await createRefund({charge: stripeStep.chargeId}, true, testUtils.defaultTestUser.stripeAccountId);

        // Lightrail reverse.
        const reverse: ReverseRequest = {
            id: generateId()
        };
        const postReverse = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${checkout.id}/reverse`, "POST", reverse);
        chai.assert.equal(postReverse.statusCode, 201, `body=${JSON.stringify(postCheckout.body)}`);
        verifyCheckoutReverseTotals(postCheckout.body, postReverse.body);
        chai.assert.isDefined(postReverse.body.steps.find(step => step.rail === "lightrail" && step.balanceChange === 110));
        chai.assert.isDefined(postReverse.body.steps.find(step => step.rail === "stripe"));

        // check value is same as before
        const getValue = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}`, "GET");
        chai.assert.deepEqualExcluding(postValue.body, getValue.body, "updatedDate");
    }).timeout(8000);

    it("can reverse checkout when Stripe charge has been partially refunded", async () => {
        // create value
        const value: Partial<Value> = {
            id: generateId(),
            currency: "USD",
            balance: 110
        };
        const postValue = await testUtils.testAuthedRequest<Value>(router, `/v2/values`, "POST", value);
        chai.assert.equal(postValue.statusCode, 201);

        // create checkout
        const checkout: CheckoutRequest = {
            id: generateId(),
            lineItems: [{
                unitPrice: 2000,
            }],
            currency: "USD",
            sources: [
                {
                    rail: "lightrail",
                    valueId: value.id
                },
                {
                    rail: "stripe",
                    source: "tok_visa"
                }
            ]
        };
        const postCheckout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkout);
        chai.assert.equal(postCheckout.statusCode, 201, `body=${JSON.stringify(postCheckout.body)}`);
        chai.assert.equal((postCheckout.body.steps[0] as LightrailTransactionStep).balanceChange, -110, `body=${JSON.stringify(postCheckout.body)}`);

        const stripeStep = postCheckout.body.steps.find(step => step.rail === "stripe") as StripeTransactionStep;
        chai.assert.isObject(stripeStep);
        chai.assert.isObject(stripeStep.charge);

        // Manual partial refund.
        await createRefund({charge: stripeStep.chargeId, amount: 200}, true, testUtils.defaultTestUser.stripeAccountId);

        // Lightrail reverse.
        const reverse: Partial<ReverseRequest> = {
            id: generateId()
        };
        const postReverse = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${checkout.id}/reverse`, "POST", reverse);
        chai.assert.equal(postReverse.statusCode, 201, `body=${JSON.stringify(postCheckout.body)}`);
        verifyCheckoutReverseTotals(postCheckout.body, postReverse.body);
        chai.assert.isDefined(postReverse.body.steps.find(step => step.rail === "lightrail" && step.balanceChange === 110));
        chai.assert.isDefined(postReverse.body.steps.find(step => step.rail === "stripe"));

        // check value is same as before
        const getValue = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}`, "GET");
        chai.assert.deepEqualExcluding(postValue.body, getValue.body, "updatedDate");
    }).timeout(8000);

    it("can not reverse checkout when Stripe charge has been disputed", async () => {
        // create value
        const value: Partial<Value> = {
            id: generateId(),
            currency: "USD",
            balance: 110
        };
        const postValue = await testUtils.testAuthedRequest<Value>(router, `/v2/values`, "POST", value);
        chai.assert.equal(postValue.statusCode, 201);

        // create checkout
        const checkout: CheckoutRequest = {
            id: generateId(),
            lineItems: [{
                unitPrice: 2000,
            }],
            currency: "USD",
            sources: [
                {
                    rail: "lightrail",
                    valueId: value.id
                },
                {
                    rail: "stripe",
                    source: "tok_createDispute"
                }
            ]
        };
        const postCheckout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkout);
        chai.assert.equal(postCheckout.statusCode, 201, `body=${JSON.stringify(postCheckout.body)}`);
        chai.assert.equal((postCheckout.body.steps[0] as LightrailTransactionStep).balanceChange, -110, `body=${JSON.stringify(postCheckout.body)}`);

        // create reverse
        const reverse: Partial<ReverseRequest> = {
            id: generateId()
        };
        const postReverse = await testUtils.testAuthedRequest<any>(router, `/v2/transactions/${checkout.id}/reverse`, "POST", reverse);
        chai.assert.equal(postReverse.statusCode, 409, `body=${JSON.stringify(postCheckout.body)}`);
        chai.assert.equal(postReverse.body.messageCode, "StripeChargeDisputed");
    }).timeout(8000);

    function verifyCheckoutReverseTotals(checkout: Transaction, reverse: Transaction): void {
        for (const key of Object.keys(checkout.totals)) {
            if (key !== "marketplace") {
                chai.assert.equal(reverse.totals[key], -checkout.totals[key]);
            } else {
                chai.assert.equal(reverse.totals.marketplace.sellerNet, -checkout.totals.marketplace.sellerNet);
                chai.assert.equal(reverse.totals.marketplace.sellerDiscount, -checkout.totals.marketplace.sellerDiscount);
                chai.assert.equal(reverse.totals.marketplace.sellerGross, -checkout.totals.marketplace.sellerGross);
            }
        }
    }
});
