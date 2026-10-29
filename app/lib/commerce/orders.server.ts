import { legacyLabSource } from "./legacy-lab-source.server";
import { commandHash, getCommerceVariantsByIds } from "./inventory.server";
import {
  buildTestQuote,
  QuoteError,
  type CartLine,
  type DeliveryMethod,
  type TestQuote,
} from "./quote";

export class OrderError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "quote_expired"
      | "quote_changed"
      | "order_conflict"
      | "invalid_request",
  ) {
    super(code);
  }
}
function validateOwner(owner: string, now: number) {
  if (
    !/^[a-f0-9]{64}$/.test(owner) ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > 8_640_000_000_000_000 - 900000
  )
    throw new OrderError("invalid_request");
}
export async function createTestQuote(
  db: D1Database,
  owner: string,
  lines: readonly CartLine[],
  delivery: DeliveryMethod,
  now = Date.now(),
) {
  validateOwner(owner, now);
  if (
    !Array.isArray(lines) ||
    lines.length < 1 ||
    lines.length > 20 ||
    lines.some(
      (line) =>
        !line ||
        typeof line.variantId !== "string" ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(line.variantId),
    )
  ) {
    throw new QuoteError("INVALID_CART");
  }
  const quote = buildTestQuote(
    lines,
    await getCommerceVariantsByIds(
      db,
      lines.map((line) => line.variantId),
    ),
    delivery,
    now,
  );
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO commerce_quotes(id, owner_hash, snapshot, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id, owner, JSON.stringify(quote), now, quote.expiresAt)
    .run();
  return { id, quote };
}
export interface TestOrder {
  id: string;
  state: "pending_payment" | "confirmed" | "cancelled" | "closed";
  fulfillment: "none" | "ready_to_pack" | "held" | "completed";
  paymentState:
    "not_started" | "processing" | "succeeded" | "unknown" | "failed";
  reserveUntil: number;
  version: number;
  quote: TestQuote;
}
export async function getTestOrder(
  db: D1Database,
  owner: string,
  orderId: string,
): Promise<TestOrder | null> {
  const order = await db
    .prepare(
      `SELECT id, state, fulfillment, payment_state AS paymentState,
    reserve_until AS reserveUntil, version, snapshot FROM commerce_orders WHERE ${legacyLabSource()} AND id = ? AND owner_hash = ?`,
    )
    .bind(orderId, owner)
    .first<Omit<TestOrder, "quote"> & { snapshot: string }>();
  if (!order) return null;
  const { snapshot, ...details } = order;
  return { ...details, quote: JSON.parse(snapshot) as TestQuote };
}
// Read-only recovery for the same test browser session; never searches other owners.
export async function listTestOrders(
  db: D1Database,
  owner: string,
): Promise<TestOrder[]> {
  validateOwner(owner, Date.now());
  const rows = await db
    .prepare(
      `SELECT id FROM commerce_orders WHERE ${legacyLabSource()} AND owner_hash = ? ORDER BY created_at DESC, id DESC LIMIT 20`,
    )
    .bind(owner)
    .all<{ id: string }>();
  const orders = await Promise.all(
    rows.results.map((row) => getTestOrder(db, owner, row.id)),
  );
  return orders.filter((order): order is TestOrder => order !== null);
}

export async function reserveTestOrder(
  db: D1Database,
  owner: string,
  quoteId: string,
  now = Date.now(),
): Promise<TestOrder> {
  validateOwner(owner, now);
  if (!/^[a-f0-9-]{36}$/.test(quoteId)) throw new OrderError("invalid_request");
  const orderId = `order-${quoteId}`;
  // Quote identity is the idempotency boundary; replay survives expiry and price changes.
  const previous = await getTestOrder(db, owner, orderId);
  if (previous) return previous;
  const record = await db
    .prepare(
      `SELECT snapshot, expires_at FROM commerce_quotes WHERE ${legacyLabSource()} AND id = ? AND owner_hash = ?`,
    )
    .bind(quoteId, owner)
    .first<{ snapshot: string; expires_at: number }>();
  if (!record) throw new OrderError("not_found");
  if (record.expires_at <= now) throw new OrderError("quote_expired");
  const quote = JSON.parse(record.snapshot) as TestQuote;
  const commandId = `reserve-${quoteId}`;
  const hash = await commandHash({
    operation: "reserve-order",
    quoteId,
    owner,
  });
  try {
    await db.batch([
      db
        .prepare(
          "INSERT INTO commerce_commands(id, request_hash, created_at) VALUES (?, ?, ?)",
        )
        .bind(commandId, hash, now),
      db
        .prepare(
          `INSERT INTO commerce_orders(id, quote_id, owner_hash, reserve_command_id, snapshot, created_at, reserve_until)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          orderId,
          quoteId,
          owner,
          commandId,
          record.snapshot,
          now,
          now + 15 * 60 * 1000,
        ),
      ...quote.lines.map((line, position) =>
        db
          .prepare(
            `INSERT INTO commerce_order_lines(order_id,position,variant_id,quantity,unit_price_cents,variant_version)
        VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            orderId,
            position,
            line.variantId,
            line.quantity,
            line.unitPriceCents,
            line.version,
          ),
      ),
    ]);
  } catch {
    const replay = await getTestOrder(db, owner, orderId);
    if (replay) return replay;
    throw new OrderError("quote_changed");
  }
  return (await getTestOrder(db, owner, orderId))!;
}

// Only not_started orders can be released here. Future unknown/processing payments
// require reconciliation; they must never enter this blind expiry/cancel path.
export async function releaseTestOrder(
  db: D1Database,
  owner: string,
  orderId: string,
  kind: "cancel" | "expire",
  now = Date.now(),
): Promise<TestOrder> {
  validateOwner(owner, now);
  if (kind !== "cancel" && kind !== "expire")
    throw new OrderError("invalid_request");
  const order = await getTestOrder(db, owner, orderId);
  if (!order) throw new OrderError("not_found");
  if (order.state === "cancelled") return order;
  if (
    order.state !== "pending_payment" ||
    order.paymentState !== "not_started" ||
    (kind === "expire" &&
      (now < order.reserveUntil || order.fulfillment !== "none"))
  )
    throw new OrderError("order_conflict");
  const commandId = `${kind}-${order.id}`;
  const hash = await commandHash({ kind, orderId, owner });
  try {
    await db.batch([
      db
        .prepare(
          "INSERT INTO commerce_commands(id, request_hash, created_at) VALUES (?, ?, ?)",
        )
        .bind(commandId, hash, now),
      db
        .prepare(
          "INSERT INTO commerce_order_transitions(command_id,order_id,kind,expected_version,occurred_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(commandId, orderId, kind, order.version, now),
    ]);
  } catch {
    const latest = await getTestOrder(db, owner, orderId);
    if (latest?.state === "cancelled") return latest;
    throw new OrderError("order_conflict");
  }
  return (await getTestOrder(db, owner, orderId))!;
}
