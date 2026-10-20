import { describe, expect, it } from "vitest";
import {
  buildTestQuote,
  QuoteError,
  type CartLine,
  type DeliveryMethod,
  type QuoteErrorCode,
  type QuoteVariant,
} from "./quote";

const now = 1_790_000_000_000;
const gold: QuoteVariant = {
  id: "test-gold",
  sku: "TEST-NECKLACE-GOLD",
  name: "Fictional necklace",
  colour: "Gold",
  sizeDescription: "Test one size",
  priceCents: 1995,
  available: 4,
  active: true,
  version: 1,
};
const silver: QuoteVariant = {
  ...gold,
  id: "test-silver",
  sku: "TEST-NECKLACE-SILVER",
  colour: "Silver",
  priceCents: 2100,
};
const cart: CartLine[] = [{ variantId: gold.id, quantity: 2 }];

function expectError(action: () => unknown, code: QuoteErrorCode) {
  expect(action).toThrow(QuoteError);
  expect(action).toThrow(expect.objectContaining({ code }));
}

describe("buildTestQuote", () => {
  it.each([
    ["pickup", 0],
    ["local_delivery", 500],
    ["shipping", 1500],
  ] as const)(
    "quotes %s with explicit fictional fees and zero tax",
    (delivery, fee) => {
      const quote = buildTestQuote(
        [...cart, { variantId: silver.id, quantity: 1 }],
        [gold, silver],
        delivery,
        now,
      );
      expect(quote).toEqual({
        testOnly: true,
        currency: "CAD",
        rulesVersion: "local-test-v1",
        expiresAt: now + 600_000,
        lines: [
          {
            variantId: gold.id,
            sku: gold.sku,
            name: gold.name,
            colour: "Gold",
            sizeDescription: gold.sizeDescription,
            quantity: 2,
            unitPriceCents: 1995,
            lineTotalCents: 3990,
            version: 1,
          },
          {
            variantId: silver.id,
            sku: silver.sku,
            name: silver.name,
            colour: "Silver",
            sizeDescription: silver.sizeDescription,
            quantity: 1,
            unitPriceCents: 2100,
            lineTotalCents: 2100,
            version: 1,
          },
        ],
        subtotalCents: 6090,
        shippingCents: fee,
        taxCents: 0,
        totalCents: 6090 + fee,
        delivery,
      });
    },
  );

  it("ignores client supplied price, tax, total and availability fields", () => {
    const tampered = [
      {
        ...cart[0],
        priceCents: 1,
        totalCents: 1,
        taxCents: -100,
        available: 999,
      },
    ];
    expect(buildTestQuote(tampered, [gold], "shipping", now).totalCents).toBe(
      5490,
    );
  });

  it("does not mutate inputs or share output references with them", () => {
    const frozenCart = Object.freeze([Object.freeze({ ...cart[0] })]);
    const frozenVariants = Object.freeze([Object.freeze({ ...gold })]);
    const quote = buildTestQuote(frozenCart, frozenVariants, "pickup", now);
    quote.lines[0].quantity = 99;
    expect(frozenCart[0].quantity).toBe(2);
    expect(frozenVariants[0].available).toBe(4);
  });

  it("supports zero price without making a production payment eligibility claim", () => {
    expect(
      buildTestQuote(cart, [{ ...gold, priceCents: 0 }], "pickup", 0)
        .totalCents,
    ).toBe(0);
  });

  it("allows exactly twenty lines and twenty units per line", () => {
    const variants = Array.from({ length: 20 }, (_, i) => ({
      ...gold,
      id: `v${i}`,
      sku: `SKU${i}`,
      available: 20,
    }));
    const lines = variants.map((v) => ({ variantId: v.id, quantity: 20 }));
    expect(buildTestQuote(lines, variants, "pickup", now).subtotalCents).toBe(
      798000,
    );
    expectError(
      () => buildTestQuote([...lines, lines[0]], variants, "pickup", now),
      "INVALID_CART",
    );
  });

  it.each([
    0,
    -1,
    1.5,
    21,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "2",
    null,
  ])("rejects invalid quantity %s", (quantity) => {
    expectError(
      () =>
        buildTestQuote(
          [{ variantId: gold.id, quantity } as CartLine],
          [gold],
          "pickup",
          now,
        ),
      "INVALID_QUANTITY",
    );
  });

  it("rejects empty and malformed carts", () => {
    for (const lines of [[], null, [null], [{ variantId: " ", quantity: 1 }]]) {
      expectError(
        () => buildTestQuote(lines as CartLine[], [gold], "pickup", now),
        "INVALID_CART",
      );
    }
  });

  it("rejects repeated cart lines rather than bypassing quantity limits", () => {
    expectError(
      () => buildTestQuote([...cart, ...cart], [gold], "pickup", now),
      "DUPLICATE_VARIANT",
    );
  });

  it("rejects unknown, inactive and insufficient stock variants", () => {
    expectError(
      () => buildTestQuote(cart, [], "pickup", now),
      "UNKNOWN_VARIANT",
    );
    expectError(
      () => buildTestQuote(cart, [{ ...gold, active: false }], "pickup", now),
      "UNAVAILABLE_VARIANT",
    );
    expectError(
      () => buildTestQuote(cart, [{ ...gold, available: 1 }], "pickup", now),
      "INSUFFICIENT_STOCK",
    );
    expectError(
      () => buildTestQuote(cart, [{ ...gold, available: 0 }], "pickup", now),
      "INSUFFICIENT_STOCK",
    );
  });

  it.each([-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "100", null])(
    "rejects invalid server price %s",
    (priceCents) => {
      expectError(
        () =>
          buildTestQuote(
            cart,
            [{ ...gold, priceCents } as QuoteVariant],
            "pickup",
            now,
          ),
        "INVALID_VARIANT",
      );
    },
  );

  it("rejects ambiguous catalog identity and malformed server data", () => {
    const badLists = [
      [gold, { ...silver, id: gold.id }],
      [gold, { ...silver, sku: gold.sku }],
      [{ ...gold, available: -1 }],
      [{ ...gold, available: 1.5 }],
      [{ ...gold, available: NaN }],
      [{ ...gold, version: 0 }],
      [{ ...gold, version: 1.5 }],
      [{ ...gold, name: "" }],
      [{ ...gold, active: "true" }],
      [null],
      null,
    ];
    for (const variants of badLists) {
      expectError(
        () => buildTestQuote(cart, variants as QuoteVariant[], "pickup", now),
        "INVALID_VARIANT",
      );
    }
  });

  it("rejects overflow in line multiplication, subtotal addition and delivery addition", () => {
    const costly = { ...gold, priceCents: Number.MAX_SAFE_INTEGER };
    expectError(
      () => buildTestQuote(cart, [costly], "pickup", now),
      "AMOUNT_OVERFLOW",
    );
    const one = [{ variantId: gold.id, quantity: 1 }];
    expectError(
      () =>
        buildTestQuote(
          [...one, { variantId: silver.id, quantity: 1 }],
          [costly, silver],
          "pickup",
          now,
        ),
      "AMOUNT_OVERFLOW",
    );
    expectError(
      () => buildTestQuote(one, [costly], "shipping", now),
      "AMOUNT_OVERFLOW",
    );
    expect(buildTestQuote(one, [costly], "pickup", now).totalCents).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it.each([
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
    8_640_000_000_000_000,
  ])("rejects invalid or overflowing expiry base %s", (time) => {
    expectError(
      () => buildTestQuote(cart, [gold], "pickup", time),
      "INVALID_TIME",
    );
  });

  it.each(["express", "toString", "__proto__", null])(
    "rejects unsupported delivery %s",
    (delivery) => {
      expectError(
        () => buildTestQuote(cart, [gold], delivery as DeliveryMethod, now),
        "INVALID_DELIVERY",
      );
    },
  );

  it("returns a new price and expiry when server data or time changes", () => {
    const old = buildTestQuote(cart, [gold], "pickup", now);
    const changed = buildTestQuote(
      cart,
      [{ ...gold, priceCents: 2000, version: 2 }],
      "pickup",
      old.expiresAt,
    );
    expect(changed.lines[0]).toMatchObject({
      unitPriceCents: 2000,
      version: 2,
    });
    expect(changed.expiresAt).toBe(old.expiresAt + 600_000);
    expect(old.lines[0].unitPriceCents).toBe(1995);
  });
});
