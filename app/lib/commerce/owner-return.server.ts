import type { AdminPrincipal } from "../auth/admin-access.server";
import { commandHash } from "./inventory.server";
import { readOwnerRefund } from "./owner-refund.server";
import type {
  OwnerReturnScope,
  OwnerReturnInput,
  OwnerReturnOperation,
  OwnerReturnReceipt,
  OwnerReturnDetail,
  OwnerReturnLine,
} from "./owner-return";
export class OwnerReturnError extends Error {
  constructor(
    public readonly code:
      "invalid_request" | "not_found" | "conflict" | "unavailable",
  ) {
    super("The local return operation could not be confirmed");
    this.name = "OwnerReturnError";
  }
}
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const orderIdPattern = new RegExp(`^order-${uuid.source.slice(1, -1)}$`);
const operations: OwnerReturnOperation[] = [
  "inspect_sellable",
  "inspect_unsuitable",
  "restock",
];
function fail(code: OwnerReturnError["code"]): never {
  throw new OwnerReturnError(code);
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
function scope(raw: unknown): OwnerReturnScope {
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
function input(raw: unknown): OwnerReturnInput {
  const i = fields(raw, [
    "requestId",
    "orderId",
    "operation",
    "expectedVersion",
    "expectedStockHash",
    "acknowledge",
  ]);
  if (
    i.acknowledge !== true ||
    !operations.includes(i.operation as OwnerReturnOperation)
  )
    fail("invalid_request");
  return {
    requestId: text(i.requestId, uuid),
    orderId: text(i.orderId, orderIdPattern),
    operation: i.operation as OwnerReturnOperation,
    expectedVersion: integer(i.expectedVersion, 1, Number.MAX_SAFE_INTEGER),
    expectedStockHash: text(i.expectedStockHash, /^[a-f0-9]{64}$/),
    acknowledge: true,
  };
}
async function safe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof OwnerReturnError) throw error;
    fail("unavailable");
  }
}
async function checkedScope(db: D1Database, s: OwnerReturnScope) {
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
  operation: OwnerReturnOperation;
  mode: string;
  instance_id: string;
  actor_hash: string;
  request_hash: string;
  expected_version: number;
  expected_stock_hash: string;
  expected_lines_json: string;
  recorded_at: number;
  complete: number;
};
const savedQuery = `SELECT r.*,EXISTS(SELECT 1 FROM commerce_commands c WHERE c.id=r.command_id AND c.request_hash=r.request_hash AND c.created_at=r.recorded_at
 AND (SELECT COUNT(*) FROM commerce_owner_return_lines l WHERE l.request_id=r.request_id)=json_array_length(r.expected_lines_json)
 AND (SELECT COUNT(*) FROM commerce_stock_movements m WHERE m.command_id=c.id)=CASE r.operation WHEN 'restock' THEN json_array_length(r.expected_lines_json) ELSE 0 END
 AND NOT EXISTS(SELECT 1 FROM json_each(r.expected_lines_json) j WHERE NOT EXISTS(SELECT 1 FROM commerce_owner_return_lines l
 WHERE l.request_id=r.request_id AND l.position=json_extract(j.value,'$.position') AND l.variant_id=json_extract(j.value,'$.variantId') AND l.quantity=json_extract(j.value,'$.quantity')
 AND l.before_on_hand=json_extract(j.value,'$.onHand') AND l.before_facebook=json_extract(j.value,'$.facebookReserved') AND l.before_checkout=json_extract(j.value,'$.checkoutReserved') AND l.before_allocated=json_extract(j.value,'$.allocated')
 AND (r.operation!='restock' OR EXISTS(SELECT 1 FROM commerce_stock_movements m WHERE m.command_id=c.id AND m.position=l.position AND m.variant_id=l.variant_id AND m.quantity=l.quantity
 AND m.kind='return' AND m.expected_variant_version IS NULL AND m.reason='Owner restocked inspected whole-order test return'))))) AS complete
 FROM commerce_owner_return_commands r`;
function receipt(r: Saved, replayed = true): OwnerReturnReceipt {
  if (r.complete !== 1 || !Number.isSafeInteger(r.recorded_at))
    fail("unavailable");
  return {
    testOnly: true,
    requestId: r.request_id,
    orderId: r.order_id,
    operation: r.operation,
    recordedAt: r.recorded_at,
    expectedVersion: r.expected_version,
    expectedStockHash: r.expected_stock_hash,
    result:
      r.operation === "restock"
        ? "stock_restored"
        : r.operation === "inspect_sellable"
          ? "sellable_received"
          : "unsuitable_received",
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
  detail: OwnerReturnDetail;
  captureId: string | null;
  handoffId: string | null;
  inspectionId: string | null;
  refundObservationId: string | null;
};
async function load(
  db: D1Database,
  s: OwnerReturnScope,
  orderId: string,
): Promise<Context | null> {
  const o = await db
    .prepare(
      `SELECT o.version,json_extract(o.snapshot,'$.delivery') AS delivery FROM commerce_checkout_order_origins x JOIN commerce_orders o ON o.id=x.order_id
 JOIN commerce_payment_scope s ON s.id=1 AND s.mode=x.mode AND s.instance_id=x.instance_id
 WHERE x.order_id=? AND x.mode=? AND x.instance_id=? AND o.owner_hash=x.owner_hash AND o.quote_id=x.promoted_quote_id AND o.reserve_command_id=x.command_id AND o.created_at=x.created_at AND o.reserve_until=x.reserve_until`,
    )
    .bind(orderId, s.mode, s.instanceId)
    .first<{ version: number; delivery: string }>();
  if (!o) return null;
  const lines = (
    await db
      .prepare(
        `SELECT l.position,l.variant_id AS variantId,json_extract(j.value,'$.name') AS name,json_extract(j.value,'$.sku') AS sku,json_extract(j.value,'$.colour') AS colour,l.quantity,
 i.on_hand AS onHand,i.facebook_reserved AS facebookReserved,i.checkout_reserved AS checkoutReserved,i.allocated
 FROM commerce_orders o JOIN commerce_order_lines l ON l.order_id=o.id JOIN commerce_inventory i ON i.variant_id=l.variant_id JOIN json_each(o.snapshot,'$.lines') j ON j.key=l.position
 WHERE o.id=? AND json_extract(j.value,'$.variantId')=l.variant_id AND json_extract(j.value,'$.quantity')=l.quantity ORDER BY l.position`,
      )
      .bind(orderId)
      .all<OwnerReturnLine>()
  ).results;
  const saved = (
    await db
      .prepare(
        savedQuery +
          " WHERE r.order_id=? AND r.mode=? AND r.instance_id=? ORDER BY r.rowid",
      )
      .bind(orderId, s.mode, s.instanceId)
      .all<Saved>()
  ).results;
  const history = saved.map((r) => receipt(r)),
    inspection = saved.find((r) => r.operation !== "restock"),
    restocked = saved.some((r) => r.operation === "restock");
  const h = await db
    .prepare(
      "SELECT capture_id AS captureId,handoff_request_id AS handoffId FROM commerce_owner_return_handoffs WHERE order_id=? AND mode=? AND instance_id=?",
    )
    .bind(orderId, s.mode, s.instanceId)
    .first<{ captureId: string; handoffId: string }>();
  const refund = await db
    .prepare(
      "SELECT observation_id AS id FROM commerce_owner_return_refunds WHERE order_id=? ORDER BY refunded_at,observation_id LIMIT 1",
    )
    .bind(orderId)
    .first<{ id: string }>();
  const refunded = await readOwnerRefund(db, s, orderId);
  const stockHash = await commandHash([
    "owner-return-stock-v1",
    orderId,
    snapshots(lines),
  ]);
  return {
    captureId: h?.captureId ?? null,
    handoffId: h?.handoffId ?? null,
    inspectionId: inspection?.request_id ?? null,
    refundObservationId: refund?.id ?? null,
    detail: {
      orderId,
      orderVersion: o.version,
      delivery: o.delivery,
      fulfillment: h ? "handed_over" : "not_handed_over",
      refundState: refunded?.state ?? "not_started",
      inspection: inspection
        ? inspection.operation === "inspect_sellable"
          ? "sellable"
          : "unsuitable"
        : "not_recorded",
      stockState: restocked ? "restored" : "not_restored",
      canInspect: !!h && !inspection && !restocked,
      canRestock:
        !!h &&
        inspection?.operation === "inspect_sellable" &&
        !!refund &&
        !restocked &&
        lines.every((l) => l.onHand + l.quantity <= 1000000),
      stockHash,
      lines,
      history,
    },
  };
}
export async function readOwnerReturn(
  db: D1Database,
  rawScope: OwnerReturnScope,
  rawOrderId: string,
): Promise<OwnerReturnDetail | null> {
  const s = scope(rawScope),
    orderId = text(rawOrderId, orderIdPattern);
  return safe(async () => {
    await checkedScope(db, s);
    return (await load(db, s, orderId))?.detail ?? null;
  });
}
type Identity = {
  s: OwnerReturnScope;
  i: OwnerReturnInput;
  actorHash: string;
  requestHash: string;
};
async function identity(
  s: OwnerReturnScope,
  a: AdminPrincipal,
  i: OwnerReturnInput,
): Promise<Identity> {
  const actorHash = await commandHash([
    "owner-return-actor-v1",
    a.email,
    a.sub,
  ]);
  return {
    s,
    i,
    actorHash,
    requestHash: await commandHash(["owner-return-v1", s, actorHash, i]),
  };
}
async function find(
  db: D1Database,
  id: Identity,
  replayed = true,
): Promise<OwnerReturnReceipt | null> {
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
    r.operation !== id.i.operation ||
    r.expected_version !== id.i.expectedVersion ||
    r.expected_stock_hash !== id.i.expectedStockHash
  )
    fail("unavailable");
  return receipt(r, replayed);
}
export async function lookupOwnerReturnCommand(
  db: D1Database,
  rawScope: OwnerReturnScope,
  rawActor: AdminPrincipal,
  rawInput: OwnerReturnInput,
): Promise<
  { state: "recorded"; receipt: OwnerReturnReceipt } | { state: "not_recorded" }
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
export async function applyOwnerReturn(
  db: D1Database,
  rawScope: OwnerReturnScope,
  rawActor: AdminPrincipal,
  rawInput: OwnerReturnInput,
  clock: () => number = Date.now,
  beforeMutation?: () => Promise<void>,
): Promise<OwnerReturnReceipt> {
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
    (i.operation === "restock" ? !d.canRestock : !d.canInspect)
  ) {
    // Another same-key caller may have committed after the first lookup and
    // changed eligibility/stock. Recover its full-identity receipt before refusal.
    const saved = await safe(() => find(db, id));
    if (saved) return saved;
    fail("conflict");
  }
  // Freeze server-authoritative quantities and all current balances BEFORE the final
  // authorization hook. SQL compares every bound snapshot inside the same mutation.
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
          `INSERT INTO commerce_owner_return_commands(request_id,command_id,mode,instance_id,actor_hash,request_hash,order_id,capture_id,handoff_request_id,inspection_request_id,refund_observation_id,operation,expected_version,expected_stock_hash,expected_lines_json,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          i.requestId,
          `owner-return-${i.requestId}`,
          s.mode,
          s.instanceId,
          id.actorHash,
          id.requestHash,
          i.orderId,
          context.captureId,
          context.handoffId,
          i.operation === "restock" ? context.inspectionId : null,
          i.operation === "restock" ? context.refundObservationId : null,
          i.operation,
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
      if (error instanceof OwnerReturnError) throw error;
      const current = await load(db, s, i.orderId);
      if (!current) fail("not_found");
      if (
        current.detail.stockHash !== i.expectedStockHash ||
        current.detail.orderVersion !== i.expectedVersion ||
        (i.operation === "restock"
          ? !current.detail.canRestock
          : !current.detail.canInspect)
      )
        fail("conflict");
      fail("unavailable");
    }
  });
}
