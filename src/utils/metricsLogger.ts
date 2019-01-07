import * as giftbitRoutes from "giftbit-cassava-routes";
import {TransactionType} from "../model/Transaction";
import {StripeTransactionPlanStep} from "../lambdas/rest/transactions/TransactionPlan";
import * as Stripe from "stripe";
import log = require("loglevel");

export namespace MetricsLogger {
    export function valueAttachment(attachType: valueAttachmentTypes, auth: giftbitRoutes.jwtauth.AuthorizationBadge) {
        logMetric(1, metricsType.histogram, `rothschild.values.attach.${attachType}`, {}, auth);
    }

    export function transaction(value: number, transactionType: TransactionType, auth: giftbitRoutes.jwtauth.AuthorizationBadge) {
        logMetric(value, metricsType.histogram, `rothschild.transactions`, {}, auth);
        logMetric(value, metricsType.histogram, `rothschild.transactions.${transactionType}`, {}, auth);
    }
}

export enum valueAttachmentTypes {
    onCreate = "onCreate",
    generic = "generic",
    genericAsNew = "genericAsNew",
    unique = "unique"
}

/**
 * Uses Cloudwatch logs to send arbitrary metrics to Datadog: see https://docs.datadoghq.com/integrations/amazon_lambda/#using-cloudwatch-logs for details
 * Log message follows format `MONITORING|<unix_epoch_timestamp_in_seconds>|<value>|<metric_type>|<metric_name>|#<tag_key>:<tag_value>`
 * The tag function_name:<name_of_the_function> is added automatically
 */
function logMetric(value: number, metricType: metricsType, metricName: string, tags: {} | { [key: string]: string }, auth: giftbitRoutes.jwtauth.AuthorizationBadge): void {
    let tagString: string = "";
    Object.keys(tags).forEach(key => tagString += `#${key}:${tags[key]},`);

    log.info(`MONITORING|` +
        `${Math.round(Date.now() / 1000)}|` +
        `${value}|` +
        `${metricType}|` +
        `${metricName}|` +
        `${tagString}` +
        `#userId:${auth.userId},` +
        `#teamMemberId:${auth.teamMemberId}`);
}

/**
 * Legal types of metrics: https://docs.datadoghq.com/integrations/amazon_lambda/#using-cloudwatch-logs
 */
enum metricsType {
    histogram = "histogram",
    count = "count",
    gauge = "gauge",
    check = "check"
}
