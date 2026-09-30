import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, RouterContextProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { Route } from "./+types/shop";
import { cloudflareContext } from "../cloudflare-context";
import type { PublicProductCard } from "../lib/db/catalog-types";
import { listPublicProducts } from "../lib/db/products.server";

import Shop, { loader, meta } from "./shop";

vi.mock("../lib/db/products.server", () => ({
  listPublicProducts: vi.fn(),
}));

const db = {} as D1Database;

function loaderArgs() {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: { DB: db } as Env,
    ctx: {} as ExecutionContext,
  });
  return { context } as unknown as Route.LoaderArgs;
}

function product(
  overrides: Partial<PublicProductCard> = {},
): PublicProductCard {
  return {
    id: 1001,
    slug: "demo-orbit-hoops",
    name: "Demo Orbit Hoops",
    priceCents: 2599,
    status: "available",
    categoryId: 1,
    material: "silver",
    colour: "silver",
    createdAt: 1780000000000,
    coverImage: {
      id: 2001,
      productId: 1001,
      r2Key: "dev/products/demo-orbit-hoops/01.jpg",
      altText: "Demo Orbit Hoops, front view",
      sortOrder: 0,
      width: 1400,
      height: 1400,
      createdAt: 1780000000000,
    },
    ...overrides,
  };
}

function renderShop(products: Awaited<ReturnType<typeof loader>>["products"]) {
  return renderToStaticMarkup(
    <MemoryRouter>
      {Shop({ loaderData: { products } } as Route.ComponentProps)}
    </MemoryRouter>,
  );
}

describe("shop route", () => {
  it("loads public D1 products and returns only the Shop card contract", async () => {
    vi.mocked(listPublicProducts).mockResolvedValueOnce([
      product(),
      product({
        id: 1002,
        slug: "demo-sold-ring",
        name: "Demo Sold Ring",
        status: "sold",
      }),
    ]);

    const result = await loader(loaderArgs());

    expect(listPublicProducts).toHaveBeenCalledWith(db);
    expect(result).toEqual({
      products: [
        {
          slug: "demo-orbit-hoops",
          name: "Demo Orbit Hoops",
          priceCents: 2599,
          status: "available",
        },
        {
          slug: "demo-sold-ring",
          name: "Demo Sold Ring",
          priceCents: 2599,
          status: "sold",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("dev/products/");
  });

  it("renders real cards, exact CAD prices, Sold Out text, and no fake links", () => {
    const markup = renderShop([
      {
        slug: "demo-orbit-hoops",
        name: "Demo Orbit Hoops",
        priceCents: 2400,
        status: "available",
      },
      {
        slug: "demo-sold-ring",
        name: "Demo Sold Ring",
        priceCents: 2599,
        status: "sold",
      },
    ]);

    expect(markup).toContain('id="shop-title"');
    expect(markup).toContain("Browse the collection");
    expect(markup).toContain("Prices in CAD");
    expect(markup.match(/class="shop-product-card"/g)).toHaveLength(2);
    expect(
      markup.match(/class="shop-product-image shop-product-placeholder"/g),
    ).toHaveLength(2);
    expect(markup).toContain("$24.00");
    expect(markup).toContain("$25.99");
    expect(markup).toContain("Sold Out");
    expect(markup).not.toContain('href="/products/');
    expect(markup).not.toContain("dev/products/");
    expect(markup).not.toContain("Design-review only");
  });

  it("shows an intentional empty state for a successful empty query", async () => {
    vi.mocked(listPublicProducts).mockResolvedValueOnce([]);
    const result = await loader(loaderArgs());
    const markup = renderShop(result.products);

    expect(markup).toContain("No pieces available right now");
    expect(markup).not.toContain('class="shop-product-card"');
    expect(markup).not.toContain("We couldn’t load the shop");
  });

  it("converts only a catalog-read failure to the known 503", async () => {
    const error = new Error("internal SQL or binding detail");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(listPublicProducts).mockRejectedValueOnce(error);

    try {
      await expect(loader(loaderArgs())).rejects.toMatchObject({
        status: 503,
        statusText: "Shop catalog unavailable",
      });
      expect(log).toHaveBeenCalledWith("Shop catalog load failed", error);
    } finally {
      log.mockRestore();
    }
  });

  it("does not label a missing request context as a catalog outage", async () => {
    const callCount = vi.mocked(listPublicProducts).mock.calls.length;
    await expect(
      loader({
        context: new RouterContextProvider(),
      } as unknown as Route.LoaderArgs),
    ).rejects.toThrow();
    expect(vi.mocked(listPublicProducts).mock.calls).toHaveLength(callCount);
  });

  it("does not label an unexpected mapping error as a catalog outage", async () => {
    vi.mocked(listPublicProducts).mockResolvedValueOnce([
      null as unknown as PublicProductCard,
    ]);
    await expect(loader(loaderArgs())).rejects.toThrow(TypeError);
  });

  it("provides Shop metadata", () => {
    expect(meta()).toContainEqual({ title: "Shop | Jewelry Catalog" });
  });
});
