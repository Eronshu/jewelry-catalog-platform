import { formatCad } from "../../lib/format-cad";

export interface ShopCard {
  slug: string;
  name: string;
  priceCents: number;
  status: "available" | "sold";
}

export function ShopProductGrid({
  products,
}: {
  products: readonly ShopCard[];
}) {
  return (
    <ol className="shop-product-grid">
      {products.map((product) => (
        <li className="shop-product-card" key={product.slug}>
          <div
            aria-hidden="true"
            className="shop-product-image shop-product-placeholder"
          >
            <span>Photo coming soon</span>
          </div>
          <div className="shop-product-details">
            <p className="shop-product-price">
              {formatCad(product.priceCents)}
            </p>
            <h3>{product.name}</h3>
            {product.status === "sold" ? (
              <p className="shop-product-sold">Sold Out</p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
