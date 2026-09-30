import { isRouteErrorResponse, Link } from "react-router";

import type { Route } from "./+types/shop";
import { cloudflareContext } from "../cloudflare-context";
import {
  ShopProductGrid,
  type ShopCard,
} from "../components/storefront/shop-product-grid";
import { reviewImages } from "../lib/design-review-images";
import { listPublicProducts } from "../lib/db/products.server";

const shopCatalogUnavailable = "Shop catalog unavailable";

export async function loader({ context }: Route.LoaderArgs) {
  const db = context.get(cloudflareContext).env.DB;
  let products: Awaited<ReturnType<typeof listPublicProducts>>;
  try {
    products = await listPublicProducts(db);
  } catch (error) {
    console.error("Shop catalog load failed", error);
    throw new Response(null, {
      status: 503,
      statusText: shopCatalogUnavailable,
    });
  }

  const cards: ShopCard[] = products.map(
    ({ slug, name, priceCents, status }) => ({
      slug,
      name,
      priceCents,
      status,
    }),
  );
  return { products: cards };
}

export function meta() {
  return [
    { title: "Shop | Jewelry Catalog" },
    {
      name: "description",
      content: "Browse the jewelry collection.",
    },
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
        {loaderData.products.length === 0 ? (
          <div className="shop-empty">
            <h3>No pieces available right now</h3>
            <p>Check back soon for new additions.</p>
          </div>
        ) : (
          <ShopProductGrid products={loaderData.products} />
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
