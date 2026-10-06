// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ShopPageCard } from "../lib/shop-data.server";
import { parseShopQuery } from "../lib/shop-query";
import Home from "./home";
import ProductDetail from "./product-detail";
import Shop from "./shop";

const products: ShopPageCard[] = [
  {
    slug: "orbit-ring",
    name: "Orbit Ring",
    priceCents: 2599,
    status: "available",
    cover: { url: "/media/products/1/10/card", altText: "Front view" },
  },
  {
    slug: "silver-chain",
    name: "Silver Chain",
    priceCents: 3100,
    status: "sold",
    cover: null,
  },
  {
    slug: "pearl-drops",
    name: "Pearl Drops",
    priceCents: 1800,
    status: "available",
    cover: null,
  },
  {
    slug: "arc-bracelet",
    name: "Arc Bracelet",
    priceCents: 4200,
    status: "available",
    cover: null,
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("Home public navigation", () => {
  it("opens a product and Shop from four Home cards with keyboard-visible links", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const complete = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "complete",
    );
    Object.defineProperty(HTMLImageElement.prototype, "complete", {
      configurable: true,
      get: () => false,
    });
    const css = readFileSync("app/app.css", "utf8");
    expect(css).toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*var\(--focus-ring-width\) solid/,
    );
    expect(css).toMatch(
      /\.shop-product-link:focus-visible[^{}]*\{[^}]*outline:\s*2px solid/,
    );

    const shopRequests: string[] = [];
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: Home,
        loader: () => ({ products }),
      },
      {
        path: "/products/:slug",
        Component: ProductDetail,
        loader: ({ params }) => {
          const product = products.find((item) => item.slug === params.slug)!;
          return {
            product: {
              name: product.name,
              priceCents: product.priceCents,
              status: product.status,
              description: null,
              material: null,
              colour: null,
              facebookUrl: null,
            },
            gallery: [],
          };
        },
      },
      {
        path: "/shop",
        Component: Shop,
        loader: ({ request }) => {
          const url = new URL(request.url);
          shopRequests.push(url.pathname + url.search);
          const query = parseShopQuery(url);
          return {
            revision: crypto.randomUUID(),
            page: {
              products,
              hasMore: false,
              nextCursor: null,
            },
            filters: query.filters,
            query,
            categories: [{ name: "Rings", slug: "rings" }],
            facets: { materials: [], colours: [] },
            emptyCatalog: false,
          };
        },
      },
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Stub initialEntries={["/"]} />));
      expect(
        host.querySelectorAll(".home-product-grid .shop-product-card"),
      ).toHaveLength(4);
      const featured = host.querySelector(".home-featured")!;
      expect(featured.textContent).toContain("View Shop");
      expect(featured.textContent).not.toContain("Explore by category");
      expect(host.querySelector('a[href^="/shop?category="]')).toBeNull();
      expect(featured.nextElementSibling?.classList).toContain("home-browse");

      const productLink = host.querySelector(
        'a[href="/products/orbit-ring"]',
      ) as HTMLAnchorElement;
      expect(productLink.textContent).toContain("Orbit Ring");
      expect(productLink.querySelector("img")?.alt).toContain("Orbit Ring");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
      productLink.focus();
      expect(document.activeElement).toBe(productLink);
      await act(async () => productLink.click());
      expect(host.querySelector("h1")?.textContent).toBe("Orbit Ring");

      await act(async () =>
        (
          host.querySelector(".product-detail-back") as HTMLAnchorElement
        ).click(),
      );
      await act(async () =>
        (
          host.querySelector(".shop-intro a[href='/']") as HTMLAnchorElement
        ).click(),
      );
      const shopLink = host.querySelector(
        '.home-featured .home-section-heading a[href="/shop"]',
      ) as HTMLAnchorElement;
      expect(shopLink.textContent).toContain("View Shop");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
      shopLink.focus();
      expect(document.activeElement).toBe(shopLink);
      await act(async () => shopLink.click());

      expect(shopRequests.at(-1)).toBe("/shop");
      expect(host.querySelector("#shop-title")?.textContent).toBe("Shop");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      if (complete)
        Object.defineProperty(HTMLImageElement.prototype, "complete", complete);
    }
  });
});
