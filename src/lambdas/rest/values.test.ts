import * as cassava from "cassava";
import * as chai from "chai";
import * as giftbitRoutes from "giftbit-cassava-routes";
import * as parseLinkHeader from "parse-link-header";
import * as testUtils from "../../testUtils";
import {defaultTestUser} from "../../testUtils";
import {DbValue, Value} from "../../model/Value";
import {Currency} from "../../model/Currency";
import {Contact} from "../../model/Contact";
import {getKnexRead, getKnexWrite} from "../../dbUtils/connection";
import {codeLastFour} from "../../model/DbCode";
import {LightrailTransactionStep, Transaction} from "../../model/Transaction";
import {installRestRoutes} from "./installRestRoutes";
import {computeLookupHash, decrypt} from "../../codeCryptoUtils";
import {createCurrency} from "./currencies";
import chaiExclude = require("chai-exclude");

chai.use(chaiExclude);

describe("/v2/values/", () => {

    const router = new cassava.Router();

    before(async function () {
        await testUtils.resetDb();
        router.route(new giftbitRoutes.jwtauth.JwtAuthorizationRoute(Promise.resolve({secretkey: "secret"})));
        installRestRoutes(router);
        await createCurrency(testUtils.defaultTestUser.auth, {
            code: "USD",
            name: "The Big Bucks",
            symbol: "$",
            decimalPlaces: 2
        });
    });

    it("can list 0 values", async () => {
        const resp = await testUtils.testAuthedRequest<Value[]>(router, "/v2/values", "GET");
        chai.assert.equal(resp.statusCode, 200);
        chai.assert.deepEqual(resp.body, []);
        chai.assert.equal(resp.headers["Limit"], "100");
        chai.assert.equal(resp.headers["Max-Limit"], "1000");
    });

    it("can list 0 values in csv", async () => {
        const resp = await testUtils.testAuthedCsvRequest<Value>(router, "/v2/values", "GET");
        chai.assert.equal(resp.statusCode, 200);
        chai.assert.deepEqual(resp.body, []);
        chai.assert.equal(resp.headers["Limit"], "100");
        chai.assert.equal(resp.headers["Max-Limit"], "1000");
    });

    let value1: Partial<Value> = {
        id: "1",
        currency: "USD",
        balance: 0
    };

    it("cannot create a value with missing currency", async () => {
        let valueWithMissingCurrency: Partial<Value> = {
            id: "1",
            currency: "IDK",
            balance: 0
        };

        const resp = await testUtils.testAuthedRequest<any>(router, "/v2/values", "POST", valueWithMissingCurrency);
        chai.assert.equal(resp.statusCode, 409, `body=${JSON.stringify(resp.body)}`);
        chai.assert.equal(resp.body.messageCode, "CurrencyNotFound");
    });

    it("can create a value with no code, no contact, no program", async () => {
        const resp2 = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value1);
        chai.assert.equal(resp2.statusCode, 201, `body=${JSON.stringify(resp2.body)}`);
        chai.assert.deepEqualExcluding(resp2.body, {
            ...value1,
            uses: null,
            programId: null,
            contactId: null,
            code: null,
            active: true,
            canceled: false,
            frozen: false,
            pretax: false,
            startDate: null,
            endDate: null,
            redemptionRule: null,
            valueRule: null,
            discount: false,
            metadata: null
        }, ["createdDate", "updatedDate"]);
        value1 = resp2.body;
    });

    it("can get the value", async () => {
        const resp = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value1.id}`, "GET");
        chai.assert.equal(resp.statusCode, 200, `body=${JSON.stringify(resp.body)}`);
        chai.assert.deepEqual(resp.body, value1);
    });

    it("409s on creating a duplicate value", async () => {
        const resp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
            id: value1.id,
            currency: value1.currency,
            balance: value1.balance
        });
        chai.assert.equal(resp.statusCode, 409, `body=${JSON.stringify(resp.body)}`);
    });

    it("cannot change a value's currency", async () => {
        const currency2: Currency = {
            code: "XYZZY",
            name: "XYZZY",
            symbol: "X",
            decimalPlaces: 0
        };

        const resp1 = await testUtils.testAuthedRequest<Value>(router, "/v2/currencies", "POST", currency2);
        chai.assert.equal(resp1.statusCode, 201, `body=${JSON.stringify(resp1.body)}`);

        const resp2 = await testUtils.testAuthedRequest<any>(router, `/v2/values/${value1.id}`, "PATCH", {currency: currency2.code});
        chai.assert.equal(resp2.statusCode, 422, `body=${JSON.stringify(resp2.body)}`);
    });

    it("cannot change a value's balance", async () => {
        const resp = await testUtils.testAuthedRequest<any>(router, `/v2/values/${value1.id}`, "PATCH", {balance: 123123});
        chai.assert.equal(resp.statusCode, 422, `body=${JSON.stringify(resp.body)}`);
    });

    it("cannot change a value's uses", async () => {
        const resp = await testUtils.testAuthedRequest<any>(router, `/v2/values/${value1.id}`, "PATCH", {uses: 100});
        chai.assert.equal(resp.statusCode, 422, `body=${JSON.stringify(resp.body)}`);
    });

    it("can change the startDate and endDate", async () => {
        const resp = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value1.id}`, "PATCH", {
            startDate: new Date("2077-01-01"),
            endDate: new Date("2277-01-01")
        });
        chai.assert.equal(resp.statusCode, 200, `body=${JSON.stringify(resp.body)}`);

        value1.startDate = new Date("2077-01-01").toISOString() as any;
        value1.endDate = new Date("2277-01-01").toISOString() as any;
        chai.assert.deepEqualExcluding(resp.body, value1, ["updatedDate"]);
    });

    it("can change the metadata", async () => {
        const resp = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value1.id}`, "PATCH", {
            metadata: {
                special: "snowflake"
            }
        });
        chai.assert.equal(resp.statusCode, 200, `body=${JSON.stringify(resp.body)}`);

        value1.metadata = {
            special: "snowflake"
        };
        chai.assert.deepEqualExcluding(resp.body, value1, ["updatedDate"]);
    });

    it("can freeze a value", async () => {
        const resp = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value1.id}`, "PATCH", {frozen: true});
        chai.assert.equal(resp.statusCode, 200, `body=${JSON.stringify(resp.body)}`);

        value1.frozen = true;
        chai.assert.deepEqualExcluding(resp.body, value1, ["updatedDate"]);
    });

    it("can unfreeze a value", async () => {
        const resp = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value1.id}`, "PATCH", {frozen: false});
        chai.assert.equal(resp.statusCode, 200, `body=${JSON.stringify(resp.body)}`);

        value1.frozen = false;
        chai.assert.deepEqualExcluding(resp.body, value1, ["updatedDate"]);
    });

    it("can cancel a value", async () => {
        const resp = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value1.id}`, "PATCH", {canceled: true});
        chai.assert.equal(resp.statusCode, 200, `body=${JSON.stringify(resp.body)}`);

        value1.canceled = true;
        chai.assert.deepEqualExcluding(resp.body, value1, ["updatedDate"]);
    });

    it("cannot uncancel a value", async () => {
        const resp = await testUtils.testAuthedRequest<any>(router, `/v2/values/${value1.id}`, "PATCH", {canceled: false});
        chai.assert.equal(resp.statusCode, 422, `body=${JSON.stringify(resp.body)}`);
        chai.assert.equal(resp.body.messageCode, "CannotUncancelValue");
    });

    let contact1: Partial<Contact> = {
        id: "c1",
    };

    let value2: Partial<Value> = {
        id: "v2",
        currency: "USD",
        balance: 0,
        contactId: contact1.id
    };

    it("can create a value attached to a contact", async () => {
        const resp1 = await testUtils.testAuthedRequest<Contact>(router, "/v2/contacts", "POST", contact1);
        chai.assert.equal(resp1.statusCode, 201);

        const resp2 = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value2);
        chai.assert.equal(resp2.statusCode, 201, `body=${JSON.stringify(resp2.body)}`);
        chai.assert.equal(resp2.body.contactId, value2.contactId);
        value2 = resp2.body;
    });

    let value3: Partial<Value> = {
        id: "v3",
        currency: "USD",
        balance: 5000
    };

    it("can create a value with an initial balance", async () => {
        const resp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value3);
        chai.assert.equal(resp.statusCode, 201, `create body=${JSON.stringify(resp.body)}`);
        chai.assert.equal(resp.body.balance, value3.balance);
        value3 = resp.body;

        const resp2 = await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${value3.id}`, "GET");
        chai.assert.equal(resp2.statusCode, 200, `body=${JSON.stringify(resp2.body)}`);
        chai.assert.equal(resp2.body.transactionType, "credit");
        chai.assert.equal(resp2.body.currency, value3.currency);
        chai.assert.equal(resp2.body.metadata, null);
        chai.assert.lengthOf(resp2.body.steps, 1);
        chai.assert.equal(resp2.body.steps[0].rail, "lightrail");
        chai.assert.deepEqual((resp2.body.steps[0] as LightrailTransactionStep), {
            rail: "lightrail",
            valueId: value3.id,
            code: null,
            contactId: null,
            balanceBefore: 0,
            balanceAfter: value3.balance,
            balanceChange: value3.balance
        });
    });

    it("422s on creating a value with a negative balance", async () => {
        const resp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
            id: "negativebalance",
            currency: "USD",
            balance: -5000
        });
        chai.assert.equal(resp.statusCode, 422, `create body=${JSON.stringify(resp.body)}`);
    });

    let value4: Partial<Value> = {
        id: "v4",
        currency: "USD",
        balance: 0,
        contactId: "idontexist"
    };

    it("409s on creating a value attached to a non-existent contact", async () => {
        const resp = await testUtils.testAuthedRequest<any>(router, "/v2/values", "POST", value4);
        chai.assert.equal(resp.statusCode, 409, `body=${JSON.stringify(resp.body)}`);
        chai.assert.equal(resp.body.messageCode, "ContactNotFound");
    });

    it("can delete a value that is not in use", async () => {
        const value: Partial<Value> = {
            id: "vjeff",
            currency: "USD",
            balance: 0
        };

        const resp1 = await testUtils.testAuthedRequest<any>(router, "/v2/values", "POST", value);
        chai.assert.equal(resp1.statusCode, 201, `create body=${JSON.stringify(resp1.body)}`);

        const resp3 = await testUtils.testAuthedRequest<any>(router, `/v2/values/${value.id}`, "DELETE");
        chai.assert.equal(resp3.statusCode, 200, `delete body=${JSON.stringify(resp3.body)}`);

        const resp4 = await testUtils.testAuthedRequest<any>(router, `/v2/values/${value.id}`, "GET");
        chai.assert.equal(resp4.statusCode, 404, `get deleted body=${JSON.stringify(resp4.body)}`);
    });

    it("404s on deleting a Value that does not exist", async () => {
        const resp = await testUtils.testAuthedRequest<any>(router, `/v2/values/idonotexist`, "DELETE");
        chai.assert.equal(resp.statusCode, 404, `delete body=${JSON.stringify(resp.body)}`);
    });

    let value5: Partial<Value> = {
        id: "vjeff2",
        currency: "USD",
        balance: 1982   // creates an initial value transaction
    };

    it("409s on deleting a Value that is in use", async () => {
        const resp1 = await testUtils.testAuthedRequest<any>(router, "/v2/values", "POST", value5);
        chai.assert.equal(resp1.statusCode, 201, `create body=${JSON.stringify(resp1.body)}`);
        value5 = resp1.body;

        const resp2 = await testUtils.testAuthedRequest<any>(router, `/v2/values/${value5.id}`, "DELETE");
        chai.assert.equal(resp2.statusCode, 409, `delete body=${JSON.stringify(resp2.body)}`);
        chai.assert.equal(resp2.body.messageCode, "ValueInUse");

        const resp3 = await testUtils.testAuthedRequest<any>(router, `/v2/values/${value5.id}`, "GET");
        chai.assert.equal(resp3.statusCode, 200, `still exists body=${JSON.stringify(resp3.body)}`);
    });

    describe("filtering and paging", () => {
        before(async () => {
            const values: Partial<DbValue>[] = [];
            const date = new Date();

            for (let i = 0; i < 1000; i++) {
                values.push({
                    userId: defaultTestUser.userId,
                    id: `paging-${i}`,
                    currency: "USD",
                    balance: Math.max((Math.sin(i) * 1000) | 0, 0),
                    pretax: true,
                    active: true,
                    canceled: !(i % 7),
                    frozen: false,
                    discount: true,
                    startDate: date,
                    endDate: date,
                    createdDate: date,
                    updatedDate: date
                });
            }

            const knex = await getKnexWrite();
            await knex("Values").insert(values);
        });

        it("pages and filters through many Values", async () => {
            const knex = await getKnexRead();
            const expected = await knex("Values")
                .where({
                    userId: defaultTestUser.userId,
                    canceled: false
                })
                .where("balance", ">", 200)
                .orderBy("id");
            chai.assert.isAtLeast(expected.length, 2, "expect results");

            const page1Size = Math.ceil(expected.length / 2);
            const page1 = await testUtils.testAuthedRequest<Contact[]>(router, `/v2/values?canceled=false&balance.gt=200&limit=${page1Size}`, "GET");
            chai.assert.equal(page1.statusCode, 200, `body=${JSON.stringify(page1.body)}`);
            chai.assert.deepEqual(page1.body.map(v => v.id), expected.slice(0, page1Size).map(v => v.id), "the same ids in the same order");
            chai.assert.equal(page1.headers["Limit"], `${page1Size}`);
            chai.assert.equal(page1.headers["Max-Limit"], "1000");
            chai.assert.isDefined(page1.headers["Link"]);

            const page1Link = parseLinkHeader(page1.headers["Link"]);
            const page2 = await testUtils.testAuthedRequest<Contact[]>(router, page1Link.next.url, "GET");
            chai.assert.equal(page2.statusCode, 200, `url=${page1Link.next.url} body=${JSON.stringify(page2.body)}`);
            chai.assert.deepEqual(page2.body.map(v => v.id), expected.slice(page1Size).map(v => v.id), "the same ids in the same order");
            chai.assert.equal(page1.headers["Limit"], `${page1Size}`);
            chai.assert.equal(page1.headers["Max-Limit"], "1000");
            chai.assert.isDefined(page1.headers["Link"]);

            const page2Link = parseLinkHeader(page2.headers["Link"]);
            const page2prev = await testUtils.testAuthedRequest<Contact[]>(router, page2Link.prev.url, "GET");
            chai.assert.equal(page2prev.statusCode, 200, `url=${page2Link.prev.url} body=${JSON.stringify(page2prev.body)}`);
            chai.assert.deepEqual(page2prev.body, page1.body);
        });

        it("supports id.in", async () => {
            const ids = ["paging-1", "paging-10", "paging-11", "paging-101", "paging-100", "paging-110", "paging-111"];

            const knex = await getKnexRead();
            const expected = await knex("Values")
                .where({
                    userId: defaultTestUser.userId
                })
                .whereIn("id", ids)
                .orderBy("id");

            const page1 = await testUtils.testAuthedRequest<Contact[]>(router, `/v2/values?id.in=${ids.join(",")}`, "GET");
            chai.assert.equal(page1.statusCode, 200, `body=${JSON.stringify(page1.body)}`);
            chai.assert.deepEqualExcludingEvery(page1.body, expected, ["userId", "codeHashed", "codeLastFour", "startDate", "endDate", "createdDate", "updatedDate", "encryptedCode", "genericCode"]);
            chai.assert.isDefined(page1.headers["Link"]);
        });
    });

    it("can create a value with public code", async () => {
        let publicCode = {
            id: "valueWithPublicCode",
            currency: "USD",
            genericCode: "PUBLIC",
            balance: 0
        };

        const post = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", publicCode);
        chai.assert.equal(post.statusCode, 201, `body=${JSON.stringify(post.body)}`);
        chai.assert.equal(post.body.code, publicCode.genericCode);

        const get = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${publicCode.id}`, "GET");
        chai.assert.equal(get.statusCode, 200, `body=${JSON.stringify(get.body)}`);
        chai.assert.equal(get.body.code, "PUBLIC");

        const showCode = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${publicCode.id}?showCode=true`, "GET");
        chai.assert.equal(showCode.statusCode, 200, `body=${JSON.stringify(showCode.body)}`);
        chai.assert.equal(showCode.body.code, "PUBLIC");


        const knex = await getKnexRead();
        const res: DbValue[] = await knex("Values")
            .select()
            .where({
                userId: testUtils.defaultTestUser.userId,
                id: publicCode.id
            });
        chai.assert.isNotNull(res[0].encryptedCode);
        chai.assert.isNotNull(res[0].codeHashed);
        chai.assert.equal(res[0].codeHashed, computeLookupHash(publicCode.genericCode, testUtils.defaultTestUser.auth));
        chai.assert.equal(res[0].code, "...BLIC");

        const list = await testUtils.testAuthedRequest<any>(router, `/v2/values`, "GET");
        let codeInListShowCodeFalse: Value = list.body.find(it => it.id === publicCode.id);
        chai.assert.equal(codeInListShowCodeFalse.code, "PUBLIC");
        const listShowCode = await testUtils.testAuthedRequest<any>(router, `/v2/values?showCode=true`, "GET");
        let codeInListShowCodeTrue: Value = listShowCode.body.find(it => it.id === publicCode.id);
        chai.assert.equal(codeInListShowCodeTrue.code, "PUBLIC");
    });

    it("can create a value with secure code", async () => {
        let secureCode = {
            id: "valueWithSecureCode",
            currency: "USD",
            code: "SECURE",
            balance: 0
        };

        const respPost = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", secureCode);
        chai.assert.equal(respPost.statusCode, 201, `body=${JSON.stringify(respPost.body)}`);
        chai.assert.equal(respPost.body.code, "...CURE");

        const respGet = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${secureCode.id}`, "GET");
        chai.assert.equal(respGet.statusCode, 200, `body=${JSON.stringify(respGet.body)}`);
        chai.assert.equal(respGet.body.code, "...CURE");

        const showCode = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${secureCode.id}?showCode=true`, "GET");
        chai.assert.equal(showCode.statusCode, 200, `body=${JSON.stringify(showCode.body)}`);
        chai.assert.equal(showCode.body.code, "SECURE");

        const knex = await getKnexRead();
        const res: DbValue[] = await knex("Values")
            .select()
            .where({
                userId: testUtils.defaultTestUser.userId,
                id: secureCode.id
            });
        chai.assert.isNotNull(res[0].encryptedCode);
        chai.assert.isNotNull(res[0].codeHashed);
        chai.assert.equal(res[0].codeHashed, computeLookupHash(secureCode.code, testUtils.defaultTestUser.auth));
        chai.assert.equal(res[0].code, "...CURE");

        const list = await testUtils.testAuthedRequest<any>(router, `/v2/values`, "GET");
        let codeInListShowCodeFalse: Value = list.body.find(it => it.id === secureCode.id);
        chai.assert.equal(codeInListShowCodeFalse.code, "...CURE");
        const listShowCode = await testUtils.testAuthedRequest<any>(router, `/v2/values?showCode=true`, "GET");
        let codeInListShowCodeTrue: Value = listShowCode.body.find(it => it.id === secureCode.id);
        chai.assert.equal(codeInListShowCodeTrue.code, "SECURE");

    });
    it("can change a code", async () => {
        let codesToTest: string[] = ["ABCDE", "ABCDEF12345", "FSSESFAWDWQCASAWD"];

        for (let code of codesToTest) {
            let value = {
                id: "changeCodeTest1" + code,
                currency: "USD",
                genericCode: "CODEONE",
                balance: 0
            };

            const create = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
            chai.assert.equal(create.statusCode, 201, `body=${JSON.stringify(create.body)}`);
            chai.assert.equal(create.body.code, value.genericCode);

            const changeCodePublic = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}/changeCode`, "POST", {genericCode: code});
            chai.assert.equal(changeCodePublic.statusCode, 200, `body=${JSON.stringify(changeCodePublic.body)}`);

            const getNewPublicCode = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}`, "GET");
            chai.assert.equal(getNewPublicCode.statusCode, 200, `body=${JSON.stringify(getNewPublicCode.body)}`);
            chai.assert.equal(getNewPublicCode.body.code, code);

            const knex = await getKnexRead();
            let res: DbValue[] = await knex("Values")
                .select()
                .where({
                    userId: testUtils.defaultTestUser.userId,
                    id: value.id
                });
            chai.assert.isNotNull(res[0].encryptedCode);
            chai.assert.isNotNull(res[0].codeHashed);
            chai.assert.equal(res[0].codeHashed, computeLookupHash(code, testUtils.defaultTestUser.auth));
            chai.assert.equal(res[0].code, codeLastFour(code));
            chai.assert.equal(decrypt(res[0].encryptedCode), code);

            const changeCodeSecure = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}/changeCode`, "POST", {code: code});
            chai.assert.equal(changeCodeSecure.statusCode, 200, `body=${JSON.stringify(changeCodeSecure.body)}`);

            const getNewSecureCode = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}`, "GET");
            chai.assert.equal(getNewSecureCode.statusCode, 200, `body=${JSON.stringify(getNewSecureCode.body)}`);
            chai.assert.equal(getNewSecureCode.body.code, codeLastFour(code));

            res = await knex("Values")
                .select()
                .where({
                    userId: testUtils.defaultTestUser.userId,
                    id: value.id
                });
            chai.assert.isNotNull(res[0].encryptedCode);
            chai.assert.isNotNull(res[0].codeHashed);
            chai.assert.equal(res[0].codeHashed, computeLookupHash(code, testUtils.defaultTestUser.auth));
            chai.assert.equal(res[0].code, codeLastFour(code));
            chai.assert.equal(decrypt(res[0].encryptedCode), code);
        }
    });

    describe("code generation tests", () => {
        let value = {
            id: "generateCodeTest-1",
            currency: "USD",
            generateCode: {
                length: 20
            },
            balance: 0
        };
        let firstGeneratedCode: string;
        let secondGeneratedCode: string;

        it("can generate a code", async () => {
            const create = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
            chai.assert.equal(create.statusCode, 201, `body=${JSON.stringify(create.body)}`);
            const lastFour = create.body.code.substring(3);
            chai.assert.equal(create.body.code, "..." + lastFour);
            chai.assert.equal(lastFour.length, 4);

            const showCode = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}?showCode=true`, "GET");
            chai.assert.equal(showCode.statusCode, 200, `body=${JSON.stringify(showCode.body)}`);
            firstGeneratedCode = showCode.body.code;
            chai.assert.equal(firstGeneratedCode.length, 20);

            const knex = await getKnexRead();
            let res: DbValue[] = await knex("Values")
                .select()
                .where({
                    userId: testUtils.defaultTestUser.userId,
                    id: value.id
                });
            chai.assert.isNotNull(res[0].encryptedCode);
            chai.assert.isNotNull(res[0].codeHashed);
            chai.assert.equal(res[0].codeHashed, computeLookupHash(firstGeneratedCode, testUtils.defaultTestUser.auth));
            chai.assert.equal(res[0].code, codeLastFour(firstGeneratedCode));
            chai.assert.equal(decrypt(res[0].encryptedCode), firstGeneratedCode);
            chai.assert.notEqual(res[0].encryptedCode, firstGeneratedCode);
            chai.assert.notEqual(res[0].codeHashed, firstGeneratedCode);
        });

        it("can regenerate a code", async () => {
            const changeCodeSecure = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}/changeCode`, "POST", {
                generateCode: {
                    length: 15, prefix: "SPRING"
                }
            });
            chai.assert.equal(changeCodeSecure.statusCode, 200, `body=${JSON.stringify(changeCodeSecure.body)}`);

            const get = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}`, "GET", value);
            console.log(JSON.stringify(get));
            const lastFour = get.body.code.substring(3);
            chai.assert.equal(get.body.code, "..." + lastFour);
            chai.assert.equal(lastFour.length, 4);

            const showCode = await testUtils.testAuthedRequest<Value>(router, `/v2/values/${value.id}?showCode=true`, "GET");
            chai.assert.equal(showCode.statusCode, 200, `body=${JSON.stringify(showCode.body)}`);
            secondGeneratedCode = showCode.body.code;
            chai.assert.equal(secondGeneratedCode.length, 21);

            const knex = await getKnexRead();
            let res: DbValue[] = await knex("Values")
                .select()
                .where({
                    userId: testUtils.defaultTestUser.userId,
                    id: value.id
                });
            chai.assert.isNotNull(res[0].encryptedCode);
            chai.assert.isNotNull(res[0].codeHashed);
            chai.assert.equal(res[0].codeHashed, computeLookupHash(secondGeneratedCode, testUtils.defaultTestUser.auth));
            chai.assert.equal(res[0].code, codeLastFour(secondGeneratedCode));
            chai.assert.equal(decrypt(res[0].encryptedCode), secondGeneratedCode);
            chai.assert.notEqual(res[0].encryptedCode, secondGeneratedCode);
            chai.assert.notEqual(res[0].codeHashed, secondGeneratedCode);
            chai.assert.notEqual(firstGeneratedCode, secondGeneratedCode);
        });
    });

    describe("can't create a Value with disjoint code properties", () => {
        it("cannot create a Value with code and genericCode", async () => {
            let valueWithPublicCode = {
                id: "value",
                currency: "USD",
                code: "SECURE",
                genericCode: "PUBLIC",
                balance: 0
            };

            const res = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", valueWithPublicCode);
            chai.assert.equal(res.statusCode, 422, `body=${JSON.stringify(res.body)}`);
        });

        it("cannot create a Value with code and generateCode", async () => {
            let valueWithPublicCode = {
                id: "value",
                currency: "USD",
                code: "SECURE",
                generateCode: {length: 5},
                balance: 0
            };

            const res = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", valueWithPublicCode);
            chai.assert.equal(res.statusCode, 422, `body=${JSON.stringify(res.body)}`);
        });

        it("cannot create a Value with genericCode and generateCode", async () => {
            let valueWithPublicCode = {
                id: "value",
                currency: "USD",
                genericCode: "PUBLIC",
                generateCode: {length: 5},
                balance: 0
            };

            const res = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", valueWithPublicCode);
            chai.assert.equal(res.statusCode, 422, `body=${JSON.stringify(res.body)}`);
        });

        it("cannot create a Value with code, genericCode, and generateCode", async () => {
            let valueWithPublicCode = {
                id: "value",
                currency: "USD",
                code: "SECURE",
                genericCode: "PUBLIC",
                generateCode: {length: 5},
                balance: 0
            };

            const res = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", valueWithPublicCode);
            chai.assert.equal(res.statusCode, 422, `body=${JSON.stringify(res.body)}`);
        });

        it("generateCode can't have unknown properties", async () => {
            let valueWithPublicCode = {
                id: "value",
                currency: "USD",
                generateCode: {length: 5, unknown: "property"},
                balance: 0
            };

            const res = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", valueWithPublicCode);
            chai.assert.equal(res.statusCode, 422, `body=${JSON.stringify(res.body)}`);
        });
    });

    describe("can't change a Value with disjoint code properties", () => {
        it("cannot create a Value with code and genericCode", async () => {
            let changeRequest = {
                code: "SECURE",
                genericCode: "PUBLIC",
            };

            const res = await testUtils.testAuthedRequest<Value>(router, "/v2/values/id/changeCode", "POST", changeRequest);
            chai.assert.equal(res.statusCode, 422, `body=${JSON.stringify(res.body)}`);
        });

        it("cannot create a Value with code and generateCode", async () => {
            let changeRequest = {
                code: "SECURE",
                generateCode: {length: 5},
            };

            const res = await testUtils.testAuthedRequest<Value>(router, "/v2/values/id/changeCode", "POST", changeRequest);
            chai.assert.equal(res.statusCode, 422, `body=${JSON.stringify(res.body)}`);
        });

        it("cannot create a Value with genericCode and generateCode", async () => {
            let changeRequest = {
                genericCode: "PUBLIC",
                generateCode: {length: 5},
            };

            const res = await testUtils.testAuthedRequest<Value>(router, "/v2/values/id/changeCode", "POST", changeRequest);
            chai.assert.equal(res.statusCode, 422, `body=${JSON.stringify(res.body)}`);
        });

        it("cannot create a Value with code, genericCode, and generateCode", async () => {
            let changeRequest = {
                code: "SECURE",
                genericCode: "PUBLIC",
                generateCode: {length: 5},
            };

            const res = await testUtils.testAuthedRequest<Value>(router, "/v2/values/id/changeCode", "POST", changeRequest);
            chai.assert.equal(res.statusCode, 422, `body=${JSON.stringify(res.body)}`);
        });

        it("generateCode can't have unknown properties", async () => {
            let changeRequest = {
                generateCode: {length: 5, unknown: "property"},
            };

            const res = await testUtils.testAuthedRequest<Value>(router, "/v2/values/id/changeCode", "POST", changeRequest);
            chai.assert.equal(res.statusCode, 422, `body=${JSON.stringify(res.body)}`);
        });
    });
});
