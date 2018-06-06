import {RouterEvent} from "cassava";

export interface TransactionFilterParams {
    transactionType?: string;
    minCreatedDate?: Date;
    maxCreatedDate?: Date;
}

export namespace Filters {
    export function getTransactionFilterParams(evt: RouterEvent): TransactionFilterParams {
        return {
            transactionType: evt.queryStringParameters["transactionType"] || null,
            minCreatedDate: evt.queryStringParameters["minCreatedDate"] ? new Date(evt.queryStringParameters["minCreatedDate"]) : null,
            maxCreatedDate: evt.queryStringParameters["maxCreatedDate"] ? new Date(evt.queryStringParameters["maxCreatedDate"]) : null
        };
    }
}