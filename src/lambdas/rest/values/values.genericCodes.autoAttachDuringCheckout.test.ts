import * as cassava from "cassava";
import * as chai from "chai";
import * as testUtils from "../../../utils/testUtils/index";
import {generateFullcode, generateId, setCodeCryptographySecrets} from "../../../utils/testUtils/index";
import {formatCodeForLastFourDisplay, Value} from "../../../model/Value";
import {installRestRoutes} from "../installRestRoutes";
import {createCurrency} from "../currencies";
import {Contact} from "../../../model/Contact";
import {Transaction} from "../../../model/Transaction";
import {CheckoutRequest} from "../../../model/TransactionRequest";
import {setStubsForStripeTests, unsetStubsForStripeTests} from "../../../utils/testUtils/stripeTestUtils";
import {generateUrlSafeHashFromValueIdContactId} from "../genericCode";
import chaiExclude from "chai-exclude";
import {nowInDbPrecision} from "../../../utils/dbUtils";
import {LightrailTransactionStep} from "../../../model/TransactionStep";

chai.use(chaiExclude);

describe("/v2/transactions/checkout - generic code with auto-attach", () => {

    const router = new cassava.Router();

    before(async function () {
        await testUtils.resetDb();
        router.route(testUtils.authRoute);
        installRestRoutes(router);
        setCodeCryptographySecrets();
        await createCurrency(testUtils.defaultTestUser.auth, {
            code: "USD",
            name: "US Dollars",
            symbol: "$",
            decimalPlaces: 2,
            createdDate: nowInDbPrecision(),
            updatedDate: nowInDbPrecision(),
            createdBy: testUtils.defaultTestUser.teamMemberId
        });
        await setStubsForStripeTests();
    });

    after(() => {
        unsetStubsForStripeTests();
    });

    describe("happy paths", () => {
        const contactId = generateId();

        before(async function () {
            const createContact = await testUtils.testAuthedRequest<Contact>(router, "/v2/contacts", "POST", {id: contactId});
            chai.assert.equal(createContact.statusCode, 201);
        });

        const genericValue: Partial<Value> = {
            id: generateId(),
            currency: "USD",
            isGenericCode: true,
            code: generateFullcode(),
            genericCodeOptions: {
                perContact: {
                    usesRemaining: 3,
                    balance: 500
                }
            },
            usesRemaining: null,
            balance: null,
        };

        it("can create generic value", async () => {
            const create = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", genericValue);
            chai.assert.equal(create.statusCode, 201);
            chai.assert.deepNestedInclude(create.body, genericValue);
        });

        it("can checkout against with code and contact", async () => {
            const checkoutRequest: CheckoutRequest = {
                id: generateId(),
                currency: "USD",
                sources: [
                    {rail: "lightrail", contactId: contactId},
                    {rail: "lightrail", code: genericValue.code}
                ],
                lineItems: [
                    {unitPrice: 200}
                ],
                simulate: false
            };
            const checkout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkoutRequest);

            chai.assert.deepEqualExcluding(checkout.body, {
                    "id": checkoutRequest.id,
                    "transactionType": "checkout",
                    "currency": "USD",
                    "createdDate": null,
                    "tax": {
                        "roundingMode": "HALF_EVEN"
                    },
                    "totals": {
                        "subtotal": 200,
                        "tax": 0,
                        "discount": 0,
                        "payable": 200,
                        "remainder": 0,
                        "forgiven": 0,
                        "discountLightrail": 0,
                        "paidLightrail": 200,
                        "paidStripe": 0,
                        "paidInternal": 0
                    },
                    "lineItems": [
                        {
                            "unitPrice": 200,
                            "quantity": 1,
                            "lineTotal": {
                                "subtotal": 200,
                                "taxable": 200,
                                "tax": 0,
                                "discount": 0,
                                "remainder": 0,
                                "payable": 200
                            }
                        }
                    ],
                    "steps": [
                        {
                            "rail": "lightrail",
                            "valueId": generateUrlSafeHashFromValueIdContactId(genericValue.id, contactId),
                            "contactId": contactId,
                            "code": null,
                            "balanceRule": null,
                            "balanceBefore": 500,
                            "balanceChange": -200,
                            "balanceAfter": 300,
                            "usesRemainingBefore": 3,
                            "usesRemainingChange": -1,
                            "usesRemainingAfter": 2
                        }
                    ],
                    "paymentSources": [
                        {
                            "rail": "lightrail",
                            "contactId": contactId
                        },
                        {
                            "rail": "lightrail",
                            "code": formatCodeForLastFourDisplay(genericValue.code)
                        }
                    ],
                    "pending": false,
                    "metadata": null,
                    "createdBy": "default-test-user-TEST"
                }, ["createdDate"]
            );

            // check for attach transaction
            const attachTx = await testUtils.testAuthedRequest<Transaction[]>(router, `/v2/transactions?valueId=${genericValue.id}&transactionType=attach`, "GET");
            chai.assert.equal(attachTx.body.length, 1);
            chai.assert.equal(attachTx.body[0].transactionType, "attach");
        });

        it("can checkout against contact1 and code again (this time code already attached so doesn't attach again)", async () => {
            const checkoutRequest: CheckoutRequest = {
                id: generateId(),
                currency: "USD",
                sources: [
                    {rail: "lightrail", contactId: contactId},
                    {rail: "lightrail", code: genericValue.code}
                ],
                lineItems: [
                    {unitPrice: 150}
                ],
                simulate: false
            };
            const checkout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkoutRequest);
            chai.assert.equal(checkout.statusCode, 201);
            chai.assert.equal(checkout.body.steps[0]["balanceAfter"], 150);
            chai.assert.equal(checkout.body.steps[0]["usesRemainingAfter"], 1);
        });

        it("can checkout against contact1", async () => {
            const checkoutRequest: CheckoutRequest = {
                id: generateId(),
                currency: "USD",
                sources: [
                    {rail: "lightrail", contactId: contactId}
                ],
                lineItems: [
                    {unitPrice: 50}
                ],
                simulate: false
            };
            const checkout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkoutRequest);
            chai.assert.equal(checkout.statusCode, 201);
            chai.assert.equal(checkout.body.steps[0]["balanceAfter"], 100);
            chai.assert.equal(checkout.body.steps[0]["usesRemainingAfter"], 0);
        });
    });

    describe("happy path balanceRule", () => {
        const contactId = generateId();

        before(async function () {
            const createContact = await testUtils.testAuthedRequest<Contact>(router, "/v2/contacts", "POST", {id: contactId});
            chai.assert.equal(createContact.statusCode, 201);
        });

        const genericValue: Partial<Value> = {
            id: generateId(),
            currency: "USD",
            isGenericCode: true,
            code: generateFullcode(),
            genericCodeOptions: {
                perContact: {
                    usesRemaining: 1,
                    balance: null
                }
            },
            usesRemaining: 5,
            balance: null,
            balanceRule: {
                rule: "500 + value.balanceChange",
                explanation: "$5 off purchase"
            }
        };

        it("can create generic value", async () => {
            const create = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", genericValue);
            chai.assert.equal(create.statusCode, 201);
            chai.assert.deepNestedInclude(create.body, genericValue);
        });

        it("can checkout against contact1", async () => {
            const checkoutRequest: CheckoutRequest = {
                id: generateId(),
                currency: "USD",
                sources: [
                    {rail: "lightrail", contactId: contactId},
                    {rail: "lightrail", code: genericValue.code}
                ],
                lineItems: [
                    {unitPrice: 777}
                ],
                allowRemainder: true,
                simulate: false
            };
            const checkout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkoutRequest);
            chai.assert.equal(checkout.statusCode, 201);
            chai.assert.equal(checkout.body.steps[0]["balanceChange"], -500);
            chai.assert.equal(checkout.body.steps[0]["usesRemainingAfter"], 0);
        });
    });

    describe("doesn't auto attach if attached Value isn't used", () => {
        const contactId = generateId();
        const discountValueId = generateId();

        const genericValue: Partial<Value> = {
            id: generateId(),
            currency: "USD",
            isGenericCode: true,
            code: generateFullcode(),
            genericCodeOptions: {
                perContact: {
                    usesRemaining: 1,
                    balance: null
                }
            },
            usesRemaining: 5,
            balance: null,
            balanceRule: {
                rule: "500 + value.balanceChange",
                explanation: "$5 off purchase"
            }
        };

        before(async function () {
            const createContact = await testUtils.testAuthedRequest<Contact>(router, "/v2/contacts", "POST", {id: contactId});
            chai.assert.equal(createContact.statusCode, 201);

            const discount: Partial<Value> = {
                id: discountValueId,
                balance: 1000,
                discount: true,
                currency: "USD",
                contactId: contactId
            };
            const addDiscount = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", discount);
            chai.assert.equal(addDiscount.statusCode, 201);

            const create = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", genericValue);
            chai.assert.equal(create.statusCode, 201);
            chai.assert.deepNestedInclude(create.body, genericValue);
        });

        it("can checkout against contact1", async () => {
            const checkoutRequest: CheckoutRequest = {
                id: generateId(),
                currency: "USD",
                sources: [
                    {rail: "lightrail", contactId: contactId},
                    {rail: "lightrail", code: genericValue.code}
                ],
                lineItems: [
                    {unitPrice: 777}
                ],
                allowRemainder: true,
                simulate: false
            };
            const checkout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkoutRequest);

            chai.assert.deepEqualExcluding(checkout.body, {
                    "id": checkoutRequest.id,
                    "transactionType": "checkout",
                    "currency": "USD",
                    "createdDate": null,
                    "tax": {
                        "roundingMode": "HALF_EVEN"
                    },
                    "totals": {
                        "subtotal": 777,
                        "tax": 0,
                        "discount": 777,
                        "payable": 0,
                        "remainder": 0,
                        "forgiven": 0,
                        "discountLightrail": 777,
                        "paidLightrail": 0,
                        "paidStripe": 0,
                        "paidInternal": 0
                    },
                    "lineItems": [
                        {
                            "unitPrice": 777,
                            "quantity": 1,
                            "lineTotal": {
                                "subtotal": 777,
                                "taxable": 777,
                                "tax": 0,
                                "discount": 777,
                                "remainder": 0,
                                "payable": 0
                            }
                        }
                    ],
                    "steps": [
                        {
                            "rail": "lightrail",
                            "valueId": discountValueId,
                            "contactId": contactId,
                            "code": null,
                            "balanceRule": null,
                            "balanceBefore": 1000,
                            "balanceChange": -777,
                            "balanceAfter": 223,
                            "usesRemainingBefore": null,
                            "usesRemainingChange": null,
                            "usesRemainingAfter": null
                        }
                    ],
                    "paymentSources": [
                        {
                            "rail": "lightrail",
                            "contactId": contactId
                        },
                        {
                            "rail": "lightrail",
                            "code": formatCodeForLastFourDisplay(genericValue.code)
                        }
                    ],
                    "pending": false,
                    "metadata": null,
                    "createdBy": "default-test-user-TEST"
                }, ["createdDate"]
            );
        });
    });

    describe("simulate: true", () => {
        const contactId = generateId();

        before(async function () {
            const createContact1 = await testUtils.testAuthedRequest<Contact>(router, "/v2/contacts", "POST", {id: contactId});
            chai.assert.equal(createContact1.statusCode, 201);
        });

        const genericValue: Partial<Value> = {
            id: generateId(),
            currency: "USD",
            isGenericCode: true,
            code: generateFullcode(),
            genericCodeOptions: {
                perContact: {
                    usesRemaining: 1,
                    balance: null
                }
            },
            usesRemaining: null,
            balance: null,
            balanceRule: {
                rule: "500 + value.balanceChange",
                explanation: "$5 off purchase"
            }
        };

        it("can create generic value", async () => {
            const create = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", genericValue);
            chai.assert.equal(create.statusCode, 201);
            chai.assert.deepNestedInclude(create.body, genericValue);
        });

        it("can checkout against contact1", async () => {
            const checkoutRequest: CheckoutRequest = {
                id: generateId(),
                currency: "USD",
                sources: [
                    {rail: "lightrail", contactId: contactId},
                    {rail: "lightrail", code: genericValue.code}
                ],
                lineItems: [
                    {unitPrice: 777}
                ],
                allowRemainder: true,
                simulate: true
            };
            const checkout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkoutRequest);
            chai.assert.equal(checkout.statusCode, 200);
            chai.assert.isTrue(checkout.body.simulated);
            chai.assert.equal(checkout.body.steps[0]["valueId"], generateUrlSafeHashFromValueIdContactId(genericValue.id, contactId));
            chai.assert.equal(checkout.body.steps[0]["balanceChange"], -500);
            chai.assert.equal(checkout.body.steps[0]["usesRemainingAfter"], 0);
        });

        it("can't simulate against an invalid contact id with auto-attach", async () => {
            const checkoutRequest: CheckoutRequest = {
                id: generateId(),
                currency: "USD",
                sources: [
                    {rail: "lightrail", contactId: "sfgdfgdsfgsdfg"},
                    {rail: "lightrail", code: genericValue.code}
                ],
                lineItems: [
                    {unitPrice: 777}
                ],
                allowRemainder: true,
                simulate: true
            };
            const checkout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkoutRequest);
            chai.assert.equal(checkout.statusCode, 409);
            chai.assert.equal(checkout.body["messageCode"], "ValueMustBeAttached");
        });
    });

    describe("auto attach works with two generic codes", () => {
        const contactId = generateId();

        const genericValue1: Partial<Value> = {
            id: generateId(),
            currency: "USD",
            isGenericCode: true,
            code: generateFullcode(),
            genericCodeOptions: {
                perContact: {
                    usesRemaining: 1,
                    balance: null
                }
            },
            balanceRule: {
                rule: "100 + value.balanceChange",
                explanation: "$1 off purchase"
            }
        };
        const genericValue2: Partial<Value> = {
            id: generateId(),
            currency: "USD",
            isGenericCode: true,
            code: generateFullcode(),
            genericCodeOptions: {
                perContact: {
                    usesRemaining: 1,
                    balance: null
                }
            },
            balanceRule: {
                rule: "200 + value.balanceChange",
                explanation: "$2 off purchase"
            }
        };

        before(async function () {
            const createContact1 = await testUtils.testAuthedRequest<Contact>(router, "/v2/contacts", "POST", {id: contactId});
            chai.assert.equal(createContact1.statusCode, 201);

            const create1 = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", genericValue1);
            chai.assert.equal(create1.statusCode, 201);
            const create2 = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", genericValue2);
            chai.assert.equal(create2.statusCode, 201);
        });

        const checkoutRequest: CheckoutRequest = {
            id: generateId(),
            currency: "USD",
            sources: [
                {rail: "lightrail", contactId: contactId},
                {rail: "lightrail", code: genericValue1.code},
                {rail: "lightrail", code: genericValue2.code}
            ],
            lineItems: [
                {unitPrice: 777}
            ],
            allowRemainder: true,
        };

        it("can simulate checkout", async () => {
            const checkout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", {
                ...checkoutRequest,
                simulate: true
            });
            chai.assert.equal(checkout.statusCode, 200);
            chai.assert.isTrue(checkout.body.simulated);
            chai.assert.sameMembers(
                checkout.body.steps.map(step => (step as LightrailTransactionStep).valueId),
                [genericValue1.id, genericValue2.id].map(gcId => generateUrlSafeHashFromValueIdContactId(gcId, contactId))
            );
            chai.assert.equal(checkout.body.totals.paidLightrail, 300);
        });

        it("can checkout", async () => {
            const checkout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", {
                ...checkoutRequest
            });
            chai.assert.equal(checkout.statusCode, 201);
            chai.assert.sameMembers(
                checkout.body.steps.map(step => (step as LightrailTransactionStep).valueId),
                [genericValue1.id, genericValue2.id].map(gcId => generateUrlSafeHashFromValueIdContactId(gcId, contactId))
            );
            chai.assert.equal(checkout.body.totals.paidLightrail, 300);

            // check for attach transactions.
            const attachTx1 = await testUtils.testAuthedRequest<Transaction[]>(router, `/v2/transactions?valueId=${genericValue1.id}&transactionType=attach`, "GET");
            chai.assert.equal(attachTx1.body.length, 1);
            chai.assert.equal(attachTx1.body[0].transactionType, "attach");

            const attachTx2 = await testUtils.testAuthedRequest<Transaction[]>(router, `/v2/transactions?valueId=${genericValue2.id}&transactionType=attach`, "GET");
            chai.assert.equal(attachTx2.body.length, 1);
            chai.assert.equal(attachTx2.body[0].transactionType, "attach");
        });
    });

    describe("edge cases", () => {
        const contactId = generateId();

        const genericValue: Partial<Value> = {
            id: generateId(),
            currency: "USD",
            isGenericCode: true,
            code: generateFullcode(),
            genericCodeOptions: {
                perContact: {
                    usesRemaining: 3,
                    balance: 500
                }
            },
            usesRemaining: null,
            balance: null,
        };

        before(async function () {
            const createContact = await testUtils.testAuthedRequest<Contact>(router, "/v2/contacts", "POST", {id: contactId});
            chai.assert.equal(createContact.statusCode, 201);

            const create = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", genericValue);
            chai.assert.equal(create.statusCode, 201);
            chai.assert.deepNestedInclude(create.body, genericValue);
        });

        it("can't checkout against generic code directly (ie without providing contactId as a payment source)", async () => {
            const checkoutRequest: CheckoutRequest = {
                id: generateId(),
                currency: "USD",
                sources: [
                    {rail: "lightrail", code: genericValue.code}
                ],
                lineItems: [
                    {unitPrice: 200}
                ]
            };
            const checkout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkoutRequest);
            chai.assert.equal(checkout.statusCode, 409);
            chai.assert.equal(checkout.body["messageCode"], "ValueMustBeAttached");
        });

        it("auto-attaches to first contact in list if multiple contactIds passed in payment sources", async () => {
            const contact2 = generateId();
            const createContact = await testUtils.testAuthedRequest<Contact>(router, "/v2/contacts", "POST", {id: contact2});
            chai.assert.equal(createContact.statusCode, 201);

            // auto attach
            const checkoutRequest: CheckoutRequest = {
                id: generateId(),
                currency: "USD",
                sources: [
                    {rail: "lightrail", code: genericValue.code},
                    {rail: "lightrail", contactId: contactId},
                    {rail: "lightrail", contactId: contact2}
                ],
                lineItems: [
                    {unitPrice: genericValue.genericCodeOptions.perContact.balance + 1} // it costs more so an auto-attach that's not used isn't thrown away.
                ],
                allowRemainder: true
            };
            const checkout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkoutRequest);
            chai.assert.equal(checkout.statusCode, 201);
            chai.assert.equal(checkout.body.steps.length, 1);
            chai.assert.equal((checkout.body.steps[0] as LightrailTransactionStep).contactId, contactId, "Expected to be auto attached to first contact in list.");
        });
    });

    it("doesn't auto attach expired generic code", async () => {
        const contactId = generateId();
        const createContact = await testUtils.testAuthedRequest<Contact>(router, "/v2/contacts", "POST", {id: contactId});
        chai.assert.equal(createContact.statusCode, 201);

        const expiredGenericCode: Partial<Value> = {
            id: generateId(),
            currency: "USD",
            isGenericCode: true,
            code: generateFullcode(),
            genericCodeOptions: {
                perContact: {
                    usesRemaining: 3,
                    balance: 500
                }
            },
            usesRemaining: null,
            balance: null,
            endDate: new Date("2011-01-01")
        };
        const create = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", expiredGenericCode);
        chai.assert.equal(create.statusCode, 201);

        // auto attach
        const checkoutRequest: CheckoutRequest = {
            id: generateId(),
            currency: "USD",
            sources: [
                {rail: "lightrail", code: expiredGenericCode.code},
                {rail: "lightrail", contactId: contactId},
            ],
            lineItems: [
                {unitPrice: 500}
            ],
            allowRemainder: true
        };
        const checkout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkoutRequest);
        chai.assert.equal(checkout.statusCode, 201);
        chai.assert.equal(checkout.body.steps.length, 0);

        // check for attach transactions.
        const attachTx = await testUtils.testAuthedRequest<Transaction[]>(router, `/v2/transactions?valueId=${expiredGenericCode.id}&transactionType=attach`, "GET");
        chai.assert.equal(attachTx.body.length, 0);
    });

    describe("doesn't auto attach generic code without perContact options because the code can be used directly", () => {
        const contactId = generateId();

        const genericValue: Partial<Value> = {
            id: generateId(),
            currency: "USD",
            isGenericCode: true,
            code: generateFullcode(),
            balanceRule: {
                rule: "500 + value.balanceChange",
                explanation: "$5 off purchase"
            }
        };

        before(async function () {
            const createContact = await testUtils.testAuthedRequest<Contact>(router, "/v2/contacts", "POST", {id: contactId});
            chai.assert.equal(createContact.statusCode, 201);

            const create = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", genericValue);
            chai.assert.equal(create.statusCode, 201);
        });

        it("can checkout directly against generic code and it's not auto-attached", async () => {
            const checkoutRequest: CheckoutRequest = {
                id: generateId(),
                currency: "USD",
                sources: [
                    {rail: "lightrail", contactId: contactId},
                    {rail: "lightrail", code: genericValue.code}
                ],
                lineItems: [
                    {unitPrice: 111}
                ],
            };
            const checkout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkoutRequest);
            chai.assert.equal(checkout.statusCode, 201);
            chai.assert.equal((checkout.body.steps[0] as LightrailTransactionStep).valueId, genericValue.id); // generic code is the one that's used

            // check for attach transactions.
            const attachTx = await testUtils.testAuthedRequest<Transaction[]>(router, `/v2/transactions?valueId=${genericValue.id}&transactionType=attach`, "GET");
            chai.assert.equal(attachTx.body.length, 0);
        });
    });

    it("checkout with stripe exception rolls back auto-attach. no value is inserted", async () => {
        const contactId = generateId();

        const genericValue: Partial<Value> = {
            id: generateId(),
            currency: "USD",
            isGenericCode: true,
            code: generateFullcode(),
            discount: true,
            genericCodeOptions: {
                perContact: {
                    balance: 500,
                    usesRemaining: null
                }
            }
        };

        const createContact = await testUtils.testAuthedRequest<Contact>(router, "/v2/contacts", "POST", {id: contactId});
        chai.assert.equal(createContact.statusCode, 201);

        const create = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", genericValue);
        chai.assert.equal(create.statusCode, 201);

        const request: CheckoutRequest = {
            id: "chg-fraudulent",
            sources: [
                {
                    rail: "stripe",
                    source: "tok_chargeDeclinedFraudulent"
                },
                {
                    rail: "lightrail",
                    contactId: contactId
                },
                {
                    rail: "lightrail",
                    code: genericValue.code
                }
            ],
            currency: "USD",
            lineItems: [{unitPrice: 1000}]
        };

        const postCheckoutResp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", request);
        chai.assert.equal(postCheckoutResp.statusCode, 409, `resp=${JSON.stringify(postCheckoutResp, null, 4)}`);

        const attachTx = await testUtils.testAuthedRequest<Transaction[]>(router, `/v2/transactions?valueId=${genericValue.id}&transactionType=attach`, "GET");
        chai.assert.equal(attachTx.body.length, 0);
    });
});
