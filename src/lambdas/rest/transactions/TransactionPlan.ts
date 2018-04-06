import * as stripe from "stripe";
import {ValueStore} from "../../../model/ValueStore";
import {CartTransaction, TransactionType} from "../../../model/Transaction";

export interface TransactionPlan {
    transactionId: string;
    transactionType: TransactionType;
    cart?: CartTransaction;
    steps: TransactionPlanStep[];
    remainder: number;
}

export type TransactionPlanStep = LightrailTransactionPlanStep | StripeTransactionPlanStep | InternalTransactionPlanStep;

export interface LightrailTransactionPlanStep {
    rail: "lightrail";
    valueStore: ValueStore & {codeLastFour: string, customerId: string};
    amount: number;
}

export interface StripeTransactionPlanStep {
    rail: "stripe";
    token: string;
    stripeSecretKey: string;
    priority: number;
    maxAmount: number | null;
    amount: number;

    /**
     * Result of creating the charge in Stripe is only set if the plan is executed.
     */
    chargeResult?: stripe.charges.ICharge;
}

export interface InternalTransactionPlanStep {
    rail: "internal";
    internalId: string;
    value: number;
    pretax: boolean;
    appliedFirst: boolean;
    amount: number;
}
