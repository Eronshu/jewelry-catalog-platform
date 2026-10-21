import type { CartLine } from "./quote";

export const SHOPPING_CART_KEY = "velaform-shopping-preview-cart-v1";
export type ShoppingVariant = {
  id: string;
  productId: number;
  slug: string;
  name: string;
  colour: string;
  sizeDescription: string;
  priceCents: number;
  available: number;
  active: boolean;
  imageId: number | null;
  imageAlt: string | null;
};
export function parseShoppingLines(value: unknown): CartLine[] {
  if (!Array.isArray(value) || value.length > 20)
    throw new Error("Invalid cart");
  const seen = new Set<string>();
  return value.map((line) => {
    if (
      !line ||
      typeof line !== "object" ||
      typeof line.variantId !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(line.variantId) ||
      seen.has(line.variantId) ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > 20
    )
      throw new Error("Invalid cart");
    seen.add(line.variantId);
    // Never retain prices, customer details or other injected fields.
    return { variantId: line.variantId, quantity: line.quantity };
  });
}
