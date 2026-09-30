import { Link } from "react-router";

import { DesignReviewProductGrid } from "../components/storefront/design-review-product-grid";
import { reviewImages } from "../lib/design-review-images";
import { shopDesignReviewCards } from "../lib/shop-design-review-fixture";

export function meta() {
  return [
    { title: "Shop | Jewelry Catalog" },
    {
      name: "description",
      content: "Explore the future home of the jewelry collection.",
    },
  ];
}

export default function Shop() {
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
            <h2 id="catalog-preview-title">Browse the preview</h2>
            <p>24 layout samples</p>
          </div>
          <span className="shop-catalog-future">
            Filter &amp; sort with the live catalog
          </span>
        </div>
        <p className="shop-fixture-notice">
          Design-review only. These are not products for sale; images and labels
          are illustrative. Prices unavailable.
        </p>
        <DesignReviewProductGrid cards={shopDesignReviewCards} eagerCount={4} />
      </section>
    </>
  );
}
