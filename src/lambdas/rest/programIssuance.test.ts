import * as testUtils from "../../utils/testUtils";
import {generateId} from "../../utils/testUtils";
import * as cassava from "cassava";
import * as chai from "chai";
import {installRestRoutes} from "./installRestRoutes";
import {createCurrency} from "./currencies";
import {Program} from "../../model/Program";
import {Value} from "../../model/Value";
import {initializeCodeCryptographySecrets} from "../../utils/codeCryptoUtils";
import {Issuance} from "../../model/Issuance";
import chaiExclude = require("chai-exclude");

chai.use(chaiExclude);

describe("/v2/issuances", () => {

    const router = new cassava.Router();

    const program: Partial<Program> = {
        id: generateId(),
        name: "program-name",
        currency: "USD"
    };

    const programWithRulesAndDates: Partial<Program> = {
        id: generateId(),
        name: "program name",
        currency: "USD",
        valueRule: {
            rule: "500",
            explanation: "$5 the hard way"
        },
        redemptionRule: {
            rule: "1 == 1",
            explanation: "always true"
        },
        startDate: new Date("2077-01-01"),
        endDate: new Date("2078-01-01")
    };

    before(async () => {
        await testUtils.resetDb();
        router.route(testUtils.authRoute);
        installRestRoutes(router);
        await initializeCodeCryptographySecrets(Promise.resolve({
            encryptionSecret: "ca7589aef4ffed15783341414fe2f4a5edf9ddad75cf2e96ed2a16aee88673ea",
            lookupHashSecret: "ae8645165cc7533dbcc84aeb21c7d6553a38271b7e3402f99d16b8a8717847e1"
        }));
        await createCurrency(testUtils.defaultTestUser.auth, {
            code: "USD",
            name: "US Dollars",
            symbol: "$",
            decimalPlaces: 2
        });

        const createProgram = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", program);
        chai.assert.equal(createProgram.statusCode, 201, JSON.stringify(createProgram.body));

        const createProgramWithRulesAndDates = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", programWithRulesAndDates);
        chai.assert.equal(createProgramWithRulesAndDates.statusCode, 201, JSON.stringify(createProgramWithRulesAndDates.body));
    });

    it(`basic issuances with varying counts. POST, GET and LIST`, async () => {
        const valuesToIssues = [1, 2, 10, 100, 1000];
        let issuances: Issuance[] = [];
        for (let num of valuesToIssues) {
            let issuance = {
                id: generateId(),
                count: num,
                generateCode: {}
            };

            const createIssuance = await testUtils.testAuthedRequest<Issuance>(router, `/v2/programs/${program.id}/issuances`, "POST", issuance);
            chai.assert.equal(createIssuance.statusCode, 201, JSON.stringify(createIssuance.body));
            chai.assert.deepEqualExcluding(createIssuance.body, {
                id: issuance.id,
                programId: program.id,
                count: num,
                balance: null,
                redemptionRule: null,
                valueRule: null,
                uses: null,
                startDate: null,
                endDate: null,
                metadata: null
            }, ["createdDate", "updatedDate"]);
            issuances.push(createIssuance.body);

            const getIssuance = await testUtils.testAuthedRequest<Issuance>(router, `/v2/programs/${program.id}/issuances/${issuance.id}`, "GET");
            chai.assert.equal(getIssuance.statusCode, 200, `body=${JSON.stringify(getIssuance.body)}`);
            chai.assert.deepEqual(getIssuance.body, createIssuance.body);

            const listValues = await testUtils.testAuthedRequest<Value[]>(router, `/v2/values?limit=1000&issuanceId=${issuance.id}`, "GET");
            chai.assert.equal(listValues.statusCode, 200, `body=${JSON.stringify(listValues.body)}`);
            chai.assert.equal(listValues.body.length, issuance.count);
        }
        const listIssuances = await testUtils.testAuthedRequest<Issuance[]>(router, `/v2/programs/${program.id}/issuances`, "GET");
        chai.assert.equal(listIssuances.statusCode, 200, `body=${JSON.stringify(listIssuances.body)}`);
        chai.assert.equal(listIssuances.body.length, valuesToIssues.length);
        chai.assert.sameDeepMembers(listIssuances.body, issuances);
    }).timeout(10000);

    it(`issuing from program that has a value rule`, async () => {
        let issuance: Partial<Issuance> = {
            id: generateId(),
            count: 1
        };

        const createIssuance = await testUtils.testAuthedRequest<Issuance>(router, `/v2/programs/${programWithRulesAndDates.id}/issuances`, "POST", issuance);
        chai.assert.equal(createIssuance.statusCode, 201, JSON.stringify(createIssuance.body));
        chai.assert.deepEqual(createIssuance.body.valueRule, programWithRulesAndDates.valueRule, "valueRule from program is copied over to the issuance");
        chai.assert.deepEqual(createIssuance.body.redemptionRule, programWithRulesAndDates.redemptionRule, "redemptionRule from program is copied over to the issuance");
        chai.assert.equal(createIssuance.body.startDate.toString(), programWithRulesAndDates.startDate.toISOString(), "startDate from program is copied over to the issuance");
        chai.assert.equal(createIssuance.body.endDate.toString(), programWithRulesAndDates.endDate.toISOString(), "endDate from program is copied over to the issuance");

        const listResponse = await testUtils.testAuthedRequest<Value[]>(router, `/v2/values?limit=1000&issuanceId=${issuance.id}`, "GET");
        chai.assert.equal(listResponse.statusCode, 200, `body=${JSON.stringify(listResponse.body)}`);
        chai.assert.equal(listResponse.body.length, issuance.count);
        chai.assert.deepEqual(listResponse.body[0].valueRule, programWithRulesAndDates.valueRule, "valueRule from program is copied over to the Value");
        chai.assert.deepEqual(listResponse.body[0].redemptionRule, programWithRulesAndDates.redemptionRule, "redemptionRule from program is copied over to the Value");
        chai.assert.equal(listResponse.body[0].startDate.toString(), programWithRulesAndDates.startDate.toISOString(), "startDate from program is copied over to the Value");
        chai.assert.equal(listResponse.body[0].endDate.toString(), programWithRulesAndDates.endDate.toISOString(), "endDate from program is copied over to the Value");
    });

    it(`can overwrite valueRule, redemptionRule, startDate and endDate`, async () => {
        let issuance: Partial<Issuance> = {
            id: generateId(),
            count: 1,
            valueRule: {
                rule: "700",
                explanation: "$7 the hard way"
            },
            redemptionRule: {
                rule: "2 == 1",
                explanation: "never true"
            },
            startDate: new Date("2177-01-01"),
            endDate: new Date("2178-01-01")
        };
        chai.assert.notDeepEqual(issuance.valueRule, programWithRulesAndDates.valueRule);
        chai.assert.notDeepEqual(issuance.redemptionRule, programWithRulesAndDates.redemptionRule);
        chai.assert.notEqual(programWithRulesAndDates.startDate, issuance.startDate);
        chai.assert.notEqual(programWithRulesAndDates.endDate, issuance.endDate);

        const createIssuance = await testUtils.testAuthedRequest<Issuance>(router, `/v2/programs/${programWithRulesAndDates.id}/issuances`, "POST", issuance);
        chai.assert.equal(createIssuance.statusCode, 201, JSON.stringify(createIssuance.body));
        chai.assert.deepEqual(createIssuance.body.valueRule, issuance.valueRule);
        chai.assert.deepEqual(createIssuance.body.redemptionRule, issuance.redemptionRule);
        chai.assert.equal(createIssuance.body.startDate.toString(), issuance.startDate.toISOString());
        chai.assert.equal(createIssuance.body.endDate.toString(), issuance.endDate.toISOString());

        const listResponse = await testUtils.testAuthedRequest<Value[]>(router, `/v2/values?limit=1000&issuanceId=${issuance.id}`, "GET");
        chai.assert.equal(listResponse.statusCode, 200, `body=${JSON.stringify(listResponse.body)}`);
        chai.assert.equal(listResponse.body.length, issuance.count);
        chai.assert.deepEqual(listResponse.body[0].valueRule, issuance.valueRule);
        chai.assert.deepEqual(listResponse.body[0].redemptionRule, issuance.redemptionRule);
        chai.assert.equal(listResponse.body[0].startDate.toString(), issuance.startDate.toISOString());
        chai.assert.equal(listResponse.body[0].endDate.toString(), issuance.endDate.toISOString());
    });

    it(`issuance with generic code`, async () => {
        let issuance = {
            id: generateId(),
            count: 1,
            isGenericCode: true,
            code: "PRETTY-GENERIC"
        };

        const createIssuance = await testUtils.testAuthedRequest<Issuance>(router, `/v2/programs/${program.id}/issuances`, "POST", issuance);
        chai.assert.equal(createIssuance.statusCode, 201, JSON.stringify(createIssuance.body));

        const listResponse = await testUtils.testAuthedRequest<Value[]>(router, `/v2/values?limit=1000&issuanceId=${issuance.id}`, "GET");
        chai.assert.equal(listResponse.statusCode, 200, `body=${JSON.stringify(listResponse.body)}`);
        chai.assert.equal(listResponse.body.length, issuance.count);
        chai.assert.equal(listResponse.body[0].code, issuance.code);
        chai.assert.isTrue(listResponse.body[0].isGenericCode);
    });

    it(`issuance with code`, async () => {
        let issuance = {
            id: generateId(),
            count: 1,
            code: "IEDKQODLAOWKRJ"
        };

        const createIssuance = await testUtils.testAuthedRequest<Issuance>(router, `/v2/programs/${program.id}/issuances`, "POST", issuance);
        chai.assert.equal(createIssuance.statusCode, 201, JSON.stringify(createIssuance.body));

        const listResponse = await testUtils.testAuthedRequest<Value[]>(router, `/v2/values?limit=1000&issuanceId=${issuance.id}`, "GET");
        chai.assert.equal(listResponse.statusCode, 200, `body=${JSON.stringify(listResponse.body)}`);
        chai.assert.equal(listResponse.body.length, issuance.count);
        chai.assert.equal(listResponse.body[0].code, "…WKRJ");
        chai.assert.isFalse(listResponse.body[0].isGenericCode);
    });

    it(`422 if isGenericCode: true and count > 1`, async () => {
        let issuance = {
            id: generateId(),
            count: 2,
            isGenericCode: true
        };

        const createIssuance = await testUtils.testAuthedRequest<cassava.RestError>(router, `/v2/programs/${program.id}/issuances`, "POST", issuance);
        chai.assert.equal(createIssuance.statusCode, 422, JSON.stringify(createIssuance.body));
        chai.assert.include(createIssuance.body.message, "Issuance count must be 1 if isGenericCode:true.");
    });

    it(`422 if provided code and count > 1`, async () => {
        let issuance = {
            id: generateId(),
            count: 2,
            code: "ABCDEFGHI"
        };

        const createIssuance = await testUtils.testAuthedRequest<cassava.RestError>(router, `/v2/programs/${program.id}/issuances`, "POST", issuance);
        chai.assert.equal(createIssuance.statusCode, 422, JSON.stringify(createIssuance.body));
        chai.assert.include(createIssuance.body.message, "Issuance count must be 1 if code is set");
    });

    it(`422 if generateCode and code parameters are provided`, async () => {
        let issuance = {
            id: generateId(),
            count: 1,
            code: "ABCDEFGHI",
            generateCode: {}
        };

        const createIssuance = await testUtils.testAuthedRequest<cassava.RestError>(router, `/v2/programs/${program.id}/issuances`, "POST", issuance);
        chai.assert.equal(createIssuance.statusCode, 422, JSON.stringify(createIssuance.body));
        chai.assert.include(createIssuance.body.message, "Parameter generateCode is not allowed with parameters code or isGenericCode:true.");
    });

    it(`422 if program has valueRule and try to issue with balance`, async () => {
        const program: Partial<Program> = {
            id: generateId(),
            name: "program-name",
            currency: "USD",
            valueRule: {
                rule: "500",
                explanation: "$5 the hard way"
            }
        };
        const createProgram = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", program);
        chai.assert.equal(createProgram.statusCode, 201, JSON.stringify(createProgram.body));

        let issuance: Partial<Issuance> = {
            id: generateId(),
            count: 1,
            balance: 1
        };

        const createIssuance = await testUtils.testAuthedRequest<cassava.RestError>(router, `/v2/programs/${program.id}/issuances`, "POST", issuance);
        chai.assert.equal(createIssuance.statusCode, 422, JSON.stringify(createIssuance.body));
        chai.assert.include(createIssuance.body.message, "Value can't have both a balance and valueRule.");
    });

    it(`422 on issuance with id over 26 characters`, async () => {
        let issuance: Partial<Issuance> = {
            id: "123456789012345678901234567",
            count: 1,
            balance: 1
        };

        chai.assert.equal(issuance.id.length, 27);
        const createIssuance = await testUtils.testAuthedRequest<cassava.RestError>(router, `/v2/programs/${generateId()}/issuances`, "POST", issuance);
        chai.assert.equal(createIssuance.statusCode, 422, JSON.stringify(createIssuance.body));
    });

    it(`404 on invalid programId`, async () => {
        let issuance: Partial<Issuance> = {
            id: generateId(),
            count: 1,
            balance: 1
        };

        const createIssuance = await testUtils.testAuthedRequest<cassava.RestError>(router, `/v2/programs/${generateId()}/issuances`, "POST", issuance);
        chai.assert.equal(createIssuance.statusCode, 404, JSON.stringify(createIssuance.body));
    });
});