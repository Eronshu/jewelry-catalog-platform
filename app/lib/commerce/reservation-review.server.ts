// Internal read model: callers must establish trusted Admin + isolated local DB.
// Never select owner_hash, snapshot, customer fields or provider credentials.
export type ReviewCursor = { reserveUntil: number; orderId: string };
type Header = {
  id: string;
  state: string;
  paymentState: string;
  fulfillment: string;
  reserveUntil: number;
  version: number;
};
export class ReservationReviewError extends Error {
  constructor(public readonly code: "invalid_request" | "unavailable") {
    super("Local reservation review unavailable");
  }
}
const referencePattern = /^order-[a-f0-9-]{36}$/;
const columns = `id, state, payment_state AS paymentState, fulfillment,
  reserve_until AS reserveUntil, version`;
function reference(value: unknown): value is string {
  return typeof value === "string" && referencePattern.test(value);
}
function clock(now: number) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000)
    throw new ReservationReviewError("invalid_request");
}
function attention(order: Header, now: number) {
  const reasons: string[] = [];
  if (order.fulfillment === "held") reasons.push("fulfillment_held");
  if (order.state === "pending_payment") {
    if (order.paymentState !== "not_started") reasons.push("payment_review");
    else if (order.reserveUntil <= now) reasons.push("overdue_unpaid");
  }
  return { ...order, reasons };
}

export async function listReservationReview(
  db: D1Database,
  { now = Date.now(), after }: { now?: number; after?: ReviewCursor } = {},
) {
  clock(now);
  if (
    after !== undefined &&
    (!after ||
      typeof after !== "object" ||
      Array.isArray(after) ||
      !Number.isSafeInteger(after.reserveUntil) ||
      after.reserveUntil < 0 ||
      after.reserveUntil > 8_640_000_000_000_000 ||
      !reference(after.orderId) ||
      Object.keys(after).some(
        (key) => key !== "reserveUntil" && key !== "orderId",
      ))
  )
    throw new ReservationReviewError("invalid_request");
  try {
    const rows = await db
      .prepare(
        `SELECT ${columns} FROM commerce_orders
       WHERE (state = 'pending_payment' OR fulfillment = 'held')
       AND (fulfillment = 'held' OR payment_state != 'not_started' OR reserve_until <= ?)
       AND (reserve_until, id) > (?, ?)
       ORDER BY reserve_until, id LIMIT 26`,
      )
      .bind(now, after?.reserveUntil ?? -1, after?.orderId ?? "")
      .all<Header>();
    const items = rows.results
      .slice(0, 25)
      .map((order) => attention(order, now));
    const last = items.at(-1);
    return {
      testOnly: true as const,
      observedAt: now,
      items,
      nextCursor:
        rows.results.length > 25 && last
          ? { reserveUntil: last.reserveUntil, orderId: last.id }
          : null,
    };
  } catch {
    throw new ReservationReviewError("unavailable");
  }
}

export async function inspectReservation(
  db: D1Database,
  orderId: string,
  now = Date.now(),
) {
  clock(now);
  if (!reference(orderId)) throw new ReservationReviewError("invalid_request");
  try {
    // Bound related reads in one batch; do not fetch the quote snapshot.
    const [orders, lines, history] = await db.batch([
      db
        .prepare(`SELECT ${columns} FROM commerce_orders WHERE id = ?`)
        .bind(orderId),
      db
        .prepare(
          `SELECT position, variant_id AS variantId, quantity
        FROM commerce_order_lines WHERE order_id = ? ORDER BY position LIMIT 21`,
        )
        .bind(orderId),
      db
        .prepare(
          `SELECT kind, occurred_at AS occurredAt, expected_version AS expectedVersion
        FROM commerce_order_transitions WHERE order_id = ?
        ORDER BY occurred_at DESC, command_id DESC LIMIT 26`,
        )
        .bind(orderId),
    ]);
    const order = orders.results[0] as Header | undefined;
    if (!order) return null;
    if (lines.results.length > 20) throw new Error();
    return {
      testOnly: true as const,
      observedAt: now,
      order: attention(order, now),
      lines: lines.results as Array<{
        position: number;
        variantId: string;
        quantity: number;
      }>,
      history: history.results.slice(0, 25) as Array<{
        kind: string;
        occurredAt: number;
        expectedVersion: number;
      }>,
      historyTruncated: history.results.length > 25,
    };
  } catch {
    throw new ReservationReviewError("unavailable");
  }
}
