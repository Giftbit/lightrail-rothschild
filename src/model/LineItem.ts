export interface LineItemRequest {
    type?: "product" | "shipping" | "fee";
    productId?: string;
    shippingId?: string;
    feeId?: string;
    variantId?: string;
    unitPrice: number;
    quantity?: number;
    tags?: string[];
    taxRate?: number;
    marketplaceRate?: number;
    metadata?: any;
}

export interface LineItemResponse extends LineItemRequest {
    lineTotal: LineTotal;
}

export interface LineTotal {
    subtotal: number;
    taxable: number;
    tax: number;
    discount: number;
    remainder: number; // not displayed but used during the order calculation
    sellerDiscount?: number;
    payable: number;
}

export type LineItem = LineItemRequest | LineItemResponse;
