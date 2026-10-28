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
import { recordTestPaymentObservation } from "./payment-observations.server";
import {
  registerTestPaymentExecution,
  type TestPaymentExecutionContext,
  type TestPaymentExecutionInput,
} from "./payment-execution-start.server";
import { executeTestPaymentWork } from "./payment-executor.server";
import {
  createTestPaymentSimulator,
  type TestPaymentSimulator,
  type TestPaymentSimulatorKind,
} from "./payment-simulator.server";
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

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "commerce-executor-"));
  mkdirSync(join(directory, "migrations"));
  for (const name of readdirSync(join(root, "migrations")).filter((name) =>
    name.endsWith(".sql"),
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
      name: "commerce-executor-fixture",
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
  await db
    .prepare(
      "INSERT INTO commerce_payment_scope(id,mode,instance_id,stripe_account_ref,paypal_account_ref) VALUES (1,'local-test',?,'fixture-stripe','fixture-paypal')",
    )
    .bind(instanceId)
    .run();
}, 30_000);
afterAll(async () => {
  await platform?.dispose();
  if (directory) rmSync(directory, { recursive: true, force: true });
}, 10_000);

const run = (
  item: Item,
  simulator: TestPaymentSimulator,
  time = item.time + 3,
  database = db,
) =>
  executeTestPaymentWork(
    database,
    item.context,
    item.input,
    simulator,
    () => time,
  );
async function rows(table: string) {
  return (await db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all())
    .results;
}
async function invariant() {
  const names = [
    "commerce_orders",
    "commerce_order_lines",
    "commerce_order_transitions",
    "commerce_inventory",
    "commerce_stock_movements",
    "commerce_payment_attempts",
    "commerce_payment_work",
    "commerce_payment_work_claims",
  ];
  return Object.fromEntries(
    await Promise.all(names.map(async (n) => [n, await rows(n)])),
  );
}
async function observations(item: Item) {
  return (
    await db
      .prepare(
        "SELECT * FROM commerce_payment_observations WHERE attempt_command_id=? ORDER BY recorded_at,observation_id",
      )
      .bind(`payment-start-${item.started.requestId}`)
      .all()
  ).results;
}
async function facts(item: Item) {
  return (
    await db
      .prepare(
        "SELECT * FROM commerce_payment_capture_facts WHERE attempt_command_id=?",
      )
      .bind(`payment-start-${item.started.requestId}`)
      .all()
  ).results;
}
const kinds: TestPaymentSimulatorKind[] = [
  "unknown",
  "not_found",
  "pending",
  "approved",
  "reported_failed",
  "captured",
];

describe("no-network fictional executor on real D1", () => {
  it.each(["stripe", "paypal"] as const)(
    "processes all six %s kinds without completing work, paying orders or moving inventory",
    async (provider) => {
      for (const kind of kinds) {
        const item = await claimed(provider);
        const before = await invariant();
        const fake = createTestPaymentSimulator([{ kind }]);
        const execute = vi.spyOn(fake, "execute");
        const result = await run(item, fake);
        expect(result).toEqual({
          testOnly: true,
          claimId: item.input.claimId,
          requestId: item.input.requestId,
          reference: item.order.id,
          status: "observation_processed",
          observationId: item.input.claimId,
          replayed: false,
        });
        expect(Object.keys(result).sort()).toEqual(
          [
            "testOnly",
            "claimId",
            "requestId",
            "reference",
            "status",
            "observationId",
            "replayed",
          ].sort(),
        );
        expect(execute).toHaveBeenCalledTimes(1);
        expect(execute.mock.calls[0][0]).toEqual({
          mode: "local-test",
          instanceId,
          provider,
          accountRef: `fixture-${provider}`,
          operation: "create",
          createOperationKey: item.claim.createOperationKey,
          amountCents: 2500,
          currency: "CAD",
        });
        expect((await observations(item))[0]).toMatchObject({ kind });
        expect(await facts(item)).toHaveLength(kind === "captured" ? 1 : 0);
        expect(await invariant()).toEqual(before);
        expect(await run(item, fake)).toMatchObject({
          replayed: true,
          status: "observation_processed",
        });
        expect(execute).toHaveBeenCalledTimes(1);
      }
    },
  );
  it("concurrent executor calls dispatch at most one CREATE; historical registrations cannot invoke adapter", async () => {
    const item = await claimed();
    const fake = createTestPaymentSimulator();
    const execute = vi.spyOn(fake, "execute");
    const results = await Promise.all([run(item, fake), run(item, fake)]);
    expect(
      results.every((x) =>
        ["query_required", "observation_processed"].includes(x.status),
      ),
    ).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await facts(item)).toHaveLength(1);
    const crash = await claimed();
    await registerTestPaymentExecution(
      db,
      crash.context,
      crash.input,
      () => now + 3,
    );
    expect(await run(crash, fake)).toMatchObject({
      replayed: true,
      status: "query_required",
      observationId: null,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const next = await replacement(crash);
    expect(next.claim.operation).toBe("query");
    expect(await run(next, fake, next.claim.claimedAt + 1)).toMatchObject({
      status: "observation_processed",
    });
    expect((await observations(next))[0]).toMatchObject({ kind: "not_found" });
    expect(await facts(next)).toHaveLength(0);
    expect(
      await db
        .prepare(
          "SELECT state,payment_state,fulfillment FROM commerce_orders WHERE id=?",
        )
        .bind(next.order.id)
        .first(),
    ).toEqual({
      state: "pending_payment",
      payment_state: "processing",
      fulfillment: "none",
    });
  });
  it.each(["stripe", "paypal"] as const)(
    "queries a committed %s capture after timeout and worker replacement without another charge",
    async (provider) => {
      const item = await claimed(provider);
      const fake = createTestPaymentSimulator([
        { kind: "captured", throwAfterCommit: true },
      ]);
      const execute = vi.spyOn(fake, "execute");
      await run(item, fake);
      expect((await observations(item))[0]).toMatchObject({
        kind: "unknown",
        transaction_ref: null,
      });
      expect(await facts(item)).toHaveLength(0);
      const next = await replacement(item);
      const before = await invariant();
      await run(next, fake, next.claim.claimedAt + 1);
      expect(execute.mock.calls.map((x) => x[0].operation)).toEqual([
        "create",
        "query",
      ]);
      expect(execute.mock.calls[0][0].createOperationKey).toBe(
        execute.mock.calls[1][0].createOperationKey,
      );
      expect(await facts(item)).toHaveLength(1);
      expect((await observations(item)).map((x) => x.kind)).toEqual([
        "unknown",
        "captured",
      ]);
      expect(await invariant()).toEqual(before);
      const another = await replacement(next, next.claim.leaseUntil);
      await run(another, fake, another.claim.claimedAt + 1);
      expect(await facts(item)).toHaveLength(1);
      const stable = await invariant();
      await run(another, fake, another.claim.claimedAt + 2);
      expect(await invariant()).toEqual(stable);
    },
  );
  it.each(["lease", "quote", "order", "replacement", "evidence", "fact"])(
    "rechecks %s after registration and retains the consumed opportunity",
    async (mutation) => {
      const item = await claimed("stripe", now, now + 600_000 - 10);
      let time = item.claim.claimedAt + 1;
      const fake = createTestPaymentSimulator();
      const execute = vi.spyOn(fake, "execute");
      const database = facade((sql) => {
        const statement = db.prepare(sql);
        if (!sql.includes("FROM commerce_payment_execution_starts e"))
          return statement;
        return {
          bind(...values: unknown[]) {
            const bound = statement.bind(...values);
            return {
              async first<T>() {
                if (mutation === "lease") time = item.claim.leaseUntil;
                if (mutation === "quote") time = item.quote.quote.expiresAt;
                if (mutation === "order")
                  await db
                    .prepare(
                      "UPDATE commerce_orders SET fulfillment='held' WHERE id=?",
                    )
                    .bind(item.order.id)
                    .run();
                if (mutation === "replacement") await replacement(item);
                if (mutation === "evidence")
                  await recordTestPaymentObservation(
                    db,
                    item.context,
                    {
                      observationId: crypto.randomUUID(),
                      claimId: item.claim.claimId,
                      requestId: item.started.requestId,
                      kind: "not_found",
                      providerObjectRef: null,
                      capture: null,
                    },
                    time,
                  );
                if (mutation === "fact")
                  await recordTestCaptureFact(
                    db,
                    item.context,
                    {
                      requestId: item.started.requestId,
                      claimId: item.claim.claimId,
                      providerObjectRef: "fixture-arrived-object",
                      transactionRef: `fixture-arrived-${item.claim.claimId}`,
                      amountCents: 2500,
                      currency: "CAD",
                    },
                    time,
                  );
                return bound.first<T>();
              },
            };
          },
        } as D1PreparedStatement;
      });
      expect(
        await executeTestPaymentWork(
          database,
          item.context,
          item.input,
          fake,
          () => time,
        ),
      ).toMatchObject({
        status: "query_required",
        observationId: null,
        replayed: false,
      });
      expect(execute).not.toHaveBeenCalled();
      expect(
        (await rows("commerce_payment_execution_starts")).filter(
          (x) => x.claim_id === item.claim.claimId,
        ),
      ).toHaveLength(1);
      expect(await run(item, fake, time)).toMatchObject({
        replayed: true,
        status: "query_required",
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it("keeps late capture evidence from an old worker without overwriting replacement work", async () => {
    const item = await claimed();
    let time = now + 3;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const pause = new Promise<void>((r) => {
      release = r;
    });
    const fake = createTestPaymentSimulator();
    const waiting: TestPaymentSimulator = {
      async execute(command) {
        const value = await fake.execute(command);
        entered();
        await pause;
        return value;
      },
    };
    const executing = executeTestPaymentWork(
      db,
      item.context,
      item.input,
      waiting,
      () => time,
    );
    await started;
    const next = await replacement(item);
    time = next.claim.claimedAt + 1;
    const before = await invariant();
    release();
    expect(await executing).toMatchObject({ status: "observation_processed" });
    expect(await facts(item)).toHaveLength(1);
    expect(await invariant()).toEqual(before);
    expect((await observations(item))[0]).toMatchObject({
      source_claim_id: item.claim.claimId,
      source_worker_id: item.context.workerId,
      recorded_at: time,
    });
  });
  it.each([
    "observation-response",
    "processing-response",
    "observation-readback",
    "processing-readback",
    "observation-no-write",
    "processing-no-write",
  ])("recovers %s without redispatch", async (fault) => {
    const item = await claimed();
    const fake = createTestPaymentSimulator();
    const execute = vi.spyOn(fake, "execute");
    let committed = false;
    const database = facade(
      (sql) => {
        if (
          committed &&
          ((fault === "observation-readback" &&
            sql.includes("FROM commerce_payment_observations WHERE")) ||
            (fault === "processing-readback" &&
              sql.includes(
                "SELECT * FROM commerce_payment_observation_results",
              )))
        )
          throw new Error("private lost read");
        return db.prepare(sql);
      },
      async (statements) => {
        // Registration is the first batch, observation second, processing third.
        calls++;
        const target = fault.startsWith("observation") ? 2 : 3;
        if (calls !== target) return db.batch(statements);
        if (fault.endsWith("no-write")) throw new Error("private no write");
        const result = await db.batch(statements);
        committed = true;
        if (fault.endsWith("response"))
          throw new Error("private lost response");
        return result;
      },
    );
    let calls = 0;
    const first = await run(item, fake, now + 3, database).catch(
      (error) => error,
    );
    if (fault.endsWith("readback") || fault.endsWith("no-write"))
      expect(first).toMatchObject({
        code: "unavailable",
        message: "Local test payment execution could not be confirmed",
      });
    else expect(first).toMatchObject({ status: "observation_processed" });
    const resumed = await run(item, fake, now + 4);
    expect(resumed).toMatchObject({
      replayed: true,
      status:
        fault === "observation-no-write"
          ? "query_required"
          : "observation_processed",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await facts(item)).toHaveLength(
      fault === "observation-no-write" ? 0 : 1,
    );
  });
  it.each(["stripe", "paypal"] as const)(
    "preserves actual %s capture amount and currency mismatches for investigation",
    async (provider) => {
      const item = await claimed(provider);
      const before = await invariant();
      await run(item, {
        async execute(command) {
          return {
            kind: "captured",
            providerObjectRef: `fixture-mismatch-${command.createOperationKey}`,
            capture: {
              transactionRef: `fixture-mismatch-capture-${command.createOperationKey}`,
              amountCents: 2510,
              currency: "USD",
            },
          };
        },
      });
      expect((await observations(item))[0]).toMatchObject({
        kind: "captured",
        amount_cents: 2510,
        currency: "USD",
      });
      expect((await facts(item))[0]).toMatchObject({
        actual_amount_cents: 2510,
        actual_currency: "USD",
        expected_amount_cents: 2500,
        expected_currency: "CAD",
        amount_match: "mismatch",
      });
      expect(await invariant()).toEqual(before);
    },
  );
  it("treats a lost registration acknowledgement as history with no simulator call", async () => {
    const item = await claimed();
    const fake = createTestPaymentSimulator();
    const execute = vi.spyOn(fake, "execute");
    const database = facade(undefined, async (statements) => {
      await db.batch(statements);
      throw new Error("private registration response lost");
    });
    expect(await run(item, fake, now + 3, database)).toMatchObject({
      status: "query_required",
      replayed: true,
    });
    expect(execute).not.toHaveBeenCalled();
  });
  it("normalizes malformed or rejected responses to unknown and exposes no private payload", async () => {
    for (const value of [
      { kind: "captured", providerObjectRef: "sk_private", capture: null },
      {
        kind: "captured",
        providerObjectRef: "fixture-object",
        capture: {
          transactionRef: "fixture-capture",
          amountCents: 1.1,
          currency: "CAD",
        },
      },
      {
        kind: "captured",
        providerObjectRef: "fixture-object",
        capture: {
          transactionRef: "fixture-capture",
          amountCents: 2500,
          currency: "usd",
        },
      },
      {
        kind: "pending",
        providerObjectRef: "fixture-object",
        capture: null,
        secret: "private",
      },
      Object.defineProperty({}, "kind", {
        get() {
          throw new Error("secret");
        },
      }),
    ]) {
      const item = await claimed();
      await run(item, {
        async execute() {
          return value;
        },
      });
      expect((await observations(item))[0]).toMatchObject({
        kind: "unknown",
        provider_object_ref: null,
        transaction_ref: null,
      });
      expect(await facts(item)).toHaveLength(0);
    }
    const item = await claimed();
    const result = await run(item, {
      async execute() {
        throw new Error("private provider secret");
      },
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect((await observations(item))[0]).toMatchObject({ kind: "unknown" });
  });
  it("rejects caller receipts, accessors, extra scope fields, invalid money/version/time before dispatch and snapshots data before awaits", async () => {
    const prepare = vi.fn(() => {
      throw new Error("must not read");
    });
    const database = facade(prepare);
    const fake = createTestPaymentSimulator();
    const execute = vi.spyOn(fake, "execute");
    const getter = vi.fn(() => dummy.claimId);
    for (const input of [
      { ...dummy, replayed: false },
      { ...dummy, amountCents: 2500 },
      { ...dummy, expectedVersion: 1 },
      { ...dummy, expectedVersion: 2.1 },
      Object.defineProperty({ ...dummy }, "claimId", { get: getter }),
    ])
      await expect(
        executeTestPaymentWork(database, trusted, input, fake, () => now),
      ).rejects.toMatchObject({ code: "invalid_request" });
    for (const time of [NaN, -1, Infinity, 0.5, 8_640_000_000_000_001])
      await expect(
        executeTestPaymentWork(database, trusted, dummy, fake, () => time),
      ).rejects.toMatchObject({ code: "invalid_request" });
    expect(prepare).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    const item = await claimed();
    const context = { ...item.context };
    const input = { ...item.input };
    const mutation = facade((sql) => {
      if (sql.includes("FROM commerce_payment_scope")) {
        context.workerId = crypto.randomUUID();
        input.requestId = crypto.randomUUID();
      }
      return db.prepare(sql);
    });
    expect(
      await executeTestPaymentWork(
        mutation,
        context,
        input,
        fake,
        () => now + 3,
      ),
    ).toMatchObject({
      status: "observation_processed",
      claimId: item.input.claimId,
      requestId: item.input.requestId,
    });
  });
  it("does not dispatch with a backwards final clock and retains starts when post-provider time is invalid", async () => {
    const item = await claimed();
    let time = now + 3;
    const fake = createTestPaymentSimulator();
    const execute = vi.spyOn(fake, "execute");
    const database = facade((sql) => {
      const statement = db.prepare(sql);
      if (!sql.includes("FROM commerce_payment_execution_starts e"))
        return statement;
      return {
        bind(...args: unknown[]) {
          const bound = statement.bind(...args);
          return {
            async first<T>() {
              const value = await bound.first<T>();
              time = now + 2;
              return value;
            },
          };
        },
      } as D1PreparedStatement;
    });
    await expect(
      executeTestPaymentWork(
        database,
        item.context,
        item.input,
        fake,
        () => time,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(execute).not.toHaveBeenCalled();
    const late = await claimed();
    time = now + 3;
    await expect(
      executeTestPaymentWork(
        db,
        late.context,
        late.input,
        {
          async execute(command) {
            const value = await fake.execute(command);
            time = now;
            return value;
          },
        },
        () => time,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await observations(late)).toHaveLength(0);
    expect(await run(late, fake, now + 4)).toMatchObject({
      status: "query_required",
      replayed: true,
    });
  });
  it("resumes a durable observation after the processing clock moves backwards", async () => {
    const item = await claimed();
    let time = now + 3;
    let batches = 0;
    const fake = createTestPaymentSimulator();
    const execute = vi.spyOn(fake, "execute");
    const database = facade(undefined, async (statements) => {
      const result = await db.batch(statements);
      if (++batches === 2) time = now + 2;
      return result;
    });
    await expect(
      executeTestPaymentWork(
        database,
        item.context,
        item.input,
        fake,
        () => time,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await observations(item)).toHaveLength(1);
    expect(await facts(item)).toHaveLength(0);
    expect(await run(item, fake, now + 4)).toMatchObject({
      replayed: true,
      status: "observation_processed",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await facts(item)).toHaveLength(1);
  });
  it("refuses occupied observation IDs from another source before dispatch or processing", async () => {
    const first = await claimed();
    const collision = await claimed();
    await recordTestPaymentObservation(
      db,
      first.context,
      {
        observationId: collision.input.claimId,
        claimId: first.claim.claimId,
        requestId: first.started.requestId,
        kind: "captured",
        providerObjectRef: "fixture-object",
        capture: {
          transactionRef: "fixture-capture",
          amountCents: 2500,
          currency: "CAD",
        },
      },
      now + 3,
    );
    const fake = createTestPaymentSimulator();
    const execute = vi.spyOn(fake, "execute");
    await expect(run(collision, fake)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(run(collision, fake)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(await facts(first)).toHaveLength(0);
    expect(await facts(collision)).toHaveLength(0);
  });
  it("uses read-only QUERY after expiry/held state/evidence and preserves original provider history", async () => {
    const item = await claimed();
    const fake = createTestPaymentSimulator();
    await run(item, fake);
    await db
      .prepare("UPDATE commerce_orders SET fulfillment='held' WHERE id=?")
      .bind(item.order.id)
      .run();
    const next = await replacement(item, item.order.reserveUntil + 1);
    const before = await invariant();
    const execute = vi.spyOn(fake, "execute");
    await run(next, fake, next.claim.claimedAt + 1);
    expect(execute.mock.calls[0][0].operation).toBe("query");
    expect(await facts(item)).toHaveLength(1);
    expect(await invariant()).toEqual(before);
  });
});

describe("fictional in-memory simulator identity", () => {
  it("is idempotent for the original scoped key, rejects changed parameters and does not create on query", async () => {
    const fake = createTestPaymentSimulator();
    const command = {
      mode: "local-test" as const,
      instanceId,
      provider: "stripe" as const,
      accountRef: "fixture-stripe",
      operation: "query" as const,
      createOperationKey: crypto.randomUUID(),
      amountCents: 2500,
      currency: "CAD" as const,
    };
    expect(await fake.execute(command)).toMatchObject({ kind: "not_found" });
    const first = await fake.execute({ ...command, operation: "create" });
    expect(await fake.execute({ ...command, operation: "create" })).toEqual(
      first,
    );
    expect(await fake.execute(command)).toEqual(first);
    const second = await createTestPaymentSimulator().execute({
      ...command,
      operation: "create",
      createOperationKey: crypto.randomUUID(),
    });
    expect(second).not.toEqual(first);
    expect(
      await createTestPaymentSimulator().execute({
        ...command,
        operation: "create",
      }),
    ).toEqual(first);

    await expect(
      fake.execute({ ...command, amountCents: 2501 }),
    ).rejects.toThrow("Conflicting fictional payment parameters");
    expect(
      await fake.execute({ ...command, accountRef: "fixture-other" }),
    ).toMatchObject({ kind: "not_found" });
    expect(await createTestPaymentSimulator().execute(command)).toMatchObject({
      kind: "not_found",
    });
  });
});
