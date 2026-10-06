import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";

import type { ShopPage } from "../../lib/shop-data.server";
import {
  MAX_SHOP_BATCHES,
  shopUrl,
  type ShopFilters,
} from "../../lib/shop-query";
import { ShopProductGrid } from "./shop-product-grid";

interface DiscoveryData {
  page: ShopPage;
  filters: ShopFilters;
  categories: { name: string; slug: string }[];
  facets: { materials: string[]; colours: string[] };
  emptyCatalog: boolean;
}

function uniqueCards(pages: ShopPage[]) {
  const slugs = new Set<string>();
  return pages.flatMap((page) =>
    page.products.filter((card) => {
      if (slugs.has(card.slug)) return false;
      slugs.add(card.slug);
      return true;
    }),
  );
}

export function ShopDiscovery({
  data,
  onBatchSupplied,
}: {
  data: DiscoveryData;
  onBatchSupplied: (url: string) => () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const target = Number(params.get("batches") || "1");
  const isAfter = params.has("after");
  const baseUrl = shopUrl(data.filters);
  const [pages, setPages] = useState<ShopPage[]>([data.page]);
  const pagesRef = useRef(pages);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [stale, setStale] = useState(false);
  const [autoArmKey, setAutoArmKey] = useState<string | null>(null);
  const autoArmed = autoArmKey === location.key;
  const pending = useRef(false);
  const appendController = useRef<AbortController | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const epoch = useRef(0);
  const restorationRun = useRef(0);

  useEffect(
    () => () => {
      epoch.current++;
      appendController.current?.abort();
    },
    [],
  );

  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);

  useEffect(() => {
    const key = `shop-scroll:${location.key}`;
    return () => {
      appendController.current?.abort();
      try {
        sessionStorage.setItem(key, String(window.scrollY));
      } catch {
        /* private mode */
      }
    };
  }, [location.key]);

  useEffect(() => {
    const arm = () => setAutoArmKey(location.key);
    let scrollbarStart: number | null = null;
    const beginScrollbarDrag = (event: PointerEvent) => {
      const gutterEdge = Math.min(
        document.documentElement.clientWidth,
        window.innerWidth - 18,
      );
      if (
        event.button === 0 &&
        event.target === document.documentElement &&
        event.clientX >= gutterEdge
      )
        scrollbarStart = window.scrollY;
    };
    const finishScrollbarDrag = () => {
      scrollbarStart = null;
    };
    const armAfterScrollbarMovement = () => {
      if (scrollbarStart !== null && window.scrollY !== scrollbarStart) {
        scrollbarStart = null;
        arm();
      }
    };
    const armFromKeyboard = (event: KeyboardEvent) => {
      if (
        ["ArrowDown", "PageDown", "End", " "].includes(event.key) &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLSelectElement) &&
        !(event.target instanceof HTMLTextAreaElement)
      )
        arm();
    };
    window.addEventListener("wheel", arm, { passive: true });
    window.addEventListener("touchmove", arm, { passive: true });
    window.addEventListener("keydown", armFromKeyboard);
    window.addEventListener("pointerdown", beginScrollbarDrag);
    window.addEventListener("pointerup", finishScrollbarDrag);
    window.addEventListener("pointercancel", finishScrollbarDrag);
    window.addEventListener("scroll", armAfterScrollbarMovement, {
      passive: true,
    });
    return () => {
      window.removeEventListener("wheel", arm);
      window.removeEventListener("touchmove", arm);
      window.removeEventListener("keydown", armFromKeyboard);
      window.removeEventListener("pointerdown", beginScrollbarDrag);
      window.removeEventListener("pointerup", finishScrollbarDrag);
      window.removeEventListener("pointercancel", finishScrollbarDrag);
      window.removeEventListener("scroll", armAfterScrollbarMovement);
    };
  }, [location.key]);

  function restoreScroll() {
    try {
      const saved = sessionStorage.getItem(`shop-scroll:${location.key}`);
      if (saved !== null)
        requestAnimationFrame(() => window.scrollTo(0, Number(saved)));
    } catch {
      /* Browser scroll restoration remains available. */
    }
  }

  const readPage = useCallback(
    async function readPage(
      cursor: string,
      signal?: AbortSignal,
    ): Promise<ShopPage | { resetUrl: string }> {
      const url = new URL(baseUrl, window.location.origin);
      url.pathname = "/shop/page";
      url.searchParams.set("after", cursor);
      const response = await fetch(url, {
        signal,
        headers: { Accept: "application/json" },
      });
      if (response.status === 409)
        return response.json() as Promise<{ resetUrl: string }>;
      if (!response.ok) throw new Error("Shop page unavailable");
      return response.json() as Promise<ShopPage>;
    },
    [baseUrl],
  );

  useEffect(() => {
    if (isAfter || stale || failed || pending.current) return;
    if (target <= pagesRef.current.length) {
      restoreScroll();
      return;
    }
    const controller = new AbortController();
    const runId = ++restorationRun.current;
    let started = false;
    const run = async () => {
      if (controller.signal.aborted) return;
      started = true;
      setBusy(true);
      const startedAt = epoch.current;
      try {
        while (pagesRef.current.length < target) {
          const last = pagesRef.current.at(-1)!;
          if (!last.nextCursor || !last.hasMore) {
            const corrected = shopUrl(data.filters, {
              batches: pagesRef.current.length,
            });
            const clear =
              pagesRef.current.length > 1
                ? onBatchSupplied(corrected)
                : () => {};
            try {
              await navigate(corrected, {
                replace: true,
                preventScrollReset: true,
              });
            } finally {
              clear();
            }
            restoreScroll();
            break;
          }
          const next = await readPage(last.nextCursor, controller.signal);
          if (controller.signal.aborted || startedAt !== epoch.current) return;
          if ("resetUrl" in next) {
            setStale(true);
            break;
          }
          pagesRef.current = [...pagesRef.current, next];
          setPages(pagesRef.current);
        }
        if (!controller.signal.aborted) restoreScroll();
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      } finally {
        if (restorationRun.current === runId) setBusy(false);
      }
    };
    void Promise.resolve().then(run);
    return () => {
      controller.abort();
      if (started) setBusy(false);
    };
    // Reads are driven by the URL batch target and the fresh first page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, data.page, isAfter, stale, failed]);

  const loadMore = useCallback(
    async function loadMore(event?: React.MouseEvent<HTMLAnchorElement>) {
      if (isAfter) return;
      event?.preventDefault();
      if (busy || pending.current || stale) return;
      if (target >= MAX_SHOP_BATCHES) return;
      if (pagesRef.current.length > target) {
        const url = shopUrl(data.filters, { batches: target + 1 });
        const clear = onBatchSupplied(url);
        try {
          await navigate(url, { preventScrollReset: true });
        } finally {
          clear();
        }
        return;
      }
      const last = pagesRef.current.at(-1)!;
      if (!last.nextCursor) return;
      pending.current = true;
      const controller = new AbortController();
      appendController.current = controller;
      setBusy(true);
      const startedAt = epoch.current;
      try {
        const next = await readPage(last.nextCursor, controller.signal);
        if (controller.signal.aborted || startedAt !== epoch.current) return;
        if ("resetUrl" in next) {
          setStale(true);
          return;
        }
        pagesRef.current = [...pagesRef.current, next];
        setPages(pagesRef.current);
        const url = shopUrl(data.filters, { batches: pagesRef.current.length });
        const clear = onBatchSupplied(url);
        try {
          await navigate(url, { preventScrollReset: true });
        } finally {
          clear();
        }
      } catch {
        if (!controller.signal.aborted && startedAt === epoch.current)
          setFailed(true);
      } finally {
        pending.current = false;
        if (appendController.current === controller)
          appendController.current = null;
        if (startedAt === epoch.current) setBusy(false);
      }
    },
    [
      busy,
      data.filters,
      isAfter,
      navigate,
      onBatchSupplied,
      readPage,
      stale,
      target,
    ],
  );

  useEffect(() => {
    if (
      typeof IntersectionObserver === "undefined" ||
      !sentinel.current ||
      !autoArmed ||
      isAfter ||
      busy ||
      failed ||
      stale ||
      pending.current ||
      target > pages.length ||
      target >= MAX_SHOP_BATCHES ||
      !pages.at(target - 1)?.hasMore
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void loadMore();
      },
      { rootMargin: "0px 0px 300px 0px" },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [autoArmed, busy, failed, isAfter, loadMore, pages, stale, target]);

  async function startAgain() {
    if (busy) return;
    setBusy(true);
    try {
      const url = new URL(baseUrl, window.location.origin);
      url.pathname = "/shop/page";
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Shop unavailable");
      const page = (await response.json()) as ShopPage;
      pagesRef.current = [page];
      setPages([page]);
      setFailed(false);
      setStale(false);
      await navigate(baseUrl, { replace: true, preventScrollReset: true });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const shown = uniqueCards(pages.slice(0, Math.min(target, pages.length)));
  const last = pages.at(Math.min(target, pages.length) - 1)!;
  const nextUrl = last.nextCursor
    ? shopUrl(data.filters, { after: last.nextCursor })
    : null;
  const atBrowsingLimit =
    !isAfter &&
    target === MAX_SHOP_BATCHES &&
    pages.length >= MAX_SHOP_BATCHES &&
    last.hasMore;
  const activeFilters = [
    data.filters.q ? `Search: ${data.filters.q}` : null,
    data.filters.category
      ? `Category: ${data.categories.find((category) => category.slug === data.filters.category)?.name ?? data.filters.category}`
      : null,
    data.filters.material ? `Material: ${data.filters.material}` : null,
    data.filters.colour ? `Colour: ${data.filters.colour}` : null,
    data.filters.availability
      ? `Availability: ${data.filters.availability === "sold" ? "Sold Out" : "Available"}`
      : null,
  ].filter((value): value is string => value !== null);
  const hasChoices = activeFilters.length > 0 || data.filters.sort !== "newest";
  return (
    <>
      <div className="shop-toolbar">
        <details className="shop-filter-disclosure">
          <summary>
            Filters{activeFilters.length ? ` (${activeFilters.length})` : ""}
          </summary>
          <form
            action="/shop"
            method="get"
            className="shop-filter-panel"
            role="search"
            onSubmit={() => appendController.current?.abort()}
          >
            <input type="hidden" name="sort" value={data.filters.sort} />
            <label className="shop-control shop-control--search">
              Search by name
              <input
                name="q"
                type="search"
                maxLength={100}
                defaultValue={data.filters.q}
                key={`q-${baseUrl}`}
                placeholder="Search jewelry"
              />
            </label>
            <label className="shop-control">
              Category
              <select
                name="category"
                defaultValue={data.filters.category}
                key={`category-${baseUrl}`}
              >
                <option value="">All categories</option>
                {data.categories.map((category) => (
                  <option key={category.slug} value={category.slug}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="shop-control">
              Material
              <select
                name="material"
                defaultValue={data.filters.material}
                key={`material-${baseUrl}`}
              >
                <option value="">All materials</option>
                {data.filters.material &&
                !data.facets.materials.includes(data.filters.material) ? (
                  <option value={data.filters.material}>
                    {data.filters.material} (no matches)
                  </option>
                ) : null}
                {data.facets.materials.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="shop-control">
              Colour
              <select
                name="colour"
                defaultValue={data.filters.colour}
                key={`colour-${baseUrl}`}
              >
                <option value="">All colours</option>
                {data.filters.colour &&
                !data.facets.colours.includes(data.filters.colour) ? (
                  <option value={data.filters.colour}>
                    {data.filters.colour} (no matches)
                  </option>
                ) : null}
                {data.facets.colours.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="shop-control">
              Availability
              <select
                name="availability"
                defaultValue={data.filters.availability}
                key={`availability-${baseUrl}`}
              >
                <option value="">All</option>
                <option value="available">Available</option>
                <option value="sold">Sold Out</option>
              </select>
            </label>
            <button type="submit" className="shop-apply-button">
              Show results
            </button>
          </form>
        </details>
        <form
          action="/shop"
          method="get"
          className="shop-sort-form"
          onSubmit={() => appendController.current?.abort()}
        >
          {(
            ["q", "category", "material", "colour", "availability"] as const
          ).map((key) =>
            data.filters[key] ? (
              <input
                key={key}
                type="hidden"
                name={key}
                value={data.filters[key]}
              />
            ) : null,
          )}
          <label className="shop-control shop-sort-control">
            Sort by
            <select
              name="sort"
              defaultValue={data.filters.sort}
              key={`sort-${baseUrl}`}
            >
              <option value="newest">Newest</option>
              <option value="price-asc">Price: low to high</option>
              <option value="price-desc">Price: high to low</option>
            </select>
          </label>
          <button type="submit" className="shop-apply-button">
            Apply
          </button>
        </form>
      </div>
      <div className="shop-active-summary">
        <p>
          {hasChoices
            ? `Showing: ${[...activeFilters, data.filters.sort !== "newest" ? `Sort: ${data.filters.sort === "price-asc" ? "Price low to high" : "Price high to low"}` : null].filter(Boolean).join(" · ")}`
            : "Showing: All pieces"}
        </p>
        {hasChoices ? (
          <Link to="/shop" onClick={() => appendController.current?.abort()}>
            Clear
          </Link>
        ) : null}
      </div>
      <p className="shop-results-status" aria-live="polite">
        {busy && target > pages.length
          ? "Restoring your results…"
          : `${shown.length} pieces shown`}
      </p>
      {target > 1 ? (
        <noscript>
          <p>
            Use Next products below to continue through the current collection.
          </p>
        </noscript>
      ) : null}
      {shown.length === 0 ? (
        <div className="shop-empty">
          <h3>
            {isAfter
              ? "No more pieces on this page"
              : data.emptyCatalog
                ? "No pieces available right now"
                : "No pieces match your search"}
          </h3>
          <p>
            {isAfter
              ? "Return to the first products to browse the current collection."
              : data.emptyCatalog
                ? "Check back soon for new additions."
                : "Try different filters or clear your search."}
          </p>
          {isAfter ? <Link to={baseUrl}>First products</Link> : null}
        </div>
      ) : (
        <div
          onClick={(event) => {
            if ((event.target as HTMLElement).closest(".shop-product-link")) {
              appendController.current?.abort();
              try {
                sessionStorage.setItem(
                  `shop-scroll:${location.key}`,
                  String(window.scrollY),
                );
              } catch {
                /* private mode */
              }
            }
          }}
        >
          <ShopProductGrid products={shown} />
        </div>
      )}
      {!isAfter && nextUrl && !stale && !failed && !atBrowsingLimit ? (
        <div ref={sentinel} className="shop-sentinel" aria-hidden="true" />
      ) : null}
      {busy && target <= pages.length ? (
        <p className="shop-auto-status" role="status">
          Loading more products…
        </p>
      ) : null}
      {stale ? (
        <div className="shop-page-message" role="status">
          <p>
            The collection changed while you were browsing. Start again to see
            the current results.
          </p>
          <button
            type="button"
            onClick={() => void startAgain()}
            disabled={busy}
          >
            {busy
              ? "Starting again…"
              : failed
                ? "Retry starting again"
                : "Start again"}
          </button>
        </div>
      ) : null}
      {failed && !stale ? (
        <div className="shop-page-message" role="status">
          <p>
            More products could not be loaded. Your current results are still
            here.
          </p>
          <button
            type="button"
            onClick={() => {
              setFailed(false);
              if (target <= pagesRef.current.length) void loadMore();
            }}
          >
            Retry
          </button>
        </div>
      ) : null}
      {atBrowsingLimit ? (
        <p className="shop-page-message" role="status">
          You’ve reached the browsing limit. Use search or filters to narrow the
          collection and find more pieces.
        </p>
      ) : null}
      {!stale && !failed && !atBrowsingLimit && nextUrl ? (
        <a
          className="shop-next"
          href={nextUrl}
          onClick={(event) => void loadMore(event)}
          aria-disabled={busy}
        >
          {busy ? "Loading…" : isAfter ? "Next products" : "Load More"}
        </a>
      ) : null}
    </>
  );
}
