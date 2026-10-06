import { describe, expect, it } from "vitest";
import { MAX_SHOP_BATCHES, parseShopQuery, shopUrl } from "./shop-query";

describe("Shop URL", () => {
  it("accepts batch counts through 20 and rejects 21", () => {
    expect(MAX_SHOP_BATCHES).toBe(20);
    expect(parseShopQuery(new URL("https://example.com/shop")).batches).toBe(1);
    for (let count = 2; count <= MAX_SHOP_BATCHES; count++) {
      const parsed = parseShopQuery(
        new URL(`https://example.com/shop?batches=${count}`),
      );
      expect(parsed.invalid).toBe(false);
      expect(parsed.batches).toBe(count);
    }
    const tooDeep = parseShopQuery(
      new URL("https://example.com/shop?batches=21"),
    );
    expect(tooDeep.invalid).toBe(true);
    expect(tooDeep.canonical).toBe("/shop");
  });
  it("reads controls and cumulative batch count from a direct URL", () => {
    const query = parseShopQuery(
      new URL(
        "https://example.com/shop?q=Silver&category=rings&material=steel&colour=red&availability=sold&sort=price-asc&batches=3",
      ),
    );
    expect(query.invalid).toBe(false);
    expect(query.batches).toBe(3);
    expect(query.filters).toMatchObject({
      q: "Silver",
      category: "rings",
      material: "steel",
      colour: "red",
      availability: "sold",
      sort: "price-asc",
    });
    expect(shopUrl(query.filters, { batches: 3 })).toBe(query.canonical);
  });

  it("canonicalizes empty, repeated, unknown, and oversized input", () => {
    const query = parseShopQuery(
      new URL(
        `https://example.com/shop?q=hi&q=bye&material=${"a".repeat(81)}&sku=SECRET&sort=nope`,
      ),
    );
    expect(query.invalid).toBe(true);
    expect(query.canonical).toBe("/shop");
    expect(query.filters.q).toBe("");
    expect(
      parseShopQuery(new URL("https://example.com/shop?colour=")).canonical,
    ).toBe("/shop");
    expect(() =>
      parseShopQuery(new URL(`https://example.com/shop?q=${"x".repeat(2100)}`)),
    ).toThrowError();
  });
});
