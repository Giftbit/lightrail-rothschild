export interface TransactionResponse {
    transactionType: "credit" | "debit" | "transfer" | "pending_create" | "pending_capture" | "pending_void";
    cart?: any; // includes item-level and cart-level explanation of how value was applied
    partners?: TransactionResponsePartner[];
}

/*
public enum TransactionType {
    DRAWDOWN,
    FUND,
    INITIAL_VALUE,
    CANCELLATION,
    INACTIVATE,
    ACTIVATE,
    FREEZE,
    UNFREEZE,
    PENDING_CREATE,
    PENDING_VOID,
    PENDING_CAPTURE,
    DRAWDOWN_REFUND,
    REDEEM,

    @Deprecated
    REFUND;
}
 */

export type TransactionResponsePartner = LightrailTransactionResponsePartner | StripeTransactionResponsePartner | InternalTransactionResponsePartner;

export interface LightrailTransactionResponsePartner {
    rail: "lightrail";
    valueStoreId: string;
    customerId?: string;
    codeLastFour?: string;
    valueBefore: number;
    valueAfter: number;
    valueChange: number;
}

export interface StripeTransactionResponsePartner {
    rail: "stripe";
    chargeId: string;
    amount: number;
    // maybe the whole JSON from https://stripe.com/docs/api#charge_object
}

export interface InternalTransactionResponsePartner {
    rail: "internal";
    id: string;
    valueBefore: number;
    valueAfter: number;
    valueUsed: number;
}
