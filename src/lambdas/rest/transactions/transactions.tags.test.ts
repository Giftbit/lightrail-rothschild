import * as chai from "chai";
import chaiExclude from "chai-exclude";
import * as cassava from "cassava";
import * as testUtils from "../../../utils/testUtils";
import {generateId} from "../../../utils/testUtils";
import {installRestRoutes} from "../installRestRoutes";
import {Value} from "../../../model/Value";
import {Contact} from "../../../model/Contact";
import {Transaction} from "../../../model/Transaction";

chai.use(chaiExclude);

describe("/v2/transactions - tags", () => {
    const router = new cassava.Router();

    const contact1: Partial<Contact> = {
        id: "contact1"
    };
    const value1: Partial<Value> = {
        id: "value-1",
        contactId: contact1.id,
        currency: "USD",
        balanceRule: {rule: "1000", explanation: "1000"},
        balance: null
    };
    const value2: Partial<Value> = {
        id: "value-2",
        contactId: contact1.id,
        currency: "USD",
        balance: 5000
    };
    const value3: Partial<Value> = {
        id: "value-3",
        contactId: contact1.id,
        currency: "USD",
        balance: 5000
    };

    before(async function () {
        await testUtils.resetDb();
        router.route(testUtils.authRoute);
        installRestRoutes(router);

        await testUtils.createUSD(router);
        const contactResp = await testUtils.testAuthedRequest<Contact>(router, "/v2/contacts", "POST", contact1);
        chai.assert.equal(contactResp.statusCode, 201);
        await testUtils.createUSDValue(router, value1);
        await testUtils.createUSDValue(router, value2);
        await testUtils.createUSDValue(router, value3);
    });

    describe("checkouts", () => {
        describe("'regular' checkouts", () => {
            it("unique attached value as source", async () => {
                const resp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", {
                    id: "checkout-uq-attached-value",
                    currency: "USD",
                    lineItems: [{unitPrice: 100}],
                    sources: [{rail: "lightrail", valueId: value1.id}]
                });
                chai.assert.equal(resp.statusCode, 201, `resp.body=${JSON.stringify(resp.body)}`);

                chai.assert.equal(resp.body.tags.length, 1, `resp.body should have 1 tag: ${JSON.stringify(resp.body)}`);
                chai.assert.sameDeepMembers(resp.body.tags, [`contactId:${contact1.id}`], `tags=${resp.body.tags}`);
            });

            it("contactId as source", async () => {
                const resp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", {
                    id: "checkout-cid",
                    currency: "USD",
                    lineItems: [{unitPrice: 100}],
                    sources: [{rail: "lightrail", contactId: contact1.id}]
                });
                chai.assert.equal(resp.statusCode, 201, `resp.body=${JSON.stringify(resp.body)}`);

                chai.assert.equal(resp.body.tags.length, 1, `resp.body should have 1 tag: ${JSON.stringify(resp.body)}`);
                chai.assert.sameDeepMembers(resp.body.tags, [`contactId:${contact1.id}`], `tags=${resp.body.tags}`);
            });

            it("2nd contactId as source, doesn't get used", async () => {
                const contact2: Partial<Contact> = {id: "contact2"};
                const contact2Resp = await testUtils.testAuthedRequest<Contact>(router, "/v2/contacts", "POST", contact2);
                chai.assert.equal(contact2Resp.statusCode, 201, `contact2Resp.body=${JSON.stringify(contact2Resp.body)}`);

                const resp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", {
                    id: "checkout-2cid",
                    currency: "USD",
                    lineItems: [{unitPrice: 100}],
                    sources: [{rail: "lightrail", valueId: value1.id}, {rail: "lightrail", contactId: contact2.id}]
                });
                chai.assert.equal(resp.statusCode, 201, `resp.body=${JSON.stringify(resp.body)}`);

                chai.assert.equal(resp.body.tags.length, 2, `resp.body should have 2 tags: ${JSON.stringify(resp.body)}`);
                chai.assert.sameDeepMembers(resp.body.tags, [`contactId:${contact1.id}`, `contactId:${contact2.id}`], `tags=${resp.body.tags}`);
            });

            it("2nd unique value (attached to different contact) as source, doesn't get used", async () => {
                const newContact: Partial<Contact> = {id: generateId(5)};
                const newContactResp = await testUtils.testAuthedRequest<Contact>(router, "/v2/contacts", "POST", newContact);
                chai.assert.equal(newContactResp.statusCode, 201, `newContactResp.body=${JSON.stringify(newContactResp.body)}`);
                const newValue: Partial<Value> = {
                    id: generateId(5),
                    currency: "USD",
                    balance: 0,
                    contactId: newContact.id
                };
                const newValueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", newValue);
                chai.assert.equal(newValueResp.statusCode, 201, `newValueResp.body=${JSON.stringify(newValueResp)}`);

                const resp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", {
                    id: "checkout-2uq-attached",
                    currency: "USD",
                    lineItems: [{unitPrice: 100}],
                    sources: [{rail: "lightrail", valueId: value1.id}, {rail: "lightrail", valueId: newValue.id}]
                });
                chai.assert.equal(resp.statusCode, 201, `resp.body=${JSON.stringify(resp.body)}`);

                chai.assert.equal(resp.body.tags.length, 2, `resp.body should have 2 tags: ${JSON.stringify(resp.body)}`);
                chai.assert.sameDeepMembers(resp.body.tags, [`contactId:${contact1.id}`, `contactId:${newContact.id}`], `tags=${resp.body.tags}`);
            });

            it("contactId that doesn't exist as source", async () => {
                const resp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", {
                    id: "checkout-nonexistent-cid",
                    currency: "USD",
                    lineItems: [{unitPrice: 100}],
                    sources: [{rail: "lightrail", contactId: "gibberish"}, {rail: "lightrail", valueId: value1.id}]
                });
                chai.assert.equal(resp.statusCode, 201, `resp.body=${JSON.stringify(resp.body)}`);

                chai.assert.equal(resp.body.tags.length, 2, `resp.body should have 2 tags: ${JSON.stringify(resp.body)}`);
                chai.assert.sameDeepMembers(resp.body.tags, [`contactId:${contact1.id}`, `contactId:gibberish`], `tags=${resp.body.tags}`);
            });
        });

        describe("auto attach", () => {
            it("can create a checkout with auto-attaches", async () => {
                const newContact: Partial<Contact> = {id: `new-contact-${generateId(4)}`};
                const contactResp = await testUtils.testAuthedRequest<Contact>(router, "/v2/contacts", "POST", newContact);
                chai.assert.equal(contactResp.statusCode, 201, `contactResp.body=${JSON.stringify(contactResp)}`);

                const perContactValue1: Partial<Value> = {
                    id: "gen-val-per-contact-1",
                    currency: "USD",
                    isGenericCode: true,
                    genericCodeOptions: {
                        perContact: {
                            balance: 50,
                            usesRemaining: null
                        }
                    }
                };
                const v1SetupResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", perContactValue1);
                chai.assert.equal(v1SetupResp.statusCode, 201, `v1SetupResp.body=${JSON.stringify(v1SetupResp.body)}`);
                const perContactValue2: Partial<Value> = {
                    id: "gen-val-per-contact-2",
                    currency: "USD",
                    isGenericCode: true,
                    genericCodeOptions: {
                        perContact: {
                            balance: 50,
                            usesRemaining: null
                        }
                    }
                };
                const v2SetupResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", perContactValue2);
                chai.assert.equal(v2SetupResp.statusCode, 201, `v2SetupResp.body=${JSON.stringify(v2SetupResp.body)}`);

                const checkoutResp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", {
                    id: "checkout-w-auto-attach",
                    currency: "USD",
                    lineItems: [{unitPrice: 100}],
                    sources: [{
                        rail: "lightrail",
                        valueId: perContactValue1.id
                    }, {
                        rail: "lightrail",
                        valueId: perContactValue2.id
                    }, {
                        rail: "lightrail",
                        contactId: newContact.id
                    }]
                });
                chai.assert.equal(checkoutResp.statusCode, 201, `checkoutResp.body=${JSON.stringify(checkoutResp.body)}`);
                chai.assert.equal(checkoutResp.body.tags.length, 1, `checkoutResp.body should have 1 tag: ${JSON.stringify(checkoutResp.body)}`);
                chai.assert.sameDeepMembers(checkoutResp.body.tags, [`contactId:${newContact.id}`], `tags=${checkoutResp.body.tags}`);
            });
        });

        it("can create a checkout with a shared generic code", async () => {
            const sharedGeneric: Partial<Value> = {
                id: "shared-generic",
                isGenericCode: true,
                currency: "USD",
                balanceRule: {
                    rule: "1000",
                    explanation: "1000"
                },
                balance: null
            };
            await testUtils.createUSDValue(router, sharedGeneric);

            const newContact: Partial<Contact> = {id: `new-contact-${generateId(4)}`};
            const contactResp = await testUtils.testAuthedRequest<Contact>(router, "/v2/contacts", "POST", newContact);
            chai.assert.equal(contactResp.statusCode, 201, `contactResp.body=${JSON.stringify(contactResp)}`);

            const attachResp = await testUtils.testAuthedRequest<Value>(router, `/v2/contacts/${newContact.id}/values/attach`, "POST", {
                valueId: sharedGeneric.id
            });
            chai.assert.equal(attachResp.statusCode, 200, `attachResp.body=${JSON.stringify(attachResp.body)}`);

            const checkoutResp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", {
                id: "checkout-w-shared-generic",
                currency: "USD",
                lineItems: [{unitPrice: 100}],
                sources: [{
                    rail: "lightrail",
                    valueId: sharedGeneric.id
                }, {
                    rail: "lightrail",
                    contactId: newContact.id
                }]
            });
            chai.assert.equal(checkoutResp.statusCode, 201, `checkoutResp.body=${JSON.stringify(checkoutResp.body)}`);
            chai.assert.equal(checkoutResp.body.tags.length, 1, `checkoutResp.body should have 1 tag: ${JSON.stringify(checkoutResp.body)}`);
            chai.assert.sameDeepMembers(checkoutResp.body.tags, [`contactId:${newContact.id}`], `tags=${checkoutResp.body.tags}`);
        });
    });

    it("adds contactId tag when creating a credit transaction", async () => {
        const resp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/credit", "POST", {
            id: "credit",
            currency: "USD",
            amount: 100,
            destination: {
                rail: "lightrail",
                valueId: value2.id
            }
        });
        chai.assert.equal(resp.statusCode, 201, `resp.body=${JSON.stringify(resp.body)}`);
        chai.assert.equal(resp.body.tags.length, 1, `resp.body should have 1 tag: ${JSON.stringify(resp.body)}`);
        chai.assert.sameDeepMembers(resp.body.tags, [`contactId:${contact1.id}`], `tags=${resp.body.tags}`);
    });

    it("adds contactId tag when creating a debit transaction", async () => {
        const resp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/debit", "POST", {
            id: "debit",
            currency: "USD",
            amount: 100,
            source: {
                rail: "lightrail",
                valueId: value2.id
            }
        });
        chai.assert.equal(resp.statusCode, 201, `resp.body=${JSON.stringify(resp.body)}`);
        chai.assert.equal(resp.body.tags.length, 1, `resp.body should have 1 tag: ${JSON.stringify(resp.body)}`);
        chai.assert.sameDeepMembers(resp.body.tags, [`contactId:${contact1.id}`], `tags=${resp.body.tags}`);
    });

    it("adds contactId tag when creating a transfer transaction", async () => {
        const resp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/transfer", "POST", {
            id: "transfer",
            currency: "USD",
            amount: 100,
            source: {
                rail: "lightrail",
                valueId: value2.id
            },
            destination: {
                rail: "lightrail",
                valueId: value3.id
            }
        });
        chai.assert.equal(resp.statusCode, 201, `resp.body=${JSON.stringify(resp.body)}`);
        chai.assert.equal(resp.body.tags.length, 1, `resp.body should have 1 tag: ${JSON.stringify(resp.body)}`);
        chai.assert.sameDeepMembers(resp.body.tags, [`contactId:${contact1.id}`], `tags=${resp.body.tags}`);
    });

    it("can create a reverse transaction", async () => {
        const setupResp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", {
            id: "setup-checkout",
            currency: "USD",
            lineItems: [{unitPrice: 100}],
            sources: [{
                rail: "lightrail",
                valueId: value1.id
            }]
        });
        chai.assert.equal(setupResp.statusCode, 201, `setupResp.body=${JSON.stringify(setupResp.body)}`);

        const resp = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${setupResp.body.id}/reverse`, "POST", {
            id: "reverse"
        });
        chai.assert.equal(resp.statusCode, 201, `resp.body=${JSON.stringify(resp.body)}`);
    });

    it("can create a pending transaction", async () => {
        const resp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", {
            id: "pending",
            currency: "USD",
            lineItems: [{unitPrice: 100}],
            sources: [{
                rail: "lightrail",
                valueId: value1.id
            }],
            pending: true
        });
        chai.assert.equal(resp.statusCode, 201, `resp.body=${JSON.stringify(resp.body)}`);
    });

    it("can create a capture transaction", async () => {
        const setupResp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", {
            id: "pending-to-capture",
            currency: "USD",
            lineItems: [{unitPrice: 100}],
            sources: [{
                rail: "lightrail",
                valueId: value1.id
            }],
            pending: true
        });
        chai.assert.equal(setupResp.statusCode, 201, `setupResp.body=${JSON.stringify(setupResp.body)}`);

        const resp = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${setupResp.body.id}/capture`, "POST", {
            id: "capture"
        });
        chai.assert.equal(resp.statusCode, 201, `resp.body=${JSON.stringify(resp.body)}`);
    });

    it("can create a void transaction", async () => {
        const setupResp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", {
            id: "pending-to-void",
            currency: "USD",
            lineItems: [{unitPrice: 100}],
            sources: [{
                rail: "lightrail",
                valueId: value1.id
            }],
            pending: true
        });
        chai.assert.equal(setupResp.statusCode, 201, `setupResp.body=${JSON.stringify(setupResp.body)}`);

        const resp = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${setupResp.body.id}/void`, "POST", {
            id: "void"
        });
        chai.assert.equal(resp.statusCode, 201, `resp.body=${JSON.stringify(resp.body)}`);
    });

    it("adds contactId tag when creating a initialBalance transaction", async () => {
        const createValueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
            id: "value-with-initial-balance",
            contactId: contact1.id,
            balance: 100,
            currency: "USD"
        });
        chai.assert.equal(createValueResp.statusCode, 201, `createValueResp.body=${JSON.stringify(createValueResp.body)}`);

        const initialBalanceTxResp = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${createValueResp.body.id}`, "GET");
        chai.assert.equal(initialBalanceTxResp.statusCode, 200, `initialBalanceTxResp.body=${JSON.stringify(initialBalanceTxResp.body)}`);
        chai.assert.equal(initialBalanceTxResp.body.transactionType, "initialBalance", `initialBalanceTxResp.body=${JSON.stringify(initialBalanceTxResp.body)}`);
        chai.assert.sameDeepMembers(initialBalanceTxResp.body.tags, [`contactId:${contact1.id}`], `tags=${initialBalanceTxResp.body.tags}`);
    });

    it("adds contactId tag when attaching a generic value with perContact options", async () => {
        const valueToAttach: Partial<Value> = {
            id: "generic-value-per-contact-options",
            currency: "USD",
            isGenericCode: true,
            genericCodeOptions: {
                perContact: {
                    balance: 1000,
                    usesRemaining: null
                }
            }
        };
        const valueSetupResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", valueToAttach);
        chai.assert.equal(valueSetupResp.statusCode, 201, `valueSetupResp.body=${JSON.stringify(valueSetupResp.body)}`);

        const attachResp = await testUtils.testAuthedRequest<Value>(router, `/v2/contacts/${contact1.id}/values/attach`, "POST", {
            valueId: valueToAttach.id
        });
        chai.assert.equal(attachResp.statusCode, 200, `.body=${JSON.stringify(attachResp)}`);

        const txResp = await testUtils.testAuthedRequest<Transaction[]>(router, `/v2/transactions?transactionType=attach&valueId=${valueToAttach.id}`, "GET");
        chai.assert.equal(txResp.statusCode, 200, `txResp.body=${JSON.stringify(txResp.body)}`);
        chai.assert.equal(txResp.body.length, 1, `txResp.body should only have one transaction=${JSON.stringify(txResp.body)}`);
        chai.assert.equal(txResp.body[0].transactionType, "attach", `transactionType should be 'attach': ${txResp.body[0].transactionType}`);
        chai.assert.equal(txResp.body[0].tags.length, 1, `txResp.body[0] should have 1 tag: ${JSON.stringify(txResp.body[0])}`);
        chai.assert.sameDeepMembers(txResp.body[0].tags, [`contactId:${contact1.id}`], `tags=${txResp.body[0].tags}`);
    });

    describe("data isolation", () => {
        it("allows two users to create transactions with the same tags");
        it("maps the right tags to the right transactions - create; get");
    });
});
