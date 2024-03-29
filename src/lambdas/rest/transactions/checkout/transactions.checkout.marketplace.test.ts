import * as currencies from "../../currencies";
import * as testUtils from "../../../../utils/testUtils";
import {defaultTestUser, generateId} from "../../../../utils/testUtils";
import * as cassava from "cassava";
import {installRestRoutes} from "../../installRestRoutes";
import {Value} from "../../../../model/Value";
import * as chai from "chai";
import {Transaction} from "../../../../model/Transaction";
import {CheckoutRequest} from "../../../../model/TransactionRequest";
import {LineTotal} from "../../../../model/LineItem";
import {nowInDbPrecision} from "../../../../utils/dbUtils";

describe("/v2/transactions/checkout - marketplaceRate", () => {

    const router = new cassava.Router();

    before(async function () {
        await testUtils.resetDb();
        router.route(testUtils.authRoute);
        installRestRoutes(router);

        await currencies.createCurrency(defaultTestUser.auth, {
            code: "CAD",
            name: "Canadian bucks",
            symbol: "$",
            decimalPlaces: 2,
            createdDate: nowInDbPrecision(),
            updatedDate: nowInDbPrecision(),
            createdBy: testUtils.defaultTestUser.teamMemberId
        });
    });

    let value: Value;

    it("allows marketplaceRate to be set on every item", async () => {
        const postValueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
            id: "marketplace-test-gift-card",
            currency: "CAD",
            balance: 95000
        });
        chai.assert.equal(postValueResp.statusCode, 201, `body=${JSON.stringify(postValueResp.body)}`);
        value = postValueResp.body;

        const checkoutRequest = {
            id: "checkout-1",
            sources: [
                {
                    rail: "lightrail",
                    valueId: value.id
                }
            ],
            lineItems: [
                {
                    type: "product",
                    productId: "cheeseburger",
                    unitPrice: 1299,
                    taxRate: 0.05,
                    marketplaceRate: 0.2
                },
                {
                    type: "product",
                    productId: "fries",
                    unitPrice: 399,
                    quantity: 2,
                    taxRate: 0.05,
                    marketplaceRate: 0.2,
                },
                {
                    type: "fee",
                    productId: "commission-fee",
                    unitPrice: 200,
                    taxRate: 0.15,
                    marketplaceRate: 1
                }
            ],
            currency: "CAD"
        };
        const checkoutResp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkoutRequest);
        chai.assert.equal(checkoutResp.statusCode, 201, `body=${JSON.stringify(checkoutResp.body)}`);
        chai.assert.equal(checkoutResp.body.totals.tax, 135);
        chai.assert.deepEqual(checkoutResp.body.totals.marketplace, {
            sellerGross: 1678,
            sellerDiscount: 0,
            sellerNet: 1678
        });
    });

    it("allows marketplaceRate to be left off, and assumed to be 0", async () => {
        const checkoutRequest = {
            id: "checkout-2",
            sources: [
                {
                    rail: "lightrail",
                    valueId: value.id
                }
            ],
            lineItems: [
                {
                    type: "product",
                    productId: "cheeseburger",
                    unitPrice: 1299,
                    taxRate: 0.05,
                    marketplaceRate: 0.2
                },
                {
                    type: "product",
                    productId: "fries",
                    unitPrice: 399,
                    quantity: 2,
                    taxRate: 0.05,
                    marketplaceRate: 0.2,
                },
                {
                    type: "product",
                    productId: "flavored-sugar-water",
                    unitPrice: 249,
                    quantity: 2,
                    taxRate: 0.25
                },
                {
                    type: "fee",
                    productId: "commission-fee",
                    unitPrice: 200,
                    taxRate: 0.15,
                    marketplaceRate: 1
                }
            ],
            currency: "CAD"
        };
        const checkoutResp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkoutRequest);
        chai.assert.equal(checkoutResp.statusCode, 201, `body=${JSON.stringify(checkoutResp.body)}`);
        chai.assert.equal(checkoutResp.body.totals.tax, 259);
        chai.assert.deepEqual(checkoutResp.body.totals.marketplace, {
            sellerGross: 2176,
            sellerDiscount: 0,
            sellerNet: 2176
        });
    });

    let sellerDiscountValue: Value;

    it("removes discountSellerLiability=1.0 from the seller net", async () => {
        const postValueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
            id: "marketplace-seller-discount",
            currency: "CAD",
            discount: true,
            discountSellerLiability: 1.0,
            balance: 500,
            pretax: true
        });
        chai.assert.equal(postValueResp.statusCode, 201, `body=${JSON.stringify(postValueResp.body)}`);
        sellerDiscountValue = postValueResp.body;

        const checkoutRequest = {
            id: "checkout-3",
            sources: [
                {
                    rail: "lightrail",
                    valueId: value.id
                },
                {
                    rail: "lightrail",
                    valueId: sellerDiscountValue.id
                }
            ],
            lineItems: [
                {
                    type: "product",
                    productId: "adventure",
                    unitPrice: 20000,
                    taxRate: 0.15,
                    marketplaceRate: 0.2
                },
                {
                    type: "fee",
                    productId: "commission-fee",
                    unitPrice: 1200,
                    taxRate: 0.15,
                    marketplaceRate: 1
                }
            ],
            currency: "CAD"
        };
        const checkoutResp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkoutRequest);
        chai.assert.equal(checkoutResp.statusCode, 201, `body=${JSON.stringify(checkoutResp.body)}`);
        chai.assert.equal(checkoutResp.body.totals.tax, 3105);
        chai.assert.deepEqual(checkoutResp.body.totals.marketplace, {
            sellerGross: 16000,
            sellerDiscount: 500,
            sellerNet: 15500
        });
    });

    it("removes discountSellerLiability=0.5 from the seller net", async () => {
        const postValueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
            id: "mp-seller-half-discount",
            currency: "CAD",
            discount: true,
            discountSellerLiability: 0.5,
            balance: 500,
            pretax: true
        });
        chai.assert.equal(postValueResp.statusCode, 201, `body=${JSON.stringify(postValueResp.body)}`);
        sellerDiscountValue = postValueResp.body;

        const checkoutRequest = {
            id: "checkout-4",
            sources: [
                {
                    rail: "lightrail",
                    valueId: value.id
                },
                {
                    rail: "lightrail",
                    valueId: sellerDiscountValue.id
                }
            ],
            lineItems: [
                {
                    type: "product",
                    productId: "adventure",
                    unitPrice: 20000,
                    taxRate: 0.15,
                    marketplaceRate: 0.2
                },
                {
                    type: "fee",
                    productId: "commission-fee",
                    unitPrice: 1200,
                    taxRate: 0.15,
                    marketplaceRate: 1
                }
            ],
            currency: "CAD"
        };
        const checkoutResp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkoutRequest);
        chai.assert.equal(checkoutResp.statusCode, 201, `body=${JSON.stringify(checkoutResp.body)}`);
        chai.assert.equal(checkoutResp.body.totals.tax, 3105);
        chai.assert.deepEqual(checkoutResp.body.totals.marketplace, {
            sellerGross: 16000,
            sellerDiscount: 250,
            sellerNet: 15750
        });
    });

    it("can set discountSellerLiability to precise decimal and resulting sellerDiscount is properly rounded", async () => {
        const value: Partial<Value> = {
            id: generateId(),
            currency: "CAD",
            discount: true,
            discountSellerLiability: 0.815768,
            balance: 9200,
            pretax: true
        };
        const postValueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
        chai.assert.equal(postValueResp.statusCode, 201, `body=${JSON.stringify(postValueResp.body)}`);

        const checkoutRequest: CheckoutRequest = {
            id: generateId(),
            sources: [
                {
                    rail: "lightrail",
                    valueId: value.id
                }
            ],
            lineItems: [
                {
                    unitPrice: 46000,
                }
            ],
            allowRemainder: true,
            currency: "CAD"
        };
        const checkoutResp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkoutRequest);
        chai.assert.deepEqual(checkoutResp.body.totals.marketplace, {
            sellerDiscount: 7505,
            sellerGross: 46000,
            sellerNet: 38495
        });
    });

    it("discountSellerLiability still works if marketplaceRate is not set in checkout", async () => {
        const value: Partial<Value> = {
            id: generateId(),
            currency: "CAD",
            discount: true,
            discountSellerLiability: 0.4,
            balance: 500,
            pretax: true
        };
        const createValue = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
        chai.assert.equal(createValue.statusCode, 201);

        const checkoutRequest: CheckoutRequest = {
            id: generateId(),
            sources: [
                {
                    rail: "lightrail",
                    valueId: value.id
                }
            ],
            lineItems: [
                {
                    unitPrice: 1000,
                }
            ],
            currency: "CAD",
            allowRemainder: true,
        };
        const checkoutResp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkoutRequest);
        chai.assert.deepEqual(checkoutResp.body.totals, {
            subtotal: 1000,
            tax: 0,
            discount: 500,
            payable: 500,
            remainder: 500,
            forgiven: 0,
            discountLightrail: 500,
            paidLightrail: 0,
            paidStripe: 0,
            paidInternal: 0,
            marketplace: {
                sellerGross: 1000,
                sellerDiscount: 200,
                sellerNet: 800
            }
        });
    });

    it("can checkout against value that has discountSellerLiability: 1 - currentLineItem.marketplaceRate", async () => {
        const value: Partial<Value> = {
            id: generateId(),
            currency: "CAD",
            discount: true,
            discountSellerLiabilityRule: {
                rule: "1 - currentLineItem.marketplaceRate",
                explanation: "proportional to marketplace rate"
            },
            balance: 9200,
            pretax: true
        };

        const createValue = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
        chai.assert.equal(createValue.statusCode, 201, `body=${JSON.stringify(createValue.body)}`);
        chai.assert.deepEqual(createValue.body.discountSellerLiabilityRule, value.discountSellerLiabilityRule);

        const checkout: CheckoutRequest = {
            id: generateId(),
            sources: [
                {
                    rail: "lightrail",
                    valueId: value.id
                }
            ],
            lineItems: [
                {
                    productId: "rental_items_total",
                    unitPrice: 46000,
                    taxRate: 0.084,
                    marketplaceRate: 0.185,
                    quantity: 1,
                },
                {
                    productId: "delivery_total",
                    unitPrice: 3500,
                    taxRate: 0.084,
                    marketplaceRate: 0.185,
                    quantity: 1,
                },
                {
                    productId: "service_fee_total",
                    unitPrice: 2821,
                    taxRate: 0.084,
                    marketplaceRate: 1,
                    quantity: 1,
                }
            ],
            currency: "CAD",
            allowRemainder: true
        };
        const createCheckout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkout);
        chai.assert.equal(createCheckout.statusCode, 201, `body=${JSON.stringify(createCheckout.body)}`);
        chai.assert.deepEqual(createCheckout.body.totals, {
            "subtotal": 52321,
            "tax": 3622,
            "discount": 9200,
            "payable": 46743,
            "remainder": 46743,
            "forgiven": 0,
            "discountLightrail": 9200,
            "paidLightrail": 0,
            "paidStripe": 0,
            "paidInternal": 0,
            "marketplace": {
                "sellerGross": 40342,
                "sellerDiscount": 7498,
                "sellerNet": 32844
            }
        });
        chai.assert.deepEqual(createCheckout.body.lineItems, [
            {
                "productId": "rental_items_total",
                "unitPrice": 46000,
                "taxRate": 0.084,
                "marketplaceRate": 0.185,
                "quantity": 1,
                "lineTotal": {
                    "subtotal": 46000,
                    "taxable": 36800,
                    "tax": 3091,
                    "discount": 9200,
                    "sellerDiscount": 7498,
                    "remainder": 39891,
                    "payable": 39891
                }
            },
            {
                "productId": "delivery_total",
                "unitPrice": 3500,
                "taxRate": 0.084,
                "marketplaceRate": 0.185,
                "quantity": 1,
                "lineTotal": {
                    "subtotal": 3500,
                    "taxable": 3500,
                    "tax": 294,
                    "discount": 0,
                    "sellerDiscount": 0,
                    "remainder": 3794,
                    "payable": 3794
                }
            },
            {
                "productId": "service_fee_total",
                "unitPrice": 2821,
                "taxRate": 0.084,
                "marketplaceRate": 1,
                "quantity": 1,
                "lineTotal": {
                    "subtotal": 2821,
                    "taxable": 2821,
                    "tax": 237,
                    "discount": 0,
                    "sellerDiscount": 0,
                    "remainder": 3058,
                    "payable": 3058
                }
            }
        ]);
    });

    it("discountSellerLiability rules result in a maximum of 100% discountSellerLiability", async () => {
        const value: Partial<Value> = {
            id: generateId(),
            currency: "CAD",
            discount: true,
            discountSellerLiabilityRule: {
                rule: "currentLineItem.marketplaceRate * 10",
                explanation: "Will evaluate to 2, which will be limited to 1"
            },
            balanceRule: {
                rule: "currentLineItem.lineTotal.subtotal * 0.40",
                explanation: "40% off"
            },
            pretax: true
        };
        const createValue = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
        chai.assert.equal(createValue.statusCode, 201, `body=${JSON.stringify(createValue.body)}`);
        chai.assert.deepEqual(createValue.body.discountSellerLiabilityRule, value.discountSellerLiabilityRule);

        const checkout: CheckoutRequest = {
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
                    productId: "adventure",
                    unitPrice: 20000,
                    marketplaceRate: 0.2
                }
            ],
            currency: "CAD",
            allowRemainder: true
        };
        const createCheckout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkout);
        chai.assert.equal(createCheckout.statusCode, 201, `body=${JSON.stringify(createCheckout.body)}`);
        chai.assert.deepEqual(createCheckout.body.totals, {
            "subtotal": 20000,
            "tax": 0,
            "discount": 8000,
            "payable": 12000,
            "remainder": 12000,
            "forgiven": 0,
            "discountLightrail": 8000,
            "paidLightrail": 0,
            "paidStripe": 0,
            "paidInternal": 0,
            "marketplace": {
                "sellerGross": 16000,
                "sellerDiscount": 8000,
                "sellerNet": 8000
            }
        });
        chai.assert.deepEqual(createCheckout.body.lineItems[0]["lineTotal"] as LineTotal, {
                "subtotal": 20000,
                "taxable": 12000,
                "tax": 0,
                "discount": 8000,
                "sellerDiscount": 8000,
                "remainder": 12000,
                "payable": 12000
            }
        );
    });

    it("discountSellerLiability rules result in a minimum of 0% discountSellerLiability", async () => {
        const value: Partial<Value> = {
            id: generateId(),
            currency: "CAD",
            discount: true,
            discountSellerLiabilityRule: {
                rule: "-10 * currentLineItem.marketplaceRate",
                explanation: "Will evaluate to -2 which will be limited to 0"
            },
            balanceRule: {
                rule: "currentLineItem.lineTotal.subtotal * 0.40",
                explanation: "40% off"
            },
            pretax: true
        };
        const createValue = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
        chai.assert.equal(createValue.statusCode, 201, `body=${JSON.stringify(createValue.body)}`);
        chai.assert.deepEqual(createValue.body.discountSellerLiabilityRule, value.discountSellerLiabilityRule);

        const checkout: CheckoutRequest = {
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
                    productId: "adventure",
                    unitPrice: 20000,
                    marketplaceRate: 0.2
                }
            ],
            currency: "CAD",
            allowRemainder: true
        };
        const createCheckout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkout);
        chai.assert.equal(createCheckout.statusCode, 201, `body=${JSON.stringify(createCheckout.body)}`);
        chai.assert.deepEqual(createCheckout.body.totals, {
            "subtotal": 20000,
            "tax": 0,
            "discount": 8000,
            "payable": 12000,
            "remainder": 12000,
            "forgiven": 0,
            "discountLightrail": 8000,
            "paidLightrail": 0,
            "paidStripe": 0,
            "paidInternal": 0,
            "marketplace": {
                "sellerGross": 16000,
                "sellerDiscount": 0,
                "sellerNet": 16000
            }
        });
        chai.assert.deepEqual(createCheckout.body.lineItems[0]["lineTotal"] as LineTotal, {
            "subtotal": 20000,
            "taxable": 12000,
            "tax": 0,
            "discount": 8000,
            "sellerDiscount": 0,
            "remainder": 12000,
            "payable": 12000
        });
    });

    it("discountSellerLiability rules that don't evaluate to anything result in 0", async () => {
        const value: Partial<Value> = {
            id: generateId(),
            currency: "CAD",
            discount: true,
            discountSellerLiabilityRule: {
                rule: "currentLineItem.nothingHere",
                explanation: "doesn't correspond to anything in the context"
            },
            balanceRule: {
                rule: "currentLineItem.lineTotal.subtotal * 0.40",
                explanation: "40% off"
            },
            pretax: true
        };
        const createValue = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
        chai.assert.equal(createValue.statusCode, 201, `body=${JSON.stringify(createValue.body)}`);
        chai.assert.deepEqual(createValue.body.discountSellerLiabilityRule, value.discountSellerLiabilityRule);

        const checkout: CheckoutRequest = {
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
                    productId: "adventure",
                    unitPrice: 20000,
                    marketplaceRate: 0.2
                }
            ],
            currency: "CAD",
            allowRemainder: true
        };
        const createCheckout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkout);
        chai.assert.equal(createCheckout.statusCode, 201, `body=${JSON.stringify(createCheckout.body)}`);
        chai.assert.deepEqual(createCheckout.body.totals, {
            "subtotal": 20000,
            "tax": 0,
            "discount": 8000,
            "payable": 12000,
            "remainder": 12000,
            "forgiven": 0,
            "discountLightrail": 8000,
            "paidLightrail": 0,
            "paidStripe": 0,
            "paidInternal": 0,
            "marketplace": {
                "sellerGross": 16000,
                "sellerDiscount": 0,
                "sellerNet": 16000
            }
        });
        chai.assert.deepEqual(createCheckout.body.lineItems, [
            {
                "type": "product",
                "productId": "adventure",
                "unitPrice": 20000,
                "marketplaceRate": 0.2,
                "quantity": 1,
                "lineTotal": {
                    "subtotal": 20000,
                    "taxable": 12000,
                    "tax": 0,
                    "discount": 8000,
                    "sellerDiscount": 0,
                    "remainder": 12000,
                    "payable": 12000
                }
            }
        ]);
    });

    it("discountSellerLiability rules that partially evaluate still execute based on what they evaluate to - missing marketplaceRate on lineItems", async () => {
        const value: Partial<Value> = {
            id: generateId(),
            currency: "CAD",
            discount: true,
            discountSellerLiabilityRule: {
                rule: "1 - currentLineItem.marketplaceRate",
                explanation: "proportional to marketplace rate"
            },
            balanceRule: {
                rule: "currentLineItem.lineTotal.subtotal * 0.40",
                explanation: "40% off"
            },
            pretax: true
        };
        const createValue = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
        chai.assert.equal(createValue.statusCode, 201, `body=${JSON.stringify(createValue.body)}`);
        chai.assert.deepEqual(createValue.body.discountSellerLiabilityRule, value.discountSellerLiabilityRule);

        const checkout: CheckoutRequest = {
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
                    productId: "adventure",
                    unitPrice: 20000
                }
            ],
            currency: "CAD",
            allowRemainder: true
        };
        const createCheckout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkout);
        chai.assert.equal(createCheckout.statusCode, 201, `body=${JSON.stringify(createCheckout.body)}`);
        chai.assert.deepEqual(createCheckout.body.totals, {
            "subtotal": 20000,
            "tax": 0,
            "discount": 8000,
            "payable": 12000,
            "remainder": 12000,
            "forgiven": 0,
            "discountLightrail": 8000,
            "paidLightrail": 0,
            "paidStripe": 0,
            "paidInternal": 0,
            "marketplace": {
                "sellerGross": 20000,
                "sellerDiscount": 8000,
                "sellerNet": 12000
            }
        });
        chai.assert.deepEqual(createCheckout.body.lineItems, [
            {
                "type": "product",
                "productId": "adventure",
                "unitPrice": 20000,
                "quantity": 1,
                "lineTotal": {
                    "subtotal": 20000,
                    "taxable": 12000,
                    "tax": 0,
                    "discount": 8000,
                    "sellerDiscount": 8000,
                    "remainder": 12000,
                    "payable": 12000
                }
            }
        ]);
    });

    it("sellerDiscount is correctly rounded", async () => {
        const value: Partial<Value> = {
            id: generateId(),
            currency: "CAD",
            discount: true,
            discountSellerLiabilityRule: {rule: "0.123456789", explanation: "a very precise discount seller liability"},
            balanceRule: {
                rule: "currentLineItem.lineTotal.subtotal * 0.40",
                explanation: "40% off"
            },
            pretax: true
        };
        const createValue = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
        chai.assert.equal(createValue.statusCode, 201, `body=${JSON.stringify(createValue.body)}`);
        chai.assert.deepEqual(createValue.body.discountSellerLiabilityRule, value.discountSellerLiabilityRule);

        const checkout: CheckoutRequest = {
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
                    productId: "adventure",
                    unitPrice: 20000,
                    marketplaceRate: 0.2
                }
            ],
            currency: "CAD",
            allowRemainder: true
        };
        const createCheckout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkout);
        chai.assert.equal(createCheckout.statusCode, 201, `body=${JSON.stringify(createCheckout.body)}`);
        chai.assert.deepEqual(createCheckout.body.totals, {
            "subtotal": 20000,
            "tax": 0,
            "discount": 8000,
            "payable": 12000,
            "remainder": 12000,
            "forgiven": 0,
            "discountLightrail": 8000,
            "paidLightrail": 0,
            "paidStripe": 0,
            "paidInternal": 0,
            "marketplace": {
                "sellerGross": 16000,
                "sellerDiscount": 988,
                "sellerNet": 15012
            }
        });
        chai.assert.deepEqual(createCheckout.body.lineItems[0]["lineTotal"] as LineTotal,
            {
                "subtotal": 20000,
                "taxable": 12000,
                "tax": 0,
                "discount": 8000,
                "sellerDiscount": 988,
                "remainder": 12000,
                "payable": 12000
            });
    });
});
