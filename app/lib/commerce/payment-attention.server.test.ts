import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyStockCommand } from "./inventory.server";
import { createTestQuote, reserveTestOrder } from "./orders.server";
import { beginTestPaymentAttempt } from "./payment-start.server";
import { claimTestPaymentWork } from "./payment-work.server";
import {
  recordTestCaptureFact,
  type TestCaptureFactInput,
} from "./capture-facts.server";
import {
  recordTestPaymentObservation,
  type TestPaymentObservationInput,
} from "./payment-observations.server";
import { processTestPaymentObservation } from "./observation-processing.server";
import {
  listTestPaymentAttention,
  type TestPaymentAttentionContext,
  type TestPaymentAttentionInput,
  type TestPaymentAttentionItem,
} from "./payment-attention.server";

const root = resolve(process.cwd());
const now = 1_800_000_000_000;
const instanceId = "11111111-1111-4111-8111-111111111111";
const otherInstance = "99999999-9999-4999-8999-999999999999";
const ownerHash = "a".repeat(64);
const trusted: TestPaymentAttentionContext = { mode: "local-test", instanceId };
let directory: string;
let platform: PlatformProxy<Env>;
let db: D1Database;
let sequence = 0;
let absentScopeReads: string[];
function list(time = now + 10, database = db, cursor: string | null = null) {
  return listTestPaymentAttention(database, trusted, { cursor }, time);
}
function adapter(prepare: D1Database["prepare"]): D1Database {
  return {
    prepare,
    batch: vi.fn(() => {
      throw new Error("unexpected write");
    }),
  } as unknown as D1Database;
}
async function reserved(time = now) {
  const id = `attention-fixture-${++sequence}`;
  const product = await db
    .prepare(
      "INSERT INTO products(name,slug,price_cents,quantity,category_id,status,created_at,updated_at) VALUES ('Fictional attention',?,999,999,1,'draft',1,1) RETURNING id",
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
        "INSERT INTO commerce_variants(id,product_id,sku,colour,size_description,price_cents,active) VALUES (?,?,?,'Gold-tone','Fictional',2500,1)",
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
    time,
  );
  const quote = await createTestQuote(
    db,
    ownerHash,
    [{ variantId: id, quantity: 1 }],
    "pickup",
    time,
  );
  const order = await reserveTestOrder(db, ownerHash, quote.id, time);
  return { order };
}
async function claimed(provider: "stripe" | "paypal" = "stripe", time = now) {
  const item = await reserved(time);
  const context = {
    ...trusted,
    provider,
    accountRef: `fixture-${provider}`,
    workerId: crypto.randomUUID(),
  };
  const started = await beginTestPaymentAttempt(
    db,
    {
      mode: context.mode,
      instanceId,
      provider,
      accountRef: context.accountRef,
      ownerHash,
    },
    {
      requestId: crypto.randomUUID(),
      reference: item.order.id,
      expectedVersion: 1,
    },
    time + 1,
  );
  const claim = await claimTestPaymentWork(
    db,
    context,
    {
      claimId: crypto.randomUUID(),
      requestId: started.requestId,
      expectedVersion: 1,
    },
    time + 2,
  );
  return { ...item, context, started, claim, time };
}
type Item = Awaited<ReturnType<typeof claimed>>;
function capture(item: Item): TestCaptureFactInput {
  return {
    requestId: item.started.requestId,
    claimId: item.claim.claimId,
    providerObjectRef: `fixture-object-${crypto.randomUUID()}`,
    transactionRef: `fixture-transaction-${crypto.randomUUID()}`,
    amountCents: 2500,
    currency: "CAD",
  };
}
async function observation(
  item: Item,
  fact = capture(item),
  kind: TestPaymentObservationInput["kind"] = "captured",
) {
  const input: TestPaymentObservationInput = {
    observationId: crypto.randomUUID(),
    requestId: fact.requestId,
    claimId: fact.claimId,
    kind,
    providerObjectRef: fact.providerObjectRef,
    capture:
      kind === "captured"
        ? {
            transactionRef: fact.transactionRef,
            amountCents: fact.amountCents,
            currency: fact.currency,
          }
        : null,
  };
  await recordTestPaymentObservation(db, item.context, input, item.time + 3);
  return input;
}
function processObservation(item: Item, input: TestPaymentObservationInput) {
  return processTestPaymentObservation(
    db,
    {
      mode: "local-test",
      instanceId,
      provider: item.context.provider,
      accountRef: item.context.accountRef,
    },
    { observationId: input.observationId },
    item.time + 4,
  );
}
async function find(
  item: Item,
  time = now + 10,
): Promise<TestPaymentAttentionItem | undefined> {
  let cursor: string | null = null;
  do {
    const page = await list(time, db, cursor);
    const value = page.items.find((row) => row.reference === item.order.id);
    if (value) return value;
    cursor = page.nextCursor;
  } while (cursor);
}
async function table(name: string) {
  return (await db.prepare(`SELECT * FROM ${name} ORDER BY 1,2`).all()).results;
}
async function snapshot() {
  return Promise.all(
    [
      "commerce_orders",
      "commerce_quotes",
      "commerce_order_lines",
      "commerce_stock_movements",
      "commerce_inventory",
      "commerce_commands",
      "commerce_payment_scope",
      "commerce_payment_attempts",
      "commerce_payment_work",
      "commerce_payment_work_claims",
      "commerce_payment_capture_facts",
      "commerce_payment_observations",
      "commerce_payment_observation_results",
    ].map(table),
  );
}
function cursor(value: unknown) {
  return btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
async function relaxedTrigger(name: string, action: () => Promise<void>) {
  const row = await db
    .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?")
    .bind(name)
    .first<{ sql: string }>();
  await db.prepare(`DROP TRIGGER ${name}`).run();
  try {
    await action();
  } finally {
    await db.prepare(row!.sql).run();
  }
}
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "jewelry-payment-attention-"));
  const configPath = join(directory, "wrangler.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "fictional-payment-attention-test",
      compatibility_date: "2026-09-29",
      d1_databases: [
        {
          binding: "DB",
          database_name: "fictional-payment-attention-test",
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
      timeout: 20_000,
    },
  );
  platform = await getPlatformProxy<Env>({
    configPath,
    envFiles: [],
    persist: { path: join(directory, "state/v3") },
    remoteBindings: false,
  });
  db = platform.env.DB;
  absentScopeReads = [];
  await expect(
    list(
      now,
      adapter((sql) => {
        absentScopeReads.push(sql);
        return db.prepare(sql);
      }),
    ),
  ).rejects.toMatchObject({ code: "unavailable" });
  await db
    .prepare(
      "INSERT INTO commerce_payment_scope(id,mode,instance_id,stripe_account_ref,paypal_account_ref) VALUES (1,'local-test',?,'fixture-stripe','fixture-paypal')",
    )
    .bind(instanceId)
    .run();
}, 30000);
afterAll(async () => {
  await platform?.dispose();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("internal current payment attention on real temporary D1", () => {
  it("fails closed on absent/mismatched/invalid scope before reading orders", async () => {
    expect(absentScopeReads).toHaveLength(1);
    expect(absentScopeReads[0]).toContain("commerce_payment_scope");
    const reads: string[] = [];
    const database = adapter((sql) => {
      reads.push(sql);
      return db.prepare(sql);
    });
    await expect(
      listTestPaymentAttention(
        database,
        { ...trusted, instanceId: otherInstance },
        { cursor: null },
        now,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(reads).toHaveLength(1);
    const bad = adapter(
      () =>
        ({
          first: async () => ({
            mode: "local-test",
            instance_id: instanceId,
            stripe_account_ref: "live-account",
            paypal_account_ref: "fixture-paypal",
          }),
        }) as D1PreparedStatement,
    );
    await expect(list(now, bad)).rejects.toMatchObject({ code: "unavailable" });
  });
  it("rejects malformed own-data inputs, clocks and noncanonical cursors without DB reads", async () => {
    const prepare = vi.fn(() => {
      throw new Error("must not read");
    });
    const database = adapter(prepare);
    const getter = vi.fn(() => null);
    const badInput = Object.defineProperty({}, "cursor", {
      enumerable: true,
      get: getter,
    }) as TestPaymentAttentionInput;
    const inputs: TestPaymentAttentionInput[] = [
      badInput,
      { cursor: null, extra: true } as TestPaymentAttentionInput,
      ...[
        "",
        "=",
        "a".repeat(193),
        "e30",
        cursor({ createdAt: now, orderId: "order-bad" }),
        cursor({
          createdAt: now + 0.5,
          orderId: `order-${crypto.randomUUID()}`,
        }),
        cursor({ orderId: `order-${crypto.randomUUID()}`, createdAt: now }),
        cursor({
          createdAt: now,
          orderId: `order-${crypto.randomUUID()}`,
          extra: true,
        }),
      ].map((cursor) => ({ cursor })),
    ];
    for (const input of inputs)
      await expect(
        listTestPaymentAttention(database, trusted, input, now),
      ).rejects.toMatchObject({ code: "invalid_request" });
    for (const time of [NaN, -1, 1.5, Infinity, 8_640_000_000_000_001])
      await expect(
        listTestPaymentAttention(database, trusted, { cursor: null }, time),
      ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      listTestPaymentAttention(
        database,
        { ...trusted, mode: "live" } as unknown as TestPaymentAttentionContext,
        { cursor: null },
        now,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(prepare).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(["stripe", "paypal"] as const)(
    "shows current %s unprocessed and mismatched amounts/currencies before and after processing",
    async (provider) => {
      const item = await claimed(provider);
      const fact = { ...capture(item), currency: "USD" };
      const o = await observation(item, fact);
      expect(await find(item)).toMatchObject({
        captureFactCount: 0,
        unprocessedObservationCount: 1,
        mismatchedObservationCount: 1,
        reasons: ["unprocessed_observations", "amount_mismatch"],
      });
      await processObservation(item, o);
      expect(await find(item)).toMatchObject({
        captureFactCount: 1,
        mismatchedFactCount: 1,
        unprocessedObservationCount: 0,
        mismatchedObservationCount: 1,
        reasons: ["amount_mismatch"],
      });
      const duplicate = await observation(item, fact);
      await processObservation(item, duplicate);
      expect(await find(item)).toMatchObject({
        captureFactCount: 1,
        mismatchedObservationCount: 2,
        reasons: ["amount_mismatch"],
      });
      const conflict = await observation(item, { ...fact, amountCents: 2499 });
      await processObservation(item, conflict);
      expect(await find(item)).toMatchObject({
        captureFactCount: 1,
        captureConflictCount: 1,
        mismatchedObservationCount: 3,
        reasons: ["capture_conflict", "amount_mismatch"],
      });
    },
  );
  it.each(["stripe", "paypal"] as const)(
    "includes mismatched %s capture API facts without any observation",
    async (provider) => {
      const item = await claimed(provider);
      await recordTestCaptureFact(
        db,
        item.context,
        { ...capture(item), amountCents: 2499 },
        now + 3,
      );
      expect(await find(item)).toMatchObject({
        captureFactCount: 1,
        mismatchedFactCount: 1,
        mismatchedObservationCount: 0,
        unprocessedObservationCount: 0,
        reasons: ["amount_mismatch"],
      });
    },
  );
  it("uses current distinct economic facts while keeping historical processing receipts unchanged", async () => {
    const item = await claimed();
    const first = await observation(item);
    expect(await processObservation(item, first)).toMatchObject({
      additionalCaptureAtProcessing: false,
    });
    expect(await find(item)).toBeUndefined();
    const second = await observation(item);
    await processObservation(item, second);
    expect(await processObservation(item, first)).toMatchObject({
      additionalCaptureAtProcessing: false,
      replayed: true,
    });
    expect(await find(item)).toMatchObject({
      captureFactCount: 2,
      reasons: ["additional_captures"],
    });
    const unrelated = await claimed("paypal");
    await processObservation(unrelated, await observation(unrelated));
    expect(await find(unrelated)).toBeUndefined();
  });
  it("refreshes noncapture observations without last-wins order/payment changes", async () => {
    const item = await claimed();
    const o = await observation(item, capture(item), "reported_failed");
    expect(await find(item)).toMatchObject({
      reasons: ["unprocessed_observations"],
    });
    await processObservation(item, o);
    expect(await find(item)).toBeUndefined();
    expect(await find(item, item.order.reserveUntil)).toMatchObject({
      paymentState: "processing",
      orderState: "pending_payment",
      reasons: ["expired_without_capture"],
    });
  });
  it("includes only attempted orders at the exact expiry boundary, without mutating business state", async () => {
    const item = await claimed();
    const unattempted = await reserved();
    expect(await find(item, item.order.reserveUntil - 1)).toBeUndefined();
    const before = await snapshot();
    const statements: string[] = [];
    const page = await list(
      item.order.reserveUntil,
      adapter((sql) => {
        statements.push(sql);
        return db.prepare(sql);
      }),
    );
    expect(
      page.items.find((row) => row.reference === item.order.id),
    ).toMatchObject({
      captureFactCount: 0,
      reasons: ["expired_without_capture"],
    });
    expect(
      page.items.find((row) => row.reference === unattempted.order.id),
    ).toBeUndefined();
    expect(statements).toHaveLength(2);
    expect(statements.every((sql) => /^SELECT|^WITH/.test(sql))).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect(page).toMatchObject({
      testOnly: true,
      checkedAt: item.order.reserveUntil,
    });
    expect(Object.keys(page.items[0]).sort()).toEqual(
      [
        "reference",
        "createdAt",
        "reserveUntil",
        "orderState",
        "paymentState",
        "fulfillmentState",
        "version",
        "captureFactCount",
        "mismatchedFactCount",
        "unprocessedObservationCount",
        "captureConflictCount",
        "mismatchedObservationCount",
        "reasons",
      ].sort(),
    );
    expect(JSON.stringify(page)).not.toMatch(
      /fixture-|owner|worker|account|transaction|payload|snapshot|email|address|totalCents|amountCents|factId|claimId/,
    );
  });
  it("uses a stable 25+1 keyset across equal creation times and snapshots mutable input before awaits", async () => {
    const items: Item[] = [];
    for (let i = 0; i < 28; i++)
      items.push(await claimed(i % 2 ? "paypal" : "stripe", now + 100));
    const time = now + 1_000_000;
    const all: TestPaymentAttentionItem[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const page = await list(time, db, after);
      expect(page.items.length).toBeLessThanOrEqual(25);
      if (page.nextCursor) expect(page.items).toHaveLength(25);
      all.push(...page.items);
      after = page.nextCursor;
      pages++;
    } while (after);
    expect(pages).toBeGreaterThan(1);
    expect(new Set(all.map((row) => row.reference)).size).toBe(all.length);
    expect(all.map((row) => [row.createdAt, row.reference])).toEqual(
      [...all]
        .sort(
          (a, b) =>
            a.createdAt - b.createdAt || a.reference.localeCompare(b.reference),
        )
        .map((row) => [row.createdAt, row.reference]),
    );
    for (const item of items)
      expect(all.filter((row) => row.reference === item.order.id)).toHaveLength(
        1,
      );
    const first = await list(time);
    const context = { ...trusted };
    const input = { cursor: first.nextCursor };
    const database = adapter((sql) => {
      const statement = db.prepare(sql);
      if (sql.includes("commerce_payment_scope"))
        return {
          first: async () => {
            context.instanceId = otherInstance;
            input.cursor = "invalid";
            return statement.first();
          },
        } as D1PreparedStatement;
      return statement;
    });
    expect(
      await listTestPaymentAttention(database, context, input, time),
    ).toEqual(await list(time, db, first.nextCursor));
    const last = all.at(-1)!;
    expect(
      await list(
        time,
        db,
        cursor({ createdAt: last.createdAt, orderId: last.reference }),
      ),
    ).toMatchObject({ items: [], nextCursor: null });
  }, 20000);
  it("counts across both providers/attempts in a disposable diagnostic fixture and excludes other instances", async () => {
    const first = await claimed();
    const second = await claimed("paypal");
    await processObservation(first, await observation(first));
    await processObservation(second, await observation(second));
    await db
      .prepare("DROP INDEX commerce_payment_attempts_one_per_order")
      .run();
    try {
      await relaxedTrigger("commerce_payment_attempts_no_update", async () => {
        try {
          await db
            .prepare(
              "UPDATE commerce_payment_attempts SET order_id=? WHERE command_id=?",
            )
            .bind(first.order.id, `payment-start-${second.started.requestId}`)
            .run();
          expect(await find(first)).toMatchObject({
            captureFactCount: 2,
            reasons: ["additional_captures"],
          });
          expect(await find(second)).toBeUndefined();
          await db
            .prepare(
              "UPDATE commerce_payment_attempts SET instance_id=? WHERE command_id=?",
            )
            .bind(otherInstance, `payment-start-${second.started.requestId}`)
            .run();
          expect(await find(first)).toBeUndefined();
        } finally {
          await db
            .prepare(
              "UPDATE commerce_payment_attempts SET order_id=?,instance_id=? WHERE command_id=?",
            )
            .bind(
              second.order.id,
              instanceId,
              `payment-start-${second.started.requestId}`,
            )
            .run();
        }
      });
    } finally {
      await db
        .prepare(
          "CREATE UNIQUE INDEX commerce_payment_attempts_one_per_order ON commerce_payment_attempts(order_id)",
        )
        .run();
    }
  });
  it("joins each fact and observation to its original environment/account rather than only attempt ID", async () => {
    const item = await claimed();
    const o = await observation(item, { ...capture(item), amountCents: 2499 });
    await processObservation(item, o);
    await relaxedTrigger("commerce_capture_facts_no_update", async () => {
      await relaxedTrigger(
        "commerce_payment_observations_no_update",
        async () => {
          try {
            await db
              .prepare(
                "UPDATE commerce_payment_capture_facts SET instance_id=? WHERE attempt_command_id=?",
              )
              .bind(otherInstance, `payment-start-${item.started.requestId}`)
              .run();
            await db
              .prepare(
                "UPDATE commerce_payment_observations SET account_ref='fixture-other' WHERE observation_id=?",
              )
              .bind(o.observationId)
              .run();
            expect(await find(item)).toBeUndefined();
          } finally {
            await db
              .prepare(
                "UPDATE commerce_payment_capture_facts SET instance_id=? WHERE attempt_command_id=?",
              )
              .bind(instanceId, `payment-start-${item.started.requestId}`)
              .run();
            await db
              .prepare(
                "UPDATE commerce_payment_observations SET account_ref=? WHERE observation_id=?",
              )
              .bind(item.context.accountRef, o.observationId)
              .run();
          }
        },
      );
    });
  });
  it("returns generic unavailable on missing migrations, read failure, partial metadata and malformed rows", async () => {
    const secret = "private SQL payload";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failPrepare = adapter(() => {
        throw new Error(secret);
      });
      await expect(list(now, failPrepare)).rejects.toMatchObject({
        code: "unavailable",
        message: "Local test payment attention could not be confirmed",
      });
      for (const result of [
        { success: false, results: [] },
        { success: true, results: [{ reference: "bad" }] },
        { success: true, results: Array(27).fill({}) },
      ]) {
        const database = adapter((sql) =>
          sql.includes("commerce_payment_scope")
            ? db.prepare(sql)
            : ({
                bind() {
                  return this;
                },
                all: async () => result,
              } as D1PreparedStatement),
        );
        await expect(list(now, database)).rejects.toMatchObject({
          code: "unavailable",
        });
      }
      const failedScope = adapter(
        () =>
          ({
            first: async () => {
              throw new Error(secret);
            },
          }) as unknown as D1PreparedStatement,
      );
      await expect(list(now, failedScope)).rejects.toMatchObject({
        code: "unavailable",
      });
      const failedRead = adapter((sql) =>
        sql.includes("commerce_payment_scope")
          ? db.prepare(sql)
          : ({
              bind() {
                return this;
              },
              all: async () => {
                throw new Error(secret);
              },
            } as unknown as D1PreparedStatement),
      );
      await expect(list(now, failedRead)).rejects.toMatchObject({
        code: "unavailable",
      });
      const missing = adapter((sql) =>
        sql.includes("commerce_payment_scope")
          ? db.prepare(sql)
          : db.prepare("SELECT * FROM absent_payment_attention_migration"),
      );
      await expect(list(now, missing)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
