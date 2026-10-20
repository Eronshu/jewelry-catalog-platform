const kinds = [
  "receive",
  "fb_reserve",
  "fb_release",
  "fb_sale",
  "reserve",
  "release",
  "allocate",
  "fulfill",
  "return",
] as const;
export type StockKind = (typeof kinds)[number];
export interface StockChange {
  variantId: string;
  kind: StockKind;
  quantity: number;
  reason: string;
  expectedVersion?: number;
}
export class InventoryError extends Error {
  constructor(
    public readonly code:
      "invalid_command" | "command_conflict" | "stock_conflict",
  ) {
    super(code);
  }
}
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
}
export async function commandHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function normalizeStockChanges(
  changes: readonly StockChange[],
): StockChange[] {
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 20)
    throw new InventoryError("invalid_command");
  return changes.map((change) => {
    if (
      !change ||
      !validId(change.variantId) ||
      !kinds.includes(change.kind) ||
      !Number.isSafeInteger(change.quantity) ||
      change.quantity < 1 ||
      change.quantity > 1000000 ||
      typeof change.reason !== "string" ||
      !change.reason.trim() ||
      change.reason.length > 200 ||
      (change.expectedVersion !== undefined &&
        (!Number.isSafeInteger(change.expectedVersion) ||
          change.expectedVersion < 1)) ||
      (change.kind === "reserve" && change.expectedVersion === undefined)
    )
      throw new InventoryError("invalid_command");
    return {
      variantId: change.variantId,
      kind: change.kind,
      quantity: change.quantity,
      reason: change.reason.trim(),
      ...(change.expectedVersion !== undefined
        ? { expectedVersion: change.expectedVersion }
        : {}),
    };
  });
}
export function stockStatements(
  db: D1Database,
  commandId: string,
  changes: readonly StockChange[],
): D1PreparedStatement[] {
  return changes.map((change, position) =>
    db
      .prepare(
        `INSERT INTO commerce_stock_movements
    (command_id, position, variant_id, kind, quantity, expected_variant_version, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        commandId,
        position,
        change.variantId,
        change.kind,
        change.quantity,
        change.expectedVersion ?? null,
        change.reason,
      ),
  );
}

// Internal command API only. Routes must authorize their operation; clients must
// never choose arbitrary stock kinds. SQL constraints make every batch all-or-none.
export async function applyStockCommand(
  db: D1Database,
  commandId: string,
  input: readonly StockChange[],
  now = Date.now(),
): Promise<{ replayed: boolean }> {
  if (!validId(commandId) || !Number.isSafeInteger(now) || now < 0)
    throw new InventoryError("invalid_command");
  const changes = normalizeStockChanges(input);
  const hash = await commandHash(changes);
  const previous = await db
    .prepare("SELECT request_hash FROM commerce_commands WHERE id = ?")
    .bind(commandId)
    .first<{ request_hash: string }>();
  if (previous) {
    if (previous.request_hash !== hash)
      throw new InventoryError("command_conflict");
    return { replayed: true };
  }
  try {
    await db.batch([
      db
        .prepare(
          "INSERT INTO commerce_commands(id, request_hash, created_at) VALUES (?, ?, ?)",
        )
        .bind(commandId, hash, now),
      ...stockStatements(db, commandId, changes),
    ]);
    return { replayed: false };
  } catch {
    // A concurrent identical command may have committed while we were awaiting.
    const committed = await db
      .prepare("SELECT request_hash FROM commerce_commands WHERE id = ?")
      .bind(commandId)
      .first<{ request_hash: string }>();
    if (committed) {
      if (committed.request_hash !== hash)
        throw new InventoryError("command_conflict");
      return { replayed: true };
    }
    throw new InventoryError("stock_conflict");
  }
}

async function readVariants(db: D1Database, ids?: readonly string[]) {
  const where = ids
    ? `v.id IN (${ids.map(() => "?").join(",")})`
    : "p.status = 'available' AND v.active = 1";
  const result = await db
    .prepare(
      `SELECT v.id, v.sku, p.name, v.colour,
    v.size_description AS sizeDescription, v.price_cents AS priceCents, v.version,
    CASE WHEN v.active = 1 AND p.status = 'available' THEN 1 ELSE 0 END AS active,
    i.on_hand - i.facebook_reserved - i.checkout_reserved - i.allocated AS available
    FROM commerce_variants v JOIN products p ON p.id = v.product_id
    JOIN commerce_inventory i ON i.variant_id = v.id
    WHERE ${where} ORDER BY v.id ${ids ? "" : "LIMIT 200"}`,
    )
    .bind(...(ids ?? []))
    .all<{
      id: string;
      sku: string;
      name: string;
      colour: string;
      sizeDescription: string;
      priceCents: number;
      version: number;
      active: number;
      available: number;
    }>();
  return result.results.map((variant) => ({
    ...variant,
    active: variant.active === 1,
  }));
}

export async function listCommerceVariants(db: D1Database) {
  return readVariants(db);
}

// Quotes resolve exact requested IDs; the display page limit is not a sales limit.
export async function getCommerceVariantsByIds(
  db: D1Database,
  ids: readonly string[],
) {
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > 20 ||
    ids.some((id) => !validId(id))
  ) {
    throw new InventoryError("invalid_command");
  }
  return readVariants(db, [...new Set(ids)]);
}
