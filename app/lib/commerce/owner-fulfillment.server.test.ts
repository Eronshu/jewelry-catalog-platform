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
const migrationName = "0025_commerce_owner_fulfillment.sql";
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
  baseline = join(directory, "baseline-0024");
  mkdirSync(baseline);
  const oldMigrations = join(baseline, "migrations");
  mkdirSync(oldMigrations);
  for (const file of readdirSync(join(root, "migrations")).filter(
    (file) => file.endsWith(".sql") && file < "0025",
  ))
    copyFileSync(join(root, "migrations", file), join(oldMigrations, file));
  migrate(baseline, configuration(baseline, oldMigrations));
  upgraded = join(directory, "upgraded-0025");
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
    (file) => file.endsWith(".sql") && file < "0025",
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
  readOwnedStripePayment,
} from "./owned-stripe.server";
import type {
  StripeSandboxConfig,
  StripeSandboxFetch,
} from "./stripe-sandbox.server";
import {
  startOwnedPayPalPayment,
  captureOwnedPayPalPayment,
  reconcileOwnedPayPalPayment,
  readOwnedPayPalPayment,
} from "./owned-paypal.server";
import type {
  PayPalSandboxConfig,
  PayPalSandboxFetch,
} from "./paypal-sandbox.server";
import {
  applyOwnerFulfillment,
  lookupOwnerFulfillmentCommand,
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
const commands = () => rows("commerce_owner_fulfillment_commands");
describe("owner whole-order fulfillment on real local D1", () => {
  it("upgrades populated financial and owned history from 0024 without altering rows or FK integrity", async () => {
    await selectBaseline();
    await legacyHistory();
    await paid("shipping", false, false, undefined, false);
    const before = await allHistory();
    await upgrade();
    const after = await allHistory();
    for (const [name, value] of Object.entries(before))
      expect(after[name], name).toEqual(value);
    expect(await commands()).toEqual([]);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  }, 30000);
  it("packs without stock changes then records pickup, local delivery or carrier handoff once for the frozen method", async () => {
    for (const [delivery, operation, paypal] of [
      ["pickup", "collect", false],
      ["local_delivery", "deliver", false],
      ["shipping", "ship", false],
      ["shipping", "ship", true],
    ] as const) {
      const item = await paid(delivery, false, paypal),
        before = await balance(item.variantId),
        r = await request(item.orderId);
      expect(await apply(r)).toMatchObject({
        operation: "pack",
        resultingVersion: 4,
        replayed: false,
      });
      expect(await balance(item.variantId)).toEqual(before);
      expect(await readOwnerFulfillment(db, scope, item.orderId)).toMatchObject(
        { state: "packed", canHandoff: true, canPack: false },
      );
      const handoff = await request(item.orderId, operation);
      expect(await apply(handoff)).toMatchObject({
        operation,
        resultingVersion: 5,
      });
      expect(await balance(item.variantId)).toEqual({
        on_hand: 3,
        facebook_reserved: 0,
        checkout_reserved: 0,
        allocated: 0,
      });
      expect(await readOwnerFulfillment(db, scope, item.orderId)).toMatchObject(
        {
          state: "handed_over",
          canHandoff: false,
          history: [{ operation: "pack" }, { operation }],
        },
      );
      expect(await apply(handoff)).toMatchObject({ replayed: true });
      expect(await apply(r)).toMatchObject({
        replayed: true,
        resultingVersion: 4,
      });
      expect(
        await db
          .prepare(
            "SELECT state,payment_state,fulfillment,version FROM commerce_orders WHERE id=?",
          )
          .bind(item.orderId)
          .first(),
      ).toEqual({
        state: "confirmed",
        payment_state: "succeeded",
        fulfillment: "completed",
        version: 5,
      });
      const payment = paypal
        ? await readOwnedPayPalPayment(
            db,
            paypalConfig,
            trusted.ownerHash,
            item.orderId,
          )
        : await readOwnedStripePayment(
            db,
            config,
            trusted.ownerHash,
            item.orderId,
          );
      expect(payment).toMatchObject({
        state: "paid",
        canStart: false,
        canQuery: false,
      });
    }
    expect(await commands()).toHaveLength(8);
  });
  it("rejects unpaid, unknown, old lab, wrong scope, wrong method and stale inputs", async () => {
    const unpaid = await held(),
      legacy = await held(true),
      item = await paid("pickup");
    for (const orderId of [unpaid.orderId, legacy.orderId])
      await expect(
        apply({
          ...(await request(item.orderId)),
          orderId,
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({
        code: legacy.orderId === orderId ? "not_found" : "conflict",
      });
    const unknown = await held();
    await begin(db, trusted, input(unknown.orderId), () => now + 1);
    await expect(
      apply({
        ...(await request(item.orderId)),
        orderId: unknown.orderId,
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      await readOwnerFulfillment(db, scope, unknown.orderId),
    ).toMatchObject({ state: "blocked", canPack: false });
    const r = await request(item.orderId);
    await apply(r);
    await expect(
      apply({ ...r, requestId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      apply(await request(item.orderId, "ship")),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      applyOwnerFulfillment(
        db,
        { ...scope, instanceId: crypto.randomUUID() },
        actor,
        await request(item.orderId, "collect"),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(apply({ ...r, operation: "collect" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      applyOwnerFulfillment(db, scope, { ...actor, sub: "other" }, r),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await commands()).toHaveLength(1);
  });
  it("serializes duplicate and competing commands with one physical effect", async () => {
    const item = await paid(),
      pack = await request(item.orderId);
    await Promise.all([apply(pack), apply(pack)]);
    const h = await request(item.orderId, "ship"),
      results = await Promise.allSettled([
        apply(h),
        apply({ ...h, requestId: crypto.randomUUID() }),
      ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await balance(item.variantId)).toMatchObject({
      on_hand: 3,
      allocated: 0,
    });
    expect(await commands()).toHaveLength(2);
  });
  it("recovers lost write responses and unknown acknowledgments with the original immutable receipt", async () => {
    const item = await paid();
    for (const [operation, phase] of [
      ["pack", "after"],
      ["ship", "unknown"],
    ] as const) {
      const r = await request(item.orderId, operation);
      const fault = faultDatabase(
        (sql) =>
          sql.startsWith("INSERT INTO commerce_owner_fulfillment_commands"),
        phase,
      );
      expect(
        await applyOwnerFulfillment(fault, scope, actor, r, () => now + 40000),
      ).toMatchObject({ replayed: true });
      expect(
        await lookupOwnerFulfillmentCommand(db, scope, actor, r),
      ).toMatchObject({ state: "recorded", receipt: { operation } });
    }
    expect(await balance(item.variantId)).toMatchObject({
      on_hand: 3,
      allocated: 0,
    });
  });
  it("rolls back every line, balances and receipt on ignored command, movement, balance, line or order writes", async () => {
    const item = await paid("shipping", true);
    await apply(await request(item.orderId));
    for (const [table, event] of [
      ["commerce_commands", "INSERT"],
      ["commerce_stock_movements", "INSERT"],
      ["commerce_inventory", "UPDATE"],
      ["commerce_owner_fulfillment_lines", "INSERT"],
      ["commerce_orders", "UPDATE"],
      ["commerce_owner_fulfillment_commands", "INSERT"],
    ]) {
      const before = await allHistory();
      await db
        .prepare(
          `CREATE TRIGGER fixture_ignore BEFORE ${event} ON ${table} BEGIN SELECT RAISE(IGNORE); END`,
        )
        .run();
      await expect(
        apply(await request(item.orderId, "ship")),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(await allHistory()).toEqual(before);
      await db.prepare("DROP TRIGGER fixture_ignore").run();
    }
    await apply(await request(item.orderId, "ship"));
    expect(await balance(item.variantId)).toMatchObject({
      on_hand: 3,
      allocated: 0,
    });
    expect(
      await balance(
        "secondVariantId" in item ? item.secondVariantId! : "missing",
      ),
    ).toMatchObject({
      on_hand: 3,
      allocated: 0,
    });
  }, 30000);
  it("blocks PayPal attention observed after pack or during final authorization, preserving paid facts and allocation", async () => {
    const item = await paid("shipping", false, true);
    await apply(await request(item.orderId));
    const r = await request(item.orderId, "ship");
    await expect(
      applyOwnerFulfillment(
        db,
        scope,
        actor,
        r,
        () => now + 40000,
        async () => {
          await db
            .prepare(
              `INSERT INTO commerce_owned_paypal_events(event_id,attempt_command_id,provider_order_id,event_type,payload_hash,recorded_at) SELECT 'WH-ATTENTION',b.attempt_command_id,z.provider_order_id,'PAYMENT.CAPTURE.REFUNDED',?,? FROM commerce_owned_paypal_associations b JOIN commerce_owned_paypal_orders z ON z.attempt_command_id=b.attempt_command_id JOIN commerce_payment_attempts a ON a.command_id=b.attempt_command_id WHERE a.order_id=?`,
            )
            .bind("b".repeat(64), now + 35000, item.orderId)
            .run();
        },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await readOwnerFulfillment(db, scope, item.orderId)).toMatchObject({
      state: "blocked",
      canHandoff: false,
    });
    expect(await balance(item.variantId)).toMatchObject({
      on_hand: 4,
      allocated: 1,
    });
    expect(await rows("commerce_payment_capture_facts")).toHaveLength(1);
  });
  it("preserves other orders allocation floors and immutable history against direct SQL tampering", async () => {
    const item = await paid();
    await apply(await request(item.orderId));
    const r = await request(item.orderId, "ship");
    for (const sql of [
      "UPDATE commerce_orders SET fulfillment='completed' WHERE state='confirmed'",
      "UPDATE commerce_inventory SET allocated=0",
      "DELETE FROM commerce_owner_fulfillment_commands",
      "UPDATE commerce_owner_fulfillment_commands SET recorded_at=0",
      "INSERT OR REPLACE INTO commerce_owner_fulfillment_commands SELECT * FROM commerce_owner_fulfillment_commands",
    ])
      await expect(db.prepare(sql).run()).rejects.toThrow();
    await expect(
      applyStockCommand(
        db,
        `fixture-${crypto.randomUUID()}`,
        [
          {
            variantId: item.variantId,
            kind: "fulfill",
            quantity: 1,
            reason: "Cannot steal paid allocation",
          },
        ],
        now + 40000,
      ),
    ).rejects.toThrow();
    await apply(r);
    await expect(
      db
        .prepare(
          "INSERT INTO commerce_stock_movements(command_id,position,variant_id,kind,quantity,reason) VALUES (?,2,?,'fulfill',1,'Owner recorded whole-order test handoff')",
        )
        .bind(`owner-fulfillment-${r.requestId}`, item.variantId)
        .run(),
    ).rejects.toThrow();
    expect(await balance(item.variantId)).toMatchObject({
      on_hand: 3,
      allocated: 0,
    });
  });
  it("releases only the handed-over order when two paid orders share a variant", async () => {
    const first = await paid(),
      second = await paid("shipping", false, false, first.variantId);
    expect(await balance(first.variantId)).toMatchObject({
      on_hand: 4,
      allocated: 2,
    });
    await apply(await request(first.orderId));
    await apply(await request(first.orderId, "ship"));
    expect(await balance(first.variantId)).toMatchObject({
      on_hand: 3,
      allocated: 1,
    });
    await expect(
      applyStockCommand(
        db,
        `fixture-${crypto.randomUUID()}`,
        [
          {
            variantId: first.variantId,
            kind: "fulfill",
            quantity: 1,
            reason: "Cannot steal other owned allocation",
          },
        ],
        now + 40000,
      ),
    ).rejects.toThrow();
    expect(await readOwnerFulfillment(db, scope, second.orderId)).toMatchObject(
      { state: "ready_to_pack", version: 3 },
    );
    await apply(await request(second.orderId));
    await apply(await request(second.orderId, "ship"));
    expect(await balance(first.variantId)).toMatchObject({
      on_hand: 2,
      allocated: 0,
    });
  });
  it("snapshots own data synchronously and preserves final authorization refusal and fresh time", async () => {
    const item = await paid(),
      r = await request(item.orderId),
      original = structuredClone(r);
    let clock = now + 40000;
    expect(
      await applyOwnerFulfillment(
        db,
        scope,
        actor,
        r,
        () => clock,
        async () => {
          r.operation = "ship";
          r.expectedVersion = 999;
          clock++;
        },
      ),
    ).toMatchObject({ operation: "pack", recordedAt: now + 40001 });
    expect(
      await lookupOwnerFulfillmentCommand(db, scope, actor, original),
    ).toMatchObject({ state: "recorded" });
    const denied = new Error("Denied");
    await expect(
      applyOwnerFulfillment(
        db,
        scope,
        actor,
        await request(item.orderId, "ship"),
        () => clock,
        async () => {
          throw denied;
        },
      ),
    ).rejects.toBe(denied);
    const spy = vi.fn();
    for (const raw of [
      { ...r, extra: true },
      { ...r, acknowledge: false },
      Object.defineProperty({ ...r }, "operation", {
        get() {
          throw Error("getter");
        },
      }),
    ])
      await expect(
        applyOwnerFulfillment(
          { prepare: spy } as unknown as D1Database,
          scope,
          actor,
          raw as OwnerFulfillmentInput,
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    expect(spy).not.toHaveBeenCalled();
    expect(await commands()).toHaveLength(1);
  });
});
