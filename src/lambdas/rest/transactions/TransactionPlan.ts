import * as stripe from "stripe";
import {TransactionPlanTotals, TransactionType} from "../../../model/Transaction";
import {Value} from "../../../model/Value";
import {LineItemResponse} from "../../../model/LineItem";
import {OrderRequest, TransactionParty} from "../../../model/TransactionRequest";

export class TransactionPlan {
    id: string;
    transactionType: TransactionType;
    currency: string;
    totals: TransactionPlanTotals;
    lineItems: LineItemResponse[] | null;
    paymentSources: TransactionParty[] | null;
    steps: TransactionPlanStep[];
    metadata: object | null;


    constructor(order: OrderRequest, steps: TransactionPlanStep[]) {
        let lineItemResponses: LineItemResponse[] = [];
        for (let lineItem of order.lineItems) {
            lineItem.quantity = lineItem.quantity ? lineItem.quantity : 1;
            const subtotal = lineItem.unitPrice * lineItem.quantity;
            let lineItemResponse: LineItemResponse = {
                ...lineItem,
                lineTotal: {
                    subtotal: subtotal,
                    taxable: subtotal,
                    tax: 0,
                    discount: 0,
                    remainder: subtotal,
                    payable: 0
                }
            };
            lineItemResponses.push(lineItemResponse);
        }
        this.id = order.id;
        this.transactionType = "order";
        this.currency = order.currency;
        this.lineItems = lineItemResponses;
        this.steps = steps;
        this.metadata = order.metadata;
        this.paymentSources = order.sources; // TODO if secure code, only return last four
        this.calculateTotalsFromLineItems();
    }

    calculateRemainderFromLineItems?(): number {
        let remainder = 0;
        for (const item of this.lineItems) {
            remainder += item.lineTotal.remainder;
        }
        return remainder;
    }

    calculateTotalsFromLineItems?(): void {
        this.totals = {
            subTotal: 0,
            tax: 0,
            discount: 0,
            payable: 0,
            remainder: this.calculateRemainderFromLineItems(),
        };
        for (let item of this.lineItems) {
            item.lineTotal.payable = item.lineTotal.subtotal + item.lineTotal.tax - item.lineTotal.discount;
            this.totals.subTotal += item.lineTotal.subtotal;
            this.totals.tax += item.lineTotal.tax;
            this.totals.discount += item.lineTotal.discount;
            this.totals.payable += item.lineTotal.payable;
        }
        this.totals.remainder = this.calculateRemainderFromLineItems();
    }
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
    balance: number;
    pretax: boolean;
    beforeLightrail: boolean;
    amount: number;
}
