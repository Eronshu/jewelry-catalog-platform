import type { AdminPrincipal } from "../auth/admin-access.server";
import { commandHash } from "./inventory.server";

export class ReservationRecoveryError extends Error {
  constructor(
    public readonly code:
      "invalid_request" | "not_found" | "conflict" | "unavailable",
  ) {
    super("Local reservation recovery could not be confirmed");
  }
}
export type ReservationRecoveryInput = {
  requestId: string;
  reference: string;
  expectedVersion: number;
  confirmation: string;
  reason: "overdue_unpaid";
};
type Receipt = {
  reference: string;
  expectedVersion: number;
  recordedAt: number;
};
type Previous = {
  requestHash: string;
  reference: string | null;
  expectedVersion: number | null;
  recordedAt: number | null;
};
type Current = {
  state: string;
  paymentState: string;
  fulfillment: string;
  reserveUntil: number;
  version: number;
};
const referencePattern = /^order-[a-f0-9-]{36}$/;
const requestPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function validate(
  input: ReservationRecoveryInput,
  actor: AdminPrincipal,
  now: number,
) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 5 ||
    Object.keys(input).some(
      (key) =>
        ![
          "requestId",
          "reference",
          "expectedVersion",
          "confirmation",
          "reason",
        ].includes(key),
    ) ||
    typeof input.requestId !== "string" ||
    !requestPattern.test(input.requestId) ||
    typeof input.reference !== "string" ||
    !referencePattern.test(input.reference) ||
    input.confirmation !== input.reference ||
    input.reason !== "overdue_unpaid" ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    input.expectedVersion >= Number.MAX_SAFE_INTEGER ||
    !actor ||
    typeof actor.email !== "string" ||
    !actor.email ||
    actor.email.length > 320 ||
    typeof actor.sub !== "string" ||
    !actor.sub ||
    actor.sub.length > 512 ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > 8_640_000_000_000_000
  )
    throw new ReservationRecoveryError("invalid_request");
}
function receipt(previous: Previous | null, hash: string): Receipt | null {
  if (!previous) return null;
  if (
    previous.requestHash !== hash ||
    previous.reference === null ||
    previous.expectedVersion === null ||
    previous.recordedAt === null
  )
    throw new ReservationRecoveryError("conflict");
  return {
    reference: previous.reference,
    expectedVersion: previous.expectedVersion,
    recordedAt: previous.recordedAt,
  };
}
function eligible(order: Current, version: number, now: number) {
  return (
    order.state === "pending_payment" &&
    order.paymentState === "not_started" &&
    order.fulfillment === "none" &&
    order.version === version &&
    order.reserveUntil <= now
  );
}

// Internal primitive. The route must establish an approved-human principal,
// local isolated binding, same-origin POST and explicit confirmation first.
export async function recoverExpiredReservation(
  db: D1Database,
  actor: AdminPrincipal,
  input: ReservationRecoveryInput,
  now = Date.now(),
) {
  validate(input, actor, now);
  const actorHash = await commandHash({
    kind: "admin-recovery-actor-v1",
    email: actor.email,
    sub: actor.sub,
  });
  const hash = await commandHash({
    operation: "recover-expired-reservation-v1",
    actorHash,
    requestId: input.requestId,
    reference: input.reference,
    expectedVersion: input.expectedVersion,
    confirmation: input.confirmation,
    reason: input.reason,
  });
  const commandId = `recovery-${input.requestId}`;
  const previous = () =>
    db
      .prepare(
        `SELECT c.request_hash AS requestHash, r.order_id AS reference,
    r.expected_version AS expectedVersion, r.occurred_at AS recordedAt
    FROM commerce_commands c LEFT JOIN commerce_reservation_recoveries r ON r.command_id = c.id WHERE c.id = ?`,
      )
      .bind(commandId)
      .first<Previous>();
  const current = () =>
    db
      .prepare(
        `SELECT state, payment_state AS paymentState, fulfillment,
    reserve_until AS reserveUntil, version FROM commerce_orders WHERE id = ?`,
      )
      .bind(input.reference)
      .first<Current>();
  const result = (saved: Receipt, replayed: boolean) => ({
    testOnly: true as const,
    requestId: input.requestId,
    ...saved,
    resultingVersion: saved.expectedVersion + 1,
    replayed,
  });
  try {
    const saved = receipt(await previous(), hash);
    if (saved) return result(saved, true);
    const order = await current();
    if (!order) throw new ReservationRecoveryError("not_found");
    if (!eligible(order, input.expectedVersion, now))
      throw new ReservationRecoveryError("conflict");
    try {
      await db.batch([
        db
          .prepare(
            "INSERT INTO commerce_commands(id, request_hash, created_at) VALUES (?, ?, ?)",
          )
          .bind(commandId, hash, now),
        db
          .prepare(
            `INSERT INTO commerce_reservation_recoveries(command_id, order_id, actor_hash, expected_version, reason, occurred_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            commandId,
            input.reference,
            actorHash,
            input.expectedVersion,
            input.reason,
            now,
          ),
      ]);
    } catch {
      // Resolve an identical concurrent request or a lost response from durable audit.
      const committed = receipt(await previous(), hash);
      if (committed) return result(committed, true);
      const latest = await current();
      if (!latest) throw new ReservationRecoveryError("not_found");
      if (!eligible(latest, input.expectedVersion, now))
        throw new ReservationRecoveryError("conflict");
      throw new ReservationRecoveryError("unavailable");
    }
    return result(
      {
        reference: input.reference,
        expectedVersion: input.expectedVersion,
        recordedAt: now,
      },
      false,
    );
  } catch (error) {
    if (error instanceof ReservationRecoveryError) throw error;
    // A storage outage does not establish whether a previous request committed.
    throw new ReservationRecoveryError("unavailable");
  }
}
