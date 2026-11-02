import type { AdminPrincipal } from "../auth/admin-access.server";
import { commandHash } from "./inventory.server";
import type {
  OwnerStockDetail,
  OwnerStockInput,
  OwnerStockOperation,
  OwnerStockReceipt,
  OwnerStockScope,
  OwnerStockSnapshot,
} from "./owner-stock";

export class OwnerStockError extends Error {
  constructor(
    public readonly code:
      "invalid_request" | "not_found" | "conflict" | "unavailable",
  ) {
    super("The local stock operation could not be confirmed");
    this.name = "OwnerStockError";
  }
}
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const variantIdPattern = /^[A-Za-z0-9_-]{1,100}$/;
const operations: OwnerStockOperation[] = [
  "receive",
  "fb_reserve",
  "fb_release",
  "fb_sale",
];
function fail(code: OwnerStockError["code"]): never {
  throw new OwnerStockError(code);
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
function scope(raw: unknown): OwnerStockScope {
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
function input(raw: unknown): OwnerStockInput {
  const i = fields(raw, [
    "requestId",
    "variantId",
    "operation",
    "quantity",
    "expected",
    "acknowledge",
  ]);
  if (
    i.acknowledge !== true ||
    !operations.includes(i.operation as OwnerStockOperation)
  )
    fail("invalid_request");
  const operation = i.operation as OwnerStockOperation,
    e = fields(i.expected, [
      "variantVersion",
      "onHand",
      "facebookReserved",
      "checkoutReserved",
      "allocated",
    ]);
  const expected = {
    variantVersion: integer(e.variantVersion, 1, Number.MAX_SAFE_INTEGER),
    onHand: integer(e.onHand, 0, 1000000),
    facebookReserved: integer(e.facebookReserved, 0, 1),
    checkoutReserved: integer(e.checkoutReserved, 0, 1000000),
    allocated: integer(e.allocated, 0, 1000000),
  };
  if (
    expected.onHand <
    expected.facebookReserved + expected.checkoutReserved + expected.allocated
  )
    fail("invalid_request");
  return {
    requestId: text(i.requestId, uuid),
    variantId: text(i.variantId, variantIdPattern),
    operation,
    quantity: integer(i.quantity, 1, operation === "receive" ? 1000 : 1),
    expected,
    acknowledge: true,
  };
}
function after(i: OwnerStockInput): OwnerStockSnapshot {
  return {
    ...i.expected,
    onHand:
      i.expected.onHand +
      (i.operation === "receive"
        ? i.quantity
        : i.operation === "fb_sale"
          ? -1
          : 0),
    facebookReserved:
      i.expected.facebookReserved +
      (i.operation === "fb_reserve"
        ? 1
        : ["fb_release", "fb_sale"].includes(i.operation)
          ? -1
          : 0),
  };
}
function eligible(i: OwnerStockInput) {
  const a = after(i);
  return (
    a.onHand <= 1000000 &&
    a.facebookReserved >= 0 &&
    a.facebookReserved <= 1 &&
    a.onHand >= a.facebookReserved + a.checkoutReserved + a.allocated
  );
}
async function safe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof OwnerStockError) throw error;
    fail("unavailable");
  }
}
async function checkedScope(db: D1Database, s: OwnerStockScope) {
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
type DetailRow = Omit<OwnerStockDetail["item"], "active"> & {
  active: number;
  variantVersion: number;
};
async function detail(
  db: D1Database,
  variantId: string,
): Promise<OwnerStockDetail | null> {
  const row = await db
    .prepare(
      `SELECT v.id AS variantId,v.product_id AS productId,p.name AS productName,v.sku,v.colour,v.size_description AS sizeDescription,
 v.price_cents AS priceCents,v.active,p.status AS productStatus,v.version AS variantVersion,
 i.on_hand AS onHand,i.facebook_reserved AS facebookReserved,i.checkout_reserved AS checkoutReserved,i.allocated,
 CASE WHEN v.active=1 AND p.status='available' THEN i.on_hand-i.facebook_reserved-i.checkout_reserved-i.allocated ELSE 0 END AS websiteAvailable
 FROM commerce_variants v JOIN products p ON p.id=v.product_id JOIN commerce_inventory i ON i.variant_id=v.id WHERE v.id=?`,
    )
    .bind(variantId)
    .first<DetailRow>();
  if (!row) return null;
  const { variantVersion, ...item } = row;
  return { item: { ...item, active: item.active === 1 }, variantVersion };
}
export async function readOwnerStock(
  db: D1Database,
  rawScope: OwnerStockScope,
  rawVariantId: string,
): Promise<OwnerStockDetail | null> {
  const s = scope(rawScope),
    variantId = text(rawVariantId, variantIdPattern);
  return safe(async () => {
    await checkedScope(db, s);
    return detail(db, variantId);
  });
}
type Identity = {
  scope: OwnerStockScope;
  input: OwnerStockInput;
  actorHash: string;
  requestHash: string;
};
async function identity(
  s: OwnerStockScope,
  a: AdminPrincipal,
  i: OwnerStockInput,
): Promise<Identity> {
  const actorHash = await commandHash(["owner-stock-actor-v1", a.email, a.sub]);
  return {
    scope: s,
    input: i,
    actorHash,
    requestHash: await commandHash(["owner-stock-v1", s, actorHash, i]),
  };
}
type Saved = {
  mode: string;
  instance_id: string;
  actor_hash: string;
  request_hash: string;
  variant_id: string;
  operation: OwnerStockOperation;
  quantity: number;
  variant_version: number;
  before_on_hand: number;
  before_facebook: number;
  before_checkout: number;
  before_allocated: number;
  after_on_hand: number;
  after_facebook: number;
  recorded_at: number;
  complete: number;
};
async function find(
  db: D1Database,
  id: Identity,
  replayed = true,
): Promise<OwnerStockReceipt | null> {
  const r = await db
    .prepare(
      `SELECT r.*,
 EXISTS(SELECT 1 FROM commerce_commands c JOIN commerce_stock_movements m ON m.command_id=c.id WHERE c.id=r.command_id AND c.request_hash=r.request_hash AND c.created_at=r.recorded_at
 AND m.position=0 AND m.variant_id=r.variant_id AND m.kind=r.operation AND m.quantity=r.quantity AND m.expected_variant_version=r.variant_version
 AND m.reason=CASE r.operation WHEN 'receive' THEN 'Owner inspected stock receipt' WHEN 'fb_reserve' THEN 'Owner Facebook reservation' WHEN 'fb_release' THEN 'Owner Facebook release' ELSE 'Owner Facebook sale' END
 AND (SELECT COUNT(*) FROM commerce_stock_movements WHERE command_id=r.command_id)=1) AS complete
 FROM commerce_owner_stock_commands r WHERE r.request_id=?`,
    )
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
  const i = id.input,
    e = i.expected,
    a = after(i);
  if (
    r.variant_id !== i.variantId ||
    r.operation !== i.operation ||
    r.quantity !== i.quantity ||
    r.variant_version !== e.variantVersion ||
    r.before_on_hand !== e.onHand ||
    r.before_facebook !== e.facebookReserved ||
    r.before_checkout !== e.checkoutReserved ||
    r.before_allocated !== e.allocated ||
    r.after_on_hand !== a.onHand ||
    r.after_facebook !== a.facebookReserved ||
    r.complete !== 1 ||
    !Number.isSafeInteger(r.recorded_at)
  )
    fail("unavailable");
  return {
    testOnly: true,
    requestId: i.requestId,
    variantId: i.variantId,
    operation: i.operation,
    quantity: i.quantity,
    recordedAt: r.recorded_at,
    replayed,
    after: a,
  };
}
export async function lookupOwnerStockCommand(
  db: D1Database,
  rawScope: OwnerStockScope,
  rawActor: AdminPrincipal,
  rawInput: OwnerStockInput,
): Promise<
  { state: "recorded"; receipt: OwnerStockReceipt } | { state: "not_recorded" }
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
function same(d: OwnerStockDetail, e: OwnerStockSnapshot) {
  return (
    d.variantVersion === e.variantVersion &&
    d.item.onHand === e.onHand &&
    d.item.facebookReserved === e.facebookReserved &&
    d.item.checkoutReserved === e.checkoutReserved &&
    d.item.allocated === e.allocated
  );
}
export async function applyOwnerStock(
  db: D1Database,
  rawScope: OwnerStockScope,
  rawActor: AdminPrincipal,
  rawInput: OwnerStockInput,
  clock: () => number = Date.now,
  beforeWrite?: () => Promise<void>,
): Promise<OwnerStockReceipt> {
  // Snapshot every caller-controlled own-data scalar synchronously before awaiting.
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
  // Auth hook deliberately outside error normalization: preserve typed auth refusal.
  if (beforeWrite) await beforeWrite();
  let recordedAt: number;
  try {
    recordedAt = integer(clock(), 0, 8640000000000000);
  } catch {
    fail("invalid_request");
  }
  const next = after(i),
    e = i.expected;
  return safe(async () => {
    try {
      const written = await db
        .prepare(
          `INSERT INTO commerce_owner_stock_commands(request_id,command_id,mode,instance_id,actor_hash,request_hash,variant_id,operation,quantity,variant_version,before_on_hand,before_facebook,before_checkout,before_allocated,after_on_hand,after_facebook,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          i.requestId,
          `owner-stock-${i.requestId}`,
          s.mode,
          s.instanceId,
          id.actorHash,
          id.requestHash,
          i.variantId,
          i.operation,
          i.quantity,
          e.variantVersion,
          e.onHand,
          e.facebookReserved,
          e.checkoutReserved,
          e.allocated,
          next.onHand,
          next.facebookReserved,
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
      // Always recover the original immutable receipt first, including concurrent
      // same-key commits or lost write/read responses. No new key/stock inference.
      const saved = await find(db, id);
      if (saved) return saved;
      if (error instanceof OwnerStockError) throw error;
      const current = await detail(db, i.variantId);
      if (!current) fail("not_found");
      if (!same(current, e) || !eligible(i)) fail("conflict");
      fail("unavailable");
    }
  });
}
