import { releaseTestCheckoutOrder } from "./checkout-release.server";
import { OrderError } from "./orders.server";
import type { ExpiryBatchResult, ExpiryCursor } from "./order-expiry.server";
import type { TestCheckoutSessionConfig } from "./checkout-session.server";

/** Controlled task only. Owners come from persisted origins, never task input. */
export async function expireOwnedCheckoutBatch(
  db: D1Database,
  config: TestCheckoutSessionConfig,
  options: { after?: ExpiryCursor; now?: number; signal?: AbortSignal } = {},
): Promise<ExpiryBatchResult> {
  const { after, now = Date.now(), signal } = options;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    (after &&
      (!Number.isSafeInteger(after.reserveUntil) ||
        after.reserveUntil < 0 ||
        after.reserveUntil > now ||
        !/^order-[a-f0-9-]{36}$/.test(after.orderId)))
  )
    throw new OrderError("invalid_request");
  const result: ExpiryBatchResult = {
    outcomes: [],
    nextCursor: after ?? null,
    stopped: false,
  };
  if (signal?.aborted) return { ...result, stopped: true };
  const rows = (
    await db
      .prepare(
        `SELECT o.id,o.version,o.reserve_until AS reserveUntil,x.owner_hash AS owner
 FROM commerce_checkout_order_origins x JOIN commerce_orders o ON o.id=x.order_id
 WHERE x.mode=? AND x.instance_id=? AND o.owner_hash=x.owner_hash
 AND o.state='pending_payment' AND o.payment_state='not_started' AND o.fulfillment='none'
 AND NOT EXISTS(SELECT 1 FROM commerce_payment_attempts a WHERE a.order_id=o.id)
 AND o.reserve_until<=? AND (o.reserve_until,o.id)>(?,?) ORDER BY o.reserve_until,o.id LIMIT 11`,
      )
      .bind(
        config.mode,
        config.instanceId,
        now,
        after?.reserveUntil ?? -1,
        after?.orderId ?? "",
      )
      .all<{
        id: string;
        version: number;
        reserveUntil: number;
        owner: string;
      }>()
  ).results;
  for (const candidate of rows.slice(0, 10)) {
    if (signal?.aborted) return { ...result, stopped: true };
    let outcome: "cancelled" | "skipped" | "failed" = "cancelled";
    try {
      // Deterministic original key makes interrupted/restarted sweeps recover the
      // same release. Order UUID is server generated and already unique per order.
      await releaseTestCheckoutOrder(
        db,
        {
          mode: "local-test",
          instanceId: config.instanceId,
          ownerHash: candidate.owner,
        },
        {
          releaseKey: candidate.id.slice(6),
          orderId: candidate.id,
          kind: "expire",
          expectedVersion: candidate.version,
        },
        () => now,
      );
    } catch {
      outcome = "failed";
      const current = await db
        .prepare(
          `SELECT state,payment_state,fulfillment FROM commerce_orders WHERE id=?`,
        )
        .bind(candidate.id)
        .first<{ state: string; payment_state: string; fulfillment: string }>()
        .catch(() => null);
      if (
        current &&
        (current.state !== "pending_payment" ||
          current.payment_state !== "not_started" ||
          current.fulfillment !== "none")
      )
        outcome = "skipped";
    }
    result.outcomes.push({ orderId: candidate.id, outcome });
    result.nextCursor = {
      reserveUntil: candidate.reserveUntil,
      orderId: candidate.id,
    };
  }
  if (rows.length <= 10) result.nextCursor = null;
  return result;
}
