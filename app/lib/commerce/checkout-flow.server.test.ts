import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { createRequestHandler, RouterContextProvider } from "react-router";
import { cloudflareContext } from "../../cloudflare-context";
import * as CommandsRoute from "../../routes/checkout-commands";
import * as CancelRoute from "../../routes/checkout-order-cancel";
import * as PaymentRoute from "../../routes/checkout-order-payment";
import * as ConfirmationRoute from "../../routes/checkout-confirm";
import * as StatusRoute from "../../routes/checkout-order";
import * as StripeRoute from "../../routes/checkout-order-stripe";
import * as StripeWebhookRoute from "../../routes/checkout-stripe-webhook";
import { actStripeCheckout, actStripeWebhook } from "./stripe-checkout.server";
import { STRIPE_SANDBOX_API_VERSION } from "./stripe-sandbox.server";
import {
  loadCheckoutConfirmation,
  actCheckoutConfirmation,
  loadCheckoutOrder,
  cancelCheckoutOrder,
  prepareCheckoutPayment,
  type OwnedCheckoutOrder,
} from "./checkout-flow.server";
import { handleLocalExpiry } from "./expiry-trigger.server";
import { applyStockCommand } from "./inventory.server";
import { expireOwnedCheckoutBatch } from "./checkout-expiry.server";
import { loadCommerceWorkspace } from "./workspace.server";
import { adminPrincipalContext } from "../auth/admin-access.server";
import { createTestQuote, reserveTestOrder } from "./orders.server";
const root = resolve(process.cwd()),
  origin = "http://127.0.0.1:8791",
  instance = "11111111-1111-4111-8111-111111111111",
  task = "c".repeat(64);
let directory: string,
  platform: PlatformProxy<Env>,
  db: D1Database,
  sequence = 0;
function settings(database = db, extra = {}) {
  return {
    DB: database,
    COMMERCE_MODE: "local-test",
    COMMERCE_CHECKOUT_INSTANCE_ID: instance,
    COMMERCE_CHECKOUT_ORIGIN: origin,
    COMMERCE_CHECKOUT_EXPIRY: "local-test",
    COMMERCE_CHECKOUT_NEW_ORDERS: "local-test",
    COMMERCE_LOCAL_EXPIRY_TOKEN: task,
    ...extra,
  } as unknown as Env;
}
function get(path = "/checkout/confirm", cookie?: string) {
  return new Request(origin + path, {
    headers: cookie ? { Cookie: cookie } : {},
  });
}
function post(path: string, cookie: string, body: Record<string, string>) {
  return new Request(origin + path, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
  });
}
async function count(table: string) {
  return (await db
    .prepare(`SELECT count(*) AS n FROM ${table}`)
    .first<{ n: number }>())!.n;
}
async function fixture() {
  const id = `flow-${++sequence}`;
  const p = await db
    .prepare(
      "INSERT INTO products(name,slug,price_cents,category_id,status,created_at,updated_at) VALUES ('Fictional necklace',?,999,1,'draft',1,1) RETURNING id",
    )
    .bind(id)
    .first<{ id: number }>();
  await db.batch([
    db
      .prepare(
        "INSERT INTO product_images(product_id,r2_key,sort_order,created_at) VALUES (?, ?,0,1)",
      )
      .bind(p!.id, `fictional/${id}.png`),
    db.prepare("UPDATE products SET status='available' WHERE id=?").bind(p!.id),
    db
      .prepare(
        "INSERT INTO commerce_variants(id,product_id,sku,colour,size_description,price_cents,active) VALUES (?,?,?,'Gold-tone','Fictional size',2500,1)",
      )
      .bind(id, p!.id, id),
  ]);
  await applyStockCommand(
    db,
    crypto.randomUUID(),
    [
      {
        variantId: id,
        kind: "receive",
        quantity: 30,
        reason: "Fictional inspected stock",
      },
    ],
    Date.now(),
  );
  return id;
}
async function browser(env = settings()) {
  const response = await loadCheckoutConfirmation(get(), env);
  expect(response.status).toBe(200);
  const cookie = response.headers.get("Set-Cookie")!.split(";", 1)[0];
  return {
    cookie,
    ...((await response.json()) as { csrfToken: string; pending: unknown[] }),
  };
}
async function quoted(
  client: Awaited<ReturnType<typeof browser>>,
  id?: string,
  env = settings(),
) {
  const variantId = id ?? (await fixture());
  const selection = JSON.stringify({
    contractVersion: "local-checkout-v1",
    lines: [{ variantId, quantity: 1 }],
    fixtureProfileId: "fixture-ontario",
    deliveryMethod: "shipping",
  });
  const request = {
    operation: "quote",
    csrf: client.csrfToken,
    issueKey: crypto.randomUUID(),
    selection,
  };
  const response = await actCheckoutConfirmation(
    post("/checkout/confirm", client.cookie, request),
    env,
  );
  expect(response.status).toBe(200);
  const { quote } = (await response.json()) as {
    quote: { quoteId: string; expiresAt: number; totalCents: number };
  };
  return {
    variantId,
    quote,
    request,
    confirm: {
      operation: "confirm",
      csrf: client.csrfToken,
      acceptanceKey: crypto.randomUUID(),
      createKey: crypto.randomUUID(),
      quoteId: quote.quoteId,
      selection,
      acknowledge: "yes",
    },
  };
}
async function create(
  client: Awaited<ReturnType<typeof browser>>,
  id?: string,
  env = settings(),
) {
  const prepared = await quoted(client, id, env);
  const response = await actCheckoutConfirmation(
    post("/checkout/confirm", client.cookie, prepared.confirm),
    env,
  );
  expect(response.status).toBe(200);
  return { ...prepared, ...((await response.json()) as { orderId: string }) };
}
function context(env = settings()) {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, { env, ctx: {} as ExecutionContext });
  return value;
}
function workspaceContext(env = settings()) {
  const value = context(env);
  value.set(adminPrincipalContext, {
    email: "owner@example.invalid",
    sub: "fictional-owner",
  });
  return value;
}
const commandRoutes = {
  stripe: {
    id: "stripe",
    path: "checkout/orders/:orderId/stripe",
    module: StripeRoute,
  },
  webhook: {
    id: "webhook",
    path: "checkout/stripe/webhook",
    module: StripeWebhookRoute,
  },
  commands: {
    id: "commands",
    path: "checkout/commands",
    module: CommandsRoute,
  },
  cancel: {
    id: "cancel",
    path: "checkout/orders/:orderId/cancel",
    module: CancelRoute,
  },
  payment: {
    id: "payment",
    path: "checkout/orders/:orderId/prepare-payment",
    module: PaymentRoute,
  },
};
const dispatch = createRequestHandler(
  {
    entry: {
      module: {
        default: () =>
          new Response("Unexpected document rendering", {
            headers: { "Content-Type": "text/html" },
          }),
      },
    },
    routes: commandRoutes,
    assets: {
      entry: { imports: [], module: "/entry.js" },
      routes: Object.fromEntries(
        Object.entries(commandRoutes).map(([id, route]) => [
          id,
          {
            id,
            path: route.path,
            module: `/${id}.js`,
            hasLoader: true,
            hasAction: true,
          },
        ]),
      ),
      url: "/manifest.js",
      version: "test",
    },
    publicPath: "/",
    assetsBuildDirectory: "build/client",
    future: {},
    ssr: true,
    isSpaMode: false,
    prerender: [],
    routeDiscovery: { mode: "initial", manifestPath: "/manifest.js" },
  } as unknown as Parameters<typeof createRequestHandler>[0],
  "test",
);
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "customer-order-flow-"));
  const configPath = join(directory, "wrangler.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "fictional-customer-flow",
      compatibility_date: "2026-09-29",
      d1_databases: [
        {
          binding: "DB",
          database_name: "fictional-flow",
          database_id: "local-test",
          migrations_dir: join(root, "migrations"),
          migrations_table: "catalog_migrations",
        },
      ],
    }),
  );
  execFileSync(
    join(root, "node_modules/.bin/wrangler"),
    [
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--config",
      configPath,
      "--persist-to",
      directory,
    ],
    {
      env: {
        ...process.env,
        CI: "1",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_PATH: join(directory, "wrangler.log"),
      },
      stdio: "pipe",
      timeout: 20000,
    },
  );
  platform = await getPlatformProxy<Env>({
    configPath,
    envFiles: [],
    remoteBindings: false,
    persist: { path: join(directory, "v3") },
  });
  db = platform.env.DB;
  await db
    .prepare(
      "INSERT INTO commerce_payment_scope(id,mode,instance_id,stripe_account_ref,paypal_account_ref) VALUES (1,'local-test',?,'fixture-stripe','fixture-paypal')",
    )
    .bind(instance)
    .run();
}, 30000);
afterAll(async () => {
  await platform?.dispose();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("visible customer order flow on real temporary D1", () => {
  it("connects owned checkout, hosted test Session, canonical payment, shared inventory and owner status without trusting the return", async () => {
    const client = await browser();
    const created = await create(client);
    const accountId = "acct_FictionalRoute123";
    const signingSecret = ["whsec", "0".repeat(24)].join("_");
    const enabled = settings(db, {
      COMMERCE_CHECKOUT_PAYMENT_PREPARE: "local-test",
      COMMERCE_STRIPE_SANDBOX: "local-test",
      COMMERCE_STRIPE_NEW_SESSIONS: "local-test",
      COMMERCE_STRIPE_ACCOUNT_ID: accountId,
      COMMERCE_STRIPE_TEST_SECRET: ["sk", "test", "0".repeat(24)].join("_"),
      COMMERCE_STRIPE_SIGNING_SECRET: signingSecret,
    });
    const paused = {
      ...enabled,
      COMMERCE_STRIPE_NEW_SESSIONS: undefined,
    } as unknown as Env;
    let now = Date.now(),
      captured = false;
    let session: Record<string, unknown> | undefined;
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      expect(url.startsWith("https://api.stripe.com/v1/")).toBe(true);
      if (url.endsWith("/account"))
        return Response.json({ object: "account", id: accountId });
      if (url.endsWith("/checkout/sessions") && init.method === "POST") {
        const form = new URLSearchParams(String(init.body));
        const metadata = Object.fromEntries(
          [...form.entries()]
            .filter(([key]) => key.startsWith("metadata["))
            .map(([key, value]) => [key.slice(9, -1), value]),
        );
        session = {
          object: "checkout.session",
          id: "cs_test_FictionalRoute123",
          livemode: false,
          mode: "payment",
          currency: "cad",
          amount_total: 4400,
          client_reference_id: created.orderId,
          expires_at: Number(form.get("expires_at")),
          status: "open",
          payment_status: "unpaid",
          payment_intent: null,
          metadata,
          url: "https://checkout.stripe.com/c/pay/fictional-route",
        };
        expect(metadata.attempt_id).toMatch(/^[a-f0-9-]{36}$/);
        expect(form.get("payment_intent_data[metadata][attempt_id]")).toBe(
          metadata.attempt_id,
        );
        return Response.json(session);
      }
      if (url.includes("/checkout/sessions/"))
        return Response.json({
          ...session,
          ...(captured
            ? {
                status: "complete",
                payment_status: "paid",
                payment_intent: "pi_FictionalRoute123",
                url: null,
              }
            : {}),
        });
      if (url.includes("/payment_intents/"))
        return Response.json({
          id: "pi_FictionalRoute123",
          object: "payment_intent",
          livemode: false,
          status: "succeeded",
          currency: "cad",
          amount: 4400,
          amount_received: 4400,
          amount_capturable: 0,
          metadata: session!.metadata,
          latest_charge: "ch_FictionalRoute123",
        });
      if (url.includes("/charges/"))
        return Response.json({
          id: "ch_FictionalRoute123",
          object: "charge",
          payment_intent: "pi_FictionalRoute123",
          livemode: false,
          status: "succeeded",
          paid: true,
          captured: true,
          currency: "cad",
          amount: 4400,
          amount_captured: 4400,
          refunded: false,
          amount_refunded: 0,
          disputed: false,
        });
      throw new Error("Unexpected injected test request");
    });
    const path = `/checkout/orders/${created.orderId}/stripe`;
    const input = {
      csrf: client.csrfToken,
      operation: "start",
      requestId: crypto.randomUUID(),
      expectedVersion: "1",
    };
    const start = await actStripeCheckout(
      post(path, client.cookie, input),
      enabled,
      created.orderId,
      transport,
      () => now,
    );
    expect(start.status).toBe(200);
    expect(await start.json()).toMatchObject({
      stripe: { state: "open", canStart: false, canQuery: true },
      order: {
        state: "pending_payment",
        paymentState: "processing",
        totalCents: 4400,
      },
    });
    expect(
      transport.mock.calls.filter(([, init]) => init.method === "POST"),
    ).toHaveLength(1);
    const returned = await loadCheckoutOrder(
      get(
        `/checkout/orders/${created.orderId}?stripe_return=success`,
        client.cookie,
      ),
      enabled,
      created.orderId,
    );
    expect(await returned.json()).toMatchObject({
      order: { paymentState: "processing" },
      stripe: { state: "open" },
    });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(
      (
        await actStripeCheckout(
          post(path, client.cookie, input),
          paused,
          created.orderId,
          transport,
          () => now,
        )
      ).status,
    ).toBe(503);
    captured = true;
    now += 31000;
    const query = await actStripeCheckout(
      post(path, client.cookie, {
        ...input,
        operation: "query",
        expectedVersion: "2",
      }),
      paused,
      created.orderId,
      transport,
      () => now,
    );
    expect(query.status).toBe(200);
    expect(await query.json()).toMatchObject({
      stripe: { state: "paid", canStart: false },
      order: { state: "confirmed", paymentState: "succeeded", version: 3 },
    });
    expect(
      await db
        .prepare(
          "SELECT checkout_reserved,allocated FROM commerce_inventory WHERE variant_id=?",
        )
        .bind(created.variantId)
        .first(),
    ).toEqual({ checkout_reserved: 0, allocated: 1 });
    const workspace = await loadCommerceWorkspace(
      get(`/admin/commerce/orders/${created.orderId}`),
      workspaceContext(),
      "order",
      created.orderId,
    );
    expect(workspace.data).toMatchObject({
      order: {
        orderState: "confirmed",
        paymentState: "succeeded",
        fulfillmentState: "ready_to_pack",
      },
    });
    const raw = JSON.stringify({
      id: "evt_FictionalRoute123",
      object: "event",
      livemode: false,
      api_version: STRIPE_SANDBOX_API_VERSION,
      type: "checkout.session.completed",
      created: Math.floor(now / 1000),
      data: {
        object: {
          ...session,
          status: "complete",
          payment_status: "paid",
          payment_intent: "pi_FictionalRoute123",
          url: null,
        },
      },
    });
    const timestamp = Math.floor(now / 1000);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = [
      ...new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(`${timestamp}.${raw}`),
        ),
      ),
    ]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    const webhook = () =>
      new Request(origin + "/checkout/stripe/webhook", {
        method: "POST",
        body: raw,
        headers: {
          "Stripe-Signature": `t=${timestamp},v1=${digest}`,
          "Content-Type": "application/json",
        },
      });
    expect(
      (await actStripeWebhook(webhook(), enabled, transport, () => now)).status,
    ).toBe(200);
    expect(
      (await actStripeWebhook(webhook(), enabled, transport, () => now)).status,
    ).toBe(200);
    expect(
      await db
        .prepare(
          "SELECT count(*) AS n FROM commerce_payment_capture_facts f JOIN commerce_payment_attempts a ON a.command_id=f.attempt_command_id WHERE a.order_id=?",
        )
        .bind(created.orderId)
        .first(),
    ).toEqual({ n: 1 });
  });
  it("rejects disabled, foreign-owner, client-supplied amounts, CSRF and bad signatures before provider dispatch", async () => {
    const client = await browser(),
      stranger = await browser();
    const created = await create(client);
    const transport = vi.fn(async () => {
      throw new Error("No provider calls allowed");
    });
    const enabled = settings(db, {
      COMMERCE_STRIPE_SANDBOX: "local-test",
      COMMERCE_STRIPE_NEW_SESSIONS: "local-test",
      COMMERCE_STRIPE_ACCOUNT_ID: "acct_FictionalRoute123",
      COMMERCE_STRIPE_TEST_SECRET: ["sk", "test", "0".repeat(24)].join("_"),
      COMMERCE_STRIPE_SIGNING_SECRET: ["whsec", "0".repeat(24)].join("_"),
    });
    const path = `/checkout/orders/${created.orderId}/stripe`;
    const input = {
      csrf: client.csrfToken,
      operation: "start",
      requestId: crypto.randomUUID(),
      expectedVersion: "1",
    };
    for (const [cookie, form, env, status] of [
      [client.cookie, input, settings(), 503],
      [stranger.cookie, { ...input, csrf: stranger.csrfToken }, enabled, 404],
      [client.cookie, { ...input, csrf: "0".repeat(64) }, enabled, 403],
      [client.cookie, { ...input, totalCents: "1" }, enabled, 422],
    ] as const)
      expect(
        (
          await actStripeCheckout(
            post(path, cookie, form),
            env,
            created.orderId,
            transport,
          )
        ).status,
      ).toBe(status);
    expect(
      (
        await actStripeWebhook(
          new Request(origin + "/checkout/stripe/webhook", {
            method: "POST",
            body: "{}",
            headers: { "Stripe-Signature": "invalid" },
          }),
          enabled,
          transport,
        )
      ).status,
    ).toBe(400);
    expect(transport).not.toHaveBeenCalled();
    expect(
      (
        await loadCheckoutOrder(
          get(`/checkout/orders/${created.orderId}`, client.cookie),
          settings(),
          created.orderId,
        )
      ).status,
    ).toBe(200);
    // Leave no unpaid order for the independent bounded expiry test later in this fixture.
    await cancelCheckoutOrder(
      post(`/checkout/orders/${created.orderId}/cancel`, client.cookie, {
        csrf: client.csrfToken,
        releaseKey: crypto.randomUUID(),
        expectedVersion: "1",
      }),
      settings(),
      created.orderId,
    );
  });
  it("shows customer-created orders and frozen amounts in the owner workspace with matching stock and preparation state", async () => {
    const client = await browser();
    const variant = await fixture();
    await applyStockCommand(
      db,
      crypto.randomUUID(),
      [
        {
          variantId: variant,
          kind: "fb_reserve",
          quantity: 1,
          reason: "Fictional Facebook stock",
        },
      ],
      Date.now(),
    );
    const created = await create(client, variant);
    const read = async (
      page: "overview" | "orders" | "order" | "inventory",
      suffix = "",
      reference?: string,
    ) =>
      (
        await loadCommerceWorkspace(
          get(`/admin/commerce${suffix}`),
          workspaceContext(),
          page,
          reference,
        )
      ).data;
    const listed = await read("orders", `/orders?reference=${created.orderId}`);
    expect(listed).toMatchObject({
      kind: "orders",
      items: [
        {
          reference: created.orderId,
          totalCents: 4400,
          taxCents: 400,
          itemCount: 1,
          hasPaymentAttempt: false,
        },
      ],
    });
    const before = await read(
      "order",
      `/orders/${created.orderId}`,
      created.orderId,
    );
    expect(before).toMatchObject({
      kind: "order",
      lines: [
        {
          name: "Fictional necklace",
          quantity: 1,
          unitPriceCents: 2500,
          lineTotalCents: 2500,
        },
      ],
      order: { delivery: "shipping" },
    });
    expect(JSON.stringify(before)).not.toMatch(
      /ownerHash|owner_hash|token_hash|create_operation_key|rules_hash|fixtureProfile|email|snapshot/,
    );
    await db
      .prepare(
        "UPDATE products SET name='Changed catalog name' WHERE id=(SELECT product_id FROM commerce_variants WHERE id=?)",
      )
      .bind(variant)
      .run();
    expect(
      await read("order", `/orders/${created.orderId}`, created.orderId),
    ).toMatchObject({ lines: [{ name: "Fictional necklace" }] });
    const response = await prepareCheckoutPayment(
      post(
        `/checkout/orders/${created.orderId}/prepare-payment`,
        client.cookie,
        {
          csrf: client.csrfToken,
          requestId: crypto.randomUUID(),
          expectedVersion: "1",
        },
      ),
      settings(db, { COMMERCE_CHECKOUT_PAYMENT_PREPARE: "local-test" }),
      created.orderId,
    );
    expect(response.status).toBe(200);
    expect(
      await read("order", `/orders/${created.orderId}`, created.orderId),
    ).toMatchObject({
      order: {
        hasPaymentAttempt: true,
        paymentState: "processing",
        orderState: "pending_payment",
      },
    });
    expect(
      await read("inventory", `/inventory?search=${variant}`),
    ).toMatchObject({
      kind: "inventory",
      items: [
        {
          onHand: 30,
          facebookReserved: 1,
          checkoutReserved: 1,
          allocated: 0,
          websiteAvailable: 28,
        },
      ],
    });
    expect(await read("overview")).toMatchObject({
      kind: "overview",
      summary: { preparedCount: 1, pendingCount: 0 },
      recentOrders: expect.any(Array),
    });
    const cancelled = await create(client, variant);
    expect(
      (
        await cancelCheckoutOrder(
          post(`/checkout/orders/${cancelled.orderId}/cancel`, client.cookie, {
            csrf: client.csrfToken,
            releaseKey: crypto.randomUUID(),
            expectedVersion: "1",
          }),
          settings(),
          cancelled.orderId,
        )
      ).status,
    ).toBe(200);
    expect(
      await read(
        "orders",
        `/orders?status=cancelled&reference=${cancelled.orderId}`,
      ),
    ).toMatchObject({
      items: [{ reference: cancelled.orderId, orderState: "cancelled" }],
    });
  });
  it("keeps owner workspace reads scoped, read-only and private before accessing storage", async () => {
    const client = await browser(),
      created = await create(client);
    const inaccessible = new Proxy({} as D1Database, {
      get() {
        throw new Error("Storage must not be read");
      },
    });
    await expect(
      loadCommerceWorkspace(
        get("/admin/commerce"),
        context(settings(inaccessible)),
        "overview",
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      loadCommerceWorkspace(
        get("/admin/commerce"),
        workspaceContext(settings(inaccessible, { COMMERCE_MODE: "disabled" })),
        "overview",
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      loadCommerceWorkspace(
        post("/admin/commerce/orders", client.cookie, {}),
        workspaceContext(settings(inaccessible)),
        "orders",
      ),
    ).rejects.toMatchObject({ status: 405 });
    const result = await loadCommerceWorkspace(
      get("/admin/commerce/orders"),
      workspaceContext(),
      "orders",
    );
    expect(result.init?.headers).toMatchObject({
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    });
    const foreign = workspaceContext(
      settings(db, { COMMERCE_CHECKOUT_INSTANCE_ID: crypto.randomUUID() }),
    );
    expect(
      (
        await loadCommerceWorkspace(
          get("/admin/commerce/orders"),
          foreign,
          "orders",
        )
      ).data,
    ).toMatchObject({ items: [] });
    await expect(
      loadCommerceWorkspace(
        get(`/admin/commerce/orders/${created.orderId}`),
        foreign,
        "order",
        created.orderId,
      ),
    ).rejects.toMatchObject({ status: 404 });
    const faulty = new Proxy({} as D1Database, {
      get() {
        throw new Error("Sensitive internal details");
      },
    });
    try {
      await loadCommerceWorkspace(
        get("/admin/commerce"),
        workspaceContext(settings(faulty)),
        "overview",
      );
      throw new Error("Expected unavailable");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      expect((error as Response).status).toBe(503);
      expect(await (error as Response).text()).not.toContain("Sensitive");
    }
  });
  it("paginates owned orders with stable ties and excludes the legacy lab", async () => {
    const client = await browser(),
      variant = await fixture();
    const legacyVariant = await fixture();
    const legacyQuote = await createTestQuote(
      db,
      "d".repeat(64),
      [{ variantId: legacyVariant, quantity: 1 }],
      "pickup",
    );
    const legacy = await reserveTestOrder(db, "d".repeat(64), legacyQuote.id);
    const now = Date.now(),
      clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const ids = [];
    try {
      for (let i = 0; i < 26; i++)
        ids.push((await create(client, variant)).orderId);
    } finally {
      clock.mockRestore();
    }
    const first = (
      await loadCommerceWorkspace(
        get("/admin/commerce/orders?status=awaiting"),
        workspaceContext(),
        "orders",
      )
    ).data;
    if (first.kind !== "orders") throw new Error("Expected orders");
    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).not.toBeNull();
    const second = (
      await loadCommerceWorkspace(
        get(`/admin/commerce/orders?status=awaiting&after=${first.nextCursor}`),
        workspaceContext(),
        "orders",
      )
    ).data;
    if (second.kind !== "orders") throw new Error("Expected orders");
    const refs = [...first.items, ...second.items].map((o) => o.reference);
    expect(new Set(refs).size).toBe(refs.length);
    expect(ids.every((id) => refs.includes(id))).toBe(true);
    expect(refs).not.toContain(legacy.id);
    await expect(
      loadCommerceWorkspace(
        get(`/admin/commerce/orders/${legacy.id}`),
        workspaceContext(),
        "order",
        legacy.id,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      loadCommerceWorkspace(
        get(
          `/admin/commerce/orders?status=cancelled&after=${first.nextCursor}`,
        ),
        workspaceContext(),
        "orders",
      ),
    ).rejects.toMatchObject({ status: 400 });
    for (const query of [
      "status=made-up",
      "reference=bad",
      "status=all&status=all",
      "after=bad!",
      "ownerHash=forged",
    ])
      await expect(
        loadCommerceWorkspace(
          get(`/admin/commerce/orders?${query}`),
          workspaceContext(),
          "orders",
        ),
      ).rejects.toMatchObject({ status: 400 });
    // Reuse the existing fixture harness without leaving this pagination batch
    // ahead of the later bounded-expiry scenario's own orders.
    for (const id of ids)
      expect(
        (
          await cancelCheckoutOrder(
            post(`/checkout/orders/${id}/cancel`, client.cookie, {
              csrf: client.csrfToken,
              releaseKey: crypto.randomUUID(),
              expectedVersion: "1",
            }),
            settings(),
            id,
          )
        ).status,
      ).toBe(200);
  }, 15000);
  it("shows unavailable catalog stock honestly and treats inventory search wildcards literally", async () => {
    const variant = await fixture();
    await db
      .prepare(
        "UPDATE commerce_variants SET active=0,version=version+1 WHERE id=?",
      )
      .bind(variant)
      .run();
    const result = (
      await loadCommerceWorkspace(
        get(`/admin/commerce/inventory?status=unavailable&search=${variant}`),
        workspaceContext(),
        "inventory",
      )
    ).data;
    expect(result).toMatchObject({
      kind: "inventory",
      items: [{ onHand: 30, websiteAvailable: 0, active: false }],
    });
    expect(
      (
        await loadCommerceWorkspace(
          get("/admin/commerce/inventory?search=%25"),
          workspaceContext(),
          "inventory",
        )
      ).data,
    ).toMatchObject({ items: [] });
    for (const query of [
      "status=bad",
      "search=" + "x".repeat(81),
      "after=%%%",
      "search=a&search=b",
    ])
      await expect(
        loadCommerceWorkspace(
          get(`/admin/commerce/inventory?${query}`),
          workspaceContext(),
          "inventory",
        ),
      ).rejects.toMatchObject({ status: 400 });
  });
  it("runs route bootstrap → final quote → owned unpaid status → cancellation with private projections", async () => {
    const request = get();
    const response = await ConfirmationRoute.loader({
      request,
      context: context(),
      params: {},
      url: new URL(request.url),
      pattern: "/checkout/confirm",
    });
    const cookie = response.headers.get("Set-Cookie")!.split(";", 1)[0];
    const data = (await response.json()) as {
      csrfToken: string;
      pending: unknown[];
    };
    const client = { cookie, ...data };
    const prepared = await quoted(client);
    expect(prepared.quote.totalCents).toBe(4400);
    const confirm = post("/checkout/commands", cookie, prepared.confirm);
    const created = await dispatch(confirm, context());
    expect(created.headers.get("Content-Type")).toContain("application/json");
    const { orderId } = (await created.json()) as { orderId: string };
    const read = get(`/checkout/orders/${orderId}`, cookie);
    const status = await StatusRoute.loader({
      request: read,
      context: context(),
      params: { orderId },
      url: new URL(read.url),
      pattern: "/checkout/orders/:orderId",
    });
    const body = (await status.json()) as {
      order: OwnedCheckoutOrder;
      csrfToken: string;
    };
    expect(status.headers.get("Cache-Control")).toBe("private, no-store");
    expect(status.headers.get("Set-Cookie")).toBeNull();
    expect(body.order).toMatchObject({
      id: orderId,
      state: "pending_payment",
      paymentState: "not_started",
      totalCents: 4400,
    });
    expect(JSON.stringify(body)).not.toMatch(
      /owner_hash|ownerHash|token_hash|fixtureProfile|address|email|request_hash|command_id|rulesHash/,
    );
    const cancel = post(`/checkout/orders/${orderId}/cancel`, cookie, {
      csrf: data.csrfToken,
      releaseKey: crypto.randomUUID(),
      expectedVersion: "1",
    });
    const cancelled = await dispatch(cancel, context());
    expect(cancelled.headers.get("Content-Type")).toContain("application/json");
    expect(
      ((await cancelled.json()) as { order: OwnedCheckoutOrder }).order.state,
    ).toBe("cancelled");
    expect(
      await db
        .prepare(
          "SELECT checkout_reserved FROM commerce_inventory WHERE variant_id=?",
        )
        .bind(prepared.variantId)
        .first(),
    ).toEqual({ checkout_reserved: 0 });
  });
  it("dispatches private resource GET rejection without creating a session", async () => {
    const before = await count("commerce_checkout_guest_sessions");
    for (const path of [
      "/checkout/commands",
      "/checkout/orders/order-placeholder/cancel",
      "/checkout/orders/order-placeholder/prepare-payment",
    ]) {
      const response = await dispatch(get(path), context());
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("POST");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("Content-Type")).toContain(
        "application/json",
      );
      const disabled = await dispatch(
        get(path),
        context(settings(db, { COMMERCE_MODE: "disabled" })),
      );
      expect(disabled.status).toBe(404);
      expect(disabled.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(await count("commerce_checkout_guest_sessions")).toBe(before);
  });
  it("prepares an owned taxed order through JSON, replays one intent and preserves attempted stock across pause and expiry", async () => {
    const originalCaptureCount = await count("commerce_payment_capture_facts");
    const client = await browser();
    const created = await create(client);
    const enabled = settings(db, {
      COMMERCE_CHECKOUT_PAYMENT_PREPARE: "local-test",
    });
    const path = `/checkout/orders/${created.orderId}/prepare-payment`;
    const input = {
      csrf: client.csrfToken,
      requestId: crypto.randomUUID(),
      expectedVersion: "1",
    };
    const before = await count("commerce_payment_attempts");
    const prepare = () =>
      dispatch(post(path, client.cookie, input), context(enabled));
    const response = await prepare();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      order: {
        id: created.orderId,
        paymentState: "processing",
        state: "pending_payment",
        totalCents: 4400,
        version: 2,
      },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /owner_hash|ownerHash|createOperationKey|request_hash|command_id|rulesHash|accountRef/,
    );
    expect(await (await prepare()).json()).toEqual(body);
    expect(await count("commerce_payment_attempts")).toBe(before + 1);
    expect(
      await db
        .prepare(
          "SELECT amount_cents,rules_version,currency FROM commerce_payment_attempts WHERE order_id=?",
        )
        .bind(created.orderId)
        .first(),
    ).toEqual({
      amount_cents: 4400,
      rules_version: "fictional-checkout-acceptance-v1",
      currency: "CAD",
    });
    expect(
      (
        await dispatch(
          post(path, client.cookie, {
            ...input,
            requestId: crypto.randomUUID(),
          }),
          context(enabled),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await cancelCheckoutOrder(
          post(`/checkout/orders/${created.orderId}/cancel`, client.cookie, {
            csrf: client.csrfToken,
            releaseKey: crypto.randomUUID(),
            expectedVersion: "2",
          }),
          settings(),
          created.orderId,
        )
      ).status,
    ).toBe(409);
    await expireOwnedCheckoutBatch(
      db,
      { mode: "local-test", instanceId: instance, canonicalOrigin: origin },
      { now: created.quote.expiresAt + 1 },
    );
    expect(
      await db
        .prepare(
          "SELECT checkout_reserved FROM commerce_inventory WHERE variant_id=?",
        )
        .bind(created.variantId)
        .first(),
    ).toEqual({ checkout_reserved: 1 });
    expect(
      (
        await prepareCheckoutPayment(
          post(path, client.cookie, input),
          settings(),
          created.orderId,
        )
      ).status,
    ).toBe(503);
    const status = await loadCheckoutOrder(
      get(`/checkout/orders/${created.orderId}`, client.cookie),
      settings(),
      created.orderId,
    );
    expect(await status.json()).toMatchObject({
      canPreparePayment: false,
      order: { paymentState: "processing", version: 2 },
    });
    expect(await count("commerce_payment_capture_facts")).toBe(
      originalCaptureCount,
    );
  });
  it("rejects disabled, other-owner, CSRF, cross-origin and client-amount preparation without writes", async () => {
    const client = await browser(),
      other = await browser();
    const created = await create(client);
    const enabled = settings(db, {
      COMMERCE_CHECKOUT_PAYMENT_PREPARE: "local-test",
    });
    const path = `/checkout/orders/${created.orderId}/prepare-payment`;
    const input = {
      csrf: client.csrfToken,
      requestId: crypto.randomUUID(),
      expectedVersion: "1",
    };
    const before = await count("commerce_payment_attempts");
    const invoke = (request: Request, env = enabled) =>
      prepareCheckoutPayment(request, env, created.orderId);
    expect(
      (await invoke(post(path, client.cookie, input), settings())).status,
    ).toBe(503);
    expect(
      (
        await invoke(
          post(path, other.cookie, { ...input, csrf: other.csrfToken }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await invoke(
          post(path, client.cookie, { ...input, csrf: "f".repeat(64) }),
        )
      ).status,
    ).toBe(403);
    const crossOrigin = post(path, client.cookie, input);
    crossOrigin.headers.set("Origin", "https://example.invalid");
    // The loopback availability gate rejects cross-origin headers before auth.
    expect((await invoke(crossOrigin)).status).toBe(404);
    expect(
      (await invoke(post(path, client.cookie, { ...input, amountCents: "1" })))
        .status,
    ).toBe(422);
    expect(await count("commerce_payment_attempts")).toBe(before);
    expect(
      await db
        .prepare("SELECT payment_state,version FROM commerce_orders WHERE id=?")
        .bind(created.orderId)
        .first(),
    ).toEqual({ payment_state: "not_started", version: 1 });
  });
  it.each(["expiry", "revocation"])(
    "reauthorizes payment preparation after source reads when session %s occurs",
    async (change) => {
      const client = await browser();
      const created = await create(client);
      let now = Date.now(),
        changed = false;
      const before = await count("commerce_payment_attempts");
      const delayed = new Proxy(db, {
        get(target, property) {
          if (property !== "prepare") {
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (sql: string) => {
            const wrap = (
              statement: D1PreparedStatement,
            ): D1PreparedStatement =>
              new Proxy(statement, {
                get(stmt, method) {
                  if (method === "bind")
                    return (...values: unknown[]) => wrap(stmt.bind(...values));
                  if (
                    method === "first" &&
                    sql.includes("q.owner_hash AS quoteOwner")
                  )
                    return async () => {
                      const result = await stmt.first();
                      const session = await db
                        .prepare(
                          "SELECT expires_at FROM commerce_checkout_guest_sessions WHERE owner_hash=(SELECT owner_hash FROM commerce_checkout_order_origins WHERE order_id=?)",
                        )
                        .bind(created.orderId)
                        .first<{ expires_at: number }>();
                      if (change === "expiry") now = session!.expires_at;
                      else
                        await db
                          .prepare(
                            "UPDATE commerce_checkout_guest_sessions SET revoked_at=? WHERE owner_hash=(SELECT owner_hash FROM commerce_checkout_order_origins WHERE order_id=?)",
                          )
                          .bind(now, created.orderId)
                          .run();
                      changed = true;
                      return result;
                    };
                  const value = Reflect.get(stmt, method);
                  return typeof value === "function" ? value.bind(stmt) : value;
                },
              });
            return wrap(target.prepare(sql));
          };
        },
      });
      const response = await prepareCheckoutPayment(
        post(
          `/checkout/orders/${created.orderId}/prepare-payment`,
          client.cookie,
          {
            csrf: client.csrfToken,
            requestId: crypto.randomUUID(),
            expectedVersion: "1",
          },
        ),
        settings(delayed, { COMMERCE_CHECKOUT_PAYMENT_PREPARE: "local-test" }),
        created.orderId,
        () => now,
      );
      expect(changed).toBe(true);
      expect(response.status).toBe(403);
      expect(await count("commerce_payment_attempts")).toBe(before);
      expect(
        await db
          .prepare(
            "SELECT payment_state,version FROM commerce_orders WHERE id=?",
          )
          .bind(created.orderId)
          .first(),
      ).toEqual({ payment_state: "not_started", version: 1 });
    },
  );
  it.each(["expiry", "revocation"])(
    "rejects cancellation when session %s occurs during the owned read",
    async (change) => {
      const client = await browser();
      const created = await create(client);
      let now = Date.now();
      let changed = false;
      const delayed = new Proxy(db, {
        get(target, property) {
          if (property !== "prepare") {
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (sql: string) => {
            const wrap = (
              statement: D1PreparedStatement,
            ): D1PreparedStatement =>
              new Proxy(statement, {
                get(stmt, method) {
                  if (method === "bind")
                    return (...values: unknown[]) => wrap(stmt.bind(...values));
                  if (method === "all" && sql.includes("json_each(o.snapshot"))
                    return async () => {
                      const result = await stmt.all();
                      const session = await db
                        .prepare(
                          "SELECT expires_at FROM commerce_checkout_guest_sessions WHERE owner_hash=(SELECT owner_hash FROM commerce_checkout_order_origins WHERE order_id=?)",
                        )
                        .bind(created.orderId)
                        .first<{ expires_at: number }>();
                      if (change === "expiry") now = session!.expires_at;
                      else
                        await db
                          .prepare(
                            "UPDATE commerce_checkout_guest_sessions SET revoked_at=? WHERE owner_hash=(SELECT owner_hash FROM commerce_checkout_order_origins WHERE order_id=?)",
                          )
                          .bind(now, created.orderId)
                          .run();
                      changed = true;
                      return result;
                    };
                  const value = Reflect.get(stmt, method);
                  return typeof value === "function" ? value.bind(stmt) : value;
                },
              });
            return wrap(target.prepare(sql));
          };
        },
      });
      const response = await cancelCheckoutOrder(
        post(`/checkout/orders/${created.orderId}`, client.cookie, {
          csrf: client.csrfToken,
          releaseKey: crypto.randomUUID(),
          expectedVersion: "1",
        }),
        settings(delayed),
        created.orderId,
        () => now,
      );
      expect(changed).toBe(true);
      expect(response.status).toBe(403);
      expect(
        await db
          .prepare("SELECT state FROM commerce_orders WHERE id=?")
          .bind(created.orderId)
          .first(),
      ).toEqual({ state: "pending_payment" });
      expect(
        await db
          .prepare(
            "SELECT checkout_reserved FROM commerce_inventory WHERE variant_id=?",
          )
          .bind(created.variantId)
          .first(),
      ).toEqual({ checkout_reserved: 1 });
    },
  );
  it("requires final amount consent and uses the same keys for duplicate requests and pending recovery", async () => {
    const client = await browser();
    const prepared = await quoted(client);
    const before = await count("commerce_orders");
    expect(
      (
        await actCheckoutConfirmation(
          post("/checkout/confirm", client.cookie, {
            ...prepared.confirm,
            acknowledge: "no",
          }),
          settings(),
        )
      ).status,
    ).toBe(422);
    const replies = await Promise.all(
      [1, 2].map(() =>
        actCheckoutConfirmation(
          post("/checkout/confirm", client.cookie, prepared.confirm),
          settings(),
        ),
      ),
    );
    const results = await Promise.all(
      replies.map((response) => response.json()),
    );
    expect(results[0]).toEqual(results[1]);
    expect(await count("commerce_orders")).toBe(before + 1);
    const refreshed = await loadCheckoutConfirmation(
      get("/checkout/confirm", client.cookie),
      settings(),
    );
    expect(
      ((await refreshed.json()) as { pending: { id: string }[] }).pending.map(
        (order) => order.id,
      ),
    ).toContain((results[0] as { orderId: string }).orderId);
  });
  it("recovers a committed order after lost readback without creating a second hold", async () => {
    const client = await browser();
    const prepared = await quoted(client);
    let committed = false;
    const faulty = new Proxy(db, {
      get(target, property) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(statement, {
              get(stmt, method) {
                if (method === "bind")
                  return (...values: unknown[]) => wrap(stmt.bind(...values));
                if (method === "all" || method === "first" || method === "run")
                  return async () => {
                    if (committed) throw new Error("Private readback lost");
                    const result = await stmt[method]();
                    if (
                      method === "run" &&
                      sql.startsWith(
                        "INSERT INTO commerce_checkout_order_origins",
                      )
                    )
                      committed = true;
                    return result;
                  };
                const value = Reflect.get(stmt, method);
                return typeof value === "function" ? value.bind(stmt) : value;
              },
            });
          return wrap(target.prepare(sql));
        };
      },
    });
    const response = await actCheckoutConfirmation(
      post("/checkout/confirm", client.cookie, prepared.confirm),
      settings(faulty),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("Private");
    const retry = await actCheckoutConfirmation(
      post("/checkout/confirm", client.cookie, prepared.confirm),
      settings(),
    );
    expect(retry.status).toBe(200);
    expect(
      await db
        .prepare(
          "SELECT checkout_reserved FROM commerce_inventory WHERE variant_id=?",
        )
        .bind(prepared.variantId)
        .first(),
    ).toEqual({ checkout_reserved: 1 });
  });
  it("rejects other owners/scopes, absent status cookie, CSRF and disabled mode/expiry", async () => {
    const client = await browser(),
      other = await browser();
    const order = await create(client);
    const sessions = await count("commerce_checkout_guest_sessions");
    for (const cookie of [undefined, other.cookie])
      expect(
        (
          await loadCheckoutOrder(
            get(`/checkout/orders/${order.orderId}`, cookie),
            settings(),
            order.orderId,
          )
        ).status,
      ).toBe(404);
    expect(await count("commerce_checkout_guest_sessions")).toBe(sessions);
    expect(
      (
        await loadCheckoutOrder(
          get(`/checkout/orders/${order.orderId}`, client.cookie),
          settings(db, { COMMERCE_CHECKOUT_INSTANCE_ID: crypto.randomUUID() }),
          order.orderId,
        )
      ).status,
    ).toBe(404);
    const before = await count("commerce_orders");
    expect(
      (
        await actCheckoutConfirmation(
          post("/checkout/confirm", client.cookie, {
            ...order.confirm,
            csrf: "f".repeat(64),
          }),
          settings(),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await actCheckoutConfirmation(
          post("/checkout/confirm", client.cookie, order.confirm),
          settings(db, { COMMERCE_MODE: "live" }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await actCheckoutConfirmation(
          post("/checkout/confirm", client.cookie, order.confirm),
          settings(db, { COMMERCE_LOCAL_EXPIRY_TOKEN: undefined }),
        )
      ).status,
    ).toBe(503);
    expect(await count("commerce_orders")).toBe(before);
    const paused = settings(db, { COMMERCE_CHECKOUT_NEW_ORDERS: undefined });
    expect(
      (
        await actCheckoutConfirmation(
          post("/checkout/confirm", client.cookie, order.confirm),
          paused,
        )
      ).status,
    ).toBe(503);
    const recovery = await loadCheckoutConfirmation(
      get("/checkout/confirm", client.cookie),
      paused,
    );
    expect(await recovery.json()).toMatchObject({
      canCreate: false,
      pending: expect.arrayContaining([
        expect.objectContaining({ id: order.orderId }),
      ]),
    });
    expect(
      (
        await loadCheckoutOrder(
          get(`/checkout/orders/${order.orderId}`, client.cookie),
          paused,
          order.orderId,
        )
      ).status,
    ).toBe(200);
    expect((await loadCheckoutConfirmation(get(), paused)).status).toBe(403);
  });
  it.each(["price", "stock"])(
    "requires fresh review when %s changes after displayed amount",
    async (change) => {
      const client = await browser();
      const prepared = await quoted(client);
      const before = await count("commerce_orders");
      if (change === "price")
        await db
          .prepare(
            "UPDATE commerce_variants SET price_cents=2600,version=version+1 WHERE id=?",
          )
          .bind(prepared.variantId)
          .run();
      else
        await applyStockCommand(
          db,
          crypto.randomUUID(),
          [
            {
              variantId: prepared.variantId,
              kind: "fb_reserve",
              quantity: 30,
              reason: "Fictional channel competition",
            },
          ],
          Date.now(),
        );
      const response = await actCheckoutConfirmation(
        post("/checkout/confirm", client.cookie, prepared.confirm),
        settings(),
      );
      expect(response.status).toBe(409);
      expect(await count("commerce_orders")).toBe(before);
    },
  );
  it("does not persist arbitrary preview contact/address or accept injected action fields", async () => {
    const client = await browser();
    const prepared = await quoted(client);
    const before = await count("commerce_checkout_quotes");
    const selection = {
      ...JSON.parse(prepared.request.selection),
      contact: { name: "Do not save", email: "test@example.invalid" },
    };
    const response = await actCheckoutConfirmation(
      post("/checkout/confirm", client.cookie, {
        ...prepared.request,
        issueKey: crypto.randomUUID(),
        selection: JSON.stringify(selection),
      }),
      settings(),
    );
    expect(response.status).toBe(409);
    expect(await count("commerce_checkout_quotes")).toBe(before);
    expect(
      (
        await actCheckoutConfirmation(
          post("/checkout/confirm", client.cookie, {
            ...prepared.confirm,
            totalCents: "1",
          }),
          settings(),
        )
      ).status,
    ).toBe(422);
  });
  it("drives bounded owned expiry through the authorized task endpoint and safely restarts", async () => {
    const client = await browser();
    const variant = await fixture();
    const orders = [];
    for (let i = 0; i < 11; i++) orders.push(await create(client, variant));
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(
        Math.max(...orders.map((order) => order.quote.expiresAt)) + 1,
      );
    const taskRequest = (body = {}) =>
      new Request(origin + "/_local/commerce/expiry", {
        method: "POST",
        headers: {
          Origin: origin,
          Authorization: `Bearer ${task}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    try {
      const first = await handleLocalExpiry(
        taskRequest(),
        settings(db, { COMMERCE_CHECKOUT_NEW_ORDERS: undefined }),
      );
      expect(first.status).toBe(200);
      const firstPage = (await first.json()) as {
        owned: { outcomes: unknown[]; nextCursor: unknown };
      };
      expect(firstPage.owned.outcomes).toHaveLength(10);
      expect(firstPage.owned.nextCursor).not.toBeNull();
      const second = await handleLocalExpiry(
        taskRequest({ ownedAfter: firstPage.owned.nextCursor }),
        settings(db, { COMMERCE_CHECKOUT_NEW_ORDERS: undefined }),
      );
      expect(second.status).toBe(200);
      await handleLocalExpiry(
        taskRequest(),
        settings(db, { COMMERCE_CHECKOUT_NEW_ORDERS: undefined }),
      );
      expect(
        await db
          .prepare(
            "SELECT checkout_reserved FROM commerce_inventory WHERE variant_id=?",
          )
          .bind(variant)
          .first(),
      ).toEqual({ checkout_reserved: 0 });
      expect(
        (
          await loadCheckoutOrder(
            get(`/checkout/orders/${orders[0].orderId}`, client.cookie),
            settings(),
            orders[0].orderId,
          )
        ).status,
      ).toBe(200);
    } finally {
      clock.mockRestore();
    }
  });
});
