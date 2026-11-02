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
const migrationName = "0026_commerce_owner_stripe_refunds.sql";
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
  baseline = join(directory, "baseline-0025");
  mkdirSync(baseline);
  const oldMigrations = join(baseline, "migrations");
  mkdirSync(oldMigrations);
  for (const file of readdirSync(join(root, "migrations")).filter(
    (file) => file.endsWith(".sql") && file < "0026",
  ))
    copyFileSync(join(root, "migrations", file), join(oldMigrations, file));
  migrate(baseline, configuration(baseline, oldMigrations));
  upgraded = join(directory, "upgraded-0026");
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
    (file) => file.endsWith(".sql") && file < "0026",
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

import {
  startOwnedStripePayment,
  reconcileOwnedStripePayment,
} from "./owned-stripe.server";
import type {
  StripeSandboxConfig,
  StripeSandboxFetch,
} from "./stripe-sandbox.server";
import {
  startOwnedPayPalPayment,
  captureOwnedPayPalPayment,
  reconcileOwnedPayPalPayment,
} from "./owned-paypal.server";
import type {
  PayPalSandboxConfig,
  PayPalSandboxFetch,
} from "./paypal-sandbox.server";
import {
  applyOwnerFulfillment,
  readOwnerFulfillment,
} from "./owner-fulfillment.server";
import type {
  OwnerFulfillmentInput,
  OwnerFulfillmentOperation,
} from "./owner-fulfillment";
// Generated nonfunctional test values only. All HTTP is injected in memory.
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
const paypalConfig: PayPalSandboxConfig = {
  enabled: true,
  mode: "local-test",
  instanceId: trusted.instanceId,
  expectedMerchantId: "2222222222222",
  clientId: "0".repeat(24),
  clientSecret: "1".repeat(24),
  canonicalOrigin: "http://127.0.0.1:8791",
};
async function paypalProvider(orderId: string) {
  const a = (await db
    .prepare(
      "SELECT request_id AS requestId,create_operation_key AS key,amount_cents AS amount FROM commerce_payment_attempts WHERE order_id=?",
    )
    .bind(orderId)
    .first<{ requestId: string; key: string; amount: number }>())!;
  const token = a.requestId.replaceAll("-", "").slice(0, 16).toUpperCase(),
    providerOrderId = `O${token}`,
    captureId = `C${token}`;
  const customId = `local-test:${paypalConfig.instanceId}:${a.requestId}:${a.key}`,
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
        : paypalConfig.expectedMerchantId,
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
        payee: { merchant_id: paypalConfig.expectedMerchantId },
        supplementary_data: { related_ids: { order_id: providerOrderId } },
        custom_id: customId,
      });
    if (path === "/v1/notifications/verify-webhook-signature")
      return Response.json({ verification_status: "SUCCESS" });
    throw new Error("Unexpected injected path");
  });

  return { state, call, providerOrderId, captureId };
}
const actor = { email: "fictional-owner@example.test", sub: "fixture-owner" };
const scope = { mode: "local-test" as const, instanceId: trusted.instanceId };
async function paid(
  delivery: "pickup" | "local_delivery" | "shipping" = "shipping",
  multi = false,
  paypal = false,
  providedVariantId?: string,
  checkNewModel = true,
) {
  const item = await held(false, multi, delivery, providedVariantId);
  await begin(
    db,
    paypal
      ? { ...trusted, provider: "paypal", accountRef: "fixture-paypal" }
      : trusted,
    input(item.orderId),
    () => now + 1,
  );
  if (paypal) {
    const p = await paypalProvider(item.orderId);
    await startOwnedPayPalPayment(
      db,
      paypalConfig,
      target(item.orderId),
      p.call,
      () => now + 2,
    );
    p.state.status = "APPROVED";
    await reconcileOwnedPayPalPayment(
      db,
      paypalConfig,
      target(item.orderId),
      p.call,
      () => now + 30002,
    );
    await captureOwnedPayPalPayment(
      db,
      paypalConfig,
      target(item.orderId),
      p.call,
      () => now + 30003,
    );
  } else {
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
  }
  if (checkNewModel)
    expect(await readOwnerFulfillment(db, scope, item.orderId)).toMatchObject({
      state: "ready_to_pack",
      version: 3,
    });
  return item;
}
async function request(
  orderId: string,
  operation: OwnerFulfillmentOperation = "pack",
): Promise<OwnerFulfillmentInput> {
  return {
    requestId: crypto.randomUUID(),
    orderId,
    operation,
    expectedVersion: (await readOwnerFulfillment(db, scope, orderId))!.version,
    acknowledge: true,
  };
}
const apply = (i: OwnerFulfillmentInput) =>
  applyOwnerFulfillment(db, scope, actor, i, () => now + 40000);
const balance = (variantId: string) =>
  db
    .prepare(
      "SELECT on_hand,facebook_reserved,checkout_reserved,allocated FROM commerce_inventory WHERE variant_id=?",
    )
    .bind(variantId)
    .first();
import {
  readOwnerRefund,
  startOwnerStripeRefund,
  reconcileOwnerStripeRefund,
  lookupOwnerRefundCommand,
} from "./owner-refund.server";
import type { OwnerRefundInput } from "./owner-refund";
const refundInput = async (orderId: string): Promise<OwnerRefundInput> => ({
  requestId: crypto.randomUUID(),
  orderId,
  expectedVersion: (await readOwnerRefund(db, scope, orderId))!.orderVersion,
  acknowledge: true,
});
async function refundProvider(orderId: string) {
  const p = await provider(orderId);
  p.state.paid = true;
  const state = {
    status: "succeeded",
    refunded: true,
    losePost: false,
    wrong: false,
    postCount: 0,
    refundId: "re_FictionalRefund123",
  };
  let metadata: Record<string, string> = {};
  const refund = () => ({
    id: state.refundId,
    object: "refund",
    charge: p.chargeId,
    payment_intent: p.intentId,
    currency: "cad",
    amount: amount,
    status: state.status,
    metadata: state.wrong ? {} : metadata,
  });
  const amount = (await readOwnerRefund(db, scope, orderId))!.amountCents;
  const call = vi.fn<StripeSandboxFetch>(async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/v1/refunds" && init.method === "POST") {
      state.postCount++;
      const body = new URLSearchParams(init.body as string);
      expect(body.get("charge")).toBe(p.chargeId);
      expect(body.get("amount")).toBe(String(amount));
      metadata = Object.fromEntries(
        [...body]
          .filter(([k]) => k.startsWith("metadata["))
          .map(([k, v]) => [k.slice(9, -1), v]),
      );
      expect(new Headers(init.headers).get("Idempotency-Key")).toBe(
        metadata.refund_operation_key,
      );
      if (state.losePost) throw new Error("Synthetic committed response lost");
      return Response.json(refund());
    }
    if (path === `/v1/refunds/${state.refundId}`)
      return Response.json(refund());
    if (path === "/v1/refunds")
      return Response.json({
        object: "list",
        data: [refund()],
        has_more: false,
      });
    const response = await p.call(url, init);
    if (path === `/v1/charges/${p.chargeId}`) {
      const ch = (await response.json()) as Record<string, unknown>;
      if (state.postCount) {
        ch.amount_refunded = state.refunded ? amount : 0;
        ch.refunded = state.refunded;
      }
      return Response.json(ch);
    }
    return response;
  });
  return { state, call, p };
}
const start = (
  i: OwnerRefundInput,
  fetcher: StripeSandboxFetch,
  database = db,
  hook?: () => Promise<void>,
) =>
  startOwnerStripeRefund(
    database,
    scope,
    actor,
    i,
    config,
    fetcher,
    () => now + 50000,
    hook,
  );
const query = (i: OwnerRefundInput, fetcher: StripeSandboxFetch) =>
  reconcileOwnerStripeRefund(
    db,
    scope,
    actor,
    i,
    config,
    fetcher,
    () => now + 60000,
  );
describe("owner one-shot Stripe test refund on real local D1", () => {
  // This scenario seeds both providers and restarts D1 around a real migration.
  // Give only this upgrade drill a bounded integration budget on shared CI.
  it("upgrades populated 0025 financial and packing/handoff history without changing rows or foreign keys", async () => {
    await selectBaseline();
    await legacyHistory();
    const a = await paid();
    const b = await paid("pickup", false, true);
    await apply(await request(a.orderId));
    await apply(await request(a.orderId, "ship"));
    await apply(await request(b.orderId));
    const before = await allHistory();
    await upgrade();
    const after = await allHistory();
    for (const [k, v] of Object.entries(before)) expect(after[k], k).toEqual(v);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
    expect((await readOwnerRefund(db, scope, a.orderId))!.canStart).toBe(true);
    expect((await readOwnerRefund(db, scope, b.orderId))!).toMatchObject({
      provider: "paypal",
      canStart: false,
    });
  }, 30000);
  it("records a full refund only after fresh GET evidence and leaves capture/order/stock unchanged", async () => {
    const item = await paid(),
      i = await refundInput(item.orderId),
      p = await refundProvider(item.orderId);
    const before = await allHistory(),
      stock = await balance(item.variantId);
    expect(await start(i, p.call)).toMatchObject({
      state: "succeeded",
      amountCents: 4406,
      refundedCents: 4406,
    });
    const after = await allHistory();
    for (const [k, v] of Object.entries(before))
      if (!k.startsWith("commerce_owner_refund_"))
        expect(after[k], k).toEqual(v);
    expect(await balance(item.variantId)).toEqual(stock);
    expect(p.state.postCount).toBe(1);
    expect(await readOwnerRefund(db, scope, item.orderId)).toMatchObject({
      state: "succeeded",
      canStart: false,
      canQuery: false,
      requestVersion: 3,
    });
    expect(await readOwnerFulfillment(db, scope, item.orderId)).toMatchObject({
      state: "blocked",
      canPack: false,
      canHandoff: false,
    });
    await expect(apply(await request(item.orderId))).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await start(i, p.call)).toMatchObject({ state: "succeeded" });
    expect(p.state.postCount).toBe(1);
  });
  it("handles concurrent double-click with exactly one POST and permanently rejects a new UUID", async () => {
    const item = await paid(),
      i = await refundInput(item.orderId),
      p = await refundProvider(item.orderId);
    await Promise.all([start(i, p.call), start(i, p.call)]);
    expect(p.state.postCount).toBe(1);
    await expect(
      start({ ...i, requestId: crypto.randomUUID() }, p.call),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await rows("commerce_owner_refund_intents")).length).toBe(1);
  });
  it.each(["pending", "failed", "canceled", "requires_action"])(
    "keeps %s outcome and fulfillment lock; original query may later verify success",
    async (status) => {
      const item = await paid(),
        i = await refundInput(item.orderId),
        p = await refundProvider(item.orderId);
      p.state.status = status;
      p.state.refunded = false;
      expect(await start(i, p.call)).toMatchObject({
        state: status === "pending" ? "pending" : "review_required",
        refundedCents: 0,
      });
      expect(await readOwnerFulfillment(db, scope, item.orderId)).toMatchObject(
        { canPack: false, canHandoff: false },
      );
      p.state.status = "succeeded";
      p.state.refunded = true;
      expect(await query(i, p.call)).toMatchObject({ state: "succeeded" });
      expect(p.state.postCount).toBe(1);
    },
  );
  it("lost POST response queries original metadata/key and never sends a second mutation", async () => {
    const item = await paid(),
      i = await refundInput(item.orderId),
      p = await refundProvider(item.orderId);
    p.state.losePost = true;
    expect(await start(i, p.call)).toMatchObject({ state: "review_required" });
    await start(i, p.call);
    expect(p.state.postCount).toBe(1);
    expect(await query(i, p.call)).toMatchObject({ state: "succeeded" });
    expect(p.state.postCount).toBe(1);
  });
  it.each(["intents", "dispatches"])(
    "lost %s write acknowledgment sends no provider request and retains audit",
    async (table) => {
      const item = await paid(),
        i = await refundInput(item.orderId),
        p = await refundProvider(item.orderId);
      const database = faultDatabase(
        (sql) => sql.includes(`INSERT INTO commerce_owner_refund_${table}`),
        "after",
      );
      await start(i, p.call, database);
      expect(p.call).not.toHaveBeenCalled();
      expect((await rows("commerce_owner_refund_intents")).length).toBe(1);
      await start(i, p.call);
      expect(p.call).not.toHaveBeenCalled();
    },
  );
  it("unknown changes acknowledgment never authorizes dispatch", async () => {
    const item = await paid(),
      i = await refundInput(item.orderId),
      p = await refundProvider(item.orderId);
    await start(
      i,
      p.call,
      faultDatabase(
        (sql) => sql.includes("INSERT INTO commerce_owner_refund_dispatches"),
        "unknown",
      ),
    );
    expect(p.call).not.toHaveBeenCalled();
  });
  it("rechecks browser authorization after account/charge GET before POST", async () => {
    const item = await paid(),
      i = await refundInput(item.orderId),
      p = await refundProvider(item.orderId);
    const error = new Error("Revoked fixture authorization");
    await expect(
      start(i, p.call, db, async () => {
        if (p.call.mock.calls.length) throw error;
      }),
    ).rejects.toBe(error);
    expect(p.state.postCount).toBe(0);
    expect(await readOwnerRefund(db, scope, item.orderId)).toMatchObject({
      canStart: false,
      state: "review_required",
    });
  });
  it("a handoff racing before intent makes stale refund fail without mutation", async () => {
    const item = await paid();
    await apply(await request(item.orderId));
    const i = await refundInput(item.orderId),
      p = await refundProvider(item.orderId);
    let fired = false;
    await expect(
      start(i, p.call, db, async () => {
        if (!fired) {
          fired = true;
          await apply(await request(item.orderId, "ship"));
        }
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(p.call).not.toHaveBeenCalled();
  });
  it("completed handoff can refund money without restocking", async () => {
    const item = await paid();
    await apply(await request(item.orderId));
    await apply(await request(item.orderId, "ship"));
    const stock = await balance(item.variantId),
      i = await refundInput(item.orderId),
      p = await refundProvider(item.orderId);
    expect(await start(i, p.call)).toMatchObject({ state: "succeeded" });
    expect(await balance(item.variantId)).toEqual(stock);
  });
  it("rejects changed UUID input, principal, scope, stale version, wrong origin/account and PayPal capture", async () => {
    const item = await paid(),
      i = await refundInput(item.orderId),
      p = await refundProvider(item.orderId);
    await expect(
      start({ ...i, expectedVersion: 2 }, p.call),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      startOwnerStripeRefund(
        db,
        scope,
        actor,
        i,
        { ...config, canonicalOrigin: "http://127.0.0.1:8792" },
        p.call,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      startOwnerStripeRefund(
        db,
        scope,
        actor,
        i,
        { ...config, expectedAccountId: "acct_OtherFictional123" },
        p.call,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await start(i, p.call);
    await expect(
      lookupOwnerRefundCommand(db, scope, { ...actor, sub: "other" }, i),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      lookupOwnerRefundCommand(db, scope, actor, { ...i, expectedVersion: 4 }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      lookupOwnerRefundCommand(db, scope, actor, {
        ...i,
        orderId: `order-${crypto.randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      lookupOwnerRefundCommand(
        db,
        { ...scope, instanceId: crypto.randomUUID() },
        actor,
        i,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const pp = await paid("pickup", false, true);
    await expect(
      start(await refundInput(pp.orderId), p.call),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await lookupOwnerRefundCommand(db, scope, actor, i)).toMatchObject({
      state: "recorded",
      receipt: { state: "succeeded" },
    });
  });
  it("mismatched canonical refund evidence cannot finalize or authorize another POST", async () => {
    const item = await paid(),
      i = await refundInput(item.orderId),
      p = await refundProvider(item.orderId);
    p.state.wrong = true;
    expect(await start(i, p.call)).toMatchObject({ state: "review_required" });
    expect(await query(i, p.call)).toMatchObject({ state: "review_required" });
    expect(p.state.postCount).toBe(1);
    expect(await rows("commerce_owner_refund_observations")).toEqual([]);
  });
  it("strictly copies input and refuses getters without invoking them", async () => {
    const item = await paid(),
      i = await refundInput(item.orderId),
      p = await refundProvider(item.orderId),
      getter = vi.fn(() => i.orderId);
    await expect(
      start(
        {
          ...i,
          get orderId() {
            return getter();
          },
        },
        p.call,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(getter).not.toHaveBeenCalled();
    expect(p.call).not.toHaveBeenCalled();
  });
  it.each(["intents", "dispatches"])(
    "silent-ignore on %s cannot authorize any provider request",
    async (table) => {
      const item = await paid(),
        i = await refundInput(item.orderId),
        p = await refundProvider(item.orderId);
      await db
        .prepare(
          `CREATE TRIGGER fixture_ignore BEFORE INSERT ON commerce_owner_refund_${table} BEGIN SELECT RAISE(IGNORE); END`,
        )
        .run();
      if (table === "intents")
        await expect(start(i, p.call)).rejects.toMatchObject({
          code: "unavailable",
        });
      else expect(await start(i, p.call)).toMatchObject({ state: "prepared" });
      expect(p.call).not.toHaveBeenCalled();
    },
  );
  it("immutable refund audit rejects UPDATE, DELETE and replacement", async () => {
    const item = await paid(),
      i = await refundInput(item.orderId),
      p = await refundProvider(item.orderId);
    await start(i, p.call);
    for (const table of ["intents", "dispatches", "observations"]) {
      await expect(
        db.prepare(`DELETE FROM commerce_owner_refund_${table}`).run(),
      ).rejects.toThrow();
      await expect(
        db
          .prepare(
            `UPDATE commerce_owner_refund_${table} SET recorded_at=recorded_at+1`,
          )
          .run(),
      ).rejects.toThrow();
      await expect(
        db
          .prepare(
            `INSERT OR REPLACE INTO commerce_owner_refund_${table} SELECT * FROM commerce_owner_refund_${table}`,
          )
          .run(),
      ).rejects.toThrow();
    }
  });
});
