import {
    InternalTransactionPlanStep,
    LightrailUpdateTransactionPlanStep,
    StripeTransactionPlanStep,
    TransactionPlan,
    TransactionPlanStep
} from "../TransactionPlan";
import {CheckoutRequest, TransactionParty} from "../../../../model/TransactionRequest";
import {LineItemResponse} from "../../../../model/LineItem";
import {TransactionTotals, TransactionType} from "../../../../model/Transaction";
import {bankersRounding, roundTax} from "../../../../utils/moneyUtils";
import {TaxRequestProperties} from "../../../../model/TaxProperties";
import {getPendingVoidDate} from "../pendingTransactionUtils";

export class CheckoutTransactionPlan implements TransactionPlan {

    id: string;
    transactionType: TransactionType;
    currency: string;
    totals: TransactionTotals;
    lineItems: LineItemResponse[] | null;
    paymentSources: TransactionParty[] | null;
    steps: TransactionPlanStep[];
    tax: TaxRequestProperties;
    pendingVoidDate?: Date;
    createdDate: Date;
    metadata: object | null;

    constructor(checkout: CheckoutRequest, steps: TransactionPlanStep[], now: Date) {
        const lineItemResponses: LineItemResponse[] = [];
        for (const lineItem of checkout.lineItems) {
            lineItem.quantity = lineItem.quantity ? lineItem.quantity : 1;
            const subtotal = lineItem.unitPrice * lineItem.quantity;
            const lineItemResponse: LineItemResponse = {
                ...lineItem,
                lineTotal: {
                    subtotal: subtotal,
                    taxable: subtotal,
                    tax: 0,
                    discount: 0,
                    sellerDiscount: 0,
                    remainder: subtotal,
                    payable: 0
                }
            };
            lineItemResponses.push(lineItemResponse);
        }
        this.id = checkout.id;
        this.transactionType = "checkout";
        this.currency = checkout.currency?.toUpperCase();
        this.lineItems = lineItemResponses.sort((a, b) => b.lineTotal.subtotal - a.lineTotal.subtotal);
        this.steps = steps;
        this.paymentSources = checkout.sources; // TODO if secure code, only return last four
        this.tax = checkout.tax;
        this.pendingVoidDate = getPendingVoidDate(checkout, now, {
            hasStripe: !!this.steps.find(step => step.rail === "stripe")
        });
        this.createdDate = now;
        this.metadata = checkout.metadata;
        this.calculateTotalsFromLineItemsAndSteps();
    }

    calculateTotalsFromLineItemsAndSteps(): void {
        this.totals = {
            subtotal: 0,
            tax: 0,
            discount: 0,
            payable: 0,
            remainder: 0,
            forgiven: 0,
            discountLightrail: this.steps.filter(step => step.rail === "lightrail" && step.value.discount === true).reduce((prev, step) => prev + (step as LightrailUpdateTransactionPlanStep).amount, 0) * -1,
            paidLightrail: this.steps.filter(step => step.rail === "lightrail" && step.value.discount === false).reduce((prev, step) => prev + (step as LightrailUpdateTransactionPlanStep).amount, 0) * -1,
            paidStripe: this.steps.filter(step => step.rail === "stripe").reduce((prev, step) => prev + (step as StripeTransactionPlanStep).amount, 0) * -1,
            paidInternal: this.steps.filter(step => step.rail === "internal").reduce((prev, step) => prev + (step as InternalTransactionPlanStep).amount, 0) * -1,
        };
        for (const item of this.lineItems) {
            item.lineTotal.payable = item.lineTotal.subtotal + item.lineTotal.tax - item.lineTotal.discount;
            this.totals.subtotal += item.lineTotal.subtotal;
            this.totals.tax += item.lineTotal.tax;
            this.totals.discount += item.lineTotal.discount;
            this.totals.payable += item.lineTotal.payable;
        }
        for (const item of this.lineItems) {
            this.totals.remainder += item.lineTotal.remainder;
        }

        this.calculateMarketplaceTotals();
    }

    private calculateMarketplaceTotals(): void {
        if (!this.hasLineItemWithMarketplaceRateSet() && !this.hasValueWithDiscountSellerLiabilitySet()) {
            // Marketplace totals are only set if an item has a marketplaceRate or if discountSellerLiability is set on a Value.
            this.totals.marketplace = undefined;
            for (const item of this.lineItems) {
                item.lineTotal.sellerDiscount = undefined;
            }
            return;
        }

        let sellerGross = 0;
        let sellerDiscount = 0;
        for (const item of this.lineItems) {
            const rate = item.marketplaceRate != null ? item.marketplaceRate : 0;
            sellerGross += (1.0 - rate) * item.unitPrice * (item.quantity || 1);
            sellerDiscount += item.lineTotal.sellerDiscount;
        }
        sellerGross = bankersRounding(sellerGross, 0);
        sellerDiscount = bankersRounding(sellerDiscount, 0);

        this.totals.marketplace = {
            sellerGross: sellerGross,
            sellerDiscount: sellerDiscount,
            sellerNet: sellerGross - sellerDiscount
        };
    }

    calculateTaxAndSetOnLineItems(): void {
        if (!this.tax) {
            this.tax = {roundingMode: "HALF_EVEN"};
        }
        for (const item of this.lineItems) {
            let tax = 0;
            item.lineTotal.taxable = item.lineTotal.remainder;
            if (item.taxRate >= 0) {
                tax = roundTax(item.taxRate * item.lineTotal.taxable, this.tax.roundingMode);
            }
            item.lineTotal.tax = tax;
            item.lineTotal.remainder += tax;
        }
    }

    private hasLineItemWithMarketplaceRateSet(): boolean {
        return !!(this.lineItems.find(lineItem => lineItem.marketplaceRate !== undefined));
    }

    private hasValueWithDiscountSellerLiabilitySet(): boolean {
        return !!this.steps.find(step =>
            step.rail === "lightrail" && step.value.discount && !!step.value.discountSellerLiabilityRule
        );
    }
}
