import { Link } from "react-router";

import { formatCad } from "../../lib/format-cad";
import { ProductPhoto, productPhotoAlt } from "./product-photo";

export interface ShopCard {
  slug: string;
  name: string;
  priceCents: number;
  status: "available" | "sold";
  cover: { url: string; altText: string | null } | null;
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
          <Link className="shop-product-link" to={`/products/${product.slug}`}>
            <ProductPhoto
              className="shop-product-image"
              src={product.cover?.url ?? null}
              alt={productPhotoAlt(
                product.name,
                product.cover?.altText ?? null,
              )}
              loading="lazy"
            />
            <div className="shop-product-details">
              <p className="shop-product-price">
                {formatCad(product.priceCents)}
              </p>
              <h3>{product.name}</h3>
              {product.status === "sold" ? (
                <p className="shop-product-sold">Sold Out</p>
              ) : null}
            </div>
          </Link>
        </li>
      ))}
    </ol>
  );
}
