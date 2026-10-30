import { legacyLabSource } from "./legacy-lab-source.server";
/** Internal local fixture diagnostics. This context is not authentication. */
export type TestPaymentAttentionContext = {
  mode: "local-test";
  instanceId: string;
};
export type TestPaymentAttentionInput = { cursor: string | null };
export type TestPaymentAttentionReason =
  | "unprocessed_observations"
  | "capture_conflict"
  | "amount_mismatch"
  | "additional_captures"
  | "expired_without_capture";
export type TestPaymentAttentionItem = {
  reference: string;
  createdAt: number;
  reserveUntil: number;
  orderState: "pending_payment" | "confirmed" | "cancelled" | "closed";
  paymentState:
    "not_started" | "processing" | "succeeded" | "unknown" | "failed";
  fulfillmentState: "none" | "ready_to_pack" | "held" | "completed";
  version: number;
  captureFactCount: number;
  mismatchedFactCount: number;
  unprocessedObservationCount: number;
  captureConflictCount: number;
  mismatchedObservationCount: number;
  reasons: TestPaymentAttentionReason[];
};
export type TestPaymentAttentionPage = {
  testOnly: true;
  checkedAt: number;
  items: TestPaymentAttentionItem[];
  nextCursor: string | null;
};
export class PaymentAttentionError extends Error {
  constructor(public readonly code: "invalid_request" | "unavailable") {
    super("Local test payment attention could not be confirmed");
    this.name = "PaymentAttentionError";
  }
}
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fixture = /^fixture-[A-Za-z0-9_-]{1,92}$/;
const maxDate = 8_640_000_000_000_000;
const pageSize = 25;
type Position = { createdAt: number; orderId: string };
type Row = Omit<TestPaymentAttentionItem, "reasons">;
const rowKeys = [
  "reference",
  "createdAt",
  "reserveUntil",
  "orderState",
  "paymentState",
  "fulfillmentState",
  "version",
  "captureFactCount",
  "mismatchedFactCount",
  "unprocessedObservationCount",
  "captureConflictCount",
  "mismatchedObservationCount",
];
function shape(value: unknown, keys: string[]): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every(
      (key) =>
        Object.hasOwn(value, key) &&
        "value" in Object.getOwnPropertyDescriptor(value, key)!,
    )
  );
}
function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}
function date(value: unknown): value is number {
  return integer(value) && value <= maxDate;
}
function reference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("order-") &&
    uuid.test(value.slice(6))
  );
}
function encode(position: Position): string {
  return btoa(JSON.stringify(position))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function decode(cursor: string): Position {
  if (cursor.length > 192 || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw new PaymentAttentionError("invalid_request");
  try {
    const value: Position = JSON.parse(
      atob(cursor.replaceAll("-", "+").replaceAll("_", "/")),
    );
    if (
      !shape(value, ["createdAt", "orderId"]) ||
      !date(value.createdAt) ||
      !reference(value.orderId)
    )
      throw new Error();
    const position = { createdAt: value.createdAt, orderId: value.orderId };
    if (encode(position) !== cursor) throw new Error();
    return position;
  } catch {
    throw new PaymentAttentionError("invalid_request");
  }
}
function normalized(
  trusted: TestPaymentAttentionContext,
  input: TestPaymentAttentionInput,
  now: number,
) {
  if (!shape(trusted, ["mode", "instanceId"]) || !shape(input, ["cursor"]))
    throw new PaymentAttentionError("invalid_request");
  // Snapshot own data before the first await; accessors never run.
  const context = { mode: trusted.mode, instanceId: trusted.instanceId };
  const cursor = input.cursor;
  if (
    context.mode !== "local-test" ||
    typeof context.instanceId !== "string" ||
    !uuid.test(context.instanceId) ||
    (cursor !== null && typeof cursor !== "string") ||
    !date(now)
  )
    throw new PaymentAttentionError("invalid_request");
  return { context, position: cursor === null ? null : decode(cursor) };
}
function validRow(row: Row): boolean {
  return (
    shape(row, rowKeys) &&
    reference(row.reference) &&
    date(row.createdAt) &&
    date(row.reserveUntil) &&
    row.reserveUntil > row.createdAt &&
    ["pending_payment", "confirmed", "cancelled", "closed"].includes(
      row.orderState,
    ) &&
    ["not_started", "processing", "succeeded", "unknown", "failed"].includes(
      row.paymentState,
    ) &&
    ["none", "ready_to_pack", "held", "completed"].includes(
      row.fulfillmentState,
    ) &&
    integer(row.version, 1) &&
    integer(row.captureFactCount) &&
    integer(row.mismatchedFactCount) &&
    row.mismatchedFactCount <= row.captureFactCount &&
    integer(row.unprocessedObservationCount) &&
    integer(row.captureConflictCount) &&
    integer(row.mismatchedObservationCount)
  );
}
function reasons(row: Row, now: number): TestPaymentAttentionReason[] {
  const value: TestPaymentAttentionReason[] = [];
  if (row.unprocessedObservationCount > 0)
    value.push("unprocessed_observations");
  if (row.captureConflictCount > 0) value.push("capture_conflict");
  if (row.mismatchedFactCount > 0 || row.mismatchedObservationCount > 0)
    value.push("amount_mismatch");
  if (row.captureFactCount > 1) value.push("additional_captures");
  if (row.captureFactCount === 0 && row.reserveUntil <= now)
    value.push("expired_without_capture");
  return value;
}
/**
 * Current diagnostics across both fixture providers, one item per order with an
 * attempt. Expiry is not proof of nonpayment or permission to release/fulfill.
 * A cursor is a position, not a snapshot or access capability. Membership can
 * change between pages. SQL bounds returned rows, not the global aggregate scan.
 */
export async function listTestPaymentAttention(
  db: D1Database,
  trusted: TestPaymentAttentionContext,
  input: TestPaymentAttentionInput,
  now = Date.now(),
): Promise<TestPaymentAttentionPage> {
  const { context, position } = normalized(trusted, input, now);
  try {
    const scope = await db
      .prepare(
        "SELECT mode,instance_id,stripe_account_ref,paypal_account_ref FROM commerce_payment_scope WHERE id=1",
      )
      .first<{
        mode: string;
        instance_id: string;
        stripe_account_ref: string;
        paypal_account_ref: string;
      }>();
    if (
      !scope ||
      !shape(scope, [
        "mode",
        "instance_id",
        "stripe_account_ref",
        "paypal_account_ref",
      ]) ||
      scope.mode !== context.mode ||
      scope.instance_id !== context.instanceId ||
      typeof scope.stripe_account_ref !== "string" ||
      !fixture.test(scope.stripe_account_ref) ||
      typeof scope.paypal_account_ref !== "string" ||
      !fixture.test(scope.paypal_account_ref)
    )
      throw new PaymentAttentionError("unavailable");
    const result = await db
      .prepare(
        `WITH attempts AS (
          SELECT command_id,order_id,mode,instance_id,provider,account_ref,amount_cents,currency
          FROM commerce_payment_attempts
          WHERE mode=? AND instance_id=? AND
            ((provider='stripe' AND account_ref=?) OR (provider='paypal' AND account_ref=?))
        ), facts AS (
          SELECT a.order_id,count(*) AS captureFactCount,
            sum(CASE WHEN f.actual_amount_cents<>a.amount_cents OR f.actual_currency<>a.currency THEN 1 ELSE 0 END) AS mismatchedFactCount
          FROM attempts a JOIN commerce_payment_capture_facts f
            ON f.attempt_command_id=a.command_id AND f.mode=a.mode AND f.instance_id=a.instance_id
            AND f.provider=a.provider AND f.account_ref=a.account_ref
          GROUP BY a.order_id
        ), observations AS (
          SELECT a.order_id,
            sum(CASE WHEN r.observation_id IS NULL THEN 1 ELSE 0 END) AS unprocessedObservationCount,
            sum(CASE WHEN r.outcome='capture_conflict' THEN 1 ELSE 0 END) AS captureConflictCount,
            sum(CASE WHEN o.kind='captured' AND (o.amount_cents<>a.amount_cents OR o.currency<>a.currency) THEN 1 ELSE 0 END) AS mismatchedObservationCount
          FROM attempts a JOIN commerce_payment_observations o
            ON o.attempt_command_id=a.command_id AND o.mode=a.mode AND o.instance_id=a.instance_id
            AND o.provider=a.provider AND o.account_ref=a.account_ref
          LEFT JOIN commerce_payment_observation_results r
            ON r.observation_id=o.observation_id AND r.attempt_command_id=o.attempt_command_id
            AND r.mode=o.mode AND r.instance_id=o.instance_id AND r.provider=o.provider AND r.account_ref=o.account_ref
          GROUP BY a.order_id
        ), attention AS (
          SELECT o.id AS reference,o.created_at AS createdAt,o.reserve_until AS reserveUntil,
            o.state AS orderState,o.payment_state AS paymentState,o.fulfillment AS fulfillmentState,o.version,
            coalesce(f.captureFactCount,0) AS captureFactCount,
            coalesce(f.mismatchedFactCount,0) AS mismatchedFactCount,
            coalesce(b.unprocessedObservationCount,0) AS unprocessedObservationCount,
            coalesce(b.captureConflictCount,0) AS captureConflictCount,
            coalesce(b.mismatchedObservationCount,0) AS mismatchedObservationCount
          FROM commerce_orders o
          JOIN (SELECT DISTINCT order_id FROM attempts) a ON a.order_id=o.id
          LEFT JOIN facts f ON f.order_id=o.id LEFT JOIN observations b ON b.order_id=o.id
          WHERE ${legacyLabSource("order")}
        )
        SELECT * FROM attention
        WHERE (unprocessedObservationCount>0 OR captureConflictCount>0 OR mismatchedFactCount>0
          OR mismatchedObservationCount>0 OR captureFactCount>1 OR (captureFactCount=0 AND reserveUntil<=?))
          AND (? IS NULL OR createdAt>? OR (createdAt=? AND reference>?))
        ORDER BY createdAt,reference LIMIT 26`,
      )
      .bind(
        context.mode,
        context.instanceId,
        scope.stripe_account_ref,
        scope.paypal_account_ref,
        now,
        position?.createdAt ?? null,
        position?.createdAt ?? null,
        position?.createdAt ?? null,
        position?.orderId ?? null,
      )
      .all<Row>();
    if (
      !result.success ||
      !Array.isArray(result.results) ||
      result.results.length > pageSize + 1
    )
      throw new PaymentAttentionError("unavailable");
    let previous = position;
    const items = result.results.map((row) => {
      if (
        !validRow(row) ||
        (previous !== null &&
          (row.createdAt < previous.createdAt ||
            (row.createdAt === previous.createdAt &&
              row.reference <= previous.orderId)))
      )
        throw new PaymentAttentionError("unavailable");
      previous = { createdAt: row.createdAt, orderId: row.reference };
      const itemReasons = reasons(row, now);
      if (itemReasons.length === 0)
        throw new PaymentAttentionError("unavailable");
      return { ...row, reasons: itemReasons };
    });
    const hasMore = items.length > pageSize;
    items.length = Math.min(items.length, pageSize);
    const last = items.at(-1);
    return {
      testOnly: true,
      checkedAt: now,
      items,
      nextCursor:
        hasMore && last
          ? encode({ createdAt: last.createdAt, orderId: last.reference })
          : null,
    };
  } catch {
    // Never expose storage errors, SQL, private source data or migration details.
    throw new PaymentAttentionError("unavailable");
  }
}
