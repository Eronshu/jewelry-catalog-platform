import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyStockCommand } from "./inventory.server";
import {
  issueTestCheckoutQuote,
  acceptTestCheckoutQuote,
  testCheckoutRulesWitness,
  type TestCheckoutSelection,
  type TestCheckoutContext,
} from "./checkout-acceptance.server";
import { createTestCheckoutOrder } from "./checkout-orders.server";
import {
  createTestQuote,
  reserveTestOrder,
  getTestOrder,
  listTestOrders,
  releaseTestOrder,
} from "./orders.server";
import { expireTestOrderBatch } from "./order-expiry.server";
import {
  listReservationReview,
  inspectReservation,
} from "./reservation-review.server";
import { recoverExpiredReservation } from "./reservation-recovery.server";
import { beginTestPaymentAttempt } from "./payment-start.server";
import { listTestPaymentAttention } from "./payment-attention.server";

const root = resolve(process.cwd());
const now = 1_800_000_000_000;
const context: TestCheckoutContext = {
  mode: "local-test",
  instanceId: "11111111-1111-4111-8111-111111111111",
  ownerHash: "a".repeat(64),
};
const actor = { email: "operator@example.invalid", sub: "fictional-operator" };
let directory: string;
let platform: PlatformProxy<Env>;
let db: D1Database;
let sequence = 0;
const clock = () => now;
const input = (acceptanceId: string) => ({
  createKey: crypto.randomUUID(),
  acceptanceId,
});
let historical: Awaited<ReturnType<typeof reserveTestOrder>>;
let historicalAcceptance: Awaited<ReturnType<typeof accepted>>;
let beforeUpgrade: unknown;

async function item(stock = 5) {
  const id = `checkout-order-${++sequence}`;
  const product = await db
    .prepare(
      "INSERT INTO products(name,slug,price_cents,category_id,status,created_at,updated_at) VALUES ('Fictional order',?,999,1,'draft',1,1) RETURNING id",
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
        "INSERT INTO commerce_variants(id,product_id,sku,colour,size_description,price_cents,active) VALUES (?,?,?,'Gold-tone','Fictional size',1995,1)",
      )
      .bind(id, product!.id, id),
  ]);
  await applyStockCommand(
    db,
    `receipt-${id}`,
    [
      {
        variantId: id,
        quantity: stock,
        kind: "receive",
        reason: "Fictional inspected receipt",
      },
    ],
    now,
  );
  return { id, productId: product!.id };
}
async function accepted(
  lines?: { variantId: string; quantity: number }[],
  trusted = context,
  deliveryMethod: TestCheckoutSelection["deliveryMethod"] = "shipping",
) {
  const fixture = lines ? null : await item();
  const selection: TestCheckoutSelection = {
    contractVersion: "local-checkout-v1",
    lines: lines ?? [{ variantId: fixture!.id, quantity: 2 }],
    fixtureProfileId: "fixture-ontario",
    deliveryMethod,
  };
  const quote = await issueTestCheckoutQuote(
    db,
    trusted,
    { issueKey: crypto.randomUUID(), selection },
    clock,
  );
  const receipt = await acceptTestCheckoutQuote(
    db,
    trusted,
    {
      acceptanceKey: crypto.randomUUID(),
      quoteId: quote.quoteId,
      selection,
      acknowledge: true,
    },
    clock,
  );
  return { selection, quote, receipt, fixture };
}
async function snapshot(includeOrigins = true) {
  const tables = [
    "commerce_inventory",
    "commerce_stock_movements",
    "commerce_commands",
    "commerce_quotes",
    "commerce_orders",
    "commerce_order_lines",
    "commerce_order_transitions",
    "commerce_reservation_recoveries",
    "commerce_payment_attempts",
    "commerce_checkout_quotes",
    "commerce_checkout_acceptances",
  ];
  if (includeOrigins) tables.push("commerce_checkout_order_origins");
  const result: Record<string, unknown> = {};
  for (const table of tables)
    result[table] = (
      await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
    ).results;
  return result;
}
async function origin(orderId: string) {
  return (await db
    .prepare("SELECT * FROM commerce_checkout_order_origins WHERE order_id=?")
    .bind(orderId)
    .first<Record<string, string | number>>())!;
}
async function balance(id: string) {
  return db
    .prepare(
      "SELECT on_hand,facebook_reserved,checkout_reserved,allocated FROM commerce_inventory WHERE variant_id=?",
    )
    .bind(id)
    .first();
}

// Timing/failure injection only: every successful query executes on real local D1.
function queries(
  database: D1Database,
  intercept: (
    sql: string,
    method: string,
    execute: () => Promise<unknown>,
  ) => Promise<unknown>,
): D1Database {
  const wrap = (
    statement: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (property === "run" || property === "all" || property === "first")
          return () => intercept(sql, property, () => target[property]());
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => wrap(target.prepare(sql), sql);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "jewelry-checkout-orders-"));
  const migrations = join(directory, "migrations");
  mkdirSync(migrations);
  for (const file of readdirSync(join(root, "migrations")).filter(
    (file) => file.endsWith(".sql") && file < "0018",
  ))
    copyFileSync(join(root, "migrations", file), join(migrations, file));
  const configPath = join(directory, "wrangler.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "fictional-checkout-orders-test",
      compatibility_date: "2026-09-29",
      d1_databases: [
        {
          binding: "DB",
          database_name: "fictional-checkout-orders-test",
          database_id: "local-test",
          migrations_dir: migrations,
          migrations_table: "catalog_migrations",
        },
      ],
    }),
  );
  function migrate() {
    execFileSync(
      join(root, "node_modules/.bin/wrangler"),
      [
        "d1",
        "migrations",
        "apply",
        "DB",
        "--config",
        configPath,
        "--local",
        "--persist-to",
        directory,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          CI: "1",
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_LOG_PATH: join(directory, "wrangler.log"),
        },
        stdio: "pipe",
        timeout: 20_000,
      },
    );
  }
  async function connect() {
    platform = await getPlatformProxy<Env>({
      configPath,
      envFiles: [],
      persist: { path: join(directory, "v3") },
      remoteBindings: false,
    });
    db = platform.env.DB;
  }
  migrate();
  await connect();
  const legacyItem = await item();
  const legacyQuote = await createTestQuote(
    db,
    context.ownerHash,
    [{ variantId: legacyItem.id, quantity: 1 }],
    "pickup",
    now,
  );
  historical = await reserveTestOrder(
    db,
    context.ownerHash,
    legacyQuote.id,
    now,
  );
  historicalAcceptance = await accepted();
  beforeUpgrade = await snapshot(false);
  await platform.dispose();
  copyFileSync(
    join(root, "migrations/0018_commerce_checkout_order_origins.sql"),
    join(migrations, "0018_commerce_checkout_order_origins.sql"),
  );
  migrate();
  await connect();
}, 30_000);
afterAll(async () => {
  await platform?.dispose();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("accepted checkout quote to the shared order/stock root", () => {
  it("preserves populated 0017 history and has no origins after upgrade", async () => {
    expect(await snapshot(false)).toEqual(beforeUpgrade);
    expect(
      (await db.prepare("SELECT * FROM commerce_checkout_order_origins").all())
        .results,
    ).toEqual([]);
    expect(await getTestOrder(db, context.ownerHash, historical.id)).toEqual(
      historical,
    );
    expect(
      (
        await db
          .prepare(
            "SELECT acceptance_id FROM commerce_checkout_acceptances WHERE acceptance_id=?",
          )
          .bind(historicalAcceptance.receipt.acceptanceId)
          .first()
      )?.acceptance_id,
    ).toBe(historicalAcceptance.receipt.acceptanceId);
  });

  it.each(["pickup", "local_delivery", "shipping"] as const)(
    "creates one %s shared order with exact profile-free projection and one reserve per line",
    async (method) => {
      const a = await item();
      const b = await item();
      const source = await accepted(
        [
          { variantId: a.id, quantity: 2 },
          { variantId: b.id, quantity: 1 },
        ],
        context,
        method,
      );
      const result = await createTestCheckoutOrder(
        db,
        context,
        input(source.receipt.acceptanceId),
        () => now + 1,
      );
      expect(result).toMatchObject({
        testOnly: true,
        acceptanceId: source.receipt.acceptanceId,
        checkoutQuoteId: source.quote.quoteId,
        createdAt: now + 1,
        reserveUntil: source.quote.expiresAt,
      });
      const mapped = await origin(result.orderId);
      const materialized = await db
        .prepare(
          `SELECT o.*,q.snapshot AS quote_snapshot,c.request_hash AS command_hash FROM commerce_orders o JOIN commerce_quotes q ON q.id=o.quote_id JOIN commerce_commands c ON c.id=o.reserve_command_id WHERE o.id=?`,
        )
        .bind(result.orderId)
        .first<Record<string, unknown>>();
      const projected = (await db
        .prepare(
          "SELECT json_remove(snapshot_json,'$.fixtureProfile') AS snapshot FROM commerce_checkout_quotes WHERE quote_id=?",
        )
        .bind(source.quote.quoteId)
        .first<{ snapshot: string }>())!.snapshot;
      expect(materialized).toMatchObject({
        state: "pending_payment",
        payment_state: "not_started",
        fulfillment: "none",
        version: 1,
        snapshot: projected,
        quote_snapshot: projected,
        reserve_until: source.quote.expiresAt,
      });
      expect(materialized!.command_hash).toBe(mapped.request_hash);
      expect(
        (
          await db
            .prepare(
              "SELECT * FROM commerce_stock_movements WHERE command_id=?",
            )
            .bind(mapped.command_id)
            .all()
        ).results,
      ).toHaveLength(2);
      expect(await balance(a.id)).toMatchObject({
        on_hand: 5,
        checkout_reserved: 2,
        allocated: 0,
      });
      expect(await balance(b.id)).toMatchObject({
        on_hand: 5,
        checkout_reserved: 1,
      });
      expect(JSON.stringify({ result, materialized })).not.toContain(
        "example.invalid",
      );
      expect(JSON.stringify(result)).not.toContain(context.ownerHash);
      expect(await getTestOrder(db, context.ownerHash, historical.id)).toEqual(
        historical,
      );
      expect(
        (await db.prepare("PRAGMA foreign_key_check").all()).results,
      ).toEqual([]);
    },
  );

  it("returns one receipt for same-key concurrent calls and rejects different keys/payloads", async () => {
    const source = await accepted();
    const command = input(source.receipt.acceptanceId);
    const results = await Promise.all([
      createTestCheckoutOrder(db, context, command, clock),
      createTestCheckoutOrder(db, context, command, clock),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await balance(source.fixture!.id)).toMatchObject({
      checkout_reserved: 2,
    });
    await expect(
      createTestCheckoutOrder(
        db,
        context,
        input(source.receipt.acceptanceId),
        clock,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const other = await accepted();
    await expect(
      createTestCheckoutOrder(
        db,
        context,
        { ...command, acceptanceId: other.receipt.acceptanceId },
        clock,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const third = await accepted();
    const competing = await Promise.allSettled([
      createTestCheckoutOrder(
        db,
        context,
        input(third.receipt.acceptanceId),
        clock,
      ),
      createTestCheckoutOrder(
        db,
        context,
        input(third.receipt.acceptanceId),
        clock,
      ),
    ]);
    expect(
      competing.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
  });

  it("lets only one of two accepted quotes reserve the last unit, excluding Facebook", async () => {
    const fixture = await item(1);
    const lines = [{ variantId: fixture.id, quantity: 1 }];
    const otherContext = { ...context, ownerHash: "b".repeat(64) };
    const a = await accepted(lines);
    const b = await accepted(lines, otherContext);
    const results = await Promise.allSettled([
      createTestCheckoutOrder(
        db,
        context,
        input(a.receipt.acceptanceId),
        clock,
      ),
      createTestCheckoutOrder(
        db,
        otherContext,
        input(b.receipt.acceptanceId),
        clock,
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(await balance(fixture.id)).toMatchObject({
      on_hand: 1,
      checkout_reserved: 1,
    });
    const fbItem = await item(1);
    const fbSource = await accepted([{ variantId: fbItem.id, quantity: 1 }]);
    const competition = await Promise.allSettled([
      createTestCheckoutOrder(
        db,
        context,
        input(fbSource.receipt.acceptanceId),
        clock,
      ),
      applyStockCommand(
        db,
        `fb-${fbItem.id}`,
        [
          {
            variantId: fbItem.id,
            quantity: 1,
            kind: "fb_reserve",
            reason: "Facebook shelf",
          },
        ],
        now,
      ),
    ]);
    expect(
      competition.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const state = (await balance(fbItem.id))!;
    expect(
      Number(state.checkout_reserved) + Number(state.facebook_reserved),
    ).toBe(1);
  });

  it("rolls back every root/ledger row if a later line fails during materialization", async () => {
    const a = await item();
    const b = await item();
    const source = await accepted([
      { variantId: a.id, quantity: 1 },
      { variantId: b.id, quantity: 2 },
    ]);
    // Real SQL injection after the first line: this makes the later CHECK fail.
    await db
      .prepare(
        `CREATE TRIGGER test_late_stock_failure AFTER INSERT ON commerce_order_lines WHEN NEW.position=0 AND EXISTS(SELECT 1 FROM commerce_checkout_order_origins WHERE order_id=NEW.order_id AND acceptance_id='${source.receipt.acceptanceId}') BEGIN UPDATE commerce_inventory SET facebook_reserved=on_hand WHERE variant_id='${b.id}'; END`,
      )
      .run();
    const before = await snapshot();
    try {
      await expect(
        createTestCheckoutOrder(
          db,
          context,
          input(source.receipt.acceptanceId),
          clock,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(await snapshot()).toEqual(before);
    } finally {
      await db.prepare("DROP TRIGGER test_late_stock_failure").run();
    }
  });

  it("asserts exact coverage even if a SQL trigger silently omits a later movement", async () => {
    const a = await item();
    const b = await item();
    const source = await accepted([
      { variantId: a.id, quantity: 1 },
      { variantId: b.id, quantity: 1 },
    ]);
    await db
      .prepare(
        `CREATE TRIGGER test_ignore_movement BEFORE INSERT ON commerce_stock_movements WHEN NEW.position=1 AND EXISTS(SELECT 1 FROM commerce_checkout_order_origins WHERE command_id=NEW.command_id AND acceptance_id='${source.receipt.acceptanceId}') BEGIN SELECT RAISE(IGNORE); END`,
      )
      .run();
    const before = await snapshot();
    try {
      await expect(
        createTestCheckoutOrder(
          db,
          context,
          input(source.receipt.acceptanceId),
          clock,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(await snapshot()).toEqual(before);
    } finally {
      await db.prepare("DROP TRIGGER test_ignore_movement").run();
    }
  });

  it.each(["price", "name", "sku", "colour", "size", "hidden", "stock"])(
    "rechecks %s at the final INSERT, not only accepted time",
    async (change) => {
      const source = await accepted();
      const fixture = source.fixture!;
      let fired = false;
      const racing = queries(db, async (sql, method, execute) => {
        if (
          !fired &&
          method === "run" &&
          sql.startsWith("INSERT INTO commerce_checkout_order_origins")
        ) {
          fired = true;
          if (change === "name")
            await db
              .prepare(
                "UPDATE products SET name='Changed after acceptance' WHERE id=?",
              )
              .bind(fixture.productId)
              .run();
          else if (change === "hidden")
            await db
              .prepare("UPDATE products SET status='hidden' WHERE id=?")
              .bind(fixture.productId)
              .run();
          else if (change === "stock")
            await applyStockCommand(
              db,
              `fb-${fixture.id}`,
              [
                {
                  variantId: fixture.id,
                  kind: "fb_reserve",
                  quantity: 5,
                  reason: "Shelf",
                },
              ],
              now,
            );
          else {
            const fields: Record<string, string> = {
              price: "price_cents=9000",
              sku: "sku=sku||'-new'",
              colour: "colour='Silver-tone'",
              size: "size_description='Different'",
            };
            await db
              .prepare(
                `UPDATE commerce_variants SET ${fields[change]},version=version+1 WHERE id=?`,
              )
              .bind(fixture.id)
              .run();
          }
        }
        return execute();
      });
      await expect(
        createTestCheckoutOrder(
          racing,
          context,
          input(source.receipt.acceptanceId),
          clock,
        ),
      ).rejects.toMatchObject({ code: "stale_quote" });
      expect(
        (
          await db
            .prepare(
              "SELECT * FROM commerce_checkout_order_origins WHERE acceptance_id=?",
            )
            .bind(source.receipt.acceptanceId)
            .all()
        ).results,
      ).toEqual([]);
      expect(await balance(fixture.id)).toMatchObject({ checkout_reserved: 0 });
    },
  );

  it("samples first-create time after preparation, rejects expiry exactly, and never extends a hold", async () => {
    const source = await accepted();
    const command = input(source.receipt.acceptanceId);
    let prepared = false;
    const observed = new Proxy(db, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            if (sql.startsWith("INSERT INTO commerce_checkout_order_origins"))
              prepared = true;
            return target.prepare(sql);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      createTestCheckoutOrder(observed, context, command, () => {
        expect(prepared).toBe(true);
        return source.quote.expiresAt;
      }),
    ).rejects.toMatchObject({ code: "expired_quote" });
    await expect(
      createTestCheckoutOrder(db, context, command, () => now - 1),
    ).rejects.toMatchObject({ code: "expired_quote" });
    const result = await createTestCheckoutOrder(
      db,
      context,
      command,
      () => source.quote.expiresAt - 1,
    );
    expect(result.reserveUntil - result.createdAt).toBe(1);
  });

  it("rejects cross-owner/instance access and copies strict inputs before the first await", async () => {
    const source = await accepted();
    const command = input(source.receipt.acceptanceId);
    for (const trusted of [
      { ...context, ownerHash: "b".repeat(64) },
      { ...context, instanceId: crypto.randomUUID() },
    ])
      await expect(
        createTestCheckoutOrder(db, trusted, command, clock),
      ).rejects.toMatchObject({ code: "conflict" });
    const trusted = { ...context };
    const mutable = { ...command };
    const pending = createTestCheckoutOrder(db, trusted, mutable, clock);
    mutable.acceptanceId = crypto.randomUUID();
    mutable.createKey = crypto.randomUUID();
    trusted.ownerHash = "b".repeat(64);
    const result = await pending;
    expect(result.acceptanceId).toBe(source.receipt.acceptanceId);
    expect(await createTestCheckoutOrder(db, context, command, clock)).toEqual(
      result,
    );
    await expect(
      createTestCheckoutOrder(db, trusted, command, clock),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects unknown fields/accessors/symbols and does not expose a mutable shared rules object", async () => {
    const source = await accepted();
    const command = input(source.receipt.acceptanceId);
    let touched = 0;
    const getters = { ...command };
    Object.defineProperty(getters, "acceptanceId", {
      get() {
        touched++;
        return command.acceptanceId;
      },
    });
    const symbol = { ...command };
    Object.defineProperty(symbol, Symbol("extra"), { value: 1 });
    const before = await snapshot();
    for (const raw of [
      null,
      [],
      Object.create(command),
      getters,
      symbol,
      { ...command, amount: 1 },
      { ...command, lines: [] },
      { ...command, clock: now },
      { ...command, createKey: "bad" },
    ])
      await expect(
        createTestCheckoutOrder(db, context, raw, clock),
      ).rejects.toMatchObject({ code: "invalid_request" });
    for (const trusted of [
      { ...context, mode: "live" },
      { ...context, ownerHash: "bad" },
      { ...context, extra: true },
    ])
      await expect(
        createTestCheckoutOrder(
          db,
          trusted as TestCheckoutContext,
          command,
          clock,
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    for (const value of [-1, NaN, Infinity, 0.5, 8_640_000_000_000_001])
      await expect(
        createTestCheckoutOrder(db, context, command, () => value),
      ).rejects.toMatchObject({ code: "invalid_request" });
    expect(touched).toBe(0);
    expect(await snapshot()).toEqual(before);
    const rules = testCheckoutRulesWitness();
    Reflect.set(rules.methods, "shipping", 1);
    expect(testCheckoutRulesWitness().methods.shipping).toBe(1500);
    const result = await createTestCheckoutOrder(
      db,
      Object.assign(Object.create(null), context),
      Object.assign(Object.create(null), command),
      clock,
    );
    expect(result.testOnly).toBe(true);
  });

  it("replays original receipts after expiration/current changes and lost write responses", async () => {
    const source = await accepted();
    const command = input(source.receipt.acceptanceId);
    let failed = false;
    const lost = queries(db, async (_sql, method, execute) => {
      const result = await execute();
      if (method === "run" && !failed) {
        failed = true;
        throw new Error("Lost committed response");
      }
      return result;
    });
    const result = await createTestCheckoutOrder(lost, context, command, clock);
    await db
      .prepare(
        "UPDATE products SET name='Later name',status='hidden' WHERE id=?",
      )
      .bind(source.fixture!.productId)
      .run();
    await db
      .prepare(
        "UPDATE commerce_variants SET price_cents=9000,version=version+1 WHERE id=?",
      )
      .bind(source.fixture!.id)
      .run();
    expect(
      await createTestCheckoutOrder(
        db,
        context,
        command,
        () => source.quote.expiresAt + 1,
      ),
    ).toEqual(result);
    await expect(
      createTestCheckoutOrder(
        db,
        context,
        input(source.receipt.acceptanceId),
        clock,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await balance(source.fixture!.id)).toMatchObject({
      checkout_reserved: 2,
    });
  });

  it("recovers a same-key winner that commits before this caller observes expiry", async () => {
    const source = await accepted();
    const command = input(source.receipt.acceptanceId);
    let first = true;
    let winner: Awaited<ReturnType<typeof createTestCheckoutOrder>> | undefined;
    const racing = queries(db, async (sql, method, execute) => {
      const result = await execute();
      if (
        first &&
        method === "all" &&
        sql.startsWith("SELECT * FROM commerce_checkout_order_origins")
      ) {
        first = false;
        winner = await createTestCheckoutOrder(db, context, command, clock);
      }
      return result;
    });
    expect(
      await createTestCheckoutOrder(
        racing,
        context,
        command,
        () => source.quote.expiresAt,
      ),
    ).toEqual(winner);
  });

  it.each([
    "before-read",
    "before-write",
    "postcommit-read",
    "lost-write-and-read",
  ])(
    "normalizes %s uncertainty and preserves original-key recovery",
    async (failure) => {
      const source = await accepted();
      const command = input(source.receipt.acceptanceId);
      let committed = false;
      const faulty = queries(db, async (_sql, method, execute) => {
        if (
          failure === "before-read" ||
          committed ||
          (failure === "before-write" && method === "run")
        )
          throw new Error("private SQL customer-data");
        const result = await execute();
        if (method === "run") {
          committed = true;
          if (failure === "lost-write-and-read")
            throw new Error("Lost response");
        }
        return result;
      });
      const error = await createTestCheckoutOrder(
        faulty,
        context,
        command,
        clock,
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        name: "CheckoutOrderError",
        code: "unavailable",
      });
      expect(String(error)).not.toContain("private");
      expect(error).not.toHaveProperty("cause");
      const restored = await createTestCheckoutOrder(
        db,
        context,
        command,
        clock,
      );
      expect(restored.acceptanceId).toBe(source.receipt.acceptanceId);
      expect(await balance(source.fixture!.id)).toMatchObject({
        checkout_reserved: 2,
      });
    },
  );

  it("freezes origin/shared roots and rejects extra lines, movements and source-less rich records", async () => {
    const source = await accepted();
    const result = await createTestCheckoutOrder(
      db,
      context,
      input(source.receipt.acceptanceId),
      clock,
    );
    const mapped = await origin(result.orderId);
    const before = await snapshot();
    for (const sql of [
      "UPDATE commerce_checkout_order_origins SET owner_hash=owner_hash WHERE order_id=?",
      "DELETE FROM commerce_checkout_order_origins WHERE order_id=?",
      "UPDATE commerce_orders SET payment_state='processing' WHERE id=?",
      "UPDATE commerce_orders SET state='cancelled' WHERE id=?",
      "DELETE FROM commerce_orders WHERE id=?",
    ])
      await expect(
        db.prepare(sql).bind(result.orderId).run(),
      ).rejects.toThrow();
    const columns = Object.keys(mapped);
    await expect(
      db
        .prepare(
          `INSERT OR REPLACE INTO commerce_checkout_order_origins(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        )
        .bind(...columns.map((name) => mapped[name]))
        .run(),
    ).rejects.toThrow();
    const order = (await db
      .prepare("SELECT * FROM commerce_orders WHERE id=?")
      .bind(result.orderId)
      .first<Record<string, string | number>>())!;
    const orderColumns = Object.keys(order);
    await expect(
      db
        .prepare(
          `INSERT OR REPLACE INTO commerce_orders(${orderColumns.join(",")}) VALUES (${orderColumns.map(() => "?").join(",")})`,
        )
        .bind(...orderColumns.map((name) => order[name]))
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT INTO commerce_order_lines(order_id,position,variant_id,quantity,unit_price_cents,variant_version) VALUES (?,1,?,1,1995,1)",
        )
        .bind(result.orderId, source.fixture!.id)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT INTO commerce_stock_movements(command_id,position,variant_id,kind,quantity,expected_variant_version,reason) VALUES (?,1,?,'reserve',1,1,'Order reservation')",
        )
        .bind(mapped.command_id, source.fixture!.id)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT INTO commerce_quotes(id,owner_hash,snapshot,created_at,expires_at) VALUES (?,?,?,?,?)",
        )
        .bind(
          crypto.randomUUID(),
          context.ownerHash,
          order.snapshot,
          now,
          source.quote.expiresAt,
        )
        .run(),
    ).rejects.toThrow();
    for (const kind of ["release", "allocate"] as const)
      await expect(
        applyStockCommand(
          db,
          crypto.randomUUID(),
          [
            {
              variantId: source.fixture!.id,
              kind,
              quantity: 1,
              reason: "Attempt to steal mapped hold",
            },
          ],
          now,
        ),
      ).rejects.toMatchObject({ code: "stock_conflict" });
    for (const sql of [
      "INSERT OR REPLACE INTO commerce_inventory(variant_id,on_hand,checkout_reserved) VALUES (?,10,0)",
      "INSERT INTO commerce_inventory(variant_id,on_hand,checkout_reserved) VALUES (?,10,2) ON CONFLICT(variant_id) DO UPDATE SET checkout_reserved=0",
    ])
      await expect(
        db.prepare(sql).bind(source.fixture!.id).run(),
      ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it("blocks legacy reads, expiry/recovery/payment consumers while ordinary lab release still works", async () => {
    const source = await accepted();
    const result = await createTestCheckoutOrder(
      db,
      context,
      input(source.receipt.acceptanceId),
      clock,
    );
    const mapped = await origin(result.orderId);
    expect(
      await getTestOrder(db, context.ownerHash, result.orderId),
    ).toBeNull();
    expect(
      (await listTestOrders(db, context.ownerHash)).some(
        (order) => order.id === result.orderId,
      ),
    ).toBe(false);
    await expect(
      reserveTestOrder(
        db,
        context.ownerHash,
        String(mapped.promoted_quote_id),
        now,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      releaseTestOrder(db, context.ownerHash, result.orderId, "cancel", now),
    ).rejects.toMatchObject({ code: "not_found" });
    const later = source.quote.expiresAt + 1;
    expect(
      (await expireTestOrderBatch(db, { now: later, limit: 25 })).outcomes.some(
        (outcome) => outcome.orderId === result.orderId,
      ),
    ).toBe(false);
    expect(
      (await listReservationReview(db, { now: later })).items.some(
        (order) => order.id === result.orderId,
      ),
    ).toBe(false);
    expect(await inspectReservation(db, result.orderId, later)).toBeNull();
    await expect(
      recoverExpiredReservation(
        db,
        actor,
        {
          requestId: crypto.randomUUID(),
          reference: result.orderId,
          expectedVersion: 1,
          confirmation: result.orderId,
          reason: "overdue_unpaid",
        },
        later,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await db
      .prepare(
        "INSERT OR IGNORE INTO commerce_payment_scope(id,mode,instance_id,stripe_account_ref,paypal_account_ref) VALUES (1,'local-test',?,'fixture-stripe','fixture-paypal')",
      )
      .bind(context.instanceId)
      .run();
    await expect(
      beginTestPaymentAttempt(
        db,
        { ...context, provider: "stripe", accountRef: "fixture-stripe" },
        {
          requestId: crypto.randomUUID(),
          reference: result.orderId,
          expectedVersion: 1,
        },
        now,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      (
        await listTestPaymentAttention(
          db,
          { mode: "local-test", instanceId: context.instanceId },
          { cursor: null },
          later,
        )
      ).items.some((order) => order.reference === result.orderId),
    ).toBe(false);
    const legacyQuote = await createTestQuote(
      db,
      context.ownerHash,
      [{ variantId: source.fixture!.id, quantity: 1 }],
      "pickup",
      now,
    );
    const legacy = await reserveTestOrder(
      db,
      context.ownerHash,
      legacyQuote.id,
      now,
    );
    expect(await balance(source.fixture!.id)).toMatchObject({
      checkout_reserved: 3,
    });
    await releaseTestOrder(db, context.ownerHash, legacy.id, "cancel", now);
    expect(await balance(source.fixture!.id)).toMatchObject({
      checkout_reserved: 2,
    });
    const unchanged = await snapshot();
    for (const table of [
      "commerce_order_transitions",
      "commerce_reservation_recoveries",
    ]) {
      const commandId = crypto.randomUUID();
      const statement =
        table === "commerce_order_transitions"
          ? db
              .prepare(
                "INSERT INTO commerce_order_transitions(command_id,order_id,kind,expected_version,occurred_at) VALUES (?,?,'expire',1,?)",
              )
              .bind(commandId, result.orderId, later)
          : db
              .prepare(
                "INSERT INTO commerce_reservation_recoveries(command_id,order_id,actor_hash,expected_version,reason,occurred_at) VALUES (?,?,?,1,'overdue_unpaid',?)",
              )
              .bind(commandId, result.orderId, "b".repeat(64), later);
      await expect(
        db.batch([
          db
            .prepare(
              "INSERT INTO commerce_commands(id,request_hash,created_at) VALUES (?,?,?)",
            )
            .bind(commandId, "c".repeat(64), later),
          statement,
        ]),
      ).rejects.toThrow();
    }
    expect(await snapshot()).toEqual(unchanged);
  });
});
