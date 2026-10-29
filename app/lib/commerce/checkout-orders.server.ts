import { commandHash } from "./inventory.server";
import {
  testCheckoutRulesWitness,
  type TestCheckoutContext,
} from "./checkout-acceptance.server";

export class CheckoutOrderError extends Error {
  constructor(
    public readonly code:
      | "invalid_request"
      | "conflict"
      | "stale_quote"
      | "expired_quote"
      | "unavailable",
  ) {
    super("The local test checkout order could not be confirmed.");
    this.name = "CheckoutOrderError";
  }
}
export type TestCheckoutOrderReceipt = {
  testOnly: true;
  orderId: string;
  acceptanceId: string;
  checkoutQuoteId: string;
  createdAt: number;
  reserveUntil: number;
};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const maxDate = 8_640_000_000_000_000;
function invalid(): never {
  throw new CheckoutOrderError("invalid_request");
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
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function key(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) invalid();
  return value;
}
function contextCopy(raw: unknown): TestCheckoutContext {
  const data = record(raw, ["mode", "instanceId", "ownerHash"]);
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
type Origin = {
  order_id: string;
  mode: string;
  instance_id: string;
  owner_hash: string;
  create_key: string;
  request_hash: string;
  acceptance_id: string;
  checkout_quote_id: string;
  promoted_quote_id: string;
  command_id: string;
  rules_hash: string;
  created_at: number;
  reserve_until: number;
};
function receipt(row: Origin): TestCheckoutOrderReceipt {
  return {
    testOnly: true,
    orderId: row.order_id,
    acceptanceId: row.acceptance_id,
    checkoutQuoteId: row.checkout_quote_id,
    createdAt: row.created_at,
    reserveUntil: row.reserve_until,
  };
}
function classify(error: unknown): CheckoutOrderError {
  if (error instanceof CheckoutOrderError) return error;
  if (
    error instanceof Error &&
    /commerce_checkout_order_stale/.test(error.message)
  )
    return new CheckoutOrderError("stale_quote");
  return new CheckoutOrderError("unavailable");
}
async function create(
  db: D1Database,
  trusted: TestCheckoutContext,
  raw: unknown,
  clock: () => number,
): Promise<TestCheckoutOrderReceipt> {
  // Capture strict own-data scalars and the fixed policy before any await.
  const context = contextCopy(trusted);
  const input = record(raw, ["createKey", "acceptanceId"]);
  const createKey = key(input.createKey);
  const acceptanceId = key(input.acceptanceId);
  if (typeof clock !== "function") invalid();
  const rules = testCheckoutRulesWitness();
  const rulesJson = JSON.stringify(rules);
  const requestHash = await commandHash({
    operation: "create-test-checkout-order-v1",
    context,
    acceptanceId,
  });
  const rulesHash = await commandHash(rules);
  const find = async (candidateId: string | null = null) => {
    const rows = await db
      .prepare(
        `SELECT * FROM commerce_checkout_order_origins WHERE order_id=? OR acceptance_id=? OR (mode=? AND instance_id=? AND owner_hash=? AND create_key=?)`,
      )
      .bind(
        candidateId,
        acceptanceId,
        context.mode,
        context.instanceId,
        context.ownerHash,
        createKey,
      )
      .all<Origin>();
    if (!rows.results.length) return null;
    const row = rows.results[0];
    if (
      rows.results.length !== 1 ||
      row.mode !== context.mode ||
      row.instance_id !== context.instanceId ||
      row.owner_hash !== context.ownerHash ||
      row.create_key !== createKey ||
      row.acceptance_id !== acceptanceId ||
      row.request_hash !== requestHash
    )
      throw new CheckoutOrderError("conflict");
    return receipt(row);
  };
  const previous = await find();
  if (previous) return previous;
  let orderId: string | null = null;
  try {
    const source = await db
      .prepare(
        `SELECT q.quote_id,q.rules_json,q.rules_hash,q.expires_at,a.accepted_at
      FROM commerce_checkout_acceptances a JOIN commerce_checkout_quotes q ON q.quote_id=a.quote_id
      WHERE a.acceptance_id=? AND a.mode=? AND a.instance_id=? AND a.owner_hash=?
      AND q.mode=a.mode AND q.instance_id=a.instance_id AND q.owner_hash=a.owner_hash`,
      )
      .bind(acceptanceId, context.mode, context.instanceId, context.ownerHash)
      .first<{
        quote_id: string;
        rules_json: string;
        rules_hash: string;
        expires_at: number;
        accepted_at: number;
      }>();
    if (!source) throw new CheckoutOrderError("conflict");
    if (source.rules_hash !== rulesHash || source.rules_json !== rulesJson)
      throw new CheckoutOrderError("stale_quote");
    const promotedQuoteId = crypto.randomUUID();
    orderId = `order-${promotedQuoteId}`;
    const commandId = `reserve-${promotedQuoteId}`;
    const statement = db.prepare(
      `INSERT INTO commerce_checkout_order_origins(order_id,mode,instance_id,owner_hash,create_key,request_hash,acceptance_id,checkout_quote_id,promoted_quote_id,command_id,rules_hash,created_at,reserve_until) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    // Sample only after asynchronous preparation; never extend the accepted quote.
    const createdAt = clock();
    if (
      !Number.isSafeInteger(createdAt) ||
      createdAt < 0 ||
      createdAt > maxDate
    )
      invalid();
    if (createdAt < source.accepted_at || createdAt >= source.expires_at)
      throw new CheckoutOrderError("expired_quote");
    // ONE statement owns all materialization, including existing line-reserve triggers.
    await statement
      .bind(
        orderId,
        context.mode,
        context.instanceId,
        context.ownerHash,
        createKey,
        requestHash,
        acceptanceId,
        source.quote_id,
        promotedQuoteId,
        commandId,
        rulesHash,
        createdAt,
        source.expires_at,
      )
      .run();
    const saved = await find(orderId);
    if (!saved) throw new CheckoutOrderError("unavailable");
    return saved;
  } catch (error) {
    // A same-key winner may commit before any eligibility check or response fails.
    const committed = await find(orderId);
    if (committed) return committed;
    throw classify(error);
  }
}

/** Internal CREATE-ONLY fixture API. Trusted context is row partitioning, not
 * authentication/DB attestation. Receipt grants no payment or fulfillment ability.
 * No consumer activation until a separately audited owned release/expiry path. */
export async function createTestCheckoutOrder(
  db: D1Database,
  context: TestCheckoutContext,
  input: unknown,
  clock: () => number = Date.now,
): Promise<TestCheckoutOrderReceipt> {
  try {
    return await create(db, context, input, clock);
  } catch (error) {
    throw classify(error);
  }
}
