import { parseShoppingLines, type ShoppingVariant } from "./shopping-cart";

// Read-only. Public metadata only; hidden/draft products never enter a saved cart response.
export async function readShoppingVariants(
  db: D1Database,
  selection: { productId: number } | { ids: string[] },
): Promise<ShoppingVariant[]> {
  const byProduct = "productId" in selection;
  if (
    byProduct &&
    (!Number.isSafeInteger(selection.productId) || selection.productId < 1)
  )
    throw new Error("Invalid product");
  if (!byProduct)
    parseShoppingLines(
      selection.ids.map((variantId) => ({ variantId, quantity: 1 })),
    );
  if (!byProduct && selection.ids.length === 0) return [];
  const result = await db
    .prepare(
      `SELECT v.id, v.product_id AS productId, p.slug, p.name,
    v.colour, v.size_description AS sizeDescription, v.price_cents AS priceCents,
    CASE WHEN v.active = 1 AND p.status = 'available' THEN 1 ELSE 0 END AS active,
    i.on_hand - i.facebook_reserved - i.checkout_reserved - i.allocated AS available,
    (SELECT id FROM product_images WHERE product_id = p.id ORDER BY sort_order, id LIMIT 1) AS imageId,
    (SELECT alt_text FROM product_images WHERE product_id = p.id ORDER BY sort_order, id LIMIT 1) AS imageAlt
    FROM commerce_variants v JOIN products p ON p.id = v.product_id
    JOIN commerce_inventory i ON i.variant_id = v.id
    WHERE p.status IN ('available', 'sold') AND ${byProduct ? "v.product_id = ?" : `v.id IN (${selection.ids.map(() => "?").join(",")})`}
    ORDER BY v.id`,
    )
    .bind(...(byProduct ? [selection.productId] : selection.ids))
    .all<Omit<ShoppingVariant, "active"> & { active: number }>();
  return result.results.map((row) => ({ ...row, active: row.active === 1 }));
}

export async function resolveShoppingCart(db: D1Database, input: unknown) {
  const lines = parseShoppingLines(input);
  const variants = await readShoppingVariants(db, {
    ids: lines.map((line) => line.variantId),
  });
  const items = lines.map((line) => {
    const variant = variants.find((item) => item.id === line.variantId) ?? null;
    return {
      ...line,
      variant,
      lineTotalCents: variant ? variant.priceCents * line.quantity : null,
    };
  });
  return {
    testOnly: true as const,
    key: JSON.stringify(lines),
    items,
    subtotalCents: items.some((item) => item.lineTotalCents === null)
      ? null
      : items.reduce((sum, item) => sum + item.lineTotalCents!, 0),
  };
}
