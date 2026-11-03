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
import { applyStockCommand, commandHash } from "./inventory.server";
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
const migrationName = "0029_commerce_owner_allocation_release.sql";
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
  baseline = join(directory, "baseline-0028");
  mkdirSync(baseline);
  const oldMigrations = join(baseline, "migrations");
  mkdirSync(oldMigrations);
  for (const file of readdirSync(join(root, "migrations")).filter(
    (file) => file.endsWith(".sql") && file < "0029",
  ))
    copyFileSync(join(root, "migrations", file), join(oldMigrations, file));
  migrate(baseline, configuration(baseline, oldMigrations));
  upgraded = join(directory, "upgraded-0029");
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
    return {
      variantId,
      secondVariantId: null,
      orderId: o.id,
      reserveUntil: o.reserveUntil,
    };
  }
  const secondVariantId = multi ? await fixture() : null;
  const selection: TestCheckoutSelection = {
    contractVersion: "local-checkout-v1",
    lines: [
      { variantId, quantity: multi ? 2 : 1 },
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
    (file) => file.endsWith(".sql") && file < "0029",
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
  startOwnerPayPalRefund,
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
async function paypalRefundProvider(orderId: string) {
  const p = await paypalProvider(orderId);
  p.state.status = "COMPLETED";
  const amount = (await readOwnerRefund(db, scope, orderId))!.amountCents,
    money = { currency_code: "CAD", value: (amount / 100).toFixed(2) };
  const state = {
    postCount: 0,
    status: "COMPLETED",
    losePost: false,
    refundId: "R22222222222222222",
    customId: "",
    wrong: false,
  };
  const refund = () => ({
    id: state.refundId,
    status: state.status,
    custom_id: state.wrong ? "wrong" : state.customId,
    amount: money,
    payer: { merchant_id: paypalConfig.expectedMerchantId },
    links: [
      {
        rel: "up",
        method: "GET",
        href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${p.captureId}`,
      },
    ],
  });
  const call = vi.fn<PayPalSandboxFetch>(async (url, init) => {
    const path = new URL(url).pathname;
    if (path === `/v2/payments/captures/${p.captureId}/refund`) {
      state.postCount++;
      const body = JSON.parse(init.body as string) as {
        amount: unknown;
        custom_id: string;
      };
      expect(body.amount).toEqual(money);
      state.customId = body.custom_id;
      expect(new Headers(init.headers).get("PayPal-Request-Id")).toBe(
        state.customId.slice(-36),
      );
      if (state.losePost) throw new Error("Synthetic committed refund lost");
      return Response.json(refund());
    }
    if (path === `/v2/payments/refunds/${state.refundId}`)
      return Response.json(refund());
    p.state.refunded = state.postCount > 0 && state.status === "COMPLETED";
    const response = await p.call(url, init);
    if (path === `/v2/checkout/orders/${p.providerOrderId}`) {
      const order = (await response.json()) as {
        purchase_units: Array<{ payments: { refunds: unknown[] } }>;
      };
      order.purchase_units[0].payments.refunds = state.postCount
        ? [refund()]
        : [];
      return Response.json(order);
    }
    return response;
  });
  return { state, call, p, amount };
}
const startPayPal = (
  i: OwnerRefundInput,
  fetcher: PayPalSandboxFetch,
  database = db,
  hook?: () => Promise<void>,
) =>
  startOwnerPayPalRefund(
    database,
    scope,
    actor,
    i,
    paypalConfig,
    fetcher,
    () => now + 50000,
    hook,
  );
async function refundedEvent(orderId: string, providerOrderId: string) {
  await db
    .prepare(
      `INSERT INTO commerce_owned_paypal_events(event_type,event_id,attempt_command_id,provider_order_id,payload_hash,recorded_at) SELECT 'PAYMENT.CAPTURE.REFUNDED',?,command_id,?,?,? FROM commerce_payment_attempts WHERE order_id=?`,
    )
    .bind(
      crypto.randomUUID(),
      providerOrderId,
      "b".repeat(64),
      now + 55000,
      orderId,
    )
    .run();
}
import { readOwnerReturn, applyOwnerReturn } from "./owner-return.server";
import type { OwnerReturnInput, OwnerReturnOperation } from "./owner-return";
const returnInput = async (
  orderId: string,
  operation: OwnerReturnOperation = "inspect_sellable",
): Promise<OwnerReturnInput> => {
  const d = (await readOwnerReturn(db, scope, orderId))!;
  return {
    requestId: crypto.randomUUID(),
    orderId,
    operation,
    expectedVersion: d.orderVersion,
    expectedStockHash: d.stockHash,
    acknowledge: true,
  };
};
const applyReturn = (
  i: OwnerReturnInput,
  database = db,
  hook?: () => Promise<void>,
) => applyOwnerReturn(database, scope, actor, i, () => now + 100000, hook);
// Historical migration fixtures must use the contract available at that schema.
// Current runtime code is exercised only after all subsequent migrations apply.
async function seedLegacyFullRefund(orderId: string) {
  const requestId = crypto.randomUUID();
  const source = (await db
    .prepare("SELECT * FROM commerce_owner_refund_sources WHERE order_id=?")
    .bind(orderId)
    .first<Record<string, unknown>>())!;
  const i = {
    requestId,
    orderId,
    expectedVersion: source.version,
    acknowledge: true,
  };
  const actorHash = await commandHash([
    "owner-refund-actor-v1",
    actor.email,
    actor.sub,
  ]);
  const requestHash = await commandHash([
    "owner-refund-v1",
    scope,
    actorHash,
    i,
  ]);
  await db
    .prepare(
      `INSERT INTO commerce_owner_refund_intents(request_id,mode,instance_id,actor_hash,request_hash,order_id,capture_id,expected_version,operation_key,provider,account_ref,canonical_origin,transaction_ref,payment_intent_ref,provider_object_ref,payment_request_id,create_operation_key,amount_cents,recorded_at)
    SELECT ?,mode,instance_id,?,?,order_id,capture_id,version,?,provider,account_ref,canonical_origin,transaction_ref,payment_intent_ref,provider_object_ref,payment_request_id,create_operation_key,amount_cents,? FROM commerce_owner_refund_sources WHERE order_id=?`,
    )
    .bind(requestId, actorHash, requestHash, requestId, now + 50000, orderId)
    .run();
  await db
    .prepare("INSERT INTO commerce_owner_refund_dispatches VALUES(?,?,?)")
    .bind(requestId, crypto.randomUUID(), now + 50000)
    .run();
  const refundId =
    source.provider === "paypal"
      ? `R${requestId.replaceAll("-", "").slice(0, 16).toUpperCase()}`
      : `re_${requestId.replaceAll("-", "")}`;
  await db
    .prepare(
      `INSERT INTO commerce_owner_refund_observations SELECT ?,request_id,?,'succeeded',amount_cents,amount_cents,? FROM commerce_owner_refund_intents WHERE request_id=?`,
    )
    .bind(crypto.randomUUID(), refundId, now + 50001, requestId)
    .run();
}
async function upgradeCurrentRuntime() {
  await platform?.dispose();
  platform = undefined;
  const migrations = join(current, "current-runtime-migrations");
  mkdirSync(migrations);
  for (const file of readdirSync(join(root, "migrations")).filter((f) =>
    f.endsWith(".sql"),
  ))
    copyFileSync(join(root, "migrations", file), join(migrations, file));
  configPath = configuration(current, migrations);
  try {
    migrate(current, configPath);
  } finally {
    await connect();
  }
}
async function handedRefunded(
  paypal = false,
  multi = false,
  refundStatus = "succeeded",
  refund = true,
  historical = false,
) {
  const item = await paid("shipping", multi, paypal);
  await apply(await request(item.orderId));
  await apply(await request(item.orderId, "ship"));
  if (historical) {
    await seedLegacyFullRefund(item.orderId);
    if (paypal) {
      const source = (await db
        .prepare(
          "SELECT provider_object_ref FROM commerce_owner_refund_intents WHERE order_id=?",
        )
        .bind(item.orderId)
        .first<{ provider_object_ref: string }>())!;
      await refundedEvent(item.orderId, source.provider_object_ref);
    }
    return item;
  }
  const i = await refundInput(item.orderId);
  if (refund) {
    if (paypal) {
      const p = await paypalRefundProvider(item.orderId);
      p.state.status =
        refundStatus === "succeeded"
          ? "COMPLETED"
          : refundStatus === "pending"
            ? "PENDING"
            : "FAILED";
      await startPayPal(i, p.call);
      await refundedEvent(item.orderId, p.p.providerOrderId);
    } else {
      const p = await refundProvider(item.orderId);
      p.state.status = refundStatus;
      p.state.refunded = refundStatus === "succeeded";
      await start(i, p.call);
    }
  }
  return item;
}
const schema = async () =>
  (
    await db
      .prepare(
        "SELECT type,name,sql FROM sqlite_schema WHERE name LIKE 'commerce_%' ORDER BY name",
      )
      .all()
  ).results;
import {
  readOwnerAllocationRelease,
  applyOwnerAllocationRelease,
  lookupOwnerAllocationReleaseCommand,
} from "./owner-allocation-release.server";
import type { OwnerAllocationReleaseInput } from "./owner-allocation-release";
import type { StockChange } from "./inventory.server";
async function releaseInput(
  orderId: string,
): Promise<OwnerAllocationReleaseInput> {
  const d = (await readOwnerAllocationRelease(db, scope, orderId))!;
  return {
    requestId: crypto.randomUUID(),
    orderId,
    expectedVersion: d.orderVersion,
    expectedStockHash: d.stockHash,
    acknowledge: true,
  };
}
const release = (
  i: OwnerAllocationReleaseInput,
  database = db,
  hook?: () => Promise<void>,
) =>
  applyOwnerAllocationRelease(
    database,
    scope,
    actor,
    i,
    () => now + 120000,
    hook,
  );
async function seedLegacyReturned(orderId: string) {
  const h = (await db
    .prepare("SELECT * FROM commerce_owner_return_handoffs WHERE order_id=?")
    .bind(orderId)
    .first<Record<string, unknown>>())!;
  const refund = (await db
    .prepare(
      "SELECT observation_id FROM commerce_owner_return_refunds WHERE order_id=?",
    )
    .bind(orderId)
    .first<{ observation_id: string }>())!;
  const inspectionId = crypto.randomUUID();
  for (const operation of ["inspect_sellable", "restock"]) {
    const requestId =
      operation === "inspect_sellable" ? inspectionId : crypto.randomUUID();
    const lines = (
      await db
        .prepare(
          "SELECT l.position,l.variant_id AS variantId,l.quantity,i.on_hand AS onHand,i.facebook_reserved AS facebookReserved,i.checkout_reserved AS checkoutReserved,i.allocated FROM commerce_order_lines l JOIN commerce_inventory i ON i.variant_id=l.variant_id WHERE l.order_id=? ORDER BY l.position",
        )
        .bind(orderId)
        .all()
    ).results;
    const actorHash = await commandHash([
      "owner-return-actor-v1",
      actor.email,
      actor.sub,
    ]);
    const stockHash = await commandHash([
      "owner-return-stock-v1",
      orderId,
      lines,
    ]);
    const originalInput = {
      requestId,
      orderId,
      operation,
      expectedVersion: h.version,
      expectedStockHash: stockHash,
      acknowledge: true,
    };
    const requestHash = await commandHash([
      "owner-return-v1",
      scope,
      actorHash,
      originalInput,
    ]);
    await db
      .prepare(
        "INSERT INTO commerce_owner_return_commands VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        requestId,
        `owner-return-${requestId}`,
        scope.mode,
        scope.instanceId,
        actorHash,
        requestHash,
        orderId,
        h.capture_id,
        h.handoff_request_id,
        operation === "restock" ? inspectionId : null,
        operation === "restock" ? refund.observation_id : null,
        operation,
        h.version,
        stockHash,
        JSON.stringify(lines),
        now + 100000,
      )
      .run();
  }
}
async function unhandedRefunded(
  paypal = false,
  packed = false,
  status = "succeeded",
  refund = true,
  multi = false,
  historical = false,
) {
  const item = await paid("shipping", multi, paypal);
  if (packed) await apply(await request(item.orderId));
  if (historical) {
    await seedLegacyFullRefund(item.orderId);
    if (paypal) {
      const source = (await db
        .prepare(
          "SELECT provider_object_ref FROM commerce_owner_refund_intents WHERE order_id=?",
        )
        .bind(item.orderId)
        .first<{ provider_object_ref: string }>())!;
      await refundedEvent(item.orderId, source.provider_object_ref);
    }
    return item;
  }
  if (refund) {
    const i = await refundInput(item.orderId);
    if (paypal) {
      const p = await paypalRefundProvider(item.orderId);
      p.state.status =
        status === "succeeded"
          ? "COMPLETED"
          : status === "pending"
            ? "PENDING"
            : "FAILED";
      await startPayPal(i, p.call);
      if (status === "succeeded")
        await refundedEvent(item.orderId, p.p.providerOrderId);
    } else {
      const p = await refundProvider(item.orderId);
      p.state.status = status;
      p.state.refunded = status === "succeeded";
      await start(i, p.call);
    }
  }
  return item;
}
const movementRows = async () =>
  (
    await db
      .prepare("SELECT rowid,* FROM commerce_stock_movements ORDER BY rowid")
      .all()
  ).results;
describe("owner explicit retained refunded allocation release on real local D1", () => {
  it("upgrades populated0028 preserving movement rowids, all history/stock/FKs/indexes/source guards without replay", async () => {
    await selectBaseline();
    await legacyHistory();
    const returned = await handedRefunded(false, true, "succeeded", true, true);
    await seedLegacyReturned(returned.orderId);
    const kept = await unhandedRefunded(
      true,
      true,
      "succeeded",
      true,
      false,
      true,
    );
    await db
      .prepare(
        "INSERT INTO commerce_commands(id,request_hash,created_at) VALUES('gap-fixture',?,?)",
      )
      .bind("a".repeat(64), now + 110000)
      .run();
    await db
      .prepare(
        "INSERT INTO commerce_stock_movements(rowid,command_id,position,variant_id,kind,quantity,reason) VALUES(99999,'gap-fixture',0,?,'receive',1,'Fictional rowid gap fixture')",
      )
      .bind(kept.variantId)
      .run();
    const before = await allHistory(),
      oldSchema = await schema(),
      movements = await movementRows();
    await upgrade();
    const after = await allHistory();
    for (const [k, v] of Object.entries(before)) expect(after[k], k).toEqual(v);
    expect(await movementRows()).toEqual(movements);
    for (const row of oldSchema as Array<{ name: string; sql: string }>)
      if (
        ![
          "commerce_stock_movements",
          "commerce_apply_stock",
          "commerce_checkout_inventory_floor",
          "commerce_checkout_inventory_insert_floor",
        ].includes(row.name)
      )
        expect(await schema()).toContainEqual(row);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
    expect(
      (
        await db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name LIKE '%backup_0029%'",
          )
          .all()
      ).results,
    ).toEqual([]);
    await upgradeCurrentRuntime();
    expect(
      await readOwnerAllocationRelease(db, scope, kept.orderId),
    ).toMatchObject({ canRelease: true });
    expect(
      await readOwnerAllocationRelease(db, scope, returned.orderId),
    ).toMatchObject({ canRelease: false, fulfillment: "handed_over" });
  }, 30000);
  it("failed0029 migration rolls back original CHECK, rowids, histories, source guards and floors", async () => {
    await selectBaseline();
    await unhandedRefunded(false, false, "succeeded", true, false, true);
    const before = await allHistory(),
      oldSchema = await schema(),
      movements = await movementRows();
    await expect(
      upgrade(
        migration() +
          "\nINSERT INTO commerce_owner_allocation_release_commands(request_id) VALUES('broken');",
      ),
    ).rejects.toThrow();
    expect(await allHistory()).toEqual(before);
    expect(await schema()).toEqual(oldSchema);
    expect(await movementRows()).toEqual(movements);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  }, 30000);
  it.each([false, true])(
    "providerPayPal=%s releases exact original allocated quantities once and preserves physical/financial/fulfillment facts",
    async (paypal) => {
      const item = await unhandedRefunded(
          paypal,
          true,
          "succeeded",
          true,
          true,
        ),
        i = await releaseInput(item.orderId),
        before = await allHistory(),
        d = (await readOwnerAllocationRelease(db, scope, item.orderId))!;
      expect(await release(i)).toMatchObject({
        result: "allocation_released",
        replayed: false,
        expectedVersion: 4,
      });
      for (const l of d.lines)
        expect(await balance(l.variantId)).toEqual({
          on_hand: l.onHand,
          facebook_reserved: l.facebookReserved,
          checkout_reserved: l.checkoutReserved,
          allocated: l.allocated - l.quantity,
        });
      const after = await allHistory();
      for (const [k, v] of Object.entries(before))
        if (
          ![
            "commerce_commands",
            "commerce_stock_movements",
            "commerce_inventory",
          ].includes(k) &&
          !k.startsWith("commerce_owner_allocation_release_")
        )
          expect(after[k], k).toEqual(v);
      expect(
        await readOwnerAllocationRelease(db, scope, item.orderId),
      ).toMatchObject({ released: true, canRelease: false, orderVersion: 4 });
      expect(await release(i)).toMatchObject({ replayed: true });
      await expect(
        release({ ...i, requestId: crypto.randomUUID() }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(
        (
          await db
            .prepare(
              "SELECT kind,quantity FROM commerce_stock_movements WHERE command_id=? ORDER BY position",
            )
            .bind(`owner-allocation-release-${i.requestId}`)
            .all()
        ).results,
      ).toEqual(
        d.lines.map((l) => ({ kind: "deallocate", quantity: l.quantity })),
      );
    },
  );
  it("also permits unpacked retained orders but never permits handed-off or physically inspected returns", async () => {
    const item = await unhandedRefunded();
    expect(await release(await releaseInput(item.orderId))).toMatchObject({
      result: "allocation_released",
      expectedVersion: 3,
    });
    const handed = await handedRefunded(true);
    await applyReturn(await returnInput(handed.orderId));
    expect(
      await readOwnerAllocationRelease(db, scope, handed.orderId),
    ).toMatchObject({ canRelease: false, fulfillment: "handed_over" });
    await expect(
      release(await releaseInput(handed.orderId)),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it.each(["pending", "failed", "none", "unknown"])(
    "%s refund cannot release allocation",
    async (status) => {
      const item = await unhandedRefunded(
        false,
        false,
        status,
        status !== "none" && status !== "unknown",
      );
      if (status === "unknown") {
        const p = await refundProvider(item.orderId);
        p.state.losePost = true;
        await start(await refundInput(item.orderId), p.call);
      }
      const before = await balance(item.variantId);
      expect(
        await readOwnerAllocationRelease(db, scope, item.orderId),
      ).toMatchObject({ canRelease: false, released: false });
      await expect(
        release(await releaseInput(item.orderId)),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await balance(item.variantId)).toEqual(before);
    },
  );
  it("keeps other paid/unknown allocations, checkout reserves and Facebook units protected after own release", async () => {
    const item = await unhandedRefunded();
    const otherPaid = await paid("pickup", false, false, item.variantId),
      unknown = await held(false, false, "shipping", item.variantId);
    await begin(db, trusted, input(unknown.orderId), () => now + 1);
    await applyStockCommand(
      db,
      `fb-${crypto.randomUUID()}`,
      [
        {
          variantId: item.variantId,
          kind: "fb_reserve",
          quantity: 1,
          reason: "Fictional held Facebook unit",
        },
      ],
      now + 100001,
    );
    const before = await balance(item.variantId);
    expect(before).toMatchObject({
      allocated: 2,
      checkout_reserved: 1,
      facebook_reserved: 1,
    });
    await release(await releaseInput(item.orderId));
    expect(await balance(item.variantId)).toEqual({ ...before, allocated: 1 });
    await expect(
      applyStockCommand(
        db,
        `steal-${crypto.randomUUID()}`,
        [
          {
            variantId: item.variantId,
            kind: "fulfill",
            quantity: 1,
            reason: "Forged generic fulfillment",
          },
        ],
        now + 130000,
      ),
    ).rejects.toThrow();
    await expect(
      applyStockCommand(
        db,
        `steal-${crypto.randomUUID()}`,
        [
          {
            variantId: item.variantId,
            kind: "release",
            quantity: 1,
            reason: "Forged generic release",
          },
        ],
        now + 130000,
      ),
    ).rejects.toThrow();
    // Exercise INSERT and UPDATE floor paths after the forward migration.
    await expect(
      db
        .prepare(
          `INSERT OR REPLACE INTO commerce_inventory(variant_id,on_hand,facebook_reserved,checkout_reserved,allocated)
      SELECT variant_id,on_hand,facebook_reserved,checkout_reserved,0 FROM commerce_inventory WHERE variant_id=?`,
        )
        .bind(item.variantId)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          `INSERT INTO commerce_inventory(variant_id,on_hand,facebook_reserved,checkout_reserved,allocated)
      SELECT variant_id,on_hand,facebook_reserved,checkout_reserved,allocated FROM commerce_inventory WHERE variant_id=?
      ON CONFLICT(variant_id) DO UPDATE SET allocated=0`,
        )
        .bind(item.variantId)
        .run(),
    ).rejects.toThrow();
    expect(await balance(item.variantId)).toEqual({ ...before, allocated: 1 });
    expect(
      await readOwnerAllocationRelease(db, scope, otherPaid.orderId),
    ).toMatchObject({ canRelease: false });
  });
  it.each(["onHand", "facebookReserved", "checkoutReserved", "allocated"])(
    "compares frozen %s atomically after final authorization hook",
    async (field) => {
      const item = await unhandedRefunded(),
        i = await releaseInput(item.orderId);
      await expect(
        release(i, db, async () => {
          if (field === "onHand" || field === "facebookReserved")
            await applyStockCommand(
              db,
              `race-${crypto.randomUUID()}`,
              [
                {
                  variantId: item.variantId,
                  kind: field === "onHand" ? "receive" : "fb_reserve",
                  quantity: 1,
                  reason: "Fictional concurrent stock change",
                },
              ],
              now + 100001,
            );
          else if (field === "checkoutReserved")
            await held(false, false, "shipping", item.variantId);
          else await paid("pickup", false, false, item.variantId);
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await rows("commerce_owner_allocation_release_commands")).toEqual(
        [],
      );
    },
  );
  it("retains original-key lookup on lost result, same-key races and identity conflicts without a second effect", async () => {
    const item = await unhandedRefunded(),
      i = await releaseInput(item.orderId),
      database = faultDatabase(
        (sql) =>
          sql.includes(
            "INSERT INTO commerce_owner_allocation_release_commands",
          ),
        "after",
      );
    expect(await release(i, database)).toMatchObject({ replayed: true });
    const after = await balance(item.variantId);
    await Promise.all([release(i), release(i)]);
    expect(await balance(item.variantId)).toEqual(after);
    expect(
      await lookupOwnerAllocationReleaseCommand(db, scope, actor, i),
    ).toMatchObject({ state: "recorded" });
    for (const changed of [
      { ...i, orderId: `order-${crypto.randomUUID()}` },
      { ...i, expectedVersion: i.expectedVersion + 1 },
      { ...i, expectedStockHash: "0".repeat(64) },
    ])
      await expect(
        lookupOwnerAllocationReleaseCommand(db, scope, actor, changed),
      ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      lookupOwnerAllocationReleaseCommand(
        db,
        scope,
        { ...actor, sub: "another" },
        i,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      lookupOwnerAllocationReleaseCommand(
        db,
        { ...scope, instanceId: crypto.randomUUID() },
        actor,
        i,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("recovers same-key winner between missing receipt lookup and now-ineligible load", async () => {
    const item = await unhandedRefunded(),
      i = await releaseInput(item.orderId);
    let fired = false;
    const database = new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            function wrap(statement: D1PreparedStatement): D1PreparedStatement {
              return new Proxy(statement, {
                get(current, method) {
                  if (method === "bind")
                    return (...values: unknown[]) =>
                      wrap(current.bind(...values));
                  const fn = Reflect.get(current, method);
                  if (
                    method === "first" &&
                    sql.includes(
                      "FROM commerce_owner_allocation_release_commands r",
                    ) &&
                    sql.endsWith(" WHERE r.request_id=?")
                  )
                    return async (...args: unknown[]) => {
                      const result = await fn.apply(current, args);
                      if (!fired) {
                        fired = true;
                        expect(result).toBeNull();
                        await release(i);
                      }
                      return result;
                    };
                  return typeof fn === "function" ? fn.bind(current) : fn;
                },
              });
            }
            return wrap(target.prepare(sql));
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(await release(i, database)).toMatchObject({ replayed: true });
    expect(
      (await rows("commerce_owner_allocation_release_commands")).length,
    ).toBe(1);
    expect(await balance(item.variantId)).toMatchObject({
      allocated: 0,
      on_hand: 4,
    });
  });
  it.each([
    "commerce_owner_allocation_release_lines",
    "commerce_commands",
    "commerce_stock_movements",
    "commerce_inventory",
  ])(
    "silent ignored %s rolls back the whole release including narrowed floor permission",
    async (table) => {
      const item = await unhandedRefunded(
          false,
          false,
          "succeeded",
          true,
          true,
        ),
        i = await releaseInput(item.orderId),
        before = await allHistory();
      await db
        .prepare(
          `CREATE TRIGGER fixture_ignore BEFORE ${table === "commerce_inventory" ? "UPDATE" : "INSERT"} ON ${table} BEGIN SELECT RAISE(IGNORE); END`,
        )
        .run();
      await expect(release(i)).rejects.toMatchObject({ code: "unavailable" });
      expect(await allHistory()).toEqual(before);
      expect(
        (
          await db
            .prepare("SELECT * FROM commerce_owner_allocation_released_lines")
            .all()
        ).results,
      ).toEqual([]);
    },
  );
  it("ignored parent/unknown acknowledgment cannot duplicate or invent a receipt", async () => {
    const item = await unhandedRefunded(),
      i = await releaseInput(item.orderId);
    await db
      .prepare(
        "CREATE TRIGGER fixture_ignore BEFORE INSERT ON commerce_owner_allocation_release_commands BEGIN SELECT RAISE(IGNORE); END",
      )
      .run();
    await expect(release(i)).rejects.toMatchObject({ code: "unavailable" });
    expect(
      await lookupOwnerAllocationReleaseCommand(db, scope, actor, i),
    ).toEqual({ state: "not_recorded" });
  });
  it("does not expose generic deallocate and preserves immutable movement/source fences", async () => {
    const item = await unhandedRefunded();
    await expect(
      applyStockCommand(
        db,
        "generic-deallocate",
        [
          {
            variantId: item.variantId,
            kind: "deallocate",
            quantity: 1,
            reason: "Forged generic deallocation",
          } as unknown as StockChange,
        ],
        now + 100001,
      ),
    ).rejects.toThrow();
    await db
      .prepare(
        "INSERT INTO commerce_commands(id,request_hash,created_at) VALUES('forged-deallocate',?,?)",
      )
      .bind("b".repeat(64), now + 100001)
      .run();
    await expect(
      db
        .prepare(
          "INSERT INTO commerce_stock_movements(command_id,position,variant_id,kind,quantity,reason) VALUES('forged-deallocate',0,?,'deallocate',1,'forged')",
        )
        .bind(item.variantId)
        .run(),
    ).rejects.toThrow();
    await release(await releaseInput(item.orderId));
    for (const table of [
      "commerce_owner_allocation_release_commands",
      "commerce_owner_allocation_release_lines",
      "commerce_stock_movements",
    ]) {
      await expect(db.prepare(`DELETE FROM ${table}`).run()).rejects.toThrow();
      await expect(
        db
          .prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)
          .run(),
      ).rejects.toThrow();
    }
  });
  it("strict inputs, stale version/hash and final authorization refuse before any receipt or stock effect", async () => {
    const item = await unhandedRefunded(),
      i = await releaseInput(item.orderId);
    for (const changed of [
      { ...i, expectedVersion: i.expectedVersion + 1 },
      { ...i, expectedStockHash: "0".repeat(64) },
    ])
      await expect(release(changed)).rejects.toMatchObject({
        code: "conflict",
      });
    await expect(
      release({ ...i, quantity: 999 } as OwnerAllocationReleaseInput),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const getter = vi.fn(() => i.orderId);
    await expect(
      release({
        ...i,
        get orderId() {
          return getter();
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(getter).not.toHaveBeenCalled();
    const revoked = new Error("Synthetic revoked session");
    await expect(
      release(i, db, async () => {
        throw revoked;
      }),
    ).rejects.toBe(revoked);
    expect(await rows("commerce_owner_allocation_release_commands")).toEqual(
      [],
    );
  });
  it("SQL refuses another order full refund observation and forged canonical quantities", async () => {
    const item = await unhandedRefunded(),
      other = await unhandedRefunded(true),
      i = await releaseInput(item.orderId),
      d = (await readOwnerAllocationRelease(db, scope, item.orderId))!;
    const source = (await db
        .prepare(
          "SELECT capture_id,observation_id FROM commerce_owner_allocation_release_sources WHERE order_id=?",
        )
        .bind(item.orderId)
        .first<{ capture_id: string; observation_id: string }>())!,
      foreign = (await db
        .prepare(
          "SELECT observation_id FROM commerce_owner_allocation_release_sources WHERE order_id=?",
        )
        .bind(other.orderId)
        .first<{ observation_id: string }>())!;
    const expected = d.lines.map((l) => ({
      position: l.position,
      variantId: l.variantId,
      quantity: l.quantity,
      onHand: l.onHand,
      facebookReserved: l.facebookReserved,
      checkoutReserved: l.checkoutReserved,
      allocated: l.allocated,
    }));
    const insert = (capture: string, observation: string, lines: unknown) =>
      db
        .prepare(
          `INSERT INTO commerce_owner_allocation_release_commands(request_id,command_id,mode,instance_id,actor_hash,request_hash,order_id,capture_id,refund_observation_id,expected_version,expected_stock_hash,expected_lines_json,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          i.requestId,
          `owner-allocation-release-${i.requestId}`,
          scope.mode,
          scope.instanceId,
          "a".repeat(64),
          "b".repeat(64),
          i.orderId,
          capture,
          observation,
          i.expectedVersion,
          i.expectedStockHash,
          JSON.stringify(lines),
          now + 120000,
        )
        .run();
    await expect(
      insert(source.capture_id, foreign.observation_id, expected),
    ).rejects.toThrow();
    expected[0].quantity = 20;
    await expect(
      insert(source.capture_id, source.observation_id, expected),
    ).rejects.toThrow();
  });
});
