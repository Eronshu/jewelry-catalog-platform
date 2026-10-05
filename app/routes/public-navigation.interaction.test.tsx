// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import Shop from "./shop";
import ProductDetail from "./product-detail";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("public navigation freshness", () => {
  it("loads Shop, opens detail, and reads fresh cover, price, and status on revisit", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const complete = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "complete",
    );
    Object.defineProperty(HTMLImageElement.prototype, "complete", {
      configurable: true,
      get: () => false,
    });
    let priceCents = 2500;
    let status: "available" | "sold" = "available";
    let imageId = 10;
    let shopReads = 0;
    let detailReads = 0;
    const Stub = createRoutesStub([
      {
        path: "/shop",
        Component: Shop,
        loader: () => {
          shopReads++;
          return {
            products: [
              {
                slug: "orbit-ring",
                name: "Orbit Ring",
                priceCents,
                status,
                cover: {
                  url: `/media/products/1/${imageId}/card`,
                  altText: null,
                },
              },
            ],
          };
        },
      },
      {
        path: "/products/:slug",
        Component: ProductDetail,
        loader: () => {
          detailReads++;
          return {
            product: {
              name: "Orbit Ring",
              priceCents,
              status,
              description: null,
              material: null,
              colour: null,
              facebookUrl:
                status === "available" ? "https://facebook.com/item" : null,
            },
            gallery: [
              {
                id: imageId,
                altText: null,
                detailUrl: `/media/products/1/${imageId}/detail`,
                thumbUrl: `/media/products/1/${imageId}/thumb`,
                zoomUrl: `/media/products/1/${imageId}/zoom`,
              },
            ],
          };
        },
      },
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Stub initialEntries={["/shop"]} />));
      expect(
        host.querySelector('a[href="/products/orbit-ring"]'),
      ).not.toBeNull();
      await act(async () =>
        (
          host.querySelector(
            'a[href="/products/orbit-ring"]',
          ) as HTMLAnchorElement
        ).click(),
      );
      expect(host.querySelector("h1")?.textContent).toBe("Orbit Ring");
      expect(detailReads).toBe(1);

      priceCents = 3199;
      status = "sold";
      imageId = 11;
      await act(async () =>
        (host.querySelector('a[href="/shop"]') as HTMLAnchorElement).click(),
      );
      expect(shopReads).toBe(2);
      expect(host.textContent).toContain("$31.99");
      expect(
        host.querySelector('img[src="/media/products/1/11/card"]'),
      ).not.toBeNull();
      await act(async () =>
        (
          host.querySelector(
            'a[href="/products/orbit-ring"]',
          ) as HTMLAnchorElement
        ).click(),
      );
      expect(detailReads).toBe(2);
      expect(host.textContent).toContain("Sold Out");
      expect(
        host.querySelector('img[src="/media/products/1/11/detail"]'),
      ).not.toBeNull();
      expect(host.textContent).not.toContain("View on Facebook Marketplace");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      if (complete)
        Object.defineProperty(HTMLImageElement.prototype, "complete", complete);
    }
  });
});
