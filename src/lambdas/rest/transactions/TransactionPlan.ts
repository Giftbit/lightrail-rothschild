import * as stripe from "stripe";
import {
    InternalDbTransactionStep,
    InternalTransactionStep,
    LightrailDbTransactionStep,
    LightrailTransactionStep,
    StripeDbTransactionStep,
    StripeTransactionStep,
    Transaction,
    TransactionPlanTotals,
    TransactionStep,
    TransactionType
} from "../../../model/Transaction";
import {Value} from "../../../model/Value";
import {LineItemResponse} from "../../../model/LineItem";
import {TransactionParty} from "../../../model/TransactionRequest";
import * as crypto from "crypto";
import * as giftbitRoutes from "giftbit-cassava-routes";

export interface TransactionPlan {
    id: string;
    transactionType: TransactionType;
    currency: string;
    totals: TransactionPlanTotals;
    lineItems: LineItemResponse[] | null;
    paymentSources: TransactionParty[] | null;
    steps: TransactionPlanStep[];
    createdDate: Date;
    metadata: object | null;
}

export type TransactionPlanStep =
    LightrailTransactionPlanStep
    | StripeTransactionPlanStep
    | InternalTransactionPlanStep;

export interface LightrailTransactionPlanStep {
    rail: "lightrail";
    value: Value;
    amount: number;
}

export interface StripeTransactionPlanStep {
    rail: "stripe";
    idempotentStepId: string;
    source?: string;
    customer?: string;
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
    balance: number;
    pretax: boolean;
    beforeLightrail: boolean;
    amount: number;
}

export namespace TransactionPlanStep {
    export function toInternalTransactionStep(step: InternalTransactionPlanStep): InternalTransactionStep {
        return {
            rail: "internal",
            internalId: step.internalId,
            balanceBefore: step.balance,
            balanceAfter: step.balance + step.amount,
            balanceChange: step.amount
        };
    }
}

export namespace LightrailTransactionPlanStep {
    export function toLightrailDbTransactionStep(step: LightrailTransactionPlanStep, plan: TransactionPlan, auth: giftbitRoutes.jwtauth.AuthorizationBadge, stepIndex: number): LightrailDbTransactionStep {
        return {
            userId: auth.giftbitUserId,
            id: `${plan.id}-${stepIndex}`,
            transactionId: plan.id,
            ...getSharedProperties(step)
        }
    }

    export function toLightrailTransactionStep(step: LightrailTransactionPlanStep): LightrailTransactionStep {
        return {
            rail: "lightrail",
            ...getSharedProperties(step),
        }
    }

    function getSharedProperties(step: LightrailTransactionPlanStep) {
        let sharedProperties = {
            valueId: step.value.id,
            contactId: step.value.contactId,
            code: step.value.code,
            balanceBefore: step.value.balance,
            balanceAfter: step.value.balance + step.amount,
            balanceChange: step.amount
        };
        if (step.value.valueRule !== null) {
            sharedProperties.balanceBefore = 0;
            sharedProperties.balanceAfter = 0;
        }
        return sharedProperties;
    }
}

export namespace StripeTransactionPlanStep {
    export function toStripeDbTransactionStep(step: StripeTransactionPlanStep, plan: TransactionPlan, auth: giftbitRoutes.jwtauth.AuthorizationBadge): StripeDbTransactionStep {
        return {
            userId: auth.giftbitUserId,
            id: step.idempotentStepId,
            transactionId: plan.id,
            chargeId: step.chargeResult.id,
            currency: step.chargeResult.currency,
            amount: step.chargeResult.amount,
            charge: JSON.stringify(step.chargeResult)
        }
    }

    export function toStripeTransactionStep(step: StripeTransactionPlanStep): StripeTransactionStep {
        let stripeTransactionStep: StripeTransactionStep = {
            rail: "stripe",
            chargeId: null,
            charge: null,
            amount: step.amount

        };
        if (step.chargeResult) {
            stripeTransactionStep.chargeId = step.chargeResult.id;
            stripeTransactionStep.charge = step.chargeResult;
            stripeTransactionStep.amount = -step.chargeResult.amount /* chargeResult.amount is positive for debits */;
        }
        return stripeTransactionStep
    }
}

export namespace InternalTransactionPlanStep {
    export function toInternalDbTransactionStep(step: InternalTransactionPlanStep, plan: TransactionPlan, auth: giftbitRoutes.jwtauth.AuthorizationBadge): InternalDbTransactionStep {
        return {
            userId: auth.giftbitUserId,
            id: crypto.createHash("sha1").update(plan.id + "/" + step.internalId).digest("base64"),
            transactionId: plan.id,
            ...getSharedProperties(step)
        }
    }

    export function toInternalTransactionStep(step: InternalTransactionPlanStep): InternalTransactionStep {
        return {
            rail: "internal",
            ...getSharedProperties(step)
        }
    }

    function getSharedProperties(step: InternalTransactionPlanStep) {
        return {
            internalId: step.internalId,
            balanceBefore: step.balance,
            balanceAfter: step.balance + step.amount /* step.amount is negative if debit */,
            balanceChange: step.amount
        }
    }
}

export namespace TransactionPlan {
    export function transactionPlanToTransaction(plan: TransactionPlan, simulated?: boolean): Transaction {
        const transaction: Transaction = {
            id: plan.id,
            transactionType: plan.transactionType,
            currency: plan.currency,
            totals: plan.totals,
            lineItems: plan.lineItems,
            steps: plan.steps.map(step => transactionPlanStepToTransactionStep(step, plan)),
            paymentSources: plan.paymentSources,
            metadata: plan.metadata || null,
            createdDate: plan.createdDate
        };
        if (simulated) {
            transaction.simulated = true;
        }
        return transaction;
    }

    function transactionPlanStepToTransactionStep(step: TransactionPlanStep, plan: TransactionPlan): TransactionStep {
        switch (step.rail) {
            case "lightrail":
                return LightrailTransactionPlanStep.toLightrailTransactionStep(step);
            case "stripe":
                return StripeTransactionPlanStep.toStripeTransactionStep(step);
            case "internal":
                return InternalTransactionPlanStep.toInternalTransactionStep(step);
        }
    }
}
