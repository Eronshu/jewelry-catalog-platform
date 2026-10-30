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
  type TestCheckoutSelection,
  type TestCheckoutContext,
} from "./checkout-acceptance.server";
import { createTestCheckoutOrder } from "./checkout-orders.server";
import {
  createTestQuote,
  reserveTestOrder,
  getTestOrder,
  releaseTestOrder,
} from "./orders.server";
import { releaseTestCheckoutOrder } from "./checkout-release.server";

const root = resolve(process.cwd());
const now = 1_800_000_000_000;
const context: TestCheckoutContext = {
  mode: "local-test",
  instanceId: "11111111-1111-4111-8111-111111111111",
  ownerHash: "a".repeat(64),
};
let directory: string;
let platform: PlatformProxy<Env>;
let db: D1Database;
let sequence = 0;
const clock = () => now;
const input = (orderId: string, kind: "cancel" | "expire" = "cancel") => ({
  releaseKey: crypto.randomUUID(),
  orderId,
  kind,
  expectedVersion: 1,
});
let historical: Awaited<ReturnType<typeof reserveTestOrder>>;
let historicalHeld: Awaited<ReturnType<typeof held>>;
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
async function snapshot(includeReleases = true) {
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
  tables.push("commerce_checkout_order_origins");
  if (includeReleases) tables.push("commerce_checkout_order_releases");
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
async function held(
  lines?: { variantId: string; quantity: number }[],
  trusted = context,
) {
  const source = await accepted(lines, trusted);
  const order = await createTestCheckoutOrder(
    db,
    trusted,
    {
      createKey: crypto.randomUUID(),
      acceptanceId: source.receipt.acceptanceId,
    },
    clock,
  );
  return { ...source, order };
}
async function row(orderId: string) {
  return (await db
    .prepare("SELECT * FROM commerce_orders WHERE id=?")
    .bind(orderId)
    .first<Record<string, string | number>>())!;
}
async function releaseRow(orderId: string) {
  return (await db
    .prepare("SELECT * FROM commerce_checkout_order_releases WHERE order_id=?")
    .bind(orderId)
    .first<Record<string, string | number>>())!;
}
async function rawRelease(
  orderId: string,
  changes: Record<string, string | number> = {},
) {
  const releaseId = crypto.randomUUID();
  const values = {
    release_id: releaseId,
    command_id: `checkout-release-${releaseId}`,
    mode: context.mode,
    instance_id: context.instanceId,
    owner_hash: context.ownerHash,
    release_key: crypto.randomUUID(),
    request_hash: "b".repeat(64),
    order_id: orderId,
    kind: "cancel",
    expected_version: 1,
    resulting_version: 2,
    occurred_at: now,
    ...changes,
  };
  return db
    .prepare(
      `INSERT INTO commerce_checkout_order_releases(${Object.keys(values).join(",")}) VALUES (${Object.keys(
        values,
      )
        .map(() => "?")
        .join(",")})`,
    )
    .bind(...Object.values(values))
    .run();
}
// Test-only private future-state injection; guards restored before assertions.
// This is NOT a legitimate payment path or proof of provider integration.
async function withoutGuards(names: string[], inject: () => Promise<void>) {
  const originals = [];
  for (const name of names) {
    const original = await db
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?")
      .bind(name)
      .first<{ sql: string }>();
    if (!original) throw new Error(`Missing fixture guard ${name}`);
    originals.push(original.sql);
    await db.prepare(`DROP TRIGGER ${name}`).run();
  }
  try {
    await inject();
  } finally {
    for (const sql of originals) await db.prepare(sql).run();
  }
}
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "jewelry-checkout-release-"));
  const migrations = join(directory, "migrations");
  mkdirSync(migrations);
  for (const file of readdirSync(join(root, "migrations")).filter(
    (file) => file.endsWith(".sql") && file < "0019",
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
  historicalHeld = await held();
  beforeUpgrade = await snapshot(false);
  await platform.dispose();
  copyFileSync(
    join(root, "migrations/0019_commerce_checkout_order_releases.sql"),
    join(migrations, "0019_commerce_checkout_order_releases.sql"),
  );
  migrate();
  await connect();
}, 30_000);
afterAll(async () => {
  await platform?.dispose();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("owned unpaid checkout reservation release on real temporary D1", () => {
  it("upgrades populated 0018 without changing shared history or the held floor", async () => {
    expect(await snapshot(false)).toEqual(beforeUpgrade);
    expect(
      (await db.prepare("SELECT * FROM commerce_checkout_order_releases").all())
        .results,
    ).toEqual([]);
    expect(await getTestOrder(db, context.ownerHash, historical.id)).toEqual(
      historical,
    );
    const before = await snapshot();
    await expect(
      db
        .prepare(
          "UPDATE commerce_inventory SET checkout_reserved=0 WHERE variant_id=?",
        )
        .bind(historicalHeld.fixture!.id)
        .run(),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  });
  it.each(["cancel", "expire"] as const)(
    "%s releases every stored line once and changes only root state/version",
    async (kind) => {
      const a = await item(),
        b = await item();
      const source = await held([
        { variantId: a.id, quantity: 2 },
        { variantId: b.id, quantity: 1 },
      ]);
      const before = await row(source.order.orderId);
      const original = await origin(source.order.orderId);
      const at = kind === "expire" ? source.order.reserveUntil : now;
      const result = await releaseTestCheckoutOrder(
        db,
        context,
        input(source.order.orderId, kind),
        () => at,
      );
      expect(result).toEqual({
        testOnly: true,
        releaseId: expect.any(String),
        orderId: source.order.orderId,
        kind,
        resultingVersion: 2,
        occurredAt: at,
      });
      expect(await row(source.order.orderId)).toEqual({
        ...before,
        state: "cancelled",
        version: 2,
      });
      expect(await origin(source.order.orderId)).toEqual(original);
      for (const fixture of [a, b])
        expect(await balance(fixture.id)).toEqual({
          on_hand: 5,
          facebook_reserved: 0,
          checkout_reserved: 0,
          allocated: 0,
        });
      const record = await releaseRow(source.order.orderId);
      const movements = (
        await db
          .prepare(
            "SELECT * FROM commerce_stock_movements WHERE command_id=? ORDER BY position",
          )
          .bind(record.command_id)
          .all()
      ).results;
      expect(movements).toHaveLength(2);
      expect(movements).toMatchObject([
        { kind: "release", quantity: 2, expected_variant_version: null },
        { kind: "release", quantity: 1, expected_variant_version: null },
      ]);
      expect(record.command_id).not.toBe(original.command_id);
      expect(
        await getTestOrder(db, context.ownerHash, source.order.orderId),
      ).toBeNull();
      expect(
        (await db.prepare("PRAGMA foreign_key_check").all()).results,
      ).toEqual([]);
    },
  );
  it("checks time after preparation; rejects early expiry/backward time and accepts exact boundary or late cancel", async () => {
    const source = await held();
    const before = await snapshot();
    for (const [kind, time] of [
      ["expire", source.order.reserveUntil - 1],
      ["cancel", now - 1],
    ] as const)
      await expect(
        releaseTestCheckoutOrder(
          db,
          context,
          input(source.order.orderId, kind),
          () => time,
        ),
      ).rejects.toMatchObject({ code: "conflict" });
    expect(await snapshot()).toEqual(before);
    let time = now;
    const delayed = queries(db, async (sql, method, execute) => {
      const result = await execute();
      if (
        sql.includes("FROM commerce_checkout_order_origins x") &&
        method === "first"
      )
        time = source.order.reserveUntil;
      return result;
    });
    expect(
      (
        await releaseTestCheckoutOrder(
          delayed,
          context,
          input(source.order.orderId, "expire"),
          () => time,
        )
      ).occurredAt,
    ).toBe(source.order.reserveUntil);
    const late = await held();
    expect(
      (
        await releaseTestCheckoutOrder(
          db,
          context,
          input(late.order.orderId),
          () => late.order.reserveUntil + 1,
        )
      ).kind,
    ).toBe("cancel");
  });
  it("makes same-key concurrent calls one effect and rejects changed payload/order/key", async () => {
    const source = await held();
    const command = input(source.order.orderId);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        releaseTestCheckoutOrder(db, context, command, clock),
      ),
    );
    expect(
      results.every(
        (result) => JSON.stringify(result) === JSON.stringify(results[0]),
      ),
    ).toBe(true);
    const other = await held();
    for (const change of [
      { releaseKey: crypto.randomUUID() },
      { kind: "expire" },
      { expectedVersion: 2 },
      { orderId: other.order.orderId },
    ])
      await expect(
        releaseTestCheckoutOrder(
          db,
          context,
          { ...command, ...change },
          () => source.order.reserveUntil,
        ),
      ).rejects.toMatchObject({ code: "conflict" });
    expect(await balance(source.fixture!.id)).toMatchObject({
      checkout_reserved: 0,
    });
    expect((await row(other.order.orderId)).state).toBe("pending_payment");
  });
  it("different keys and cancel/expire racing yield one release", async () => {
    const source = await held();
    const outcomes = await Promise.allSettled(
      ["cancel", "expire"].map((kind) =>
        releaseTestCheckoutOrder(
          db,
          context,
          input(source.order.orderId, kind as "cancel" | "expire"),
          () => source.order.reserveUntil,
        ),
      ),
    );
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((result) => result.status === "rejected"),
    ).toMatchObject([{ reason: { code: "conflict" } }]);
    expect(await balance(source.fixture!.id)).toMatchObject({
      checkout_reserved: 0,
    });
  });
  it("rejects another owner/instance, missing origin and wrong expected version without mutation", async () => {
    const source = await held();
    const before = await snapshot();
    for (const trusted of [
      { ...context, ownerHash: "b".repeat(64) },
      { ...context, instanceId: crypto.randomUUID() },
    ])
      await expect(
        releaseTestCheckoutOrder(
          db,
          trusted,
          input(source.order.orderId),
          clock,
        ),
      ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      releaseTestCheckoutOrder(
        db,
        context,
        { ...input(source.order.orderId), expectedVersion: 2 },
        clock,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      releaseTestCheckoutOrder(db, context, input(historical.id), clock),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await snapshot()).toEqual(before);
  });
  it("releases original quantities despite price/name/version/publication changes", async () => {
    const source = await held();
    await db.batch([
      db
        .prepare(
          "UPDATE commerce_variants SET price_cents=2995,active=0,version=version+1 WHERE id=?",
        )
        .bind(source.fixture!.id),
      db
        .prepare(
          "UPDATE products SET name='Changed fictional name',status='hidden' WHERE id=?",
        )
        .bind(source.fixture!.productId),
    ]);
    await releaseTestCheckoutOrder(
      db,
      context,
      input(source.order.orderId),
      clock,
    );
    expect(await balance(source.fixture!.id)).toEqual({
      on_hand: 5,
      facebook_reserved: 0,
      checkout_reserved: 0,
      allocated: 0,
    });
  });
  it.each(["abort-movement", "ignore-movement", "ignore-update"])(
    "rolls back parent/command/lines/root/floor after %s",
    async (failure) => {
      const a = await item(),
        b = await item();
      const source = await held([
        { variantId: a.id, quantity: 1 },
        { variantId: b.id, quantity: 2 },
      ]);
      const before = await snapshot();
      const trigger =
        failure === "ignore-update"
          ? `CREATE TRIGGER release_test_failure BEFORE UPDATE ON commerce_orders WHEN OLD.id='${source.order.orderId}' BEGIN SELECT RAISE(IGNORE); END`
          : `CREATE TRIGGER release_test_failure BEFORE INSERT ON commerce_stock_movements WHEN NEW.kind='release' AND NEW.variant_id='${b.id}' BEGIN SELECT RAISE(${failure === "abort-movement" ? "ABORT,'fixture failure'" : "IGNORE"}); END`;
      await db.prepare(trigger).run();
      try {
        await expect(
          releaseTestCheckoutOrder(
            db,
            context,
            input(source.order.orderId),
            clock,
          ),
        ).rejects.toMatchObject({ code: "unavailable" });
      } finally {
        await db.prepare("DROP TRIGGER release_test_failure").run();
      }
      expect(await snapshot()).toEqual(before);
      await expect(
        db
          .prepare(
            "UPDATE commerce_inventory SET checkout_reserved=0 WHERE variant_id=?",
          )
          .bind(a.id)
          .run(),
      ).rejects.toThrow();
    },
  );
  it("copies context/input before await and accepts null-prototype own data", async () => {
    const source = await held();
    const command = input(source.order.orderId);
    const trusted = { ...context };
    const pending = releaseTestCheckoutOrder(db, trusted, command, clock);
    command.orderId = `order-${crypto.randomUUID()}`;
    command.kind = "expire";
    command.expectedVersion = 3;
    trusted.ownerHash = "b".repeat(64);
    const result = await pending;
    expect(result.orderId).toBe(source.order.orderId);
    expect(result.kind).toBe("cancel");
    const other = await held();
    expect(
      (
        await releaseTestCheckoutOrder(
          db,
          Object.assign(Object.create(null), context),
          Object.assign(Object.create(null), input(other.order.orderId)),
          clock,
        )
      ).resultingVersion,
    ).toBe(2);
  });
  it("rejects extra data, accessors, symbols, invalid scalars and unsafe clocks without DB writes", async () => {
    const source = await held();
    const command = input(source.order.orderId);
    const before = await snapshot();
    let getterCalled = false;
    const getter = { ...command };
    Object.defineProperty(getter, "kind", {
      get() {
        getterCalled = true;
        return "cancel";
      },
    });
    const malformed: unknown[] = [
      null,
      [],
      { ...command, quantity: 1 },
      { ...command, ownerHash: context.ownerHash },
      { ...command, [Symbol("extra")]: 1 },
      getter,
      { ...command, releaseKey: "bad" },
      { ...command, orderId: source.order.orderId.toUpperCase() },
      { ...command, kind: "allocate" },
      ...[0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER, NaN].map(
        (expectedVersion) => ({ ...command, expectedVersion }),
      ),
    ];
    for (const bad of malformed)
      await expect(
        releaseTestCheckoutOrder(db, context, bad, clock),
      ).rejects.toMatchObject({ code: "invalid_request" });
    for (const badContext of [
      { ...context, ownerHash: "x".repeat(64) },
      { ...context, mode: "production" },
      { ...context, extra: true },
    ])
      await expect(
        releaseTestCheckoutOrder(
          db,
          badContext as TestCheckoutContext,
          command,
          clock,
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    for (const time of [NaN, Infinity, -1, 1.5, 8_640_000_000_000_001])
      await expect(
        releaseTestCheckoutOrder(db, context, command, () => time),
      ).rejects.toMatchObject({ code: "invalid_request" });
    expect(getterCalled).toBe(false);
    expect(await snapshot()).toEqual(before);
  });
  it("recovers a pre-insert same-key winner before rejecting its changed order version", async () => {
    const source = await held();
    const command = input(source.order.orderId);
    let won = false;
    const delayed = queries(db, async (sql, method, execute) => {
      if (
        !won &&
        method === "first" &&
        sql.includes("FROM commerce_checkout_order_origins x")
      ) {
        won = true;
        await releaseTestCheckoutOrder(db, context, command, clock);
      }
      return execute();
    });
    const result = await releaseTestCheckoutOrder(
      delayed,
      context,
      command,
      () => now + 1,
    );
    expect(result).toEqual(
      await releaseTestCheckoutOrder(db, context, command, () => now + 999_999),
    );
    expect(result.occurredAt).toBe(now);
  });
  it("replays historical receipt after expiry/catalog change and a lost write response", async () => {
    const source = await held();
    const command = input(source.order.orderId);
    let lost = false;
    const flaky = queries(db, async (_sql, method, execute) => {
      const result = await execute();
      if (method === "run" && !lost) {
        lost = true;
        throw new Error("Lost private response");
      }
      return result;
    });
    const first = await releaseTestCheckoutOrder(
      flaky,
      context,
      command,
      clock,
    );
    await db
      .prepare(
        "UPDATE commerce_variants SET active=0,version=version+1 WHERE id=?",
      )
      .bind(source.fixture!.id)
      .run();
    expect(
      await releaseTestCheckoutOrder(
        db,
        context,
        command,
        () => source.order.reserveUntil + 999_999,
      ),
    ).toEqual(first);
    expect(await balance(source.fixture!.id)).toMatchObject({
      checkout_reserved: 0,
    });
  });
  it.each([
    "before-read",
    "before-write",
    "postcommit-read",
    "lost-write-and-read",
  ])(
    "normalizes %s uncertainty and permits original-key recovery",
    async (failure) => {
      const source = await held();
      const command = input(source.order.orderId);
      let committed = false;
      const faulty = queries(db, async (_sql, method, execute) => {
        if (
          failure === "before-read" ||
          committed ||
          (failure === "before-write" && method === "run")
        )
          throw new Error("private SQL owner-data");
        const result = await execute();
        if (method === "run") {
          committed = true;
          if (failure === "lost-write-and-read")
            throw new Error("private SQL lost write");
        }
        return result;
      });
      const error = await releaseTestCheckoutOrder(
        faulty,
        context,
        command,
        clock,
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        name: "CheckoutReleaseError",
        code: "unavailable",
      });
      expect(String(error)).not.toContain("private");
      expect(error).not.toHaveProperty("cause");
      const recovered = await releaseTestCheckoutOrder(
        db,
        context,
        command,
        clock,
      );
      expect(recovered.orderId).toBe(source.order.orderId);
      expect(await balance(source.fixture!.id)).toMatchObject({
        checkout_reserved: 0,
      });
    },
  );
  it("keeps another mapped hold and legacy hold safe while releasing only owned quantities", async () => {
    const fixture = await item(10);
    const a = await held([{ variantId: fixture.id, quantity: 2 }]);
    const b = await held([{ variantId: fixture.id, quantity: 3 }]);
    const quote = await createTestQuote(
      db,
      context.ownerHash,
      [{ variantId: fixture.id, quantity: 1 }],
      "pickup",
      now,
    );
    const legacy = await reserveTestOrder(db, context.ownerHash, quote.id, now);
    await applyStockCommand(
      db,
      crypto.randomUUID(),
      [
        {
          variantId: fixture.id,
          kind: "fb_reserve",
          quantity: 1,
          reason: "Fictional channel hold",
        },
      ],
      now,
    );
    await releaseTestCheckoutOrder(db, context, input(a.order.orderId), clock);
    expect(await balance(fixture.id)).toEqual({
      on_hand: 10,
      facebook_reserved: 1,
      checkout_reserved: 4,
      allocated: 0,
    });
    await releaseTestOrder(db, context.ownerHash, legacy.id, "cancel", now);
    expect(await balance(fixture.id)).toEqual({
      on_hand: 10,
      facebook_reserved: 1,
      checkout_reserved: 3,
      allocated: 0,
    });
    const before = await snapshot();
    for (const sql of [
      "UPDATE commerce_inventory SET checkout_reserved=2 WHERE variant_id=?",
      "INSERT OR REPLACE INTO commerce_inventory(variant_id,on_hand,checkout_reserved) VALUES (?,10,0)",
      "INSERT INTO commerce_inventory(variant_id,on_hand,checkout_reserved) VALUES (?,10,3) ON CONFLICT(variant_id) DO UPDATE SET checkout_reserved=0",
    ])
      await expect(db.prepare(sql).bind(fixture.id).run()).rejects.toThrow();
    await expect(
      applyStockCommand(
        db,
        crypto.randomUUID(),
        [
          {
            variantId: fixture.id,
            kind: "release",
            quantity: 1,
            reason: "Cannot steal remaining hold",
          },
        ],
        now,
      ),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await releaseTestCheckoutOrder(db, context, input(b.order.orderId), clock);
    expect(await balance(fixture.id)).toEqual({
      on_hand: 10,
      facebook_reserved: 1,
      checkout_reserved: 0,
      allocated: 0,
    });
  });
  it("blocks direct state changes, receipt replacement, extra movements and command adoption", async () => {
    const source = await held();
    const before = await snapshot();
    await expect(
      db
        .prepare(
          "UPDATE commerce_orders SET state='cancelled',version=version+1 WHERE id=?",
        )
        .bind(source.order.orderId)
        .run(),
    ).rejects.toThrow();
    await expect(
      rawRelease(source.order.orderId, { owner_hash: "b".repeat(64) }),
    ).rejects.toThrow();
    await expect(
      rawRelease(source.order.orderId, { kind: "expire" }),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    const collision = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO commerce_commands(id,request_hash,created_at) VALUES (?, ?, ?)",
      )
      .bind(`checkout-release-${collision}`, "c".repeat(64), now)
      .run();
    const collisionBefore = await snapshot();
    await expect(
      rawRelease(source.order.orderId, {
        release_id: collision,
        command_id: `checkout-release-${collision}`,
      }),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(collisionBefore);
    await releaseTestCheckoutOrder(
      db,
      context,
      input(source.order.orderId),
      clock,
    );
    const release = await releaseRow(source.order.orderId);
    const after = await snapshot();
    for (const sql of [
      "UPDATE commerce_checkout_order_releases SET kind=kind WHERE order_id=?",
      "DELETE FROM commerce_checkout_order_releases WHERE order_id=?",
      "UPDATE commerce_orders SET state='pending_payment',version=1 WHERE id=?",
      "UPDATE commerce_orders SET owner_hash=owner_hash WHERE id=?",
      "DELETE FROM commerce_orders WHERE id=?",
    ])
      await expect(
        db.prepare(sql).bind(source.order.orderId).run(),
      ).rejects.toThrow();
    const columns = Object.keys(release);
    await expect(
      db
        .prepare(
          `INSERT OR REPLACE INTO commerce_checkout_order_releases(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        )
        .bind(...columns.map((column) => release[column]))
        .run(),
    ).rejects.toThrow();
    for (const position of [0, 1])
      await expect(
        db
          .prepare(
            "INSERT INTO commerce_stock_movements(command_id,position,variant_id,kind,quantity,expected_variant_version,reason) VALUES (?, ?, ?, 'release',2,NULL,'Owned unpaid checkout release')",
          )
          .bind(release.command_id, position, source.fixture!.id)
          .run(),
      ).rejects.toThrow();
    expect(await snapshot()).toEqual(after);
  });
  it.each([
    ["processing", "payment_state='processing'"],
    ["unknown", "payment_state='unknown'"],
    ["failed", "payment_state='failed'"],
    ["held", "fulfillment='held'"],
    ["confirmed", "state='confirmed'"],
    ["unsafe version", "version=9007199254740991"],
  ])(
    "refuses injected private future %s state without freeing stock",
    async (_label, change) => {
      const source = await held();
      await withoutGuards(["commerce_checkout_order_no_update"], async () => {
        await db
          .prepare(`UPDATE commerce_orders SET ${change} WHERE id=?`)
          .bind(source.order.orderId)
          .run();
      });
      const before = await snapshot();
      await expect(
        releaseTestCheckoutOrder(
          db,
          context,
          input(source.order.orderId),
          clock,
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(rawRelease(source.order.orderId)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    },
  );
  it("rejects any injected attempt across provider/context even if root still says not_started", async () => {
    const source = await held();
    const mapped = await origin(source.order.orderId);
    const requestId = crypto.randomUUID();
    // Existing payment constraints cannot legitimately start this typed order.
    // Inject only an impossible future fixture, restoring guards before release.
    const insert = async () => {
      await db
        .prepare(
          `INSERT INTO commerce_payment_attempts(command_id,request_id,order_id,quote_id,owner_hash,mode,instance_id,provider,account_ref,amount_cents,currency,rules_version,snapshot_hash,expected_version,occurred_at,create_operation_key) VALUES (?,?,?,?,?,'local-test',?,'paypal','fixture-private',1,'CAD','local-test-v1',?,1,?,?)`,
        )
        .bind(
          `payment-start-${requestId}`,
          requestId,
          source.order.orderId,
          mapped.promoted_quote_id,
          "b".repeat(64),
          crypto.randomUUID(),
          "d".repeat(64),
          now,
          crypto.randomUUID(),
        )
        .run();
    };
    await db
      .prepare(
        "INSERT INTO commerce_commands(id,request_hash,created_at) VALUES (?,?,?)",
      )
      .bind(`payment-start-${requestId}`, "d".repeat(64), now)
      .run();
    await expect(insert()).rejects.toThrow();
    await withoutGuards(
      [
        "commerce_payment_start_guard",
        "commerce_payment_start_quote_guard",
        "commerce_payment_start_lines_guard",
        "commerce_payment_start_lock",
      ],
      insert,
    );
    expect((await row(source.order.orderId)).payment_state).toBe("not_started");
    const before = await snapshot();
    await expect(
      releaseTestCheckoutOrder(db, context, input(source.order.orderId), clock),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(rawRelease(source.order.orderId)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
});
