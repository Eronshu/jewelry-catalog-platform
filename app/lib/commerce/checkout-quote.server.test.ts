import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  quoteLocalCheckout,
  FICTIONAL_CHECKOUT_RULES,
  type TestCheckoutRules,
} from "./checkout-quote.server";
import { getCommerceVariantsByIds } from "./inventory.server";
import { CHECKOUT_CONTRACT_VERSION } from "./checkout";

vi.mock("./inventory.server", () => ({ getCommerceVariantsByIds: vi.fn() }));
const db = {} as D1Database;
const now = 1_800_000_000_000;
const input = () => ({
  contractVersion: CHECKOUT_CONTRACT_VERSION,
  requestId: "11111111-1111-4111-8111-111111111111",
  lines: [{ variantId: "v", quantity: 2 }],
  contact: { name: "Fictional Customer", email: "c@example.invalid" },
  delivery: {
    method: "shipping",
    address: {
      line1: "100 Fictional Test Street",
      city: "Test City",
      province: "ON",
      postalCode: "K1A 0B1",
      country: "CA",
    },
  },
});
const variant = {
  id: "v",
  sku: "TEST-V",
  name: "Fictional necklace",
  colour: "Gold-tone",
  sizeDescription: "Fictional single size",
  priceCents: 1995,
  available: 4,
  active: true,
  version: 2,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCommerceVariantsByIds).mockResolvedValue([{ ...variant }]);
});
describe("read-only delivery quote", () => {
  it.each([
    ["pickup", 0, 399, 4389],
    ["local_delivery", 500, 449, 4939],
    ["shipping", 1500, 549, 6039],
  ] as const)(
    "calculates %s with explicit fictional charges",
    async (method, shippingCents, taxCents, totalCents) => {
      const quote = await quoteLocalCheckout(
        db,
        { ...input(), delivery: { ...input().delivery, method } },
        FICTIONAL_CHECKOUT_RULES,
        now,
      );
      expect(quote).toMatchObject({
        testOnly: true,
        currency: "CAD",
        contractVersion: CHECKOUT_CONTRACT_VERSION,
        requestId: input().requestId,
        rulesVersion: "fictional-delivery-v1",
        subtotalCents: 3990,
        shippingCents,
        taxCents,
        totalCents,
        taxBaseCents: 3990 + shippingCents,
        taxBasisPoints: 1000,
        expiresAt: now + 600_000,
        delivery: method,
      });
      expect(quote.lines[0]).toMatchObject({
        unitPriceCents: 1995,
        version: 2,
      });
      const serialized = JSON.stringify(quote);
      for (const privateValue of [
        "Fictional Customer",
        "c@example.invalid",
        "100 Fictional Test Street",
        "Test City",
        "K1A0B1",
      ])
        expect(serialized).not.toContain(privateValue);
    },
  );
  it("ignores submitted money, stock and rule values and reads exact IDs", async () => {
    const quote = await quoteLocalCheckout(
      db,
      {
        ...input(),
        shippingCents: 0,
        taxBasisPoints: 0,
        totalCents: 1,
        rulesVersion: "free",
        lines: [{ variantId: "v", quantity: 2, priceCents: 1, available: 999 }],
      },
      FICTIONAL_CHECKOUT_RULES,
      now,
    );
    expect(quote.totalCents).toBe(6039);
    expect(getCommerceVariantsByIds).toHaveBeenCalledWith(db, ["v"]);
  });
  it("rounds half cents up using integer arithmetic and rejects overflow", async () => {
    vi.mocked(getCommerceVariantsByIds).mockResolvedValue([
      { ...variant, priceCents: 5 },
    ]);
    const pickup = {
      ...input(),
      lines: [{ variantId: "v", quantity: 1 }],
      delivery: { method: "pickup" },
    };
    expect(
      (await quoteLocalCheckout(db, pickup, FICTIONAL_CHECKOUT_RULES, now))
        .taxCents,
    ).toBe(1);
    vi.mocked(getCommerceVariantsByIds).mockResolvedValue([
      { ...variant, priceCents: Number.MAX_SAFE_INTEGER },
    ]);
    await expect(
      quoteLocalCheckout(db, pickup, FICTIONAL_CHECKOUT_RULES, now),
    ).rejects.toMatchObject({ code: "AMOUNT_OVERFLOW" });
  });
  it.each([
    undefined,
    { ...FICTIONAL_CHECKOUT_RULES, taxBasisPoints: undefined },
    { ...FICTIONAL_CHECKOUT_RULES, taxBasisPoints: -1 },
    { ...FICTIONAL_CHECKOUT_RULES, taxBasisPoints: 0.5 },
    { ...FICTIONAL_CHECKOUT_RULES, version: "production" },
    { ...FICTIONAL_CHECKOUT_RULES, methods: {} },
    {
      ...FICTIONAL_CHECKOUT_RULES,
      methods: { shipping: { feeCents: -1, provinces: ["ON"] } },
    },
    {
      ...FICTIONAL_CHECKOUT_RULES,
      methods: { shipping: { feeCents: 0, provinces: [] } },
    },
  ])("fails closed for absent/invalid rules %j", async (rules) => {
    await expect(
      quoteLocalCheckout(db, input(), rules as TestCheckoutRules, now),
    ).rejects.toMatchObject({ code: "RULES_UNAVAILABLE" });
    expect(getCommerceVariantsByIds).not.toHaveBeenCalled();
  });
  it.each([
    { province: "AB", postalCode: "T1A0B1" },
    { province: "ON", postalCode: "M1A0B1" },
  ])(
    "rejects outside fictional local coverage %j before DB access",
    async (change) => {
      const value = input();
      value.delivery.method = "local_delivery";
      Object.assign(value.delivery.address, change);
      await expect(
        quoteLocalCheckout(db, value, FICTIONAL_CHECKOUT_RULES, now),
      ).rejects.toMatchObject({ code: "DELIVERY_UNAVAILABLE" });
      expect(getCommerceVariantsByIds).not.toHaveBeenCalled();
    },
  );
  it.each([
    { variants: [{ ...variant, active: false }], code: "UNAVAILABLE_VARIANT" },
    { variants: [{ ...variant, available: 1 }], code: "INSUFFICIENT_STOCK" },
    { variants: [], code: "UNKNOWN_VARIANT" },
  ])(
    "refuses unavailable variants without returning private metadata",
    async ({ variants, code }) => {
      vi.mocked(getCommerceVariantsByIds).mockResolvedValue(variants);
      await expect(
        quoteLocalCheckout(db, input(), FICTIONAL_CHECKOUT_RULES, now),
      ).rejects.toMatchObject({ code });
    },
  );
  it("rereads changed price/version/stock on every request", async () => {
    const before = await quoteLocalCheckout(
      db,
      input(),
      FICTIONAL_CHECKOUT_RULES,
      now,
    );
    vi.mocked(getCommerceVariantsByIds).mockResolvedValue([
      { ...variant, priceCents: 2500, version: 3 },
    ]);
    const after = await quoteLocalCheckout(
      db,
      input(),
      FICTIONAL_CHECKOUT_RULES,
      now + 1,
    );
    expect(after.totalCents).not.toBe(before.totalCents);
    expect(after.lines[0].version).toBe(3);
    vi.mocked(getCommerceVariantsByIds).mockResolvedValue([
      { ...variant, available: 0 },
    ]);
    await expect(
      quoteLocalCheckout(db, input(), FICTIONAL_CHECKOUT_RULES, now + 2),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
  });
});
