import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Route } from "./+types/home";
import { cloudflareContext } from "../cloudflare-context";
import { homeData } from "../lib/home-data.server";
import Home, { ErrorBoundary, loader, meta } from "./home";

vi.mock("../lib/home-data.server", () => ({ homeData: vi.fn() }));

const db = {} as D1Database;
type HomeData = Awaited<ReturnType<typeof homeData>>;

const data: HomeData = {
  products: [
    {
      slug: "orbit-ring",
      name: "Orbit Ring",
      priceCents: 2599,
      status: "sold",
      cover: { url: "/media/products/7/12/card", altText: "Side view" },
    },
    {
      slug: "silver-chain",
      name: "Silver Chain",
      priceCents: 3100,
      status: "available",
      cover: null,
    },
  ],
};

function args() {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: { DB: db } as Env,
    ctx: {} as ExecutionContext,
  });
  return { context } as unknown as Route.LoaderArgs;
}

function markup(loaderData: HomeData) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <Home loaderData={loaderData} params={{}} matches={[] as never} />
    </MemoryRouter>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("home catalog merchandising", () => {
  it("renders live Shop cards, safe image URLs, and a Shop path", async () => {
    vi.mocked(homeData).mockResolvedValueOnce(data);
    const result = await loader(args());
    expect(homeData).toHaveBeenCalledWith(db);
    const html = markup(result);

    expect(html).toContain("Wear it your way.");
    expect(html).toContain("Temporary editorial photo for visual direction.");
    expect(html).toContain("Recently added");
    expect(html).toContain("$25.99");
    expect(html).toContain("Sold Out");
    expect(html).toContain('href="/products/orbit-ring"');
    expect(html).toContain('src="/media/products/7/12/card"');
    expect(html).toContain('alt="Orbit Ring — Side view"');
    expect(html).toContain('href="/products/silver-chain"');
    expect(html).toContain("Photo unavailable");
    expect(html).toContain("View Shop");
    expect(html).not.toContain("Explore by category");
    expect(html).not.toContain('href="/shop?category=');
    expect(html).toContain("Temporary editorial imagery");
    expect(html).toContain("Not here to blend in.");
    expect(JSON.stringify(result) + html).not.toMatch(
      /Featured preview|Design-review only|CA\$ —|Gold grillz styling|r2_key|r2Key|\/admin\/|"sku"|"id"/,
    );
  });

  it("keeps Shop access with no eligible products", () => {
    const html = markup({ products: [] });
    expect(html).toContain("No pieces to feature right now");
    expect(html).toContain('href="/shop"');
    expect(html).not.toContain('href="/products/');
    expect(html).not.toContain("Explore by category");
  });

  it("renders one card without fixture padding", () => {
    const html = markup({
      products: data.products.slice(0, 1),
    });
    expect(html.match(/class="shop-product-card"/g)).toHaveLength(1);
  });

  it("returns a generic 503 boundary with a Shop path on D1 failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(homeData).mockRejectedValueOnce(new Error("private SQL detail"));
    let error: unknown;
    try {
      await loader(args());
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ status: 503 });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ErrorBoundary error={error} params={{}} />
      </MemoryRouter>,
    );
    expect(html).toContain("We couldn’t load the collection");
    expect(html).toContain('href="/shop"');
    expect(html).not.toContain("private SQL detail");
    log.mockRestore();
  });

  it("retains baseline metadata", () => {
    expect(meta()).toContainEqual({
      title: "Wear it your way | Jewelry Catalog",
    });
  });
});
