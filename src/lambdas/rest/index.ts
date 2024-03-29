import * as cassava from "cassava";
import * as giftbitRoutes from "giftbit-cassava-routes";
import * as logPrefix from "loglevel-plugin-prefix";
import {installRestRoutes} from "./installRestRoutes";
import {CodeCryptographySecrets, initializeCodeCryptographySecrets} from "../../utils/codeCryptoUtils"; // Prefix log messages with the level.
import {initializeAssumeCheckoutToken, initializeLightrailStripeConfig} from "../../utils/stripeUtils/stripeAccess";
import {StripeConfig} from "../../utils/stripeUtils/StripeConfig";
import log = require("loglevel");

// Wrapping console.log instead of binding (default behaviour for loglevel)
// Otherwise all log calls are prefixed with the requestId from the first
// request the lambda received (AWS modifies log calls, loglevel binds to the
// version of console.log that exists when it is initialized).
// See https://github.com/pimterry/loglevel/blob/master/lib/loglevel.js
// eslint-disable-next-line no-console
log.methodFactory = () => (...args) => console.log(...args);

// Prefix log messages with the level.
logPrefix.reg(log);
logPrefix.apply(log, {
    format: (level, name, timestamp) => {
        return `[${level}]`;
    },
});

// Set the log level when running in Lambda.
log.setLevel(log.levels.INFO);

const router = new cassava.Router();

router.route(new cassava.routes.LoggingRoute({
    logFunction: log.info,
    logRequestHeaders: ["Lightrail-Client"]
}));

router.route(new giftbitRoutes.MetricsRoute({
    logFunction: log.info
}));

router.route(new giftbitRoutes.HealthCheckRoute("/v2/healthCheck"));

router.route(new giftbitRoutes.jwtauth.JwtAuthorizationRoute({
    authConfigPromise: giftbitRoutes.secureConfig.fetchFromS3ByEnvVar<any>("SECURE_CONFIG_BUCKET", "SECURE_CONFIG_KEY_JWT"),
    rolesConfigPromise: giftbitRoutes.secureConfig.fetchFromS3ByEnvVar<any>("SECURE_CONFIG_BUCKET", "SECURE_CONFIG_KEY_ROLE_DEFINITIONS"),
    sharedSecretProvider: new giftbitRoutes.jwtauth.sharedSecret.RestSharedSecretProvider(`https://${process.env["LIGHTRAIL_DOMAIN"]}/v1/storage/jwtSecret`, giftbitRoutes.secureConfig.fetchFromS3ByEnvVar<giftbitRoutes.secureConfig.AssumeScopeToken>("SECURE_CONFIG_BUCKET", "SECURE_CONFIG_KEY_ASSUME_STORAGE_SCOPE_TOKEN"),
    ),
    infoLogFunction: log.info,
    errorLogFunction: log.error,
    onAuth: auth => giftbitRoutes.sentry.setSentryUser(auth)
}));

initializeCodeCryptographySecrets(
    giftbitRoutes.secureConfig.fetchFromS3ByEnvVar<CodeCryptographySecrets>("SECURE_CONFIG_BUCKET", "SECURE_CONFIG_KEY_CODE_CRYTPOGRAPHY")
);

initializeAssumeCheckoutToken(
    giftbitRoutes.secureConfig.fetchFromS3ByEnvVar<giftbitRoutes.secureConfig.AssumeScopeToken>("SECURE_CONFIG_BUCKET", "SECURE_CONFIG_KEY_ASSUME_RETRIEVE_STRIPE_AUTH")
);

initializeLightrailStripeConfig(
    giftbitRoutes.secureConfig.fetchFromS3ByEnvVar<StripeConfig>("SECURE_CONFIG_BUCKET", "SECURE_CONFIG_KEY_STRIPE")
);

installRestRoutes(router);

// Export the lambda handler with Sentry error logging supported.
export const handler = giftbitRoutes.sentry.wrapLambdaHandler({
    router,
    logger: log.error,
    sentryDsn: process.env["SENTRY_DSN"]
});
