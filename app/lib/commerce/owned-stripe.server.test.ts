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
  startOwnedStripePayment as start,
  reconcileOwnedStripePayment as reconcile,
  readOwnedStripePayment as read,
  recordOwnedStripeEvent as recordEvent,
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
const migrationName = "0022_commerce_owned_stripe.sql";
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
  baseline = join(directory, "empty-0021");
  mkdirSync(baseline);
  const oldMigrations = join(baseline, "migrations");
  mkdirSync(oldMigrations);
  for (const file of readdirSync(join(root, "migrations")).filter(
    (file) => file.endsWith(".sql") && file < "0022",
  ))
    copyFileSync(join(root, "migrations", file), join(oldMigrations, file));
  migrate(baseline, configuration(baseline, oldMigrations));
  upgraded = join(directory, "empty-0022");
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
    (file) => file.endsWith(".sql") && file < "0022",
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
const config: StripeSandboxConfig = {
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
  await begin(db, trusted, command, () => now + 1);
  return { ...item, requestId: command.requestId };
}
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
        instanceId: config.instanceId,
        expectedAccountId: config.expectedAccountId,
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
  phase: "before" | "after",
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

describe("owned Stripe on actual local D1 with injected canonical provider", () => {
  it("upgrades populated 0021 preserving every legacy dependent row, work version, index and FK", async () => {
    await selectBaseline();
    await legacyHistory();
    const item = await held();
    await begin(db, trusted, input(item.orderId), () => now + 1);
    const before = await allHistory();
    await upgrade();
    const after = await allHistory();
    for (const [table, oldRows] of Object.entries(before))
      expect(after[table]).toEqual(
        table === "commerce_payment_capture_facts"
          ? (oldRows as Record<string, unknown>[]).map((r) => ({
              ...(r as object),
              payment_intent_ref: null,
            }))
          : oldRows,
      );
    expect(after.commerce_owned_stripe_associations).toEqual([]);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
    expect(
      (
        await db
          .prepare("PRAGMA index_list(commerce_payment_capture_facts)")
          .all()
      ).results,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "commerce_capture_facts_by_attempt" }),
      ]),
    );
    // The historical event inbox already conservatively blocks CREATE; a legacy
    // QUERY still works after upgrade and never gains fulfillment authority.
    await legacyHistory(true);
    expect(await balance(item.variantId)).toMatchObject({
      checkout_reserved: 1,
      allocated: 0,
    });
  }, 30000);
  it("rolls back a failed real migration after rebuilding the parent and retains the entire old schema/history", async () => {
    await selectBaseline();
    await legacyHistory();
    const before = await allHistory();
    const schema = (
      await db
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name LIKE 'commerce_%' ORDER BY name",
        )
        .all()
    ).results;
    await expect(
      upgrade(
        migration().replace(
          "DROP TABLE commerce_capture_upgrade_backup;",
          "DROP TABLE commerce_capture_upgrade_backup; INSERT INTO missing_0022_fault VALUES(1);",
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
  it("shows an owned unprepared order, persists exact frozen parameters, creates once and only canonical capture allocates", async () => {
    const item = await held();
    expect(
      await read(db, config, trusted.ownerHash, item.orderId),
    ).toMatchObject({ state: "not_started", canStart: true });
    const command = input(item.orderId);
    await begin(db, trusted, command, () => now + 1);
    const p = await provider(item.orderId);
    const initial = await start(
      db,
      config,
      target(item.orderId),
      p.call,
      () => now + 2,
    );
    expect(initial).toMatchObject({
      state: "open",
      canQuery: true,
      canStart: false,
    });
    expect(JSON.stringify(initial)).not.toMatch(
      /owner|attempt|account|metadata|key|secret|snapshot/i,
    );
    expect(
      await start(db, config, target(item.orderId), p.call, () => now + 3),
    ).toEqual(initial);
    expect(p.call).toHaveBeenCalledTimes(2);
    expect(await balance(item.variantId)).toMatchObject({
      on_hand: 4,
      checkout_reserved: 1,
      allocated: 0,
    });
    p.state.paid = true;
    expect(
      await reconcile(
        db,
        config,
        target(item.orderId),
        p.call,
        () => now + 30002,
      ),
    ).toEqual({ state: "paid", canStart: false, canQuery: false });
    expect(await order(item.orderId)).toMatchObject({
      state: "confirmed",
      payment_state: "succeeded",
      version: 3,
    });
    expect(await balance(item.variantId)).toMatchObject({
      on_hand: 4,
      checkout_reserved: 0,
      allocated: 1,
    });
    expect(await rows("commerce_payment_capture_facts")).toHaveLength(1);
    expect((await rows("commerce_payment_capture_facts"))[0]).toMatchObject({
      actual_amount_cents: 4406,
      account_ref: config.expectedAccountId,
      transaction_ref: p.chargeId,
      payment_intent_ref: p.intentId,
    });
    const calls = p.call.mock.calls.length;
    expect(
      await reconcile(
        db,
        config,
        target(item.orderId),
        p.call,
        () => now + 999999,
      ),
    ).toMatchObject({ state: "paid" });
    expect(p.call).toHaveBeenCalledTimes(calls);
  });
  it("concurrent starts have one dispatch and one provider create; response loss never resends CREATE", async () => {
    const item = await prepared(),
      p = await provider(item.orderId);
    const results = await Promise.allSettled([
      start(db, config, target(item.orderId), p.call, () => now + 2),
      start(db, config, target(item.orderId), p.call, () => now + 2),
    ]);
    expect(
      results.some((r) => r.status === "fulfilled" && r.value.state === "open"),
    ).toBe(true);
    expect(
      p.call.mock.calls.filter(([, init]) => init.method === "POST"),
    ).toHaveLength(1);
    expect(await rows("commerce_owned_stripe_dispatches")).toHaveLength(1);
    const second = await prepared(),
      lost = await provider(second.orderId);
    lost.state.loseCreate = true;
    expect(
      await start(db, config, target(second.orderId), lost.call, () => now + 2),
    ).toMatchObject({ state: "review_required", canQuery: false });
    await start(
      db,
      config,
      target(second.orderId),
      lost.call,
      () => now + 100000,
    );
    expect(lost.call).toHaveBeenCalledTimes(2);
    expect(await balance(second.variantId)).toMatchObject({
      checkout_reserved: 1,
      allocated: 0,
    });
  });
  it("recovers a lost CREATE ID only from signed event plus canonical lookup; duplicate pending events retry without duplicate capture", async () => {
    const item = await prepared(),
      p = await provider(item.orderId);
    p.state.loseCreate = true;
    await start(db, config, target(item.orderId), p.call, () => now + 2);
    p.state.paid = true;
    const event = await p.event();
    p.state.refunded = true;
    await expect(
      recordEvent(db, config, event, p.call, () => now + 30002),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await rows("commerce_owned_stripe_sessions")).toHaveLength(1);
    expect(await rows("commerce_payment_capture_facts")).toEqual([]);
    p.state.refunded = false;
    await recordEvent(db, config, event, p.call, () => now + 60002);
    await recordEvent(db, config, event, p.call, () => now + 90002);
    expect(await rows("commerce_owned_stripe_events")).toHaveLength(1);
    expect(await rows("commerce_payment_capture_facts")).toHaveLength(1);
    expect(
      p.call.mock.calls.filter(([, init]) => init.method === "POST"),
    ).toHaveLength(1);
    expect(await balance(item.variantId)).toMatchObject({
      allocated: 1,
      checkout_reserved: 0,
    });
  });
  it("wrong owner, scope/config and legacy orders cannot read or dispatch; input is copied before await", async () => {
    const item = await prepared(),
      p = await provider(item.orderId),
      legacy = await held(true);
    expect(await read(db, config, "b".repeat(64), item.orderId)).toBeNull();
    expect(
      await read(
        db,
        { ...config, instanceId: crypto.randomUUID() },
        trusted.ownerHash,
        item.orderId,
      ),
    ).toBeNull();
    await expect(
      start(db, config, target(legacy.orderId), p.call, () => now + 2),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      start(
        db,
        { ...config, enabled: false } as unknown as StripeSandboxConfig,
        target(item.orderId),
        p.call,
        () => now + 2,
      ),
    ).rejects.toMatchObject({ code: "invalid_config" });
    await expect(
      start(
        db,
        config,
        { ...target(item.orderId), amount: 1 } as ReturnType<typeof target>,
        p.call,
        () => now + 2,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(p.call).not.toHaveBeenCalled();
    const t = target(item.orderId),
      c = { ...config };
    await start(
      db,
      c,
      t,
      p.call,
      () => now + 2,
      async () => {
        t.ownerHash = "b".repeat(64);
        c.expectedAccountId = "acct_WrongFixture123";
      },
    );
    expect(p.call).toHaveBeenCalledTimes(2);
    await expect(
      read(db, c, trusted.ownerHash, item.orderId),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("reauthorizes before dispatch and after canonical reads; elapsed order TTL and provider expiry never blindly release", async () => {
    const item = await prepared(),
      p = await provider(item.orderId),
      authFailure = new Error("Synthetic revoked session");
    await expect(
      start(
        db,
        config,
        target(item.orderId),
        p.call,
        () => now + 2,
        async () => {
          throw authFailure;
        },
      ),
    ).rejects.toBe(authFailure);
    expect(await rows("commerce_owned_stripe_associations")).toEqual([]);
    expect(p.call).not.toHaveBeenCalled();
    await start(db, config, target(item.orderId), p.call, () => now + 2);
    p.state.expired = true;
    expect(
      await reconcile(
        db,
        config,
        target(item.orderId),
        p.call,
        () => now + 3601000,
      ),
    ).toMatchObject({ state: "expired", canQuery: true });
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
        () => now + 3601000,
      ),
    ).rejects.toThrow();
    expect(await balance(item.variantId)).toMatchObject({
      checkout_reserved: 1,
      allocated: 0,
    });
  });
  it("canonical mismatch/refunded data and known session alone cannot fulfill; later canonical retry can", async () => {
    const item = await prepared(),
      p = await provider(item.orderId);
    await start(db, config, target(item.orderId), p.call, () => now + 2);
    p.state.paid = true;
    p.state.wrongAccount = true;
    expect(
      await reconcile(
        db,
        config,
        target(item.orderId),
        p.call,
        () => now + 30002,
      ),
    ).toMatchObject({ state: "review_required" });
    p.state.wrongAccount = false;
    p.state.refunded = true;
    expect(
      await reconcile(
        db,
        config,
        target(item.orderId),
        p.call,
        () => now + 60002,
      ),
    ).toMatchObject({ state: "review_required" });
    expect(await balance(item.variantId)).toMatchObject({
      checkout_reserved: 1,
      allocated: 0,
    });
    expect(await rows("commerce_payment_capture_facts")).toEqual([]);
    p.state.refunded = false;
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
  it("parallel queries and stale claims cannot double allocate, including a canonical read taking longer than a lease", async () => {
    const item = await prepared(),
      p = await provider(item.orderId);
    await start(db, config, target(item.orderId), p.call, () => now + 2);
    p.state.paid = true;
    let entered!: () => void, resume!: () => void;
    const reached = new Promise<void>((r) => (entered = r)),
      blocked = new Promise<void>((r) => (resume = r));
    const slow: StripeSandboxFetch = async (url, init) => {
      if (url.includes("/charges/")) {
        entered();
        await blocked;
      }
      return p.call(url, init);
    };
    let tick = now + 30002;
    const first = reconcile(
      db,
      config,
      target(item.orderId),
      slow,
      () => tick,
    ).catch((e) => e);
    await reached;
    tick = now + 70002;
    const second = await reconcile(
      db,
      config,
      target(item.orderId),
      p.call,
      () => tick,
    );
    resume();
    await first;
    expect(second).toMatchObject({ state: "paid" });
    expect(await rows("commerce_payment_capture_facts")).toHaveLength(1);
    expect(await balance(item.variantId)).toMatchObject({
      checkout_reserved: 0,
      allocated: 1,
    });
  });
  it("late/ignored multi-line allocation failures roll back fact, command, all movement balances and order state", async () => {
    const item = await prepared(true),
      p = await provider(item.orderId);
    await start(db, config, target(item.orderId), p.call, () => now + 2);
    p.state.paid = true;
    const before = await inventoryTotals(),
      commands = await rows("commerce_commands"),
      movements = await rows("commerce_stock_movements");
    await db
      .prepare(
        "CREATE TRIGGER fixture_late_ignore BEFORE INSERT ON commerce_stock_movements WHEN NEW.kind='allocate' AND NEW.position=1 BEGIN SELECT RAISE(IGNORE); END",
      )
      .run();
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
    expect(await inventoryTotals()).toEqual(before);
    expect(await rows("commerce_commands")).toEqual(commands);
    expect(await rows("commerce_stock_movements")).toEqual(movements);
    expect(await order(item.orderId)).toMatchObject({
      state: "pending_payment",
      payment_state: "processing",
      version: 2,
    });
    await db.prepare("DROP TRIGGER fixture_late_ignore").run();
    expect(
      await reconcile(
        db,
        config,
        target(item.orderId),
        p.call,
        () => now + 60002,
      ),
    ).toMatchObject({ state: "paid" });
  });
  it("lost dispatch/fact responses and read faults retain original keys and sanitized errors", async () => {
    const item = await prepared(),
      p = await provider(item.orderId);
    const lost = faultDatabase(
      (s) => s.includes("INSERT INTO commerce_owned_stripe_dispatches"),
      "after",
    );
    expect(
      await start(lost, config, target(item.orderId), p.call, () => now + 2),
    ).toMatchObject({ state: "review_required" });
    expect(p.call).not.toHaveBeenCalled();
    expect(
      await start(db, config, target(item.orderId), p.call, () => now + 3),
    ).toMatchObject({ state: "review_required" });
    expect(p.call).not.toHaveBeenCalled();
    const second = await prepared(),
      q = await provider(second.orderId);
    await start(db, config, target(second.orderId), q.call, () => now + 2);
    q.state.paid = true;
    const lostFact = faultDatabase(
      (s) => s.includes("INSERT INTO commerce_payment_capture_facts"),
      "after",
    );
    expect(
      await reconcile(
        lostFact,
        config,
        target(second.orderId),
        q.call,
        () => now + 30002,
      ),
    ).toMatchObject({ state: "paid" });
    expect(await rows("commerce_payment_capture_facts")).toHaveLength(1);
    const error = await read(
      faultDatabase(() => true, "before", "first"),
      config,
      trusted.ownerHash,
      second.orderId,
    ).catch((e) => e);
    expect(error).toMatchObject({
      code: "unavailable",
      message: "The test payment could not be verified",
    });
    expect(error.cause).toBeUndefined();
  });
  it("requires an acknowledged new dispatch and exact current-claim readback before CREATE", async () => {
    const item = await prepared(),
      p = await provider(item.orderId);
    await db
      .prepare(
        "CREATE TRIGGER fixture_ignore_dispatch BEFORE INSERT ON commerce_owned_stripe_dispatches BEGIN SELECT RAISE(IGNORE); END",
      )
      .run();
    await expect(
      start(db, config, target(item.orderId), p.call, () => now + 2),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await rows("commerce_owned_stripe_dispatches")).toEqual([]);
    expect(p.call).not.toHaveBeenCalled();
    await db.prepare("DROP TRIGGER fixture_ignore_dispatch").run();
    const unknownAck = new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            function wrap(statement: D1PreparedStatement): D1PreparedStatement {
              return new Proxy(statement, {
                get(st, k) {
                  if (k === "bind")
                    return (...values: unknown[]) => wrap(st.bind(...values));
                  if (
                    k === "run" &&
                    sql.includes("INSERT INTO commerce_owned_stripe_dispatches")
                  )
                    return async () => {
                      await st.run();
                      return { success: true, meta: {} };
                    };
                  const value = Reflect.get(st, k);
                  return typeof value === "function" ? value.bind(st) : value;
                },
              });
            }
            return wrap(target.prepare(sql));
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(
      await start(
        unknownAck,
        config,
        target(item.orderId),
        p.call,
        () => now + 3,
      ),
    ).toMatchObject({ state: "review_required", canQuery: false });
    expect(await rows("commerce_owned_stripe_dispatches")).toHaveLength(1);
    expect(p.call).not.toHaveBeenCalled();
    await start(db, config, target(item.orderId), p.call, () => now + 4);
    expect(p.call).not.toHaveBeenCalled();
    const second = await prepared(),
      q = await provider(second.orderId);
    const noReadback = faultDatabase(
      (sql) => sql.includes("SELECT d.claim_id AS claimId"),
      "before",
      "first",
    );
    expect(
      await start(
        noReadback,
        config,
        target(second.orderId),
        q.call,
        () => now + 2,
      ),
    ).toMatchObject({ state: "review_required" });
    expect(q.call).not.toHaveBeenCalled();
  });
  it("reauthorizes after acknowledged dispatch and never recreates when that authorization expires", async () => {
    const item = await prepared(),
      p = await provider(item.orderId),
      revoked = new Error("Synthetic session expired while dispatch persisted");
    await expect(
      start(
        db,
        config,
        target(item.orderId),
        p.call,
        () => now + 2,
        async () => {
          if ((await rows("commerce_owned_stripe_dispatches")).length)
            throw revoked;
        },
      ),
    ).rejects.toBe(revoked);
    expect(await rows("commerce_owned_stripe_dispatches")).toHaveLength(1);
    expect(p.call).not.toHaveBeenCalled();
    expect(
      await start(db, config, target(item.orderId), p.call, () => now + 3),
    ).toMatchObject({ state: "review_required" });
    expect(p.call).not.toHaveBeenCalled();
    expect(await balance(item.variantId)).toMatchObject({
      checkout_reserved: 1,
      allocated: 0,
    });
  });
  it("owned claims remain closed to the legacy simulator and raw SQL cannot mutate identities, add allocation or steal held/allocated stock", async () => {
    const item = await prepared(),
      p = await provider(item.orderId);
    await expect(
      claimTestPaymentWork(
        db,
        worker,
        {
          claimId: crypto.randomUUID(),
          requestId: item.requestId,
          expectedVersion: 1,
        },
        now + 2,
      ),
    ).rejects.toThrow();
    await start(db, config, target(item.orderId), p.call, () => now + 2);
    const d = (await rows("commerce_owned_stripe_dispatches"))[0];
    await expect(
      executeTestPaymentWork(
        db,
        { ...worker, workerId: d.worker_id as string },
        {
          claimId: d.claim_id as string,
          requestId: item.requestId,
          expectedVersion: 2,
        },
        createTestPaymentSimulator([{ kind: "captured" }]),
        () => now + 3,
      ),
    ).rejects.toThrow();
    expect(await rows("commerce_payment_execution_starts")).toEqual([]);
    for (const table of [
      "commerce_owned_stripe_associations",
      "commerce_owned_stripe_dispatches",
      "commerce_owned_stripe_sessions",
      "commerce_owned_stripe_status",
    ]) {
      const column = table.endsWith("associations")
        ? "actual_account_id"
        : table.endsWith("dispatches")
          ? "worker_id"
          : "session_id";
      await expect(
        db.prepare(`UPDATE ${table} SET ${column}=${column}`).run(),
      ).rejects.toThrow();
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
          "UPDATE commerce_orders SET state='confirmed',payment_state='succeeded',fulfillment='ready_to_pack',version=version+1 WHERE id=?",
        )
        .bind(item.orderId)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT OR REPLACE INTO commerce_inventory(variant_id,on_hand) VALUES(?,4)",
        )
        .bind(item.variantId)
        .run(),
    ).rejects.toThrow();
    p.state.paid = true;
    await reconcile(
      db,
      config,
      target(item.orderId),
      p.call,
      () => now + 30002,
    );
    await expect(
      db
        .prepare("UPDATE commerce_inventory SET allocated=0 WHERE variant_id=?")
        .bind(item.variantId)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT OR REPLACE INTO commerce_inventory(variant_id,on_hand) VALUES(?,4)",
        )
        .bind(item.variantId)
        .run(),
    ).rejects.toThrow();
    const f = (await rows("commerce_payment_capture_facts"))[0];
    await expect(
      db
        .prepare(
          "INSERT INTO commerce_stock_movements(command_id,position,variant_id,kind,quantity,reason) VALUES(?,99,?,'allocate',1,'Unauthorized extra')",
        )
        .bind(`stripe-allocate-${f.id}`, item.variantId)
        .run(),
    ).rejects.toThrow();
  });
});
