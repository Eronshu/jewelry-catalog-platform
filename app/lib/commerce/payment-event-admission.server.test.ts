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
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { applyStockCommand } from "./inventory.server";
import { createTestQuote, reserveTestOrder } from "./orders.server";
import { beginTestPaymentAttempt } from "./payment-start.server";
import { claimTestPaymentWork } from "./payment-work.server";
import {
  registerTestPaymentExecution,
  type TestPaymentExecutionContext,
} from "./payment-execution-start.server";
import { executeTestPaymentWork } from "./payment-executor.server";
import {
  createTestPaymentSimulator,
  type TestPaymentSimulator,
} from "./payment-simulator.server";
import {
  recordTestPaymentEvent,
  type TestPaymentEventInput,
} from "./payment-event-inbox.server";

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
let directory: string;
let template: string;
let current: string;
let configPath: string;
let platform: PlatformProxy<Env> | undefined;
let db: D1Database;
let sequence = 0;
function config(path: string, migrations: string) {
  writeFileSync(
    join(path, "worker.js"),
    "export default {fetch(){return new Response('fixture')}};",
  );
  const name = join(path, "wrangler.json");
  writeFileSync(
    name,
    JSON.stringify({
      name: "fictional-event-admission",
      main: "worker.js",
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
  return name;
}
function migrate(path: string, configuration: string) {
  execFileSync(
    join(root, "node_modules/.bin/wrangler"),
    [
      "d1",
      "migrations",
      "apply",
      "DB",
      "--config",
      configuration,
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
      timeout: 20_000,
    },
  );
}
async function connect() {
  platform = await getPlatformProxy<Env>({
    configPath,
    envFiles: [],
    persist: { path: join(current, "state/v3") },
    remoteBindings: false,
  });
  db = platform.env.DB;
}
const migration = () =>
  readFileSync(
    join(root, "migrations/0016_commerce_payment_event_admission.sql"),
    "utf8",
  );
const fence = () => db.prepare(migration()).run();
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "jewelry-event-admission-"));
  template = join(directory, "empty-0015");
  mkdirSync(template);
  const migrations = join(template, "migrations");
  mkdirSync(migrations);
  for (const file of readdirSync(join(root, "migrations")).filter(
    (file) => file.endsWith(".sql") && file < "0016",
  ))
    copyFileSync(join(root, "migrations", file), join(migrations, file));
  migrate(template, config(template, migrations));
}, 30_000);
beforeEach(async () => {
  current = mkdtempSync(join(directory, "case-"));
  // Copy an empty, closed 0015 test template, not an existing business database.
  // This isolates every case without deleting evidence to reopen CREATE.
  cpSync(join(template, "state"), join(current, "state"), { recursive: true });
  configPath = config(current, join(template, "migrations"));
  await connect();
  await db
    .prepare(
      "INSERT INTO commerce_payment_scope(id,mode,instance_id,stripe_account_ref,paypal_account_ref) VALUES (1,'local-test',?,'fixture-stripe','fixture-paypal')",
    )
    .bind(instanceId)
    .run();
});
afterEach(async () => {
  await platform?.dispose();
  platform = undefined;
  if (current) rmSync(current, { recursive: true, force: true });
}, 10_000);
afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});
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

const run = (
  item: Item,
  fake: TestPaymentSimulator,
  time = now + 3,
  database = db,
) =>
  executeTestPaymentWork(database, item.context, item.input, fake, () => time);
async function rows(name: string) {
  return (await db.prepare(`SELECT * FROM ${name} ORDER BY 1,2`).all()).results;
}
async function business() {
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
function event(
  kind: TestPaymentEventInput["kind"] = "unknown",
  hint: string | null = null,
): TestPaymentEventInput {
  return {
    eventRef: `fixture-event-${crypto.randomUUID()}`,
    kind,
    providerObjectRef: ["unknown", "not_found", "unmapped"].includes(kind)
      ? null
      : "fixture-object",
    candidateRequestId: hint,
    capture:
      kind === "captured"
        ? {
            transactionRef: "fixture-transaction",
            amountCents: 1,
            currency: "USD",
          }
        : null,
    occurredAt: now + 1_000_000,
  };
}
function intake(command = event(), provider: "stripe" | "paypal" = "paypal") {
  return recordTestPaymentEvent(
    db,
    {
      mode: "local-test",
      instanceId,
      provider,
      accountRef: `fixture-${provider}`,
    },
    command,
    now + 4,
  );
}
function finalRead(
  before: () => Promise<void> = async () => {},
  after: () => Promise<void> = async () => {},
  transform: (row: Record<string, unknown> | null) => unknown = (row) => row,
): D1Database {
  return {
    batch: db.batch.bind(db),
    prepare(sql: string) {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, key) {
            if (key === "bind")
              return (...values: unknown[]) => wrap(target.bind(...values));
            if (key === "first" && sql.includes("AS hasInboxEvidence"))
              return async () => {
                await before();
                const row = await target.first<Record<string, unknown>>();
                await after();
                return transform(row);
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      return wrap(db.prepare(sql));
    },
  } as D1Database;
}
async function rawStart(item: Item, changes: Record<string, unknown> = {}) {
  const values = {
    claim_id: item.claim.claimId,
    attempt_command_id: `payment-start-${item.started.requestId}`,
    worker_id: item.context.workerId,
    mode: item.context.mode,
    instance_id: instanceId,
    provider: item.context.provider,
    account_ref: item.context.accountRef,
    expected_work_version: item.input.expectedVersion,
    operation: item.claim.operation,
    request_hash: "a".repeat(64),
    started_at: item.claim.claimedAt + 1,
    ...changes,
  };
  return db
    .prepare(
      `INSERT INTO commerce_payment_execution_starts (${Object.keys(values).join(",")}) VALUES (${Object.keys(
        values,
      )
        .map(() => "?")
        .join(",")})`,
    )
    .bind(...Object.values(values))
    .run();
}

describe("unresolved event receipts conservatively fence CREATE on real temporary D1", () => {
  it("upgrades 0015 with existing starts and receipts without changing any history", async () => {
    const old = await claimed();
    const fresh = await claimed("paypal");
    const receipt = await registerTestPaymentExecution(
      db,
      old.context,
      old.input,
      () => now + 3,
    );
    await intake();
    const tables = (
      await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'commerce_%' ORDER BY name",
        )
        .all<{ name: string }>()
    ).results;
    const history = async () =>
      Object.fromEntries(
        await Promise.all(
          tables.map(async ({ name }) => [name, await rows(name)]),
        ),
      );
    const before = await history();
    await platform!.dispose();
    platform = undefined;
    const migrations = join(current, "migrations");
    cpSync(join(template, "migrations"), migrations, { recursive: true });
    copyFileSync(
      join(root, "migrations/0016_commerce_payment_event_admission.sql"),
      join(migrations, "0016_commerce_payment_event_admission.sql"),
    );
    configPath = config(current, migrations);
    migrate(current, configPath);
    await connect();
    expect(await history()).toEqual(before);
    expect(
      await registerTestPaymentExecution(
        db,
        old.context,
        old.input,
        () => now + 60_000,
      ),
    ).toEqual({ ...receipt, replayed: true });
    await expect(rawStart(fresh)).rejects.toThrow(
      "commerce_execution_start_event_fence",
    );
    expect(await history()).toEqual(before);
  });
  it.each(["stripe", "paypal"] as const)(
    "allows original %s CREATE with an empty inbox without business mutation",
    async (provider) => {
      await fence();
      const item = await claimed(provider);
      const before = await business();
      const fake = createTestPaymentSimulator();
      const execute = vi.spyOn(fake, "execute");
      expect(await run(item, fake)).toMatchObject({
        status: "observation_processed",
        replayed: false,
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][0].operation).toBe("create");
      expect(await business()).toEqual(before);
    },
  );
  it.each(
    (["stripe", "paypal"] as const).flatMap((provider) =>
      (
        [
          "unknown",
          "not_found",
          "pending",
          "approved",
          "reported_failed",
          "captured",
          "unmapped",
        ] as const
      ).map((kind, index) => ({ provider, kind, index })),
    ),
  )(
    "blocks $provider CREATE for a separately isolated $kind receipt on the other provider",
    async ({ provider, kind, index }) => {
      await fence();
      const item = await claimed(provider);
      const other = await claimed(provider === "stripe" ? "paypal" : "stripe");
      const hint =
        index % 3 === 0
          ? null
          : index % 3 === 1
            ? crypto.randomUUID()
            : other.started.requestId;
      const command = event(kind, hint);
      await intake(command, provider === "stripe" ? "paypal" : "stripe");
      const before = await business();
      const fake = createTestPaymentSimulator();
      const execute = vi.spyOn(fake, "execute");
      await expect(run(item, fake)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(execute).not.toHaveBeenCalled();
      expect(await rows("commerce_payment_execution_starts")).toEqual([]);
      expect(await rows("commerce_payment_observations")).toEqual([]);
      expect(await rows("commerce_payment_capture_facts")).toEqual([]);
      expect(await business()).toEqual(before);
    },
  );
  it("does not treat duplicate receipts, additional variants, matching hints or provider times as clearance", async () => {
    await fence();
    const item = await claimed();
    const command = event("not_found", item.started.requestId);
    const first = await intake(command);
    expect(await intake(command)).toEqual({ ...first, replayed: true });
    await intake({ ...command, kind: "unknown", occurredAt: 0 });
    expect(await rows("commerce_payment_event_receipts")).toHaveLength(2);
    const before = await business();
    await expect(rawStart(item)).rejects.toThrow(
      "commerce_execution_start_event_fence",
    );
    expect(await business()).toEqual(before);
  });
  it("keeps a historical registration as history and never dispatches it after an event arrives", async () => {
    await fence();
    const item = await claimed();
    const saved = await registerTestPaymentExecution(
      db,
      item.context,
      item.input,
      () => now + 3,
    );
    await intake();
    const before = await business();
    const fake = createTestPaymentSimulator();
    const execute = vi.spyOn(fake, "execute");
    expect(await run(item, fake, now + 5)).toMatchObject({
      status: "query_required",
      replayed: true,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(await rows("commerce_payment_execution_starts")).toHaveLength(1);
    expect(
      await registerTestPaymentExecution(
        db,
        item.context,
        item.input,
        () => now + 60_000,
      ),
    ).toEqual({ ...saved, replayed: true });
    expect(await business()).toEqual(before);
  });
  it("retains a fresh registration but does not call the simulator when a receipt arrives before the final read", async () => {
    await fence();
    const item = await claimed();
    const before = await business();
    const fake = createTestPaymentSimulator();
    const execute = vi.spyOn(fake, "execute");
    const database = finalRead(async () => {
      await intake();
    });
    expect(await run(item, fake, now + 5, database)).toMatchObject({
      status: "query_required",
      replayed: false,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(await rows("commerce_payment_execution_starts")).toHaveLength(1);
    expect(await rows("commerce_payment_event_receipts")).toHaveLength(1);
    expect(await run(item, fake, now + 6)).toMatchObject({
      status: "query_required",
      replayed: true,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(await business()).toEqual(before);
  });
  it("preserves the receipt and capture when another worker commits after the final read: the remaining dispatch gap", async () => {
    await fence();
    const item = await claimed();
    const before = await business();
    const fake = createTestPaymentSimulator();
    const execute = vi.spyOn(fake, "execute");
    const database = finalRead(undefined, async () => {
      await intake();
    });
    expect(await run(item, fake, now + 5, database)).toMatchObject({
      status: "observation_processed",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0].operation).toBe("create");
    expect(await rows("commerce_payment_event_receipts")).toHaveLength(1);
    expect(await rows("commerce_payment_capture_facts")).toHaveLength(1);
    expect(await business()).toEqual(before);
    const next = await claimed("paypal");
    await expect(rawStart(next)).rejects.toThrow(
      "commerce_execution_start_event_fence",
    );
  });
  it("continues QUERY with inbox evidence, expired reservation, held state and existing capture", async () => {
    await fence();
    const item = await claimed();
    const fake = createTestPaymentSimulator();
    await run(item, fake);
    await intake();
    await db
      .prepare("UPDATE commerce_orders SET fulfillment='held' WHERE id=?")
      .bind(item.order.id)
      .run();
    const query = await replacement(item, item.order.reserveUntil + 1);
    const before = await business();
    const execute = vi.spyOn(fake, "execute");
    expect(await run(query, fake, query.claim.claimedAt + 1)).toMatchObject({
      status: "observation_processed",
      replayed: false,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0].operation).toBe("query");
    expect(await rows("commerce_payment_capture_facts")).toHaveLength(1);
    expect(await business()).toEqual(before);
  });
  it("can resume an already durable observation after intake without calling the simulator", async () => {
    await fence();
    const item = await claimed();
    const fake = createTestPaymentSimulator();
    const execute = vi.spyOn(fake, "execute");
    await run(item, fake);
    await intake();
    const before = await business();
    expect(await run(item, fake, now + 5)).toMatchObject({
      status: "observation_processed",
      replayed: true,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(await rows("commerce_payment_capture_facts")).toHaveLength(1);
    expect(await business()).toEqual(before);
  });
  it.each(["read-failure", null, undefined, 2, "0"])(
    "fails closed for invalid final inbox evidence %j",
    async (fault) => {
      await fence();
      const item = await claimed();
      const fake = createTestPaymentSimulator();
      const execute = vi.spyOn(fake, "execute");
      const database = finalRead(
        async () => {
          if (fault === "read-failure")
            throw new Error("private storage failure");
        },
        undefined,
        (row) => ({ ...row, hasInboxEvidence: fault }),
      );
      await expect(run(item, fake, now + 5, database)).rejects.toMatchObject({
        code: "unavailable",
        message: "Local test payment execution could not be confirmed",
      });
      expect(execute).not.toHaveBeenCalled();
      expect(await rows("commerce_payment_execution_starts")).toHaveLength(1);
    },
  );
  it("SQL preserves original provenance and distinguishes fenced CREATE from allowed QUERY", async () => {
    await fence();
    const first = await claimed();
    const blocked = await claimed("paypal");
    await expect(
      rawStart(first, { worker_id: crypto.randomUUID() }),
    ).rejects.toThrow("commerce_execution_start_source");
    await rawStart(first);
    await intake();
    const before = await business();
    await expect(rawStart(blocked)).rejects.toThrow(
      "commerce_execution_start_event_fence",
    );
    // Disguising a CREATE claim as QUERY cannot bypass the original source guard.
    await expect(rawStart(blocked, { operation: "query" })).rejects.toThrow(
      "commerce_execution_start_source",
    );
    expect(await business()).toEqual(before);
    const query = await replacement(first, first.claim.leaseUntil);
    const queryBefore = await business();
    await rawStart(query);
    expect(await rows("commerce_payment_execution_starts")).toHaveLength(2);
    expect(await business()).toEqual(queryBefore);
    await expect(
      db
        .prepare(
          "DELETE FROM commerce_payment_execution_starts WHERE claim_id=?",
        )
        .bind(first.claim.claimId)
        .run(),
    ).rejects.toThrow();
    await expect(
      db.prepare("DELETE FROM commerce_payment_event_receipts").run(),
    ).rejects.toThrow();
  });
});
