// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, RouterContextProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { Route } from "./+types/shop";
import { cloudflareContext } from "../cloudflare-context";
import { shopData } from "../lib/shop-data.server";
import { parseShopQuery, shopUrl } from "../lib/shop-query";
import Shop, {
  loader,
  markSuppliedBatch,
  meta,
  shouldRevalidate,
} from "./shop";

vi.mock("../lib/shop-data.server", () => ({ shopData: vi.fn() }));

const db = {} as D1Database;
const filters = parseShopQuery(new URL("https://example.com/shop")).filters;
const data = {
  revision: crypto.randomUUID(),
  page: {
    products: [
      {
        slug: "orbit-ring",
        name: "Orbit Ring",
        priceCents: 2599,
        status: "sold" as const,
        cover: null,
      },
    ],
    hasMore: false,
    nextCursor: null,
  },
  filters,
  query: parseShopQuery(new URL("https://example.com/shop")),
  categories: [{ name: "Rings", slug: "rings" }],
  facets: { materials: ["silver"], colours: ["black"] },
  emptyCatalog: false,
};

function args(url = "https://example.com/shop") {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: { DB: db } as Env,
    ctx: {} as ExecutionContext,
  });
  return { context, request: new Request(url) } as unknown as Route.LoaderArgs;
}

async function firstNoJsLink() {
  const firstUrl =
    "https://example.com/shop?q=Orbit&category=rings&sort=price-asc";
  const selected = parseShopQuery(new URL(firstUrl));
  const firstData = {
    ...data,
    filters: selected.filters,
    query: selected,
    page: { ...data.page, hasMore: true, nextCursor: "valid_cursor" },
  };
  vi.mocked(shopData).mockResolvedValueOnce(firstData);
  const firstResult = await loader(args(firstUrl));
  const firstHtml = renderToStaticMarkup(
    <MemoryRouter
      initialEntries={[new URL(firstUrl).pathname + new URL(firstUrl).search]}
    >
      <Shop
        loaderData={firstResult as typeof firstData}
        params={{}}
        matches={[] as never}
      />
    </MemoryRouter>,
  );
  const nextUrl = shopUrl(selected.filters, { after: "valid_cursor" });
  expect(firstHtml).toContain(`href="${nextUrl.replaceAll("&", "&amp;")}"`);
  return { selected, firstData, nextUrl };
}

describe("shop route", () => {
  it("follows a valid no-JavaScript Next products link to the next batch", async () => {
    const { firstData, nextUrl } = await firstNoJsLink();
    const nextData = {
      ...firstData,
      page: {
        products: [
          {
            ...data.page.products[0],
            slug: "second-ring",
            name: "Second Ring",
          },
        ],
        hasMore: false,
        nextCursor: null,
      },
    };
    vi.mocked(shopData).mockResolvedValueOnce(nextData);
    const nextResult = await loader(args(`https://example.com${nextUrl}`));
    const nextHtml = renderToStaticMarkup(
      <MemoryRouter initialEntries={[nextUrl]}>
        <Shop
          loaderData={nextResult as typeof nextData}
          params={{}}
          matches={[] as never}
        />
      </MemoryRouter>,
    );
    expect(nextHtml).toContain("Second Ring");
    expect(nextHtml).not.toContain("The collection changed");
  });

  it("explains a stale no-JavaScript Next link and preserves choices in Start again", async () => {
    const { selected, nextUrl } = await firstNoJsLink();
    const startUrl = shopUrl(selected.filters);
    vi.mocked(shopData).mockResolvedValueOnce({
      resetUrl: startUrl,
      stale: true,
    });
    const staleResult = await loader(args(`https://example.com${nextUrl}`));
    expect(staleResult).not.toBeInstanceOf(Response);
    const staleHtml = renderToStaticMarkup(
      <MemoryRouter initialEntries={[nextUrl]}>
        <Shop
          loaderData={staleResult as never}
          params={{}}
          matches={[] as never}
        />
      </MemoryRouter>,
    );
    expect(staleHtml).toContain("The collection changed");
    expect(staleHtml).toContain("Start again");
    expect(staleHtml).toContain(`href="${startUrl.replaceAll("&", "&amp;")}"`);
    expect(staleHtml).not.toMatch(/valid_cursor|Second Ring|sku|r2_key/i);
  });
  it("renders the current public cards and URL-derived controls", async () => {
    vi.mocked(shopData).mockResolvedValueOnce(data);
    const result = await loader(args());
    expect(shopData).toHaveBeenCalledWith(
      db,
      new URL("https://example.com/shop"),
    );
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Shop
          loaderData={result as typeof data}
          params={{}}
          matches={[] as never}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Orbit Ring");
    expect(html).toContain("$25.99");
    expect(html).toContain("Sold Out");
    expect(html).toContain('href="/products/orbit-ring"');
    expect(html).toContain('<details class="shop-filter-disclosure"');
    expect(html).toContain("<summary>Filters</summary>");
    expect(html).toContain('class="shop-filter-panel"');
    expect(html).toContain('class="shop-sort-form"');
    expect(html).toContain("Sort by");
    expect(html).toContain("Price: low to high");
    expect(html).toContain("Price: high to low");
    expect(html).toContain("Showing: All pieces");
    expect(html).toContain("Search by name");
    expect(html).not.toMatch(/sku|r2_key|admin\/products/i);
    expect(meta()).toContainEqual({ title: "Shop | Jewelry Catalog" });
  });

  it("renders a plain next-page link for a no-JavaScript visit", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Shop
          loaderData={{
            ...data,
            page: { ...data.page, hasMore: true, nextCursor: "cursor_1" },
          }}
          params={{}}
          matches={[] as never}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('href="/shop?after=cursor_1"');
    expect(html).toContain("Load More");
  });

  it("passes canonical redirects through and turns D1 failures into generic 503", async () => {
    vi.mocked(shopData).mockResolvedValueOnce({
      resetUrl: "/shop",
      stale: false,
    });
    expect(
      (
        (await loader(args("https://example.com/shop?sort=bad"))) as Response
      ).headers.get("Location"),
    ).toBe("/shop");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(shopData).mockRejectedValueOnce(new Error("private SQL"));
    await expect(loader(args())).rejects.toMatchObject({
      status: 503,
      statusText: "Shop catalog unavailable",
    });
    log.mockRestore();
  });

  it("does not bypass revalidation on normal Shop navigation or detail return", () => {
    const currentUrl = new URL("https://example.com/products/orbit-ring");
    const nextUrl = new URL("https://example.com/shop?batches=2");
    expect(
      shouldRevalidate({ currentUrl, nextUrl, defaultShouldRevalidate: true }),
    ).toBe(true);
    expect(
      shouldRevalidate({
        currentUrl: new URL("https://example.com/shop"),
        nextUrl: new URL("https://example.com/shop?colour=black"),
        defaultShouldRevalidate: true,
      }),
    ).toBe(true);
  });

  it("skips revalidation only for the supplied batch-count navigation", () => {
    const clear = markSuppliedBatch("https://example.com/shop?batches=2");
    const args = {
      currentUrl: new URL("https://example.com/shop"),
      nextUrl: new URL("https://example.com/shop?batches=2"),
      defaultShouldRevalidate: true,
    };
    expect(shouldRevalidate(args)).toBe(false);
    expect(shouldRevalidate(args)).toBe(false);
    expect(shouldRevalidate(args)).toBe(false);
    clear();
    expect(shouldRevalidate(args)).toBe(true);
  });
});
