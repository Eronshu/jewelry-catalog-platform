import { useEffect, useRef } from "react";
import {
  data,
  isRouteErrorResponse,
  Link,
  useFetcher,
  useRouteError,
} from "react-router";
import type { Route } from "./+types/cart";
import { cloudflareContext } from "../cloudflare-context";
import { requireLocalCommerce } from "../lib/commerce/environment.server";
import { readCommerceForm } from "../lib/commerce/request.server";
import { resolveShoppingCart } from "../lib/commerce/shopping.server";
import { parseShoppingLines } from "../lib/commerce/shopping-cart";
import { formatCad } from "../lib/format-cad";
import { productImageUrl } from "../lib/images/image-urls";
import { useShoppingCart } from "../components/storefront/shopping-cart-context";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
};
export function headers() {
  return privateHeaders;
}
export function meta() {
  return [
    { title: "Your cart — local preview | Velaform Studio" },
    { name: "robots", content: "noindex, nofollow" },
  ];
}
export function loader({ request, context }: Route.LoaderArgs) {
  requireLocalCommerce(request, context.get(cloudflareContext).env);
  return data({ localPreview: true }, { headers: privateHeaders });
}
export async function action({ request, context }: Route.ActionArgs) {
  const env = context.get(cloudflareContext).env;
  requireLocalCommerce(request, env);
  const form = await readCommerceForm(request);
  let lines;
  try {
    if (form.get("intent") !== "resolve") throw new Error("Invalid action");
    lines = parseShoppingLines(JSON.parse(form.get("lines") ?? ""));
  } catch {
    return data(
      {
        error:
          "Your cart could not be read. Remove invalid items or start a new cart.",
      },
      { status: 422, headers: privateHeaders },
    );
  }
  try {
    return data(await resolveShoppingCart(env.DB, lines), {
      headers: privateHeaders,
    });
  } catch {
    return data(
      {
        error:
          "Current prices and availability could not be loaded. Please retry.",
      },
      { status: 503, headers: privateHeaders },
    );
  }
}

export default function ShoppingCart() {
  const cart = useShoppingCart();
  const fetcher = useFetcher<typeof action>();
  const { submit } = fetcher;
  const key = JSON.stringify(cart.lines);
  const title = useRef<HTMLHeadingElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  function refresh() {
    submit(
      { intent: "resolve", lines: key },
      { method: "post", action: "/cart" },
    );
  }
  useEffect(() => {
    if (cart.ready && key !== "[]")
      submit(
        { intent: "resolve", lines: key },
        { method: "post", action: "/cart" },
      );
  }, [cart.ready, key, submit]);
  const result =
    fetcher.state === "idle" &&
    fetcher.data &&
    "key" in fetcher.data &&
    fetcher.data.key === key
      ? fetcher.data
      : undefined;
  const error =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;
  function remove(variantId: string) {
    cart.change(cart.lines.filter((line) => line.variantId !== variantId));
    title.current?.focus();
    if (status.current)
      status.current.textContent = "Item removed from your cart.";
  }
  return (
    <div className="container commerce-page">
      <header className="commerce-intro">
        <h1 ref={title} tabIndex={-1}>
          Your cart
        </h1>
        <p>
          Local shopping preview with fictional products. No orders or payments
          can be placed.
        </p>
      </header>
      <p ref={status} role="status" />
      {!cart.ready ? (
        <p role="status">Loading your saved cart…</p>
      ) : !cart.lines.length ? (
        <div className="commerce-empty-cart">
          <h2>Your cart is empty</h2>
          <Link to="/shop">Browse products</Link>
        </div>
      ) : (
        <>
          {!result && !error && (
            <p role="status">Checking current prices and availability…</p>
          )}
          {error && (
            <p className="commerce-alert" role="alert">
              {error}
            </p>
          )}
          <div className="commerce-quote-form">
            <ul className="commerce-cart-items" aria-label="Cart items">
              {cart.lines.map((line) => {
                const item = result?.items.find(
                  (item) => item.variantId === line.variantId,
                );
                const variant = item?.variant;
                const unavailable =
                  item &&
                  (!variant ||
                    !variant.active ||
                    variant.available < line.quantity);
                const label = variant
                  ? `${variant.name} — ${variant.colour}`
                  : item
                    ? "Unavailable item"
                    : "Saved item";
                return (
                  <li className="commerce-cart-item" key={line.variantId}>
                    {variant?.imageId ? (
                      <img
                        className="commerce-cart-thumb shopping-thumb"
                        width="80"
                        height="80"
                        src={productImageUrl(
                          variant.productId,
                          variant.imageId,
                          "thumb",
                        )}
                        alt={variant.imageAlt ?? variant.name}
                      />
                    ) : (
                      <div className="commerce-cart-thumb" aria-hidden="true">
                        <span className="commerce-product-art-mark" />
                      </div>
                    )}
                    <div className="commerce-cart-item-body">
                      <div className="commerce-cart-item-heading">
                        <p>
                          {variant ? (
                            <Link
                              className="shopping-product-link"
                              to={`/products/${variant.slug}`}
                            >
                              {label}
                            </Link>
                          ) : (
                            label
                          )}
                        </p>
                        <strong>
                          {item?.lineTotalCents != null
                            ? formatCad(item.lineTotalCents)
                            : "—"}
                        </strong>
                      </div>
                      {variant && (
                        <p>
                          {variant.sizeDescription} ·{" "}
                          {formatCad(variant.priceCents)} each
                        </p>
                      )}
                      <div className="commerce-cart-item-controls">
                        <label htmlFor={`qty-${line.variantId}`}>
                          Quantity for {label}
                        </label>
                        <input
                          key={`${line.variantId}-${line.quantity}`}
                          id={`qty-${line.variantId}`}
                          className="commerce-quantity"
                          type="number"
                          inputMode="numeric"
                          min="1"
                          max="20"
                          step="1"
                          defaultValue={line.quantity}
                          aria-invalid={unavailable || undefined}
                          aria-describedby={
                            unavailable ? `stock-${line.variantId}` : undefined
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter")
                              event.currentTarget.blur();
                          }}
                          onBlur={(event) => {
                            const quantity = event.currentTarget.valueAsNumber;
                            if (
                              !Number.isSafeInteger(quantity) ||
                              quantity < 1 ||
                              quantity > 20
                            ) {
                              event.currentTarget.value = String(line.quantity);
                              if (status.current)
                                status.current.textContent =
                                  "Choose a whole quantity from 1 to 20, or remove the item.";
                              return;
                            }
                            if (quantity !== line.quantity)
                              cart.change(
                                cart.lines.map((item) =>
                                  item.variantId === line.variantId
                                    ? { ...item, quantity }
                                    : item,
                                ),
                              );
                          }}
                        />
                        <button
                          className="commerce-remove-button"
                          type="button"
                          aria-label={`Remove ${label}`}
                          onClick={() => remove(line.variantId)}
                        >
                          Remove
                        </button>
                      </div>
                      {unavailable && (
                        <p id={`stock-${line.variantId}`} role="status">
                          {!variant || !variant.active
                            ? "This item is no longer available. Remove it to update your subtotal."
                            : "Not enough available stock. Reduce the quantity or remove this item."}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <aside className="commerce-summary" aria-label="Cart summary">
              <h2>Item summary</h2>
              <p>
                Subtotal (
                {cart.lines.reduce((sum, line) => sum + line.quantity, 0)}{" "}
                items)
              </p>
              <strong>
                {result
                  ? result.subtotalCents === null
                    ? "Unavailable — review missing items"
                    : formatCad(result.subtotalCents)
                  : "Awaiting current prices"}
              </strong>
              <p>
                Delivery and tax are not calculated yet. This is not a final
                quote. Items in your cart are not reserved.
              </p>
              <button
                className="commerce-secondary-button"
                type="button"
                disabled={fetcher.state !== "idle"}
                onClick={refresh}
              >
                Refresh prices and availability
              </button>
              <Link to="/shop">Continue shopping</Link>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <div className="container error-content">
      <h1>
        {isRouteErrorResponse(error) && error.status === 404
          ? "Page not found"
          : "Cart unavailable"}
      </h1>
      <p>
        This shopping preview is available only in the isolated local
        environment.
      </p>
      <Link to="/shop">Back to Shop</Link>
    </div>
  );
}
