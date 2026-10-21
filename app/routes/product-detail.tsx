import { isRouteErrorResponse, Link } from "react-router";

import type { Route } from "./+types/product-detail";
import { cloudflareContext } from "../cloudflare-context";
import {
  ProductGallery,
  type GalleryImage,
} from "../components/storefront/product-gallery";
import { getPublicProductBySlug } from "../lib/db/products.server";
import { formatCad } from "../lib/format-cad";
import { productImageUrl } from "../lib/images/image-urls";
import { safeFacebookUrl } from "../lib/safe-facebook-url";

import { isLocalCommerceEnabled } from "../lib/commerce/environment.server";
import { readShoppingVariants } from "../lib/commerce/shopping.server";
import { ProductPurchase } from "../components/storefront/product-purchase";

const unavailable = "Product catalog unavailable";

export async function loader({ context, params, request }: Route.LoaderArgs) {
  const db = context.get(cloudflareContext).env.DB;
  let result: Awaited<ReturnType<typeof getPublicProductBySlug>>;
  try {
    result = await getPublicProductBySlug(db, params.slug);
  } catch (error) {
    console.error("Product catalog load failed", error);
    throw new Response(null, { status: 503, statusText: unavailable });
  }
  if (result === null) throw new Response(null, { status: 404 });

  const { product, images } = result;
  const gallery: GalleryImage[] = images.map((image) => ({
    id: image.id,
    altText: image.altText,
    thumbUrl: productImageUrl(product.id, image.id, "thumb"),
    detailUrl: productImageUrl(product.id, image.id, "detail"),
    zoomUrl: productImageUrl(product.id, image.id, "zoom"),
  }));

  const localShopping = isLocalCommerceEnabled(
    request,
    context.get(cloudflareContext).env,
  );
  let shoppingVariants = null;
  if (localShopping) {
    try {
      shoppingVariants = await readShoppingVariants(db, {
        productId: product.id,
      });
    } catch {
      throw new Response(null, { status: 503, statusText: unavailable });
    }
  }
  return {
    shoppingVariants,
    product: {
      name: product.name,
      priceCents: product.priceCents,
      status: product.status,
      description: product.description,
      material: product.material,
      colour: product.colour,
      facebookUrl:
        product.status === "available"
          ? safeFacebookUrl(product.facebookUrl)
          : null,
    },
    gallery,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) {
    return [
      { title: "Product unavailable | Velaform Studio" },
      { name: "description", content: "Browse the jewelry collection." },
    ];
  }
  const { product } = loaderData;
  const summary = product.description?.trim().replace(/\s+/g, " ");
  return [
    { title: `${product.name} | Velaform Studio` },
    {
      name: "description",
      content: summary
        ? summary.slice(0, 155)
        : `${product.name} — ${product.status === "sold" ? "Sold Out" : "Available"}. Browse the jewelry collection.`,
    },
  ];
}

export default function ProductDetail({
  loaderData,
  params,
}: Route.ComponentProps) {
  const { product, gallery, shoppingVariants } = loaderData;
  return (
    <div className="container product-detail">
      <nav aria-label="Breadcrumb" className="breadcrumb product-breadcrumb">
        <Link to="/shop">← Shop</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{product.name}</span>
      </nav>
      <div className="product-detail-layout">
        <ProductGallery name={product.name} images={gallery} />
        <div className="product-detail-info">
          <h1>{product.name}</h1>
          {shoppingVariants == null ? (
            <>
              <p className="product-detail-price">
                {formatCad(product.priceCents)}
              </p>
              <p className="product-detail-status">
                {product.status === "sold" ? "Sold Out" : "Available"}
              </p>
            </>
          ) : (
            <ProductPurchase key={params.slug} variants={shoppingVariants} />
          )}
          {product.description ? (
            <p className="product-detail-description">{product.description}</p>
          ) : null}
          {product.material || (shoppingVariants == null && product.colour) ? (
            <dl className="product-detail-attributes">
              {product.material ? (
                <>
                  <dt>Material</dt>
                  <dd>{product.material}</dd>
                </>
              ) : null}
              {shoppingVariants == null && product.colour ? (
                <>
                  <dt>Colour</dt>
                  <dd>{product.colour}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
          {product.facebookUrl ? (
            <a
              className="button-link product-detail-cta"
              href={product.facebookUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              View on Facebook Marketplace
            </a>
          ) : null}
        </div>
      </div>
      <Link className="product-detail-back" to="/shop">
        Back to Shop
      </Link>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const routeError = isRouteErrorResponse(error) || error instanceof Response;
  const missing = routeError && error.status === 404;
  const failed =
    routeError && error.status === 503 && error.statusText === unavailable;
  return (
    <div className="container error-content">
      <h1 className="page-title">
        {missing
          ? "Product not found"
          : failed
            ? "We couldn’t load this product"
            : "Something went wrong"}
      </h1>
      <p className="lead">
        {missing
          ? "This piece isn’t available to view."
          : "Please try again in a moment."}
      </p>
      <Link className="button-link" to="/shop">
        Back to Shop
      </Link>
    </div>
  );
}
