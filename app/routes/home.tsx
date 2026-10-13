import { isRouteErrorResponse, Link } from "react-router";

import type { Route } from "./+types/home";
import { cloudflareContext } from "../cloudflare-context";
import { ShopProductGrid } from "../components/storefront/shop-product-grid";
import { reviewImages } from "../lib/design-review-images";
import { homeData } from "../lib/home-data.server";

const homeCatalogUnavailable = "Home catalog unavailable";

export async function loader({ context }: Route.LoaderArgs) {
  try {
    return await homeData(context.get(cloudflareContext).env.DB);
  } catch (error) {
    console.error("Home catalog load failed", error);
    throw new Response(null, {
      status: 503,
      statusText: homeCatalogUnavailable,
    });
  }
}

export function meta() {
  return [
    { title: "Wear it your way | Velaform Studio" },
    {
      name: "description",
      content: "Jewelry for every version of you.",
    },
  ];
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <section aria-labelledby="home-title" className="home-stage">
        <img
          alt={reviewImages.urban.alt}
          className="cover-image home-stage-image"
          fetchPriority="high"
          height="1200"
          sizes="100vw"
          src={reviewImages.urban.src}
          srcSet={reviewImages.urban.srcSet}
          width="1200"
        />
        <div aria-hidden="true" className="home-stage-shade" />
        <div className="container home-stage-copy">
          <h1 id="home-title">Wear it your way.</h1>
          <Link className="button-link button-link--light" to="/shop">
            Shop jewelry <span aria-hidden="true">↗</span>
          </Link>
          <p className="home-stage-note">
            Temporary editorial photo for visual direction.
          </p>
        </div>
      </section>

      <section
        aria-labelledby="featured-title"
        className="container home-featured"
      >
        <div className="home-section-heading">
          <div>
            <h2 id="featured-title">Recently added</h2>
            <p>Prices in CAD</p>
          </div>
          <Link className="text-link" to="/shop">
            View Shop <span aria-hidden="true">↗</span>
          </Link>
        </div>
        {loaderData.products.length ? (
          <div className="home-product-grid">
            <ShopProductGrid products={loaderData.products} />
          </div>
        ) : (
          <div className="home-empty">
            <p>No pieces to feature right now. Explore the Shop for updates.</p>
            <Link className="text-link" to="/shop">
              Browse Shop
            </Link>
          </div>
        )}
      </section>

      <section aria-labelledby="style-title" className="container home-browse">
        <div className="home-section-heading">
          <div>
            <h2 id="style-title">Style inspiration</h2>
            <p>Temporary editorial imagery · shown for visual direction</p>
          </div>
          <Link className="text-link" to="/shop">
            Shop all <span aria-hidden="true">↗</span>
          </Link>
        </div>
        <div className="home-browse-grid">
          <figure className="home-browse-tile home-browse-tile--feature">
            <img
              alt={reviewImages.body.alt}
              className="cover-image"
              height="1200"
              loading="lazy"
              sizes="(min-width: 48rem) 55vw, 100vw"
              src={reviewImages.body.src}
              srcSet={reviewImages.body.srcSet}
              width="1200"
            />
            <figcaption>After dark</figcaption>
          </figure>
          <figure className="home-browse-tile home-browse-tile--detail">
            <img
              alt={reviewImages.hero.alt}
              className="cover-image"
              height="1200"
              loading="lazy"
              sizes="(min-width: 48rem) 40vw, 50vw"
              src={reviewImages.hero.src}
              srcSet={reviewImages.hero.srcSet}
              width="1200"
            />
            <figcaption>Soft shine</figcaption>
          </figure>
          <figure className="home-browse-tile home-browse-tile--still">
            <img
              alt={reviewImages.bracelet.alt}
              className="cover-image"
              height="1200"
              loading="lazy"
              sizes="(min-width: 48rem) 40vw, 50vw"
              src={reviewImages.bracelet.src}
              srcSet={reviewImages.bracelet.srcSet}
              width="1200"
            />
            <figcaption>Everyday extra</figcaption>
          </figure>
        </div>
      </section>

      <section aria-labelledby="night-title" className="home-night">
        <div className="container home-night-content">
          <h2 id="night-title">Not here to blend in.</h2>
          <Link className="button-link button-link--light" to="/shop">
            Explore the shop <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </section>
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const unavailable =
    (isRouteErrorResponse(error) || error instanceof Response) &&
    error.status === 503 &&
    error.statusText === homeCatalogUnavailable;
  return (
    <div className="container error-content">
      <h1 className="page-title">
        {unavailable
          ? "We couldn’t load the collection"
          : "Something went wrong"}
      </h1>
      <p className="lead">Please try again in a moment.</p>
      <Link className="button-link" to="/shop">
        Browse Shop
      </Link>
    </div>
  );
}
