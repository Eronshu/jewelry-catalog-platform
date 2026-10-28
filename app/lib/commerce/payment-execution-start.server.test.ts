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
import { createTestQuote, reserveTestOrder } from "./orders.server";
import { beginTestPaymentAttempt } from "./payment-start.server";
import { claimTestPaymentWork } from "./payment-work.server";
import { recordTestCaptureFact } from "./capture-facts.server";
import {
  recordTestPaymentObservation,
  type TestPaymentObservationInput,
} from "./payment-observations.server";
import { processTestPaymentObservation } from "./observation-processing.server";
import {
  registerTestPaymentExecution,
  type TestPaymentExecutionContext,
  type TestPaymentExecutionInput,
} from "./payment-execution-start.server";

const root = resolve(process.cwd());
const now = 1_800_000_000_000;
const instanceId = "11111111-1111-4111-8111-111111111111";
const workerId = "22222222-2222-4222-8222-222222222222";
const ownerHash = "a".repeat(64);
const trusted: TestPaymentExecutionContext = {
  mode: "local-test",
  instanceId,
  provider: "stripe",
  accountRef: "fixture-stripe",
  workerId,
};
const dummy: TestPaymentExecutionInput = {
  claimId: crypto.randomUUID(),
  requestId: crypto.randomUUID(),
  expectedVersion: 2,
};
let directory: string;
let configPath: string;
let platform: PlatformProxy<Env>;
let db: D1Database;
let sequence = 0;
let oldHistory: unknown;
let oldAfter: unknown;
let absentReads: string[];
let upgradedEmpty: unknown;
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
      timeout: 20_000,
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
function facade(
  prepare: D1Database["prepare"] = db.prepare.bind(db),
  batch: (statements: D1PreparedStatement[]) => Promise<unknown> = (
    statements,
  ) => db.batch(statements),
): D1Database {
  return {
    prepare,
    async batch<T>(statements: D1PreparedStatement[]) {
      return (await batch(statements)) as D1Result<T>[];
    },
  } as D1Database;
}
async function history() {
  const names = (
    await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'commerce_%' AND name<>'commerce_payment_execution_starts' ORDER BY name",
      )
      .all<{ name: string }>()
  ).results;
  const rows = await Promise.all(
    names.map(async ({ name }) => [
      name,
      (await db.prepare(`SELECT * FROM ${name} ORDER BY 1,2`).all()).results,
    ]),
  );
  return Object.fromEntries(rows);
}
async function claimed(
  provider: "stripe" | "paypal" = "stripe",
  time = now,
  claimTime = time + 2,
) {
  const id = `execution-fixture-${++sequence}`;
  const product = await db
    .prepare(
      "INSERT INTO products(name,slug,price_cents,quantity,category_id,status,created_at,updated_at) VALUES ('Fictional execution fixture',?,999,99,1,'draft',1,1) RETURNING id",
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
  const context = { ...trusted, provider, accountRef: `fixture-${provider}` };
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
      reference: order.id,
      expectedVersion: order.version,
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
    claimTime,
  );
  const input = {
    claimId: claim.claimId,
    requestId: started.requestId,
    expectedVersion: 2,
  };
  return { id, context, input, started, claim, order, quote, time };
}
type Item = Awaited<ReturnType<typeof claimed>>;
const register = (item: Item, time = item.time + 3, database = db) =>
  registerTestPaymentExecution(database, item.context, item.input, () => time);
async function capture(item: Item) {
  return recordTestCaptureFact(
    db,
    item.context,
    {
      claimId: item.claim.claimId,
      requestId: item.started.requestId,
      providerObjectRef: `fixture-object-${item.id}`,
      transactionRef: `fixture-transaction-${item.id}`,
      amountCents: 2500,
      currency: "CAD",
    },
    item.time + 4,
  );
}
async function observation(
  item: Item,
  kind: TestPaymentObservationInput["kind"] = "not_found",
  process = false,
) {
  const input: TestPaymentObservationInput = {
    observationId: crypto.randomUUID(),
    requestId: item.started.requestId,
    claimId: item.claim.claimId,
    kind,
    providerObjectRef: ["unknown", "not_found"].includes(kind)
      ? null
      : `fixture-object-${item.id}`,
    capture:
      kind === "captured"
        ? {
            transactionRef: `fixture-observed-${item.id}`,
            amountCents: 2500,
            currency: "CAD",
          }
        : null,
  };
  await recordTestPaymentObservation(db, item.context, input, item.time + 4);
  if (process) {
    const { workerId: _, ...context } = item.context;
    void _;
    await processTestPaymentObservation(
      db,
      context,
      { observationId: input.observationId },
      item.time + 5,
    );
  }
  return input;
}
async function replacement(item: Item, time = item.claim.leaseUntil) {
  const context = { ...item.context, workerId: crypto.randomUUID() };
  const claim = await claimTestPaymentWork(
    db,
    context,
    {
      claimId: crypto.randomUUID(),
      requestId: item.started.requestId,
      expectedVersion: item.input.expectedVersion,
    },
    time,
  );
  return {
    ...item,
    context,
    claim,
    input: {
      ...item.input,
      claimId: claim.claimId,
      expectedVersion: claim.resultingVersion,
    },
  };
}
async function count(item: Item) {
  return (await db
    .prepare(
      "SELECT count(*) AS n FROM commerce_payment_execution_starts WHERE claim_id=?",
    )
    .bind(item.input.claimId)
    .first<{ n: number }>())!.n;
}
function insert(item: Item, changes: Record<string, unknown> = {}) {
  const row = {
    claim_id: item.input.claimId,
    attempt_command_id: `payment-start-${item.started.requestId}`,
    worker_id: item.context.workerId,
    mode: item.context.mode,
    instance_id: instanceId,
    provider: item.context.provider,
    account_ref: item.context.accountRef,
    expected_work_version: item.input.expectedVersion,
    operation: item.claim.operation,
    request_hash: "a".repeat(64),
    started_at: item.time + 3,
    ...changes,
  };
  return db
    .prepare(
      `INSERT INTO commerce_payment_execution_starts (${Object.keys(row).join(",")}) VALUES (${Object.keys(
        row,
      )
        .map(() => "?")
        .join(",")})`,
    )
    .bind(...Object.values(row));
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "commerce-execution-start-"));
  mkdirSync(join(directory, "migrations"));
  for (const name of readdirSync(join(root, "migrations")).filter(
    (name) => name.endsWith(".sql") && name < "0014_",
  ))
    copyFileSync(
      join(root, "migrations", name),
      join(directory, "migrations", name),
    );
  configPath = join(directory, "wrangler.json");
  writeFileSync(
    join(directory, "worker.js"),
    "export default {fetch(){return new Response('fixture')}};",
  );
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "commerce-execution-fixture",
      main: "worker.js",
      compatibility_date: "2026-10-01",
      d1_databases: [
        {
          binding: "DB",
          database_name: "fixture",
          database_id: "00000000-0000-0000-0000-000000000000",
          migrations_dir: "migrations",
        },
      ],
    }),
  );
  migrate();
  await connect();
  absentReads = [];
  await expect(
    registerTestPaymentExecution(
      facade((sql) => {
        absentReads.push(sql);
        return db.prepare(sql);
      }),
      trusted,
      dummy,
      () => now,
    ),
  ).rejects.toMatchObject({ code: "unavailable" });
  await db
    .prepare(
      "INSERT INTO commerce_payment_scope(id,mode,instance_id,stripe_account_ref,paypal_account_ref) VALUES (1,'local-test',?,'fixture-stripe','fixture-paypal')",
    )
    .bind(instanceId)
    .run();
  const old = await claimed("paypal");
  await observation(old, "captured", true);
  oldHistory = await history();
  await platform.dispose();
  copyFileSync(
    join(root, "migrations/0014_commerce_payment_execution_starts.sql"),
    join(directory, "migrations/0014_commerce_payment_execution_starts.sql"),
  );
  migrate();
  await connect();
  oldAfter = await history();
  upgradedEmpty = (
    await db.prepare("SELECT * FROM commerce_payment_execution_starts").all()
  ).results;
}, 30_000);
afterAll(async () => {
  await platform?.dispose();
  if (directory) rmSync(directory, { recursive: true, force: true });
}, 10_000);

describe("internal synthetic execution starts on real D1", () => {
  it("upgrades 0013 without changing history or seeding starts and fails scope closed first", async () => {
    expect(oldAfter).toEqual(oldHistory);
    expect(upgradedEmpty).toEqual([]);
    expect(absentReads).toHaveLength(1);
    expect(absentReads[0]).toContain("commerce_payment_scope");
    const reads: string[] = [];
    await expect(
      registerTestPaymentExecution(
        facade((sql) => {
          reads.push(sql);
          return db.prepare(sql);
        }),
        { ...trusted, instanceId: crypto.randomUUID() },
        dummy,
        () => now,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(reads).toHaveLength(1);
  });
  it.each(["stripe", "paypal"] as const)(
    "records one %s start and preserves minimal original receipt and all business state",
    async (provider) => {
      const item = await claimed(provider);
      const before = await history();
      const result = await register(item);
      expect(result).toEqual({
        testOnly: true,
        claimId: item.input.claimId,
        requestId: item.started.requestId,
        reference: item.order.id,
        provider,
        operation: "create",
        expectedVersion: 2,
        startedAt: now + 3,
        replayed: false,
      });
      expect(await register(item, item.claim.leaseUntil + 1000)).toEqual({
        ...result,
        replayed: true,
      });
      expect(await count(item)).toBe(1);
      expect(await history()).toEqual(before);
      expect(JSON.stringify(result)).not.toMatch(
        /fixture-|owner|worker|account|hash|amount|currency|key|snapshot|mayDispatch/,
      );
    },
  );
  it("allows only one fresh registrar for identical concurrent invocations", async () => {
    const item = await claimed();
    const results = await Promise.all([register(item), register(item)]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(await count(item)).toBe(1);
  });
  it("requires original proof even for historical replay and snapshots inputs before awaits", async () => {
    const item = await claimed();
    await register(item);
    for (const context of [
      { ...item.context, workerId: crypto.randomUUID() },
      {
        ...item.context,
        provider: "paypal" as const,
        accountRef: "fixture-paypal",
      },
    ])
      await expect(
        registerTestPaymentExecution(db, context, item.input, () => now + 3),
      ).rejects.toMatchObject({ code: "conflict" });
    for (const input of [
      { ...item.input, requestId: crypto.randomUUID() },
      { ...item.input, expectedVersion: 3 },
      { ...item.input, expectedVersion: Number.MAX_SAFE_INTEGER },
    ])
      await expect(
        registerTestPaymentExecution(db, item.context, input, () => now + 3),
      ).rejects.toMatchObject({ code: "conflict" });
    const fresh = await claimed();
    const context = { ...fresh.context };
    const input = { ...fresh.input };
    const database = facade((sql) => {
      if (sql.includes("FROM commerce_payment_scope")) {
        context.workerId = crypto.randomUUID();
        input.claimId = crypto.randomUUID();
      }
      return db.prepare(sql);
    });
    expect(
      await registerTestPaymentExecution(
        database,
        context,
        input,
        () => now + 3,
      ),
    ).toMatchObject({ claimId: fresh.input.claimId, replayed: false });
  });
  it("rejects malformed data, accessor inputs, versions and clocks without business reads", async () => {
    const prepare = vi.fn(() => {
      throw new Error("must not read");
    });
    const database = facade(prepare);
    const getter = vi.fn(() => dummy.claimId);
    const bad = Object.defineProperty({ ...dummy }, "claimId", {
      get: getter,
    }) as TestPaymentExecutionInput;
    for (const input of [
      bad,
      { ...dummy, extra: true } as TestPaymentExecutionInput,
      { ...dummy, expectedVersion: 1 },
      { ...dummy, expectedVersion: 2.5 },
      { ...dummy, expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
    ])
      await expect(
        registerTestPaymentExecution(database, trusted, input, () => now),
      ).rejects.toMatchObject({ code: "invalid_request" });
    for (const time of [NaN, -1, 0.5, Infinity, 8_640_000_000_000_001])
      await expect(
        registerTestPaymentExecution(database, trusted, dummy, () => time),
      ).rejects.toMatchObject({ code: "invalid_request" });
    expect(prepare).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });
  it("resamples after async preparation and rejects exact lease expiry and backwards clocks", async () => {
    const atBoundary = await claimed();
    await expect(
      register(atBoundary, atBoundary.claim.leaseUntil),
    ).rejects.toMatchObject({ code: "conflict" });
    const late = await claimed();
    let time = now + 3;
    const database = facade((sql) => {
      const statement = db.prepare(sql);
      if (!sql.includes("FROM commerce_payment_scope")) return statement;
      return {
        async first<T>() {
          const value = await statement.first<T>();
          time = late.claim.leaseUntil;
          return value;
        },
      } as D1PreparedStatement;
    });
    await expect(
      registerTestPaymentExecution(
        database,
        late.context,
        late.input,
        () => time,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await count(late)).toBe(0);
    const rewind = await claimed();
    let samples = 0;
    await expect(
      registerTestPaymentExecution(db, rewind.context, rewind.input, () =>
        ++samples === 1 ? now + 5 : now + 4,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const early = await claimed();
    await expect(register(early, now + 1)).rejects.toMatchObject({
      code: "conflict",
    });
    const last = await claimed();
    expect(await register(last, last.claim.leaseUntil - 1)).toMatchObject({
      replayed: false,
    });
  });
  it("burns CREATE after registration/crash and only permits QUERY on a fresh replacement, even after expiry/capture", async () => {
    const item = await claimed("paypal");
    const first = await register(item);
    const next = await replacement(item, item.order.reserveUntil + 1);
    expect(next.claim.operation).toBe("query");
    expect(next.claim.createOperationKey).toBe(item.claim.createOperationKey);
    expect(await register(item, next.claim.claimedAt)).toEqual({
      ...first,
      replayed: true,
    });
    await capture(item); // Valid historical worker evidence remains accepted.
    expect(await register(next, next.claim.claimedAt + 1)).toMatchObject({
      operation: "query",
      replayed: false,
      expectedVersion: 3,
    });
    expect(await register(next, next.claim.leaseUntil + 1)).toMatchObject({
      replayed: true,
    });
    expect(await count(item)).toBe(1);
    expect(await count(next)).toBe(1);
    const stale = await claimed();
    await replacement(stale);
    await expect(register(stale, stale.claim.leaseUntil)).rejects.toMatchObject(
      { code: "conflict" },
    );
  });
  it.each([
    "unknown",
    "not_found",
    "pending",
    "approved",
    "reported_failed",
    "captured",
  ] as const)(
    "blocks CREATE for prior %s observations, including processed ones",
    async (kind) => {
      const item = await claimed();
      await observation(item, kind, true);
      await expect(register(item, now + 6)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(await count(item)).toBe(0);
    },
  );
  it("rechecks CREATE prerequisites in the write and retains later evidence without reversing registration", async () => {
    const fact = await claimed();
    await capture(fact);
    await expect(register(fact, now + 5)).rejects.toMatchObject({
      code: "unavailable",
    });
    const race = await claimed();
    const database = facade(undefined, async (statements) => {
      await observation(race, "not_found");
      return db.batch(statements);
    });
    await expect(register(race, now + 5, database)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(await count(race)).toBe(0);
    const replaced = await claimed();
    await expect(
      register(
        replaced,
        now + 5,
        facade(undefined, async (statements) => {
          await replacement(replaced);
          return db.batch(statements);
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await count(replaced)).toBe(0);
    const later = await claimed();
    const receipt = await register(later);
    await observation(later, "captured", true);
    expect(await register(later, now + 6)).toEqual({
      ...receipt,
      replayed: true,
    });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS n FROM commerce_payment_capture_facts WHERE attempt_command_id=?",
        )
        .bind(`payment-start-${later.started.requestId}`)
        .first(),
    ).toEqual({ n: 1 });
  });
  it.each([
    "lost-response",
    "zero-changes",
    "missing-metadata",
    "empty-results",
  ])(
    "treats %s after a committed write as historical, never fresh",
    async (mode) => {
      const item = await claimed();
      const database = facade(undefined, async (statements) => {
        const results = await db.batch(statements);
        if (mode === "lost-response") throw new Error("write response lost");
        if (mode === "empty-results") return [];
        return results.map((result) => ({
          ...result,
          meta:
            mode === "missing-metadata"
              ? undefined
              : { ...result.meta, changes: 0 },
        }));
      });
      expect(await register(item, now + 3, database)).toMatchObject({
        replayed: true,
      });
      expect(await register(item)).toMatchObject({ replayed: true });
      expect(await count(item)).toBe(1);
    },
  );
  it("does not grant freshness after no write, readback loss or storage failure", async () => {
    const none = await claimed();
    await expect(
      register(
        none,
        now + 3,
        facade(undefined, async () => [
          { success: true, meta: { changes: 0 } },
        ]),
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await count(none)).toBe(0);
    const lost = await claimed();
    let committed = false;
    const database = facade(
      (sql) => {
        if (committed && sql.includes("FROM commerce_payment_execution_starts"))
          throw new Error("private SQL and payload");
        return db.prepare(sql);
      },
      async (statements) => {
        const result = await db.batch(statements);
        committed = true;
        return result;
      },
    );
    await expect(register(lost, now + 3, database)).rejects.toMatchObject({
      code: "unavailable",
      message:
        "Local test payment execution registration could not be confirmed",
    });
    expect(await register(lost)).toMatchObject({ replayed: true });
    const broken = await claimed();
    await expect(
      register(
        broken,
        now + 3,
        facade(undefined, async () => {
          throw new Error("private SQL");
        }),
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await count(broken)).toBe(0);
  });
  it("rejects NULL, wrong binding/type/version/time and changed order state through direct SQL", async () => {
    const item = await claimed();
    const bad: Record<string, unknown>[] = [
      { worker_id: null },
      { mode: null },
      { expected_work_version: null },
      { operation: null },
      { started_at: null },
      { worker_id: crypto.randomUUID() },
      { instance_id: crypto.randomUUID() },
      { account_ref: "fixture-other" },
      { provider: "paypal" },
      { expected_work_version: 1 },
      { expected_work_version: 3 },
      { expected_work_version: 2.5 },
      { operation: "query" },
      { request_hash: "bad" },
      { started_at: now + 1 },
      { started_at: item.claim.leaseUntil },
      { started_at: now + 3.5 },
    ];
    for (const change of bad)
      await expect(insert(item, change).run()).rejects.toThrow();
    await db
      .prepare("UPDATE commerce_orders SET fulfillment='held' WHERE id=?")
      .bind(item.order.id)
      .run();
    await expect(insert(item).run()).rejects.toThrow();
    expect(await count(item)).toBe(0);
  });
  it("guards quote expiry, immutable starts, REPLACE and batch rollback without changing prior history", async () => {
    const old = await claimed("stripe", now, now + 600_000 - 10);
    // The first CREATE lease remains live when the independently shorter quote expires.
    await expect(
      insert(old, { started_at: old.quote.quote.expiresAt }).run(),
    ).rejects.toThrow();
    await expect(
      register(old, old.quote.quote.expiresAt),
    ).rejects.toMatchObject({ code: "unavailable" });
    const near = await replacement(old, old.order.reserveUntil + 1);
    expect(await register(near, near.claim.claimedAt + 1)).toMatchObject({
      operation: "query",
    });
    const item = await claimed();
    const before = await history();
    await register(item);
    for (const sql of [
      "UPDATE commerce_payment_execution_starts SET started_at=started_at+1 WHERE claim_id=?",
      "DELETE FROM commerce_payment_execution_starts WHERE claim_id=?",
    ])
      await expect(
        db.prepare(sql).bind(item.input.claimId).run(),
      ).rejects.toThrow();
    const original = insert(item);
    await expect(original.run()).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT OR REPLACE INTO commerce_payment_execution_starts SELECT * FROM commerce_payment_execution_starts WHERE claim_id=?",
        )
        .bind(item.input.claimId)
        .run(),
    ).rejects.toThrow();
    expect(await history()).toEqual(before);
    const rollback = await claimed();
    const snapshot = await history();
    await expect(
      db.batch([
        insert(rollback),
        db.prepare(
          "INSERT INTO commerce_payment_scope SELECT * FROM commerce_payment_scope",
        ),
      ]),
    ).rejects.toThrow();
    expect(await count(rollback)).toBe(0);
    expect(await history()).toEqual(snapshot);
  });
});
