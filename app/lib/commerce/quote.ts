export type CartLine = { variantId: string; quantity: number };

export type QuoteVariant = {
  id: string;
  sku: string;
  name: string;
  colour: string;
  sizeDescription: string;
  priceCents: number;
  available: number;
  active: boolean;
  version: number;
};

export type DeliveryMethod = "pickup" | "local_delivery" | "shipping";

export type QuoteErrorCode =
  | "INVALID_CART"
  | "DUPLICATE_VARIANT"
  | "INVALID_QUANTITY"
  | "UNKNOWN_VARIANT"
  | "UNAVAILABLE_VARIANT"
  | "INSUFFICIENT_STOCK"
  | "INVALID_VARIANT"
  | "INVALID_DELIVERY"
  | "INVALID_TIME"
  | "AMOUNT_OVERFLOW";

export class QuoteError extends Error {
  constructor(public readonly code: QuoteErrorCode) {
    super("The test cart could not be quoted.");
    this.name = "QuoteError";
  }
}

export type TestQuote = {
  testOnly: true;
  currency: "CAD";
  rulesVersion: "local-test-v1";
  expiresAt: number;
  lines: {
    variantId: string;
    sku: string;
    name: string;
    colour: string;
    sizeDescription: string;
    quantity: number;
    unitPriceCents: number;
    lineTotalCents: number;
    version: number;
  }[];
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  delivery: DeliveryMethod;
};

// Fictional local-test assumptions, not Canadian tax or delivery policy.
const TEST_SHIPPING_CENTS = {
  pickup: 0,
  local_delivery: 500,
  shipping: 1500,
} as const;
const TEST_QUOTE_TTL_MS = 10 * 60 * 1000;
const MAX_DATE_MS = 8_640_000_000_000_000;

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasText(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function checkedAmount(value: number): number {
  if (!isNonNegativeInteger(value)) throw new QuoteError("AMOUNT_OVERFLOW");
  return value;
}

/** Pure test-only calculation. Callers must load variants from trusted server data.
 * A quote neither reserves inventory nor authorizes a payment. Its contents must
 * be revalidated before any future reservation/payment flow.
 */
export function buildTestQuote(
  lines: readonly CartLine[],
  variants: readonly QuoteVariant[],
  delivery: DeliveryMethod,
  now: number,
): TestQuote {
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 20) {
    throw new QuoteError("INVALID_CART");
  }
  if (
    delivery !== "pickup" &&
    delivery !== "local_delivery" &&
    delivery !== "shipping"
  ) {
    throw new QuoteError("INVALID_DELIVERY");
  }
  if (!isNonNegativeInteger(now) || now > MAX_DATE_MS - TEST_QUOTE_TTL_MS) {
    throw new QuoteError("INVALID_TIME");
  }
  if (!Array.isArray(variants)) throw new QuoteError("INVALID_VARIANT");
  const byId = new Map<string, QuoteVariant>();
  const skus = new Set<string>();
  for (const variant of variants) {
    if (
      !variant ||
      !hasText(variant.id) ||
      !hasText(variant.sku) ||
      !hasText(variant.name) ||
      !hasText(variant.colour) ||
      !hasText(variant.sizeDescription) ||
      !isNonNegativeInteger(variant.priceCents) ||
      !isNonNegativeInteger(variant.available) ||
      !Number.isSafeInteger(variant.version) ||
      variant.version < 1 ||
      typeof variant.active !== "boolean" ||
      byId.has(variant.id) ||
      skus.has(variant.sku)
    ) {
      throw new QuoteError("INVALID_VARIANT");
    }
    byId.set(variant.id, variant);
    skus.add(variant.sku);
  }

  const seen = new Set<string>();
  let subtotalCents = 0;
  const quotedLines = lines.map((line) => {
    if (!line || !hasText(line.variantId)) throw new QuoteError("INVALID_CART");
    if (
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > 20
    ) {
      throw new QuoteError("INVALID_QUANTITY");
    }
    if (seen.has(line.variantId)) throw new QuoteError("DUPLICATE_VARIANT");
    seen.add(line.variantId);
    const variant = byId.get(line.variantId);
    if (!variant) throw new QuoteError("UNKNOWN_VARIANT");
    if (!variant.active) throw new QuoteError("UNAVAILABLE_VARIANT");
    if (variant.available < line.quantity) {
      throw new QuoteError("INSUFFICIENT_STOCK");
    }
    const lineTotalCents = checkedAmount(variant.priceCents * line.quantity);
    subtotalCents = checkedAmount(subtotalCents + lineTotalCents);
    return {
      variantId: variant.id,
      sku: variant.sku,
      name: variant.name,
      colour: variant.colour,
      sizeDescription: variant.sizeDescription,
      quantity: line.quantity,
      unitPriceCents: variant.priceCents,
      lineTotalCents,
      version: variant.version,
    };
  });
  const shippingCents = TEST_SHIPPING_CENTS[delivery];
  // Zero is a deliberately fictional test tax; never infer tax exemption from it.
  const taxCents = 0;
  return {
    testOnly: true,
    currency: "CAD",
    rulesVersion: "local-test-v1",
    expiresAt: now + TEST_QUOTE_TTL_MS,
    lines: quotedLines,
    subtotalCents,
    shippingCents,
    taxCents,
    totalCents: checkedAmount(subtotalCents + shippingCents + taxCents),
    delivery,
  };
}
