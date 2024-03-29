import * as cassava from "cassava";
import * as chai from "chai";
import * as giftbitRoutes from "giftbit-cassava-routes";
import {Contact} from "../../model/Contact";
import {installRestRoutes} from "./installRestRoutes";
import * as testUtils from "../../utils/testUtils";
import {defaultTestUser, generateFullcode, generateId, setCodeCryptographySecrets} from "../../utils/testUtils";
import {createContact} from "./contacts";
import {Currency} from "../../model/Currency";
import {createCurrency} from "./currencies";
import {generateCode} from "../../utils/codeGenerator";
import chaiExclude from "chai-exclude";
import {getKnexWrite} from "../../utils/dbUtils/connection";
import {generateUrlSafeHashFromValueIdContactId} from "./genericCode";
import {generateLegacyHashForValueIdContactId, yervanaUserId} from "./contactValues";
import {nowInDbPrecision} from "../../utils/dbUtils";
import {updateValue} from "./values/values";
import {Value} from "../../model/Value";
import {TestUser} from "../../utils/testUtils/TestUser";

chai.use(chaiExclude);

describe("/v2/contacts/values", () => {

    const router = new cassava.Router();

    const currency: Currency = {
        code: "AUD",
        decimalPlaces: 2,
        symbol: "$",
        name: "Dollarydoo",
        createdDate: nowInDbPrecision(),
        updatedDate: nowInDbPrecision(),
        createdBy: testUtils.defaultTestUser.teamMemberId
    };

    const contact: Contact = {
        id: "c-1",
        firstName: null,
        lastName: null,
        email: null,
        metadata: null,
        createdDate: new Date(),
        updatedDate: new Date(),
        createdBy: defaultTestUser.auth.teamMemberId
    };

    before(async function () {
        await testUtils.resetDb();
        router.route(testUtils.authRoute);
        installRestRoutes(router);
        setCodeCryptographySecrets();
        await createCurrency(testUtils.defaultTestUser.auth, currency);
        await createContact(testUtils.defaultTestUser.auth, contact);
    });

    describe("unique values can be attached and detached using code or valueId", () => {
        const value: Partial<Value> = {
            id: "unique-value",
            currency: currency.code,
            code: generateFullcode(),
        };

        before(async () => {
            const createValueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
            chai.assert.equal(createValueResp.statusCode, 201, `body=${JSON.stringify(createValueResp.body)}`);
        });

        it("can attach by code", async () => {
            const attachResp = await testUtils.testAuthedRequest<Value>(router, `/v2/contacts/${contact.id}/values/attach`, "POST", {code: value.code});
            chai.assert.equal(attachResp.statusCode, 200, `body=${JSON.stringify(attachResp.body)}`);
            chai.assert.equal(attachResp.body.id, value.id);
            chai.assert.equal(attachResp.body.contactId, contact.id);
            chai.assert.equal(attachResp.body.code, `…${value.code.slice(-4)}`);
            chai.assert.isNotNull(attachResp.body.updatedContactIdDate);
            chai.assert.equal(attachResp.body.updatedContactIdDate, attachResp.body.updatedDate);
        });

        it("can attach by valueId", async () => {
            const attachResp = await testUtils.testAuthedRequest<Value>(router, `/v2/contacts/${contact.id}/values/attach`, "POST", {valueId: value.id});
            chai.assert.equal(attachResp.statusCode, 200, `body=${JSON.stringify(attachResp.body)}`);
            chai.assert.equal(attachResp.body.id, value.id);
            chai.assert.equal(attachResp.body.contactId, contact.id);
            chai.assert.equal(attachResp.body.code, `…${value.code.slice(-4)}`);
            chai.assert.isNotNull(attachResp.body.updatedContactIdDate);
            chai.assert.equal(attachResp.body.updatedContactIdDate, attachResp.body.updatedDate);
        });

        it("can detach", async () => {
            const detach = await testUtils.testAuthedRequest<any>(router, `/v2/contacts/${contact.id}/values/detach`, "POST", {valueId: value.id});
            chai.assert.equal(detach.statusCode, 200, `body=${JSON.stringify(detach.body)}`);
            chai.assert.isNull(detach.body.contactId);

            const getValue = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}`, "GET");
            chai.assert.equal(getValue.statusCode, 200);
            chai.assert.deepEqualExcluding(detach.body, getValue.body, ["updatedContactIdDate", "updatedDate"]);
        });

        it("can re-attach", async () => {
            const reattach = await testUtils.testAuthedRequest<any>(router, `/v2/contacts/${contact.id}/values/attach`, "POST", {valueId: value.id});
            chai.assert.equal(reattach.statusCode, 200, `body=${JSON.stringify(reattach.body)}`);
            chai.assert.isNotNull(reattach.body.contactId);
        });
    });

    describe("generic-code with the PerContact properties scenario", () => {
        const value: Partial<Value> = {
            id: generateId(),
            currency: currency.code,
            balanceRule: {
                rule: "500",
                explanation: "$5 done the hard way"
            }, genericCodeOptions: {
                perContact: {
                    balance: null,
                    usesRemaining: 1
                }
            },
            code: generateFullcode(),
            isGenericCode: true,
            usesRemaining: 20
        };

        before(async () => {
            const createValue = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
            chai.assert.equal(createValue.statusCode, 201, `body=${JSON.stringify(createValue.body)}`);
        });

        it("can attach", async () => {
            const attach = await testUtils.testAuthedRequest<any>(router, `/v2/contacts/${contact.id}/values/attach`, "POST", {valueId: value.id});
            chai.assert.equal(attach.statusCode, 200, `body=${JSON.stringify(attach.body)}`);
        });

        it("can detach", async () => {
            const detach = await testUtils.testAuthedRequest<any>(router, `/v2/contacts/${contact.id}/values/detach`, "POST", {valueId: value.id});
            chai.assert.equal(detach.statusCode, 200, `body=${JSON.stringify(detach.body)}`);
            chai.assert.equal(detach.body.contactId, null);

            const getContactValues = await testUtils.testAuthedRequest<Value[]>(router, `/v2/contacts/${contact.id}/values?id=${value.id}`, "GET");
            chai.assert.equal(getContactValues.statusCode, 200);
            chai.assert.notInclude(getContactValues.body.map(v => v.id), detach.body.valueId);
        });

        it("can re-attach", async () => {
            const reattach = await testUtils.testAuthedRequest<any>(router, `/v2/contacts/${contact.id}/values/attach`, "POST", {valueId: value.id});
            chai.assert.equal(reattach.statusCode, 200, `body=${JSON.stringify(reattach.body)}`);
            chai.assert.isNotNull(reattach.body.contactId);
        });
    });

    describe("generic code attached before June 26, 2019", () => {
        const genericCode: Partial<Value> = {
            id: "genericCodeId54321",
            currency: currency.code,
            code: generateCode({}),
            isGenericCode: true,
            balanceRule: {
                rule: "500 + value.balanceChange",
                explanation: "five bucks"
            }
        };
        const contact: Partial<Contact> = {
            id: "contactId54321"
        };

        const attachedValue: Partial<Value> = {
            id: generateLegacyHashForValueIdContactId(genericCode.id, contact.id),
            currency: genericCode.currency,
            balanceRule: genericCode.balanceRule,
            contactId: contact.id,
            usesRemaining: 1
        };

        before(async () => {
            const createCode = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", genericCode);
            chai.assert.equal(createCode.statusCode, 201);

            const knex = await getKnexWrite();
            await knex.transaction(async trx => {
                const updateRes: number = await trx("Values")
                    .where({
                        userId: testUtils.defaultTestUser.userId,
                        id: genericCode.id
                    })
                    .update({
                        createdDate: "2019-06-15 00:00:00.000"
                    });
                if (updateRes === 0) {
                    throw new cassava.RestError(404);
                }
                if (updateRes > 1) {
                    throw new Error(`Illegal UPDATE query.  Updated ${updateRes} values.`);
                }
            });
            const getGenericCode = await testUtils.testAuthedRequest<any>(router, `/v2/values/${encodeURI(genericCode.id)}`, "GET");
            chai.assert.equal(getGenericCode.statusCode, 200);
            chai.assert.equal(getGenericCode.body.createdDate, "2019-06-15T00:00:00.000Z");

            const createContact = await testUtils.testAuthedRequest<Value>(router, "/v2/contacts", "POST", contact);
            chai.assert.equal(createContact.statusCode, 201);

            const attach = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", attachedValue);
            chai.assert.equal(attach.statusCode, 201);

            // manually set attachedFromValueId
            await knex.transaction(async trx => {
                const updateRes: number = await trx("Values")
                    .where({
                        userId: testUtils.defaultTestUser.userId,
                        id: attachedValue.id
                    })
                    .update({
                        attachedFromValueId: genericCode.id,
                        createdDate: "2019-06-15 00:00:00.000"
                    });
                if (updateRes === 0) {
                    throw new cassava.RestError(404);
                }
                if (updateRes > 1) {
                    throw new Error(`Illegal UPDATE query.  Updated ${updateRes} values.`);
                }
            });

            const get = await testUtils.testAuthedRequest<any>(router, `/v2/values/${encodeURI(attachedValue.id)}`, "GET");
            chai.assert.equal(get.statusCode, 200);
            chai.assert.equal(get.body.createdDate, "2019-06-15T00:00:00.000Z");
            chai.assert.equal(get.body.attachedFromValueId, genericCode.id);
        });


        it("can detach", async () => {
            const detach = await testUtils.testAuthedRequest<any>(router, `/v2/contacts/${contact.id}/values/detach`, "POST", {valueId: genericCode.id});
            chai.assert.equal(detach.statusCode, 200, `body=${JSON.stringify(detach.body)}`);
            chai.assert.isNull(detach.body.contactId);

            const getContactValues = await testUtils.testAuthedRequest<Value[]>(router, `/v2/contacts/${contact.id}/values`, "GET");
            chai.assert.equal(getContactValues.statusCode, 200);
            chai.assert.notInclude(getContactValues.body.map(v => v.id), genericCode.id);
        });

        it("can re-attach", async () => {
            const reattach = await testUtils.testAuthedRequest<Value>(router, `/v2/contacts/${contact.id}/values/attach`, "POST", {valueId: genericCode.id});
            chai.assert.equal(reattach.statusCode, 200, `body=${JSON.stringify(reattach.body)}`);
            chai.assert.isNotNull(reattach.body.contactId);
            chai.assert.equal(reattach.body.attachedFromValueId, genericCode.id);
            chai.assert.equal(reattach.body.id, attachedValue.id, "The Id should resolve to the same Id that would have been generated before June 26, 2019.");
        });
    });

    describe("generic code with per contact property using generateUrlSafeHashFromValueIdContactId", () => {
        const value: Partial<Value> = {
            id: generateId(),
            currency: currency.code,
            isGenericCode: true,
            genericCodeOptions: {
                perContact: {
                    balance: null,
                    usesRemaining: 1
                }
            },
            balanceRule: {
                rule: "500 + value.balanceChange",
                explanation: "$5.00 off order"
            },
        };

        before(async () => {
            const createValue = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
            chai.assert.equal(createValue.statusCode, 201, `body=${JSON.stringify(createValue.body)}`);

            const knex = await getKnexWrite();
            const res: number = await knex("Values")
                .where({
                    userId: testUtils.defaultTestUser.userId,
                    id: value.id,
                })
                .update(await Value.toDbValue(testUtils.defaultTestUser.auth, {
                    ...createValue.body,
                    createdDate: new Date("2019-04-04"),
                    updatedDate: new Date("2019-04-04")
                }));
            if (res === 0) {
                chai.assert.fail(`no row updated. test is broken`);
            }

            const updatedValue = await testUtils.testAuthedRequest<Value[]>(router, "/v2/values", "GET");
            chai.assert.equal(updatedValue.statusCode, 200);
        });

        it("can attach", async () => {
            const attach = await testUtils.testAuthedRequest<any>(router, `/v2/contacts/${contact.id}/values/attach`, "POST", {valueId: value.id});
            chai.assert.equal(attach.statusCode, 200, `body=${JSON.stringify(attach.body)}`);
            chai.assert.equal(attach.body.id, generateUrlSafeHashFromValueIdContactId(value.id, contact.id));
        });

        it("can detach", async () => {
            const detach = await testUtils.testAuthedRequest<any>(router, `/v2/contacts/${contact.id}/values/detach`, "POST", {valueId: value.id});
            chai.assert.equal(detach.statusCode, 200, `body=${JSON.stringify(detach.body)}`);
            chai.assert.isNull(detach.body.contactId);

            const getContactValues = await testUtils.testAuthedRequest<Value[]>(router, `/v2/contacts/${contact.id}/values`, "GET");
            chai.assert.equal(getContactValues.statusCode, 200);
            chai.assert.notInclude(getContactValues.body.map(v => v.id), value.id);
        });

        it("can re-attach", async () => {
            const reattach = await testUtils.testAuthedRequest<any>(router, `/v2/contacts/${contact.id}/values/attach`, "POST", {valueId: value.id});
            chai.assert.equal(reattach.statusCode, 200, `body=${JSON.stringify(reattach.body)}`);
            chai.assert.isNotNull(reattach.body.contactId);
        });
    });

    describe("can attach and detach a generic code but can't re-attach if the value is frozen after detach", () => {
        const value: Partial<Value> = {
            id: generateId(),
            currency: currency.code,
            balanceRule: {
                rule: "500",
                explanation: "$5 done the hard way"
            }, genericCodeOptions: {
                perContact: {
                    balance: null,
                    usesRemaining: 1
                }
            },
            code: generateFullcode(),
            isGenericCode: true,
            usesRemaining: 20
        };

        before(async () => {
            const createValue = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
            chai.assert.equal(createValue.statusCode, 201, `body=${JSON.stringify(createValue.body)}`);
        });

        it("can attach", async () => {
            const attach = await testUtils.testAuthedRequest<any>(router, `/v2/contacts/${contact.id}/values/attach`, "POST", {valueId: value.id});
            chai.assert.equal(attach.statusCode, 200, `body=${JSON.stringify(attach.body)}`);
        });

        it("can detach", async () => {
            const detach = await testUtils.testAuthedRequest<any>(router, `/v2/contacts/${contact.id}/values/detach`, "POST", {valueId: value.id});
            chai.assert.equal(detach.statusCode, 200, `body=${JSON.stringify(detach.body)}`);
            chai.assert.isNull(detach.body.contactId);

            const getContactValues = await testUtils.testAuthedRequest<Value[]>(router, `/v2/contacts/${contact.id}/values?id=${value.id}`, "GET");
            chai.assert.equal(getContactValues.statusCode, 200);
            chai.assert.notInclude(getContactValues.body.map(v => v.id), detach.body.valueId);
        });

        it("can't re-attach", async () => {

            const now = nowInDbPrecision();
            await updateValue(testUtils.defaultTestUser.auth, value.id, {
                frozen: true,
                updatedDate: now,
                updatedContactIdDate: now
            });
            const reattach = await testUtils.testAuthedRequest<Value>(router, `/v2/contacts/${contact.id}/values/attach`, "POST", {code: value.code});
            chai.assert.equal(reattach.statusCode, 409, `ValueFrozen`);
        });
    });

    const contact2: Contact = {
        id: "c-2",
        firstName: null,
        lastName: null,
        email: null,
        metadata: null,
        createdDate: new Date(),
        updatedDate: new Date(),
        createdBy: defaultTestUser.auth.teamMemberId
    };

    describe("attach behaviour for unique code based on JWT", function () {
        const value: Partial<Value> = {
            id: generateId(),
            currency: currency.code,
            code: generateFullcode(),
        };

        before(async () => {
            const createValueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
            chai.assert.equal(createValueResp.statusCode, 201, `body=${JSON.stringify(createValueResp.body)}`);

            const attachResp = await testUtils.testAuthedRequest<Value>(router, `/v2/contacts/${contact.id}/values/attach`, "POST", {code: value.code});
            chai.assert.equal(attachResp.statusCode, 200, `body=${JSON.stringify(attachResp.body)}`);
        });

        it("cannot attach an already attached value using a token scoped to a Contact", async () => {
            await createContact(testUtils.defaultTestUser.auth, contact2);
            const contact2Badge = new giftbitRoutes.jwtauth.AuthorizationBadge(testUtils.defaultTestUser.auth.getJwtPayload());
            contact2Badge.contactId = contact2.id;
            contact2Badge.scopes.push("lightrailV2:values:attach:self");

            const resp = await cassava.testing.testRouter(router, cassava.testing.createTestProxyEvent(`/v2/contacts/${contact2.id}/values/attach`, "POST", {
                headers: {
                    Authorization: `Bearer ${contact2Badge.sign("secret")}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({code: value.code})
            }));
            chai.assert.equal(resp.statusCode, 409, `body=${resp.body}`);
            chai.assert.equal(JSON.parse(resp.body).messageCode, "ValueNotFound", `body=${resp.body}`);
        });

        it("can attach an already attached value using a plain JWT", async () => {
            const resp = await testUtils.testAuthedRequest<Value>(router, `/v2/contacts/${contact2.id}/values/attach`, "POST", {code: value.code});
            chai.assert.equal(resp.statusCode, 200, `body=${JSON.stringify(resp.body)}`);
            chai.assert.equal(resp.body.id, value.id);
            chai.assert.equal(resp.body.contactId, contact2.id);
            chai.assert.equal(resp.body.code, `…${value.code.slice(-4)}`);
            chai.assert.isNotNull(resp.body.updatedContactIdDate);
            chai.assert.equal(resp.body.updatedContactIdDate, resp.body.updatedDate);
        });
    });

    describe("attach Value in state cases: frozen, cancelled, expired, inactive, usesRemaining=0", function () {
        for (const isGenericCode of [true, false]) {
            it(`cannot attach a frozen isGeneric=${isGenericCode} Value`, async () => {
                const value: Partial<Value> = {
                    id: generateId(),
                    currency: currency.code,
                    isGenericCode: isGenericCode,
                    balanceRule: {
                        rule: "500 + value.balanceChange",
                        explanation: "$5 off"
                    }
                };
                const createValue = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
                chai.assert.equal(createValue.statusCode, 201, `body=${JSON.stringify(createValue.body)}`);

                const update: Partial<Value> = {
                    frozen: true
                };
                const patchUpdate = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}`, "PATCH", update);
                chai.assert.equal(patchUpdate.statusCode, 200, `body=${JSON.stringify(patchUpdate.body)}`);

                const attach = await testUtils.testAuthedRequest<any>(router, `/v2/contacts/${contact.id}/values/attach`, "POST", {valueId: value.id});
                chai.assert.equal(attach.statusCode, 409, `body=${JSON.stringify(attach.body)}`);
                chai.assert.equal(attach.body.messageCode, "ValueFrozen");
            });

            it(`cannot attach a canceled isGeneric=${isGenericCode} Value`, async () => {
                const value: Partial<Value> = {
                    id: generateId(),
                    currency: currency.code,
                    isGenericCode: isGenericCode,
                    balanceRule: {
                        rule: "500 + value.balanceChange",
                        explanation: "$5 off"
                    }
                };
                const createValue = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
                chai.assert.equal(createValue.statusCode, 201, `body=${JSON.stringify(createValue.body)}`);

                const update: Partial<Value> = {
                    canceled: true
                };
                const patchUpdate = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}`, "PATCH", update);
                chai.assert.equal(patchUpdate.statusCode, 200, `body=${JSON.stringify(patchUpdate.body)}`);

                const attach = await testUtils.testAuthedRequest<any>(router, `/v2/contacts/${contact.id}/values/attach`, "POST", {valueId: value.id});
                chai.assert.equal(attach.statusCode, 409, `body=${JSON.stringify(attach.body)}`);
                chai.assert.equal(attach.body.messageCode, "ValueCanceled");
            });

            it(`can attach if currentDate < startDate isGeneric=${isGenericCode} Value`, async () => {
                const value: Partial<Value> = {
                    id: generateId(),
                    currency: currency.code,
                    isGenericCode: isGenericCode,
                    balanceRule: {
                        rule: "500 + value.balanceChange",
                        explanation: "$5 off"
                    },
                    startDate: new Date("2077-01-01")
                };
                const createValue = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
                chai.assert.equal(createValue.statusCode, 201, `body=${JSON.stringify(createValue.body)}`);

                const attach = await testUtils.testAuthedRequest<any>(router, `/v2/contacts/${contact.id}/values/attach`, "POST", {valueId: value.id});
                chai.assert.equal(attach.statusCode, 200, `body=${JSON.stringify(attach.body)}`);
            });

            it(`cannot attach if currentDate > endDate isGeneric=${isGenericCode} Value`, async () => {
                const value: Partial<Value> = {
                    id: generateId(),
                    currency: currency.code,
                    isGenericCode: isGenericCode,
                    balanceRule: {
                        rule: "500 + value.balanceChange",
                        explanation: "$5 off"
                    },
                    endDate: new Date("2011-01-01")
                };
                const createValue = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
                chai.assert.equal(createValue.statusCode, 201, `body=${JSON.stringify(createValue.body)}`);

                const attach = await testUtils.testAuthedRequest<any>(router, `/v2/contacts/${contact.id}/values/attach`, "POST", {valueId: value.id});
                chai.assert.equal(attach.statusCode, 409, `body=${JSON.stringify(attach.body)}`);
                chai.assert.equal(attach.body.messageCode, "ValueExpired");
            });
        }
    });

    describe("can list values attached to a contact and contacts who've attach a value", () => {
        let data: AttachedContactValueScenario;
        before(async () => {
            data = await setupAttachedContactValueScenario(router, currency);
        });

        it("can list contacts associated with unique code", async () => {
            const contactListValues = await testUtils.testAuthedRequest<Contact[]>(router, `/v2/contacts?valueId=${data.uniqueValueWithContact.id}`, "GET");
            chai.assert.sameDeepMembers(contactListValues.body, data.contacts.filter(contact => contact.id === data.uniqueValueWithContact.contactId));
        });

        it("can list values attached to contactA", async () => {
            const contactListValues = await testUtils.testAuthedRequest<Value[]>(router, `/v2/contacts/${data.contactA.id}/values`, "GET");
            chai.assert.sameDeepMembers(contactListValues.body, data.valuesAttachedToContactA);

            const listValuesByContact = await testUtils.testAuthedRequest<Value[]>(router, `/v2/values?contactId=${data.contactA.id}`, "GET");
            chai.assert.sameDeepMembers(listValuesByContact.body, data.valuesAttachedToContactA);

            const listValuesByContactUsingDotEq = await testUtils.testAuthedRequest<Value[]>(router, `/v2/values?contactId.eq=${data.contactA.id}`, "GET");
            chai.assert.sameDeepMembers(listValuesByContactUsingDotEq.body, data.valuesAttachedToContactA);

            const listValuesByContactAndIsGenericCodeFalse = await testUtils.testAuthedRequest<Value[]>(router, `/v2/values?contactId=${data.contactA.id}&isGenericCode=false`, "GET");
            chai.assert.sameDeepMembers(listValuesByContactAndIsGenericCodeFalse.body, data.valuesAttachedToContactA.filter(v => v.isGenericCode === false));

            const listValuesByContactAndIsGenericCodeTrue = await testUtils.testAuthedRequest<Value[]>(router, `/v2/values?contactId=${data.contactA.id}&isGenericCode=true`, "GET");
            chai.assert.sameDeepMembers(listValuesByContactAndIsGenericCodeTrue.body, data.valuesAttachedToContactA.filter(v => v.isGenericCode === true));

            const listValuesByContactAndIsCode = await testUtils.testAuthedRequest<Value[]>(router, `/v2/values?contactId=${data.contactA.id}&code=${data.genVal1_genericValue.code}`, "GET");
            chai.assert.sameDeepMembers(listValuesByContactAndIsCode.body, data.valuesAttachedToContactA.filter(v => v.id === data.genVal1_genericValue.id));
        });

        it("can list values attached to contactB", async () => {
            const contactListValues = await testUtils.testAuthedRequest<Value[]>(router, `/v2/contacts/${data.contactB.id}/values`, "GET");
            chai.assert.sameDeepMembers(contactListValues.body, data.valuesAttachedToContactB);

            const listValuesByContact = await testUtils.testAuthedRequest<Value[]>(router, `/v2/values?contactId=${data.contactB.id}`, "GET");
            chai.assert.sameDeepMembers(listValuesByContact.body, data.valuesAttachedToContactB);
        });

        it("can list contacts who have attached genVal1 but returns none since genericValue1 was attached as new Values", async () => {
            const contactListValues = await testUtils.testAuthedRequest<Contact[]>(router, `/v2/contacts?valueId=${data.genVal1_genericValue.id}`, "GET");
            chai.assert.sameDeepMembers(contactListValues.body, data.contacts);
        });

        it("can list contacts who have attached genVal2", async () => {
            const contactListValues = await testUtils.testAuthedRequest<Contact[]>(router, `/v2/contacts?valueId=${data.genVal2_genericValue.id}`, "GET");
            chai.assert.sameDeepMembers(contactListValues.body, data.contacts);
        });
    });

    describe("detach error handling", () => {

        it("can't detach a Value that a Contact doesn't have attached", async () => {
            const value: Partial<Value> = {
                id: generateId(),
                currency: currency.code,
            };
            const createValue = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
            chai.assert.equal(createValue.statusCode, 201, `body=${JSON.stringify(createValue.body)}`);

            const detach = await testUtils.testAuthedRequest<any>(router, `/v2/contacts/${contact.id}/values/detach`, "POST", {valueId: value.id});
            chai.assert.equal(detach.statusCode, 409, `body=${JSON.stringify(detach.body)}`);
            chai.assert.equal(detach.body.messageCode, "AttachedValueNotFound");
        });

        it("can't detach a Generic Value that a Contact doesn't have attached", async () => {
            const value: Partial<Value> = {
                id: generateId(),
                currency: currency.code,
                isGenericCode: true,
                balanceRule: {
                    rule: "1",
                    explanation: "$0.01 off everything!"
                }
            };
            const createValue = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
            chai.assert.equal(createValue.statusCode, 201, `body=${JSON.stringify(createValue.body)}`);

            const detach = await testUtils.testAuthedRequest<any>(router, `/v2/contacts/${contact.id}/values/detach`, "POST", {valueId: value.id});
            chai.assert.equal(detach.statusCode, 409, `body=${JSON.stringify(detach.body)}`);
            chai.assert.equal(detach.body.messageCode, "AttachedValueNotFound");
        });

        it("can't detach frozen Values", async () => {
            const value: Partial<Value> = {
                id: generateId(),
                currency: currency.code
            };
            const createValue = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
            chai.assert.equal(createValue.statusCode, 201, `body=${JSON.stringify(createValue.body)}`);

            const attach = await testUtils.testAuthedRequest<any>(router, `/v2/contacts/${contact.id}/values/attach`, "POST", {valueId: value.id});
            chai.assert.equal(attach.statusCode, 200, `body=${JSON.stringify(attach.body)}`);

            const freeze = await testUtils.testAuthedRequest<any>(router, `/v2/values/${value.id}`, "PATCH", {frozen: true});
            chai.assert.equal(freeze.statusCode, 200, `body=${JSON.stringify(attach.body)}`);

            const detach = await testUtils.testAuthedRequest<any>(router, `/v2/contacts/${contact.id}/values/detach`, "POST", {valueId: value.id});
            chai.assert.equal(detach.statusCode, 409, `body=${JSON.stringify(detach.body)}`);
            chai.assert.equal(detach.body.messageCode, "ValueFrozen");
        });

        it("can detach canceled Values", async () => {
            const value: Partial<Value> = {
                id: generateId(),
                currency: currency.code
            };
            const createValue = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
            chai.assert.equal(createValue.statusCode, 201, `body=${JSON.stringify(createValue.body)}`);

            const attach = await testUtils.testAuthedRequest<any>(router, `/v2/contacts/${contact.id}/values/attach`, "POST", {valueId: value.id});
            chai.assert.equal(attach.statusCode, 200, `body=${JSON.stringify(attach.body)}`);

            const cancel = await testUtils.testAuthedRequest<any>(router, `/v2/values/${value.id}`, "PATCH", {canceled: true});
            chai.assert.equal(cancel.statusCode, 200, `body=${JSON.stringify(attach.body)}`);

            const detach = await testUtils.testAuthedRequest<any>(router, `/v2/contacts/${contact.id}/values/detach`, "POST", {valueId: value.id});
            chai.assert.equal(detach.statusCode, 200, `body=${JSON.stringify(detach.body)}`);
        });
    });

    describe("yervana attachGenericAsNewValue support", () => {
        const yervanaUsers = [new TestUser({userId: yervanaUserId}), new TestUser({userId: yervanaUserId + "-TEST"})];

        for (const yervana of yervanaUsers) {
            it("can call attach with attachGenericAsNewValue - will also migrate generic code if it doesn't have perContact properties", async () => {
                await createCurrency(yervana.auth, currency);
                const contact = await yervana.request<Contact>(router, `/v2/contacts`, "POST", {id: generateId()});

                const genericCode: Partial<Value> = {
                    id: generateId(),
                    currency: currency.code,
                    isGenericCode: true,
                    balanceRule: {
                        rule: "1",
                        explanation: "$0.01 off every item!"
                    }
                };
                const createGenericCode = await yervana.request<Value>(router, `/v2/values`, "POST", genericCode);
                chai.assert.equal(createGenericCode.statusCode, 201);

                const attach = await yervana.request<Value>(router, `/v2/contacts/${contact.body.id}/values/attach`, "POST", {
                    valueId: genericCode.id,
                    attachGenericAsNewValue: true
                });
                chai.assert.notEqual(attach.statusCode, 422, "attachGenericAsNewValue is only allowed in attach schema for yervana");
                chai.assert.equal(attach.statusCode, 200);

                const genericCodeAfterAttach = await yervana.request<Value>(router, `/v2/values/${genericCode.id}`, "GET");
                chai.assert.equal(genericCodeAfterAttach.statusCode, 200);
                chai.assert.deepEqualExcluding(genericCodeAfterAttach.body, {
                    ...createGenericCode.body,
                    genericCodeOptions: {
                        perContact: {
                            usesRemaining: 1,
                            balance: null
                        }
                    }
                }, ["updatedDate"]);
            });
        }
    });
});

export interface AttachedContactValueScenario {
    contactA: Partial<Contact>;
    contactB: Partial<Contact>;
    contacts: Contact[];
    valuesAttachedToContactA: Value[];
    valuesAttachedToContactB: Value[];
    uniqueValueWithContact: Partial<Value>;
    uniqueValue: Partial<Value>;
    genVal1_genericValue: Partial<Value>;
    genVal2_genericValue: Partial<Value>;
    genVal3_perContactProperties: Partial<Value>;
}

export async function setupAttachedContactValueScenario(router: cassava.Router, currency: Currency): Promise<AttachedContactValueScenario> {
    const contactAId = generateId(5) + "A";
    const data: AttachedContactValueScenario = {
        contactA: {
            id: contactAId,
            firstName: "A",
        },
        contactB: {
            id: generateId(5) + "B",
            firstName: "B",
        },
        contacts: [],
        valuesAttachedToContactA: [],
        valuesAttachedToContactB: [],
        uniqueValueWithContact: {
            id: generateId(5) + "unique-belongsToA",
            currency: currency.code,
            contactId: contactAId
        },
        uniqueValue: {
            id: generateId(5) + "-unique-attachToA",
            currency: currency.code,
        },
        genVal1_genericValue: {
            id: generateId(5) + "-GEN1",
            currency: currency.code,
            code: generateCode({}),
            isGenericCode: true,
            balanceRule: {
                rule: "500 + value.balanceChange",
                explanation: "$5 off"
            }
        },
        genVal2_genericValue: {
            id: generateId(5) + "-GEN2",
            currency: currency.code,
            isGenericCode: true,
            balanceRule: {
                rule: "500 + value.balanceChange",
                explanation: "$5 off"
            }
        },
        genVal3_perContactProperties: {
            id: generateId(5) + "-GEN3",
            currency: currency.code,
            isGenericCode: true,
            genericCodeOptions: {
                perContact: {
                    balance: null,
                    usesRemaining: 1
                }
            },
            balanceRule: {
                rule: "500 + value.balanceChange",
                explanation: "$5 off"
            }
        }
    };

    const createContactA = await testUtils.testAuthedRequest<Contact>(router, `/v2/contacts`, "POST", data.contactA);
    chai.assert.equal(createContactA.statusCode, 201);
    data.contacts.push(createContactA.body);
    const createContactB = await testUtils.testAuthedRequest<Contact>(router, `/v2/contacts`, "POST", data.contactB);
    chai.assert.equal(createContactB.statusCode, 201);
    data.contacts.push(createContactB.body);

    // create genericVal1
    const createGenericVal1 = await testUtils.testAuthedRequest<Value>(router, `/v2/values`, "POST", data.genVal1_genericValue);
    chai.assert.equal(createGenericVal1.statusCode, 201);

    // create a genericVal2
    const createGenVal2 = await testUtils.testAuthedRequest<Value>(router, `/v2/values`, "POST", data.genVal2_genericValue);
    chai.assert.equal(createGenVal2.statusCode, 201);
    chai.assert.isNull(createGenVal2.body.genericCodeOptions);

    // create a genericVal3
    const createGenVal3 = await testUtils.testAuthedRequest<Value>(router, `/v2/values`, "POST", data.genVal3_perContactProperties);
    chai.assert.equal(createGenVal3.statusCode, 201);
    chai.assert.deepEqual(createGenVal3.body.genericCodeOptions, data.genVal3_perContactProperties.genericCodeOptions);

    /** ContactA Attached Values **/
        // unique value created with contactId set to ContactA
    const createUniqueValueWithContact = await testUtils.testAuthedRequest<Value>(router, `/v2/values`, "POST", data.uniqueValueWithContact);
    chai.assert.equal(createUniqueValueWithContact.statusCode, 201);
    data.valuesAttachedToContactA.push(createUniqueValueWithContact.body);

    // attach unique value to ContactA
    const createUniqueValue = await testUtils.testAuthedRequest<Value>(router, `/v2/values`, "POST", data.uniqueValue);
    chai.assert.equal(createUniqueValue.statusCode, 201);

    const attachUniqueValue = await testUtils.testAuthedRequest<Value>(router, `/v2/contacts/${data.contactA.id}/values/attach`, "POST", {valueId: data.uniqueValue.id});
    chai.assert.equal(attachUniqueValue.statusCode, 200);
    data.valuesAttachedToContactA.push(attachUniqueValue.body);

    // attach genericVal1 to ContactA
    const attachNew_genVal1_contactA = await testUtils.testAuthedRequest<Value>(router, `/v2/contacts/${data.contactA.id}/values/attach`, "POST", {
        valueId: data.genVal1_genericValue.id
    });
    chai.assert.equal(attachNew_genVal1_contactA.statusCode, 200);
    data.valuesAttachedToContactA.push(attachNew_genVal1_contactA.body /* new value from attach */);

    // attach genVal2 to ContactA
    const attach_genVal2_contactA = await testUtils.testAuthedRequest<Value>(router, `/v2/contacts/${data.contactA.id}/values/attach`, "POST", {valueId: data.genVal2_genericValue.id});
    chai.assert.equal(attach_genVal2_contactA.statusCode, 200);
    data.valuesAttachedToContactA.push(attach_genVal2_contactA.body);

    // attach genVal3 to ContactA
    const attach_genVal3_contactA = await testUtils.testAuthedRequest<Value>(router, `/v2/contacts/${data.contactA.id}/values/attach`, "POST", {valueId: data.genVal3_perContactProperties.id});
    chai.assert.equal(attach_genVal3_contactA.statusCode, 200);
    data.valuesAttachedToContactA.push(attach_genVal3_contactA.body /* new value attached with per contact properties */);

    /** ContactB Attached Values **/
    const attach_genVal1_contactB = await testUtils.testAuthedRequest<Value>(router, `/v2/contacts/${data.contactB.id}/values/attach`, "POST", {
        valueId: data.genVal1_genericValue.id,
    });
    chai.assert.equal(attach_genVal1_contactB.statusCode, 200);
    data.valuesAttachedToContactB.push(attach_genVal1_contactB.body /* new value from attach */);

    const attach_genVal2_contactB = await testUtils.testAuthedRequest<Value>(router, `/v2/contacts/${data.contactB.id}/values/attach`, "POST", {valueId: data.genVal2_genericValue.id});
    chai.assert.equal(attach_genVal2_contactB.statusCode, 200);
    data.valuesAttachedToContactB.push(attach_genVal2_contactB.body);

    return data;
}
