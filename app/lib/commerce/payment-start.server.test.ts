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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyStockCommand } from "./inventory.server";
import {
  createTestQuote,
  getTestOrder,
  releaseTestOrder,
  reserveTestOrder,
} from "./orders.server";
import { recoverExpiredReservation } from "./reservation-recovery.server";
import {
  beginTestPaymentAttempt,
  type TestPaymentStartInput,
  type TrustedTestPaymentContext,
} from "./payment-start.server";

const root = resolve(process.cwd());
const now = 1_800_000_000_000;
const owner = "a".repeat(64);
const trusted: TrustedTestPaymentContext = {
  mode: "local-test",
  instanceId: "11111111-1111-4111-8111-111111111111",
  provider: "stripe",
  accountRef: "fixture-stripe",
  ownerHash: owner,
};
const actor = {
  email: "fictional-owner@example.invalid",
  sub: "fictional-operator",
};
let directory: string;
let configPath: string;
let platform: PlatformProxy<Env>;
let db: D1Database;
let sequence = 0;
let legacy: Awaited<ReturnType<typeof reserved>>;
let beforeUpgrade: unknown;
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
      join(directory, "state"),
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
}
async function connect() {
  platform = await getPlatformProxy<Env>({
    configPath,
    envFiles: [],
    persist: { path: join(directory, "state/v3") },
    remoteBindings: false,
  });
  db = platform.env.DB;
}
async function reserved(mutate?: (quote: Record<string, unknown>) => unknown) {
  const id = `payment-fixture-${++sequence}`;
  const product = await db
    .prepare(
      `INSERT INTO products(name,slug,price_cents,quantity,category_id,status,created_at,updated_at)
    VALUES ('Fictional payment test',?,999,999,1,'draft',1,1) RETURNING id`,
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
        `INSERT INTO commerce_variants(id,product_id,sku,colour,size_description,price_cents,active) VALUES (?,?,?,'Gold-tone','Fictional',2500,1)`,
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
        quantity: 3,
        reason: "Fictional receipt",
      },
    ],
    now,
  );
  const saved = await createTestQuote(
    db,
    owner,
    [{ variantId: id, quantity: 1 }],
    "pickup",
    now,
  );
  if (!mutate) {
    const order = await reserveTestOrder(db, owner, saved.id, now);
    return { id, order, quoteId: saved.id };
  }
  const quoteId = crypto.randomUUID();
  const snapshot = JSON.stringify(
    mutate(JSON.parse(JSON.stringify(saved.quote)) as Record<string, unknown>),
  );
  await db
    .prepare(
      "INSERT INTO commerce_quotes(id,owner_hash,snapshot,created_at,expires_at) VALUES (?,?,?,?,?)",
    )
    .bind(quoteId, owner, snapshot, now, saved.quote.expiresAt)
    .run();
  const orderId = `order-${quoteId}`;
  const commandId = `reserve-${quoteId}`;
  await db.batch([
    db
      .prepare(
        "INSERT INTO commerce_commands(id,request_hash,created_at) VALUES (?,?,?)",
      )
      .bind(commandId, "c".repeat(64), now),
    db
      .prepare(
        "INSERT INTO commerce_orders(id,quote_id,owner_hash,reserve_command_id,snapshot,created_at,reserve_until) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(orderId, quoteId, owner, commandId, snapshot, now, now + 900_000),
    db
      .prepare(
        "INSERT INTO commerce_order_lines(order_id,position,variant_id,quantity,unit_price_cents,variant_version) VALUES (?,0,?,1,2500,1)",
      )
      .bind(orderId, id),
  ]);
  return {
    id,
    order: { id: orderId, version: 1, reserveUntil: now + 900_000 },
    quoteId,
  };
}
function input(reference: string): TestPaymentStartInput {
  return { requestId: crypto.randomUUID(), reference, expectedVersion: 1 };
}
async function snapshot(item: { id: string; order: { id: string } }) {
  return {
    order: await db
      .prepare("SELECT * FROM commerce_orders WHERE id=?")
      .bind(item.order.id)
      .first(),
    stock: (
      await db
        .prepare("SELECT * FROM commerce_inventory WHERE variant_id=?")
        .bind(item.id)
        .all()
    ).results,
    movements: (
      await db
        .prepare(
          "SELECT * FROM commerce_stock_movements WHERE variant_id=? ORDER BY command_id,position",
        )
        .bind(item.id)
        .all()
    ).results,
    attempts: (
      await db
        .prepare("SELECT * FROM commerce_payment_attempts WHERE order_id=?")
        .bind(item.order.id)
        .all()
    ).results,
    transitions: (
      await db
        .prepare("SELECT * FROM commerce_order_transitions WHERE order_id=?")
        .bind(item.order.id)
        .all()
    ).results,
  };
}
async function commandCount(command: TestPaymentStartInput) {
  return db
    .prepare("SELECT count(*) AS n FROM commerce_commands WHERE id=?")
    .bind(`payment-start-${command.requestId}`)
    .first<{ n: number }>();
}
// Deliberately bypass the service preflight: the database must enforce eligibility.
async function rawStart(
  item: { order: { id: string }; quoteId: string },
  command = input(item.order.id),
  occurredAt = now + 1,
) {
  return db.batch([
    db
      .prepare(
        "INSERT INTO commerce_commands(id,request_hash,created_at) VALUES (?,?,?)",
      )
      .bind(`payment-start-${command.requestId}`, "d".repeat(64), occurredAt),
    db
      .prepare(
        `INSERT INTO commerce_payment_attempts(command_id,request_id,order_id,quote_id,owner_hash,mode,instance_id,provider,account_ref,amount_cents,currency,rules_version,snapshot_hash,expected_version,occurred_at,create_operation_key)
      VALUES (?,?,?,?,?,'local-test',?,'stripe','fixture-stripe',2500,'CAD','local-test-v1',?,?,?,?)`,
      )
      .bind(
        `payment-start-${command.requestId}`,
        command.requestId,
        item.order.id,
        item.quoteId,
        owner,
        trusted.instanceId,
        "e".repeat(64),
        command.expectedVersion,
        occurredAt,
        crypto.randomUUID(),
      ),
  ]);
}
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "jewelry-payment-start-"));
  const migrations = join(directory, "migrations");
  mkdirSync(migrations);
  for (const file of readdirSync(join(root, "migrations")).filter(
    (file) => file.endsWith(".sql") && file < "0009",
  ))
    copyFileSync(join(root, "migrations", file), join(migrations, file));
  configPath = join(directory, "wrangler.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "fictional-payment-start-test",
      compatibility_date: "2026-09-29",
      d1_databases: [
        {
          binding: "DB",
          database_name: "fictional-payment-start-test",
          database_id: "local-test",
          migrations_dir: migrations,
          migrations_table: "catalog_migrations",
        },
      ],
    }),
  );
  migrate();
  await connect();
  legacy = await reserved();
  await recoverExpiredReservation(
    db,
    actor,
    {
      ...input(legacy.order.id),
      confirmation: legacy.order.id,
      reason: "overdue_unpaid",
    },
    legacy.order.reserveUntil,
  );
  beforeUpgrade = {
    order: await getTestOrder(db, owner, legacy.order.id),
    audit: (
      await db.prepare("SELECT * FROM commerce_reservation_recoveries").all()
    ).results,
    stock: (
      await db
        .prepare(
          "SELECT * FROM commerce_stock_movements ORDER BY command_id,position",
        )
        .all()
    ).results,
  };
  await platform.dispose();
  copyFileSync(
    join(root, "migrations/0009_commerce_payment_start.sql"),
    join(migrations, "0009_commerce_payment_start.sql"),
  );
  migrate();
  await connect();
}, 30_000);
afterAll(async () => {
  await platform?.dispose();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("internal fictional payment-start intent on real temporary D1", () => {
  it("upgrades 0001–0008 without changing historical orders, recovery audits or stock; scope stays empty", async () => {
    expect({
      order: await getTestOrder(db, owner, legacy.order.id),
      audit: (
        await db.prepare("SELECT * FROM commerce_reservation_recoveries").all()
      ).results,
      stock: (
        await db
          .prepare(
            "SELECT * FROM commerce_stock_movements ORDER BY command_id,position",
          )
          .all()
      ).results,
    }).toEqual(beforeUpgrade);
    expect(
      (await db.prepare("SELECT * FROM commerce_payment_scope").all()).results,
    ).toEqual([]);
    const prepare = vi.fn((sql: string) => db.prepare(sql));
    await expect(
      beginTestPaymentAttempt(
        { prepare } as unknown as D1Database,
        trusted,
        input(legacy.order.id),
        now,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0][0]).toContain("commerce_payment_scope");
    await db
      .prepare(
        "INSERT INTO commerce_payment_scope(id,mode,instance_id,stripe_account_ref,paypal_account_ref) VALUES (1,'local-test',?,'fixture-stripe','fixture-paypal')",
      )
      .bind(trusted.instanceId)
      .run();
  });
  it.each([
    { instanceId: "22222222-2222-4222-8222-222222222222" },
    { accountRef: "fixture-wrong" },
  ])(
    "refuses mismatched binding before any receipt/order read: %j",
    async (change) => {
      const prepare = vi.fn((sql: string) => db.prepare(sql));
      await expect(
        beginTestPaymentAttempt(
          { prepare } as unknown as D1Database,
          { ...trusted, ...change },
          input(legacy.order.id),
          now,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(prepare).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["stripe", "paypal"] as const)(
    "records one %s intent, locks version 2 and preserves stock and ledger",
    async (provider) => {
      const item = await reserved();
      const before = await snapshot(item);
      const command = input(item.order.id);
      const context = {
        ...trusted,
        provider,
        accountRef: `fixture-${provider}`,
      };
      const result = await beginTestPaymentAttempt(
        db,
        context,
        command,
        now + 1,
      );
      expect(result).toEqual({
        testOnly: true,
        ...command,
        provider,
        amountCents: 2500,
        currency: "CAD",
        resultingVersion: 2,
        recordedAt: now + 1,
        createOperationKey: expect.any(String),
        replayed: false,
      });
      const after = await snapshot(item);
      expect(after.order).toMatchObject({
        payment_state: "processing",
        version: 2,
      });
      expect(after.stock).toEqual(before.stock);
      expect(after.movements).toEqual(before.movements);
      expect(after.attempts).toHaveLength(1);
      const descriptor = after.attempts[0] as Record<string, unknown>;
      expect(descriptor).toMatchObject({
        request_id: command.requestId,
        quote_id: item.quoteId,
        owner_hash: owner,
        mode: "local-test",
        instance_id: trusted.instanceId,
        provider,
        account_ref: context.accountRef,
        amount_cents: 2500,
        currency: "CAD",
        rules_version: "local-test-v1",
        expected_version: 1,
        occurred_at: now + 1,
      });
      expect(descriptor.snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
      await db
        .prepare(
          "UPDATE commerce_orders SET state='confirmed',payment_state='succeeded',version=3 WHERE id=?",
        )
        .bind(item.order.id)
        .run();
      expect(
        await beginTestPaymentAttempt(db, context, command, now + 2_000_000),
      ).toEqual({ ...result, replayed: true });
      expect(await commandCount(command)).toEqual({ n: 1 });
    },
  );
  it("records identical concurrent submissions exactly once", async () => {
    const item = await reserved();
    const command = input(item.order.id);
    const receipts = await Promise.all(
      Array.from({ length: 4 }, () =>
        beginTestPaymentAttempt(db, trusted, command, now + 1),
      ),
    );
    expect(
      new Set(receipts.map((receipt) => receipt.createOperationKey)).size,
    ).toBe(1);
    expect(receipts.filter((receipt) => !receipt.replayed)).toHaveLength(1);
    expect((await snapshot(item)).attempts).toHaveLength(1);
    expect(await commandCount(command)).toEqual({ n: 1 });
  });
  it("different request keys/providers race to one intent and one command", async () => {
    const item = await reserved();
    const first = input(item.order.id);
    const second = input(item.order.id);
    const outcomes = await Promise.allSettled([
      beginTestPaymentAttempt(db, trusted, first, now + 1),
      beginTestPaymentAttempt(
        db,
        { ...trusted, provider: "paypal", accountRef: "fixture-paypal" },
        second,
        now + 1,
      ),
    ]);
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((result) => result.status === "rejected"),
    ).toMatchObject([{ reason: { code: "conflict" } }]);
    expect((await snapshot(item)).attempts).toHaveLength(1);
    expect(
      (await commandCount(first))!.n + (await commandCount(second))!.n,
    ).toBe(1);
  });
  it("rejects same-key actor, order, version and provider collisions; an orphan command is never success", async () => {
    const item = await reserved();
    const command = input(item.order.id);
    await beginTestPaymentAttempt(db, trusted, command, now + 1);
    const other = await reserved();
    for (const [context, request] of [
      [{ ...trusted, ownerHash: "b".repeat(64) }, command],
      [trusted, { ...command, reference: other.order.id }],
      [trusted, { ...command, expectedVersion: 2 }],
      [
        { ...trusted, provider: "paypal", accountRef: "fixture-paypal" },
        command,
      ],
    ] as [TrustedTestPaymentContext, TestPaymentStartInput][]) {
      await expect(
        beginTestPaymentAttempt(db, context, request, now + 2),
      ).rejects.toMatchObject({ code: "conflict" });
    }
    const orphan = input(other.order.id);
    await db
      .prepare(
        "INSERT INTO commerce_commands(id,request_hash,created_at) VALUES (?,?,?)",
      )
      .bind(`payment-start-${orphan.requestId}`, "f".repeat(64), now)
      .run();
    await expect(
      beginTestPaymentAttempt(db, trusted, orphan, now + 1),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      beginTestPaymentAttempt(
        db,
        { ...trusted, ownerHash: "b".repeat(64) },
        input(other.order.id),
        now + 1,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
  it.each(["cancel", "expire", "recovery"] as const)(
    "%s before start wins; after start cannot release stock",
    async (kind) => {
      const item = await reserved();
      const release = async () =>
        kind === "recovery"
          ? recoverExpiredReservation(
              db,
              actor,
              {
                ...input(item.order.id),
                confirmation: item.order.id,
                reason: "overdue_unpaid",
              },
              item.order.reserveUntil,
            )
          : releaseTestOrder(
              db,
              owner,
              item.order.id,
              kind,
              kind === "expire" ? item.order.reserveUntil : now + 1,
            );
      await release();
      await expect(
        beginTestPaymentAttempt(db, trusted, input(item.order.id), now + 2),
      ).rejects.toMatchObject({ code: "conflict" });
      const locked = await reserved();
      await beginTestPaymentAttempt(
        db,
        trusted,
        input(locked.order.id),
        now + 1,
      );
      const before = await snapshot(locked);
      await expect(
        kind === "recovery"
          ? recoverExpiredReservation(
              db,
              actor,
              {
                ...input(locked.order.id),
                expectedVersion: 2,
                confirmation: locked.order.id,
                reason: "overdue_unpaid",
              },
              locked.order.reserveUntil,
            )
          : releaseTestOrder(
              db,
              owner,
              locked.order.id,
              kind,
              locked.order.reserveUntil,
            ),
      ).rejects.toMatchObject({
        code: kind === "recovery" ? "conflict" : "order_conflict",
      });
      expect(await snapshot(locked)).toEqual(before);
    },
  );
  it.each(["cancel", "expire", "recovery"] as const)(
    "%s committing between preflight and insert prevents an intent",
    async (kind) => {
      const item = await reserved();
      const command = input(item.order.id);
      const raced = {
        prepare: db.prepare.bind(db),
        async batch(statements: D1PreparedStatement[]) {
          if (kind === "recovery")
            await recoverExpiredReservation(
              db,
              actor,
              {
                ...input(item.order.id),
                confirmation: item.order.id,
                reason: "overdue_unpaid",
              },
              item.order.reserveUntil,
            );
          else
            await releaseTestOrder(
              db,
              owner,
              item.order.id,
              kind,
              item.order.reserveUntil,
            );
          return db.batch(statements);
        },
      } as unknown as D1Database;
      await expect(
        beginTestPaymentAttempt(raced, trusted, command, now + 1),
      ).rejects.toMatchObject({ code: "conflict" });
      const after = await snapshot(item);
      expect(after.order).toMatchObject({
        state: "cancelled",
        payment_state: "not_started",
        version: 2,
      });
      expect(after.attempts).toEqual([]);
      expect(after.transitions).toHaveLength(1);
      expect(after.stock[0]).toMatchObject({
        on_hand: 3,
        checkout_reserved: 0,
      });
      expect(await commandCount(command)).toEqual({ n: 0 });
    },
  );
  it.each([
    [
      "stale version",
      "UPDATE commerce_orders SET version=2 WHERE id=?",
      now + 1,
    ],
    [
      "held",
      "UPDATE commerce_orders SET fulfillment='held' WHERE id=?",
      now + 1,
    ],
    [
      "confirmed",
      "UPDATE commerce_orders SET state='confirmed' WHERE id=?",
      now + 1,
    ],
    [
      "processing",
      "UPDATE commerce_orders SET payment_state='processing' WHERE id=?",
      now + 1,
    ],
    [
      "future order",
      "UPDATE commerce_orders SET created_at=created_at+100 WHERE id=?",
      now + 1,
    ],
    ["quote deadline equality", null, now + 600_000],
    [
      "reservation deadline equality",
      "UPDATE commerce_orders SET reserve_until=created_at+10 WHERE id=?",
      now + 10,
    ],
  ] as const)(
    "refuses %s in service and database guard",
    async (_label, sql, time) => {
      const item = await reserved();
      if (sql) await db.prepare(sql).bind(item.order.id).run();
      const command = input(item.order.id);
      const before = await snapshot(item);
      await expect(
        beginTestPaymentAttempt(db, trusted, command, time),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(rawStart(item, command, time)).rejects.toThrow();
      expect(await snapshot(item)).toEqual(before);
      expect(await commandCount(command)).toEqual({ n: 0 });
    },
  );
  it.each([
    ["null root", () => null],
    [
      "null total",
      (q: Record<string, unknown>) => ({ ...q, totalCents: null }),
    ],
    [
      "string total",
      (q: Record<string, unknown>) => ({ ...q, totalCents: "2500" }),
    ],
    [
      "wrong test marker",
      (q: Record<string, unknown>) => ({ ...q, testOnly: 1 }),
    ],
    [
      "wrong currency",
      (q: Record<string, unknown>) => ({ ...q, currency: "USD" }),
    ],
    [
      "wrong rules",
      (q: Record<string, unknown>) => ({ ...q, rulesVersion: "future-live" }),
    ],
    [
      "wrong expiry",
      (q: Record<string, unknown>) => ({ ...q, expiresAt: now + 700_000 }),
    ],
    ["null lines", (q: Record<string, unknown>) => ({ ...q, lines: null })],
    ["empty lines", (q: Record<string, unknown>) => ({ ...q, lines: [] })],
    [
      "missing subtotal",
      (q: Record<string, unknown>) => {
        delete q.subtotalCents;
        return q;
      },
    ],
    [
      "unsafe total",
      (q: Record<string, unknown>) => ({
        ...q,
        totalCents: Number.MAX_SAFE_INTEGER + 1,
      }),
    ],
    ["zero total", (q: Record<string, unknown>) => ({ ...q, totalCents: 0 })],
    [
      "fictional tax changed",
      (q: Record<string, unknown>) => ({
        ...q,
        taxCents: 10,
        totalCents: 2510,
      }),
    ],
    [
      "line quantity coerced",
      (q: Record<string, unknown>) => {
        (q.lines as Record<string, unknown>[])[0].quantity = "1";
        return q;
      },
    ],
    [
      "line amount mismatch",
      (q: Record<string, unknown>) => {
        (q.lines as Record<string, unknown>[])[0].lineTotalCents = 2499;
        return q;
      },
    ],
    [
      "line identity mismatch",
      (q: Record<string, unknown>) => {
        (q.lines as Record<string, unknown>[])[0].variantId = "wrong-variant";
        return q;
      },
    ],
    [
      "extra line",
      (q: Record<string, unknown>) => ({
        ...q,
        lines: [...(q.lines as unknown[]), ...(q.lines as unknown[])],
      }),
    ],
  ])(
    "rejects malformed stored fixture: %s, including direct SQL",
    async (_label, mutate) => {
      const item = await reserved(
        mutate as (quote: Record<string, unknown>) => unknown,
      );
      const before = await snapshot(item);
      const command = input(item.order.id);
      await expect(
        beginTestPaymentAttempt(db, trusted, command, now + 1),
      ).rejects.toMatchObject({
        // The typed legacy read boundary excludes these historical malformed
        // sources before payment validation; raw SQL must still reject them.
        code: [
          "null root",
          "wrong test marker",
          "wrong currency",
          "wrong rules",
          "fictional tax changed",
        ].includes(_label as string)
          ? "not_found"
          : _label === "line identity mismatch"
            ? "unavailable"
            : "conflict",
      });
      await expect(rawStart(item, command)).rejects.toThrow();
      expect(await snapshot(item)).toEqual(before);
      expect(await commandCount(command)).toEqual({ n: 0 });
    },
  );
  it("refuses exact order-line/original reserve mismatch even when the service quote preflight is valid", async () => {
    const item = await reserved();
    const different = await reserved();
    // This was permitted by the legacy order schema before attempts; the new
    // guard must refuse to lock it against another order's reserve audit.
    await db
      .prepare("UPDATE commerce_orders SET reserve_command_id=? WHERE id=?")
      .bind(`receive-${different.id}`, item.order.id)
      .run();
    const before = await snapshot(item);
    const command = input(item.order.id);
    await expect(
      beginTestPaymentAttempt(db, trusted, command, now + 1),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(rawStart(item, command)).rejects.toThrow();
    expect(await snapshot(item)).toEqual(before);
    expect(await commandCount(command)).toEqual({ n: 0 });
  });
  it("rejects a changed snapshot between read and insert using the literal snapshot precondition", async () => {
    const item = await reserved();
    const command = input(item.order.id);
    const intercepted = {
      prepare: db.prepare.bind(db),
      async batch(statements: D1PreparedStatement[]) {
        await db
          .prepare(
            "UPDATE commerce_orders SET snapshot=json_set(snapshot,'$.lines[0].name','Changed fixture') WHERE id=?",
          )
          .bind(item.order.id)
          .run();
        return db.batch(statements);
      },
    } as unknown as D1Database;
    await expect(
      beginTestPaymentAttempt(intercepted, trusted, command, now + 1),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await snapshot(item)).attempts).toEqual([]);
    expect(await commandCount(command)).toEqual({ n: 0 });
    expect((await snapshot(item)).stock[0]).toMatchObject({
      checkout_reserved: 1,
    });
  });
  it("rolls back a trigger failure and refuses to claim a zero-write adapter succeeded", async () => {
    const item = await reserved();
    const command = input(item.order.id);
    const before = await snapshot(item);
    await db
      .prepare(
        `CREATE TRIGGER payment_fixture_failure AFTER INSERT ON commerce_payment_attempts BEGIN SELECT RAISE(ABORT,'fictional failure'); END`,
      )
      .run();
    try {
      await expect(
        beginTestPaymentAttempt(db, trusted, command, now + 1),
      ).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      await db.prepare("DROP TRIGGER payment_fixture_failure").run();
    }
    expect(await snapshot(item)).toEqual(before);
    expect(await commandCount(command)).toEqual({ n: 0 });
    await expect(
      beginTestPaymentAttempt(
        {
          prepare: db.prepare.bind(db),
          batch: async () => [],
        } as unknown as D1Database,
        trusted,
        command,
        now + 1,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await snapshot(item)).toEqual(before);
  });
  it("reconciles a lost batch response from the immutable descriptor", async () => {
    const item = await reserved();
    const command = input(item.order.id);
    const lost = {
      prepare: db.prepare.bind(db),
      async batch(statements: D1PreparedStatement[]) {
        await db.batch(statements);
        throw new Error("fictional lost response");
      },
    } as unknown as D1Database;
    const receipt = await beginTestPaymentAttempt(
      lost,
      trusted,
      command,
      now + 1,
    );
    expect(receipt).toMatchObject({
      replayed: true,
      amountCents: 2500,
      recordedAt: now + 1,
    });
    expect(
      await beginTestPaymentAttempt(db, trusted, command, now + 900_000),
    ).toEqual(receipt);
    expect(await commandCount(command)).toEqual({ n: 1 });
  });
  it("returns unavailable when write response and readback are lost; original key resolves later", async () => {
    const item = await reserved();
    const command = input(item.order.id);
    let committed = false;
    const lost = {
      prepare(sql: string) {
        if (committed) throw new Error("fictional readback outage");
        return db.prepare(sql);
      },
      async batch(statements: D1PreparedStatement[]) {
        await db.batch(statements);
        committed = true;
        throw new Error("fictional lost response");
      },
    } as unknown as D1Database;
    await expect(
      beginTestPaymentAttempt(lost, trusted, command, now + 1),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect((await snapshot(item)).attempts).toHaveLength(1);
    expect(
      await beginTestPaymentAttempt(db, trusted, command, now + 900_000),
    ).toMatchObject({ replayed: true, recordedAt: now + 1 });
    expect(await commandCount(command)).toEqual({ n: 1 });
  });
  it.each(["preflight", "failed-batch reconciliation"])(
    "rechecks receipts after the %s order-read race gap",
    async (stage) => {
      const item = await reserved();
      const command = input(item.order.id);
      let committed:
        Awaited<ReturnType<typeof beginTestPaymentAttempt>> | undefined;
      let reads = 0;
      const batch = vi.fn(async () => {
        throw new Error("fictional transient write failure");
      });
      const raced = {
        prepare(sql: string) {
          const statement = db.prepare(sql);
          if (!sql.includes("q.owner_hash AS quoteOwner")) return statement;
          return {
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return {
                async first() {
                  reads += 1;
                  if (reads === (stage === "preflight" ? 1 : 2))
                    committed = await beginTestPaymentAttempt(
                      db,
                      trusted,
                      command,
                      now + 1,
                    );
                  return bound.first();
                },
              };
            },
          };
        },
        batch,
      } as unknown as D1Database;
      expect(
        await beginTestPaymentAttempt(raced, trusted, command, now + 1),
      ).toEqual({ ...committed, replayed: true });
      expect(batch).toHaveBeenCalledTimes(stage === "preflight" ? 0 : 1);
      expect((await snapshot(item)).attempts).toHaveLength(1);
      expect(await commandCount(command)).toEqual({ n: 1 });
    },
  );
  it("makes scope/descriptor immutable and freezes commercial order identity only after intent", async () => {
    const item = await reserved();
    // Existing recovery/diagnostic fixture editing remains available before start.
    await db
      .prepare(
        "UPDATE commerce_orders SET reserve_until=reserve_until+1 WHERE id=?",
      )
      .bind(item.order.id)
      .run();
    const command = input(item.order.id);
    await beginTestPaymentAttempt(db, trusted, command, now + 1);
    const before = await snapshot(item);
    for (const sql of [
      "UPDATE commerce_payment_scope SET stripe_account_ref='fixture-other' WHERE id=1",
      "DELETE FROM commerce_payment_scope WHERE id=1",
      "INSERT OR REPLACE INTO commerce_payment_scope SELECT * FROM commerce_payment_scope WHERE id=1",
      "UPDATE commerce_payment_attempts SET amount_cents=1 WHERE order_id=?",
      "DELETE FROM commerce_payment_attempts WHERE order_id=?",
      "INSERT OR REPLACE INTO commerce_payment_attempts SELECT * FROM commerce_payment_attempts WHERE order_id=?",
      "UPDATE commerce_orders SET snapshot='{}' WHERE id=?",
      "UPDATE commerce_orders SET owner_hash='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' WHERE id=?",
      "UPDATE commerce_orders SET quote_id='wrong-quote' WHERE id=?",
      "UPDATE commerce_orders SET reserve_command_id='wrong-reserve' WHERE id=?",
      "UPDATE commerce_orders SET reserve_until=reserve_until+1 WHERE id=?",
      "UPDATE commerce_orders SET created_at=created_at+1 WHERE id=?",
      "UPDATE commerce_orders SET id='wrong-id' WHERE id=?",
      "UPDATE commerce_orders SET payment_state='not_started' WHERE id=?",
      "DELETE FROM commerce_orders WHERE id=?",
      "INSERT OR REPLACE INTO commerce_orders SELECT * FROM commerce_orders WHERE id=?",
    ]) {
      const statement = db.prepare(sql);
      await expect(
        (sql.includes("?") ? statement.bind(item.order.id) : statement).run(),
      ).rejects.toThrow();
    }
    // Collision on another unique identity must not delete the first descriptor.
    const other = await reserved();
    await expect(
      rawStart(other, {
        ...input(other.order.id),
        requestId: command.requestId,
      }),
    ).rejects.toThrow();
    expect(await snapshot(item)).toEqual(before);
    expect((await snapshot(other)).attempts).toEqual([]);
  });
  it("validates strict shapes, bounds and synthetic identities before touching the database", async () => {
    const prepare = vi.fn();
    const absent = { prepare } as unknown as D1Database;
    const command = input(legacy.order.id);
    const cases: [unknown, unknown, number][] = [
      [null, command, now],
      [{ ...trusted, mode: "sandbox" }, command, now],
      [{ ...trusted, ownerHash: "not-owner" }, command, now],
      [{ ...trusted, accountRef: "acct_real-looking" }, command, now],
      [{ ...trusted, instanceId: "not-uuid" }, command, now],
      [{ ...trusted, extra: true }, command, now],
      [Object.create(trusted), command, now],
      [trusted, null, now],
      [trusted, { ...command, extra: 1 }, now],
      [trusted, { ...command, [Symbol("hidden")]: true }, now],
      [
        trusted,
        { ...command, requestId: "11111111-1111-1111-8111-111111111111" },
        now,
      ],
      [trusted, { ...command, reference: "order-other" }, now],
      [trusted, { ...command, expectedVersion: "1" }, now],
      [trusted, { ...command, expectedVersion: 0 }, now],
      [trusted, { ...command, expectedVersion: Number.MAX_SAFE_INTEGER }, now],
      [trusted, command, -1],
      [trusted, command, Number.NaN],
      [trusted, command, 8_640_000_000_000_001],
    ];
    for (const [context, request, time] of cases)
      await expect(
        beginTestPaymentAttempt(
          absent,
          context as TrustedTestPaymentContext,
          request as TestPaymentStartInput,
          time,
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    expect(prepare).not.toHaveBeenCalled();
  });
});
