import type { AdminPrincipal } from "../auth/admin-access.server";
import { commandHash } from "./inventory.server";
import { readOwnerReturn } from "./owner-return.server";
import type { OwnerReturnLine } from "./owner-return";
import type {
  OwnerAllocationReleaseScope,
  OwnerAllocationReleaseInput,
  OwnerAllocationReleaseReceipt,
  OwnerAllocationReleaseDetail,
} from "./owner-allocation-release";
export class OwnerAllocationReleaseError extends Error {
  constructor(
    public readonly code:
      "invalid_request" | "not_found" | "conflict" | "unavailable",
  ) {
    super("The local allocation release could not be confirmed");
    this.name = "OwnerAllocationReleaseError";
  }
}
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const orderIdPattern = new RegExp(`^order-${uuid.source.slice(1, -1)}$`);
function fail(code: OwnerAllocationReleaseError["code"]): never {
  throw new OwnerAllocationReleaseError(code);
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
function scope(raw: unknown): OwnerAllocationReleaseScope {
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
function input(raw: unknown): OwnerAllocationReleaseInput {
  const i = fields(raw, [
    "requestId",
    "orderId",
    "expectedVersion",
    "expectedStockHash",
    "acknowledge",
  ]);
  if (i.acknowledge !== true) fail("invalid_request");
  return {
    requestId: text(i.requestId, uuid),
    orderId: text(i.orderId, orderIdPattern),
    expectedVersion: integer(i.expectedVersion, 1, Number.MAX_SAFE_INTEGER),
    expectedStockHash: text(i.expectedStockHash, /^[a-f0-9]{64}$/),
    acknowledge: true,
  };
}
async function safe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof OwnerAllocationReleaseError) throw error;
    fail("unavailable");
  }
}
async function checkedScope(db: D1Database, s: OwnerAllocationReleaseScope) {
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
  mode: string;
  instance_id: string;
  actor_hash: string;
  request_hash: string;
  expected_version: number;
  expected_stock_hash: string;
  recorded_at: number;
  complete: number;
};
const savedQuery = `SELECT r.*,EXISTS(SELECT 1 FROM commerce_commands c WHERE c.id=r.command_id AND c.request_hash=r.request_hash AND c.created_at=r.recorded_at
 AND (SELECT COUNT(*) FROM commerce_owner_allocation_release_lines l WHERE l.request_id=r.request_id)=json_array_length(r.expected_lines_json)
 AND (SELECT COUNT(*) FROM commerce_stock_movements m WHERE m.command_id=c.id)=json_array_length(r.expected_lines_json)
 AND NOT EXISTS(SELECT 1 FROM json_each(r.expected_lines_json) j WHERE NOT EXISTS(SELECT 1 FROM commerce_owner_allocation_release_lines l
 JOIN commerce_stock_movements m ON m.command_id=c.id AND m.position=l.position AND m.variant_id=l.variant_id AND m.quantity=l.quantity
 WHERE l.request_id=r.request_id AND l.position=json_extract(j.value,'$.position') AND l.variant_id=json_extract(j.value,'$.variantId') AND l.quantity=json_extract(j.value,'$.quantity')
 AND l.before_on_hand=json_extract(j.value,'$.onHand') AND l.before_facebook=json_extract(j.value,'$.facebookReserved') AND l.before_checkout=json_extract(j.value,'$.checkoutReserved') AND l.before_allocated=json_extract(j.value,'$.allocated')
 AND m.kind='deallocate' AND m.expected_variant_version IS NULL AND m.reason='Owner released retained refunded whole-order allocation'))) AS complete
 FROM commerce_owner_allocation_release_commands r`;
function receipt(r: Saved, replayed = true): OwnerAllocationReleaseReceipt {
  if (r.complete !== 1 || !Number.isSafeInteger(r.recorded_at))
    fail("unavailable");
  return {
    testOnly: true,
    requestId: r.request_id,
    orderId: r.order_id,
    recordedAt: r.recorded_at,
    expectedVersion: r.expected_version,
    expectedStockHash: r.expected_stock_hash,
    result: "allocation_released",
    replayed,
  };
}
function snapshots(lines: OwnerReturnLine[]) {
  return lines.map((l) => ({
    position: l.position,
    variantId: l.variantId,
    quantity: l.quantity,
    onHand: l.onHand,
    facebookReserved: l.facebookReserved,
    checkoutReserved: l.checkoutReserved,
    allocated: l.allocated,
  }));
}
type Context = {
  detail: OwnerAllocationReleaseDetail;
  captureId: string | null;
  refundObservationId: string | null;
};
async function load(
  db: D1Database,
  s: OwnerAllocationReleaseScope,
  orderId: string,
): Promise<Context | null> {
  const original = await readOwnerReturn(db, s, orderId);
  if (!original) return null;
  const saved = (
    await db
      .prepare(
        savedQuery +
          " WHERE r.order_id=? AND r.mode=? AND r.instance_id=? ORDER BY r.rowid",
      )
      .bind(orderId, s.mode, s.instanceId)
      .all<Saved>()
  ).results;
  const source = await db
    .prepare(
      "SELECT capture_id AS captureId,observation_id AS refundObservationId FROM commerce_owner_allocation_release_sources WHERE order_id=? AND mode=? AND instance_id=? ORDER BY refunded_at,observation_id LIMIT 1",
    )
    .bind(orderId, s.mode, s.instanceId)
    .first<{ captureId: string; refundObservationId: string }>();
  const history = saved.map((r) => receipt(r)),
    stockHash = await commandHash([
      "owner-allocation-release-stock-v1",
      orderId,
      snapshots(original.lines),
    ]);
  return {
    captureId: source?.captureId ?? null,
    refundObservationId: source?.refundObservationId ?? null,
    detail: {
      orderId,
      orderVersion: original.orderVersion,
      fulfillment: original.fulfillment,
      refundState: original.refundState,
      released: history.length > 0,
      canRelease:
        !!source &&
        history.length === 0 &&
        original.lines.length > 0 &&
        original.lines.every((l) => l.allocated >= l.quantity),
      stockHash,
      lines: original.lines,
      history,
    },
  };
}
export async function readOwnerAllocationRelease(
  db: D1Database,
  rawScope: OwnerAllocationReleaseScope,
  rawOrderId: string,
): Promise<OwnerAllocationReleaseDetail | null> {
  const s = scope(rawScope),
    orderId = text(rawOrderId, orderIdPattern);
  return safe(async () => {
    await checkedScope(db, s);
    return (await load(db, s, orderId))?.detail ?? null;
  });
}
type Identity = {
  s: OwnerAllocationReleaseScope;
  i: OwnerAllocationReleaseInput;
  actorHash: string;
  requestHash: string;
};
async function identity(
  s: OwnerAllocationReleaseScope,
  a: AdminPrincipal,
  i: OwnerAllocationReleaseInput,
): Promise<Identity> {
  const actorHash = await commandHash([
    "owner-allocation-release-actor-v1",
    a.email,
    a.sub,
  ]);
  return {
    s,
    i,
    actorHash,
    requestHash: await commandHash([
      "owner-allocation-release-v1",
      s,
      actorHash,
      i,
    ]),
  };
}
async function find(
  db: D1Database,
  id: Identity,
  replayed = true,
): Promise<OwnerAllocationReleaseReceipt | null> {
  const r = await db
    .prepare(savedQuery + " WHERE r.request_id=?")
    .bind(id.i.requestId)
    .first<Saved>();
  if (!r) return null;
  if (
    r.mode !== id.s.mode ||
    r.instance_id !== id.s.instanceId ||
    r.actor_hash !== id.actorHash ||
    r.request_hash !== id.requestHash
  )
    fail("conflict");
  if (
    r.order_id !== id.i.orderId ||
    r.expected_version !== id.i.expectedVersion ||
    r.expected_stock_hash !== id.i.expectedStockHash
  )
    fail("unavailable");
  return receipt(r, replayed);
}
export async function lookupOwnerAllocationReleaseCommand(
  db: D1Database,
  rawScope: OwnerAllocationReleaseScope,
  rawActor: AdminPrincipal,
  rawInput: OwnerAllocationReleaseInput,
): Promise<
  | { state: "recorded"; receipt: OwnerAllocationReleaseReceipt }
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
export async function applyOwnerAllocationRelease(
  db: D1Database,
  rawScope: OwnerAllocationReleaseScope,
  rawActor: AdminPrincipal,
  rawInput: OwnerAllocationReleaseInput,
  clock: () => number = Date.now,
  beforeMutation?: () => Promise<void>,
): Promise<OwnerAllocationReleaseReceipt> {
  const s = scope(rawScope),
    a = principal(rawActor),
    i = input(rawInput);
  if (
    typeof clock !== "function" ||
    (beforeMutation !== undefined && typeof beforeMutation !== "function")
  )
    fail("invalid_request");
  const id = await safe(() => identity(s, a, i));
  const replay = await safe(async () => {
    await checkedScope(db, s);
    return find(db, id);
  });
  if (replay) return replay;
  const context = await safe(() => load(db, s, i.orderId));
  if (!context) fail("not_found");
  const d = context.detail;
  if (
    d.orderVersion !== i.expectedVersion ||
    d.stockHash !== i.expectedStockHash ||
    !d.canRelease
  ) {
    const saved = await safe(() => find(db, id));
    if (saved) return saved;
    fail("conflict");
  }
  const expectedLines = JSON.stringify(snapshots(d.lines));
  if (beforeMutation) await beforeMutation();
  let recordedAt: number;
  try {
    recordedAt = integer(clock(), 0, 8640000000000000);
  } catch {
    fail("invalid_request");
  }
  return safe(async () => {
    try {
      const written = await db
        .prepare(
          `INSERT INTO commerce_owner_allocation_release_commands(request_id,command_id,mode,instance_id,actor_hash,request_hash,order_id,capture_id,refund_observation_id,expected_version,expected_stock_hash,expected_lines_json,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          i.requestId,
          `owner-allocation-release-${i.requestId}`,
          s.mode,
          s.instanceId,
          id.actorHash,
          id.requestHash,
          i.orderId,
          context.captureId,
          context.refundObservationId,
          i.expectedVersion,
          i.expectedStockHash,
          expectedLines,
          recordedAt,
        )
        .run();
      const acknowledged =
        written.success === true &&
        Number.isSafeInteger(written.meta?.changes) &&
        written.meta.changes > 0;
      const saved = await find(db, id, !acknowledged);
      if (!saved) fail("unavailable");
      return saved;
    } catch (error) {
      const saved = await find(db, id);
      if (saved) return saved;
      if (error instanceof OwnerAllocationReleaseError) throw error;
      const current = await load(db, s, i.orderId);
      if (!current) fail("not_found");
      if (
        current.detail.orderVersion !== i.expectedVersion ||
        current.detail.stockHash !== i.expectedStockHash ||
        !current.detail.canRelease
      )
        fail("conflict");
      fail("unavailable");
    }
  });
}
