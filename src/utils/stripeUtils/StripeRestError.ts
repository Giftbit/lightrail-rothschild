import * as cassava from "cassava";
import * as Stripe from "stripe";

export class StripeRestError extends cassava.RestError {

    readonly isStripeRestError = true;

    constructor(statusCode: number, message: string, messageCode: string, stripeError: Stripe.IStripeError) {
        super(statusCode, message, {
            messageCode,
            stripeError: StripeRestError.santizeStripeError(stripeError)
        });
    }

    get stripeError(): Stripe.IStripeError {
        return this.additionalParams["stripeError"];
    }

    /**
     * Remove properties of the StripeError we don't want to share.
     * @param error
     */
    static santizeStripeError(error: Stripe.IStripeError): Stripe.IStripeError {
        return {
            ...error,
            stack: undefined
        } as any;
    }
}
