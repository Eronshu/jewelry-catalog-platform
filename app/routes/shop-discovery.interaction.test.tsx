// @vitest-environment happy-dom

import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { createRoutesStub, Link, useLocation, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ShopPage } from "../lib/shop-data.server";
import { MAX_SHOP_BATCHES, parseShopQuery } from "../lib/shop-query";
import Shop, { shouldRevalidate } from "./shop";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function card(slug: string) {
  return {
    slug,
    name: slug,
    priceCents: 2500,
    status: "available" as const,
    cover: null,
  };
}

function observeShopEnd() {
  const observers: Array<{
    active: boolean;
    trigger: () => void;
  }> = [];
  class TestObserver {
    active = false;
    constructor(private callback: IntersectionObserverCallback) {
      observers.push(this);
    }
    observe() {
      this.active = true;
    }
    disconnect() {
      this.active = false;
    }
    trigger() {
      if (this.active)
        this.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
    }
  }
  vi.stubGlobal("IntersectionObserver", TestObserver);
  return {
    trigger: () => observers.findLast((observer) => observer.active)?.trigger(),
    activeCount: () => observers.filter((observer) => observer.active).length,
  };
}

async function scrollTowardShopEnd() {
  await act(async () => {
    window.dispatchEvent(new Event("wheel"));
  });
}

function Detail() {
  const navigate = useNavigate();
  return (
    <>
      <h1>Detail</h1>
      <button onClick={() => navigate(-1)}>Browser Back</button>
    </>
  );
}

function LocationText() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname + location.search}
    </output>
  );
}

function HistoryControls() {
  const navigate = useNavigate();
  return (
    <>
      <LocationText />
      <button type="button" onClick={() => navigate(-1)}>
        History back
      </button>
      <button type="button" onClick={() => navigate(1)}>
        History forward
      </button>
      <Link to="/shop?colour=red">Red filter</Link>
    </>
  );
}

describe("Shop batch navigation", () => {
  it("arms observation when a scrollbar drag actually moves the page", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const observer = observeShopEnd();
    let position = 0;
    vi.spyOn(window, "scrollY", "get").mockImplementation(() => position);
    const read = vi.fn(async () =>
      Response.json({
        products: [card("second")],
        hasMore: false,
        nextCursor: null,
      }),
    );
    vi.stubGlobal("fetch", read);
    const query = parseShopQuery(new URL("https://example.com/shop"));
    const data = {
      revision: crypto.randomUUID(),
      page: {
        products: [card("first")],
        hasMore: true,
        nextCursor: "cursor-1",
      },
      filters: query.filters,
      query,
      categories: [],
      facets: { materials: [], colours: [] },
      emptyCatalog: false,
    };
    const Stub = createRoutesStub([
      { path: "/shop", Component: Shop, loader: () => data, shouldRevalidate },
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Stub initialEntries={["/shop"]} />));
      expect(observer.activeCount()).toBe(0);
      await act(async () => {
        document.documentElement.dispatchEvent(
          new MouseEvent("pointerdown", {
            bubbles: true,
            button: 0,
            clientX: innerWidth - 1,
          }),
        );
        window.dispatchEvent(new Event("scroll"));
      });
      expect(observer.activeCount()).toBe(0);
      await act(async () => {
        position = 500;
        window.dispatchEvent(new Event("scroll"));
      });
      expect(observer.activeCount()).toBe(1);
      await act(async () => observer.trigger());
      expect(read).toHaveBeenCalledTimes(1);
      expect(host.querySelectorAll(".shop-product-card")).toHaveLength(2);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.restoreAllMocks();
    }
  });

  it("does not arm extra batches from scroll restoration alone", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const observer = observeShopEnd();
    const read = vi.fn(async () =>
      Response.json({
        products: [card("second")],
        hasMore: true,
        nextCursor: "cursor-2",
      }),
    );
    vi.stubGlobal("fetch", read);
    const query = parseShopQuery(new URL("https://example.com/shop?batches=2"));
    const data = {
      revision: crypto.randomUUID(),
      page: {
        products: [card("first")],
        hasMore: true,
        nextCursor: "cursor-1",
      },
      filters: query.filters,
      query,
      categories: [],
      facets: { materials: [], colours: [] },
      emptyCatalog: false,
    };
    const Stub = createRoutesStub([
      { path: "/shop", Component: Shop, loader: () => data, shouldRevalidate },
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(<Stub initialEntries={["/shop?batches=2"]} />),
      );
      await act(async () => window.dispatchEvent(new Event("scroll")));
      expect(host.querySelectorAll(".shop-product-card")).toHaveLength(2);
      expect(observer.activeCount()).toBe(0);
      await act(async () => observer.trigger());
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("observes the list end, appends 24 then one card, and prevents overlapping requests", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const observer = observeShopEnd();
    let resolveSecond!: (response: Response) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<Response>((resolve) => (resolveSecond = resolve)),
      )
      .mockResolvedValueOnce(
        Response.json({
          products: [card("piece-49")],
          hasMore: false,
          nextCursor: null,
        }),
      );
    vi.stubGlobal("fetch", read);
    const Stub = createRoutesStub([
      {
        path: "/shop",
        Component: ({ loaderData }) => (
          <>
            <Shop
              loaderData={loaderData as never}
              params={{}}
              matches={[] as never}
            />
            <LocationText />
          </>
        ),
        loader: ({ request }) => {
          const query = parseShopQuery(new URL(request.url));
          return {
            revision: crypto.randomUUID(),
            page: {
              products: Array.from({ length: 24 }, (_, index) =>
                card(`piece-${index + 1}`),
              ),
              hasMore: true,
              nextCursor: "cursor-1",
            },
            filters: query.filters,
            query,
            categories: [],
            facets: { materials: [], colours: [] },
            emptyCatalog: false,
          };
        },
        shouldRevalidate,
      },
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Stub initialEntries={["/shop"]} />));
      await scrollTowardShopEnd();
      expect(observer.activeCount()).toBe(1);
      await act(async () => {
        observer.trigger();
        observer.trigger();
      });
      expect(read).toHaveBeenCalledTimes(1);
      expect(host.textContent).toContain("Loading more products");
      expect(host.querySelector('[data-testid="location"]')?.textContent).toBe(
        "/shop",
      );
      await act(async () =>
        resolveSecond(
          Response.json({
            products: Array.from({ length: 24 }, (_, index) =>
              card(`piece-${index + 25}`),
            ),
            hasMore: true,
            nextCursor: "cursor-2",
          }),
        ),
      );
      expect(host.querySelectorAll(".shop-product-card")).toHaveLength(48);
      expect(host.querySelector('[data-testid="location"]')?.textContent).toBe(
        "/shop?batches=2",
      );
      expect(observer.activeCount()).toBe(0);
      await scrollTowardShopEnd();
      await act(async () => observer.trigger());
      expect(read).toHaveBeenCalledTimes(2);
      expect(host.querySelectorAll(".shop-product-card")).toHaveLength(49);
      expect(host.querySelector('[data-testid="location"]')?.textContent).toBe(
        "/shop?batches=3",
      );
      expect(observer.activeCount()).toBe(0);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("stops observing after an automatic failure until an explicit Retry", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const observer = observeShopEnd();
    const read = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({
          products: [card("second")],
          hasMore: false,
          nextCursor: null,
        }),
      );
    vi.stubGlobal("fetch", read);
    const query = parseShopQuery(new URL("https://example.com/shop"));
    const data = {
      revision: crypto.randomUUID(),
      page: {
        products: [card("first")],
        hasMore: true,
        nextCursor: "cursor-1",
      },
      filters: query.filters,
      query,
      categories: [],
      facets: { materials: [], colours: [] },
      emptyCatalog: false,
    };
    const Stub = createRoutesStub([
      { path: "/shop", Component: Shop, loader: () => data, shouldRevalidate },
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Stub initialEntries={["/shop"]} />));
      await scrollTowardShopEnd();
      await act(async () => observer.trigger());
      expect(read).toHaveBeenCalledTimes(1);
      expect(observer.activeCount()).toBe(0);
      expect(host.querySelectorAll(".shop-product-card")).toHaveLength(1);
      expect(host.textContent).toContain("More products could not be loaded");
      await act(async () => observer.trigger());
      expect(read).toHaveBeenCalledTimes(1);
      await act(async () =>
        (
          host.querySelector(".shop-page-message button") as HTMLButtonElement
        ).click(),
      );
      expect(read).toHaveBeenCalledTimes(2);
      expect(host.querySelectorAll(".shop-product-card")).toHaveLength(2);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("aborts an automatic request when opening detail and reloads current Shop data on Back", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const observer = observeShopEnd();
    let resolvePage!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    const read = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => (resolvePage = resolve));
    });
    vi.stubGlobal("fetch", read);
    let current = false;
    let loads = 0;
    const Stub = createRoutesStub([
      {
        path: "/shop",
        Component: Shop,
        loader: ({ request }) => {
          loads++;
          const query = parseShopQuery(new URL(request.url));
          return {
            revision: crypto.randomUUID(),
            page: {
              products: [card(current ? "current" : "first")],
              hasMore: true,
              nextCursor: "cursor-1",
            },
            filters: query.filters,
            query,
            categories: [],
            facets: { materials: [], colours: [] },
            emptyCatalog: false,
          };
        },
        shouldRevalidate,
      },
      { path: "/products/:slug", Component: Detail },
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Stub initialEntries={["/shop"]} />));
      await scrollTowardShopEnd();
      await act(async () => observer.trigger());
      expect(read).toHaveBeenCalledTimes(1);
      await act(async () =>
        (
          host.querySelector('a[href="/products/first"]') as HTMLAnchorElement
        ).click(),
      );
      expect(signal?.aborted).toBe(true);
      current = true;
      await act(async () =>
        resolvePage(
          Response.json({
            products: [card("obsolete")],
            hasMore: false,
            nextCursor: null,
          }),
        ),
      );
      await act(async () =>
        (host.querySelector("button") as HTMLButtonElement).click(),
      );
      expect(loads).toBeGreaterThanOrEqual(2);
      expect(host.querySelector('a[href="/products/current"]')).not.toBeNull();
      expect(host.querySelector('a[href="/products/obsolete"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("finishes restoration under Strict Mode effect cleanup", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const read = vi.fn(async () =>
      Response.json({
        products: [card("second")],
        hasMore: false,
        nextCursor: null,
      }),
    );
    vi.stubGlobal("fetch", read);
    const parsed = parseShopQuery(
      new URL("https://example.com/shop?batches=2"),
    );
    const data = {
      revision: crypto.randomUUID(),
      page: {
        products: [card("first")],
        hasMore: true,
        nextCursor: "cursor-1",
      },
      filters: parsed.filters,
      query: parsed,
      categories: [],
      facets: { materials: [], colours: [] },
      emptyCatalog: false,
    };
    const Stub = createRoutesStub([
      { path: "/shop", Component: Shop, loader: () => data, shouldRevalidate },
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <StrictMode>
            <Stub initialEntries={["/shop?batches=2"]} />
          </StrictMode>,
        ),
      );
      expect(host.querySelectorAll(".shop-product-card")).toHaveLength(2);
      expect(host.textContent).toContain("2 pieces shown");
      expect(host.textContent).not.toContain("Restoring your results");
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
  it("allows batch 20, blocks a 21st request, and restores the last valid URL", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const after = new URL(String(input)).searchParams.get("after")!;
        requests.push(after);
        const number = Number(after.split("-")[1]) + 1;
        return Response.json({
          products: [card(`piece-${number}`)],
          hasMore: true,
          nextCursor: `cursor-${number}`,
        });
      }),
    );
    const Stub = createRoutesStub([
      {
        path: "/shop",
        Component: ({ loaderData }) => (
          <>
            <Shop
              loaderData={loaderData as never}
              params={{}}
              matches={[] as never}
            />
            <LocationText />
          </>
        ),
        loader: ({ request }) => {
          const parsed = parseShopQuery(new URL(request.url));
          return {
            revision: crypto.randomUUID(),
            page: {
              products: [card("piece-1")],
              hasMore: true,
              nextCursor: "cursor-1",
            },
            filters: parsed.filters,
            query: parsed,
            categories: [],
            facets: { materials: [], colours: [] },
            emptyCatalog: false,
          };
        },
        shouldRevalidate,
      },
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    let root = createRoot(host);
    try {
      await act(async () =>
        root.render(<Stub initialEntries={["/shop?batches=19"]} />),
      );
      expect(requests).toHaveLength(18);
      expect(host.querySelectorAll(".shop-product-card")).toHaveLength(19);
      await act(async () =>
        (host.querySelector(".shop-next") as HTMLAnchorElement).click(),
      );
      expect(host.querySelector('[data-testid="location"]')?.textContent).toBe(
        `/shop?batches=${MAX_SHOP_BATCHES}`,
      );
      expect(requests).toHaveLength(19);
      expect(host.querySelectorAll(".shop-product-card")).toHaveLength(20);
      expect(host.textContent).toContain("reached the browsing limit");
      expect(host.querySelector(".shop-next")).toBeNull();
      await act(async () => root.unmount());

      root = createRoot(host);
      await act(async () =>
        root.render(<Stub initialEntries={["/shop?batches=20"]} />),
      );
      expect(host.querySelectorAll(".shop-product-card")).toHaveLength(20);
      expect(host.textContent).toContain("reached the browsing limit");
      expect(host.querySelector('[data-testid="location"]')?.textContent).toBe(
        "/shop?batches=20",
      );
      expect(requests).toHaveLength(38);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
  it("corrects an over-deep batch URL at the current end without refetching its last batch", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        reads++;
        return Response.json({
          products: [card("last")],
          hasMore: false,
          nextCursor: null,
        });
      }),
    );
    const parsed = parseShopQuery(
      new URL("https://example.com/shop?batches=3"),
    );
    const data = {
      revision: crypto.randomUUID(),
      page: {
        products: [card("first")],
        hasMore: true,
        nextCursor: "cursor-1",
      },
      filters: parsed.filters,
      query: parsed,
      categories: [],
      facets: { materials: [], colours: [] },
      emptyCatalog: false,
    };
    const Stub = createRoutesStub([
      {
        path: "/shop",
        Component: ({ loaderData }) => (
          <>
            <Shop
              loaderData={loaderData as typeof data}
              params={{}}
              matches={[] as never}
            />
            <LocationText />
          </>
        ),
        loader: () => data,
        shouldRevalidate,
      },
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(<Stub initialEntries={["/shop?batches=3"]} />),
      );
      expect(host.querySelector('[data-testid="location"]')?.textContent).toBe(
        "/shop?batches=2",
      );
      expect(host.querySelectorAll(".shop-product-card")).toHaveLength(2);
      expect(reads).toBe(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
  it("keeps visible cards on page failure and retries the same cursor", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempts++;
        if (attempts === 1) return new Response(null, { status: 503 });
        return Response.json({
          products: [card("second")],
          hasMore: false,
          nextCursor: null,
        });
      }),
    );
    const parsed = parseShopQuery(new URL("https://example.com/shop"));
    const data = {
      revision: crypto.randomUUID(),
      page: {
        products: [card("first")],
        hasMore: true,
        nextCursor: "cursor-1",
      },
      filters: parsed.filters,
      query: parsed,
      categories: [],
      facets: { materials: [], colours: [] },
      emptyCatalog: false,
    };
    const Stub = createRoutesStub([
      { path: "/shop", Component: Shop, loader: () => data, shouldRevalidate },
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Stub initialEntries={["/shop"]} />));
      await act(async () =>
        (host.querySelector(".shop-next") as HTMLAnchorElement).click(),
      );
      expect(host.querySelectorAll(".shop-product-card")).toHaveLength(1);
      expect(host.textContent).toContain("More products could not be loaded");
      await act(async () =>
        (
          host.querySelector(".shop-page-message button") as HTMLButtonElement
        ).click(),
      );
      expect(host.querySelectorAll(".shop-product-card")).toHaveLength(2);
      expect(attempts).toBe(2);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
  it("restores loaded counts and selected controls through Back and Forward", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const observer = observeShopEnd();
    let pageReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        pageReads++;
        return Response.json({
          products: [card("second")],
          hasMore: false,
          nextCursor: null,
        });
      }),
    );
    const routeData = (request: Request) => {
      const parsed = parseShopQuery(new URL(request.url));
      return {
        revision: crypto.randomUUID(),
        page: {
          products: [card(parsed.filters.colour ? "red-item" : "first")],
          hasMore: !parsed.filters.colour,
          nextCursor: parsed.filters.colour ? null : "cursor-1",
        },
        filters: parsed.filters,
        query: parsed,
        categories: [],
        facets: { materials: [], colours: ["red"] },
        emptyCatalog: false,
      };
    };
    const Stub = createRoutesStub([
      {
        path: "/shop",
        Component: ({ loaderData }) => (
          <>
            <Shop
              loaderData={loaderData as ReturnType<typeof routeData>}
              params={{}}
              matches={[] as never}
            />
            <HistoryControls />
          </>
        ),
        loader: ({ request }) => routeData(request),
        shouldRevalidate,
      },
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Stub initialEntries={["/shop"]} />));
      await act(async () =>
        (host.querySelector(".shop-next") as HTMLAnchorElement).click(),
      );
      expect(host.querySelector('[data-testid="location"]')?.textContent).toBe(
        "/shop?batches=2",
      );
      expect(host.querySelectorAll(".shop-product-card")).toHaveLength(2);
      await act(async () =>
        (
          Array.from(host.querySelectorAll("button")).find(
            (button) => button.textContent === "History back",
          ) as HTMLButtonElement
        ).click(),
      );
      expect(host.querySelector('[data-testid="location"]')?.textContent).toBe(
        "/shop",
      );
      expect(host.querySelectorAll(".shop-product-card")).toHaveLength(1);
      expect(observer.activeCount()).toBe(0);
      await act(async () => observer.trigger());
      expect(host.querySelector('[data-testid="location"]')?.textContent).toBe(
        "/shop",
      );
      await act(async () =>
        (
          Array.from(host.querySelectorAll("button")).find(
            (button) => button.textContent === "History forward",
          ) as HTMLButtonElement
        ).click(),
      );
      expect(host.querySelector('[data-testid="location"]')?.textContent).toBe(
        "/shop?batches=2",
      );
      expect(host.querySelectorAll(".shop-product-card")).toHaveLength(2);
      await act(async () =>
        (
          host.querySelector('a[href="/shop?colour=red"]') as HTMLAnchorElement
        ).click(),
      );
      expect(host.querySelector('[data-testid="location"]')?.textContent).toBe(
        "/shop?colour=red",
      );
      expect(
        (
          host.querySelector(
            'select[name="colour"]',
          ) as unknown as HTMLSelectElement
        ).value,
      ).toBe("red");
      expect(pageReads).toBeGreaterThanOrEqual(2);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
  it("restores a direct batches URL, supports Back/Forward, and reloads current public data after detail", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let hidden = false;
    let reads = 0;
    let pageReads = 0;
    const first = (): ShopPage => ({
      products: hidden ? [card("second")] : [card("first"), card("second")],
      hasMore: true,
      nextCursor: "cursor-1",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        pageReads++;
        return Response.json({
          products: [card("third")],
          hasMore: false,
          nextCursor: null,
        });
      }),
    );
    function routeData() {
      reads++;
      return {
        revision: crypto.randomUUID(),
        page: first(),
        filters: parseShopQuery(new URL("https://example.com/shop")).filters,
        query: parseShopQuery(new URL("https://example.com/shop")),
        categories: [],
        facets: { materials: [], colours: [] },
        emptyCatalog: false,
      };
    }
    const Stub = createRoutesStub([
      {
        path: "/shop",
        Component: ({ loaderData }) => (
          <>
            <Shop
              loaderData={loaderData as ReturnType<typeof routeData>}
              params={{}}
              matches={[] as never}
            />
            <LocationText />
          </>
        ),
        loader: () => routeData(),
        shouldRevalidate,
      },
      { path: "/products/:slug", Component: Detail },
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(<Stub initialEntries={["/shop?batches=2"]} />),
      );
      expect(host.textContent).toContain("third");
      expect(pageReads).toBe(1);
      expect(host.querySelector('[data-testid="location"]')?.textContent).toBe(
        "/shop?batches=2",
      );
      await act(async () =>
        (
          host.querySelector('a[href="/products/first"]') as HTMLAnchorElement
        ).click(),
      );
      hidden = true;
      await act(async () =>
        (host.querySelector("button") as HTMLButtonElement).click(),
      );
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(host.querySelector('a[href="/products/first"]')).toBeNull();
      expect(
        host.querySelector(".shop-product-grid")?.textContent,
      ).not.toContain("first");
      expect(host.querySelector(".shop-product-grid")?.textContent).toContain(
        "third",
      );
      expect(pageReads).toBe(2);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("keeps multiple visible batches when the next cursor is stale", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const observer = observeShopEnd();
    let pageReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        pageReads++;
        if (pageReads === 1)
          return Response.json({
            products: [card("second")],
            hasMore: true,
            nextCursor: "cursor-2",
          });
        if (pageReads === 2)
          return Response.json(
            { resetUrl: "/shop", stale: true },
            { status: 409 },
          );
        return Response.json({
          products: [card("current")],
          hasMore: false,
          nextCursor: null,
        });
      }),
    );
    const filters = parseShopQuery(new URL("https://example.com/shop")).filters;
    const data = {
      revision: crypto.randomUUID(),
      page: {
        products: [card("first")],
        hasMore: true,
        nextCursor: "cursor-1",
      },
      filters,
      query: parseShopQuery(new URL("https://example.com/shop")),
      categories: [],
      facets: { materials: [], colours: [] },
      emptyCatalog: false,
    };
    const Stub = createRoutesStub([
      { path: "/shop", Component: Shop, loader: () => data, shouldRevalidate },
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Stub initialEntries={["/shop"]} />));
      await scrollTowardShopEnd();
      await act(async () => observer.trigger());
      expect(host.querySelectorAll(".shop-product-card")).toHaveLength(2);
      await scrollTowardShopEnd();
      await act(async () => observer.trigger());
      expect(host.querySelectorAll(".shop-product-card")).toHaveLength(2);
      expect(host.textContent).toContain("The collection changed");
      expect(host.querySelector(".shop-next")).toBeNull();
      expect(observer.activeCount()).toBe(0);
      await act(async () => observer.trigger());
      expect(pageReads).toBe(2);
      await act(async () =>
        (
          host.querySelector(".shop-page-message button") as HTMLButtonElement
        ).click(),
      );
      expect(host.querySelector(".shop-product-grid")?.textContent).toContain(
        "current",
      );
      expect(host.querySelectorAll(".shop-product-card")).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
