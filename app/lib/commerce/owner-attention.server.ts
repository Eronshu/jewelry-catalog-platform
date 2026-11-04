import type {
  AttentionFilter,
  AttentionItem,
  AttentionQuery,
  AttentionScope,
  AttentionView,
} from "./owner-attention";

export class OwnerAttentionError extends Error {
  constructor(
    public readonly code: "invalid_request" | "conflict" | "unavailable",
  ) {
    super("The fictional operating review could not be read");
    this.name = "OwnerAttentionError";
  }
}
function fail(code: OwnerAttentionError["code"]): never {
  throw new OwnerAttentionError(code);
}
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const orderPattern = new RegExp(`^order-${uuid.source.slice(1, -1)}$`);
const filters: AttentionFilter[] = [
  "all",
  "payment",
  "refund",
  "notifications",
];
const maxTime = 8639999913600000;
function fields(raw: unknown, keys: string[]): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    fail("invalid_request");
  const ds = Object.getOwnPropertyDescriptors(raw);
  if (
    Reflect.ownKeys(ds).length !== keys.length ||
    Reflect.ownKeys(ds).some((k) => typeof k !== "string" || !keys.includes(k))
  )
    fail("invalid_request");
  return Object.fromEntries(
    keys.map((k) => {
      const d = ds[k];
      if (!d || !("value" in d)) fail("invalid_request");
      return [k, d.value];
    }),
  );
}
function scope(raw: unknown): AttentionScope {
  const s = fields(raw, ["mode", "instanceId", "canonicalOrigin"]);
  if (
    s.mode !== "local-test" ||
    typeof s.instanceId !== "string" ||
    !uuid.test(s.instanceId) ||
    typeof s.canonicalOrigin !== "string" ||
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(s.canonicalOrigin)
  )
    fail("invalid_request");
  try {
    if (new URL(s.canonicalOrigin).origin !== s.canonicalOrigin)
      fail("invalid_request");
  } catch {
    fail("invalid_request");
  }
  return {
    mode: "local-test",
    instanceId: s.instanceId,
    canonicalOrigin: s.canonicalOrigin,
  };
}
function query(raw: unknown): AttentionQuery {
  const q = fields(raw, ["filter", "reference", "after"]);
  if (
    !filters.includes(q.filter as AttentionFilter) ||
    typeof q.reference !== "string" ||
    (q.reference !== "" && !orderPattern.test(q.reference)) ||
    (q.after !== null && (typeof q.after !== "string" || q.after.length > 2048))
  )
    fail("invalid_request");
  return q as AttentionQuery;
}
function validTime(n: unknown): n is number {
  return (
    Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= maxTime
  );
}
function time(clock: () => number) {
  try {
    if (typeof clock !== "function") fail("invalid_request");
    const n = clock();
    if (!validTime(n)) fail("invalid_request");
    return n;
  } catch {
    fail("invalid_request");
  }
}
function encode(values: unknown[]): string {
  return btoa(JSON.stringify(values))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function cursor(
  s: AttentionScope,
  q: AttentionQuery,
): { at: number; id: string } | null {
  if (q.after === null) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(q.after)) fail("invalid_request");
  try {
    const v: unknown = JSON.parse(
      atob(q.after.replaceAll("-", "+").replaceAll("_", "/")),
    );
    if (
      !Array.isArray(v) ||
      v.length !== 8 ||
      encode(v) !== q.after ||
      v[0] !== 1 ||
      v[1] !== s.mode ||
      v[2] !== s.instanceId ||
      v[3] !== s.canonicalOrigin ||
      v[4] !== q.filter ||
      v[5] !== q.reference ||
      !validTime(v[6]) ||
      typeof v[7] !== "string" ||
      !orderPattern.test(v[7]) ||
      (q.reference !== "" && v[7] !== q.reference)
    )
      fail("invalid_request");
    return { at: v[6], id: v[7] };
  } catch {
    fail("invalid_request");
  }
}

// All projections share a single SQLite read snapshot. The existing notification
// witness excludes lab/foreign/malformed checkout origins. An attempt without an
// association has no persisted origin yet: it belongs to this instance's review.
// Once associated, its actual canonical origin must match even for pending work.
const reviewSQL = `WITH
 cfg AS (SELECT ? AS mode,? AS instance,? AS origin,? AS reference),
 associations AS (
 SELECT attempt_command_id,canonical_origin,'stripe' AS provider FROM commerce_owned_stripe_associations
 UNION ALL SELECT attempt_command_id,canonical_origin,'paypal' AS provider FROM commerce_owned_paypal_associations),
 owned AS (
 SELECT n.order_id,o.created_at,n.total_cents,n.payment_state,n.fulfillment,a.command_id AS attempt_id,
 EXISTS(SELECT 1 FROM commerce_owner_return_orders p WHERE p.order_id=n.order_id AND p.mode=cfg.mode AND p.instance_id=cfg.instance AND p.canonical_origin=cfg.origin) AS paid
 FROM cfg JOIN commerce_notification_orders n ON n.mode=cfg.mode AND n.instance_id=cfg.instance
 JOIN commerce_orders o ON o.id=n.order_id
 JOIN commerce_checkout_order_origins x ON x.order_id=o.id AND x.mode=n.mode AND x.instance_id=n.instance_id
 JOIN commerce_payment_scope ps ON ps.id=1 AND ps.mode=n.mode AND ps.instance_id=n.instance_id
 LEFT JOIN commerce_payment_attempts a ON a.order_id=o.id AND a.mode=x.mode AND a.instance_id=x.instance_id
 AND a.owner_hash=x.owner_hash AND a.quote_id=o.quote_id AND a.rules_version='fictional-checkout-acceptance-v1'
 AND a.currency='CAD' AND a.amount_cents=n.total_cents AND a.occurred_at>=o.created_at AND a.occurred_at<o.reserve_until
 AND a.account_ref=CASE a.provider WHEN 'stripe' THEN ps.stripe_account_ref WHEN 'paypal' THEN ps.paypal_account_ref END
 AND EXISTS(SELECT 1 FROM commerce_commands c WHERE c.id=a.command_id AND c.created_at=a.occurred_at)
 WHERE (cfg.reference='' OR n.order_id=cfg.reference)
 AND json_type(o.snapshot,'$.totalCents')='integer' AND n.total_cents BETWEEN 1 AND 9007199254740991
 AND NOT EXISTS(SELECT 1 FROM commerce_payment_attempts bad JOIN associations b ON b.attempt_command_id=bad.command_id
 WHERE bad.order_id=o.id AND (b.canonical_origin!=cfg.origin OR b.provider!=bad.provider))
 AND NOT EXISTS(SELECT 1 FROM commerce_notification_commands c WHERE c.order_id=o.id AND c.mode=cfg.mode AND c.instance_id=cfg.instance AND c.canonical_origin!=cfg.origin)),
 canonical AS (
 SELECT DISTINCT s.order_id,s.mode,s.instance_id,s.kind,s.source_id FROM commerce_notification_sources s,cfg
 WHERE s.mode=cfg.mode AND s.instance_id=cfg.instance AND s.canonical_origin=cfg.origin),
 active AS (
 SELECT i.order_id,i.id,
 (SELECT COUNT(*) FROM commerce_notification_attempts a WHERE a.notification_id=i.id) AS attempts,
 (SELECT a.outcome FROM commerce_notification_attempts a WHERE a.notification_id=i.id ORDER BY a.rowid DESC LIMIT 1) AS latest
 FROM commerce_notification_intents i JOIN commerce_notification_commands c ON c.request_id=i.prepare_request_id
 JOIN canonical s ON s.order_id=i.order_id AND s.mode=i.mode AND s.instance_id=i.instance_id AND s.kind=i.kind AND s.source_id=i.source_id,cfg
 WHERE i.mode=cfg.mode AND i.instance_id=cfg.instance AND c.canonical_origin=cfg.origin
 AND c.operation='prepare' AND c.order_id=i.order_id AND c.mode=i.mode AND c.instance_id=i.instance_id
 AND NOT EXISTS(SELECT 1 FROM commerce_notification_revocations r WHERE r.notification_id=i.id)
 AND NOT EXISTS(SELECT 1 FROM commerce_notification_attempts a WHERE a.notification_id=i.id AND a.outcome='test_delivered')),
 flags AS (
 SELECT o.*,CASE WHEN o.attempt_id IS NOT NULL AND (o.paid=0 OR EXISTS(
 SELECT 1 FROM commerce_owned_paypal_events e JOIN commerce_owned_paypal_orders z ON z.attempt_command_id=e.attempt_command_id AND z.provider_order_id=e.provider_order_id
 WHERE e.attempt_command_id=o.attempt_id AND e.event_type IN ('PAYMENT.CAPTURE.REFUNDED','PAYMENT.CAPTURE.REVERSED','PAYMENT.CAPTURE.DENIED','PAYMENT.CAPTURE.DECLINED'))) THEN 1 ELSE 0 END AS payment_review,
 EXISTS(SELECT 1 FROM commerce_owner_return_orders p JOIN commerce_owner_refund_intents r
 ON r.order_id=p.order_id AND r.capture_id=p.capture_id AND r.mode=p.mode AND r.instance_id=p.instance_id
 AND r.provider=p.provider AND r.account_ref=p.account_ref AND r.canonical_origin=p.canonical_origin
 AND r.transaction_ref=p.transaction_ref AND r.payment_intent_ref IS p.payment_intent_ref AND r.provider_object_ref=p.provider_object_ref
 AND r.payment_request_id=p.payment_request_id AND r.create_operation_key=p.create_operation_key AND r.amount_cents=p.amount_cents,cfg
 WHERE p.order_id=o.order_id AND p.mode=cfg.mode AND p.instance_id=cfg.instance AND p.canonical_origin=cfg.origin
 AND NOT EXISTS(SELECT 1 FROM commerce_owner_refund_confirmed c WHERE c.request_id=r.request_id)) AS refund_review,
 (SELECT COUNT(*) FROM active a WHERE a.order_id=o.order_id AND a.attempts=0) AS notification_pending,
 (SELECT COUNT(*) FROM active a WHERE a.order_id=o.order_id AND a.latest='test_failed') AS notification_failed,
 (SELECT COUNT(*) FROM active a WHERE a.order_id=o.order_id AND a.latest='test_failed' AND a.attempts>=3) AS notification_exhausted,
 (SELECT COUNT(*) FROM canonical s WHERE s.order_id=o.order_id AND NOT EXISTS(
 SELECT 1 FROM commerce_notification_intents i WHERE i.order_id=s.order_id AND i.mode=s.mode AND i.instance_id=s.instance_id AND i.kind=s.kind AND i.source_id=s.source_id)) AS notification_missing
 FROM owned o),
 attention AS (SELECT *,CASE WHEN notification_pending+notification_failed+notification_missing>0 THEN 1 ELSE 0 END AS notification_review FROM flags),
 flagged AS (SELECT * FROM attention WHERE payment_review+refund_review+notification_review>0),
 summary AS (SELECT COUNT(*) AS order_count,COALESCE(SUM(payment_review),0) AS payment_count,COALESCE(SUM(refund_review),0) AS refund_count,COALESCE(SUM(notification_review),0) AS notification_count FROM flagged),
 page AS (SELECT * FROM flagged WHERE (?='all' OR (?='payment' AND payment_review=1) OR (?='refund' AND refund_review=1) OR (?='notifications' AND notification_review=1))
 AND (? IS NULL OR created_at<? OR (created_at=? AND order_id<?)) ORDER BY created_at DESC,order_id DESC LIMIT 26)
 SELECT summary.*,page.order_id,page.created_at,page.total_cents,page.payment_state,page.fulfillment,page.payment_review,page.refund_review,
 page.notification_pending,page.notification_failed,page.notification_missing,page.notification_exhausted FROM summary LEFT JOIN page ON 1=1 ORDER BY page.created_at DESC,page.order_id DESC`;
type Row = {
  order_count: number;
  payment_count: number;
  refund_count: number;
  notification_count: number;
  order_id: string | null;
  created_at: number;
  total_cents: number;
  payment_state: string;
  fulfillment: string;
  payment_review: number;
  refund_review: number;
  notification_pending: number;
  notification_failed: number;
  notification_missing: number;
  notification_exhausted: number;
};
export async function readOwnerAttention(
  db: D1Database,
  rawScope: AttentionScope,
  rawQuery: AttentionQuery,
  clock: () => number = Date.now,
): Promise<AttentionView> {
  const s = scope(rawScope),
    q = query(rawQuery),
    after = cursor(s, q),
    observedAt = time(clock);
  try {
    if (
      !(await db
        .prepare(
          "SELECT 1 FROM commerce_payment_scope WHERE id=1 AND mode=? AND instance_id=?",
        )
        .bind(s.mode, s.instanceId)
        .first())
    )
      fail("conflict");
    const result = await db
      .prepare(reviewSQL)
      .bind(
        s.mode,
        s.instanceId,
        s.canonicalOrigin,
        q.reference,
        q.filter,
        q.filter,
        q.filter,
        q.filter,
        after?.at ?? null,
        after?.at ?? null,
        after?.at ?? null,
        after?.id ?? null,
      )
      .all<Row>();
    if (!result.success || !result.results.length) fail("unavailable");
    const rows = result.results.filter(
      (r): r is Row & { order_id: string } => r.order_id !== null,
    );
    const items: AttentionItem[] = rows.slice(0, 25).map((r) => ({
      orderId: r.order_id,
      createdAt: r.created_at,
      totalCents: r.total_cents,
      paymentState: r.payment_state,
      fulfillment: r.fulfillment,
      paymentReview: r.payment_review === 1,
      refundReview: r.refund_review === 1,
      notificationPending: r.notification_pending,
      notificationFailed: r.notification_failed,
      notificationMissing: r.notification_missing,
      notificationExhausted: r.notification_exhausted,
    }));
    const last = items.at(-1),
      totals = result.results[0];
    return {
      observedAt,
      filter: q.filter,
      reference: q.reference,
      nextCursor:
        rows.length > 25 && last
          ? encode([
              1,
              s.mode,
              s.instanceId,
              s.canonicalOrigin,
              q.filter,
              q.reference,
              last.createdAt,
              last.orderId,
            ])
          : null,
      summary: {
        orderCount: totals.order_count,
        paymentCount: totals.payment_count,
        refundCount: totals.refund_count,
        notificationCount: totals.notification_count,
      },
      items,
    };
  } catch (e) {
    if (e instanceof OwnerAttentionError) throw e;
    fail("unavailable");
  }
}
