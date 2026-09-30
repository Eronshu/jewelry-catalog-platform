import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { shopDesignReviewCards } from "../lib/shop-design-review-fixture";

import Shop, { meta } from "./shop";

describe("shop route", () => {
  it("renders 24 clearly temporary, non-navigating cards", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <Shop />
      </MemoryRouter>,
    );

    expect(markup).toContain('id="shop-title"');
    expect(markup).toContain("Shop");
    expect(shopDesignReviewCards).toHaveLength(24);
    expect(
      new Set(shopDesignReviewCards.map((card) => card.image.src)).size,
    ).toBeGreaterThanOrEqual(12);
    expect(markup.match(/class="shop-product-card"/g)).toHaveLength(24);
    expect(markup.match(/class="shop-product-image"/g)).toHaveLength(24);
    expect(markup).toContain("not products for sale");
    expect(markup.match(/Price pending/g)).toHaveLength(24);
    expect(markup).toContain('href="/"');
    expect(markup).not.toContain('href="/products/');
    expect(markup).not.toContain("screencaptureui");
  });

  it("provides preview metadata", () => {
    expect(meta()).toContainEqual({
      title: "Shop | Jewelry Catalog",
    });
  });
});
