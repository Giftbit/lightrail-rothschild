import * as testUtils from "../../utils/testUtils";
import {defaultTestUser, generateId} from "../../utils/testUtils";
import * as cassava from "cassava";
import * as chai from "chai";
import {Program} from "../../model/Program";
import {installRestRoutes} from "./installRestRoutes";
import {createCurrency} from "./currencies";
import {getKnexWrite} from "../../utils/dbUtils/connection";
import {CheckoutRequest} from "../../model/TransactionRequest";
import {setStubsForStripeTests, unsetStubsForStripeTests} from "../../utils/testUtils/stripeTestUtils";
import {Rule, Value} from "../../model/Value";
import {Transaction} from "../../model/Transaction";
import {ProgramStats} from "../../model/ProgramStats";
import chaiExclude from "chai-exclude";
import {nowInDbPrecision} from "../../utils/dbUtils";

chai.use(chaiExclude);

describe("/v2/programs", () => {

    const router = new cassava.Router();

    before(async () => {
        await testUtils.resetDb();
        router.route(testUtils.authRoute);
        installRestRoutes(router);
        await createCurrency(testUtils.defaultTestUser.auth, {
            code: "USD",
            name: "USDees",
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

    it("can list 0 programs", async () => {
        const resp = await testUtils.testAuthedRequest(router, "/v2/programs", "GET");
        chai.assert.equal(resp.statusCode, 200);
        chai.assert.deepEqual(resp.body, []);
    });

    const programRequest: Partial<Program> = {
        id: "1",
        currency: "USD",
        name: "test program"
    };
    let programResponse: Program;

    it("can create a program", async () => {
        const resp = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", programRequest);
        chai.assert.equal(resp.statusCode, 201);
        chai.assert.equal(resp.body.id, programRequest.id);
        chai.assert.equal(resp.body.currency, programRequest.currency);
        chai.assert.deepEqualExcluding(resp.body, {
            id: programRequest.id,
            name: programRequest.name,
            currency: programRequest.currency,
            discount: false,
            discountSellerLiability: null,
            discountSellerLiabilityRule: null,
            pretax: false,
            active: true,
            redemptionRule: null,
            balanceRule: null,
            minInitialBalance: null,
            maxInitialBalance: null,
            fixedInitialBalances: null,
            fixedInitialUsesRemaining: null,
            startDate: null,
            endDate: null,
            metadata: null,
            createdDate: null,
            updatedDate: null,
            createdBy: defaultTestUser.auth.teamMemberId
        }, ["createdDate", "updatedDate", "createdBy"]);
        chai.assert.isNotNull(resp.body.createdDate);
        chai.assert.isNotNull(resp.body.updatedDate);
        programResponse = resp.body;
    });

    it("can get the program", async () => {
        const resp = await testUtils.testAuthedRequest<Program>(router, `/v2/programs/${programResponse.id}`, "GET");
        chai.assert.equal(resp.statusCode, 200);
        chai.assert.deepEqual(resp.body, programResponse);
    });

    it("can list programs", async () => {
        const newProgram = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", {
            ...programRequest,
            id: generateId(),
            name: "new program!"
        });
        chai.assert.equal(newProgram.statusCode, 201);

        const resp = await testUtils.testAuthedRequest<Program[]>(router, `/v2/programs`, "GET");
        chai.assert.equal(resp.statusCode, 200);
        chai.assert.equal(resp.body.length, 2);
        const indexOfNewProgram = resp.body[0].id === newProgram.body.id ? 0 : 1;
        chai.assert.deepEqual(resp.body[indexOfNewProgram], newProgram.body);
        chai.assert.deepEqual(resp.body[(indexOfNewProgram + 1) % 2], programResponse);
    });

    it("can filter programs by id", async () => {
        const newProgram1 = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", {
            ...programRequest,
            id: "one",
            name: `new program ${generateId()}`
        });
        chai.assert.equal(newProgram1.statusCode, 201);
        const newProgram2 = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", {
            ...programRequest,
            id: "two",
            name: `new program ${generateId()}`
        });
        chai.assert.equal(newProgram2.statusCode, 201);
        const newProgram3 = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", {
            ...programRequest,
            id: "three",
            name: `new program ${generateId()}`
        });
        chai.assert.equal(newProgram3.statusCode, 201);

        const filterResp1 = await testUtils.testAuthedRequest<Program[]>(router, `/v2/programs?id.in=${[newProgram1.body.id, newProgram2.body.id, newProgram3.body.id].join(",")}`, "GET");
        chai.assert.equal(filterResp1.statusCode, 200);
        chai.assert.equal(filterResp1.body.length, 3);

        const filterResp2 = await testUtils.testAuthedRequest<Program[]>(router, `/v2/programs?id.in=${newProgram2.body.id}`, "GET");
        chai.assert.equal(filterResp2.statusCode, 200);
        chai.assert.equal(filterResp2.body.length, 1, `filterResp.body=${JSON.stringify(filterResp2.body, null, 4)}`);
    });

    it("can filter programs by currency", async () => {
        await createCurrency(testUtils.defaultTestUser.auth, {
            code: "CAD",
            name: "CAD",
            symbol: "$",
            decimalPlaces: 2,
            createdDate: nowInDbPrecision(),
            updatedDate: nowInDbPrecision(),
            createdBy: testUtils.defaultTestUser.teamMemberId
        });
        const newProgram = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", {
            id: "one-cad",
            name: `new program ${generateId()}`,
            currency: "CAD"
        });
        chai.assert.equal(newProgram.statusCode, 201);

        const filterResp1 = await testUtils.testAuthedRequest<Program[]>(router, `/v2/programs?currency.eq=CAD`, "GET");
        chai.assert.equal(filterResp1.statusCode, 200);
        chai.assert.equal(filterResp1.body.length, 1);

        const respAll = await testUtils.testAuthedRequest<Program[]>(router, `/v2/programs`, "GET");
        const filterResp2 = await testUtils.testAuthedRequest<Program[]>(router, `/v2/programs?currency.eq=USD`, "GET");
        chai.assert.equal(filterResp2.statusCode, 200);
        chai.assert.equal(filterResp2.body.length, respAll.body.length - 1);
    });

    it("can filter programs by createdDate", async () => {
        const respAll = await testUtils.testAuthedRequest<Program[]>(router, `/v2/programs`, "GET");
        const filterResp1 = await testUtils.testAuthedRequest<Program[]>(router, `/v2/programs?createdDate.gte=2000-01-01T00:00:50.000Z`, "GET");
        chai.assert.equal(filterResp1.statusCode, 200);
        chai.assert.equal(filterResp1.body.length, respAll.body.length);

        const filterResp2 = await testUtils.testAuthedRequest<Program[]>(router, `/v2/programs?createdDate.gte=2121-01-01T00:00:50.000Z`, "GET");
        chai.assert.equal(filterResp2.statusCode, 200);
        chai.assert.equal(filterResp2.body.length, 0);
    });

    it("can update a program", async () => {
        const request1: Partial<Program> = {
            name: "The revised program."
        };
        const update1 = await testUtils.testAuthedRequest<Program>(router, `/v2/programs/${programRequest.id}`, "PATCH", request1);
        chai.assert.equal(update1.statusCode, 200);
        chai.assert.equal(update1.body.name, "The revised program.");
        chai.assert.isNotNull(update1.body.createdDate);
        chai.assert.isNotNull(update1.body.updatedDate);

        const request2: Partial<Program> = {
            minInitialBalance: 50,
            maxInitialBalance: 500
        };
        const update2 = await testUtils.testAuthedRequest<Program>(router, `/v2/programs/${programRequest.id}`, "PATCH", request2);
        chai.assert.equal(update2.statusCode, 200);
        chai.assert.equal(update2.body.minInitialBalance, request2.minInitialBalance);
        chai.assert.equal(update2.body.maxInitialBalance, request2.maxInitialBalance);

        const request3: Partial<Program> = {
            minInitialBalance: null,
            maxInitialBalance: null,
            balanceRule: {
                rule: "500",
                explanation: "$5 the hard way"
            }
        };
        const update3 = await testUtils.testAuthedRequest<Program>(router, `/v2/programs/${programRequest.id}`, "PATCH", request3);
        chai.assert.equal(update3.statusCode, 200);
        chai.assert.equal(update3.body.minInitialBalance, request3.minInitialBalance);
        chai.assert.equal(update3.body.maxInitialBalance, request3.maxInitialBalance);
        chai.assert.deepEqual(update3.body.balanceRule, request3.balanceRule);
    });

    it("can update startDate and endDate", async () => {
        const prog: Partial<Program> = {
            id: generateId(),
            currency: "USD",
            name: "some program name"
        };
        const createProgram = await testUtils.testAuthedRequest<Program>(router, `/v2/programs`, "POST", prog);
        chai.assert.equal(createProgram.statusCode, 201);

        const update = await testUtils.testAuthedRequest<Program>(router, `/v2/programs/${prog.id}`, "PATCH", {
            startDate: "2020-01-01T00:00:00.000Z",
            endDate: "2030-01-01T00:00:00.000Z",
        });
        chai.assert.equal(update.statusCode, 200);
        chai.assert.equal(update.body.startDate as any, "2020-01-01T00:00:00.000Z");
        chai.assert.equal(update.body.endDate as any, "2030-01-01T00:00:00.000Z");

        // can't update where startDate exceeds endDate
        const update2 = await testUtils.testAuthedRequest<Program>(router, `/v2/programs/${prog.id}`, "PATCH", {
            startDate: "2040-01-01T00:00:00.000Z",
            endDate: "2030-01-01T00:00:00.000Z",
        });
        chai.assert.equal(update2.statusCode, 422);
    });

    it("can delete a program", async () => {
        const deleteResp = await testUtils.testAuthedRequest(router, `/v2/programs/${programRequest.id}`, "DELETE");
        chai.assert.equal(deleteResp.statusCode, 200);

        const getResp = await testUtils.testAuthedRequest(router, `/v2/programs/${programRequest.id}`, "GET");
        chai.assert.equal(getResp.statusCode, 404);
    });

    it("lists programs with sorting on createdDate by default", async () => {
        const idAndDates = [
            {id: generateId(), createdDate: new Date("3030-02-01")},
            {id: generateId(), createdDate: new Date("3030-02-02")},
            {id: generateId(), createdDate: new Date("3030-02-03")},
            {id: generateId(), createdDate: new Date("3030-02-04")}
        ];
        for (const idAndDate of idAndDates) {
            const response = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", {
                id: idAndDate.id,
                currency: "USD",
                name: "test program"
            });
            chai.assert.equal(response.statusCode, 201);
            const knex = await getKnexWrite();
            const res: number = await knex("Programs")
                .where({
                    userId: testUtils.defaultTestUser.userId,
                    id: idAndDate.id,
                })
                .update(Program.toDbProgram(testUtils.defaultTestUser.auth, {
                    ...response.body,
                    createdDate: idAndDate.createdDate,
                    updatedDate: idAndDate.createdDate
                }));
            if (res === 0) {
                chai.assert.fail(`no row updated. test is broken`);
            }
        }
        const resp = await testUtils.testAuthedRequest<Program[]>(router, "/v2/programs?createdDate.gt=3030-01-01", "GET");
        chai.assert.equal(resp.statusCode, 200);
        chai.assert.equal(resp.body.length, 4);
        chai.assert.sameOrderedMembers(resp.body.map(tx => tx.id), idAndDates.reverse().map(tx => tx.id) /* reversed since createdDate desc */);
    });

    it("treats programId as case sensitive", async () => {
        const program1: Partial<Program> = {
            id: generateId() + "-A",
            currency: "USD",
            name: "program with upper case"
        };
        const program: Partial<Program> = {
            id: program1.id.toLowerCase(),
            currency: "USD",
            name: "program in lower case"
        };
        chai.assert.notEqual(program1.id, program.id);

        const postProgram1Resp = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", program1);
        chai.assert.equal(postProgram1Resp.statusCode, 201, postProgram1Resp.bodyRaw);

        const postProgram2Resp = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", program);
        chai.assert.equal(postProgram2Resp.statusCode, 201, postProgram2Resp.bodyRaw);

        const getProgram1Resp = await testUtils.testAuthedRequest<Program>(router, `/v2/programs/${program1.id}`, "GET");
        chai.assert.equal(getProgram1Resp.statusCode, 200);
        chai.assert.equal(getProgram1Resp.body.id, program1.id);

        const getProgram2Resp = await testUtils.testAuthedRequest<Program>(router, `/v2/programs/${program.id}`, "GET");
        chai.assert.equal(getProgram2Resp.statusCode, 200);
        chai.assert.equal(getProgram2Resp.body.id, program.id);
        chai.assert.notEqual(getProgram1Resp.body.id, getProgram2Resp.body.id);

        const getPrograms1Resp = await testUtils.testAuthedRequest<Program[]>(router, `/v2/programs?id=${program1.id}`, "GET");
        chai.assert.equal(getPrograms1Resp.statusCode, 200);
        chai.assert.deepEqual(getPrograms1Resp.body, [getProgram1Resp.body]);

        const getPrograms2Resp = await testUtils.testAuthedRequest<Program[]>(router, `/v2/programs?id=${program.id}`, "GET");
        chai.assert.equal(getPrograms2Resp.statusCode, 200);
        chai.assert.deepEqual(getPrograms2Resp.body, [getProgram2Resp.body]);
    });

    describe("create validation", () => {
        it("422s creating a program with non-ascii characters in the ID", async () => {
            const request: Partial<Program> = {
                id: generateId() + "🐶",
                name: generateId(),
                currency: "USD"
            };
            const res = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", request);
            chai.assert.equal(res.statusCode, 422);
        });

        it("422s creating a program with startDate > endDate", async () => {
            const prog: Partial<Program> = {
                id: generateId(),
                currency: "USD",
                name: "some program name",
                startDate: new Date("2025-01-01"),
                endDate: new Date("2024-01-01")
            };
            const createProgram = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", prog);
            chai.assert.equal(createProgram.statusCode, 422);
        });

        it("422s creating a program with minInitialBalance > maxInitialBalance", async () => {
            const request: Partial<Program> = {
                id: generateId(),
                name: generateId(),
                currency: "USD",
                minInitialBalance: 10,
                maxInitialBalance: 5
            };
            const res = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", request);
            chai.assert.equal(res.statusCode, 422);
        });

        it("422s creating a program with a huge minInitialBalance", async () => {
            const createRequest: Partial<Program> = {
                id: generateId(),
                name: generateId(),
                currency: "USD",
                minInitialBalance: 999999999999
            };
            const resp = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", createRequest);
            chai.assert.equal(resp.statusCode, 422);
        });

        it("422s creating a program with a huge maxInitialBalance", async () => {
            const createRequest: Partial<Program> = {
                id: generateId(),
                name: generateId(),
                currency: "USD",
                minInitialBalance: 5,
                maxInitialBalance: 999999999999
            };
            const resp = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", createRequest);
            chai.assert.equal(resp.statusCode, 422);
        });

        it("422s creating a program with a huge member of fixedInitialBalances", async () => {
            const createRequest: Partial<Program> = {
                id: generateId(),
                name: generateId(),
                currency: "USD",
                fixedInitialBalances: [0, 1, 999999999999]
            };
            const resp = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", createRequest);
            chai.assert.equal(resp.statusCode, 422);
        });

        it("422s creating a program with a negative member of fixedInitialBalances", async () => {
            const createRequest: Partial<Program> = {
                id: generateId(),
                name: generateId(),
                currency: "USD",
                fixedInitialBalances: [-1, 0]
            };
            const resp = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", createRequest);
            chai.assert.equal(resp.statusCode, 422);
        });

        it("422s creating a program with a huge member of fixedInitialUsesRemaining", async () => {
            const createRequest: Partial<Program> = {
                id: generateId(),
                name: generateId(),
                currency: "USD",
                fixedInitialUsesRemaining: [0, 1, 999999999999]
            };
            const resp = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", createRequest);
            chai.assert.equal(resp.statusCode, 422);
        });

        it("422s creating a program with a negative member of fixedInitialUsesRemaining", async () => {
            const createRequest: Partial<Program> = {
                id: generateId(),
                name: generateId(),
                currency: "USD",
                fixedInitialUsesRemaining: [-1, 0]
            };
            const resp = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", createRequest);
            chai.assert.equal(resp.statusCode, 422);
        });

        it("409s creating a program with an unknown currency", async () => {
            const request: Partial<Program> = {
                id: generateId(),
                name: generateId(),
                currency: generateId().replace(/-/g, "").substring(0, 15)
            };
            const res = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", request);
            chai.assert.equal(res.statusCode, 409);
        });

        it("409s creating a program with a duplicate id", async () => {
            const request: Partial<Program> = {
                id: generateId(),
                name: generateId(),
                currency: "USD"
            };
            const res = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", request);
            chai.assert.equal(res.statusCode, 201);

            const res2 = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", request);
            chai.assert.equal(res2.statusCode, 409);
        });

        it("422s creating a program with a balanceRule that does not compile", async () => {
            const postBody: Partial<Program> = {
                id: generateId(),
                name: generateId(),
                currency: "USD",
                balanceRule: {
                    rule: "currentLineItem.lineTotal.subtotal * (0.1",
                    explanation: "unbalanced paranthesis"
                }
            };
            const progResp = await testUtils.testAuthedRequest<any>(router, "/v2/programs", "POST", postBody);
            chai.assert.equal(progResp.statusCode, 422, JSON.stringify(progResp.body));
            chai.assert.equal(progResp.body.messageCode, "BalanceRuleSyntaxError", JSON.stringify(progResp.body));
            chai.assert.isString(progResp.body.syntaxErrorMessage);
            chai.assert.isNumber(progResp.body.row);
            chai.assert.isNumber(progResp.body.column);
        });

        it("422s creating a program with a redemptionRule that does not compile", async () => {
            const postBody: Partial<Program> = {
                id: generateId(),
                name: generateId(),
                currency: "USD",
                balanceRule: {
                    rule: "currentLineItem.lineTotal.subtotal * (0.1)",
                    explanation: "this is fine"
                },
                redemptionRule: {
                    rule: "currentLineItem.lineTotal.subtotal > (0.1",
                    explanation: "unbalanced paranthesis"
                }
            };
            const progResp = await testUtils.testAuthedRequest<any>(router, "/v2/programs", "POST", postBody);
            chai.assert.equal(progResp.statusCode, 422, JSON.stringify(progResp.body));
            chai.assert.equal(progResp.body.messageCode, "RedemptionRuleSyntaxError", JSON.stringify(progResp.body));
            chai.assert.isString(progResp.body.syntaxErrorMessage);
            chai.assert.isNumber(progResp.body.row);
            chai.assert.isNumber(progResp.body.column);
        });
    });

    describe("update validation", () => {
        const updateableProgram: Partial<Program> = {
            id: generateId(),
            name: generateId(),
            currency: "USD"
        };

        before(async () => {
            const createRes = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", updateableProgram);
            chai.assert.equal(createRes.statusCode, 201, `body=${JSON.stringify(createRes.body)}`);
        });

        it("422s updating a program id", async () => {
            const request = {
                id: generateId()
            };
            const resp = await testUtils.testAuthedRequest<Program>(router, `/v2/programs/${updateableProgram.id}`, "PATCH", request);
            chai.assert.equal(resp.statusCode, 422);
        });

        it("422s updating a program to have minInitialBalance > maxInitialBalance", async () => {
            const createRequest: Partial<Program> = {
                id: generateId(),
                name: generateId(),
                currency: "USD",
                minInitialBalance: 5,
                maxInitialBalance: 10
            };
            const createRes = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", createRequest);
            chai.assert.equal(createRes.statusCode, 201);

            const patchRes = await testUtils.testAuthedRequest<Program>(router, `/v2/programs/${createRequest.id}`, "PATCH", {
                minInitialBalance: 15
            });
            chai.assert.equal(patchRes.statusCode, 422);
        });

        it("422s updating a program to a huge minInitialBalance", async () => {
            const request: Partial<Program> = {
                minInitialBalance: 999999999999
            };
            const resp = await testUtils.testAuthedRequest<Program>(router, `/v2/programs/${updateableProgram.id}`, "PATCH", request);
            chai.assert.equal(resp.statusCode, 422);
        });

        it("422s updating a program to a huge maxInitialBalance", async () => {
            const request: Partial<Program> = {
                maxInitialBalance: 999999999999
            };
            const resp = await testUtils.testAuthedRequest<Program>(router, `/v2/programs/${updateableProgram.id}`, "PATCH", request);
            chai.assert.equal(resp.statusCode, 422);
        });

        it("422s updating a program to a huge member of fixedInitialBalances", async () => {
            const request: Partial<Program> = {
                fixedInitialBalances: [0, 1, 999999999999]
            };
            const resp = await testUtils.testAuthedRequest<Program>(router, `/v2/programs/${updateableProgram.id}`, "PATCH", request);
            chai.assert.equal(resp.statusCode, 422);
        });

        it("422s updating a program to a negative member of fixedInitialBalances", async () => {
            const request: Partial<Program> = {
                fixedInitialBalances: [-1, 0]
            };
            const resp = await testUtils.testAuthedRequest<Program>(router, `/v2/programs/${updateableProgram.id}`, "PATCH", request);
            chai.assert.equal(resp.statusCode, 422);
        });

        it("422s updating a program to a huge member of fixedInitialUsesRemaining", async () => {
            const request: Partial<Program> = {
                fixedInitialUsesRemaining: [0, 1, 999999999999]
            };
            const resp = await testUtils.testAuthedRequest<Program>(router, `/v2/programs/${updateableProgram.id}`, "PATCH", request);
            chai.assert.equal(resp.statusCode, 422);
        });

        it("422s updating a program to a negative member of fixedInitialUsesRemaining", async () => {
            const request: Partial<Program> = {
                fixedInitialUsesRemaining: [-1, 0]
            };
            const resp = await testUtils.testAuthedRequest<Program>(router, `/v2/programs/${updateableProgram.id}`, "PATCH", request);
            chai.assert.equal(resp.statusCode, 422);
        });

        it("422s updating a program to have a balanceRule that does not compile", async () => {
            const postBody: Partial<Program> = {
                id: generateId(),
                name: generateId(),
                currency: "USD",
                balanceRule: {
                    rule: "500",
                    explanation: "five hundy"
                }
            };
            const progResp = await testUtils.testAuthedRequest<any>(router, "/v2/programs", "POST", postBody);
            chai.assert.equal(progResp.statusCode, 201, JSON.stringify(progResp.body));

            const patchResp = await testUtils.testAuthedRequest<any>(router, `/v2/programs/${postBody.id}`, "PATCH", {
                balanceRule: {
                    rule: "currentLineItem.lineTotal.subtotal * (0.1",
                    explanation: "unbalanced paranthesis"
                }
            });
            chai.assert.equal(patchResp.body.messageCode, "BalanceRuleSyntaxError", JSON.stringify(patchResp.body));
            chai.assert.equal(patchResp.statusCode, 422, JSON.stringify(patchResp.body));
            chai.assert.isString(patchResp.body.syntaxErrorMessage);
            chai.assert.isNumber(patchResp.body.row);
            chai.assert.isNumber(patchResp.body.column);
        });

        it("422s updating a program to have a redemptionRule that does not compile", async () => {
            const postBody: Partial<Program> = {
                id: generateId(),
                name: generateId(),
                currency: "USD",
                balanceRule: {
                    rule: "currentLineItem.lineTotal.subtotal * (0.1)",
                    explanation: "this is fine"
                },
                redemptionRule: {
                    rule: "1 == 1",
                    explanation: "true"
                }
            };
            const progResp = await testUtils.testAuthedRequest<any>(router, "/v2/programs", "POST", postBody);
            chai.assert.equal(progResp.statusCode, 201, JSON.stringify(progResp.body));

            const patchResp = await testUtils.testAuthedRequest<any>(router, `/v2/programs/${postBody.id}`, "PATCH", {
                redemptionRule: {
                    rule: "currentLineItem.lineTotal.subtotal * (0.1",
                    explanation: "unbalanced paranthesis"
                }
            });
            chai.assert.equal(patchResp.body.messageCode, "RedemptionRuleSyntaxError", JSON.stringify(patchResp.body));
            chai.assert.equal(patchResp.statusCode, 422, JSON.stringify(patchResp.body));
            chai.assert.isString(patchResp.body.syntaxErrorMessage);
            chai.assert.isNumber(patchResp.body.row);
            chai.assert.isNumber(patchResp.body.column);
        });
    });

    describe("handling unicode in IDs", () => {
        it("404s getting a Value by ID with unicode", async () => {
            const programResp = await testUtils.testAuthedRequest<any>(router, "/v2/programs/%F0%9F%92%A9", "GET");
            chai.assert.equal(programResp.statusCode, 404);
            chai.assert.equal(programResp.body.messageCode, "ProgramNotFound");
        });

        it("returns an empty list searching Program by ID with unicode", async () => {
            const programsResp = await testUtils.testAuthedRequest<Value[]>(router, "/v2/programs?id=%F0%9F%92%A9", "GET");
            chai.assert.equal(programsResp.statusCode, 200);
            chai.assert.deepEqual(programsResp.body, []);
        });

        it("returns valid results, when searching ID with the in operator and some values are unicode", async () => {
            const program: Partial<Program> = {
                id: generateId(),
                currency: "USD",
                name: "the program without unicode in the id in a test that has one",
                discount: true
            };
            const createProgram = await testUtils.testAuthedRequest<Value>(router, "/v2/programs", "POST", program);
            chai.assert.equal(createProgram.statusCode, 201, createProgram.bodyRaw);

            const programsResp = await testUtils.testAuthedRequest<Value[]>(router, `/v2/programs?id.in=%F0%9F%92%A9,${program.id}`, "GET");
            chai.assert.equal(programsResp.statusCode, 200);
            chai.assert.deepEqual(programsResp.body, [createProgram.body]);
        });

        it("404s patching a Program by ID with unicode", async () => {
            const patchResp = await testUtils.testAuthedRequest<any>(router, "/v2/programs/%F0%9F%92%A9", "PATCH", {discount: false});
            chai.assert.equal(patchResp.statusCode, 404);
            chai.assert.equal(patchResp.body.messageCode, "ProgramNotFound");
        });

        it("404s deleting a Program by ID with unicode", async () => {
            const deleteResp = await testUtils.testAuthedRequest<any>(router, "/v2/programs/%F0%9F%92%A9", "DELETE");
            chai.assert.equal(deleteResp.statusCode, 404);
            chai.assert.equal(deleteResp.body.messageCode, "ProgramNotFound");
        });
    });

    describe("stats", () => {
        interface Scenario {
            description: string;
            setup: (programId: string) => Promise<void>;
            result: Partial<ProgramStats>;
        }

        const scenarios: Scenario[] = [
            {
                description: "unused",
                setup: async (programId: string) => {
                    const value = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                        id: generateId(),
                        balance: 2,
                        programId
                    });
                    chai.assert.deepEqual(value.statusCode, 201);
                },
                result: {
                    outstanding: {
                        balance: 2,
                        count: 1
                    },
                    expired: {
                        balance: 0,
                        count: 0
                    },
                    canceled: {
                        balance: 0,
                        count: 0
                    },
                    redeemed: {
                        balance: 0,
                        count: 0,
                        transactionCount: 0
                    },
                    checkout: {
                        lightrailSpend: 0,
                        overspend: 0,
                        transactionCount: 0
                    }
                }
            },
            {
                description: "canceled",
                setup: async (programId: string) => {
                    const value = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                        id: generateId(),
                        balance: 100,
                        programId
                    });
                    await testUtils.testAuthedRequest<any>(router, `/v2/values/${value.body.id}`, "PATCH", {
                        canceled: true
                    });
                },
                result: {
                    outstanding: {
                        balance: 0,
                        count: 0
                    },
                    expired: {
                        balance: 0,
                        count: 0
                    },
                    canceled: {
                        balance: 100,
                        count: 1
                    },
                    redeemed: {
                        balance: 0,
                        count: 0,
                        transactionCount: 0
                    },
                    checkout: {
                        lightrailSpend: 0,
                        overspend: 0,
                        transactionCount: 0
                    }
                }
            },
            {
                description: "expired",
                setup: async (programId: string) => {
                    await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                        id: generateId(),
                        balance: 300,
                        programId,
                        endDate: new Date("2011-11-11")
                    });
                },
                result: {
                    outstanding: {
                        balance: 0,
                        count: 0
                    },
                    expired: {
                        balance: 300,
                        count: 1
                    },
                    canceled: {
                        balance: 0,
                        count: 0
                    },
                    redeemed: {
                        balance: 0,
                        count: 0,
                        transactionCount: 0
                    },
                    checkout: {
                        lightrailSpend: 0,
                        overspend: 0,
                        transactionCount: 0
                    }
                }
            },
            {
                description: "canceled and expired",
                setup: async (programId: string) => {
                    const value = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                        id: generateId(),
                        balance: 700,
                        programId,
                        endDate: new Date("2011-11-11")
                    });
                    await testUtils.testAuthedRequest<any>(router, `/v2/values/${value.body.id}`, "PATCH", {
                        canceled: true
                    });
                },
                result: {
                    outstanding: {
                        balance: 0,
                        count: 0
                    },
                    expired: {
                        balance: 0,
                        count: 0
                    },
                    canceled: {
                        balance: 700,
                        count: 1
                    },
                    redeemed: {
                        balance: 0,
                        count: 0,
                        transactionCount: 0
                    },
                    checkout: {
                        lightrailSpend: 0,
                        overspend: 0,
                        transactionCount: 0
                    }
                }
            },
            {
                description: "credit and debit",
                setup: async (programId: string) => {
                    const value = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                        id: generateId(),
                        balance: 10,
                        programId
                    });
                    await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/credit", "POST", {
                        id: generateId(),
                        destination: {
                            rail: "lightrail",
                            valueId: value.body.id
                        },
                        amount: 15,
                        currency: "USD"
                    });
                    await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/debit", "POST", {
                        id: generateId(),
                        source: {
                            rail: "lightrail",
                            valueId: value.body.id
                        },
                        amount: 5,
                        currency: "USD"
                    });
                },
                result: {
                    outstanding: {
                        balance: 20,
                        count: 1
                    },
                    expired: {
                        balance: 0,
                        count: 0
                    },
                    canceled: {
                        balance: 0,
                        count: 0
                    },
                    redeemed: {
                        balance: 5,
                        count: 1,
                        transactionCount: 1
                    },
                    checkout: {
                        lightrailSpend: 0,
                        overspend: 0,
                        transactionCount: 0
                    }
                }
            },
            {
                description: "debit then cancel",
                setup: async (programId: string) => {
                    const value = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                        id: generateId(),
                        balance: 13,
                        programId
                    });
                    await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/debit", "POST", {
                        id: generateId(),
                        source: {
                            rail: "lightrail",
                            valueId: value.body.id
                        },
                        amount: 6,
                        currency: "USD"
                    });
                    await testUtils.testAuthedRequest<any>(router, `/v2/values/${value.body.id}`, "PATCH", {
                        canceled: true
                    });
                },
                result: {
                    outstanding: {
                        balance: 0,
                        count: 0
                    },
                    expired: {
                        balance: 0,
                        count: 0
                    },
                    canceled: {
                        balance: 7,
                        count: 1
                    },
                    redeemed: {
                        balance: 6,
                        count: 1,
                        transactionCount: 1
                    },
                    checkout: {
                        lightrailSpend: 0,
                        overspend: 0,
                        transactionCount: 0
                    }
                }
            },
            {
                description: "debit x 3",
                setup: async (programId: string) => {
                    const value = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                        id: generateId(),
                        balance: 20,
                        programId
                    });
                    await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/debit", "POST", {
                        id: generateId(),
                        source: {
                            rail: "lightrail",
                            valueId: value.body.id
                        },
                        amount: 1,
                        currency: "USD"
                    });
                    await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/debit", "POST", {
                        id: generateId(),
                        source: {
                            rail: "lightrail",
                            valueId: value.body.id
                        },
                        amount: 3,
                        currency: "USD"
                    });
                    await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/debit", "POST", {
                        id: generateId(),
                        source: {
                            rail: "lightrail",
                            valueId: value.body.id
                        },
                        amount: 5,
                        currency: "USD"
                    });
                },
                result: {
                    outstanding: {
                        balance: 11,
                        count: 1
                    },
                    expired: {
                        balance: 0,
                        count: 0
                    },
                    canceled: {
                        balance: 0,
                        count: 0
                    },
                    redeemed: {
                        balance: 9,
                        count: 1,
                        transactionCount: 3
                    },
                    checkout: {
                        lightrailSpend: 0,
                        overspend: 0,
                        transactionCount: 0
                    }
                }
            },
            {
                description: "debit pending capture",
                setup: async (programId: string) => {
                    const value = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                        id: generateId(),
                        balance: 10,
                        programId
                    });
                    const debit = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/debit", "POST", {
                        id: generateId(),
                        source: {
                            rail: "lightrail",
                            valueId: value.body.id
                        },
                        amount: 4,
                        currency: "USD",
                        pending: true
                    });
                    await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${debit.body.id}/capture`, "POST", {
                        id: generateId()
                    });
                },
                result: {
                    outstanding: {
                        balance: 6,
                        count: 1
                    },
                    expired: {
                        balance: 0,
                        count: 0
                    },
                    canceled: {
                        balance: 0,
                        count: 0
                    },
                    redeemed: {
                        balance: 4,
                        count: 1,
                        transactionCount: 1
                    },
                    checkout: {
                        lightrailSpend: 0,
                        overspend: 0,
                        transactionCount: 0
                    }
                }
            },
            {
                description: "debit pending void",
                setup: async (programId: string) => {
                    const value = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                        id: generateId(),
                        balance: 10,
                        programId
                    });
                    const debit = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/debit", "POST", {
                        id: generateId(),
                        source: {
                            rail: "lightrail",
                            valueId: value.body.id
                        },
                        amount: 4,
                        currency: "USD",
                        pending: true
                    });
                    await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${debit.body.id}/void`, "POST", {
                        id: generateId()
                    });
                },
                result: {
                    outstanding: {
                        balance: 10,
                        count: 1
                    },
                    expired: {
                        balance: 0,
                        count: 0
                    },
                    canceled: {
                        balance: 0,
                        count: 0
                    },
                    redeemed: {
                        balance: 0,
                        count: 1,
                        transactionCount: 1
                    },
                    checkout: {
                        lightrailSpend: 0,
                        overspend: 0,
                        transactionCount: 0
                    }
                }
            },
            {
                description: "debit reverse",
                setup: async (programId: string) => {
                    const value = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                        id: generateId(),
                        balance: 10,
                        programId
                    });
                    const debit = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/debit", "POST", {
                        id: generateId(),
                        source: {
                            rail: "lightrail",
                            valueId: value.body.id
                        },
                        amount: 4,
                        currency: "USD"
                    });
                    await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${debit.body.id}/reverse`, "POST", {
                        id: generateId()
                    });
                },
                result: {
                    outstanding: {
                        balance: 10,
                        count: 1
                    },
                    expired: {
                        balance: 0,
                        count: 0
                    },
                    canceled: {
                        balance: 0,
                        count: 0
                    },
                    redeemed: {
                        balance: 0,
                        count: 1,
                        transactionCount: 1
                    },
                    checkout: {
                        lightrailSpend: 0,
                        overspend: 0,
                        transactionCount: 0
                    }
                }
            },
            {
                description: "checkout lightrail",
                setup: async (programId: string) => {
                    const value = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                        id: generateId(),
                        balance: 4,
                        programId
                    });
                    const checkout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", {
                        id: generateId(),
                        lineItems: [
                            {
                                type: "product",
                                productId: "dead-parrot",
                                quantity: 1,
                                unitPrice: 1
                            }
                        ],
                        currency: "USD",
                        sources: [
                            {
                                rail: "lightrail",
                                valueId: value.body.id
                            }
                        ]
                    });
                    chai.assert.equal(checkout.statusCode, 201);
                },
                result: {
                    outstanding: {
                        balance: 3,
                        count: 1
                    },
                    expired: {
                        balance: 0,
                        count: 0
                    },
                    canceled: {
                        balance: 0,
                        count: 0
                    },
                    redeemed: {
                        balance: 1,
                        count: 1,
                        transactionCount: 1
                    },
                    checkout: {
                        lightrailSpend: 1,
                        overspend: 0,
                        transactionCount: 1
                    }
                }
            },
            {
                description: "checkout lightrail balanceRule",
                setup: async (programId: string) => {
                    const value = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                        id: generateId(),
                        balanceRule: {
                            explanation: "100% off",
                            rule: "currentLineItem.lineTotal.remainder"
                        },
                        programId
                    });
                    chai.assert.deepEqual(value.statusCode, 201, JSON.stringify(value.body));
                    const checkout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", {
                        id: generateId(),
                        lineItems: [
                            {
                                type: "product",
                                productId: "log",
                                quantity: 1,
                                unitPrice: 3
                            }
                        ],
                        currency: "USD",
                        sources: [
                            {
                                rail: "lightrail",
                                valueId: value.body.id
                            }
                        ]
                    });
                    chai.assert.deepEqual(checkout.statusCode, 201, JSON.stringify(checkout.body));
                },
                result: {
                    outstanding: {
                        balance: 0,
                        count: 1
                    },
                    expired: {
                        balance: 0,
                        count: 0
                    },
                    canceled: {
                        balance: 0,
                        count: 0
                    },
                    redeemed: {
                        balance: 3,
                        count: 1,
                        transactionCount: 1
                    },
                    checkout: {
                        lightrailSpend: 3,
                        overspend: 0,
                        transactionCount: 1
                    }
                }
            },
            {
                description: "checkout lightrail + internal",
                setup: async (programId: string) => {
                    const value1 = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                        id: generateId(),
                        balance: 20,
                        programId
                    });
                    const checkout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", {
                        id: generateId(),
                        lineItems: [
                            {
                                type: "product",
                                productId: "duff-beer",
                                quantity: 1,
                                unitPrice: 10
                            }
                        ],
                        currency: "USD",
                        sources: [
                            {
                                rail: "lightrail",
                                valueId: value1.body.id
                            },
                            {
                                rail: "internal",
                                internalId: generateId(),
                                balance: 4,
                                beforeLightrail: true
                            }
                        ]
                    });
                    chai.assert.equal(checkout.statusCode, 201);
                },
                result: {
                    outstanding: {
                        balance: 14,
                        count: 1
                    },
                    expired: {
                        balance: 0,
                        count: 0
                    },
                    canceled: {
                        balance: 0,
                        count: 0
                    },
                    redeemed: {
                        balance: 6,
                        count: 1,
                        transactionCount: 1
                    },
                    checkout: {
                        lightrailSpend: 6,
                        overspend: 4,
                        transactionCount: 1
                    }
                }
            },
            {
                description: "checkout lightrail + remainder",
                setup: async (programId: string) => {
                    const value1 = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                        id: generateId(),
                        balance: 4,
                        programId
                    });
                    const checkout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", {
                        id: generateId(),
                        lineItems: [
                            {
                                type: "product",
                                productId: "everlasting-gobstopper",
                                quantity: 1,
                                unitPrice: 15
                            }
                        ],
                        currency: "USD",
                        sources: [
                            {
                                rail: "lightrail",
                                valueId: value1.body.id
                            }
                        ],
                        allowRemainder: true
                    });
                    chai.assert.equal(checkout.statusCode, 201);
                },
                result: {
                    outstanding: {
                        balance: 0,
                        count: 0
                    },
                    expired: {
                        balance: 0,
                        count: 0
                    },
                    canceled: {
                        balance: 0,
                        count: 0
                    },
                    redeemed: {
                        balance: 4,
                        count: 1,
                        transactionCount: 1
                    },
                    checkout: {
                        lightrailSpend: 4,
                        overspend: 11,
                        transactionCount: 1
                    }
                }
            },
            {
                description: "checkout stripe - no value used, so doesn't count towards program stats",
                setup: async (programId: string) => {
                    const checkoutRequest: CheckoutRequest = {
                        id: generateId(),
                        lineItems: [
                            {
                                type: "product",
                                productId: "bachelor-chow",
                                quantity: 1,
                                unitPrice: 50
                            }
                        ],
                        currency: "USD",
                        sources: [
                            {
                                rail: "stripe",
                                source: "tok_visa"
                            }
                        ]
                    };
                    await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkoutRequest);
                },
                result: {
                    outstanding: {
                        balance: 0,
                        count: 0
                    },
                    expired: {
                        balance: 0,
                        count: 0
                    },
                    canceled: {
                        balance: 0,
                        count: 0
                    },
                    redeemed: {
                        balance: 0,
                        count: 0,
                        transactionCount: 0
                    },
                    checkout: {
                        lightrailSpend: 0,
                        overspend: 0,
                        transactionCount: 0
                    }
                }
            },
            {
                description: "checkout 2x lightrail + stripe",
                setup: async (programId: string) => {
                    const value1 = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                        id: generateId(),
                        balance: 4,
                        programId
                    });
                    const value2 = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                        id: generateId(),
                        balance: 4,
                        programId
                    });
                    const checkoutRequest: CheckoutRequest = {
                        id: generateId(),
                        lineItems: [
                            {
                                type: "product",
                                productId: "squishee",
                                quantity: 1,
                                unitPrice: 58
                            }
                        ],
                        currency: "USD",
                        sources: [
                            {
                                rail: "lightrail",
                                valueId: value1.body.id
                            },
                            {
                                rail: "lightrail",
                                valueId: value2.body.id
                            },
                            {
                                rail: "stripe",
                                source: "tok_visa"
                            }
                        ]
                    };
                    await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkoutRequest);
                },
                result: {
                    outstanding: {
                        balance: 0,
                        count: 0
                    },
                    expired: {
                        balance: 0,
                        count: 0
                    },
                    canceled: {
                        balance: 0,
                        count: 0
                    },
                    redeemed: {
                        balance: 8,
                        count: 2,
                        transactionCount: 1
                    },
                    checkout: {
                        lightrailSpend: 8,
                        overspend: 50,
                        transactionCount: 1
                    }
                }
            },
            {
                description: "checkout pending capture",
                setup: async (programId: string) => {
                    const value = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                        id: generateId(),
                        balance: 4,
                        programId
                    });
                    const checkoutRequest: CheckoutRequest = {
                        id: generateId(),
                        lineItems: [
                            {
                                type: "product",
                                productId: "plumbus",
                                quantity: 1,
                                unitPrice: 54
                            }
                        ],
                        currency: "USD",
                        sources: [
                            {
                                rail: "lightrail",
                                valueId: value.body.id
                            },
                            {
                                rail: "stripe",
                                source: "tok_visa"
                            }
                        ],
                        pending: true
                    };
                    const checkout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkoutRequest);
                    await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${checkout.body.id}/capture`, "POST", {id: generateId()});
                },
                result: {
                    outstanding: {
                        balance: 0,
                        count: 0
                    },
                    expired: {
                        balance: 0,
                        count: 0
                    },
                    canceled: {
                        balance: 0,
                        count: 0
                    },
                    redeemed: {
                        balance: 4,
                        count: 1,
                        transactionCount: 1
                    },
                    checkout: {
                        lightrailSpend: 4,
                        overspend: 50,
                        transactionCount: 1
                    }
                }
            },
            {
                description: "checkout pending void",
                setup: async (programId: string) => {
                    const value = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                        id: generateId(),
                        balance: 4,
                        programId
                    });
                    const checkoutRequest: CheckoutRequest = {
                        id: generateId(),
                        lineItems: [
                            {
                                type: "product",
                                productId: "plumbus",
                                quantity: 1,
                                unitPrice: 54
                            }
                        ],
                        currency: "USD",
                        sources: [
                            {
                                rail: "lightrail",
                                valueId: value.body.id
                            },
                            {
                                rail: "stripe",
                                source: "tok_visa"
                            }
                        ],
                        pending: true
                    };
                    const checkout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkoutRequest);
                    await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${checkout.body.id}/void`, "POST", {id: generateId()});
                },
                result: {
                    outstanding: {
                        balance: 4,
                        count: 1
                    },
                    expired: {
                        balance: 0,
                        count: 0
                    },
                    canceled: {
                        balance: 0,
                        count: 0
                    },
                    redeemed: {
                        balance: 0,
                        count: 1,
                        transactionCount: 1
                    },
                    checkout: {
                        lightrailSpend: 0,
                        overspend: 0,
                        transactionCount: 1
                    }
                }
            },
            {
                description: "checkout reverse",
                setup: async (programId: string) => {
                    const value = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                        id: generateId(),
                        balance: 4,
                        programId
                    });
                    const checkoutRequest: CheckoutRequest = {
                        id: generateId(),
                        lineItems: [
                            {
                                type: "product",
                                productId: "plumbus",
                                quantity: 1,
                                unitPrice: 54
                            }
                        ],
                        currency: "USD",
                        sources: [
                            {
                                rail: "lightrail",
                                valueId: value.body.id
                            },
                            {
                                rail: "stripe",
                                source: "tok_visa"
                            }
                        ]
                    };
                    const checkout = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/checkout", "POST", checkoutRequest);
                    await testUtils.testAuthedRequest<Transaction>(router, `/v2/transactions/${checkout.body.id}/reverse`, "POST", {id: generateId()});
                },
                result: {
                    outstanding: {
                        balance: 4,
                        count: 1
                    },
                    expired: {
                        balance: 0,
                        count: 0
                    },
                    canceled: {
                        balance: 0,
                        count: 0
                    },
                    redeemed: {
                        balance: 0,
                        count: 1,
                        transactionCount: 1
                    },
                    checkout: {
                        lightrailSpend: 0,
                        overspend: 0,
                        transactionCount: 1
                    }
                }
            },
        ];

        function buildScenarioTest(scenario: Scenario): void {
            it(scenario.description, async () => {
                const programId = generateId();
                const progResp = await testUtils.testAuthedRequest<any>(router, "/v2/programs", "POST", {
                    id: programId,
                    name: generateId(),
                    currency: "USD"
                });
                chai.assert.equal(progResp.statusCode, 201, JSON.stringify(progResp.body));

                await scenario.setup(programId);

                const statsResp = await testUtils.testAuthedRequest<any>(router, `/v2/programs/${programId}/stats`, "GET");
                chai.assert.equal(statsResp.statusCode, 200, JSON.stringify(statsResp.body));
                chai.assert.deepEqual(statsResp.body, scenario.result);
            }).timeout(15000);
        }

        // Run each scenario individually.
        scenarios.forEach(buildScenarioTest);

        // Run all the scenarios together for one result.
        buildScenarioTest({
            description: "all together",
            setup: async (programId: string) => {
                for (const scenario of scenarios) {
                    await scenario.setup(programId);
                }
            },
            result: scenarios.reduce(
                (result, scenario) => {
                    const r: any = {};
                    for (const key1 in scenario.result) {
                        r[key1] = {};
                        for (const key2 in scenario.result[key1]) {
                            r[key1][key2] = result[key1][key2] + scenario.result[key1][key2];
                        }
                    }
                    return r;
                },
                {
                    outstanding: {
                        balance: 0,
                        count: 0
                    },
                    expired: {
                        balance: 0,
                        count: 0
                    },
                    canceled: {
                        balance: 0,
                        count: 0
                    },
                    redeemed: {
                        balance: 0,
                        count: 0,
                        transactionCount: 0
                    },
                    checkout: {
                        lightrailSpend: 0,
                        overspend: 0,
                        transactionCount: 0
                    }
                }
            )
        });
    });

    it("can create program with maximum id length", async () => {
        const program: Partial<Program> = {
            id: generateId(64),
            currency: "USD",
            name: "name"
        };
        chai.assert.equal(program.id.length, 64);

        const createProgram = await testUtils.testAuthedRequest<Program>(router, `/v2/programs`, "POST", program);
        chai.assert.equal(createProgram.statusCode, 201);
        chai.assert.equal(createProgram.body.id, program.id);
    });

    it("cannot create program with id exceeding max length of 64 - returns 422", async () => {
        const program: Partial<Program> = {
            id: generateId(65),
            currency: "USD",
            name: "name"
        };
        chai.assert.equal(program.id.length, 65);

        const createProgram = await testUtils.testAuthedRequest<cassava.RestError>(router, `/v2/programs`, "POST", program);
        chai.assert.equal(createProgram.statusCode, 422);
        chai.assert.include(createProgram.body.message, "requestBody.id does not meet maximum length of 64");
    });

    it("can't delete a program that doesn't exist - returns 404", async () => {
        const deleteResp = await testUtils.testAuthedRequest(router, `/v2/programs/${programRequest.id}`, "DELETE");
        chai.assert.equal(deleteResp.statusCode, 404);
    });

    it("can create a value from a program with a balanceRule", async () => {
        const program: Partial<Program> = {
            id: generateId(),
            name: "10% off a ride",
            currency: "USD",
            pretax: true,
            discount: true,
            fixedInitialUsesRemaining: [
                1
            ],
            balanceRule: {
                rule: "currentLineItem.lineTotal.subtotal * 0.10",
                explanation: "10% off a ride"
            }
        };
        const createProgram = await testUtils.testAuthedRequest<Value>(router, "/v2/programs", "POST", program);
        chai.assert.equal(createProgram.statusCode, 201);

        const value: Partial<Value> = {
            id: generateId(),
            programId: program.id,
            usesRemaining: 1
        };
        const createValue = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
        chai.assert.equal(createValue.statusCode, 201);
        chai.assert.deepEqual(createValue.body.balanceRule, program.balanceRule);
        chai.assert.isNull(createValue.body.balance);
    });

    describe("filter by name", () => {
        let programA: Program, programB: Program;

        before(async () => {
            const createA = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", {
                id: generateId(),
                name: "a",
                currency: "USD"
            });
            chai.assert.equal(createA.statusCode, 201);
            programA = createA.body;

            const createB = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", {
                id: generateId(),
                name: "b",
                currency: "USD"
            });
            chai.assert.equal(createB.statusCode, 201);
            programB = createB.body;

            const createOther = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", {
                id: generateId(),
                name: "c",
                currency: "USD"
            });
            chai.assert.equal(createOther.statusCode, 201);
        });

        it("filter by name with no operator", async () => {
            const get = await testUtils.testAuthedRequest<Program[]>(router, "/v2/programs?name=a", "GET");
            chai.assert.equal(get.statusCode, 200);
            chai.assert.deepEqual(get.body[0], programA);
        });

        it("filter by name with eq operator", async () => {
            const get = await testUtils.testAuthedRequest<Program[]>(router, "/v2/programs?name.eq=a", "GET");
            chai.assert.equal(get.statusCode, 200);
            chai.assert.deepEqual(get.body[0], programA);
        });

        it("filter by name with in operator", async () => {
            const get = await testUtils.testAuthedRequest<Program[]>(router, "/v2/programs?name.in=a,b", "GET");
            chai.assert.equal(get.statusCode, 200);
            chai.assert.sameDeepMembers(get.body, [programA, programB]);
        });
    });

    it("can't create a program with a balanceRule and fixedInitialBalances", async () => {
        const program: Partial<Program> = {
            id: generateId(),
            name: "name " + generateId(5),
            currency: "USD",
            balanceRule: {
                rule: "500",
                explanation: "$5 off everything!"
            },
            fixedInitialBalances: [1]
        };
        const create = await testUtils.testAuthedRequest<cassava.RestError>(router, "/v2/programs", "POST", program);
        chai.assert.equal(create.statusCode, 422);
        chai.assert.equal(create.body.message, "Program cannot have a balanceRule when also defining minInitialBalance, maxInitialBalance or fixedInitialBalances.");
    });

    it("can't create a program with a balanceRule and minInitialBalance", async () => {
        const program: Partial<Program> = {
            id: generateId(),
            name: "name " + generateId(5),
            currency: "USD",
            balanceRule: {
                rule: "500",
                explanation: "$5 off everything!"
            },
            minInitialBalance: 0
        };
        const create = await testUtils.testAuthedRequest<cassava.RestError>(router, "/v2/programs", "POST", program);
        chai.assert.equal(create.statusCode, 422);
        chai.assert.equal(create.body.message, "Program cannot have a balanceRule when also defining minInitialBalance, maxInitialBalance or fixedInitialBalances.");
    });

    it("can't create a program with a balanceRule and maxInitialBalance", async () => {
        const program: Partial<Program> = {
            id: generateId(),
            name: "name " + generateId(5),
            currency: "USD",
            balanceRule: {
                rule: "500",
                explanation: "$5 off everything!"
            },
            maxInitialBalance: 0
        };
        const create = await testUtils.testAuthedRequest<cassava.RestError>(router, "/v2/programs", "POST", program);
        chai.assert.equal(create.statusCode, 422);
        chai.assert.equal(create.body.message, "Program cannot have a balanceRule when also defining minInitialBalance, maxInitialBalance or fixedInitialBalances.");
    });

    it("can't create a program with fixedInitialBalances and min/maxInitialBalance", async () => {
        const program: Partial<Program> = {
            id: generateId(),
            name: "name " + generateId(5),
            currency: "USD",
            fixedInitialBalances: [200],
            minInitialBalance: 0,
            maxInitialBalance: 100
        };
        const create = await testUtils.testAuthedRequest<cassava.RestError>(router, "/v2/programs", "POST", program);
        chai.assert.equal(create.statusCode, 422);
        chai.assert.equal(create.body.message, "Program cannot have fixedInitialBalances defined when also defining minInitialBalance or maxInitialBalance");
    });

    describe("discountSellerLiability", () => {
        // can be removed when discountSellerLiability is dropped from API responses
        it("can create program with discountSellerLiability set", async () => {
            const program: Partial<Program> = {
                id: generateId(),
                name: "name",
                currency: "USD",
                discount: true,
                discountSellerLiability: 0.25
            };
            const create = await testUtils.testAuthedRequest<Program>(router, `/v2/programs`, "POST", program);
            chai.assert.equal(create.statusCode, 201, `body=${JSON.stringify(create.body)}`);
            chai.assert.equal(create.body.discountSellerLiability, 0.25);
            chai.assert.deepEqual(create.body.discountSellerLiabilityRule, {
                rule: "0.25",
                explanation: "Seller 25% liable"
            });
        });

        it("can create program with discountSellerLiabilityRule set - set as decimal WILL populate discountSellerLiability in response", async () => {
            const program: Partial<Program> = {
                id: generateId(),
                name: "name",
                currency: "USD",
                discount: true,
                discountSellerLiabilityRule: {
                    rule: "0.25",
                    explanation: "Seller 25% liable"
                }
            };
            const create = await testUtils.testAuthedRequest<Program>(router, `/v2/programs`, "POST", program);
            chai.assert.equal(create.statusCode, 201, `body=${JSON.stringify(create.body)}`);
            chai.assert.equal(create.body.discountSellerLiability, 0.25, "should be set because the rule is a number");
            chai.assert.deepEqual(create.body.discountSellerLiabilityRule, program.discountSellerLiabilityRule);
        });

        it("can create program with discountSellerLiabilityRule set - set as rule WILL NOT populate discountSellerLiability in response", async () => {
            const program: Partial<Program> = {
                id: generateId(),
                name: "name",
                currency: "USD",
                discount: true,
                discountSellerLiabilityRule: {
                    rule: "1 - currentLineItem.marketplaceRate",
                    explanation: "proportional to marketplace rate"
                }
            };
            const create = await testUtils.testAuthedRequest<Program>(router, `/v2/programs`, "POST", program);
            chai.assert.equal(create.statusCode, 201, `body=${JSON.stringify(create.body)}`);
            chai.assert.isNull(create.body.discountSellerLiability, "should be null because the rule isn't a number");
            chai.assert.deepEqual(create.body.discountSellerLiabilityRule, program.discountSellerLiabilityRule);
        });

        // can be removed when discountSellerLiability is dropped from API responses
        it("can update discountSellerLiability from null", async () => {
            const program: Partial<Program> = {
                id: generateId(),
                name: "name",
                currency: "USD",
                discount: true
            };
            const create = await testUtils.testAuthedRequest<Program>(router, `/v2/programs`, "POST", program);
            chai.assert.equal(create.statusCode, 201, `body=${JSON.stringify(create.body)}`);

            const update = await testUtils.testAuthedRequest<Program>(router, `/v2/programs/${program.id}`, "PATCH", {discountSellerLiability: 1.0});
            chai.assert.equal(update.statusCode, 200, `body=${JSON.stringify(update.body)}`);
            chai.assert.equal(update.body.discountSellerLiability, 1.0);
            chai.assert.deepEqual(update.body.discountSellerLiabilityRule, {
                    rule: "1",
                    explanation: "Seller 100% liable"
                }
            );
        });

        it("can update discountSellerLiabilityRule from null", async () => {
            const program: Partial<Program> = {
                id: generateId(),
                name: "name",
                currency: "USD",
                discount: true
            };
            const create = await testUtils.testAuthedRequest<Program>(router, `/v2/programs`, "POST", program);
            chai.assert.equal(create.statusCode, 201, `body=${JSON.stringify(create.body)}`);

            const discountSellerLiabilityRule: Rule = {
                rule: "0.05",
                explanation: "5%"
            };
            const programUpdate: Partial<Program> = {
                discountSellerLiabilityRule: discountSellerLiabilityRule
            };
            const update = await testUtils.testAuthedRequest<Value>(router, `/v2/programs/${program.id}`, "PATCH", programUpdate);
            chai.assert.equal(update.statusCode, 200, `body=${JSON.stringify(update.body)}`);
            chai.assert.deepEqual(update.body.discountSellerLiabilityRule, {
                rule: "0.05",
                explanation: "5%"
            });
            chai.assert.equal(update.body.discountSellerLiability, 0.05, "should be set since the rule is a number");
        });

        it("can update discountSellerLiability from a number to a rule", async () => {
            const program: Partial<Program> = {
                id: generateId(),
                name: "name",
                currency: "USD",
                discount: true,
                discountSellerLiability: 0.25
            };
            const create = await testUtils.testAuthedRequest<Program>(router, `/v2/programs`, "POST", program);
            chai.assert.equal(create.statusCode, 201, `body=${JSON.stringify(create.body)}`);
            chai.assert.equal(create.body.discountSellerLiability, 0.25);
            chai.assert.deepEqual(create.body.discountSellerLiabilityRule, {
                rule: "0.25",
                explanation: "Seller 25% liable"
            });

            const discountSellerLiabilityRule: Rule = {
                rule: "1 - currentLineItem.marketplaceRate",
                explanation: "proportional to marketplace rate"
            };
            const programUpdate: Partial<Program> = {
                discountSellerLiabilityRule: discountSellerLiabilityRule
            };
            const update = await testUtils.testAuthedRequest<Program>(router, `/v2/programs/${program.id}`, "PATCH", programUpdate);
            chai.assert.equal(update.statusCode, 200, `body=${JSON.stringify(update.body)}`);
            chai.assert.deepEqual(update.body.discountSellerLiabilityRule, discountSellerLiabilityRule);
            chai.assert.isNull(update.body.discountSellerLiability, "should not be set since the rule isn't a number");
        });

        // can be removed when discountSellerLiability is dropped from API responses
        it("can update discountSellerLiability from a rule to a number", async () => {
            const program: Partial<Program> = {
                id: generateId(),
                name: "name",
                currency: "USD",
                discount: true,
                discountSellerLiabilityRule: {
                    rule: "1 - currentLineItem.marketplaceRate",
                    explanation: "proportional to marketplaceRate"
                }
            };
            const create = await testUtils.testAuthedRequest<Program>(router, `/v2/programs`, "POST", program);
            chai.assert.equal(create.statusCode, 201, `body=${JSON.stringify(create.body)}`);
            chai.assert.isNull(create.body.discountSellerLiability);
            chai.assert.deepEqual(create.body.discountSellerLiabilityRule, program.discountSellerLiabilityRule);

            const programUpdate: Partial<Value> = {
                discountSellerLiability: 0.50
            };
            const update = await testUtils.testAuthedRequest<Program>(router, `/v2/programs/${program.id}`, "PATCH", programUpdate);
            chai.assert.equal(update.statusCode, 200, `body=${JSON.stringify(update.body)}`);
            chai.assert.equal(update.body.discountSellerLiability, 0.50);
            chai.assert.deepEqual(update.body.discountSellerLiabilityRule, {
                rule: "0.5",
                explanation: "Seller 50% liable"
            });
        });

        // can be removed when discountSellerLiability is dropped from API responses
        it("can't set discountSellerLiability to be a rule", async () => {
            const program: any = {
                id: generateId(),
                name: "name",
                currency: "USD",
                discount: true,
                discountSellerLiability: {
                    rule: "0.05",
                    explanation: "5% off"
                }
            };
            const create = await testUtils.testAuthedRequest<Program>(router, `/v2/programs`, "POST", program);
            chai.assert.equal(create.statusCode, 422, `body=${JSON.stringify(create.body)}`);
        });

        // can be removed when discountSellerLiability is dropped from API responses
        it("can't set discountSellerLiability and discountSellerLiabilityRule at same time", async () => {
            const program: Partial<Program> = {
                id: generateId(),
                name: "name",
                currency: "USD",
                discount: true,
                discountSellerLiability: null,
                discountSellerLiabilityRule: {
                    rule: "0.05",
                    explanation: "5% off"
                }
            };
            const create = await testUtils.testAuthedRequest<Program>(router, `/v2/programs`, "POST", program);
            chai.assert.equal(create.statusCode, 422, `body=${JSON.stringify(create.body)}`);
        });

        // can be removed when discountSellerLiability is dropped from API responses
        it("can't can't create program with discountSellerLiability if discount: false", async () => {
            const program: Partial<Program> = {
                id: generateId(),
                name: "name",
                currency: "USD",
                discount: false,
                discountSellerLiability: 0.25
            };
            const create = await testUtils.testAuthedRequest<Value>(router, `/v2/programs`, "POST", program);
            chai.assert.equal(create.statusCode, 422, JSON.stringify(create.body));
        });

        it("can't create program with discountSellerLiabilityRule if discount: false", async () => {
            const program: Partial<Program> = {
                id: generateId(),
                name: "name",
                currency: "USD",
                discount: false,
                discountSellerLiabilityRule: {
                    rule: "0.05",
                    explanation: "5% off"
                }
            };
            const create = await testUtils.testAuthedRequest<Value>(router, `/v2/programs`, "POST", program);
            chai.assert.equal(create.statusCode, 422, JSON.stringify(create.body));
        });

        // can be removed when discountSellerLiability is dropped from API responses
        it("can't update discount to be false if discountSellerLiability is set", async () => {
            const program: Partial<Program> = {
                id: generateId(),
                name: "name",
                currency: "USD",
                discount: true,
                discountSellerLiability: 0.25
            };
            const create = await testUtils.testAuthedRequest<Program>(router, `/v2/programs`, "POST", program);
            chai.assert.equal(create.statusCode, 201, `body=${JSON.stringify(create.body)}`);
            chai.assert.equal(create.body.discountSellerLiability, 0.25);
            chai.assert.deepEqual(create.body.discountSellerLiabilityRule, {
                rule: "0.25",
                explanation: "Seller 25% liable"
            });

            const update = await testUtils.testAuthedRequest<Program>(router, `/v2/programs/${program.id}`, "PATCH", {
                discount: false
            });
            chai.assert.equal(update.statusCode, 422, `body=${JSON.stringify(update.body)}`);
        });

        it("can't update discount to be false if discountSellerLiabilityRule is set", async () => {
            const program: Partial<Program> = {
                id: generateId(),
                name: "name",
                currency: "USD",
                discount: true,
                discountSellerLiabilityRule: {
                    rule: "0.25",
                    explanation: "25%"
                }
            };
            const create = await testUtils.testAuthedRequest<Program>(router, `/v2/programs`, "POST", program);
            chai.assert.equal(create.statusCode, 201, `body=${JSON.stringify(create.body)}`);
            chai.assert.deepEqual(create.body.discountSellerLiabilityRule, {
                    rule: "0.25",
                    explanation: "25%"
                }
            );

            const update = await testUtils.testAuthedRequest<Program>(router, `/v2/programs/${program.id}`, "PATCH", {
                discount: false
            });
            chai.assert.equal(update.statusCode, 422, `body=${JSON.stringify(update.body)}`);
        });

        it("can't set discountSellerLiabilityRule to a rule that doesn't compile", async () => {
            const program: Partial<Program> = {
                id: generateId(),
                name: "name",
                currency: "USD",
                discount: true,
                discountSellerLiabilityRule: {
                    rule: "currentLineItem.lineTotal.subtotal * (0.1",
                    explanation: "unclosed parenthesis"
                }
            };
            const create = await testUtils.testAuthedRequest<Program>(router, `/v2/programs`, "POST", program);
            chai.assert.equal(create.statusCode, 422, `body=${JSON.stringify(create.body)}`);
        });

        it("can't set discountSellerLiabilityRule to a rule that evaluate to a number less than 0", async () => {
            const program: Partial<Program> = {
                id: generateId(),
                name: "name",
                currency: "USD",
                discount: true,
                discountSellerLiabilityRule: {
                    rule: "-1",
                    explanation: "must be between 0 and 1"
                }
            };
            const create = await testUtils.testAuthedRequest<Program>(router, `/v2/programs`, "POST", program);
            chai.assert.equal(create.statusCode, 422, `body=${JSON.stringify(create.body)}`);
        });

        it("can't set discountSellerLiabilityRule to a rule that evaluate to a number greater than 1", async () => {
            const program: Partial<Program> = {
                id: generateId(),
                name: "name",
                currency: "USD",
                discount: true,
                discountSellerLiabilityRule: {
                    rule: "1.1",
                    explanation: "must be between 0 and 1"
                }
            };
            const create = await testUtils.testAuthedRequest<Program>(router, `/v2/programs`, "POST", program);
            chai.assert.equal(create.statusCode, 422, `body=${JSON.stringify(create.body)}`);
        });

        // can be removed when discountSellerLiability is dropped from API responses
        it("can set discountSellerLiability: null, if discount: false", async () => {
            const program: Partial<Program> = {
                id: generateId(),
                name: "name",
                currency: "USD",
                discount: false,
                discountSellerLiability: null
            };
            const create = await testUtils.testAuthedRequest<Program>(router, `/v2/programs`, "POST", program);
            chai.assert.equal(create.statusCode, 201, `body=${JSON.stringify(create.body)}`);
        });

        it("can set discountSellerLiabilityRule: null, if discount: false", async () => {
            const program: Partial<Program> = {
                id: generateId(),
                name: "name",
                currency: "USD",
                discount: false,
                discountSellerLiabilityRule: null
            };
            const create = await testUtils.testAuthedRequest<Program>(router, `/v2/programs`, "POST", program);
            chai.assert.equal(create.statusCode, 201, `body=${JSON.stringify(create.body)}`);
        });

        it("can set both discountSellerLiabilityRule: null and discountSellerLiability: null", async () => {
            const program: Partial<Program> = {
                id: generateId(),
                name: "name",
                currency: "USD",
                discount: false,
                discountSellerLiability: null,
                discountSellerLiabilityRule: null
            };
            const create = await testUtils.testAuthedRequest<Value>(router, `/v2/programs`, "POST", program);
            chai.assert.equal(create.statusCode, 201, `body=${JSON.stringify(create.body)}`);
        });
    });

    it("can't create a program with duplicate fixedInitialUsesRemaining", async () => {
        const program: Partial<Program> = {
            id: generateId(),
            name: "name " + generateId(5),
            currency: "USD",
            fixedInitialUsesRemaining: [1, 1, 2]
        };
        const create = await testUtils.testAuthedRequest<cassava.RestError>(router, "/v2/programs", "POST", program);
        chai.assert.equal(create.statusCode, 422);
    });

    let programForPatch: Program;
    it("can create a program with distinct fixedInitialUsesRemaining", async () => {
        const program: Partial<Program> = {
            id: generateId(),
            name: "name " + generateId(5),
            currency: "USD",
            fixedInitialUsesRemaining: [1, 2, 3]
        };
        const create = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", program);
        chai.assert.equal(create.statusCode, 201);
        programForPatch = create.body;
    });

    it("can't patch a program with duplicated fixedInitialUsesRemaining", async () => {
        chai.assert.isNotNull(programForPatch);

        const patch = await testUtils.testAuthedRequest<cassava.RestError>(router, `/v2/programs/${programForPatch.id}`, "PATCH", {
            fixedInitialUsesRemaining: [1, 1, 2]
        });
        chai.assert.equal(patch.statusCode, 422);
    });

    it("can't create a program with duplicate fixedInitialBalances", async () => {
        const program: Partial<Program> = {
            id: generateId(),
            name: "name " + generateId(5),
            currency: "USD",
            fixedInitialBalances: [1, 1, 2]
        };
        const create = await testUtils.testAuthedRequest<cassava.RestError>(router, "/v2/programs", "POST", program);
        chai.assert.equal(create.statusCode, 422);
    });

    it("can create a program with distinct fixedInitialBalances", async () => {
        const program: Partial<Program> = {
            id: generateId(),
            name: "name " + generateId(5),
            currency: "USD",
            fixedInitialBalances: [1, 2, 3]
        };
        const create = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", program);
        chai.assert.equal(create.statusCode, 201);
    });

    it("can't patch a program with duplicated fixedInitialBalances", async () => {
        chai.assert.isNotNull(programForPatch);

        const patch = await testUtils.testAuthedRequest<cassava.RestError>(router, `/v2/programs/${programForPatch.id}`, "PATCH", {
            fixedInitialBalances: [1, 1, 2]
        });
        chai.assert.equal(patch.statusCode, 422);
    });

    it("can filter by isNull", async () => {
        const list = await testUtils.testAuthedRequest<Program[]>(router, "/v2/programs?endDate.isNull=true", "GET");
        chai.assert.equal(list.statusCode, 200, "The isNull functionality is tested through filterQuery tests. This test just ensures the isNull operator is allowed on endDate.");
    });

    it("can filter by orNull", async () => {
        const list = await testUtils.testAuthedRequest<Program[]>(router, "/v2/programs?endDate.gt=2019-01-01&endDate.orNull=true", "GET");
        chai.assert.equal(list.statusCode, 200, "The orNull functionality is tested through filterQuery tests. This test just ensures the orNull operator is allowed on endDate.");
    });

    describe("whitespace handling", () => {
        it("422s creating programIds with leading/trailing whitespace", async () => {
            const createLeadingResp = await testUtils.testAuthedRequest<cassava.RestError>(router, "/v2/programs", "POST", {
                id: `\r${testUtils.generateId()}`,
                currency: "USD",
                name: "Irrelevant test program"
            });
            chai.assert.equal(createLeadingResp.statusCode, 422, `createLeadingResp.body=${JSON.stringify(createLeadingResp.body)}`);

            const createTrailingResp = await testUtils.testAuthedRequest<cassava.RestError>(router, "/v2/values", "POST", {
                id: `${testUtils.generateId()}\v`,
                currency: "USD",
                name: "Irrelevant test program"
            });
            chai.assert.equal(createTrailingResp.statusCode, 422, `createTrailingResp.body=${JSON.stringify(createTrailingResp.body)}`);
        });

        it("404s when looking up a program by id with leading/trailing whitespace", async () => {
            const programResp = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", {
                id: testUtils.generateId(),
                currency: "USD",
                name: "Another test program"
            });
            chai.assert.equal(programResp.statusCode, 201, `programResp.body=${JSON.stringify(programResp.body)}`);
            const program = programResp.body;

            const fetchLeadingResp = await testUtils.testAuthedRequest<cassava.RestError>(router, `/v2/programs/%20${program.id}`, "GET");
            chai.assert.equal(fetchLeadingResp.statusCode, 404, `fetchLeadingResp.body=${JSON.stringify(fetchLeadingResp.body)}`);
            const fetchTrailingResp = await testUtils.testAuthedRequest<cassava.RestError>(router, `/v2/programs/${program.id}%20`, "GET");
            chai.assert.equal(fetchTrailingResp.statusCode, 404, `fetchLeadingResp.body=${JSON.stringify(fetchTrailingResp.body)}`);
        });

        describe("FK references to programIds", () => {
            let programForFKReferences;
            before(async () => {
                const programResp = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", {
                    id: testUtils.generateId(),
                    currency: "USD",
                    name: "Irreverent test program"
                });
                chai.assert.equal(programResp.statusCode, 201, `programResp.body=${JSON.stringify(programResp.body)}`);
                programForFKReferences = programResp.body;
            });

            it("404s creating values from programIds with leading/trailing whitespace", async () => {
                const createValueLeadingResp = await testUtils.testAuthedRequest<cassava.RestError>(router, "/v2/values", "POST", {
                    id: testUtils.generateId(),
                    programId: `\t${programForFKReferences.id}`,
                    balance: 1
                });
                chai.assert.equal(createValueLeadingResp.statusCode, 404, `createValueLeadingResp.body=${JSON.stringify(createValueLeadingResp.body)}`);
                chai.assert.equal(createValueLeadingResp.body["messageCode"], "ProgramNotFound", `createValueLeadingResp.body=${JSON.stringify(createValueLeadingResp.body)}`);

                const createValueTrailingResp = await testUtils.testAuthedRequest<cassava.RestError>(router, "/v2/values", "POST", {
                    id: testUtils.generateId(),
                    programId: `${programForFKReferences.id}\t`,
                    balance: 1
                });
                chai.assert.equal(createValueTrailingResp.statusCode, 404, `createValueTrailingResp.body=${JSON.stringify(createValueTrailingResp.body)}`);
                chai.assert.equal(createValueTrailingResp.body["messageCode"], "ProgramNotFound", `createValueTrailingResp.body=${JSON.stringify(createValueTrailingResp.body)}`);
            });

            it("does not find values when searching by programId with leading/trailing whitespace", async () => {
                const createValueResp = await testUtils.testAuthedRequest<cassava.RestError>(router, "/v2/values", "POST", {
                    id: testUtils.generateId(),
                    programId: programForFKReferences.id,
                    balance: 1
                });
                chai.assert.equal(createValueResp.statusCode, 201, `createValueResp.body=${JSON.stringify(createValueResp.body)}`);

                const searchValuesLeadingResp = await testUtils.testAuthedRequest<Value[]>(router, `/v2/values?programId=$%20{programForFKReferences.id}`, "GET");
                chai.assert.equal(searchValuesLeadingResp.statusCode, 200, `searchValuesLeadingResp.body=${JSON.stringify(searchValuesLeadingResp.body)}`);
                chai.assert.equal(searchValuesLeadingResp.body.length, 0, `searchValuesLeadingResp.body=${JSON.stringify(searchValuesLeadingResp.body)}`);

                const searchValuesTrailingResp = await testUtils.testAuthedRequest<Value[]>(router, `/v2/values?programId=${programForFKReferences.id}%20`, "GET");
                chai.assert.equal(searchValuesTrailingResp.statusCode, 200, `searchValuesTrailingResp.body=${JSON.stringify(searchValuesTrailingResp.body)}`);
                chai.assert.equal(searchValuesTrailingResp.body.length, 0, `searchValuesTrailingResp.body=${JSON.stringify(searchValuesTrailingResp.body)}`);
            });

            it("404s creating issuances from programIds with leading/trailing whitespace", async () => {
                const issuanceLeadingResp = await testUtils.testAuthedRequest<cassava.RestError>(router, `/v2/programs/%0D%0A${programForFKReferences.id}/issuances`, "POST", {
                    id: testUtils.generateId(),
                    name: testUtils.generateId(),
                    count: 1
                });
                chai.assert.equal(issuanceLeadingResp.statusCode, 404, `issuanceLeadingResp.body=${JSON.stringify(issuanceLeadingResp.body)}`);
                chai.assert.equal(issuanceLeadingResp.body["messageCode"], "ProgramNotFound", `issuanceLeadingResp.body=${JSON.stringify(issuanceLeadingResp.body)}`);

                const issuanceTrailingResp = await testUtils.testAuthedRequest<cassava.RestError>(router, `/v2/programs/${programForFKReferences.id}%20/issuances`, "POST", {
                    id: testUtils.generateId(),
                    name: testUtils.generateId(),
                    count: 1
                });
                chai.assert.equal(issuanceTrailingResp.statusCode, 404, `issuanceTrailingResp.body=${JSON.stringify(issuanceTrailingResp.body)}`);
                chai.assert.equal(issuanceTrailingResp.body["messageCode"], "ProgramNotFound", `issuanceTrailingResp.body=${JSON.stringify(issuanceTrailingResp.body)}`);
            });
        });
    });
});
