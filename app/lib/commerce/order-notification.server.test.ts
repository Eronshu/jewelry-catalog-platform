import { RouterContextProvider } from "react-router";
import { cloudflareContext } from "../../cloudflare-context";
import { adminPrincipalContext } from "../auth/admin-access.server";
import {
  actOwnerNotificationPage,
  actNotificationStatus,
  loadOwnerNotificationPage,
} from "./order-notification-http.server";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  vi,
  describe,
  expect,
  it,
} from "vitest";
import { applyStockCommand } from "./inventory.server";
import { createTestQuote, reserveTestOrder } from "./orders.server";
import {
  issueTestCheckoutQuote,
  acceptTestCheckoutQuote,
  type TestCheckoutSelection,
} from "./checkout-acceptance.server";
import { createTestCheckoutOrder } from "./checkout-orders.server";
import {
  beginOwnedCheckoutPaymentAttempt as begin,
  type TrustedTestPaymentContext,
} from "./payment-start.server";
const root = resolve(process.cwd()),
  now = 1_800_000_000_000;
const trusted: TrustedTestPaymentContext = {
  mode: "local-test",
  instanceId: "11111111-1111-4111-8111-111111111111",
  provider: "stripe",
  accountRef: "fixture-stripe",
  ownerHash: "a".repeat(64),
};
const owner = {
  mode: trusted.mode,
  instanceId: trusted.instanceId,
  ownerHash: trusted.ownerHash,
};

let directory: string,
  baseline: string,
  upgraded: string,
  current: string,
  configPath: string,
  platform: PlatformProxy<Env> | undefined,
  db: D1Database,
  sequence = 0;
function configuration(path: string, migrations: string) {
  const filename = join(path, "wrangler.json");
  writeFileSync(
    filename,
    JSON.stringify({
      name: "fictional-owned-payment",
      compatibility_date: "2026-10-01",
      d1_databases: [
        {
          binding: "DB",
          database_name: "fixture",
          database_id: "00000000-0000-0000-0000-000000000000",
          migrations_dir: migrations,
        },
      ],
    }),
  );
  return filename;
}
function migrate(path: string, config: string) {
  execFileSync(
    join(root, "node_modules/.bin/wrangler"),
    [
      "d1",
      "migrations",
      "apply",
      "DB",
      "--config",
      config,
      "--local",
      "--persist-to",
      join(path, "state"),
    ],
    {
      env: {
        ...process.env,
        CI: "1",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_PATH: join(path, "wrangler.log"),
      },
      stdio: "pipe",
      timeout: 20000,
    },
  );
}
async function connect() {
  platform = await getPlatformProxy<Env>({
    configPath,
    envFiles: [],
    remoteBindings: false,
    persist: { path: join(current, "state/v3") },
  });
  db = platform.env.DB;
}
async function selectBaseline(seed = true) {
  await platform?.dispose();
  platform = undefined;
  rmSync(join(current, "state"), { recursive: true, force: true });
  cpSync(join(baseline, "state"), join(current, "state"), { recursive: true });
  await connect();
  if (seed) await seedScope();
}
async function seedScope() {
  await db
    .prepare(
      "INSERT INTO commerce_payment_scope(id,mode,instance_id,stripe_account_ref,paypal_account_ref) VALUES (1,'local-test',?,'fixture-stripe','fixture-paypal')",
    )
    .bind(trusted.instanceId)
    .run();
}
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "owned-payment-start-"));
  baseline = join(directory, "baseline-0030");
  mkdirSync(baseline);
  const oldMigrations = join(baseline, "migrations");
  mkdirSync(oldMigrations);
  for (const file of readdirSync(join(root, "migrations")).filter(
    (file) => file.endsWith(".sql") && file < "0031",
  ))
    copyFileSync(join(root, "migrations", file), join(oldMigrations, file));
  migrate(baseline, configuration(baseline, oldMigrations));
  upgraded = join(directory, "upgraded-0031");
  mkdirSync(upgraded);
  cpSync(join(baseline, "state"), join(upgraded, "state"), { recursive: true });
  migrate(upgraded, configuration(upgraded, join(root, "migrations")));
}, 30000);
beforeEach(async () => {
  current = mkdtempSync(join(directory, "case-"));
  cpSync(join(upgraded, "state"), join(current, "state"), { recursive: true });
  configPath = configuration(current, join(root, "migrations"));
  await connect();
  await seedScope();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No actual external transport");
    }),
  );
});
afterEach(async () => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await platform?.dispose();
  platform = undefined;
  if (current) rmSync(current, { recursive: true, force: true });
});
afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});
async function fixture() {
  const id = `owned-payment-${++sequence}`;
  const product = await db
    .prepare(
      "INSERT INTO products(name,slug,price_cents,quantity,category_id,status,created_at,updated_at) VALUES ('Fictional payment fixture',?,999,99,1,'draft',1,1) RETURNING id",
    )
    .bind(id)
    .first<{ id: number }>();
  await db.batch([
    db
      .prepare(
        "INSERT INTO product_images(product_id,r2_key,sort_order,created_at) VALUES (?,?,0,1)",
      )
      .bind(product!.id, `fictional/${id}.jpg`),
    db
      .prepare("UPDATE products SET status='available' WHERE id=?")
      .bind(product!.id),
    db
      .prepare(
        "INSERT INTO commerce_variants(id,product_id,sku,colour,size_description,price_cents,active) VALUES (?,?,?,'Gold-tone','Fictional',2505,1)",
      )
      .bind(id, product!.id, id),
  ]);
  await applyStockCommand(
    db,
    `receive-${id}`,
    [
      {
        variantId: id,
        kind: "receive",
        quantity: 4,
        reason: "Fictional inspected receipt",
      },
    ],
    now,
  );
  return id;
}
async function held(
  legacy = false,
  multi = false,
  delivery: "pickup" | "local_delivery" | "shipping" = "shipping",
  providedVariantId?: string,
) {
  const variantId = providedVariantId ?? (await fixture());
  if (legacy) {
    const q = await createTestQuote(
      db,
      trusted.ownerHash,
      [{ variantId, quantity: 1 }],
      "shipping",
      now,
    );
    const o = await reserveTestOrder(db, trusted.ownerHash, q.id, now);
    return { variantId, orderId: o.id, reserveUntil: o.reserveUntil };
  }
  const secondVariantId = multi ? await fixture() : null;
  const selection: TestCheckoutSelection = {
    contractVersion: "local-checkout-v1",
    lines: [
      { variantId, quantity: 1 },
      ...(secondVariantId ? [{ variantId: secondVariantId, quantity: 1 }] : []),
    ],
    fixtureProfileId: "fixture-ontario",
    deliveryMethod: delivery,
  };
  const q = await issueTestCheckoutQuote(
    db,
    owner,
    { issueKey: crypto.randomUUID(), selection },
    () => now,
  );
  const accepted = await acceptTestCheckoutQuote(
    db,
    owner,
    {
      acceptanceKey: crypto.randomUUID(),
      quoteId: q.quoteId,
      selection,
      acknowledge: true,
    },
    () => now,
  );
  return {
    variantId,
    secondVariantId,
    ...(await createTestCheckoutOrder(
      db,
      owner,
      { createKey: crypto.randomUUID(), acceptanceId: accepted.acceptanceId },
      () => now,
    )),
  };
}
const config: StripeSandboxConfig = {
  enabled: true,
  mode: "local-test",
  instanceId: trusted.instanceId,
  expectedAccountId: "acct_FictionalOnly123",
  canonicalOrigin: "http://127.0.0.1:8791",
  testSecretKey: ["sk", "test", "0".repeat(24)].join("_"),
};
const target = (orderId: string) => ({ ownerHash: trusted.ownerHash, orderId });
async function provider(orderId: string) {
  const a = await db
    .prepare(
      "SELECT request_id AS requestId,create_operation_key AS key,amount_cents AS amount FROM commerce_payment_attempts WHERE order_id=?",
    )
    .bind(orderId)
    .first<{ requestId: string; key: string; amount: number }>();
  const token = a!.requestId.replaceAll("-", "");
  const sessionId = `cs_test_${token}`,
    intentId = `pi_${token}`,
    chargeId = `ch_${token}`;
  const metadata = {
    test_mode: "local-test",
    instance_id: trusted.instanceId,
    account_ref: config.expectedAccountId,
    order_id: orderId,
    attempt_id: a!.requestId,
    create_operation_key: a!.key,
  };
  const state = {
    paid: false,
    expired: false,
    refunded: false,
    wrongAccount: false,
    loseCreate: false,
  };
  const session = () => ({
    id: sessionId,
    object: "checkout.session",
    livemode: false,
    mode: "payment",
    currency: "cad",
    amount_total: a!.amount,
    client_reference_id: orderId,
    expires_at: Math.floor((now + 2) / 1000) + 3600,
    status: state.paid ? "complete" : state.expired ? "expired" : "open",
    payment_status: state.paid ? "paid" : "unpaid",
    payment_intent: state.paid ? intentId : null,
    metadata,
    url:
      state.paid || state.expired
        ? null
        : `https://checkout.stripe.com/c/pay/${token}`,
  });
  const call = vi.fn<StripeSandboxFetch>(async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/v1/account")
      return Response.json({
        id: state.wrongAccount
          ? "acct_OtherFixture123"
          : config.expectedAccountId,
        object: "account",
      });
    if (path === "/v1/checkout/sessions" && init.method === "POST") {
      if (state.loseCreate)
        throw new Error("Lost provider response includes private stuff");
      const body = new URLSearchParams(init.body as string);
      expect(body.get("metadata[attempt_id]")).toBe(a!.requestId);
      expect(body.get("metadata[order_id]")).toBe(orderId);
      expect(body.get("line_items[0][price_data][unit_amount]")).toBe(
        String(a!.amount),
      );
      expect(new Headers(init.headers).get("Idempotency-Key")).toBe(a!.key);
      return Response.json(session());
    }
    if (path === `/v1/checkout/sessions/${sessionId}`)
      return Response.json(session());
    if (path === `/v1/payment_intents/${intentId}`)
      return Response.json({
        id: intentId,
        object: "payment_intent",
        livemode: false,
        status: "succeeded",
        currency: "cad",
        amount: a!.amount,
        amount_received: a!.amount,
        amount_capturable: 0,
        latest_charge: chargeId,
        metadata,
      });
    if (path === `/v1/charges/${chargeId}`)
      return Response.json({
        id: chargeId,
        object: "charge",
        livemode: false,
        payment_intent: intentId,
        status: "succeeded",
        currency: "cad",
        amount: a!.amount,
        amount_captured: a!.amount,
        amount_refunded: state.refunded ? 1 : 0,
        paid: true,
        captured: true,
        refunded: state.refunded,
        disputed: false,
      });
    throw new Error("Unexpected request");
  });

  return { state, call, sessionId, intentId, chargeId };
}

import {
  startOwnedStripePayment,
  reconcileOwnedStripePayment,
} from "./owned-stripe.server";
import type {
  StripeSandboxConfig,
  StripeSandboxFetch,
} from "./stripe-sandbox.server";
import {
  applyOwnerFulfillment,
  readOwnerFulfillment,
} from "./owner-fulfillment.server";
import {
  applyOwnerNotification,
  lookupOwnerNotificationCommand,
  readNotificationStatus,
  readOwnerNotifications,
} from "./order-notification.server";
import type {
  NotificationConfig,
  OwnerNotificationInput,
  OwnerNotificationOperation,
} from "./order-notification";
const actor = { email: "fictional-owner@example.test", sub: "fixture-owner" };
const scope = { mode: "local-test" as const, instanceId: trusted.instanceId };
const notificationConfig: NotificationConfig = {
  ...scope,
  canonicalOrigin: config.canonicalOrigin,
  linkSecret: "c".repeat(64),
};
const statusScope = {
  ...scope,
  canonicalOrigin: notificationConfig.canonicalOrigin,
};
const command = (
  orderId: string,
  operation: OwnerNotificationOperation = "prepare",
  notificationId: string | null = null,
): OwnerNotificationInput => ({
  requestId: crypto.randomUUID(),
  orderId,
  operation,
  notificationId,
});
const apply = (i: OwnerNotificationInput) =>
  applyOwnerNotification(db, notificationConfig, actor, i, () => now + 50000);
const read = (orderId: string) =>
  readOwnerNotifications(db, notificationConfig, orderId, () => now + 50001);
async function paid() {
  const item = await held();
  await begin(
    db,
    trusted,
    {
      requestId: crypto.randomUUID(),
      reference: item.orderId,
      expectedVersion: 1,
    },
    () => now + 1,
  );
  const p = await provider(item.orderId);
  await startOwnedStripePayment(
    db,
    config,
    target(item.orderId),
    p.call,
    () => now + 2,
  );
  p.state.paid = true;
  await reconcileOwnedStripePayment(
    db,
    config,
    target(item.orderId),
    p.call,
    () => now + 30002,
  );
  return { ...item, p };
}
async function history() {
  const names = (
    await db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'commerce_%' AND name NOT LIKE 'commerce_notification_%' ORDER BY name",
      )
      .all<{ name: string }>()
  ).results;
  return Object.fromEntries(
    await Promise.all(
      names.map(async ({ name }) => [
        name,
        (await db.prepare(`SELECT rowid,* FROM ${name} ORDER BY rowid`).all())
          .results,
      ]),
    ),
  );
}
async function notificationCount() {
  return (await db
    .prepare("SELECT COUNT(*) AS n FROM commerce_notification_intents")
    .first<{ n: number }>())!.n;
}
async function refund(orderId: string, refundCents = 100, success = true) {
  const requestId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO commerce_owner_refund_intents(request_id,mode,instance_id,actor_hash,request_hash,order_id,capture_id,expected_version,operation_key,provider,account_ref,canonical_origin,transaction_ref,payment_intent_ref,provider_object_ref,payment_request_id,create_operation_key,amount_cents,refund_cents,prior_refunded_cents,input_contract,recorded_at)
 SELECT ?,mode,instance_id,?,?,order_id,capture_id,version,?,provider,account_ref,canonical_origin,transaction_ref,payment_intent_ref,provider_object_ref,payment_request_id,create_operation_key,amount_cents,?,COALESCE((SELECT SUM(refund_cents) FROM commerce_owner_refund_confirmed c WHERE c.capture_id=s.capture_id),0),'partial-v2',? FROM commerce_owner_refund_sources s WHERE order_id=?`,
    )
    .bind(
      requestId,
      "1".repeat(64),
      "2".repeat(64),
      requestId,
      refundCents,
      now + 40000,
      orderId,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO commerce_owner_refund_dispatches(request_id,dispatch_id,recorded_at) VALUES(?,?,?)",
    )
    .bind(requestId, crypto.randomUUID(), now + 40001)
    .run();
  const observe = async (status: string) =>
    db
      .prepare(
        "INSERT INTO commerce_owner_refund_observations(observation_id,request_id,refund_id,status,amount_cents,refunded_cents,recorded_at) SELECT ?,request_id,?,?,amount_cents,CASE WHEN ?='succeeded' THEN refund_cents ELSE 0 END,? FROM commerce_owner_refund_intents WHERE request_id=?",
      )
      .bind(
        crypto.randomUUID(),
        `re_${requestId.replaceAll("-", "")}`,
        status,
        status,
        now + 40002,
        requestId,
      )
      .run();
  await observe("pending");
  if (success) await observe("succeeded");
  return { requestId, observe };
}
function faultDatabase(phase: "before" | "after" | "unknown") {
  let fired = false;
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          function wrap(statement: D1PreparedStatement): D1PreparedStatement {
            return new Proxy(statement, {
              get(s, k) {
                if (k === "bind")
                  return (...v: unknown[]) => wrap(s.bind(...v));
                const fn = Reflect.get(s, k);
                if (k === "run")
                  return async () => {
                    const intercept =
                      !fired &&
                      sql.startsWith(
                        "INSERT INTO commerce_notification_commands",
                      );
                    if (intercept) {
                      fired = true;
                      if (phase === "before")
                        throw new Error("fictional failure before SQL");
                    }
                    const result = await fn.call(s);
                    if (intercept && phase === "unknown")
                      return { success: true, meta: {} };
                    if (intercept)
                      throw new Error("fictional committed response lost");
                    return result;
                  };
                return typeof fn === "function" ? fn.bind(s) : fn;
              },
            });
          }
          return wrap(target.prepare(sql));
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
describe("fictional notification ledger and read-only capabilities", () => {
  it("prepares once per canonical event and delivers only to simulated inbox", async () => {
    const { orderId } = await paid(),
      before = await history();
    expect(await read(orderId)).toMatchObject({
      canPrepare: true,
      notifications: [],
    });
    const i = command(orderId);
    expect(await apply(i)).toMatchObject({ recorded: true, testOnly: true });
    expect(await apply(i)).toEqual(await apply(i));
    await apply(command(orderId));
    expect(await notificationCount()).toBe(1);
    const detail = (await read(orderId))!,
      n = detail.notifications[0];
    expect(detail.canPrepare).toBe(false);
    expect(n).toMatchObject({
      kind: "capture_confirmed",
      recipient: "ontario@example.invalid",
      state: "pending",
      canDeliver: true,
    });
    const token = n.statusUrl!.split("#")[1];
    expect(
      await readNotificationStatus(
        db,
        { ...statusScope, canonicalOrigin: "http://127.0.0.1:8799" },
        token,
        () => now + 50002,
      ),
    ).toBeNull();
    expect(
      await readNotificationStatus(db, statusScope, token, () => now + 50002),
    ).toEqual({
      orderId,
      state: "confirmed",
      paymentState: "succeeded",
      fulfillment: "ready_to_pack",
      totalCents: 4406,
      delivery: "shipping",
      refundedCents: 0,
    });
    expect(
      JSON.stringify(
        (await db.prepare("SELECT * FROM commerce_notification_intents").all())
          .results,
      ),
    ).not.toContain(token);
    const failed = command(orderId, "test_failed", n.id);
    await apply(failed);
    expect((await read(orderId))!.notifications[0].state).toBe("test_failed");
    const delivered = command(orderId, "test_delivered", n.id);
    await apply(delivered);
    await apply(delivered);
    expect((await read(orderId))!.notifications[0]).toMatchObject({
      state: "test_delivered",
      canDeliver: false,
      attempts: [{ outcome: "test_failed" }, { outcome: "test_delivered" }],
    });
    await expect(
      apply(command(orderId, "test_delivered", n.id)),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await history()).toEqual(before);
  });
  it("uses original command identity for lookup and reauthorizes only new writes", async () => {
    const { orderId } = await paid(),
      i = command(orderId);
    await apply(i);
    expect(
      await lookupOwnerNotificationCommand(db, scope, actor, i),
    ).toMatchObject({ state: "recorded" });
    await expect(
      lookupOwnerNotificationCommand(
        db,
        scope,
        { ...actor, sub: "different" },
        i,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      lookupOwnerNotificationCommand(db, scope, actor, {
        ...i,
        operation: "revoke",
        notificationId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const hook = vi.fn(async () => {
      throw new Error("paused access");
    });
    expect(
      await applyOwnerNotification(
        db,
        notificationConfig,
        actor,
        i,
        () => now + 50002,
        hook,
      ),
    ).toMatchObject({ recorded: true });
    expect(hook).not.toHaveBeenCalled();
    await expect(
      applyOwnerNotification(
        db,
        notificationConfig,
        actor,
        command(orderId),
        () => now + 50002,
        hook,
      ),
    ).rejects.toThrow("paused access");
  });
  it("keeps delivery race and revocation terminal; key changes fail closed", async () => {
    const { orderId } = await paid();
    await apply(command(orderId));
    const n = (await read(orderId))!.notifications[0],
      token = n.statusUrl!.split("#")[1];
    const results = await Promise.allSettled([
      apply(command(orderId, "test_delivered", n.id)),
      apply(command(orderId, "test_delivered", n.id)),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(
      (await readOwnerNotifications(
        db,
        { ...notificationConfig, linkSecret: "d".repeat(64) },
        orderId,
        () => now + 50002,
      ))!.notifications[0].statusUrl,
    ).toBeNull();
    expect(
      await readNotificationStatus(
        db,
        statusScope,
        "d".repeat(64),
        () => now + 50002,
      ),
    ).toBeNull();
    expect(
      await readNotificationStatus(db, statusScope, token, () => n.expiresAt),
    ).toBeNull();
    await apply(command(orderId, "revoke", n.id));
    expect(
      await readNotificationStatus(db, statusScope, token, () => now + 50002),
    ).toBeNull();
    await expect(
      apply(command(orderId, "test_failed", n.id)),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      readNotificationStatus(
        db,
        { ...statusScope, instanceId: crypto.randomUUID() },
        token,
        () => now + 50002,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("rejects lab origins, unpaid/unknown authority, bad recipients and accessor input", async () => {
    const unpaid = await held();
    expect((await read(unpaid.orderId))!.canPrepare).toBe(false);
    await expect(apply(command(unpaid.orderId))).rejects.toMatchObject({
      code: "unavailable",
    });
    const lab = await held(true);
    expect(await read(lab.orderId)).toBeNull();
    const { orderId } = await paid();
    const i = command(orderId);
    await expect(
      applyOwnerNotification(
        db,
        notificationConfig,
        actor,
        {
          ...i,
          get recipient() {
            throw new Error("must not read");
          },
        } as OwnerNotificationInput,
        () => now + 50000,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      applyOwnerNotification(
        db,
        { ...notificationConfig, canonicalOrigin: "http://127.0.0.1:8792" },
        actor,
        i,
        () => now + 50000,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    await apply(i);
    const n = (await read(orderId))!.notifications[0];
    await expect(
      db
        .prepare(
          "UPDATE commerce_notification_intents SET recipient='real@example.com' WHERE id=?",
        )
        .bind(n.id)
        .run(),
    ).rejects.toThrow();
  });
  it("backfills packing and handoff receipts without touching financial or stock facts", async () => {
    const { orderId } = await paid();
    await applyOwnerFulfillment(
      db,
      scope,
      actor,
      {
        requestId: crypto.randomUUID(),
        orderId,
        operation: "pack",
        expectedVersion: (await readOwnerFulfillment(db, scope, orderId))!
          .version,
        acknowledge: true,
      },
      () => now + 40000,
    );
    await applyOwnerFulfillment(
      db,
      scope,
      actor,
      {
        requestId: crypto.randomUUID(),
        orderId,
        operation: "ship",
        expectedVersion: (await readOwnerFulfillment(db, scope, orderId))!
          .version,
        acknowledge: true,
      },
      () => now + 40001,
    );
    const before = await history();
    await apply(command(orderId));
    expect((await read(orderId))!.notifications.map((n) => n.kind)).toEqual([
      "capture_confirmed",
      "packed",
      "handed_over",
    ]);
    expect(await history()).toEqual(before);
  });
  it("rolls back ignored intent/attempt materialization atomically", async () => {
    const { orderId } = await paid(),
      i = command(orderId);
    await db.exec(
      "CREATE TRIGGER notification_test_ignore BEFORE INSERT ON commerce_notification_intents BEGIN SELECT RAISE(IGNORE); END;",
    );
    await expect(apply(i)).rejects.toMatchObject({ code: "unavailable" });
    expect(await notificationCount()).toBe(0);
    expect(await lookupOwnerNotificationCommand(db, scope, actor, i)).toEqual({
      state: "not_recorded",
    });
    await db.exec("DROP TRIGGER notification_test_ignore;");
    await apply(i);
    const n = (await read(orderId))!.notifications[0],
      d = command(orderId, "test_delivered", n.id);
    await db.exec(
      "CREATE TRIGGER notification_test_ignore BEFORE INSERT ON commerce_notification_attempts BEGIN SELECT RAISE(IGNORE); END;",
    );
    await expect(apply(d)).rejects.toMatchObject({ code: "unavailable" });
    expect(await lookupOwnerNotificationCommand(db, scope, actor, d)).toEqual({
      state: "not_recorded",
    });
  });
  it("bounds simulated retries at three and allows terminal revocation", async () => {
    const { orderId } = await paid();
    await apply(command(orderId));
    const n = (await read(orderId))!.notifications[0];
    for (let x = 0; x < 3; x++)
      await apply(command(orderId, "test_failed", n.id));
    expect((await read(orderId))!.notifications[0]).toMatchObject({
      state: "test_failed",
      canDeliver: false,
    });
    await expect(
      apply(command(orderId, "test_delivered", n.id)),
    ).rejects.toMatchObject({ code: "conflict" });
    await apply(command(orderId, "revoke", n.id));
  });
  it("recovers only the original recorded UUID after uncertain local acknowledgments", async () => {
    const { orderId } = await paid();
    const before = command(orderId);
    await expect(
      applyOwnerNotification(
        faultDatabase("before"),
        notificationConfig,
        actor,
        before,
        () => now + 50000,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(
      await lookupOwnerNotificationCommand(db, scope, actor, before),
    ).toEqual({ state: "not_recorded" });
    for (const phase of ["after", "unknown"] as const) {
      const i = command(orderId);
      expect(
        await applyOwnerNotification(
          faultDatabase(phase),
          notificationConfig,
          actor,
          i,
          () => now + 50000,
        ),
      ).toMatchObject({ requestId: i.requestId, recorded: true });
      expect(
        await lookupOwnerNotificationCommand(db, scope, actor, i),
      ).toMatchObject({ state: "recorded" });
    }
    expect(await notificationCount()).toBe(1);
  });
  it("deduplicates concurrent prepare and permits the same unrecorded UUID to retry", async () => {
    const { orderId } = await paid(),
      a = command(orderId),
      b = command(orderId);
    const result = await Promise.allSettled([apply(a), apply(b)]);
    expect(result.some((r) => r.status === "fulfilled")).toBe(true);
    for (const i of [a, b]) {
      const r = await lookupOwnerNotificationCommand(db, scope, actor, i);
      if (r.state === "not_recorded") await apply(i);
    }
    expect(await notificationCount()).toBe(1);
    const n = (await read(orderId))!.notifications[0];
    await expect(
      db
        .prepare(
          "INSERT OR REPLACE INTO commerce_notification_intents SELECT ?,prepare_request_id,order_id,mode,instance_id,kind,source_id,recipient,token_hash,created_at,expires_at FROM commerce_notification_intents WHERE id=?",
        )
        .bind(crypto.randomUUID(), n.id)
        .run(),
    ).rejects.toThrow();
  });
  it("deduplicates confirmed partial refunds by request and ignores pending observations", async () => {
    const { orderId } = await paid();
    await apply(command(orderId));
    const a = await refund(orderId);
    await a.observe("succeeded");
    await apply(command(orderId));
    expect((await read(orderId))!.notifications.map((n) => n.kind)).toEqual([
      "capture_confirmed",
      "refund_confirmed",
    ]);
    await refund(orderId, 200);
    await apply(command(orderId));
    expect(
      (await read(orderId))!.notifications.filter(
        (n) => n.kind === "refund_confirmed",
      ),
    ).toHaveLength(2);
    const pending = await refund(orderId, 100, false);
    await apply(command(orderId));
    expect(await notificationCount()).toBe(3);
    await pending.observe("succeeded");
    await apply(command(orderId));
    expect(await notificationCount()).toBe(4);
    const n = (await read(orderId))!.notifications[0];
    expect(
      await readNotificationStatus(
        db,
        statusScope,
        n.statusUrl!.split("#")[1],
        () => now + 50002,
      ),
    ).toMatchObject({ refundedCents: 400 });
  });
  it("rolls back failed 0031 migration with all filled0030 history intact", async () => {
    await selectBaseline();
    const { orderId } = await paid();
    await refund(orderId);
    const before = await history();
    await platform!.dispose();
    platform = undefined;
    const migrationDirectory = join(current, "failed-migrations");
    mkdirSync(migrationDirectory);
    for (const name of readdirSync(join(root, "migrations")).filter(
      (name) => name.endsWith(".sql") && name < "0031",
    ))
      copyFileSync(
        join(root, "migrations", name),
        join(migrationDirectory, name),
      );
    writeFileSync(
      join(migrationDirectory, "0031_commerce_order_notifications.sql"),
      readFileSync(
        join(root, "migrations/0031_commerce_order_notifications.sql"),
        "utf8",
      ) + "\nINSERT INTO notification_forced_absent_table VALUES(1);\n",
    );
    configPath = configuration(current, migrationDirectory);
    expect(() => migrate(current, configPath)).toThrow();
    await connect();
    expect(await history()).toEqual(before);
    expect(
      (
        await db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name LIKE 'commerce_notification_%'",
          )
          .all()
      ).results,
    ).toEqual([]);
  }, 30000);
  it("applies 0031 over filled 0030 without changing histories or rowids", async () => {
    await selectBaseline();
    const item = await paid();
    await refund(item.orderId);
    const before = await history();
    await platform!.dispose();
    platform = undefined;
    migrate(current, configPath);
    await connect();
    expect(await history()).toEqual(before);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  }, 30000);
});

it("serves real D1 simulated inbox and read-only status through protected HTTP with revoke and original lookup", async () => {
  const { orderId } = await paid();
  const before = await history();
  const env = {
    DB: db,
    COMMERCE_MODE: "local-test",
    COMMERCE_CHECKOUT_INSTANCE_ID: trusted.instanceId,
    COMMERCE_CHECKOUT_ORIGIN: notificationConfig.canonicalOrigin,
    COMMERCE_OWNER_NOTIFICATIONS_UI: "local-test",
    COMMERCE_OWNER_NOTIFICATIONS_WRITES: "local-test",
    COMMERCE_NOTIFICATION_LINK_SECRET: notificationConfig.linkSecret,
    COMMERCE_ORDER_STATUS_LINKS: "local-test",
  } as unknown as Env;
  const context = new RouterContextProvider();
  context.set(adminPrincipalContext, actor);
  context.set(cloudflareContext, { env, ctx: {} as ExecutionContext });
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 50000);
  const command = (
    operation: string,
    notificationId = "",
    intent = "apply",
    requestId = crypto.randomUUID(),
  ) =>
    new Request(
      `${notificationConfig.canonicalOrigin}/admin/commerce/orders/${orderId}/notifications/commands`,
      {
        method: "POST",
        headers: {
          Origin: notificationConfig.canonicalOrigin,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          operation,
          notificationId,
          intent,
          requestId,
        }),
      },
    );
  try {
    expect(
      (await actOwnerNotificationPage(command("prepare"), context, orderId))
        .status,
    ).toBe(200);
    const page = await loadOwnerNotificationPage(
      new Request(
        `${notificationConfig.canonicalOrigin}/admin/commerce/orders/${orderId}/notifications`,
      ),
      context,
      orderId,
    );
    const { detail } = (await page.json()) as {
      detail: import("./order-notification").OwnerNotificationDetail;
    };
    expect(detail.notifications).toHaveLength(1);
    const n = detail.notifications[0],
      token = n.statusUrl!.split("#")[1];
    expect(n.recipient).toBe("ontario@example.invalid");
    const failed = command("test_failed", n.id);
    expect(
      (await actOwnerNotificationPage(failed, context, orderId)).status,
    ).toBe(200);
    const deliveredId = crypto.randomUUID();
    const delivered = command("test_delivered", n.id, "apply", deliveredId);
    const replay = command("test_delivered", n.id, "apply", deliveredId);
    expect(
      (await actOwnerNotificationPage(delivered, context, orderId)).status,
    ).toBe(200);
    expect(
      (await actOwnerNotificationPage(replay, context, orderId)).status,
    ).toBe(200);
    const read = () =>
      actNotificationStatus(
        new Request(
          `${notificationConfig.canonicalOrigin}/checkout/status/read`,
          {
            method: "POST",
            headers: {
              Origin: notificationConfig.canonicalOrigin,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ token }),
          },
        ),
        env,
      );
    const response = await read();
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      status: Record<string, unknown>;
    };
    expect(Object.keys(payload.status).sort()).toEqual(
      [
        "orderId",
        "state",
        "paymentState",
        "fulfillment",
        "totalCents",
        "delivery",
        "refundedCents",
      ].sort(),
    );
    expect(payload.status.paymentState).toBe("succeeded");
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(
      (
        await actOwnerNotificationPage(
          command("revoke", n.id),
          context,
          orderId,
        )
      ).status,
    ).toBe(200);
    expect((await read()).status).toBe(404);
    expect(await history()).toEqual(before);
  } finally {
    clock.mockRestore();
  }
});

it("prepares bounded batches for more than100 supported canonical refund events", async () => {
  const { orderId } = await paid();
  for (let i = 0; i < 100; i++) await refund(orderId, 1);
  const before = await history();
  await apply(command(orderId));
  expect(await notificationCount()).toBe(100);
  expect((await read(orderId))!.canPrepare).toBe(true);
  await apply(command(orderId));
  expect(await notificationCount()).toBe(101);
  expect((await read(orderId))!.canPrepare).toBe(false);
  await apply(command(orderId));
  expect(await notificationCount()).toBe(101);
  expect(await history()).toEqual(before);
}, 30000);
