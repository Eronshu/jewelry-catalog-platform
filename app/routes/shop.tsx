import { isRouteErrorResponse, Link, redirect } from "react-router";

import type { Route } from "./+types/shop";
import { cloudflareContext } from "../cloudflare-context";
import { ShopDiscovery } from "../components/storefront/shop-discovery";
import { reviewImages } from "../lib/design-review-images";
import { shopData } from "../lib/shop-data.server";

const shopCatalogUnavailable = "Shop catalog unavailable";
const suppliedBatchUrls = new WeakMap<Window, Set<string>>();

export function markSuppliedBatch(url: string) {
  if (typeof window === "undefined") return () => {};
  let urls = suppliedBatchUrls.get(window);
  if (!urls) {
    urls = new Set();
    suppliedBatchUrls.set(window, urls);
  }
  const next = new URL(url, window.location.origin);
  const key = next.pathname + next.search;
  urls.add(key);
  return () => urls.delete(key);
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const db = context.get(cloudflareContext).env.DB;
  let result;
  try {
    result = await shopData(db, new URL(request.url));
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("Shop catalog load failed", error);
    throw new Response(null, {
      status: 503,
      statusText: shopCatalogUnavailable,
    });
  }
  if ("resetUrl" in result) {
    if (result.stale)
      return { stalePagination: true as const, startUrl: result.resetUrl };
    return redirect(result.resetUrl);
  }
  return { ...result, revision: crypto.randomUUID() };
}

export function shouldRevalidate({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: {
  currentUrl: URL;
  nextUrl: URL;
  defaultShouldRevalidate: boolean;
}) {
  if (
    typeof window === "undefined" ||
    currentUrl.pathname !== "/shop" ||
    nextUrl.pathname !== "/shop"
  )
    return defaultShouldRevalidate;
  const urls = suppliedBatchUrls.get(window);
  if (!urls?.has(nextUrl.pathname + nextUrl.search))
    return defaultShouldRevalidate;
  const current = new URL(currentUrl);
  const next = new URL(nextUrl);
  current.searchParams.delete("batches");
  next.searchParams.delete("batches");
  return current.href === next.href ? false : defaultShouldRevalidate;
}

export function meta() {
  return [
    { title: "Shop | Jewelry Catalog" },
    { name: "description", content: "Browse the jewelry collection." },
  ];
}

export default function Shop({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <section aria-labelledby="shop-title" className="shop-intro">
        <img
          alt=""
          aria-hidden="true"
          className="cover-image shop-intro-image"
          fetchPriority="high"
          height="1200"
          sizes="100vw"
          src={reviewImages.urban.src}
          srcSet={reviewImages.urban.srcSet}
          width="1200"
        />
        <div className="container shop-intro-content">
          <nav
            aria-label="Breadcrumb"
            className="breadcrumb breadcrumb--inverse"
          >
            <Link to="/">
              <span aria-hidden="true">←</span> Home
            </Link>
            <span aria-hidden="true">/</span>
            <span aria-current="page">Shop</span>
          </nav>
          <div className="shop-intro-heading">
            <h1 id="shop-title">Shop</h1>
            <p>Find your next favorite piece.</p>
          </div>
        </div>
      </section>
      <section
        aria-labelledby="catalog-preview-title"
        className="container shop-catalog"
      >
        <div className="shop-catalog-heading">
          <div>
            <h2 id="catalog-preview-title">Browse the collection</h2>
            <p>Prices in CAD</p>
          </div>
        </div>
        {loaderData.stalePagination === true ? (
          <div className="shop-page-message" role="status">
            <h3>The collection changed</h3>
            <p>
              These results have changed since you opened the next page. Start
              again to see the current collection.
            </p>
            <Link to={loaderData.startUrl}>Start again</Link>
          </div>
        ) : (
          <ShopDiscovery
            key={loaderData.revision}
            data={loaderData}
            onBatchSupplied={markSuppliedBatch}
          />
        )}
      </section>
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  if (
    !isRouteErrorResponse(error) ||
    error.status !== 503 ||
    error.statusText !== shopCatalogUnavailable
  ) {
    return (
      <div className="container error-content">
        <h1 className="page-title">Something went wrong</h1>
        <p className="lead">Please try again later.</p>
      </div>
    );
  }
  return (
    <div className="container error-content">
      <h1 className="page-title">We couldn’t load the shop</h1>
      <p className="lead">Please try again in a moment.</p>
      <a className="button-link" href="/shop">
        Try again
      </a>
    </div>
  );
}
