import * as cassava from "cassava";
import * as chai from "chai";
import * as testUtils from "../../../../utils/testUtils";
import {defaultTestUser, generateId} from "../../../../utils/testUtils";
import {Value} from "../../../../model/Value";
import {Transaction} from "../../../../model/Transaction";
import {createCurrency} from "../../currencies";
import {installRestRoutes} from "../../installRestRoutes";
import chaiExclude from "chai-exclude";
import {nowInDbPrecision} from "../../../../utils/dbUtils";
import {CheckoutRequest} from "../../../../model/TransactionRequest";

chai.use(chaiExclude);

describe("/v2/transactions/checkout - allowRemainder tests", () => {

    const router = new cassava.Router();

    before(async function () {
        await testUtils.resetDb();
        router.route(testUtils.authRoute);
        installRestRoutes(router);
        await createCurrency(testUtils.defaultTestUser.auth, {
            code: "CAD",
            name: "Canadian Tire Money",
            symbol: "$",
            decimalPlaces: 2,
            createdDate: nowInDbPrecision(),
            updatedDate: nowInDbPrecision(),
            createdBy: testUtils.defaultTestUser.teamMemberId
        });
    });

    it("process checkout with InsufficientBalance followed by allowRemainder = true", async () => {
        const giftCard: Partial<Value> = {
            id: "vs-checkout4-giftcard",
            currency: "CAD",
            balance: 500
        };
        const preTaxPromotion: Partial<Value> = {
            id: "vs-checkout4-promotion1",
            currency: "CAD",
            balance: 200,
            pretax: true,
            discount: true
        };

        const createGiftCardResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", giftCard);
        chai.assert.equal(createGiftCardResp.statusCode, 201, `body=${JSON.stringify(createGiftCardResp.body)}`);

        const createPromotion1Resp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", preTaxPromotion);
        chai.assert.equal(createPromotion1Resp.statusCode, 201, `body=${JSON.stringify(createPromotion1Resp.body)}`);

        const request: CheckoutRequest = {
            id: "checkout-4",
            sources: [
                {
                    rail: "lightrail",
                    valueId: giftCard.id
                },
                {
                    rail: "lightrail",
                    valueId: preTaxPromotion.id
                }
            ],
            lineItems: [
                {
                    type: "shipping",
                    productId: "p1",
                    unitPrice: 500,
                    taxRate: 0.05
                },
                {
                    type: "product",
                    productId: "p2",
                    unitPrice: 333,
                    quantity: 2,
                    taxRate: 0.08
                }
            ],
            currency: "CAD"
        };
        const postCheckoutRespInsufficientBalance = await testUtils.testAuthedRequest<any>(router, "/v2/transactions/checkout", "POST", request);
        chai.assert.equal(postCheckoutRespInsufficientBalance.statusCode, 409, `body=${JSON.stringify(postCheckoutRespInsufficientBalance.body)}`);
        chai.assert.equal(postCheckoutRespInsufficientBalance.body.messageCode, "InsufficientBalance", `body=${JSON.stringify(postCheckoutRespInsufficientBalance.body)}`);

        request.allowRemainder = true;
        const postCheckoutResp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", request);
        chai.assert.equal(postCheckoutResp.statusCode, 201, `body=${JSON.stringify(postCheckoutResp.body)}`);
        chai.assert.deepEqualExcluding(postCheckoutResp.body, {
            "id": "checkout-4",
            "transactionType": "checkout",
            "currency": "CAD",
            "totals": {
                "subtotal": 1166,
                "tax": 62,
                "discount": 200,
                "discountLightrail": 200,
                "payable": 1028,
                "paidInternal": 0,
                "paidLightrail": 500,
                "paidStripe": 0,
                "remainder": 528,
                "forgiven": 0
            },
            "lineItems": [
                {
                    "type": "product",
                    "productId": "p2",
                    "unitPrice": 333,
                    "quantity": 2,
                    "taxRate": 0.08,
                    "lineTotal": {
                        "subtotal": 666,
                        "taxable": 466,
                        "tax": 37,
                        "discount": 200,
                        "remainder": 3,
                        "payable": 503
                    }
                },
                {
                    "type": "shipping",
                    "productId": "p1",
                    "unitPrice": 500,
                    "taxRate": 0.05,
                    "quantity": 1,
                    "lineTotal": {
                        "subtotal": 500,
                        "taxable": 500,
                        "tax": 25,
                        "discount": 0,
                        "remainder": 525,
                        "payable": 525
                    }
                }
            ],
            "steps": [
                {
                    "rail": "lightrail",
                    "valueId": "vs-checkout4-promotion1",
                    "contactId": null,
                    "code": null,
                    "balanceRule": null,
                    "balanceBefore": 200,
                    "balanceAfter": 0,
                    "balanceChange": -200,
                    "usesRemainingBefore": null,
                    "usesRemainingAfter": null,
                    "usesRemainingChange": null
                },
                {
                    "rail": "lightrail",
                    "valueId": "vs-checkout4-giftcard",
                    "contactId": null,
                    "code": null,
                    "balanceRule": null,
                    "balanceBefore": 500,
                    "balanceAfter": 0,
                    "balanceChange": -500,
                    "usesRemainingBefore": null,
                    "usesRemainingAfter": null,
                    "usesRemainingChange": null
                }
            ],
            "paymentSources": [
                {
                    "rail": "lightrail",
                    "valueId": "vs-checkout4-giftcard"
                },
                {
                    "rail": "lightrail",
                    "valueId": "vs-checkout4-promotion1"
                }
            ],
            pending: false,
            "metadata": null,
            tax: {
                "roundingMode": "HALF_EVEN"
            },
            "createdDate": null,
            "createdBy": defaultTestUser.auth.teamMemberId
        }, ["createdDate", "createdBy"]);

        const getPreTaxPromo = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${preTaxPromotion.id}`, "GET");
        chai.assert.equal(getPreTaxPromo.statusCode, 200, `body=${JSON.stringify(getPreTaxPromo.body)}`);
        chai.assert.equal(getPreTaxPromo.body.balance, 0);

        const getGiftCardVS = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${giftCard.id}`, "GET");
        chai.assert.equal(getGiftCardVS.statusCode, 200, `body=${JSON.stringify(getGiftCardVS.body)}`);
        chai.assert.equal(getGiftCardVS.body.balance, 0);

        const getCheckoutResp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout-4", "GET");
        chai.assert.equal(getCheckoutResp.statusCode, 200, `body=${JSON.stringify(getCheckoutResp.body)}`);
        chai.assert.deepEqual(getCheckoutResp.body, postCheckoutResp.body);
    });

    it("can checkout with a percent off discount with a capped maximum value", async () => {
        const maxDiscount = 200;
        const value: Partial<Value> = {
            id: generateId(),
            currency: "CAD",
            usesRemaining: 1,
            balanceRule: {
                rule: `min(currentLineItem.lineTotal.subtotal * 0.10, ${maxDiscount} + value.balanceChange)`,
                explanation: "10% off a ride"
            },
            pretax: true,
            discount: true,
        };
        const createValue = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
        chai.assert.equal(createValue.statusCode, 201);
        chai.assert.deepEqual(createValue.body.balanceRule, value.balanceRule);

        const checkout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", {
            id: generateId(),
            currency: "CAD",
            sources: [{
                rail: "lightrail",
                valueId: value.id
            }],
            lineItems: [
                {unitPrice: 1000},
                {unitPrice: 12000}
            ],
            allowRemainder: true
        });
        chai.assert.equal(checkout.statusCode, 201);
        chai.assert.equal(checkout.body.totals.discountLightrail, maxDiscount);
    });
});
