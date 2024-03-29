import * as cassava from "cassava";
import * as chai from "chai";
import * as testUtils from "../../../utils/testUtils";
import {generateId} from "../../../utils/testUtils";
import {Transaction} from "../../../model/Transaction";
import {installRestRoutes} from "../installRestRoutes";
import {Program} from "../../../model/Program";
import {setStubsForStripeTests, unsetStubsForStripeTests} from "../../../utils/testUtils/stripeTestUtils";
import {ReportTransaction} from "../transactions/ReportTransaction";
import parseLinkHeader = require("parse-link-header");

describe("/v2/reports/transactions/", () => {
    const router = new cassava.Router();

    let initialBalanceId: string;
    const program: Partial<Program> = {
        id: generateId(),
        currency: "USD",
        name: "test program"
    };

    function getTransactionReportHeadersForAssertions(limit: number = 10000): { [key: string]: string } {
        return {
            "Limit": limit.toString(),
            "Max-Limit": "10000",
            "Content-Type": "text/csv"
        };
    }

    before(async function () {
        await testUtils.resetDb();
        router.route(testUtils.authRoute);
        installRestRoutes(router);
        testUtils.setCodeCryptographySecrets();
        await testUtils.createUSD(router);

        await testUtils.createUSDCheckout(router, null, false);
        await testUtils.createUSDCheckout(router, null, false);
        await testUtils.createUSDCheckout(router, null, false);

        const createProgram = await testUtils.testAuthedRequest(router, "/v2/programs", "POST", program);
        chai.assert.equal(createProgram.statusCode, 201);
        const value = await testUtils.createUSDValue(router, {balance: 1000, programId: program.id});
        initialBalanceId = value.id;
        const creditResp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/credit", "POST", {
            id: testUtils.generateId(),
            currency: "USD",
            amount: 500,
            destination: {
                rail: "lightrail",
                valueId: value.id
            }
        });
        chai.assert.equal(creditResp.statusCode, 201, `creditResp.body=${JSON.stringify(creditResp.body)}`);
        const debitResp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/debit", "POST", {
            id: testUtils.generateId(),
            currency: "USD",
            amount: 550,
            source: {
                rail: "lightrail",
                valueId: value.id
            }
        });
        chai.assert.equal(debitResp.statusCode, 201, `debitResp.body=${JSON.stringify(debitResp.body)}`);
    });

    it("can download a csv of Transactions", async () => {
        const resp = await testUtils.testAuthedCsvRequest<ReportTransaction>(router, "/v2/reports/transactions", "GET");
        chai.assert.equal(resp.statusCode, 200, `resp.body=${JSON.stringify(resp.body)}`);
        chai.assert.deepInclude(resp.headers, getTransactionReportHeadersForAssertions(), `resp.headers=${JSON.stringify(resp.headers)}`);
        chai.assert.equal(resp.body.length, 9, `transactions in resp.body=${resp.body.map(txn => txn.transactionType)}`);

        const checkouts = resp.body.filter(txn => txn.transactionType === "checkout");
        chai.assert.equal(checkouts.length, 3, `checkout transactions: ${JSON.stringify(checkouts)}`);
        for (const [index, txn] of checkouts.entries()) {
            chai.assert.deepEqualExcluding(txn, {
                id: "",
                createdDate: null,
                transactionType: "checkout",
                currency: "USD",
                transactionAmount: -1000,
                checkout_subtotal: 1000,
                checkout_tax: 0,
                checkout_discountLightrail: 0,
                checkout_paidLightrail: 1000,
                checkout_paidStripe: 0,
                checkout_paidInternal: 0,
                checkout_remainder: 0,
                checkout_forgiven: 0,
                stepsCount: 1,
                marketplace_sellerNet: 0,
                marketplace_sellerGross: 0,
                marketplace_sellerDiscount: 0,
                metadata: null
            }, ["id", "createdDate", "metadata"], `checkout transaction ${index} of ${checkouts.length}: ${JSON.stringify(txn)}`);
        }

        const initialBalances = resp.body.filter(txn => txn.transactionType === "initialBalance");
        chai.assert.equal(initialBalances.length, 4, `initial balance transactions: ${JSON.stringify(initialBalances)}`);
        for (const [index, txn] of initialBalances.entries()) {
            chai.assert.deepEqualExcluding(txn, {
                id: "",
                createdDate: null,
                transactionType: "initialBalance",
                currency: "USD",
                transactionAmount: 1000,
                checkout_subtotal: 0,
                checkout_tax: 0,
                checkout_discountLightrail: 0,
                checkout_paidLightrail: 0,
                checkout_paidStripe: 0,
                checkout_paidInternal: 0,
                checkout_remainder: 0,
                checkout_forgiven: 0,
                stepsCount: 1,
                marketplace_sellerNet: 0,
                marketplace_sellerGross: 0,
                marketplace_sellerDiscount: 0,
                metadata: null
            }, ["id", "createdDate", "metadata"], `initialBalance transaction ${index} of ${initialBalances.length}: ${JSON.stringify(txn)}`);
        }
    }).timeout(8000);

    it("can page through results", async () => {
        const getAllTransactions = await testUtils.testAuthedCsvRequest<ReportTransaction>(router, `/v2/reports/transactions`, "GET");
        chai.assert.equal(getAllTransactions.statusCode, 200, `getAllTransactions.body=${JSON.stringify(getAllTransactions.body)}`);
        chai.assert.isAbove(getAllTransactions.body.length, 3, `getAllTransactions.body.length=${getAllTransactions.body.length}`);

        const returnedTransactionIds: string[] = [];
        let resp = await testUtils.testAuthedCsvRequest<ReportTransaction>(router, "/v2/reports/transactions?limit=3", "GET");
        chai.assert.equal(resp.statusCode, 200);
        returnedTransactionIds.push(...resp.body.map(t => t.id));
        const linkHeaders = parseLinkHeader(resp.headers["Link"]);
        let nextLink = linkHeaders.next.url;
        while (nextLink) {
            resp = await testUtils.testAuthedCsvRequest<ReportTransaction>(router, nextLink, "GET");
            chai.assert.equal(resp.statusCode, 200);
            returnedTransactionIds.push(...resp.body.map(t => t.id));
            const linkHeaders = parseLinkHeader(resp.headers["Link"]);
            nextLink = (linkHeaders && linkHeaders.next) ? linkHeaders.next.url : null;
        }

        const expected = getAllTransactions.body.map(v => v.id);
        chai.assert.sameDeepMembers(returnedTransactionIds, expected, `returnedTransactionIds=${JSON.stringify(returnedTransactionIds)}, getAllTransactions IDs = ${JSON.stringify(expected)}`);
    });

    describe("filtering by transactionType", () => {
        it("can download a csv of checkout Transactions", async () => {
            const resp = await testUtils.testAuthedCsvRequest<ReportTransaction>(router, "/v2/reports/transactions?transactionType=checkout", "GET");
            chai.assert.equal(resp.statusCode, 200, `resp.body=${JSON.stringify(resp.body)}`);
            chai.assert.deepInclude(resp.headers, getTransactionReportHeadersForAssertions(), `resp.headers=${JSON.stringify(resp.headers)}`);
            chai.assert.equal(resp.body.length, 3, `transactions in resp.body=${resp.body.map(txn => txn.transactionType)}`);
            for (const [index, txn] of resp.body.entries()) {
                chai.assert.deepEqualExcluding(txn, {
                    id: "",
                    createdDate: null,
                    transactionType: "checkout",
                    currency: "USD",
                    transactionAmount: -1000,
                    checkout_subtotal: 1000,
                    checkout_tax: 0,
                    checkout_discountLightrail: 0,
                    checkout_paidLightrail: 1000,
                    checkout_paidStripe: 0,
                    checkout_paidInternal: 0,
                    checkout_remainder: 0,
                    checkout_forgiven: 0,
                    stepsCount: 1,
                    marketplace_sellerNet: 0,
                    marketplace_sellerGross: 0,
                    marketplace_sellerDiscount: 0,
                    metadata: null
                }, ["id", "createdDate", "metadata"], `checkout transaction ${index} of ${resp.body.length}: ${JSON.stringify(txn)}`);
            }
        });

        it("can download a csv of initialBalance Transactions", async () => {
            const resp = await testUtils.testAuthedCsvRequest<ReportTransaction>(router, "/v2/reports/transactions?transactionType=initialBalance", "GET");
            chai.assert.equal(resp.statusCode, 200, `resp.body=${JSON.stringify(resp.body)}`);
            chai.assert.deepInclude(resp.headers, getTransactionReportHeadersForAssertions(), `resp.headers=${JSON.stringify(resp.headers)}`);
            chai.assert.equal(resp.body.length, 4, `transactions in resp.body=${resp.body.map(txn => txn.transactionType)}`);
            for (const [index, txn] of resp.body.entries()) {
                chai.assert.deepEqualExcluding(txn, {
                    id: "",
                    createdDate: null,
                    transactionType: "initialBalance",
                    currency: "USD",
                    transactionAmount: 1000,
                    checkout_subtotal: 0,
                    checkout_tax: 0,
                    checkout_discountLightrail: 0,
                    checkout_paidLightrail: 0,
                    checkout_paidStripe: 0,
                    checkout_paidInternal: 0,
                    checkout_remainder: 0,
                    checkout_forgiven: 0,
                    stepsCount: 1,
                    marketplace_sellerNet: 0,
                    marketplace_sellerGross: 0,
                    marketplace_sellerDiscount: 0,
                    metadata: null
                }, ["id", "createdDate", "metadata"], `initialBalance transaction ${index} of ${resp.body.length}: ${JSON.stringify(txn)}`);
            }
        });

        it("can download a csv of credit and debit Transactions (two types)", async () => {
            const resp = await testUtils.testAuthedCsvRequest<ReportTransaction>(router, "/v2/reports/transactions?transactionType.in=credit,debit", "GET");
            chai.assert.equal(resp.statusCode, 200, `resp.body=${JSON.stringify(resp.body)}`);
            chai.assert.deepInclude(resp.headers, getTransactionReportHeadersForAssertions(), `resp.headers=${JSON.stringify(resp.headers)}`);
            chai.assert.equal(resp.body.length, 2, `transactions in resp.body=${resp.body.map(txn => txn.transactionType)}`);

            const credit = resp.body.find(txn => txn.transactionType === "credit");
            chai.assert.deepEqualExcluding(credit, {
                id: "",
                createdDate: null,
                transactionType: "credit",
                currency: "USD",
                transactionAmount: 500,
                checkout_subtotal: 0,
                checkout_tax: 0,
                checkout_discountLightrail: 0,
                checkout_paidLightrail: 0,
                checkout_paidStripe: 0,
                checkout_paidInternal: 0,
                checkout_remainder: 0,
                checkout_forgiven: 0,
                stepsCount: 1,
                marketplace_sellerNet: 0,
                marketplace_sellerGross: 0,
                marketplace_sellerDiscount: 0,
                metadata: null
            }, ["id", "createdDate", "metadata"], `credit transaction: ${JSON.stringify(credit)}`);

            const debit = resp.body.find(txn => txn.transactionType === "debit");
            chai.assert.deepEqualExcluding(debit, {
                id: "",
                createdDate: null,
                transactionType: "debit",
                currency: "USD",
                transactionAmount: -550,
                checkout_subtotal: 0,
                checkout_tax: 0,
                checkout_discountLightrail: 0,
                checkout_paidLightrail: 0,
                checkout_paidStripe: 0,
                checkout_paidInternal: 0,
                checkout_remainder: 0,
                checkout_forgiven: 0,
                stepsCount: 1,
                marketplace_sellerNet: 0,
                marketplace_sellerGross: 0,
                marketplace_sellerDiscount: 0,
                metadata: null
            }, ["id", "createdDate", "metadata"], `debit transaction: ${JSON.stringify(debit)}`);
        });
    });

    describe("filtering by programId", () => {
        let program1checkout: Transaction;
        let program1debit: Transaction;
        let program2checkout: Transaction;

        before(async () => {
            await testUtils.createUSD(router);
            const program1resp = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", {
                id: "program1",
                name: "program1",
                currency: "USD",
                fixedInitialBalances: [5000]
            });
            chai.assert.equal(program1resp.statusCode, 201, `program1resp.body=${JSON.stringify(program1resp.body)}`);
            const program2resp = await testUtils.testAuthedRequest<Program>(router, "/v2/programs", "POST", {
                id: "program2",
                name: "program2",
                currency: "USD",
                fixedInitialBalances: [5000]
            });
            chai.assert.equal(program2resp.statusCode, 201, `program1resp.body=${JSON.stringify(program2resp.body)}`);

            const value1 = await testUtils.createUSDValue(router, {balance: 5000, programId: "program1"});
            const value2 = await testUtils.createUSDValue(router, {balance: 5000, programId: "program1"});
            const value3 = await testUtils.createUSDValue(router, {balance: 5000, programId: "program2"});

            program1checkout = (await testUtils.createUSDCheckout(router, {
                sources: [{
                    rail: "lightrail",
                    valueId: value1.id
                }]
            }, false)).checkout;
            const program1debitResp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/debit", "POST", {
                id: testUtils.generateId(),
                amount: 200,
                currency: "USD",
                source: {rail: "lightrail", valueId: value2.id}
            });
            chai.assert.equal(program1debitResp.statusCode, 201, `debit3.body=${JSON.stringify(program1debitResp.body)}`);
            program1debit = program1debitResp.body;

            program2checkout = (await testUtils.createUSDCheckout(router, {
                sources: [{
                    rail: "lightrail",
                    valueId: value3.id
                }]
            }, false)).checkout;
        });

        it("Transactions by programId={id}", async () => {
            const program1report = await testUtils.testAuthedCsvRequest<ReportTransaction>(router, `/v2/reports/transactions?programId=program1`, "GET");
            chai.assert.equal(program1report.statusCode, 200, `program1report.body=${JSON.stringify(program1report.body)}`);
            chai.assert.deepInclude(program1report.headers as any, getTransactionReportHeadersForAssertions(), `resp.headers=${JSON.stringify(program1report.headers)}`);
            chai.assert.equal(program1report.body.length, 4, `transaction types in program1report.body: ${program1report.body.map(txn => txn.transactionType)}`);
            chai.assert.equal(program1report.body.find(txn => txn.transactionType === "checkout").id, program1checkout.id, `program1report.body=${JSON.stringify(program1report.body)}`);
            chai.assert.equal(program1report.body.find(txn => txn.transactionType === "debit").id, program1debit.id, `program1report.body=${JSON.stringify(program1report.body)}`);
            chai.assert.equal(program1report.body.filter(txn => txn.transactionType === "initialBalance").length, 2, `program1report.body=${JSON.stringify(program1report.body)}`);
        });

        it("Transactions by programId.eq={id}", async () => {
            const program2report = await testUtils.testAuthedCsvRequest<ReportTransaction>(router, `/v2/reports/transactions?programId.eq=program2`, "GET");
            chai.assert.equal(program2report.statusCode, 200, `program2report.body=${JSON.stringify(program2report.body)}`);
            chai.assert.deepInclude(program2report.headers as any, getTransactionReportHeadersForAssertions(), `resp.headers=${JSON.stringify(program2report.headers)}`);
            chai.assert.equal(program2report.body.length, 2, `transaction types in program2report.body: ${program2report.body.map(txn => txn.transactionType)}`);
            chai.assert.equal(program2report.body.find(txn => txn.transactionType === "checkout").id, program2checkout.id, `program2report.body=${JSON.stringify(program2report.body)}`);
            chai.assert.isObject(program2report.body.find(txn => txn.transactionType === "initialBalance"), `program2report.body=${JSON.stringify(program2report.body)}`);
        });

        it("Transactions by programId.in={id,id}", async () => {
            const bothProgramsReport = await testUtils.testAuthedCsvRequest<ReportTransaction>(router, `/v2/reports/transactions?programId.in=program1,program2`, "GET");
            chai.assert.equal(bothProgramsReport.statusCode, 200, `bothProgramsReport.body=${JSON.stringify(bothProgramsReport.body)}`);
            chai.assert.deepInclude(bothProgramsReport.headers as any, getTransactionReportHeadersForAssertions(), `resp.headers=${JSON.stringify(bothProgramsReport.headers)}`);
            chai.assert.equal(bothProgramsReport.body.length, 6, `transaction types in bothProgramsReport.body: ${bothProgramsReport.body.map(txn => txn.transactionType)}`);
        });

        it("can filter and limit at the same time", async () => {
            const reportProgram1 = await testUtils.testAuthedCsvRequest<ReportTransaction>(router, `/v2/reports/transactions?programId=program1`, "GET");
            chai.assert.equal(reportProgram1.statusCode, 200, `reportProgram1.body=${JSON.stringify(reportProgram1.body)}`);
            chai.assert.isAbove(reportProgram1.body.length, 2, `reportProgram1.body.length: ${reportProgram1.body.length}`);

            const reportLimitedProgram1 = await testUtils.testAuthedCsvRequest<ReportTransaction>(router, "/v2/reports/transactions?limit=2&programId=program1", "GET");
            chai.assert.equal(reportLimitedProgram1.statusCode, 200, `reportLimitedProgram1NoErrors.body=${JSON.stringify(reportLimitedProgram1.body)}`);
            chai.assert.equal(reportLimitedProgram1.body.length, 2, `reportLimitedProgram1NoErrors.body=${JSON.stringify(reportLimitedProgram1.body)}`);
        });
    });

    describe("multiple transaction steps", () => {
        after(() => {
            unsetStubsForStripeTests();
        });

        it("returns one row per Transaction regardless of number of steps", async () => {
            await testUtils.resetDb();
            await testUtils.createUSD(router);

            const value1 = await testUtils.createUSDValue(router);
            const value2 = await testUtils.createUSDValue(router);
            const transferResp = await testUtils.testAuthedRequest<Transaction>(router, "/v2/transactions/transfer", "POST", {
                id: testUtils.generateId(),
                amount: 1,
                currency: "USD",
                source: {
                    rail: "lightrail",
                    valueId: value1.id
                },
                destination: {
                    rail: "lightrail",
                    valueId: value2.id
                }
            });
            chai.assert.equal(transferResp.statusCode, 201, `transferResp.body=${JSON.stringify(transferResp.body)}`);

            const transferReportResp = await testUtils.testAuthedCsvRequest<ReportTransaction[]>(router, "/v2/reports/transactions?transactionType=transfer", "GET");
            chai.assert.equal(transferReportResp.statusCode, 200, `transferReportResp.body=${JSON.stringify(transferReportResp.body)}`);
            chai.assert.deepInclude(transferReportResp.headers, getTransactionReportHeadersForAssertions(), `resp.headers=${JSON.stringify(transferReportResp.headers)}`);
            chai.assert.deepEqualExcluding(transferReportResp.body[0], {
                id: "",
                transactionType: "transfer",
                currency: "USD",
                createdDate: null,
                transactionAmount: 1,
                checkout_subtotal: 0,
                checkout_tax: 0,
                checkout_discountLightrail: 0,
                checkout_paidLightrail: 0,
                checkout_paidStripe: 0,
                checkout_paidInternal: 0,
                checkout_remainder: 0,
                checkout_forgiven: 0,
                stepsCount: 2,
                marketplace_sellerNet: 0,
                marketplace_sellerDiscount: 0,
                marketplace_sellerGross: 0,
                metadata: null,
            }, ["createdDate", "id", "metadata"], `transferReportResp.body[0]=${JSON.stringify(transferReportResp.body[0], null, 4)}`);

            const value3 = await testUtils.createUSDValue(router);
            await testUtils.createUSDCheckout(router, {
                lineItems: [{unitPrice: 150}],
                sources: [
                    {
                        rail: "lightrail",
                        valueId: value1.id
                    },
                    {
                        rail: "lightrail",
                        valueId: value2.id
                    },
                    {
                        rail: "lightrail",
                        valueId: value3.id
                    }
                ]
            }, false);

            const checkoutReportResp = await testUtils.testAuthedCsvRequest<ReportTransaction[]>(router, "/v2/reports/transactions?transactionType=checkout", "GET");
            chai.assert.equal(checkoutReportResp.statusCode, 200, `checkoutReportResp.body=${JSON.stringify(checkoutReportResp.body)}`);
            chai.assert.deepInclude(transferReportResp.headers, getTransactionReportHeadersForAssertions(), `resp.headers=${JSON.stringify(checkoutReportResp.headers)}`);
            chai.assert.deepEqualExcluding(checkoutReportResp.body[0], {
                id: "",
                transactionType: "checkout",
                currency: "USD",
                createdDate: null,
                transactionAmount: -150,
                checkout_subtotal: 150,
                checkout_tax: 0,
                checkout_discountLightrail: 0,
                checkout_paidLightrail: 150,
                checkout_paidStripe: 0,
                checkout_paidInternal: 0,
                checkout_remainder: 0,
                checkout_forgiven: 0,
                stepsCount: 3,
                marketplace_sellerNet: 0,
                marketplace_sellerDiscount: 0,
                marketplace_sellerGross: 0,
                metadata: null,
            }, ["createdDate", "id", "metadata"], `checkoutReportResp.body[0]=${JSON.stringify(checkoutReportResp.body[0], null, 4)}`);
        }).timeout(12000);

        it("handles Stripe steps", async () => {
            await testUtils.resetDb();
            await testUtils.createUSD(router);
            await setStubsForStripeTests();

            await testUtils.createUSDCheckout(router, null, true);
            const checkoutReportResp = await testUtils.testAuthedCsvRequest<ReportTransaction[]>(router, "/v2/reports/transactions?transactionType=checkout", "GET");
            chai.assert.equal(checkoutReportResp.statusCode, 200, `checkoutReportResp.body=${JSON.stringify(checkoutReportResp)}`);
            chai.assert.deepInclude(checkoutReportResp.headers, getTransactionReportHeadersForAssertions(), `resp.headers=${JSON.stringify(checkoutReportResp.headers)}`);
            chai.assert.equal(checkoutReportResp.statusCode, 200, `checkoutReportResp.body=${JSON.stringify(checkoutReportResp.body)}`);
            chai.assert.deepEqualExcluding(checkoutReportResp.body[0], {
                id: "",
                transactionType: "checkout",
                currency: "USD",
                createdDate: null,
                transactionAmount: -1000,
                checkout_subtotal: 1000,
                checkout_tax: 0,
                checkout_discountLightrail: 0,
                checkout_paidLightrail: 50,
                checkout_paidStripe: 950,
                checkout_paidInternal: 0,
                checkout_remainder: 0,
                checkout_forgiven: 0,
                stepsCount: 2,
                marketplace_sellerNet: 0,
                marketplace_sellerDiscount: 0,
                marketplace_sellerGross: 0,
                metadata: null,
            }, ["createdDate", "id", "metadata"], `checkoutReportResp.body=${JSON.stringify(checkoutReportResp.body)}`);
        }).timeout(10000);
    });

    it("can format currencies", async () => {
        const resp = await testUtils.testAuthedCsvRequest<ReportTransaction>(router, "/v2/reports/transactions?transactionType=initialBalance&formatCurrencies=true", "GET");
        chai.assert.equal(resp.statusCode, 200, `resp.body=${JSON.stringify(resp.body)}`);
        chai.assert.deepInclude(resp.headers, getTransactionReportHeadersForAssertions(), `resp.headers=${JSON.stringify(resp.headers)}`);
        chai.assert.deepEqualExcluding(resp.body.find(tx => tx.id === initialBalanceId), {
            id: "",
            createdDate: null,
            transactionType: "initialBalance",
            currency: "USD",
            transactionAmount: "$10.00",
            checkout_subtotal: "$0.00",
            checkout_tax: "$0.00",
            checkout_discountLightrail: "$0.00",
            checkout_paidLightrail: "$0.00",
            checkout_paidStripe: "$0.00",
            checkout_paidInternal: "$0.00",
            checkout_remainder: "$0.00",
            checkout_forgiven: "$0.00",
            stepsCount: 1,
            marketplace_sellerNet: "$0.00",
            marketplace_sellerGross: "$0.00",
            marketplace_sellerDiscount: "$0.00",
            metadata: null
        }, ["id", "createdDate", "metadata"]);
    });

    it("can query by programId and createdDate", async () => {
        const queryReports = await testUtils.testAuthedCsvRequest(router, `/v2/reports/transactions?programId=${program.id}&createdDate.gte=2007-04-05T14:30:00.000Z`, "GET");
        chai.assert.equal(queryReports.statusCode, 200);
        chai.assert.deepInclude(queryReports.headers as any, getTransactionReportHeadersForAssertions(), `resp.headers=${JSON.stringify(queryReports.headers)}`);
        chai.assert.include(JSON.stringify(queryReports.body), initialBalanceId);
    });
});
