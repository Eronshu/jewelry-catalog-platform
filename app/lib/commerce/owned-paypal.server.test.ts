import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import { releaseTestCheckoutOrder } from "./checkout-release.server";
import {
  beginOwnedCheckoutPaymentAttempt as begin,
  beginTestPaymentAttempt as legacyBegin,
  type TestPaymentStartInput,
  type TrustedTestPaymentContext,
} from "./payment-start.server";
import { claimTestPaymentWork } from "./payment-work.server";
import { executeTestPaymentWork } from "./payment-executor.server";
import { createTestPaymentSimulator } from "./payment-simulator.server";
import { recordTestPaymentEvent } from "./payment-event-inbox.server";
import {
  startOwnedStripePayment as startStripe,
  reconcileOwnedStripePayment as reconcileStripe,
} from "./owned-stripe.server";
import {
  STRIPE_SANDBOX_API_VERSION,
  verifyStripeSandboxWebhook,
  type StripeSandboxConfig,
  type StripeSandboxFetch,
} from "./stripe-sandbox.server";

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
const worker = {
  mode: trusted.mode,
  instanceId: trusted.instanceId,
  provider: trusted.provider,
  accountRef: trusted.accountRef,
  workerId: "22222222-2222-4222-8222-222222222222",
};
const migrationName = "0023_commerce_owned_paypal.sql";
const migration = () =>
  readFileSync(join(root, "migrations", migrationName), "utf8");
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
async function selectBaseline() {
  await platform?.dispose();
  platform = undefined;
  rmSync(join(current, "state"), { recursive: true, force: true });
  cpSync(join(baseline, "state"), join(current, "state"), { recursive: true });
  await connect();
  await seedScope();
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
  baseline = join(directory, "empty-0022");
  mkdirSync(baseline);
  const oldMigrations = join(baseline, "migrations");
  mkdirSync(oldMigrations);
  for (const file of readdirSync(join(root, "migrations")).filter(
    (file) => file.endsWith(".sql") && file < "0023",
  ))
    copyFileSync(join(root, "migrations", file), join(oldMigrations, file));
  migrate(baseline, configuration(baseline, oldMigrations));
  upgraded = join(directory, "empty-0023");
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
async function held(legacy = false, multi = false) {
  const variantId = await fixture();
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
    deliveryMethod: "shipping",
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
const input = (reference: string): TestPaymentStartInput => ({
  requestId: crypto.randomUUID(),
  reference,
  expectedVersion: 1,
});
const rows = async (name: string) =>
  (await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results;
async function allHistory() {
  const tables = (
    await db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'commerce_%' ORDER BY name",
      )
      .all<{ name: string }>()
  ).results;
  return Object.fromEntries(
    await Promise.all(tables.map(async ({ name }) => [name, await rows(name)])),
  );
}
async function legacyHistory(query = false) {
  const item = await held(true),
    request = input(item.orderId);
  const started = await legacyBegin(db, trusted, request, now + 1);
  const claim = await claimTestPaymentWork(
    db,
    worker,
    {
      claimId: crypto.randomUUID(),
      requestId: started.requestId,
      expectedVersion: 1,
    },
    now + (query ? 700002 : 2),
  );
  await executeTestPaymentWork(
    db,
    worker,
    {
      claimId: claim.claimId,
      requestId: started.requestId,
      expectedVersion: claim.resultingVersion,
    },
    createTestPaymentSimulator([{ kind: "captured" }]),
    () => now + (query ? 700003 : 3),
  );
  await recordTestPaymentEvent(
    db,
    {
      mode: worker.mode,
      instanceId: worker.instanceId,
      provider: worker.provider,
      accountRef: worker.accountRef,
    },
    {
      eventRef: `fixture-event-${crypto.randomUUID()}`,
      kind: "unknown",
      providerObjectRef: null,
      candidateRequestId: null,
      capture: null,
      occurredAt: now + 4,
    },
    now + 4,
  );
  return { item, request, started };
}
async function upgrade(sql = migration()) {
  await platform?.dispose();
  platform = undefined;
  const migrations = join(current, "upgrade-migrations");
  mkdirSync(migrations);
  for (const file of readdirSync(join(root, "migrations")).filter(
    (file) => file.endsWith(".sql") && file < "0023",
  ))
    copyFileSync(join(root, "migrations", file), join(migrations, file));
  writeFileSync(join(migrations, migrationName), sql);
  configPath = configuration(current, migrations);
  try {
    migrate(current, configPath);
  } finally {
    await connect();
  }
}
async function order(id: string) {
  return db
    .prepare(
      "SELECT state,payment_state,version FROM commerce_orders WHERE id=?",
    )
    .bind(id)
    .first();
}
async function balance(id: string) {
  return db
    .prepare(
      "SELECT on_hand,facebook_reserved,checkout_reserved,allocated FROM commerce_inventory WHERE variant_id=?",
    )
    .bind(id)
    .first();
}
// Generated nonfunctional test values only. All HTTP is injected in memory.
const stripeConfig: StripeSandboxConfig = {
  enabled: true,
  mode: "local-test",
  instanceId: trusted.instanceId,
  expectedAccountId: "acct_FictionalOnly123",
  canonicalOrigin: "http://127.0.0.1:8791",
  testSecretKey: ["sk", "test", "0".repeat(24)].join("_"),
};
const target = (orderId: string) => ({ ownerHash: trusted.ownerHash, orderId });
async function prepared(multi = false) {
  const item = await held(false, multi);
  const command = input(item.orderId);
  await begin(db, paypalTrusted, command, () => now + 1);
  return { ...item, requestId: command.requestId };
}
async function stripeProvider(orderId: string) {
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
    account_ref: stripeConfig.expectedAccountId,
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
          : stripeConfig.expectedAccountId,
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
  async function event(eventId = `evt_${token}`) {
    const secret = ["whsec", "0".repeat(24)].join("_");
    const payload = {
      id: eventId,
      object: "event",
      api_version: STRIPE_SANDBOX_API_VERSION,
      livemode: false,
      type: "checkout.session.completed",
      created: now / 1000,
      data: { object: session() },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const signed = new TextEncoder().encode(
      `${now / 1000}.${JSON.stringify(payload)}`,
    );
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = Array.from(
      new Uint8Array(await crypto.subtle.sign("HMAC", key, signed)),
    )
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    return verifyStripeSandboxWebhook(
      {
        enabled: true,
        mode: "local-test",
        instanceId: stripeConfig.instanceId,
        expectedAccountId: stripeConfig.expectedAccountId,
        signingSecrets: [secret],
      },
      bytes,
      `t=${now / 1000},v1=${signature}`,
      () => now,
    );
  }
  return { state, call, event, sessionId, intentId, chargeId };
}
function faultDatabase(
  predicate: (sql: string) => boolean,
  phase: "before" | "after" | "unknown",
  method = "run",
) {
  let fired = false;
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          function wrap(statement: D1PreparedStatement): D1PreparedStatement {
            return new Proxy(statement, {
              get(s, k) {
                if (k === "bind")
                  return (...values: unknown[]) => wrap(s.bind(...values));
                const fn = Reflect.get(s, k);
                if (k === method)
                  return async (...args: unknown[]) => {
                    const should = !fired && predicate(sql);
                    if (should) {
                      fired = true;
                      if (phase === "before")
                        throw new Error("SQL private fault");
                    }
                    const result = await fn.apply(s, args);
                    if (should && phase === "unknown")
                      return { success: true, meta: {} };
                    if (should) throw new Error("SQL private committed fault");
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
async function inventoryTotals() {
  return (
    await db
      .prepare("SELECT * FROM commerce_inventory ORDER BY variant_id")
      .all()
  ).results;
}

import {
  startOwnedPayPalPayment as start,
  reconcileOwnedPayPalPayment as reconcile,
  captureOwnedPayPalPayment as capture,
  readOwnedPayPalPayment as read,
  recordOwnedPayPalEvent as recordEvent,
} from "./owned-paypal.server";
import {
  type PayPalSandboxConfig,
  type PayPalSandboxFetch,
  verifyPayPalSandboxWebhook,
} from "./paypal-sandbox.server";
const paypalTrusted = {
  ...trusted,
  provider: "paypal" as const,
  accountRef: "fixture-paypal",
};
const config: PayPalSandboxConfig = {
  enabled: true,
  mode: "local-test",
  instanceId: trusted.instanceId,
  expectedMerchantId: "2222222222222",
  clientId: "0".repeat(24),
  clientSecret: "1".repeat(24),
  canonicalOrigin: "http://127.0.0.1:8791",
};
async function provider(orderId: string) {
  const a = (await db
    .prepare(
      "SELECT request_id AS requestId,create_operation_key AS key,amount_cents AS amount FROM commerce_payment_attempts WHERE order_id=?",
    )
    .bind(orderId)
    .first<{ requestId: string; key: string; amount: number }>())!;
  const token = a.requestId.replaceAll("-", "").slice(0, 16).toUpperCase(),
    providerOrderId = `O${token}`,
    captureId = `C${token}`;
  const customId = `local-test:${config.instanceId}:${a.requestId}:${a.key}`,
    money = { currency_code: "CAD", value: (a.amount / 100).toFixed(2) };
  const state = {
    status: "CREATED",
    loseCreate: false,
    loseCapture: false,
    refunded: false,
    wrongMerchant: false,
  };
  const unit = () => ({
    reference_id: orderId,
    custom_id: customId,
    amount: money,
    payee: {
      merchant_id: state.wrongMerchant
        ? "3333333333333"
        : config.expectedMerchantId,
    },
    ...(state.status === "COMPLETED"
      ? {
          payments: {
            captures: [
              {
                id: captureId,
                status: state.refunded ? "REFUNDED" : "COMPLETED",
                final_capture: true,
                amount: money,
              },
            ],
            refunds: state.refunded ? [{ id: "REFUND" }] : [],
          },
        }
      : {}),
  });
  const order = () => ({
    id: providerOrderId,
    intent: "CAPTURE",
    status: state.status,
    purchase_units: [unit()],
    links: [
      {
        rel: "approve",
        method: "GET",
        href: `https://www.sandbox.paypal.com/checkoutnow?token=${providerOrderId}`,
      },
    ],
  });
  const call = vi.fn<PayPalSandboxFetch>(async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/v1/oauth2/token")
      return Response.json({
        access_token: "2".repeat(32),
        token_type: "Bearer",
        expires_in: 300,
      });
    if (path === "/v2/checkout/orders" && init.method === "POST") {
      const body = JSON.parse(init.body as string);
      expect(body.purchase_units[0].custom_id).toBe(customId);
      expect(body.purchase_units[0].reference_id).toBe(orderId);
      expect(body.purchase_units[0].amount).toEqual(money);
      expect(new Headers(init.headers).get("PayPal-Request-Id")).toBe(a.key);
      if (state.loseCreate) throw new Error("Synthetic response lost");
      return Response.json(order());
    }
    if (path === `/v2/checkout/orders/${providerOrderId}`)
      return Response.json(order());
    if (path === `/v2/checkout/orders/${providerOrderId}/capture`) {
      expect(init.method).toBe("POST");
      const original = await db
        .prepare(
          "SELECT capture_operation_key AS key FROM commerce_owned_paypal_associations WHERE attempt_command_id=?",
        )
        .bind(`payment-start-${a.requestId}`)
        .first<{ key: string }>();
      expect(new Headers(init.headers).get("PayPal-Request-Id")).toBe(
        original!.key,
      );
      expect(original!.key).not.toBe(a.key);
      state.status = "COMPLETED";
      if (state.loseCapture)
        throw new Error("Synthetic committed capture response lost");
      return Response.json(order());
    }
    if (path === `/v2/payments/captures/${captureId}`)
      return Response.json({
        id: captureId,
        status: state.refunded ? "REFUNDED" : "COMPLETED",
        final_capture: true,
        amount: money,
        payee: { merchant_id: config.expectedMerchantId },
        supplementary_data: { related_ids: { order_id: providerOrderId } },
        custom_id: customId,
      });
    if (path === "/v1/notifications/verify-webhook-signature")
      return Response.json({ verification_status: "SUCCESS" });
    throw new Error("Unexpected injected path");
  });
  const event = () =>
    verifyPayPalSandboxWebhook(
      config,
      {
        webhookId: "FICTIONALWEBHOOK",
        rawBody: new TextEncoder().encode(
          JSON.stringify({
            id: `WH-${token}`,
            event_type: "CHECKOUT.ORDER.APPROVED",
            resource: order(),
          }),
        ),
        headers: new Headers({
          "paypal-cert-url":
            "https://api.sandbox.paypal.com/v1/notifications/certs/fictional",
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-transmission-id": "fictional-transmission",
          "paypal-transmission-sig": "AAAA",
          "paypal-transmission-time": "2026-10-31T10:00:00Z",
        }),
      },
      call,
    );
  return { state, call, event, providerOrderId, captureId };
}
async function opened() {
  const item = await prepared(),
    p = await provider(item.orderId);
  await start(db, config, target(item.orderId), p.call, () => now + 2);
  return { item, p };
}
async function approved() {
  const { item, p } = await opened();
  p.state.status = "APPROVED";
  expect(
    await reconcile(
      db,
      config,
      target(item.orderId),
      p.call,
      () => now + 30002,
    ),
  ).toMatchObject({ state: "approved", canCapture: true });
  return { item, p };
}
const mutations = (p: Awaited<ReturnType<typeof provider>>, suffix: string) =>
  p.call.mock.calls.filter(
    ([url, init]) => url.endsWith(suffix) && init.method === "POST",
  );
describe("owned PayPal on actual local D1 and injected provider transport", () => {
  it("preserves populated Stripe/legacy financial dependencies and paid inventory through 0023", async () => {
    await selectBaseline();
    await legacyHistory();
    const item = await held();
    await begin(db, trusted, input(item.orderId), () => now + 1);
    const p = await stripeProvider(item.orderId);
    await startStripe(
      db,
      stripeConfig,
      target(item.orderId),
      p.call,
      () => now + 2,
    );
    p.state.paid = true;
    expect(
      await reconcileStripe(
        db,
        stripeConfig,
        target(item.orderId),
        p.call,
        () => now + 30002,
      ),
    ).toMatchObject({ state: "paid" });
    const before = await allHistory();
    await upgrade();
    const after = await allHistory();
    for (const [name, history] of Object.entries(before))
      expect(after[name]).toEqual(history);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
    expect(await balance(item.variantId)).toMatchObject({
      checkout_reserved: 0,
      allocated: 1,
    });
    await expect(
      db
        .prepare("UPDATE commerce_inventory SET allocated=0 WHERE variant_id=?")
        .bind(item.variantId)
        .run(),
    ).rejects.toThrow();
    const second = await held();
    await begin(db, trusted, input(second.orderId), () => now + 1);
    const q = await stripeProvider(second.orderId);
    await startStripe(
      db,
      stripeConfig,
      target(second.orderId),
      q.call,
      () => now + 2,
    );
    q.state.paid = true;
    expect(
      await reconcileStripe(
        db,
        stripeConfig,
        target(second.orderId),
        q.call,
        () => now + 30002,
      ),
    ).toMatchObject({ state: "paid" });
  }, 30000);
  it("rolls back a failed actual fact-table rebuild without losing prior Stripe history or guards", async () => {
    await selectBaseline();
    await legacyHistory();
    const before = await allHistory(),
      schema = (
        await db
          .prepare(
            "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name LIKE 'commerce_%' ORDER BY name",
          )
          .all()
      ).results;
    await expect(
      upgrade(
        migration().replace(
          "DROP TABLE commerce_capture_backup_0023;",
          "DROP TABLE commerce_capture_backup_0023; INSERT INTO missing_0023 VALUES(1);",
        ),
      ),
    ).rejects.toThrow();
    expect(await allHistory()).toEqual(before);
    expect(
      (
        await db
          .prepare(
            "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name LIKE 'commerce_%' ORDER BY name",
          )
          .all()
      ).results,
    ).toEqual(schema);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  }, 30000);
  it("creates once, queries APPROVED without charging, then explicit capture canonical verification pays/allocates exactly once", async () => {
    const item = await held();
    expect(
      await read(db, config, trusted.ownerHash, item.orderId),
    ).toMatchObject({
      state: "not_started",
      canStart: true,
      canCapture: false,
    });
    await begin(db, paypalTrusted, input(item.orderId), () => now + 1);
    const p = await provider(item.orderId);
    expect(
      await start(db, config, target(item.orderId), p.call, () => now + 2),
    ).toMatchObject({ state: "open", canStart: false, canCapture: false });
    await start(db, config, target(item.orderId), p.call, () => now + 3);
    expect(mutations(p, "/v2/checkout/orders")).toHaveLength(1);
    p.state.status = "APPROVED";
    expect(
      await reconcile(
        db,
        config,
        target(item.orderId),
        p.call,
        () => now + 30002,
      ),
    ).toMatchObject({ state: "approved", canCapture: true });
    expect(mutations(p, "/capture")).toEqual([]);
    expect(await balance(item.variantId)).toMatchObject({
      checkout_reserved: 1,
      allocated: 0,
    });
    const result = await capture(
      db,
      config,
      target(item.orderId),
      p.call,
      () => now + 30003,
    );
    expect(result).toEqual({
      state: "paid",
      canStart: false,
      canQuery: false,
      canCapture: false,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /owner|merchant|account|attempt|token|key|secret|snapshot/,
    );
    expect(await balance(item.variantId)).toMatchObject({
      on_hand: 4,
      facebook_reserved: 0,
      checkout_reserved: 0,
      allocated: 1,
    });
    expect(await order(item.orderId)).toMatchObject({
      state: "confirmed",
      payment_state: "succeeded",
      version: 3,
    });
    expect((await rows("commerce_payment_capture_facts"))[0]).toMatchObject({
      provider: "paypal",
      account_ref: config.expectedMerchantId,
      transaction_ref: p.captureId,
      actual_amount_cents: 4406,
      payment_intent_ref: null,
    });
    await capture(db, config, target(item.orderId), p.call, () => now + 40000);
    await reconcile(
      db,
      config,
      target(item.orderId),
      p.call,
      () => now + 60002,
    );
    expect(mutations(p, "/capture")).toHaveLength(1);
    expect(await rows("commerce_payment_capture_facts")).toHaveLength(1);
  });
  it("one canonical intent wins Stripe/PayPal competition and wrong owners/scopes never dispatch", async () => {
    const item = await held(),
      a = input(item.orderId),
      b = input(item.orderId);
    const raced = await Promise.allSettled([
      begin(db, trusted, a, () => now + 1),
      begin(db, paypalTrusted, b, () => now + 1),
    ]);
    expect(raced.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await rows("commerce_payment_attempts")).toHaveLength(1);
    const chosen = (await rows("commerce_payment_attempts"))[0].provider;
    if (chosen === "stripe")
      expect(
        await read(db, config, trusted.ownerHash, item.orderId),
      ).toMatchObject({
        state: "review_required",
        canStart: false,
        canQuery: false,
        canCapture: false,
      });
    const fresh = await prepared(),
      p = await provider(fresh.orderId);
    expect(await read(db, config, "b".repeat(64), fresh.orderId)).toBeNull();
    expect(
      await read(
        db,
        { ...config, instanceId: crypto.randomUUID() },
        trusted.ownerHash,
        fresh.orderId,
      ),
    ).toBeNull();
    await expect(
      start(
        db,
        config,
        { ...target(fresh.orderId), ownerHash: "b".repeat(64) },
        p.call,
        () => now + 2,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      start(
        db,
        { ...config, enabled: false } as unknown as PayPalSandboxConfig,
        target(fresh.orderId),
        p.call,
        () => now + 2,
      ),
    ).rejects.toMatchObject({ code: "invalid_config" });
    expect(p.call).not.toHaveBeenCalled();
  });
  it("unknown CREATE is never recreated and a verified same-scope order event recovers via canonical GET without auto-capture", async () => {
    const item = await prepared(),
      p = await provider(item.orderId);
    p.state.loseCreate = true;
    expect(
      await start(db, config, target(item.orderId), p.call, () => now + 2),
    ).toMatchObject({ state: "review_required", canCapture: false });
    await start(db, config, target(item.orderId), p.call, () => now + 1000);
    expect(mutations(p, "/v2/checkout/orders")).toHaveLength(1);
    p.state.status = "APPROVED";
    const verified = await p.event();
    await recordEvent(db, config, verified, p.call, () => now + 30002);
    expect(
      await read(db, config, trusted.ownerHash, item.orderId),
    ).toMatchObject({ state: "approved", canCapture: true });
    expect(mutations(p, "/capture")).toEqual([]);
    await recordEvent(db, config, verified, p.call, () => now + 60002);
    expect(await rows("commerce_owned_paypal_events")).toHaveLength(1);
    expect(await rows("commerce_payment_capture_facts")).toEqual([]);
    expect(await balance(item.variantId)).toMatchObject({
      checkout_reserved: 1,
      allocated: 0,
    });
  });
  it("unknown CAPTURE is query-only even when later provider approval still appears; canonical completed query finalizes", async () => {
    const { item, p } = await approved();
    p.state.loseCapture = true;
    expect(
      await capture(
        db,
        config,
        target(item.orderId),
        p.call,
        () => now + 30003,
      ),
    ).toMatchObject({ state: "review_required", canCapture: false });
    p.state.status = "APPROVED";
    await capture(db, config, target(item.orderId), p.call, () => now + 30004);
    expect(mutations(p, "/capture")).toHaveLength(1);
    p.state.status = "COMPLETED";
    expect(
      await reconcile(
        db,
        config,
        target(item.orderId),
        p.call,
        () => now + 60002,
      ),
    ).toMatchObject({ state: "paid" });
    expect(await balance(item.variantId)).toMatchObject({
      allocated: 1,
      checkout_reserved: 0,
    });
  });
  it("requires acknowledged exact durable CREATE/CAPTURE boundaries; silent IGNORE/readback loss never grants mutation", async () => {
    const item = await prepared(),
      p = await provider(item.orderId);
    await db
      .prepare(
        "CREATE TRIGGER ignore_paypal_create BEFORE INSERT ON commerce_owned_paypal_dispatches BEGIN SELECT RAISE(IGNORE); END",
      )
      .run();
    await expect(
      start(db, config, target(item.orderId), p.call, () => now + 2),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(p.call).not.toHaveBeenCalled();
    await db.prepare("DROP TRIGGER ignore_paypal_create").run();
    const lost = faultDatabase(
      (sql) => sql.includes("INSERT INTO commerce_owned_paypal_dispatches"),
      "after",
    );
    await start(lost, config, target(item.orderId), p.call, () => now + 2);
    await start(db, config, target(item.orderId), p.call, () => now + 3);
    expect(p.call).not.toHaveBeenCalled();
    const second = await approved();
    await db
      .prepare(
        "CREATE TRIGGER ignore_paypal_capture BEFORE INSERT ON commerce_owned_paypal_capture_dispatches BEGIN SELECT RAISE(IGNORE); END",
      )
      .run();
    await expect(
      capture(
        db,
        config,
        target(second.item.orderId),
        second.p.call,
        () => now + 30003,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(mutations(second.p, "/capture")).toEqual([]);
    await db.prepare("DROP TRIGGER ignore_paypal_capture").run();
    const lostCapture = faultDatabase(
      (sql) =>
        sql.includes("INSERT INTO commerce_owned_paypal_capture_dispatches"),
      "after",
    );
    expect(
      await capture(
        lostCapture,
        config,
        target(second.item.orderId),
        second.p.call,
        () => now + 30004,
      ),
    ).toMatchObject({ canCapture: false });
    await capture(
      db,
      config,
      target(second.item.orderId),
      second.p.call,
      () => now + 30005,
    );
    expect(mutations(second.p, "/capture")).toEqual([]);
  });
  it("unknown mutation acknowledgements and exact-receipt readback failure never grant CREATE or CAPTURE", async () => {
    const item = await prepared(),
      p = await provider(item.orderId);
    const unknownCreate = faultDatabase(
      (sql) => sql.includes("INSERT INTO commerce_owned_paypal_dispatches"),
      "unknown",
    );
    expect(
      await start(
        unknownCreate,
        config,
        target(item.orderId),
        p.call,
        () => now + 2,
      ),
    ).toMatchObject({ state: "review_required" });
    expect(p.call).not.toHaveBeenCalled();
    const second = await approved();
    const unknownCapture = faultDatabase(
      (sql) =>
        sql.includes("INSERT INTO commerce_owned_paypal_capture_dispatches"),
      "unknown",
    );
    expect(
      await capture(
        unknownCapture,
        config,
        target(second.item.orderId),
        second.p.call,
        () => now + 30003,
      ),
    ).toMatchObject({ canCapture: false });
    expect(mutations(second.p, "/capture")).toEqual([]);
    const third = await approved();
    const readFailure = faultDatabase(
      (sql) => sql.includes("SELECT d.receipt_id AS id"),
      "before",
      "first",
    );
    expect(
      await capture(
        readFailure,
        config,
        target(third.item.orderId),
        third.p.call,
        () => now + 30003,
      ),
    ).toMatchObject({ canCapture: false });
    await capture(
      db,
      config,
      target(third.item.orderId),
      third.p.call,
      () => now + 30004,
    );
    expect(mutations(third.p, "/capture")).toEqual([]);
  });
  it("concurrent capture callers and replaced query claims cannot duplicate transport or allocate twice", async () => {
    const { item, p } = await approved();
    const result = await Promise.allSettled([
      capture(db, config, target(item.orderId), p.call, () => now + 30003),
      capture(db, config, target(item.orderId), p.call, () => now + 30003),
    ]);
    expect(
      result.some((r) => r.status === "fulfilled" && r.value.state === "paid"),
    ).toBe(true);
    expect(mutations(p, "/capture")).toHaveLength(1);
    expect(await rows("commerce_payment_capture_facts")).toHaveLength(1);
    const second = await approved();
    let reached!: () => void, resume!: () => void;
    const enter = new Promise<void>((r) => (reached = r)),
      wait = new Promise<void>((r) => (resume = r));
    let tick = now + 30003;
    const slow: PayPalSandboxFetch = async (url, init) => {
      if (url.includes("/v2/payments/captures/")) {
        reached();
        await wait;
      }
      return second.p.call(url, init);
    };
    const first = capture(
      db,
      config,
      target(second.item.orderId),
      slow,
      () => tick,
    ).catch((e) => e);
    await enter;
    tick = now + 70002;
    expect(
      await reconcile(
        db,
        config,
        target(second.item.orderId),
        second.p.call,
        () => tick,
      ),
    ).toMatchObject({ state: "paid" });
    resume();
    await first;
    expect(await balance(second.item.variantId)).toMatchObject({
      checkout_reserved: 0,
      allocated: 1,
    });
  });
  it("attention arriving during approval GET or final authorization forbids capture transport and retains the hold", async () => {
    for (const phase of ["approval", "final-authorization"] as const) {
      const { item, p } = await approved();
      let injected = false;
      const inject = async () => {
        if (injected) return;
        injected = true;
        await expect(
          recordEvent(
            db,
            config,
            {
              testOnly: true,
              eventId: `WH-RACE-${phase}`,
              eventType: "PAYMENT.CAPTURE.DENIED",
              providerOrderId: p.providerOrderId,
              captureId: null,
            },
            p.call,
            () => now + 30003,
          ),
        ).rejects.toMatchObject({ code: "unavailable" });
      };
      const duringApproval: PayPalSandboxFetch = async (url, init) => {
        if (
          phase === "approval" &&
          new URL(url).pathname === `/v2/checkout/orders/${p.providerOrderId}`
        )
          await inject();
        return p.call(url, init);
      };
      const result = await capture(
        db,
        config,
        target(item.orderId),
        duringApproval,
        () => now + 30003,
        async () => {
          if (
            phase === "final-authorization" &&
            (await rows("commerce_owned_paypal_capture_dispatches")).some(
              (row) =>
                row.attempt_command_id === `payment-start-${item.requestId}`,
            )
          )
            await inject();
        },
      ).catch((error) => error);
      expect(injected).toBe(true);
      if (phase === "approval")
        expect(result).toMatchObject({ code: "unavailable" });
      else
        expect(result).toMatchObject({
          state: "review_required",
          canCapture: false,
        });
      expect(mutations(p, "/capture")).toEqual([]);
      expect(
        await read(db, config, trusted.ownerHash, item.orderId),
      ).toMatchObject({ state: "review_required", canCapture: false });
      expect(await balance(item.variantId)).toMatchObject({
        checkout_reserved: 1,
        allocated: 0,
      });
      expect(
        (await rows("commerce_payment_capture_facts")).filter(
          (f) => f.attempt_command_id === `payment-start-${item.requestId}`,
        ),
      ).toEqual([]);
    }
  });
  it("checks capture attention after the adapter's internal approval GET, immediately before POST", async () => {
    const { item, p } = await approved();
    let gets = 0;
    const transport: PayPalSandboxFetch = async (url, init) => {
      if (
        new URL(url).pathname === `/v2/checkout/orders/${p.providerOrderId}` &&
        ++gets === 2
      ) {
        await expect(
          recordEvent(
            db,
            config,
            {
              testOnly: true,
              eventId: "WH-INTERNAL-GET",
              eventType: "PAYMENT.CAPTURE.REVERSED",
              providerOrderId: p.providerOrderId,
              captureId: null,
            },
            p.call,
            () => now + 30003,
          ),
        ).rejects.toMatchObject({ code: "unavailable" });
      }
      return p.call(url, init);
    };
    await expect(
      capture(db, config, target(item.orderId), transport, () => now + 30003),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(gets).toBe(2);
    expect(mutations(p, "/capture")).toEqual([]);
    expect(await rows("commerce_owned_paypal_capture_dispatches")).toHaveLength(
      1,
    );
    expect(await balance(item.variantId)).toMatchObject({
      checkout_reserved: 1,
      allocated: 0,
    });
    await capture(db, config, target(item.orderId), p.call, () => now + 30004);
    expect(mutations(p, "/capture")).toEqual([]);
  });
  it("reauthorizes and samples fresh CREATE eligibility after OAuth, with no POST after revocation or elapsed deadline", async () => {
    for (const phase of ["revoked", "expired"] as const) {
      const item = await prepared(),
        p = await provider(item.orderId);
      let tick = now + 2,
        revoked = false;
      const denied = new Error("Synthetic authorization revoked during OAuth");
      const transport: PayPalSandboxFetch = async (url, init) => {
        const response = await p.call(url, init);
        if (new URL(url).pathname === "/v1/oauth2/token") {
          if (phase === "revoked") revoked = true;
          else tick = now + 600002;
        }
        return response;
      };
      const result = await start(
        db,
        config,
        target(item.orderId),
        transport,
        () => tick,
        async () => {
          if (revoked) throw denied;
        },
      ).catch((error) => error);
      if (phase === "revoked") expect(result).toBe(denied);
      else expect(result).toMatchObject({ code: "unavailable" });
      expect(mutations(p, "/v2/checkout/orders")).toEqual([]);
      expect(await balance(item.variantId)).toMatchObject({
        checkout_reserved: 1,
        allocated: 0,
      });
      await start(db, config, target(item.orderId), p.call, () => tick);
      expect(mutations(p, "/v2/checkout/orders")).toEqual([]);
    }
  });
  it("fresh authorization after dispatch can stop transport and consumed capture remains query-only", async () => {
    const { item, p } = await approved(),
      revoked = new Error("Synthetic revoked session");
    await expect(
      capture(
        db,
        config,
        target(item.orderId),
        p.call,
        () => now + 30003,
        async () => {
          if ((await rows("commerce_owned_paypal_capture_dispatches")).length)
            throw revoked;
        },
      ),
    ).rejects.toBe(revoked);
    expect(mutations(p, "/capture")).toEqual([]);
    expect(await rows("commerce_owned_paypal_capture_dispatches")).toHaveLength(
      1,
    );
    await capture(db, config, target(item.orderId), p.call, () => now + 30004);
    expect(mutations(p, "/capture")).toEqual([]);
    expect(await balance(item.variantId)).toMatchObject({
      checkout_reserved: 1,
      allocated: 0,
    });
    await expect(
      releaseTestCheckoutOrder(
        db,
        owner,
        {
          releaseKey: crypto.randomUUID(),
          orderId: item.orderId,
          kind: "expire",
          expectedVersion: 2,
        },
        () => now + 999999,
      ),
    ).rejects.toThrow();
  });
  it("canonical refund/mismatch and ignored multi-line allocation retain holds; later valid query can atomically allocate", async () => {
    const item = await prepared(true),
      p = await provider(item.orderId);
    await start(db, config, target(item.orderId), p.call, () => now + 2);
    p.state.status = "COMPLETED";
    p.state.refunded = true;
    expect(
      await reconcile(
        db,
        config,
        target(item.orderId),
        p.call,
        () => now + 30002,
      ),
    ).toMatchObject({ state: "review_required" });
    expect(await rows("commerce_payment_capture_facts")).toEqual([]);
    p.state.refunded = false;
    const balances = await inventoryTotals(),
      commands = await rows("commerce_commands"),
      movements = await rows("commerce_stock_movements");
    await db
      .prepare(
        "CREATE TRIGGER ignore_paypal_allocate BEFORE INSERT ON commerce_stock_movements WHEN NEW.kind='allocate' AND NEW.position=1 BEGIN SELECT RAISE(IGNORE); END",
      )
      .run();
    expect(
      await reconcile(
        db,
        config,
        target(item.orderId),
        p.call,
        () => now + 60002,
      ),
    ).toMatchObject({ state: "review_required" });
    expect(await inventoryTotals()).toEqual(balances);
    expect(await rows("commerce_commands")).toEqual(commands);
    expect(await rows("commerce_stock_movements")).toEqual(movements);
    expect(await rows("commerce_payment_capture_facts")).toEqual([]);
    await db.prepare("DROP TRIGGER ignore_paypal_allocate").run();
    expect(
      await reconcile(
        db,
        config,
        target(item.orderId),
        p.call,
        () => now + 90002,
      ),
    ).toMatchObject({ state: "paid" });
  });
  it("refund wakeup preserves historical paid fact and allocated stock but exposes manual review without automatic refund", async () => {
    const { item, p } = await approved();
    await capture(db, config, target(item.orderId), p.call, () => now + 30003);
    const before = await inventoryTotals();
    await expect(
      recordEvent(
        db,
        config,
        {
          testOnly: true,
          eventId: "WH-REFUND",
          eventType: "PAYMENT.CAPTURE.REFUNDED",
          providerOrderId: null,
          captureId: p.captureId,
        },
        p.call,
        () => now + 60003,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(
      await read(db, config, trusted.ownerHash, item.orderId),
    ).toMatchObject({ state: "review_required", canCapture: false });
    expect(await rows("commerce_payment_capture_facts")).toHaveLength(1);
    expect(await inventoryTotals()).toEqual(before);
  });
  it("raw SQL/source fences keep old simulator closed and cannot mutate receipt identity, add movement, or steal allocated stock", async () => {
    const { item, p } = await approved();
    const d = (await rows("commerce_owned_paypal_dispatches")).at(-1)!;
    await expect(
      executeTestPaymentWork(
        db,
        {
          ...worker,
          provider: "paypal",
          accountRef: "fixture-paypal",
          workerId: d.worker_id as string,
        },
        {
          claimId: d.claim_id as string,
          requestId: item.requestId,
          expectedVersion: 3,
        },
        createTestPaymentSimulator([{ kind: "captured" }]),
        () => now + 30003,
      ),
    ).rejects.toThrow();
    expect(await rows("commerce_payment_execution_starts")).toEqual([]);
    await capture(db, config, target(item.orderId), p.call, () => now + 30003);
    for (const table of [
      "commerce_owned_paypal_associations",
      "commerce_owned_paypal_dispatches",
      "commerce_owned_paypal_orders",
      "commerce_owned_paypal_status",
      "commerce_owned_paypal_capture_dispatches",
    ]) {
      await expect(db.prepare(`DELETE FROM ${table}`).run()).rejects.toThrow();
      await expect(
        db
          .prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)
          .run(),
      ).rejects.toThrow();
    }
    await expect(
      db
        .prepare(
          "INSERT OR REPLACE INTO commerce_inventory(variant_id,on_hand) VALUES(?,4)",
        )
        .bind(item.variantId)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare("UPDATE commerce_inventory SET allocated=0 WHERE variant_id=?")
        .bind(item.variantId)
        .run(),
    ).rejects.toThrow();
    const f = (await rows("commerce_payment_capture_facts"))[0];
    await expect(
      db
        .prepare(
          "INSERT INTO commerce_stock_movements(command_id,position,variant_id,kind,quantity,reason) VALUES(?,99,?,'allocate',1,'Fake')",
        )
        .bind(`paypal-allocate-${f.id}`, item.variantId)
        .run(),
    ).rejects.toThrow();
  });
});
