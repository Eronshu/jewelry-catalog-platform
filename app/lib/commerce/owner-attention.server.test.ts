import {
  startOwnedPayPalPayment,
  reconcileOwnedPayPalPayment,
  captureOwnedPayPalPayment,
} from "./owned-paypal.server";
import type {
  PayPalSandboxConfig,
  PayPalSandboxFetch,
} from "./paypal-sandbox.server";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

import {
  startOwnedStripePayment,
  reconcileOwnedStripePayment,
} from "./owned-stripe.server";
import type {
  StripeSandboxConfig,
  StripeSandboxFetch,
} from "./stripe-sandbox.server";
import {
  applyOwnerNotification,
  readOwnerNotifications,
} from "./order-notification.server";
import type {
  NotificationConfig,
  OwnerNotificationInput,
  OwnerNotificationOperation,
} from "./order-notification";
import {
  applyOwnerFulfillment,
  readOwnerFulfillment,
} from "./owner-fulfillment.server";
import { readOwnerAttention } from "./owner-attention.server";
import type { AttentionScope, AttentionQuery } from "./owner-attention";

let directory: string,
  baseline: string,
  current: string,
  platform: PlatformProxy<Env> | undefined,
  db: D1Database,
  sequence = 0;
function configuration(path: string) {
  const filename = join(path, "wrangler.json");
  writeFileSync(
    filename,
    JSON.stringify({
      name: "fictional-owner-attention",
      compatibility_date: "2026-10-01",
      d1_databases: [
        {
          binding: "DB",
          database_name: "fixture",
          database_id: "00000000-0000-0000-0000-000000000000",
          migrations_dir: join(root, "migrations"),
        },
      ],
    }),
  );
  return filename;
}
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "owner-attention-"));
  baseline = join(directory, "baseline");
  mkdirSync(baseline);
  execFileSync(
    join(root, "node_modules/.bin/wrangler"),
    [
      "d1",
      "migrations",
      "apply",
      "DB",
      "--config",
      configuration(baseline),
      "--local",
      "--persist-to",
      join(baseline, "state"),
    ],
    {
      env: {
        PATH: process.env.PATH,
        CI: "1",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_PATH: join(directory, "wrangler.log"),
      },
      stdio: "pipe",
      timeout: 30000,
    },
  );
}, 40000);
beforeEach(async () => {
  current = mkdtempSync(join(directory, "case-"));
  cpSync(join(baseline, "state"), join(current, "state"), { recursive: true });
  platform = await getPlatformProxy<Env>({
    configPath: configuration(current),
    envFiles: [],
    remoteBindings: false,
    persist: { path: join(current, "state/v3") },
  });
  db = platform.env.DB;
  await db
    .prepare(
      "INSERT INTO commerce_payment_scope(id,mode,instance_id,stripe_account_ref,paypal_account_ref) VALUES(1,'local-test',?,'fixture-stripe','fixture-paypal')",
    )
    .bind(trusted.instanceId)
    .run();
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

const actor = { email: "fictional-owner@example.test", sub: "fixture-owner" };
const scope = { mode: "local-test" as const, instanceId: trusted.instanceId };
const notificationConfig: NotificationConfig = {
  ...scope,
  canonicalOrigin: config.canonicalOrigin,
  linkSecret: "c".repeat(64),
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
        "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'commerce_%' ORDER BY name",
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
const paypalTrusted = {
  ...trusted,
  provider: "paypal" as const,
  accountRef: "fixture-paypal",
};
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

const attentionScope: AttentionScope = {
  ...scope,
  canonicalOrigin: config.canonicalOrigin,
};
const all: AttentionQuery = { filter: "all", reference: "", after: null };
const review = (q: Partial<AttentionQuery> = {}, s = attentionScope) =>
  readOwnerAttention(db, s, { ...all, ...q }, () => now + 50001);
async function prepare(orderId: string) {
  await apply(command(orderId));
  return (await read(orderId))!.notifications;
}
async function processing() {
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
  return item;
}

describe("read-only fictional operating review", () => {
  it("keeps persisted unknown payment unresolved without deriving success from transport", async () => {
    const item = await processing();
    // Adversarial persisted-state fixture only; runtime review performs no writes.
    await db.exec("DROP TRIGGER commerce_checkout_order_no_update;");
    await db
      .prepare("UPDATE commerce_orders SET payment_state='unknown' WHERE id=?")
      .bind(item.orderId)
      .run();
    const before = await history();
    expect((await review()).items[0]).toMatchObject({
      orderId: item.orderId,
      paymentState: "unknown",
      paymentReview: true,
    });
    expect(await history()).toEqual(before);
  });
  it.each([
    "PAYMENT.CAPTURE.REFUNDED",
    "PAYMENT.CAPTURE.REVERSED",
    "PAYMENT.CAPTURE.DENIED",
    "PAYMENT.CAPTURE.DECLINED",
  ])(
    "retains paid PayPal proof and flags persisted %s for manual review",
    async (eventType) => {
      const item = await held();
      await begin(
        db,
        paypalTrusted,
        {
          requestId: crypto.randomUUID(),
          reference: item.orderId,
          expectedVersion: 1,
        },
        () => now + 1,
      );
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
      const n = (await prepare(item.orderId))[0];
      await apply(command(item.orderId, "test_delivered", n.id));
      expect((await review()).items).toEqual([]);
      // Persist the canonical normalized event, with the original provider-order binding.
      await db
        .prepare(
          "INSERT INTO commerce_owned_paypal_events(event_type,event_id,attempt_command_id,provider_order_id,payload_hash,recorded_at) SELECT ?,?,command_id,?,?,? FROM commerce_payment_attempts WHERE order_id=?",
        )
        .bind(
          eventType,
          crypto.randomUUID(),
          p.providerOrderId,
          "c".repeat(64),
          now + 50000,
          item.orderId,
        )
        .run();
      const before = await history(),
        v = await review({ filter: "payment" });
      expect(v.items[0]).toMatchObject({
        orderId: item.orderId,
        paymentState: "succeeded",
        paymentReview: true,
        refundReview: false,
        notificationMissing: 0,
      });
      expect(await history()).toEqual(before);
    },
  );

  it("counts canonical packing/handoff sources independently from capture preparation", async () => {
    const { orderId } = await paid();
    const n = (await prepare(orderId))[0];
    await apply(command(orderId, "test_delivered", n.id));
    for (const operation of ["pack", "ship"] as const) {
      const current = (await readOwnerFulfillment(db, scope, orderId))!;
      await applyOwnerFulfillment(
        db,
        scope,
        actor,
        {
          requestId: crypto.randomUUID(),
          orderId,
          operation,
          expectedVersion: current.version,
          acknowledge: true,
        },
        () => now + 40000,
      );
    }
    expect((await review()).items[0]).toMatchObject({
      orderId,
      notificationMissing: 2,
      paymentReview: false,
    });
    await prepare(orderId);
    expect((await review()).items[0]).toMatchObject({
      notificationMissing: 0,
      notificationPending: 2,
    });
  });

  it("excludes unpaid/no-attempt and legacy orders; shows prepared, open and uncertain owned attempts", async () => {
    await held();
    await held(true);
    expect((await review()).items).toEqual([]);
    const a = await processing();
    expect((await review()).items).toEqual([
      expect.objectContaining({
        orderId: a.orderId,
        paymentState: "processing",
        paymentReview: true,
        refundReview: false,
        notificationMissing: 0,
      }),
    ]);
    const b = await processing(),
      p = await provider(b.orderId);
    await startOwnedStripePayment(
      db,
      config,
      target(b.orderId),
      p.call,
      () => now + 2,
    );
    const c = await processing(),
      lost = await provider(c.orderId);
    lost.state.loseCreate = true;
    await startOwnedStripePayment(
      db,
      config,
      target(c.orderId),
      lost.call,
      () => now + 2,
    );
    const v = await review();
    expect(v.items).toHaveLength(3);
    expect(v.items.every((i) => i.paymentReview)).toBe(true);
    expect(v.items.find((i) => i.orderId === c.orderId)?.paymentState).toBe(
      "processing",
    );
    expect(v.summary).toEqual({
      orderCount: 3,
      paymentCount: 3,
      refundCount: 0,
      notificationCount: 0,
    });
  });
  it("requires canonical paid proof, counts missing preparation and excludes healthy simulated delivery", async () => {
    const { orderId } = await paid();
    const missing = await review();
    expect(missing.items).toEqual([
      expect.objectContaining({
        orderId,
        paymentReview: false,
        notificationMissing: 1,
        notificationPending: 0,
      }),
    ]);
    const n = (await prepare(orderId))[0];
    expect((await review()).items[0]).toMatchObject({
      notificationMissing: 0,
      notificationPending: 1,
      notificationFailed: 0,
    });
    await apply(command(orderId, "test_delivered", n.id));
    expect((await review()).items).toEqual([]);
    expect((await review()).summary).toEqual({
      orderCount: 0,
      paymentCount: 0,
      refundCount: 0,
      notificationCount: 0,
    });
  });
  it("counts active latest failures once, marks exhausted retries, and treats revoke/delivery as terminal", async () => {
    const { orderId } = await paid(),
      n = (await prepare(orderId))[0];
    await apply(command(orderId, "test_failed", n.id));
    expect((await review()).items[0]).toMatchObject({
      notificationPending: 0,
      notificationFailed: 1,
      notificationExhausted: 0,
    });
    for (let i = 0; i < 2; i++)
      await apply(command(orderId, "test_failed", n.id));
    expect((await review()).items[0]).toMatchObject({
      notificationFailed: 1,
      notificationExhausted: 1,
    });
    await apply(command(orderId, "revoke", n.id));
    expect((await review()).items).toEqual([]);
    const other = await paid(),
      m = (await prepare(other.orderId))[0];
    await apply(command(other.orderId, "test_failed", m.id));
    await apply(command(other.orderId, "test_delivered", m.id));
    expect((await review()).items).toEqual([]);
  });
  it("retains expired pending and failed intents for manual review without inventing retries", async () => {
    const a = await paid(),
      n = (await prepare(a.orderId))[0];
    const b = await paid(),
      m = (await prepare(b.orderId))[0];
    await apply(command(b.orderId, "test_failed", m.id));
    const v = await readOwnerAttention(
      db,
      attentionScope,
      all,
      () => n.expiresAt + 1,
    );
    expect(v.items.find((i) => i.orderId === a.orderId)).toMatchObject({
      notificationPending: 1,
      notificationFailed: 0,
    });
    expect(v.items.find((i) => i.orderId === b.orderId)).toMatchObject({
      notificationPending: 0,
      notificationFailed: 1,
      notificationExhausted: 0,
    });
  });
  it("reviews unconfirmed partial/full refund intents and deduplicates confirmed success observations", async () => {
    const a = await paid(),
      n = (await prepare(a.orderId))[0];
    await apply(command(a.orderId, "test_delivered", n.id));
    const partial = await refund(a.orderId, 100, false);
    expect((await review({ filter: "refund" })).items[0]).toMatchObject({
      orderId: a.orderId,
      refundReview: true,
    });
    await partial.observe("failed");
    expect((await review({ filter: "refund" })).items).toHaveLength(1);
    await partial.observe("succeeded");
    await partial.observe("succeeded");
    expect((await review({ filter: "refund" })).items).toEqual([]);
    expect((await review()).items[0]).toMatchObject({
      notificationMissing: 1,
      refundReview: false,
    });
    const full = await refund(a.orderId, 4306, false);
    expect((await review({ filter: "refund" })).summary.refundCount).toBe(1);
    await full.observe("succeeded");
    expect((await review()).items[0]).toMatchObject({
      notificationMissing: 2,
      refundReview: false,
    });
  });
  it("separates prepared refunds from observations and distinct order summaries across overlapping categories", async () => {
    const { orderId } = await paid();
    const requestId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO commerce_owner_refund_intents(request_id,mode,instance_id,actor_hash,request_hash,order_id,capture_id,expected_version,operation_key,provider,account_ref,canonical_origin,transaction_ref,payment_intent_ref,provider_object_ref,payment_request_id,create_operation_key,amount_cents,refund_cents,prior_refunded_cents,input_contract,recorded_at) SELECT ?,mode,instance_id,?,?,order_id,capture_id,version,?,provider,account_ref,canonical_origin,transaction_ref,payment_intent_ref,provider_object_ref,payment_request_id,create_operation_key,amount_cents,100,0,'partial-v2',? FROM commerce_owner_refund_sources WHERE order_id=?`,
      )
      .bind(
        requestId,
        "1".repeat(64),
        "2".repeat(64),
        requestId,
        now + 40000,
        orderId,
      )
      .run();
    await processing();
    const expected = {
      orderCount: 2,
      paymentCount: 1,
      refundCount: 1,
      notificationCount: 1,
    };
    for (const filter of ["all", "payment", "refund", "notifications"] as const)
      expect((await review({ filter })).summary).toEqual(expected);
    expect((await review({ reference: orderId })).summary).toEqual({
      orderCount: 1,
      paymentCount: 0,
      refundCount: 1,
      notificationCount: 1,
    });
  });
  it("counts all missing events across the existing100-event preparation boundary", async () => {
    const { orderId } = await paid();
    for (let i = 0; i < 100; i++) await refund(orderId, 1);
    expect((await review()).items[0].notificationMissing).toBe(101);
    await prepare(orderId);
    expect((await review()).items[0]).toMatchObject({
      notificationMissing: 1,
      notificationPending: 100,
    });
    await prepare(orderId);
    expect((await review()).items[0]).toMatchObject({
      notificationMissing: 0,
      notificationPending: 101,
    });
    expect((await review()).summary.notificationCount).toBe(1);
    expect(await notificationCount()).toBe(101);
  }, 30000);
  it("uses bounded stable25-row keyset pages including creation-time ties, filters and exact references", async () => {
    for (let i = 0; i < 27; i++) await processing();
    const first = await review();
    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await review({ after: first.nextCursor });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(second.summary).toEqual(first.summary);
    const ids = [...first.items, ...second.items].map((i) => i.orderId);
    expect(new Set(ids).size).toBe(27);
    expect(ids).toEqual([...ids].sort().reverse());
    const reference = ids[0];
    expect((await review({ reference })).items.map((i) => i.orderId)).toEqual([
      reference,
    ]);
    expect(
      (await review({ reference: `order-${crypto.randomUUID()}` })).items,
    ).toEqual([]);
    expect((await review({ filter: "refund" })).items).toEqual([]);
    for (const q of [
      { filter: "payment" as const, after: first.nextCursor },
      { reference, after: first.nextCursor },
    ])
      await expect(review(q)).rejects.toMatchObject({
        code: "invalid_request",
      });
    await expect(
      review(
        { after: first.nextCursor },
        { ...attentionScope, instanceId: crypto.randomUUID() },
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      review(
        { after: first.nextCursor },
        { ...attentionScope, canonicalOrigin: "http://127.0.0.1:8799" },
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
  }, 30000);
  it("excludes associated foreign-origin and malformed witnesses; refuses a different instance", async () => {
    const paidOrder = await paid(),
      pending = await processing(),
      p = await provider(pending.orderId);
    await startOwnedStripePayment(
      db,
      config,
      target(pending.orderId),
      p.call,
      () => now + 2,
    );
    expect(
      (
        await review(
          {},
          { ...attentionScope, canonicalOrigin: "http://127.0.0.1:8799" },
        )
      ).items,
    ).toEqual([]);
    await expect(
      review({}, { ...attentionScope, instanceId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "conflict" });
    await db.exec("DROP TRIGGER commerce_checkout_quotes_no_update;");
    await db
      .prepare(
        "UPDATE commerce_checkout_quotes SET snapshot_json=json_set(snapshot_json,'$.fixtureProfile.name','Untrusted witness') WHERE quote_id=(SELECT checkout_quote_id FROM commerce_checkout_order_origins WHERE order_id=?)",
      )
      .bind(paidOrder.orderId)
      .run();
    expect((await review()).items.map((i) => i.orderId)).toEqual([
      pending.orderId,
    ]);
  });
  it("reads only minimal projection and leaves every commerce table and rowid unchanged", async () => {
    const { orderId } = await paid();
    await refund(orderId, 100, false);
    await prepare(orderId);
    const before = await history(),
      v = await review();
    await review({ filter: "payment" });
    await review({ filter: "refund" });
    await review({ filter: "notifications", reference: orderId });
    expect(await history()).toEqual(before);
    expect(Object.keys(v.items[0]).sort()).toEqual(
      [
        "orderId",
        "createdAt",
        "totalCents",
        "paymentState",
        "fulfillment",
        "paymentReview",
        "refundReview",
        "notificationPending",
        "notificationFailed",
        "notificationMissing",
        "notificationExhausted",
      ].sort(),
    );
    const serialized = JSON.stringify(v);
    for (const value of [
      trusted.ownerHash,
      "example.invalid",
      "acct_",
      "cs_test_",
      "token_hash",
      "source_id",
    ])
      expect(serialized).not.toContain(value);
  });
  it("validates exact inputs/accessors/cursors/clock before any database access and masks storage failures", async () => {
    const prepare = vi.fn(() => {
        throw new Error("private storage detail");
      }),
      inaccessible = { prepare } as unknown as D1Database;
    const invalidQueries: unknown[] = [
      { ...all, reference: "order-partial" },
      { ...all, reference: `order-${crypto.randomUUID()}`.toUpperCase() },
      { ...all, filter: "paid" },
      { ...all, extra: true },
      { ...all, after: "" },
      { ...all, after: "%%%" },
      { ...all, after: "a".repeat(2049) },
      {
        ...all,
        get reference() {
          throw new Error("must not read");
        },
      },
    ];
    for (const q of invalidQueries)
      await expect(
        readOwnerAttention(inaccessible, attentionScope, q as AttentionQuery),
      ).rejects.toMatchObject({ code: "invalid_request" });
    for (const s of [
      { ...attentionScope, mode: "sandbox" },
      { ...attentionScope, canonicalOrigin: "https://example.com" },
      { ...attentionScope, canonicalOrigin: "http://127.0.0.1:65536" },
      { ...attentionScope, canonicalOrigin: "http://127.0.0.1:08791" },
      { ...attentionScope, canonicalOrigin: "http://127.0.0.1:8791/" },
      { ...attentionScope, extra: true },
    ])
      await expect(
        readOwnerAttention(inaccessible, s as AttentionScope, all),
      ).rejects.toMatchObject({ code: "invalid_request" });
    for (const clock of [
      () => NaN,
      () => -1,
      () => 1.5,
      () => {
        throw new Error("clock");
      },
    ])
      await expect(
        readOwnerAttention(inaccessible, attentionScope, all, clock),
      ).rejects.toMatchObject({ code: "invalid_request" });
    expect(prepare).not.toHaveBeenCalled();
    await expect(
      readOwnerAttention(inaccessible, attentionScope, all, () => now),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: "The fictional operating review could not be read",
    });
  });
});
