import {TaxRoundingMode} from "../model/TaxProperties";

/**
 * Bankers rounding is to help make results that end in .5 from always rounding up.
 * The problem with always rounding up on .5's in respect to money is that it is favoured.
 * Bankers rounding attempts to make rounding more fair. Now, results that end in x.5 will be
 * evaluated based on whether x is even or odd. If even, round down. If odd, round up.
 * ie:
 *  - bankersRounding(0.5, 0) => 0
 *  - bankersRounding(1.5, 0) => 2
 *
 * source http://stackoverflow.com/a/3109234
 */
export function bankersRounding(num: number, decimalPlaces: number): number {
    const d = decimalPlaces || 0;
    const m = Math.pow(10, d);
    const n = +(d ? num * m : num).toFixed(8); // Avoid rounding errors
    const i = Math.floor(n), f = n - i;
    const e = 1e-8; // Allow for rounding errors in f
    const r = (f > 0.5 - e && f < 0.5 + e) ?
        ((i % 2 === 0) ? i : i + 1) :
        Math.round(n);

    return d ? r / m : r;
}

export function roundTax(tax: number, mode: TaxRoundingMode): number {
    switch (mode) {
        case "HALF_EVEN":
            return bankersRounding(tax, 0);
        case "HALF_UP":
            return Math.round(tax);
        default:
            throw new Error(`Unexpected mode: ${mode}.`);
    }
}
