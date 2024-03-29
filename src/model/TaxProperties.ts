export interface TaxRequestProperties {
    roundingMode: TaxRoundingMode;
}

export type TaxRoundingMode = "HALF_EVEN" | "HALF_UP";