import * as cassava from "cassava";
import * as chai from "chai";
import * as testUtils from "../../../utils/testUtils/index";
import {generateId} from "../../../utils/testUtils/index";
import {installRestRoutes} from "../installRestRoutes";
import {createCurrency} from "../currencies";
import {Program} from "../../../model/Program";
import {Value} from "../../../model/Value";
import {dateInDbPrecision, nowInDbPrecision} from "../../../utils/dbUtils/index";

describe("/v2/values create from program", () => {

    const router = new cassava.Router();

    before(async () => {
        await testUtils.resetDb();
        router.route(testUtils.authRoute);
        installRestRoutes(router);
        await createCurrency(testUtils.defaultTestUser.auth, {
            code: "USD",
            name: "US Dollars",
            symbol: "$",
            decimalPlaces: 2,
            createdDate: nowInDbPrecision(),
            updatedDate: nowInDbPrecision(),
            createdBy: testUtils.defaultTestUser.teamMemberId
        });
        await createCurrency(testUtils.defaultTestUser.auth, {
            code: "CAD",
            name: "Canadian Dollars",
            symbol: "$",
            decimalPlaces: 2,
            createdDate: nowInDbPrecision(),
            updatedDate: nowInDbPrecision(),
            createdBy: testUtils.defaultTestUser.teamMemberId
        });
    });

    it("can create a value with programId = null", async () => {
        const value: Partial<Value> = {
            id: generateId(),
            currency: "USD",
            programId: null
        };

        const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
        chai.assert.equal(valueResp.statusCode, 201, JSON.stringify(valueResp.body));
    });

    it("can't create a value with a programId that doesn't exist", async () => {
        const value: Partial<Value> = {
            id: generateId(),
            currency: "USD",
            programId: generateId()
        };

        const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
        chai.assert.equal(valueResp.statusCode, 404, JSON.stringify(valueResp.body));
    });

    describe(`creating Values from Program with no balance constraints or value balanceRule`, () => {
        const program: Partial<Program> = {
            id: generateId(),
            name: "program with no balance constraints or balanceRule",
            currency: "USD"
        };

        const programProperties = Object.keys(program);
        it("can create Program", async () => {
            const programResp = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", program);
            chai.assert.equal(programResp.statusCode, 201, JSON.stringify(programResp.body));
            for (const prop of programProperties) {
                chai.assert.equal(programResp.body[prop], program[prop]);
            }
        });

        const value: Partial<Value> = {
            programId: program.id
        };

        it("can't create Value with currency != program.currency", async () => {
            const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                ...value,
                id: generateId(),
                currency: "CAD"
            });
            chai.assert.equal(valueResp.statusCode, 409, JSON.stringify(valueResp.body));
        });

        it("can create Value", async () => {
            const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                ...value,
                id: generateId()
            });
            chai.assert.equal(valueResp.statusCode, 201, JSON.stringify(valueResp.body));
            chai.assert.equal(valueResp.body.currency, program.currency);
        });
    });

    describe(`creating Values from Program with fixedInitialBalance constraints`, () => {
        const program: Partial<Program> = {
            id: generateId(),
            name: "program with fixedInitialBalance constraints",
            currency: "USD",
            fixedInitialBalances: [100, 200]
        };

        const programProperties = Object.keys(program);
        it("can create Program", async () => {
            const programResp = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", program);
            chai.assert.equal(programResp.statusCode, 201, JSON.stringify(programResp.body));
            for (const prop of programProperties) {
                chai.assert.equal(JSON.stringify(programResp.body[prop]), JSON.stringify(program[prop]));
            }
        });

        const value: Partial<Value> = {
            programId: program.id
        };

        it("can't create Value with balance = null", async () => {
            const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                ...value,
                id: generateId()
            });
            chai.assert.equal(valueResp.statusCode, 409, JSON.stringify(valueResp.body));
        });

        it("can't create Value with balance != fixedInitialBalances", async () => {
            value.balance = 1;
            const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                ...value,
                id: generateId()
            });
            chai.assert.equal(valueResp.statusCode, 409, JSON.stringify(valueResp.body));
        });

        it("can create Value with balance = fixedInitialBalances[0]", async () => {
            value.balance = program.fixedInitialBalances[0];
            const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                ...value,
                id: generateId()
            });
            chai.assert.equal(valueResp.statusCode, 201, JSON.stringify(valueResp.body));
            chai.assert.equal(valueResp.body.balance, value.balance);
        });

        it("can create Value with balance = fixedInitialBalances[1]", async () => {
            value.balance = program.fixedInitialBalances[1];
            const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                ...value,
                id: generateId()
            });
            chai.assert.equal(valueResp.statusCode, 201, JSON.stringify(valueResp.body));
            chai.assert.equal(valueResp.body.balance, value.balance);
        });
    });

    describe(`creating Values from Program with fixedInitialUses constraints`, () => {
        const program: Partial<Program> = {
            id: generateId(),
            name: "program with fixedInitialUses constraints",
            currency: "USD",
            fixedInitialUsesRemaining: [100, 200]
        };

        const programProperties = Object.keys(program);
        it("can create Program", async () => {
            const programResp = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", program);
            chai.assert.equal(programResp.statusCode, 201, JSON.stringify(programResp.body));
            for (const prop of programProperties) {
                chai.assert.equal(JSON.stringify(programResp.body[prop]), JSON.stringify(program[prop]));
            }
        });

        const value: Partial<Value> = {
            programId: program.id
        };

        it("can't create Value with usesRemaining = null", async () => {
            const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                ...value,
                id: generateId()
            });
            chai.assert.equal(valueResp.statusCode, 409, JSON.stringify(valueResp.body));
        });

        it("can't create Value with usesRemaining != fixedInitialUsesRemaining", async () => {
            value.usesRemaining = 1;
            const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                ...value,
                id: generateId()
            });
            chai.assert.equal(valueResp.statusCode, 409, JSON.stringify(valueResp.body));
        });

        it("can create Value with usesRemaining = fixedInitialUsesRemaining[0]", async () => {
            value.usesRemaining = program.fixedInitialUsesRemaining[0];
            const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                ...value,
                id: generateId()
            });
            chai.assert.equal(valueResp.statusCode, 201, JSON.stringify(valueResp.body));
            chai.assert.equal(valueResp.body.usesRemaining, value.usesRemaining);
        });

        it("can create Value with usesRemaining= fixedInitialUsesRemaining[1]", async () => {
            value.usesRemaining = program.fixedInitialUsesRemaining[1];
            const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                ...value,
                id: generateId()
            });
            chai.assert.equal(valueResp.statusCode, 201, JSON.stringify(valueResp.body));
            chai.assert.equal(valueResp.body.usesRemaining, value.usesRemaining);
        });
    });

    describe(`creating Values from Program with minInitialBalance and maxInitialBalance set`, () => {
        const program: Partial<Program> = {
            id: generateId(),
            name: "program with minInitialBalance and maxInitialBalance constraints",
            currency: "USD",
            minInitialBalance: 100,
            maxInitialBalance: 200
        };

        const programProperties = Object.keys(program);
        it("can create Program", async () => {
            const programResp = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", program);
            chai.assert.equal(programResp.statusCode, 201, JSON.stringify(programResp.body));
            for (const prop of programProperties) {
                chai.assert.equal(JSON.stringify(programResp.body[prop]), JSON.stringify(program[prop]));
            }
        });

        const value: Partial<Value> = {
            programId: program.id
        };

        it("can't create Value with balance = null", async () => {
            const valueResp = await testUtils.testAuthedRequest<cassava.RestError>(router, "/v2/values", "POST", {
                ...value,
                id: generateId()
            });
            chai.assert.equal(valueResp.statusCode, 409, JSON.stringify(valueResp.body));
            chai.assert.include(valueResp.body.message, "minInitialBalance");
        });

        it("can't create Value with balance < minInitialBalance", async () => {
            value.balance = 1;
            const valueResp = await testUtils.testAuthedRequest<cassava.RestError>(router, "/v2/values", "POST", {
                ...value,
                id: generateId()
            });
            chai.assert.equal(valueResp.statusCode, 409, JSON.stringify(valueResp.body));
            chai.assert.include(valueResp.body.message, "minInitialBalance");
        });

        it("can't create Value with balance > maxInitialBalance", async () => {
            value.balance = 201;
            const valueResp = await testUtils.testAuthedRequest<cassava.RestError>(router, "/v2/values", "POST", {
                ...value,
                id: generateId()
            });
            chai.assert.equal(valueResp.statusCode, 409, JSON.stringify(valueResp.body));
            chai.assert.include(valueResp.body.message, "maxInitialBalance");
        });

        it("can create Value with balance > minInitialBalance and balance < maxInitialBalance", async () => {
            value.balance = 150;
            const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                ...value,
                id: generateId()
            });
            chai.assert.equal(valueResp.statusCode, 201, JSON.stringify(valueResp.body));
            chai.assert.equal(valueResp.body.balance, value.balance);
        });

        it("can create Value with balance = minInitialBalance", async () => {
            value.balance = program.minInitialBalance;
            const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                ...value,
                id: generateId()
            });
            chai.assert.equal(valueResp.statusCode, 201, JSON.stringify(valueResp.body));
            chai.assert.equal(valueResp.body.balance, value.balance);
        });

        it("can create Value with balance = maxInitialBalance", async () => {
            value.balance = program.maxInitialBalance;
            const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                ...value,
                id: generateId()
            });
            chai.assert.equal(valueResp.statusCode, 201, JSON.stringify(valueResp.body));
            chai.assert.equal(valueResp.body.balance, value.balance);
        });
    });

    describe(`creating Values from Program with minInitialBalance=0`, () => {
        const program: Partial<Program> = {
            id: generateId(),
            name: "program with minInitialBalance and maxInitialBalance constraints",
            currency: "USD",
            minInitialBalance: 0
        };

        const programProperties = Object.keys(program);
        it("can create Program", async () => {
            const programResp = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", program);
            chai.assert.equal(programResp.statusCode, 201, JSON.stringify(programResp.body));
            for (const prop of programProperties) {
                chai.assert.equal(JSON.stringify(programResp.body[prop]), JSON.stringify(program[prop]));
            }
        });

        const value: Partial<Value> = {
            programId: program.id
        };

        it("can create Value with balance > minInitialBalance", async () => {
            value.balance = 2500;
            const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                ...value,
                id: generateId()
            });
            chai.assert.equal(valueResp.statusCode, 201, JSON.stringify(valueResp.body));
            chai.assert.equal(valueResp.body.balance, value.balance);
        });

        it("can create Value with balance = minInitialBalance", async () => {
            value.balance = program.minInitialBalance;
            const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                ...value,
                id: generateId()
            });
            chai.assert.equal(valueResp.statusCode, 201, JSON.stringify(valueResp.body));
            chai.assert.equal(valueResp.body.balance, value.balance);
        });

        it("can't create Value with balance = null", async () => {
            const valuePost_BalanceNull = await testUtils.testAuthedRequest<cassava.RestError>(router, "/v2/values", "POST", {
                id: generateId(),
                balance: null,
                programId: program.id
            } as Partial<Value>);
            chai.assert.equal(valuePost_BalanceNull.statusCode, 409);
            chai.assert.include(valuePost_BalanceNull.body.message, "minInitialBalance");
        });
    });

    describe("creating Values from Program with minInitialBalance = null and maxInitialBalance = null", () => {
        const program: Partial<Program> = {
            id: generateId(),
            currency: "USD",
            name: "name",
            minInitialBalance: null,
            maxInitialBalance: null
        };

        it("can create program", async () => {
            const programPost = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", program);
            chai.assert.equal(programPost.statusCode, 201);
        });

        it("can create Value with balance = 0", async () => {
            const valuePost_Balance0 = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                id: generateId(),
                balance: 0,
                programId: program.id
            } as Partial<Value>);
            chai.assert.equal(valuePost_Balance0.statusCode, 201);
        });

        it("can create Value with balance = 10", async () => {
            const valuePost_Balance10 = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                id: generateId(),
                balance: 10,
                programId: program.id
            } as Partial<Value>);
            chai.assert.equal(valuePost_Balance10.statusCode, 201);
        });

        it("can create Value with balance = null", async () => {
            const valuePost_BalanceNull = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                id: generateId(),
                balance: null,
                programId: program.id
            } as Partial<Value>);
            chai.assert.equal(valuePost_BalanceNull.statusCode, 201);
        });
    });

    describe("creating Values from Program with fixedInitialBalances = [0]", () => {
        const program: Partial<Program> = {
            id: generateId(),
            currency: "USD",
            name: "name",
            fixedInitialBalances: [0]
        };

        it("can create program", async () => {
            const programPost = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", program);
            chai.assert.equal(programPost.statusCode, 201);
        });

        it("can create Value with balance = 0", async () => {
            const valuePost_Balance0 = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                id: generateId(),
                balance: 0,
                programId: program.id
            } as Partial<Value>);
            chai.assert.equal(valuePost_Balance0.statusCode, 201);
        });

        it("can't create Value with balance = null", async () => {
            const valuePost_BalanceNull = await testUtils.testAuthedRequest<cassava.RestError>(router, "/v2/values", "POST", {
                id: generateId(),
                balance: null,
                programId: program.id
            } as Partial<Value>);
            chai.assert.equal(valuePost_BalanceNull.statusCode, 409);
            chai.assert.include(valuePost_BalanceNull.body.message, "fixedInitialBalances");
        });
    });

    it("can't create a Program with minInitialBalance > maxInitialBalance", async () => {
        const program: Partial<Program> = {
            id: generateId(),
            name: "program with minInitialBalance and maxInitialBalance constraints",
            currency: "USD",
            minInitialBalance: 50,
            maxInitialBalance: 25
        };

        const programResp = await testUtils.testAuthedRequest<cassava.RestError>(router, "/v2/programs", "POST", program);
        chai.assert.equal(programResp.statusCode, 422, JSON.stringify(programResp.body));
        chai.assert.equal(programResp.body.message, "Program's minInitialBalance cannot exceed maxInitialBalance.");
    });

    describe(`creating Values from Program with balanceRule set`, () => {
        const program: Partial<Program> = {
            id: generateId(),
            name: "program with balanceRule",
            currency: "USD",
            balanceRule: {rule: "500", explanation: "$5 the hard way"}
        };

        const programProperties = Object.keys(program);
        it("can create Program", async () => {
            const programResp = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", program);
            chai.assert.equal(programResp.statusCode, 201, JSON.stringify(programResp.body));
            for (const prop of programProperties) {
                chai.assert.equal(JSON.stringify(programResp.body[prop]), JSON.stringify(program[prop]));
            }
        });

        const value: Partial<Value> = {
            programId: program.id
        };

        it("can't create Value with balance != null", async () => {
            const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                ...value,
                id: generateId(),
                balance: 50
            });
            chai.assert.equal(valueResp.statusCode, 422, JSON.stringify(valueResp.body));
        });

        it("can create Value with balance = null", async () => {
            const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                ...value,
                id: generateId()
            });
            chai.assert.equal(valueResp.statusCode, 201, JSON.stringify(valueResp.body));
            chai.assert.deepEqual(valueResp.body.balanceRule, program.balanceRule);
        });

        it("can create Value with balanceRule != null. this overrides the Program's balanceRule", async () => {
            value.balanceRule = {rule: "600", explanation: "$6 the hard way too"};
            const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", {
                ...value,
                id: generateId()
            });
            chai.assert.equal(valueResp.statusCode, 201, JSON.stringify(valueResp.body));
            chai.assert.deepEqual(valueResp.body.balanceRule, value.balanceRule);
            chai.assert.notDeepEqual(valueResp.body.balanceRule, program.balanceRule);
        });
    });

    describe(`create Values from complex Program`, () => {
        const now = new Date();
        const program = {
            id: generateId(),
            name: "program with fixedInitialBalance constraints",
            currency: "USD",
            balanceRule: {rule: "500", explanation: "$5 the hard way"},
            discount: true,
            discountSellerLiability: 0.2,
            pretax: true,
            active: false,
            redemptionRule: {rule: "true", explanation: "always true"},
            fixedInitialUsesRemaining: [1, 2, 3],
            startDate: new Date(new Date().setDate(now.getDate() + 10)).toJSON(),
            endDate: new Date(new Date().setDate(now.getDate() + 100)).toJSON(),
            metadata: {notes: "this is a program note"}
        };

        const programProperties = Object.keys(program);
        it("can create Program", async () => {
            const programResp = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", program);
            chai.assert.equal(programResp.statusCode, 201, JSON.stringify(programResp.body));
            program.startDate = dateInDbPrecision(new Date(program.startDate)).toJSON();
            program.endDate = dateInDbPrecision(new Date(program.endDate)).toJSON();
            for (const prop of programProperties) {
                chai.assert.equal(JSON.stringify(programResp.body[prop]), JSON.stringify(program[prop]));
            }
        });

        const value: Partial<Value> = {
            id: generateId(),
            programId: program.id,
            usesRemaining: 3,
        };

        it("can create Value", async () => {
            const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
            chai.assert.equal(valueResp.statusCode, 201, JSON.stringify(valueResp.body));
            chai.assert.equal(valueResp.body.currency, program.currency);
            chai.assert.deepEqual(valueResp.body.balanceRule, program.balanceRule);
            chai.assert.equal(valueResp.body.discount, program.discount);
            chai.assert.equal(valueResp.body.discountSellerLiability, program.discountSellerLiability);
            chai.assert.equal(valueResp.body.pretax, program.pretax);
            chai.assert.equal(valueResp.body.active, program.active);
            chai.assert.deepEqual(valueResp.body.redemptionRule, program.redemptionRule);
            chai.assert.equal(valueResp.body.startDate.toString(), program.startDate);
            chai.assert.equal(valueResp.body.endDate.toString(), program.endDate);
        });

        it("can create Value and override Program properties", async () => {
            chai.assert.isTrue(program.discount);

            const value2 = {
                id: generateId(),
                programId: program.id,
                currency: "USD",
                balanceRule: {rule: "700", explanation: "$7 the hard way"},
                pretax: !program.pretax,
                active: !program.active,
                usesRemaining: program.fixedInitialUsesRemaining[0],
                redemptionRule: {rule: "false", explanation: "always false"},
                startDate: new Date(new Date().setDate(now.getDate() + 50)).toJSON(),
                endDate: new Date(new Date().setDate(now.getDate() + 150)).toJSON()
            };
            const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value2);
            chai.assert.equal(valueResp.statusCode, 201, JSON.stringify(valueResp.body));

            // these can't differ from program. it doesn't make sense since discountSellerLiability can only be set if discount = true.
            chai.assert.equal(valueResp.body.discount, program.discount);
            chai.assert.equal(valueResp.body.discountSellerLiability, program.discountSellerLiability);
            chai.assert.equal(valueResp.body.currency, program.currency);

            chai.assert.notEqual(valueResp.body.pretax, program.pretax);
            chai.assert.notEqual(valueResp.body.active, program.active);
            chai.assert.notEqual(valueResp.body.startDate.toString(), program.startDate);
            chai.assert.notEqual(valueResp.body.endDate.toString(), program.endDate);
            chai.assert.notDeepEqual(valueResp.body.balanceRule, program.balanceRule);
            chai.assert.notDeepEqual(valueResp.body.redemptionRule, program.redemptionRule);

            chai.assert.equal(valueResp.body.currency, value2.currency);
            chai.assert.deepEqual(valueResp.body.balanceRule, value2.balanceRule);
            chai.assert.equal(valueResp.body.pretax, value2.pretax);
            chai.assert.equal(valueResp.body.active, value2.active);
            chai.assert.deepEqual(valueResp.body.redemptionRule, value2.redemptionRule);

            chai.assert.equal(valueResp.body.startDate.toString(), dateInDbPrecision(new Date(value2.startDate)).toJSON());
            chai.assert.equal(valueResp.body.endDate.toString(), dateInDbPrecision(new Date(value2.endDate)).toJSON());
        });
    });

    describe(`creating Values from Program with metadata`, () => {
        const program: Partial<Program> = {
            id: generateId(),
            name: "program with balanceRule",
            currency: "USD",
            metadata: {
                a: "A",
                b: "B"
            }
        };

        const programProperties = Object.keys(program);
        it("can create Program", async () => {
            const programResp = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", program);
            chai.assert.equal(programResp.statusCode, 201, JSON.stringify(programResp.body));
            for (const prop of programProperties) {
                chai.assert.equal(JSON.stringify(programResp.body[prop]), JSON.stringify(program[prop]));
            }
        });

        it("can create Value and metadata from Program is copied over", async () => {
            const value: Partial<Value> = {
                id: generateId(),
                programId: program.id
            };
            const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
            chai.assert.equal(valueResp.statusCode, 201, JSON.stringify(valueResp.body));
            chai.assert.deepEqual(valueResp.body.metadata, program.metadata);
        });

        it("can create Value with metadata and override parts of Program's metadata", async () => {
            const value: Partial<Value> = {
                id: generateId(),
                programId: program.id,
                metadata: {
                    b: "override program",
                    c: "new"
                }
            };

            const valueResp = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
            chai.assert.equal(valueResp.statusCode, 201, JSON.stringify(valueResp.body));
            chai.assert.deepEqual(valueResp.body.metadata, {
                ...program.metadata,
                ...value.metadata
            });
            chai.assert.notDeepEqual(valueResp.body.metadata, program.metadata);
        });
    });

    it("can create value from program that uses discountSellerLiabilityRule", async () => {
        const program: Partial<Program> = {
            id: generateId(),
            currency: "USD",
            name: "example",
            discount: true,
            discountSellerLiabilityRule: {
                rule: "1 - currentLineItem.marketplaceRate",
                explanation: "proportional to marketplace rate"
            },
        };
        const createProgram = await testUtils.testAuthedRequest<Value>(router, "/v2/programs", "POST", program);
        chai.assert.equal(createProgram.statusCode, 201, JSON.stringify(createProgram.body));
        chai.assert.deepEqual(createProgram.body.discountSellerLiabilityRule, program.discountSellerLiabilityRule);
        chai.assert.isNull(createProgram.body.discountSellerLiability);

        const value: Partial<Value> = {
            id: generateId(),
            programId: program.id,
            balance: 100
        };

        const createValue = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
        chai.assert.equal(createValue.statusCode, 201, JSON.stringify(createValue.body));
        chai.assert.deepEqual(createValue.body.discountSellerLiabilityRule, program.discountSellerLiabilityRule);
        chai.assert.isNull(createValue.body.discountSellerLiability);
    });

    describe("program with discountSellerLiability set as number", () => {
        const program: Partial<Program> = {
            id: generateId(),
            currency: "USD",
            name: "example",
            discount: true,
            discountSellerLiability: 0.25
        };

        before(async () => {
            const createProgram = await testUtils.testAuthedRequest<Value>(router, "/v2/programs", "POST", program);
            chai.assert.equal(createProgram.statusCode, 201, JSON.stringify(createProgram.body));
            chai.assert.deepEqual(createProgram.body.discountSellerLiabilityRule, {
                rule: "0.25",
                explanation: "Seller 25% liable"
            });
            chai.assert.equal(createProgram.body.discountSellerLiability, 0.25);
        });

        it("can override discountSellerLiability by setting number during value creation", async () => {
            // set discountSellerLiability as number
            const value: Partial<Value> = {
                id: generateId(),
                programId: program.id,
                balance: 100,
                discountSellerLiability: 0.35
            };

            const create = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
            chai.assert.equal(create.statusCode, 201, JSON.stringify(create.body));
            chai.assert.deepEqual(create.body.discountSellerLiabilityRule, {
                rule: "0.35",
                explanation: "Seller 35% liable"
            });
            chai.assert.equal(create.body.discountSellerLiability, 0.35);
        });

        it("can override discountSellerLiability by setting rule during value creation", async () => {
            // set discountSellerLiability as rule
            const value: Partial<Value> = {
                id: generateId(),
                programId: program.id,
                balance: 100,
                discountSellerLiabilityRule: {
                    rule: "1 - currentLineItem.marketplaceRate",
                    explanation: "proportional to marketplace rate"
                }
            };

            const create = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
            chai.assert.equal(create.statusCode, 201, JSON.stringify(create.body));
            chai.assert.deepEqual(create.body.discountSellerLiabilityRule, value.discountSellerLiabilityRule);
            chai.assert.isNull(create.body.discountSellerLiability);
        });
    });

    describe("program with discountSellerLiabilityRule set as rule", () => {
        const program: Partial<Program> = {
            id: generateId(),
            currency: "USD",
            name: "example",
            discount: true,
            discountSellerLiabilityRule: {
                rule: "1 - currentLineItem.marketplaceRate",
                explanation: "proportional to marketplace rate"
            },
        };

        before(async () => {
            const createProgram = await testUtils.testAuthedRequest<Value>(router, "/v2/programs", "POST", program);
            chai.assert.equal(createProgram.statusCode, 201, JSON.stringify(createProgram.body));
            chai.assert.deepEqual(createProgram.body.discountSellerLiabilityRule, program.discountSellerLiabilityRule);
            chai.assert.isNull(createProgram.body.discountSellerLiability);
        });

        it("can override discountSellerLiability by setting number during value creation", async () => {
            const value: Partial<Value> = {
                id: generateId(),
                programId: program.id,
                balance: 100,
                discountSellerLiability: 0.35
            };

            const create = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
            chai.assert.equal(create.statusCode, 201, JSON.stringify(create.body));
            chai.assert.deepEqual(create.body.discountSellerLiabilityRule, {
                rule: "0.35",
                explanation: "Seller 35% liable"
            });
            chai.assert.equal(create.body.discountSellerLiability, 0.35);
        });

        it("can override discountSellerLiability by setting rule during value creation", async () => {
            const value: Partial<Value> = {
                id: generateId(),
                programId: program.id,
                balance: 100,
                discountSellerLiabilityRule: {
                    rule: "currentLineItem.marketplaceRate + 0.10",
                    explanation: "some different weird rule"
                }
            };

            const create = await testUtils.testAuthedRequest<Value>(router, "/v2/values", "POST", value);
            chai.assert.equal(create.statusCode, 201, JSON.stringify(create.body));
            chai.assert.deepEqual(create.body.discountSellerLiabilityRule, value.discountSellerLiabilityRule);
            chai.assert.isNull(create.body.discountSellerLiability);
        });
    });

});
