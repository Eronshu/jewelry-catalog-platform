import { OrderError, releaseTestOrder } from "./orders.server";

// Internal batch primitive only. Callers must supply an isolated local D1;
// there is no HTTP endpoint, scheduler, environment bypass or customer capability.
export const MAX_EXPIRY_BATCH_SIZE = 25;
export type ExpiryCursor = { reserveUntil: number; orderId: string };
type ExpiryOptions = {
  now?: number;
  limit?: number;
  after?: ExpiryCursor;
  signal?: AbortSignal;
};
type Candidate = { id: string; owner: string; reserveUntil: number };
type Outcome = {
  orderId: string;
  // cancelled is observed state, not a count of transitions created by this run.
  outcome: "cancelled" | "skipped" | "failed";
};
export type ExpiryBatchResult = {
  outcomes: Outcome[];
  nextCursor: ExpiryCursor | null;
  stopped: boolean;
};

/** Each order remains its own atomic transaction. The cursor advances past
 * failed items so later due orders can make progress; retry failures in a new
 * sweep from the beginning, never treat a cursor as proof all orders expired.
 * After interruption, starting again without a cursor is safe: committed
 * cancellations are absent from candidates and transitions are idempotent.
 */
export async function expireTestOrderBatch(
  db: D1Database,
  options: ExpiryOptions = {},
): Promise<ExpiryBatchResult> {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new OrderError("invalid_request");
  const { now = Date.now(), limit = 10, after, signal } = options;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > 8_640_000_000_000_000 - 900000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_EXPIRY_BATCH_SIZE ||
    (after !== undefined &&
      (!after ||
        !Number.isSafeInteger(after.reserveUntil) ||
        after.reserveUntil < 0 ||
        after.reserveUntil > now ||
        typeof after.orderId !== "string" ||
        !/^order-[a-f0-9-]{36}$/.test(after.orderId)))
  )
    throw new OrderError("invalid_request");

  const result: ExpiryBatchResult = {
    outcomes: [],
    nextCursor: after
      ? { reserveUntil: after.reserveUntil, orderId: after.orderId }
      : null,
    stopped: false,
  };
  if (signal?.aborted) return { ...result, stopped: true };

  let candidates: Candidate[];
  try {
    const page = await db
      .prepare(
        `SELECT id, owner_hash AS owner, reserve_until AS reserveUntil
         FROM commerce_orders
         WHERE state = 'pending_payment' AND payment_state = 'not_started'
           AND fulfillment = 'none' AND reserve_until <= ?
           AND (reserve_until, id) > (?, ?)
         ORDER BY reserve_until, id LIMIT ?`,
      )
      .bind(now, after?.reserveUntil ?? -1, after?.orderId ?? "", limit + 1)
      .all<Candidate>();
    candidates = page.results;
  } catch {
    // Do not log/propagate database exceptions or order snapshots.
    throw new Error("Local reservation expiry scan unavailable");
  }

  for (const candidate of candidates.slice(0, limit)) {
    if (signal?.aborted) return { ...result, stopped: true };
    let outcome: Outcome["outcome"];
    try {
      await releaseTestOrder(db, candidate.owner, candidate.id, "expire", now);
      outcome = "cancelled";
    } catch {
      outcome = "failed";
      try {
        // Distinguish a legitimate race from a still-eligible failed release.
        const current = await db
          .prepare(
            `SELECT state, payment_state AS paymentState, fulfillment,
             reserve_until AS reserveUntil FROM commerce_orders
             WHERE id = ? AND owner_hash = ?`,
          )
          .bind(candidate.id, candidate.owner)
          .first<{
            state: string;
            paymentState: string;
            fulfillment: string;
            reserveUntil: number;
          }>();
        if (
          !current ||
          current.state !== "pending_payment" ||
          current.paymentState !== "not_started" ||
          current.fulfillment !== "none" ||
          current.reserveUntil > now
        )
          outcome = "skipped";
      } catch {
        // Keep this order visible as failed; no speculative release or retry.
      }
    }
    result.outcomes.push({ orderId: candidate.id, outcome });
    result.nextCursor = {
      reserveUntil: candidate.reserveUntil,
      orderId: candidate.id,
    };
  }
  if (candidates.length <= limit) result.nextCursor = null;
  return result;
}
