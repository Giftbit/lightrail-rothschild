import * as testUtils from "../../../utils/testUtils";
import * as cassava from "cassava";
import * as chai from "chai";
import {installRestRoutes} from "../installRestRoutes";
import * as crypto from "crypto";
import {initializeIntercomSecrets} from "../../../utils/intercomUtils";
import chaiExclude = require("chai-exclude");

chai.use(chaiExclude);

describe("/v2/user", () => {

    const intercomTestSecret = "TEST_SECRET";
    const router = new cassava.Router();

    before(async () => {
        await testUtils.resetDb();
        router.route(testUtils.authRoute);
        installRestRoutes(router);
        await initializeIntercomSecrets(Promise.resolve({
            secretKey: intercomTestSecret
        }));
    });

    describe("/v2/user/intercom", () => {
        const testId = testUtils.defaultTestUser.teamMemberId.replace("-TEST", "");

        it("gets expected hash", async () => {
            const expectedOutput = crypto.createHmac("sha256", intercomTestSecret)
                .update(testId)
                .digest("hex");

            const resp = await testUtils.testAuthedRequest<{ userHash: string; teamMemberId: string; }>(router, "/v2/user/intercom", "GET");
            chai.assert.equal(resp.statusCode, 200);
            chai.assert.equal(expectedOutput, resp.body.userHash);
            chai.assert.equal(testId, resp.body.teamMemberId);
        });
    });
});
