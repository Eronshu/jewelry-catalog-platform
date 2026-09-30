import { Link } from "react-router";

import { DesignReviewProductGrid } from "../components/storefront/design-review-product-grid";
import { reviewImages } from "../lib/design-review-images";
import { shopDesignReviewCards } from "../lib/shop-design-review-fixture";

const featuredReviewCards = [
  shopDesignReviewCards[0],
  ...shopDesignReviewCards.slice(2, 9),
];
const afterDarkImage = shopDesignReviewCards[12].image;

export function meta() {
  return [
    { title: "Wear it your way | Jewelry Catalog" },
    {
      name: "description",
      content: "Jewelry for every version of you.",
    },
  ];
}

export default function Home() {
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
        </div>
      </section>

      <section
        aria-labelledby="featured-title"
        className="container home-featured"
      >
        <div className="home-section-heading">
          <div>
            <h2 id="featured-title">Featured preview</h2>
            <p>Design-review only · not for sale</p>
          </div>
          <Link className="text-link" to="/shop">
            View Shop <span aria-hidden="true">↗</span>
          </Link>
        </div>
        <DesignReviewProductGrid cards={featuredReviewCards} featured />
      </section>

      <section aria-labelledby="browse-title" className="container home-browse">
        <div className="home-section-heading">
          <h2 id="browse-title">Shop by mood</h2>
          <Link className="text-link" to="/shop">
            Shop all <span aria-hidden="true">↗</span>
          </Link>
        </div>
        <div className="home-browse-grid">
          <figure className="home-browse-tile home-browse-tile--feature">
            <img
              alt={afterDarkImage.alt}
              className="cover-image"
              height="1200"
              loading="lazy"
              sizes="(min-width: 48rem) 55vw, 100vw"
              src={afterDarkImage.src}
              srcSet={afterDarkImage.srcSet}
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
