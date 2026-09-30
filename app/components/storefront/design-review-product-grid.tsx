import type { shopDesignReviewCards } from "../../lib/shop-design-review-fixture";

type DesignReviewCard = (typeof shopDesignReviewCards)[number];

/** Temporary presentation for the Issue #2 visual fixture, not a catalog card. */
export function DesignReviewProductGrid({
  cards,
  eagerCount = 0,
  featured = false,
}: {
  cards: readonly DesignReviewCard[];
  eagerCount?: number;
  featured?: boolean;
}) {
  return (
    <ol
      className={`shop-product-grid${featured ? " shop-product-grid--featured" : ""}`}
    >
      {cards.map((card, index) => (
        <li className="shop-product-card" key={card.id}>
          <div className="shop-product-image">
            <img
              alt={card.image.alt}
              height="640"
              loading={index < eagerCount ? "eager" : "lazy"}
              sizes="(min-width: 100rem) 240px, (min-width: 64rem) 300px, (min-width: 48rem) 230px, 50vw"
              src={card.image.src}
              srcSet={card.image.srcSet}
              width="640"
            />
          </div>
          <div className="shop-product-details">
            <p className="shop-product-price">
              <span aria-hidden="true">CA$ —</span>
              <span className="sr-only">Price pending</span>
            </p>
            <h3>{card.label}</h3>
          </div>
        </li>
      ))}
    </ol>
  );
}
