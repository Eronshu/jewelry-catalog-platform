import { describe, expect, it } from "vitest";

import {
  mapProduct,
  mapPublicProductCard,
  type ProductRow,
  type PublicProductCardRow,
} from "./catalog-mappers";
import { slugCandidate, slugifyProductName } from "./slugs";

const productRow: ProductRow = {
  id: 7,
  name: "Pearl Drop Earrings",
  slug: "pearl-drop-earrings",
  sku: null,
  description: null,
  price_cents: 2599,
  category_id: 1,
  material: "silver",
  colour: null,
  status: "sold",
  quantity: null,
  facebook_url: null,
  created_at: 1780000000000,
  updated_at: 1780000001000,
  published_at: 1780000000500,
  sort_order: null,
};

describe("catalog row mapping", () => {
  it("converts a D1 product row without changing integer cents or timestamps", () => {
    expect(mapProduct(productRow)).toMatchObject({
      id: 7,
      priceCents: 2599,
      categoryId: 1,
      createdAt: 1780000000000,
      publishedAt: 1780000000500,
      status: "sold",
    });
  });

  it("rejects an unexpected database status", () => {
    expect(() => mapProduct({ ...productRow, status: "pending" })).toThrow(
      "Unexpected product status",
    );
  });

  it("derives cover image metadata from the selected first image row", () => {
    const cardRow: PublicProductCardRow = {
      id: 7,
      name: "Pearl Drop Earrings",
      slug: "pearl-drop-earrings",
      price_cents: 2599,
      status: "available",
      created_at: 1780000000000,
      cover_id: 11,
      cover_alt_text: "Front view",
      cover_sort_order: 0,
      cover_width: 1200,
      cover_height: 1200,
    };

    expect(mapPublicProductCard(cardRow).coverImage).toMatchObject({
      id: 11,
      sortOrder: 0,
    });
    expect(
      mapPublicProductCard({ ...cardRow, cover_id: null }).coverImage,
    ).toBe(null);
    expect(() =>
      mapPublicProductCard({ ...cardRow, status: "hidden" }),
    ).toThrow("Non-public product");
  });
});

describe("slug candidates", () => {
  it("normalizes names and provides deterministic collision suffixes", () => {
    const base = slugifyProductName("  Péarl & Drop Earrings!  ");
    expect(base).toBe("pearl-drop-earrings");
    expect(slugCandidate(base, 1)).toBe(base);
    expect(slugCandidate(base, 2)).toBe("pearl-drop-earrings-2");
    expect(slugifyProductName("💎")).toBe("product");
  });
});
