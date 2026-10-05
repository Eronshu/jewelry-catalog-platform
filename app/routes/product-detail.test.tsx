import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, RouterContextProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { Route } from "./+types/product-detail";
import { cloudflareContext } from "../cloudflare-context";
import type { PublicProductDetail } from "../lib/db/catalog-types";
import { getPublicProductBySlug } from "../lib/db/products.server";

import ProductDetail, { loader, meta, ErrorBoundary } from "./product-detail";

vi.mock("../lib/db/products.server", () => ({
  getPublicProductBySlug: vi.fn(),
}));

const db = {} as D1Database;
const saved: PublicProductDetail = {
  product: {
    id: 7,
    name: "Silver Orbit Ring",
    slug: "silver-orbit-ring",
    priceCents: 2599,
    status: "available",
    description: "A bright ring.",
    material: "silver",
    colour: "chrome",
    facebookUrl: "https://www.facebook.com/marketplace/item/123",
  },
  images: [
    { id: 12, altText: "Side view", sortOrder: 0, width: 800, height: 900 },
    { id: 11, altText: null, sortOrder: 1, width: 900, height: 800 },
  ],
};

function args(slug = saved.product.slug) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: { DB: db } as Env,
    ctx: {} as ExecutionContext,
  });
  return { context, params: { slug } } as unknown as Route.LoaderArgs;
}

function markup(data: Awaited<ReturnType<typeof loader>>) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ProductDetail
        loaderData={data}
        params={{ slug: saved.product.slug }}
        matches={[] as never}
      />
    </MemoryRouter>,
  );
}

describe("public product detail", () => {
  it("loads only browser-safe fields and renders an ordered primary photo in initial HTML", async () => {
    vi.mocked(getPublicProductBySlug).mockResolvedValueOnce(saved);
    const data = await loader(args());
    const html = markup(data);
    expect(getPublicProductBySlug).toHaveBeenCalledWith(
      db,
      "silver-orbit-ring",
    );
    expect(data.gallery.map((image) => image.id)).toEqual([12, 11]);
    expect(html).toContain('src="/media/products/7/12/detail"');
    expect(html).toContain('alt="Silver Orbit Ring — Side view"');
    expect(html).toContain("$25.99");
    expect(html).toContain("View on Facebook Marketplace");
    expect(html).toContain("Back to Shop");
    expect(JSON.stringify(data) + html).not.toMatch(
      /r2Key|r2_key|\/admin\/products|products\/7\/.*\.jpg/,
    );
    expect(meta({ loaderData: data } as Route.MetaArgs)).toContainEqual({
      title: "Silver Orbit Ring | Jewelry Catalog",
    });
  });

  it("never serializes or displays an internal SKU, even if a query returns one", async () => {
    const internalSku = "PRIVATE-SKU-7";
    vi.mocked(getPublicProductBySlug).mockResolvedValueOnce({
      ...saved,
      product: { ...saved.product, sku: internalSku },
    } as unknown as PublicProductDetail);
    const data = await loader(args());
    const html = markup(data);
    const metadata = meta({ loaderData: data } as Route.MetaArgs);
    expect(JSON.stringify(data)).not.toContain(internalSku);
    expect(html).not.toContain(internalSku);
    expect(html).not.toContain("SKU");
    expect(JSON.stringify(metadata)).not.toContain(internalSku);
  });

  it("keeps Sold visible without a CTA and gives no-image products a server fallback", async () => {
    vi.mocked(getPublicProductBySlug).mockResolvedValueOnce({
      product: { ...saved.product, status: "sold" },
      images: [],
    });
    const data = await loader(args());
    const html = markup(data);
    expect(html).toContain("Sold Out");
    expect(html).toContain("Photo unavailable");
    expect(html).not.toContain("View on Facebook Marketplace");
  });

  it.each([
    "http://facebook.com/item",
    "https://evil.example/item",
    "https://facebook.com.evil.example/item",
    "https://user:pass@facebook.com/item",
    "https://facebook.com:8080/item",
    "broken",
  ])("omits an unsafe Facebook CTA for %s", async (url) => {
    vi.mocked(getPublicProductBySlug).mockResolvedValueOnce({
      ...saved,
      product: { ...saved.product, facebookUrl: url },
    });
    expect((await loader(args())).product.facebookUrl).toBeNull();
  });

  it("gives missing and private slugs the same private-data-free 404", async () => {
    vi.mocked(getPublicProductBySlug)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    for (const slug of ["missing", "private-item"]) {
      await expect(loader(args(slug))).rejects.toMatchObject({ status: 404 });
    }
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ErrorBoundary
          error={new Response(null, { status: 404 }) as never}
          params={{ slug: "private-item" }}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Product not found");
    expect(html).not.toContain("private-item");
    expect(meta({ loaderData: undefined } as Route.MetaArgs)).toContainEqual({
      title: "Product unavailable | Jewelry Catalog",
    });
  });

  it("turns a D1 failure into a generic 503 without leaking details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getPublicProductBySlug).mockRejectedValueOnce(
      new Error("secret SQL detail"),
    );
    try {
      await expect(loader(args())).rejects.toMatchObject({ status: 503 });
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <ErrorBoundary
            error={
              new Response(null, {
                status: 503,
                statusText: "Product catalog unavailable",
              }) as never
            }
            params={{ slug: "a" }}
          />
        </MemoryRouter>,
      );
      expect(html).toContain("We couldn’t load this product");
      expect(html).not.toContain("secret SQL detail");
    } finally {
      log.mockRestore();
    }
  });
});
