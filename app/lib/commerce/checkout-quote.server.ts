import {
  CANADIAN_REGIONS,
  CHECKOUT_CONTRACT_VERSION,
  parseCheckoutInput,
  type CanadianRegion,
  type CheckoutQuote,
} from "./checkout";
import { getCommerceVariantsByIds } from "./inventory.server";
import { buildTestQuote, QuoteError, type DeliveryMethod } from "./quote";

type DeliveryRule = {
  feeCents: number;
  provinces: readonly CanadianRegion[];
  postalPrefixes?: readonly string[];
};
export type TestCheckoutRules = {
  testOnly: true;
  version: string;
  taxBasisPoints: number;
  methods: Partial<Record<DeliveryMethod, DeliveryRule>>;
};

// Deliberately fictional: this is neither a Canadian tax calculation nor a
// business promise. In particular 10% tests nonzero tax and half-up rounding.
export const FICTIONAL_CHECKOUT_RULES: TestCheckoutRules = {
  testOnly: true,
  version: "fictional-delivery-v1",
  taxBasisPoints: 1000,
  methods: {
    pickup: { feeCents: 0, provinces: [] },
    local_delivery: {
      feeCents: 500,
      provinces: ["ON"],
      postalPrefixes: ["K1A"],
    },
    shipping: { feeCents: 1500, provinces: CANADIAN_REGIONS },
  },
};
export class CheckoutRuleError extends Error {
  constructor(
    public readonly code: "RULES_UNAVAILABLE" | "DELIVERY_UNAVAILABLE",
  ) {
    super("Test delivery rules are unavailable for this selection.");
    this.name = "CheckoutRuleError";
  }
}
function ruleFor(rules: TestCheckoutRules | undefined, method: DeliveryMethod) {
  const rule = rules?.methods?.[method];
  if (
    !rules ||
    rules.testOnly !== true ||
    !/^fictional-[a-z0-9-]{1,80}$/.test(rules.version) ||
    !Number.isSafeInteger(rules.taxBasisPoints) ||
    rules.taxBasisPoints < 0 ||
    rules.taxBasisPoints > 10000 ||
    !rule ||
    !Number.isSafeInteger(rule.feeCents) ||
    rule.feeCents < 0 ||
    !Array.isArray(rule.provinces) ||
    rule.provinces.some((p) => !CANADIAN_REGIONS.includes(p)) ||
    (method !== "pickup" && rule.provinces.length === 0) ||
    (rule.postalPrefixes !== undefined &&
      (!Array.isArray(rule.postalPrefixes) ||
        rule.postalPrefixes.length === 0 ||
        rule.postalPrefixes.some(
          (p) =>
            typeof p !== "string" ||
            !/^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTVWXYZ]$/.test(p),
        )))
  ) {
    throw new CheckoutRuleError("RULES_UNAVAILABLE");
  }
  return rule;
}
function amount(value: number) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new QuoteError("AMOUNT_OVERFLOW");
  return value;
}

/** Read-only, transient quote: no session, persistence, reservation or payment.
 * The response carries no contact/address or accepted-quote token. C09b2 must
 * discard it on ANY input change and ignore late requestIds. C09c must revalidate
 * and bind details/amounts to an owned order; this DTO cannot create an order.
 */
export async function quoteLocalCheckout(
  db: D1Database,
  raw: unknown,
  rules: TestCheckoutRules | undefined,
  now = Date.now(),
): Promise<CheckoutQuote> {
  const input = parseCheckoutInput(raw);
  const rule = ruleFor(rules, input.delivery.method);
  if (input.delivery.method !== "pickup") {
    const { address } = input.delivery;
    if (
      !rule.provinces.includes(address.province) ||
      (rule.postalPrefixes &&
        !rule.postalPrefixes.includes(address.postalCode.slice(0, 3)))
    ) {
      throw new CheckoutRuleError("DELIVERY_UNAVAILABLE");
    }
  }
  const quote = buildTestQuote(
    input.lines,
    await getCommerceVariantsByIds(
      db,
      input.lines.map((line) => line.variantId),
    ),
    input.delivery.method,
    now,
  );
  const taxBaseCents = amount(quote.subtotalCents + rule.feeCents);
  const taxCents = amount(
    Number(
      (BigInt(taxBaseCents) * BigInt(rules!.taxBasisPoints) + 5000n) / 10000n,
    ),
  );
  return {
    ...quote,
    contractVersion: CHECKOUT_CONTRACT_VERSION,
    requestId: input.requestId,
    rulesVersion: rules!.version,
    shippingCents: rule.feeCents,
    taxBaseCents,
    taxBasisPoints: rules!.taxBasisPoints,
    taxCents,
    totalCents: amount(taxBaseCents + taxCents),
  };
}
