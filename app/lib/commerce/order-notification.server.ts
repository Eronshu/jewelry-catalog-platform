import type { AdminPrincipal } from "../auth/admin-access.server";
import { commandHash } from "./inventory.server";
import type {
  NotificationConfig,
  NotificationKind,
  NotificationScope,
  NotificationStatus,
  NotificationStatusScope,
  OwnerNotificationDetail,
  OwnerNotificationInput,
  OwnerNotificationOperation,
  OwnerNotificationReceipt,
} from "./order-notification";

export class OwnerNotificationError extends Error {
  constructor(
    public readonly code:
      "invalid_request" | "not_found" | "conflict" | "unavailable",
  ) {
    super("The fictional notification could not be confirmed");
    this.name = "OwnerNotificationError";
  }
}
function fail(code: OwnerNotificationError["code"]): never {
  throw new OwnerNotificationError(code);
}
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const orderPattern = new RegExp(`^order-${uuid.source.slice(1, -1)}$`);
const hex = /^[a-f0-9]{64}$/;
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
function text(raw: unknown, pattern: RegExp): string {
  if (typeof raw !== "string" || !pattern.test(raw)) fail("invalid_request");
  return raw;
}
function scope(raw: unknown): NotificationScope {
  const s = fields(raw, ["mode", "instanceId"]);
  if (s.mode !== "local-test") fail("invalid_request");
  return { mode: "local-test", instanceId: text(s.instanceId, uuid) };
}
function config(raw: unknown): NotificationConfig {
  const c = fields(raw, [
    "mode",
    "instanceId",
    "canonicalOrigin",
    "linkSecret",
  ]);
  const s = scope({ mode: c.mode, instanceId: c.instanceId });
  const canonicalOrigin = text(
    c.canonicalOrigin,
    /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/,
  );
  try {
    if (new URL(canonicalOrigin).origin !== canonicalOrigin)
      fail("invalid_request");
  } catch {
    fail("invalid_request");
  }
  return { ...s, canonicalOrigin, linkSecret: text(c.linkSecret, hex) };
}
function principal(raw: unknown): AdminPrincipal {
  const a = fields(raw, ["email", "sub"]);
  return {
    email: text(a.email, /^[^\s\u0000-\u001f]{1,320}$/).toLowerCase(),
    sub: text(a.sub, /^[^\s\u0000-\u001f]{1,400}$/),
  };
}
function input(raw: unknown): OwnerNotificationInput {
  const i = fields(raw, [
    "requestId",
    "orderId",
    "operation",
    "notificationId",
  ]);
  if (
    !["prepare", "test_delivered", "test_failed", "revoke"].includes(
      i.operation as string,
    )
  )
    fail("invalid_request");
  if (
    i.operation === "prepare"
      ? i.notificationId !== null
      : typeof i.notificationId !== "string" || !uuid.test(i.notificationId)
  )
    fail("invalid_request");
  return {
    requestId: text(i.requestId, uuid),
    orderId: text(i.orderId, orderPattern),
    operation: i.operation as OwnerNotificationOperation,
    notificationId: i.notificationId as string | null,
  };
}
function time(clock: () => number): number {
  if (typeof clock !== "function") fail("invalid_request");
  try {
    const n = clock();
    if (!Number.isSafeInteger(n) || n < 0 || n > 8639999913600000)
      fail("invalid_request");
    return n;
  } catch {
    fail("invalid_request");
  }
}
async function safe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof OwnerNotificationError) throw e;
    fail("unavailable");
  }
}
async function checked(db: D1Database, s: NotificationScope) {
  if (
    !(await db
      .prepare(
        "SELECT 1 FROM commerce_payment_scope WHERE id=1 AND mode=? AND instance_id=?",
      )
      .bind(s.mode, s.instanceId)
      .first())
  )
    fail("conflict");
}
async function hashToken(raw: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
async function token(
  c: NotificationConfig,
  orderId: string,
  notificationId: string,
) {
  const bytes = Uint8Array.from(c.linkSecret.match(/../g)!, (b) =>
    parseInt(b, 16),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(
      JSON.stringify([
        "fictional-order-status-v1",
        c.mode,
        c.instanceId,
        orderId,
        notificationId,
      ]),
    ),
  );
  return Array.from(new Uint8Array(signed), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
type Source = { kind: NotificationKind; source_id: string; event_at: number };
const missingSQL = `SELECT s.kind,s.source_id,s.event_at FROM commerce_notification_sources s WHERE s.order_id=? AND s.mode=? AND s.instance_id=? AND s.canonical_origin=? AND NOT EXISTS(SELECT 1 FROM commerce_notification_intents i WHERE i.mode=s.mode AND i.instance_id=s.instance_id AND i.kind=s.kind AND i.source_id=s.source_id) ORDER BY s.event_at,s.kind,s.source_id LIMIT 100`;
const labels: Record<NotificationKind, string> = {
  capture_confirmed: "Payment confirmed",
  refund_confirmed: "Refund confirmed",
  packed: "Order packed",
  handed_over: "Order handed over",
};
export async function readOwnerNotifications(
  db: D1Database,
  rawConfig: NotificationConfig,
  rawOrderId: string,
  clock: () => number = Date.now,
): Promise<OwnerNotificationDetail | null> {
  const c = config(rawConfig),
    orderId = text(rawOrderId, orderPattern),
    now = time(clock);
  return safe(async () => {
    await checked(db, c);
    if (
      !(await db
        .prepare(
          "SELECT 1 FROM commerce_notification_orders WHERE order_id=? AND mode=? AND instance_id=?",
        )
        .bind(orderId, c.mode, c.instanceId)
        .first())
    )
      return null;
    const missing = await db
      .prepare(missingSQL)
      .bind(orderId, c.mode, c.instanceId, c.canonicalOrigin)
      .all<Source>();
    const rows = await db
      .prepare(
        `SELECT i.*,EXISTS(SELECT 1 FROM commerce_notification_revocations r WHERE r.notification_id=i.id) AS revoked FROM commerce_notification_intents i JOIN commerce_notification_commands c ON c.request_id=i.prepare_request_id WHERE i.order_id=? AND i.mode=? AND i.instance_id=? AND c.canonical_origin=? ORDER BY i.created_at,i.rowid`,
      )
      .bind(orderId, c.mode, c.instanceId, c.canonicalOrigin)
      .all<{
        id: string;
        kind: NotificationKind;
        recipient: string;
        token_hash: string;
        created_at: number;
        expires_at: number;
        revoked: number;
      }>();
    const notifications = await Promise.all(
      rows.results.map(async (r) => {
        const attempts = (
          await db
            .prepare(
              "SELECT outcome,recorded_at AS at FROM commerce_notification_attempts WHERE notification_id=? ORDER BY rowid",
            )
            .bind(r.id)
            .all<{ outcome: "test_delivered" | "test_failed"; at: number }>()
        ).results;
        const state: OwnerNotificationDetail["notifications"][number]["state"] =
          r.revoked === 1 ? "revoked" : (attempts.at(-1)?.outcome ?? "pending");
        const raw = await token(c, orderId, r.id),
          usable =
            r.revoked === 0 &&
            now >= r.created_at &&
            now < r.expires_at &&
            (await hashToken(raw)) === r.token_hash;
        return {
          id: r.id,
          kind: r.kind,
          recipient: r.recipient,
          subject: `[FICTIONAL TEST] ${labels[r.kind]}`,
          body: `Fictional local test only. ${labels[r.kind]} for ${orderId}. No email was sent. The status link is read-only and expires after 24 hours.`,
          state,
          statusUrl: usable
            ? `${c.canonicalOrigin}/checkout/status#${raw}`
            : null,
          expiresAt: r.expires_at,
          canDeliver:
            usable &&
            attempts.length < 3 &&
            (state === "pending" || state === "test_failed"),
          canRevoke: r.revoked === 0,
          attempts,
        };
      }),
    );
    return { orderId, canPrepare: missing.results.length > 0, notifications };
  });
}
type Identity = {
  s: NotificationScope;
  a: string;
  h: string;
  i: OwnerNotificationInput;
};
async function identity(
  s: NotificationScope,
  a: AdminPrincipal,
  i: OwnerNotificationInput,
): Promise<Identity> {
  const actorHash = await commandHash([
    "owner-notification-actor-v1",
    a.email,
    a.sub,
  ]);
  return {
    s,
    a: actorHash,
    h: await commandHash(["owner-notification-v1", s, actorHash, i]),
    i,
  };
}
type Saved = {
  request_id: string;
  order_id: string;
  operation: OwnerNotificationOperation;
  notification_id: string | null;
  mode: string;
  instance_id: string;
  actor_hash: string;
  request_hash: string;
  complete: number;
};
const savedSQL = `SELECT c.*,((SELECT COUNT(*) FROM commerce_notification_intents i WHERE i.prepare_request_id=c.request_id)=json_array_length(c.intents_json) AND (SELECT COUNT(*) FROM commerce_notification_attempts a WHERE a.request_id=c.request_id AND a.notification_id=c.notification_id AND a.outcome=c.operation AND a.recorded_at=c.recorded_at)=CASE WHEN c.operation IN ('test_delivered','test_failed') THEN 1 ELSE 0 END AND (SELECT COUNT(*) FROM commerce_notification_revocations r WHERE r.request_id=c.request_id AND r.notification_id=c.notification_id AND r.recorded_at=c.recorded_at)=CASE WHEN c.operation='revoke' THEN 1 ELSE 0 END) AS complete FROM commerce_notification_commands c WHERE c.request_id=?`;
async function find(
  db: D1Database,
  id: Identity,
): Promise<OwnerNotificationReceipt | null> {
  const r = await db.prepare(savedSQL).bind(id.i.requestId).first<Saved>();
  if (!r) return null;
  if (
    r.mode !== id.s.mode ||
    r.instance_id !== id.s.instanceId ||
    r.actor_hash !== id.a ||
    r.request_hash !== id.h
  )
    fail("conflict");
  if (
    r.complete !== 1 ||
    r.order_id !== id.i.orderId ||
    r.operation !== id.i.operation ||
    r.notification_id !== id.i.notificationId
  )
    fail("unavailable");
  return {
    testOnly: true,
    requestId: r.request_id,
    orderId: r.order_id,
    operation: r.operation,
    recorded: true,
  };
}
export async function lookupOwnerNotificationCommand(
  db: D1Database,
  rawScope: NotificationScope,
  rawActor: AdminPrincipal,
  rawInput: OwnerNotificationInput,
): Promise<
  | { state: "recorded"; receipt: OwnerNotificationReceipt }
  | { state: "not_recorded" }
> {
  const s = scope(rawScope),
    a = principal(rawActor),
    i = input(rawInput);
  return safe(async () => {
    await checked(db, s);
    const r = await find(db, await identity(s, a, i));
    return r ? { state: "recorded", receipt: r } : { state: "not_recorded" };
  });
}
export async function applyOwnerNotification(
  db: D1Database,
  rawConfig: NotificationConfig,
  rawActor: AdminPrincipal,
  rawInput: OwnerNotificationInput,
  clock: () => number = Date.now,
  beforeMutationHook?: () => Promise<void>,
): Promise<OwnerNotificationReceipt> {
  const c = config(rawConfig),
    a = principal(rawActor),
    i = input(rawInput),
    s = scope({ mode: c.mode, instanceId: c.instanceId });
  if (
    typeof clock !== "function" ||
    (beforeMutationHook !== undefined &&
      typeof beforeMutationHook !== "function")
  )
    fail("invalid_request");
  const id = await safe(() => identity(s, a, i));
  const replay = await safe(async () => {
    await checked(db, s);
    return find(db, id);
  });
  if (replay) return replay;
  const intents = await safe(async () => {
    const sources =
      i.operation === "prepare"
        ? (
            await db
              .prepare(missingSQL)
              .bind(i.orderId, c.mode, c.instanceId, c.canonicalOrigin)
              .all<Source>()
          ).results
        : [];
    return Promise.all(
      sources.map(async (source) => {
        const notificationId = crypto.randomUUID();
        return {
          id: notificationId,
          kind: source.kind,
          sourceId: source.source_id,
          tokenHash: await hashToken(await token(c, i.orderId, notificationId)),
        };
      }),
    );
  });
  if (beforeMutationHook) await beforeMutationHook();
  const at = time(clock);
  return safe(async () => {
    try {
      const result = await db
        .prepare(
          "INSERT INTO commerce_notification_commands(request_id,mode,instance_id,actor_hash,request_hash,order_id,operation,notification_id,canonical_origin,intents_json,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          i.requestId,
          c.mode,
          c.instanceId,
          id.a,
          id.h,
          i.orderId,
          i.operation,
          i.notificationId,
          c.canonicalOrigin,
          JSON.stringify(intents),
          at,
        )
        .run();
      if (
        result.success !== true ||
        !Number.isSafeInteger(result.meta?.changes) ||
        result.meta.changes <= 0
      )
        fail("unavailable");
      const saved = await find(db, id);
      if (!saved) fail("unavailable");
      return saved;
    } catch (e) {
      const saved = await find(db, id);
      if (saved) return saved;
      // A competing prepare can cover the same sources before this write. The
      // caller retains its request UUID and may explicitly retry that command.
      if (e instanceof OwnerNotificationError) throw e;
      const current = await readOwnerNotifications(db, c, i.orderId, () => at);
      if (!current) fail("not_found");
      if (i.operation !== "prepare") {
        const n = current.notifications.find((n) => n.id === i.notificationId);
        if (!n || (i.operation === "revoke" ? !n.canRevoke : !n.canDeliver))
          fail("conflict");
      }
      fail("unavailable");
    }
  });
}
export async function readNotificationStatus(
  db: D1Database,
  rawScope: NotificationStatusScope,
  rawToken: string,
  clock: () => number = Date.now,
): Promise<NotificationStatus | null> {
  const statusScope = fields(rawScope, [
    "mode",
    "instanceId",
    "canonicalOrigin",
  ]);
  const canonicalOrigin = text(
    statusScope.canonicalOrigin,
    /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/,
  );
  try {
    if (new URL(canonicalOrigin).origin !== canonicalOrigin)
      fail("invalid_request");
  } catch {
    fail("invalid_request");
  }
  const s = scope({
      mode: statusScope.mode,
      instanceId: statusScope.instanceId,
    }),
    raw = text(rawToken, hex),
    now = time(clock);
  return safe(async () => {
    await checked(db, s);
    const row = await db
      .prepare(
        `SELECT o.order_id AS orderId,o.state,o.payment_state AS paymentState,o.fulfillment,o.total_cents AS totalCents,o.delivery,COALESCE((SELECT SUM(r.refund_cents) FROM commerce_owner_refund_confirmed r WHERE r.order_id=o.order_id AND r.mode=o.mode AND r.instance_id=o.instance_id),0) AS refundedCents FROM commerce_notification_intents i JOIN commerce_notification_commands c ON c.request_id=i.prepare_request_id JOIN commerce_notification_orders o ON o.order_id=i.order_id AND o.mode=i.mode AND o.instance_id=i.instance_id WHERE c.canonical_origin=? AND i.token_hash=? AND i.mode=? AND i.instance_id=? AND i.created_at<=? AND i.expires_at>? AND NOT EXISTS(SELECT 1 FROM commerce_notification_revocations r WHERE r.notification_id=i.id)`,
      )
      .bind(
        canonicalOrigin,
        await hashToken(raw),
        s.mode,
        s.instanceId,
        now,
        now,
      )
      .first<NotificationStatus>();
    return row;
  });
}
