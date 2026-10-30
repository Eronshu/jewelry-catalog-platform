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
import * as ConfirmationRoute from "../../routes/checkout-confirm";
import * as StatusRoute from "../../routes/checkout-order";
import {
  loadCheckoutConfirmation,
  actCheckoutConfirmation,
  loadCheckoutOrder,
  cancelCheckoutOrder,
  type OwnedCheckoutOrder,
} from "./checkout-flow.server";
import { handleLocalExpiry } from "./expiry-trigger.server";
import { applyStockCommand } from "./inventory.server";
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
const commandRoutes = {
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
}, 30000);
afterAll(async () => {
  await platform?.dispose();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("visible customer order flow on real temporary D1", () => {
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
