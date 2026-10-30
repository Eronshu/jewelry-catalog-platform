import { commandHash } from "./inventory.server";
import type { TestCheckoutContext } from "./checkout-acceptance.server";

export class CheckoutReleaseError extends Error {
  constructor(
    public readonly code: "invalid_request" | "conflict" | "unavailable",
  ) {
    super("The local test checkout release could not be confirmed.");
    this.name = "CheckoutReleaseError";
  }
}
export type TestCheckoutReleaseReceipt = {
  testOnly: true;
  releaseId: string;
  orderId: string;
  kind: "cancel" | "expire";
  resultingVersion: number;
  occurredAt: number;
};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function invalid(): never {
  throw new CheckoutReleaseError("invalid_request");
}
function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length
  )
    invalid();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) invalid();
    copy[key] = descriptor.value;
  }
  return copy;
}
function key(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) invalid();
  return value;
}
function copyContext(value: unknown): TestCheckoutContext {
  const data = record(value, ["mode", "instanceId", "ownerHash"]);
  if (
    data.mode !== "local-test" ||
    typeof data.ownerHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.ownerHash)
  )
    invalid();
  return {
    mode: "local-test",
    instanceId: key(data.instanceId),
    ownerHash: data.ownerHash,
  };
}
type Release = {
  release_id: string;
  command_id: string;
  mode: string;
  instance_id: string;
  owner_hash: string;
  release_key: string;
  request_hash: string;
  order_id: string;
  kind: "cancel" | "expire";
  expected_version: number;
  resulting_version: number;
  occurred_at: number;
};
function receipt(row: Release): TestCheckoutReleaseReceipt {
  return {
    testOnly: true,
    releaseId: row.release_id,
    orderId: row.order_id,
    kind: row.kind,
    resultingVersion: row.resulting_version,
    occurredAt: row.occurred_at,
  };
}
function classify(error: unknown): CheckoutReleaseError {
  if (error instanceof CheckoutReleaseError) return error;
  if (
    error instanceof Error &&
    /commerce_checkout_release_conflict/.test(error.message)
  )
    return new CheckoutReleaseError("conflict");
  return new CheckoutReleaseError("unavailable");
}
async function release(
  db: D1Database,
  trusted: TestCheckoutContext,
  raw: unknown,
  clock: () => number,
): Promise<TestCheckoutReleaseReceipt> {
  // All caller data is copied before the first asynchronous operation.
  const context = copyContext(trusted);
  const input = record(raw, [
    "releaseKey",
    "orderId",
    "kind",
    "expectedVersion",
  ]);
  const releaseKey = key(input.releaseKey);
  if (typeof input.orderId !== "string" || !input.orderId.startsWith("order-"))
    invalid();
  const orderId = `order-${key(input.orderId.slice(6))}`;
  const kind = input.kind;
  if (kind !== "cancel" && kind !== "expire") invalid();
  const expectedVersion = input.expectedVersion;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1 ||
    expectedVersion >= Number.MAX_SAFE_INTEGER ||
    typeof clock !== "function"
  )
    invalid();
  const requestHash = await commandHash({
    operation: "release-test-checkout-order-v1",
    context,
    orderId,
    kind,
    expectedVersion,
  });
  const find = async (candidateId: string | null = null) => {
    const rows = await db
      .prepare(
        `SELECT * FROM commerce_checkout_order_releases WHERE release_id=? OR order_id=? OR (mode=? AND instance_id=? AND owner_hash=? AND release_key=?)`,
      )
      .bind(
        candidateId,
        orderId,
        context.mode,
        context.instanceId,
        context.ownerHash,
        releaseKey,
      )
      .all<Release>();
    if (!rows.results.length) return null;
    const row = rows.results[0];
    if (
      rows.results.length !== 1 ||
      row.mode !== context.mode ||
      row.instance_id !== context.instanceId ||
      row.owner_hash !== context.ownerHash ||
      row.release_key !== releaseKey ||
      row.order_id !== orderId ||
      row.kind !== kind ||
      row.expected_version !== expectedVersion ||
      row.request_hash !== requestHash
    )
      throw new CheckoutReleaseError("conflict");
    return receipt(row);
  };
  let releaseId: string | null = null;
  try {
    const previous = await find();
    if (previous) return previous;
    const order = await db
      .prepare(
        `SELECT o.created_at,o.reserve_until,o.version,o.state,o.payment_state,o.fulfillment,
      EXISTS(SELECT 1 FROM commerce_payment_attempts a WHERE a.order_id=o.id) AS attempted
      FROM commerce_checkout_order_origins x JOIN commerce_orders o ON o.id=x.order_id
      WHERE x.order_id=? AND x.mode=? AND x.instance_id=? AND x.owner_hash=? AND o.owner_hash=x.owner_hash`,
      )
      .bind(orderId, context.mode, context.instanceId, context.ownerHash)
      .first<{
        created_at: number;
        reserve_until: number;
        version: number;
        state: string;
        payment_state: string;
        fulfillment: string;
        attempted: number;
      }>();
    if (
      !order ||
      order.version !== expectedVersion ||
      order.state !== "pending_payment" ||
      order.payment_state !== "not_started" ||
      order.fulfillment !== "none" ||
      order.attempted !== 0
    )
      throw new CheckoutReleaseError("conflict");
    releaseId = crypto.randomUUID();
    const commandId = `checkout-release-${releaseId}`;
    const statement = db.prepare(
      `INSERT INTO commerce_checkout_order_releases(release_id,command_id,mode,instance_id,owner_hash,release_key,request_hash,order_id,kind,expected_version,resulting_version,occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const occurredAt = clock();
    if (
      !Number.isSafeInteger(occurredAt) ||
      occurredAt < 0 ||
      occurredAt > 8_640_000_000_000_000
    )
      invalid();
    if (
      occurredAt < order.created_at ||
      (kind === "expire" && occurredAt < order.reserve_until)
    )
      throw new CheckoutReleaseError("conflict");
    await statement
      .bind(
        releaseId,
        commandId,
        context.mode,
        context.instanceId,
        context.ownerHash,
        releaseKey,
        requestHash,
        orderId,
        kind,
        expectedVersion,
        expectedVersion + 1,
        occurredAt,
      )
      .run();
    const saved = await find(releaseId);
    if (!saved) throw new CheckoutReleaseError("unavailable");
    return saved;
  } catch (error) {
    // Recover any same-key winner before reporting stale eligibility or I/O loss.
    const committed = await find(releaseId);
    if (committed) return committed;
    throw classify(error);
  }
}
/** Internal local fixture command. Trusted context partitions rows; it is not
 * authentication or payment authorization. Receipt is immutable historical evidence. */
export async function releaseTestCheckoutOrder(
  db: D1Database,
  context: TestCheckoutContext,
  input: unknown,
  clock: () => number = Date.now,
): Promise<TestCheckoutReleaseReceipt> {
  try {
    return await release(db, context, input, clock);
  } catch (error) {
    throw classify(error);
  }
}
