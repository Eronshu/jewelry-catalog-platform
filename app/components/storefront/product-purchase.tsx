import { useId, useState } from "react";
import { Link } from "react-router";
import { formatCad } from "../../lib/format-cad";
import type { ShoppingVariant } from "../../lib/commerce/shopping-cart";
import { useShoppingCart } from "./shopping-cart-context";

export function ProductPurchase({ variants }: { variants: ShoppingVariant[] }) {
  const cart = useShoppingCart();
  const prefix = useId();
  const [selected, setSelected] = useState("");
  const [message, setMessage] = useState("");
  const variant =
    variants.find((item) => item.id === selected) ??
    variants.find((item) => item.active && item.available > 0) ??
    variants[0];
  if (!variant)
    return <p>This product is not enabled for the local shopping preview.</p>;
  function add() {
    if (!variant || !variant.active) return;
    const existing = cart.lines.find((line) => line.variantId === variant.id);
    const quantity = (existing?.quantity ?? 0) + 1;
    if (quantity > variant.available) {
      setMessage("There is not enough available stock. Review your cart.");
      return;
    }
    if (quantity > 20 || (!existing && cart.lines.length >= 20)) {
      setMessage("This preview allows 20 variants and up to 20 of each.");
      return;
    }
    cart.change(
      existing
        ? cart.lines.map((line) =>
            line.variantId === variant.id ? { ...line, quantity } : line,
          )
        : [...cart.lines, { variantId: variant.id, quantity }],
    );
    setMessage(
      `Added ${variant.name} — ${variant.colour} to your cart. No stock is reserved.`,
    );
  }
  return (
    <section className="shopping-purchase" aria-label="Local product selection">
      <p className="product-detail-price">{formatCad(variant.priceCents)}</p>
      <label htmlFor={`${prefix}-colour`}>Colour</label>
      <select
        id={`${prefix}-colour`}
        value={variant.id}
        className="commerce-delivery"
        onChange={(event) => {
          setSelected(event.target.value);
          setMessage("");
        }}
      >
        {variants.map((item) => (
          <option key={item.id} value={item.id}>
            {item.colour}
            {!item.active || item.available < 1 ? " — unavailable" : ""}
          </option>
        ))}
      </select>
      <p>{variant.sizeDescription}</p>
      <p>
        {variant.active && variant.available > 0
          ? "Available for the local preview"
          : "Currently unavailable"}
      </p>
      <button
        className="commerce-primary-button"
        type="button"
        disabled={!cart.ready || !variant.active || variant.available < 1}
        onClick={add}
      >
        Add to cart
      </button>
      <Link className="shopping-view-cart" to="/cart">
        View cart
      </Link>
      <p role="status">{message}</p>
    </section>
  );
}
