import type { AdminPrincipal } from "../auth/admin-access.server";
import { commandHash } from "./inventory.server";
import type {
  OwnerFulfillmentDetail,
  OwnerFulfillmentInput,
  OwnerFulfillmentOperation,
  OwnerFulfillmentReceipt,
  OwnerFulfillmentScope,
} from "./owner-fulfillment";
export class OwnerFulfillmentError extends Error {
  constructor(
    public readonly code:
      "invalid_request" | "not_found" | "conflict" | "unavailable",
  ) {
    super("The local fulfillment operation could not be confirmed");
    this.name = "OwnerFulfillmentError";
  }
}
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const orderIdPattern = new RegExp(`^order-${uuid.source.slice(1, -1)}$`);
const operations: OwnerFulfillmentOperation[] = [
  "pack",
  "collect",
  "deliver",
  "ship",
];
function fail(code: OwnerFulfillmentError["code"]): never {
  throw new OwnerFulfillmentError(code);
}
function fields(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail("invalid_request");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    Reflect.ownKeys(descriptors).some(
      (k) => typeof k !== "string" || !keys.includes(k),
    )
  )
    fail("invalid_request");
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const d = descriptors[key];
    if (!d || !("value" in d)) fail("invalid_request");
    copy[key] = d.value;
  }
  return copy;
}
function text(v: unknown, p: RegExp): string {
  if (typeof v !== "string" || !p.test(v)) fail("invalid_request");
  return v;
}
function integer(v: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max)
    fail("invalid_request");
  return v as number;
}
function scope(raw: unknown): OwnerFulfillmentScope {
  const s = fields(raw, ["mode", "instanceId"]);
  if (s.mode !== "local-test") fail("invalid_request");
  return { mode: "local-test", instanceId: text(s.instanceId, uuid) };
}
function principal(raw: unknown): AdminPrincipal {
  const a = fields(raw, ["email", "sub"]);
  const email = text(a.email, /^[^\s\u0000-\u001f]{1,320}$/),
    sub = text(a.sub, /^[^\s\u0000-\u001f]{1,400}$/);
  return { email: email.toLowerCase(), sub };
}
function input(raw: unknown): OwnerFulfillmentInput {
  const i = fields(raw, [
    "requestId",
    "orderId",
    "operation",
    "expectedVersion",
    "acknowledge",
  ]);
  if (
    i.acknowledge !== true ||
    !operations.includes(i.operation as OwnerFulfillmentOperation)
  )
    fail("invalid_request");
  return {
    requestId: text(i.requestId, uuid),
    orderId: text(i.orderId, orderIdPattern),
    operation: i.operation as OwnerFulfillmentOperation,
    expectedVersion: integer(i.expectedVersion, 1, Number.MAX_SAFE_INTEGER - 1),
    acknowledge: true,
  };
}
async function safe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof OwnerFulfillmentError) throw error;
    fail("unavailable");
  }
}
async function checkedScope(db: D1Database, s: OwnerFulfillmentScope) {
  if (
    !(await db
      .prepare(
        "SELECT 1 AS ok FROM commerce_payment_scope WHERE id=1 AND mode=? AND instance_id=?",
      )
      .bind(s.mode, s.instanceId)
      .first())
  )
    fail("conflict");
}

type Saved = {
  request_id: string;
  order_id: string;
  operation: OwnerFulfillmentOperation;
  mode: string;
  instance_id: string;
  actor_hash: string;
  request_hash: string;
  expected_version: number;
  resulting_version: number;
  recorded_at: number;
  complete: number;
};
const savedQuery = `SELECT r.*, EXISTS(SELECT 1 FROM commerce_commands c WHERE c.id=r.command_id AND c.request_hash=r.request_hash AND c.created_at=r.recorded_at
 AND (SELECT count(*) FROM commerce_stock_movements m WHERE m.command_id=c.id)=CASE r.operation WHEN 'pack' THEN 0 ELSE (SELECT count(*) FROM commerce_order_lines l WHERE l.order_id=r.order_id) END
 AND (SELECT count(*) FROM commerce_owner_fulfillment_lines s WHERE s.request_id=r.request_id)=CASE r.operation WHEN 'pack' THEN 0 ELSE (SELECT count(*) FROM commerce_order_lines l WHERE l.order_id=r.order_id) END
 AND (r.operation='pack' OR NOT EXISTS(SELECT 1 FROM commerce_order_lines l WHERE l.order_id=r.order_id AND NOT EXISTS(
 SELECT 1 FROM commerce_stock_movements m WHERE m.command_id=c.id AND m.position=l.position AND m.variant_id=l.variant_id AND m.quantity=l.quantity
 AND m.kind='fulfill' AND m.expected_variant_version IS NULL AND m.reason='Owner recorded whole-order test handoff'
 AND EXISTS(SELECT 1 FROM commerce_owner_fulfillment_lines s WHERE s.request_id=r.request_id AND s.position=l.position AND s.variant_id=l.variant_id AND s.quantity=l.quantity))))) AS complete
 FROM commerce_owner_fulfillment_commands r`;
function receipt(r: Saved, replayed = true): OwnerFulfillmentReceipt {
  if (
    r.complete !== 1 ||
    !Number.isSafeInteger(r.recorded_at) ||
    r.resulting_version !== r.expected_version + 1
  )
    fail("unavailable");
  return {
    testOnly: true,
    requestId: r.request_id,
    orderId: r.order_id,
    operation: r.operation,
    recordedAt: r.recorded_at,
    replayed,
    resultingVersion: r.resulting_version,
  };
}
async function detail(
  db: D1Database,
  s: OwnerFulfillmentScope,
  orderId: string,
): Promise<OwnerFulfillmentDetail | null> {
  const r = await db
    .prepare(
      `SELECT o.id,o.version,o.state,o.payment_state,o.fulfillment,json_extract(o.snapshot,'$.delivery') AS delivery,
 EXISTS(SELECT 1 FROM commerce_owner_fulfillment_orders e WHERE e.order_id=o.id AND e.mode=x.mode AND e.instance_id=x.instance_id) AS eligible
 FROM commerce_checkout_order_origins x JOIN commerce_orders o ON o.id=x.order_id
 JOIN commerce_payment_scope s ON s.id=1 AND s.mode=x.mode AND s.instance_id=x.instance_id
 WHERE x.order_id=? AND x.mode=? AND x.instance_id=? AND o.owner_hash=x.owner_hash AND o.quote_id=x.promoted_quote_id AND o.reserve_command_id=x.command_id`,
    )
    .bind(orderId, s.mode, s.instanceId)
    .first<{
      id: string;
      version: number;
      state: string;
      payment_state: string;
      fulfillment: string;
      delivery: string;
      eligible: number;
    }>();
  if (!r) return null;
  const rows = await db
    .prepare(
      savedQuery +
        " WHERE r.order_id=? AND r.mode=? AND r.instance_id=? ORDER BY r.resulting_version",
    )
    .bind(orderId, s.mode, s.instanceId)
    .all<Saved>();
  const history = rows.results.map((x) => receipt(x));
  const handed = history.some((x) => x.operation !== "pack"),
    packed = history.some((x) => x.operation === "pack");
  const paid =
    r.eligible === 1 &&
    r.state === "confirmed" &&
    r.payment_state === "succeeded";
  const canPack =
    paid && r.fulfillment === "ready_to_pack" && !packed && !handed;
  const canHandoff =
    paid &&
    r.fulfillment === "ready_to_pack" &&
    packed &&
    !handed &&
    history.at(-1)?.resultingVersion === r.version;
  return {
    orderId,
    version: r.version,
    delivery: r.delivery,
    state:
      handed && paid && r.fulfillment === "completed"
        ? "handed_over"
        : canHandoff
          ? "packed"
          : canPack
            ? "ready_to_pack"
            : "blocked",
    canPack,
    canHandoff,
    history,
  };
}
export async function readOwnerFulfillment(
  db: D1Database,
  rawScope: OwnerFulfillmentScope,
  rawOrderId: string,
): Promise<OwnerFulfillmentDetail | null> {
  const s = scope(rawScope),
    orderId = text(rawOrderId, orderIdPattern);
  return safe(async () => {
    await checkedScope(db, s);
    return detail(db, s, orderId);
  });
}
type Identity = {
  scope: OwnerFulfillmentScope;
  input: OwnerFulfillmentInput;
  actorHash: string;
  requestHash: string;
};
async function identity(
  s: OwnerFulfillmentScope,
  a: AdminPrincipal,
  i: OwnerFulfillmentInput,
): Promise<Identity> {
  const actorHash = await commandHash([
    "owner-fulfillment-actor-v1",
    a.email,
    a.sub,
  ]);
  return {
    scope: s,
    input: i,
    actorHash,
    requestHash: await commandHash(["owner-fulfillment-v1", s, actorHash, i]),
  };
}
async function find(
  db: D1Database,
  id: Identity,
  replayed = true,
): Promise<OwnerFulfillmentReceipt | null> {
  const r = await db
    .prepare(savedQuery + " WHERE r.request_id=?")
    .bind(id.input.requestId)
    .first<Saved>();
  if (!r) return null;
  if (
    r.mode !== id.scope.mode ||
    r.instance_id !== id.scope.instanceId ||
    r.actor_hash !== id.actorHash ||
    r.request_hash !== id.requestHash
  )
    fail("conflict");
  if (
    r.order_id !== id.input.orderId ||
    r.operation !== id.input.operation ||
    r.expected_version !== id.input.expectedVersion
  )
    fail("unavailable");
  return receipt(r, replayed);
}
export async function lookupOwnerFulfillmentCommand(
  db: D1Database,
  rawScope: OwnerFulfillmentScope,
  rawActor: AdminPrincipal,
  rawInput: OwnerFulfillmentInput,
): Promise<
  | { state: "recorded"; receipt: OwnerFulfillmentReceipt }
  | { state: "not_recorded" }
> {
  const s = scope(rawScope),
    a = principal(rawActor),
    i = input(rawInput);
  return safe(async () => {
    await checkedScope(db, s);
    const r = await find(db, await identity(s, a, i));
    return r ? { state: "recorded", receipt: r } : { state: "not_recorded" };
  });
}
export async function applyOwnerFulfillment(
  db: D1Database,
  rawScope: OwnerFulfillmentScope,
  rawActor: AdminPrincipal,
  rawInput: OwnerFulfillmentInput,
  clock: () => number = Date.now,
  beforeWrite?: () => Promise<void>,
): Promise<OwnerFulfillmentReceipt> {
  const s = scope(rawScope),
    a = principal(rawActor),
    i = input(rawInput);
  if (
    typeof clock !== "function" ||
    (beforeWrite !== undefined && typeof beforeWrite !== "function")
  )
    fail("invalid_request");
  const id = await safe(() => identity(s, a, i));
  const replay = await safe(async () => {
    await checkedScope(db, s);
    return find(db, id);
  });
  if (replay) return replay;
  if (beforeWrite) await beforeWrite();
  let recordedAt: number;
  try {
    recordedAt = integer(clock(), 0, 8640000000000000);
  } catch {
    fail("invalid_request");
  }
  return safe(async () => {
    try {
      const result = await db
        .prepare(
          `INSERT INTO commerce_owner_fulfillment_commands(request_id,command_id,mode,instance_id,actor_hash,request_hash,order_id,operation,expected_version,resulting_version,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          i.requestId,
          `owner-fulfillment-${i.requestId}`,
          s.mode,
          s.instanceId,
          id.actorHash,
          id.requestHash,
          i.orderId,
          i.operation,
          i.expectedVersion,
          i.expectedVersion + 1,
          recordedAt,
        )
        .run();
      const acknowledged =
        result.success === true &&
        Number.isSafeInteger(result.meta?.changes) &&
        result.meta.changes > 0;
      const saved = await find(db, id, !acknowledged);
      if (!saved) fail("unavailable");
      return saved;
    } catch (error) {
      const saved = await find(db, id);
      if (saved) return saved;
      if (error instanceof OwnerFulfillmentError) throw error;
      const current = await detail(db, s, i.orderId);
      if (!current) fail("not_found");
      const method = {
        pickup: "collect",
        local_delivery: "deliver",
        shipping: "ship",
      }[current.delivery];
      if (
        current.version !== i.expectedVersion ||
        (i.operation === "pack"
          ? !current.canPack
          : !current.canHandoff || method !== i.operation)
      )
        fail("conflict");
      fail("unavailable");
    }
  });
}
