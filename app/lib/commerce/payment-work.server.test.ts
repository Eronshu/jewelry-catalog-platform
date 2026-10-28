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
import { recoverExpiredReservation } from "./reservation-recovery.server";
import {
  beginTestPaymentAttempt,
  type TrustedTestPaymentContext,
} from "./payment-start.server";
import {
  claimTestPaymentWork,
  type TestPaymentWorkContext,
  type TestPaymentWorkClaimInput,
} from "./payment-work.server";

const root = resolve(process.cwd());
const now = 1_800_000_000_000;
const owner = "a".repeat(64);
const instanceId = "11111111-1111-4111-8111-111111111111";
const workerId = "22222222-2222-4222-8222-222222222222";
const context: TestPaymentWorkContext = {
  mode: "local-test",
  instanceId,
  provider: "stripe",
  accountRef: "fixture-stripe",
  workerId,
};
const startContext: TrustedTestPaymentContext = {
  ...context,
  ownerHash: owner,
} as unknown as TrustedTestPaymentContext;
delete (startContext as unknown as Record<string, unknown>).workerId;
let directory: string;
let configPath: string;
let platform: PlatformProxy<Env>;
let db: D1Database;
let sequence = 0;
let historical: Awaited<ReturnType<typeof attempt>>[];
let beforeUpgrade: unknown;
let absentScopeReads: string[];
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
async function reserved(reserveUntil?: number) {
  const id = `work-fixture-${++sequence}`;
  const product = await db
    .prepare(
      `INSERT INTO products(name,slug,price_cents,quantity,category_id,status,created_at,updated_at)
    VALUES ('Fictional work test',?,999,999,1,'draft',1,1) RETURNING id`,
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
    now,
  );
  const quote = await createTestQuote(
    db,
    owner,
    [{ variantId: id, quantity: 1 }],
    "pickup",
    now,
  );
  const order = await reserveTestOrder(db, owner, quote.id, now);
  if (reserveUntil !== undefined)
    await db
      .prepare("UPDATE commerce_orders SET reserve_until=? WHERE id=?")
      .bind(reserveUntil, order.id)
      .run();
  return { id, order, quote };
}
async function attempt(
  provider: "stripe" | "paypal" = "stripe",
  reserveUntil?: number,
) {
  const item = await reserved(reserveUntil);
  const started = await beginTestPaymentAttempt(
    db,
    { ...startContext, provider, accountRef: `fixture-${provider}` },
    {
      requestId: crypto.randomUUID(),
      reference: item.order.id,
      expectedVersion: 1,
    },
    now + 1,
  );
  return { ...item, started };
}
function command(
  requestId: string,
  expectedVersion = 1,
): TestPaymentWorkClaimInput {
  return { claimId: crypto.randomUUID(), requestId, expectedVersion };
}
async function table(table: string) {
  return (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results;
}
async function business() {
  return Promise.all(
    [
      "commerce_orders",
      "commerce_quotes",
      "commerce_order_lines",
      "commerce_stock_movements",
      "commerce_inventory",
      "commerce_commands",
      "commerce_payment_attempts",
      "commerce_reservation_recoveries",
    ].map(table),
  );
}
async function work(requestId: string) {
  return db
    .prepare("SELECT * FROM commerce_payment_work WHERE attempt_command_id=?")
    .bind(`payment-start-${requestId}`)
    .first();
}
async function claims(requestId: string) {
  return (
    await db
      .prepare(
        "SELECT * FROM commerce_payment_work_claims WHERE attempt_command_id=? ORDER BY expected_version",
      )
      .bind(`payment-start-${requestId}`)
      .all()
  ).results;
}
async function rawClaim(
  input: TestPaymentWorkClaimInput,
  time = now + 2,
  kind = "create",
  trusted = context,
) {
  return db
    .prepare(
      `INSERT INTO commerce_payment_work_claims(claim_id,attempt_command_id,worker_id,request_hash,mode,instance_id,provider,account_ref,expected_version,kind,claimed_at,lease_until)
    VALUES (?,?,?,?,'local-test',?,?,?,?,?,?,?)`,
    )
    .bind(
      input.claimId,
      `payment-start-${input.requestId}`,
      trusted.workerId,
      "b".repeat(64),
      trusted.instanceId,
      trusted.provider,
      trusted.accountRef,
      input.expectedVersion,
      kind,
      time,
      time + 30_000,
    )
    .run();
}
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "jewelry-payment-work-"));
  const migrations = join(directory, "migrations");
  mkdirSync(migrations);
  for (const file of readdirSync(join(root, "migrations")).filter(
    (file) => file.endsWith(".sql") && file < "0010",
  ))
    copyFileSync(join(root, "migrations", file), join(migrations, file));
  configPath = join(directory, "wrangler.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "fictional-payment-work-test",
      compatibility_date: "2026-09-29",
      d1_databases: [
        {
          binding: "DB",
          database_name: "fictional-payment-work-test",
          database_id: "local-test",
          migrations_dir: migrations,
          migrations_table: "catalog_migrations",
        },
      ],
    }),
  );
  migrate();
  await connect();
  absentScopeReads = [];
  await expect(
    claimTestPaymentWork(
      {
        prepare(sql: string) {
          absentScopeReads.push(sql);
          return db.prepare(sql);
        },
      } as unknown as D1Database,
      context,
      command(crypto.randomUUID()),
      now,
    ),
  ).rejects.toMatchObject({ code: "unavailable" });
  await db
    .prepare(
      "INSERT INTO commerce_payment_scope(id,mode,instance_id,stripe_account_ref,paypal_account_ref) VALUES (1,'local-test',?,'fixture-stripe','fixture-paypal')",
    )
    .bind(instanceId)
    .run();
  historical = [await attempt("stripe"), await attempt("paypal")];
  const recovered = await reserved();
  await recoverExpiredReservation(
    db,
    { email: "fictional@example.invalid", sub: "fictional-operator" },
    {
      requestId: crypto.randomUUID(),
      reference: recovered.order.id,
      expectedVersion: 1,
      confirmation: recovered.order.id,
      reason: "overdue_unpaid",
    },
    recovered.order.reserveUntil,
  );
  beforeUpgrade = await business();
  await platform.dispose();
  copyFileSync(
    join(root, "migrations/0010_commerce_payment_work.sql"),
    join(migrations, "0010_commerce_payment_work.sql"),
  );
  migrate();
  await connect();
}, 30_000);
afterAll(async () => {
  await platform?.dispose();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("internal fictional local payment work journal on real temporary D1", () => {
  it("upgrades 0001–0009 and backfills both old intents without changing orders, balances or audit", async () => {
    expect(await business()).toEqual(beforeUpgrade);
    expect(await table("commerce_payment_work")).toHaveLength(2);
    for (const item of historical)
      expect(await work(item.started.requestId)).toEqual({
        attempt_command_id: `payment-start-${item.started.requestId}`,
        version: 1,
        next_operation: "create",
        current_claim_id: null,
      });
    expect(await table("commerce_payment_work_claims")).toEqual([]);
    expect(absentScopeReads).toHaveLength(1);
    expect(absentScopeReads[0]).toContain("commerce_payment_scope");
  });
  it.each(["stripe", "paypal"] as const)(
    "automatically creates one work record for a new %s intent and persists a first historical create claim",
    async (provider) => {
      const item = await attempt(provider);
      const input = command(item.started.requestId);
      const before = await business();
      expect(await work(input.requestId)).toMatchObject({
        version: 1,
        next_operation: "create",
        current_claim_id: null,
      });
      const trusted = {
        ...context,
        provider,
        accountRef: `fixture-${provider}`,
      };
      const receipt = await claimTestPaymentWork(db, trusted, input, now + 2);
      expect(receipt).toEqual({
        testOnly: true,
        ...input,
        reference: item.order.id,
        provider,
        operation: "create",
        amountCents: 2500,
        currency: "CAD",
        createOperationKey: item.started.createOperationKey,
        resultingVersion: 2,
        claimedAt: now + 2,
        leaseUntil: now + 30_002,
        replayed: false,
      });
      expect(Object.keys(receipt).sort()).toEqual(
        [
          "testOnly",
          "claimId",
          "requestId",
          "reference",
          "provider",
          "operation",
          "amountCents",
          "currency",
          "createOperationKey",
          "expectedVersion",
          "resultingVersion",
          "claimedAt",
          "leaseUntil",
          "replayed",
        ].sort(),
      );
      expect(await work(input.requestId)).toMatchObject({
        version: 2,
        next_operation: "query",
        current_claim_id: input.claimId,
      });
      expect(await claims(input.requestId)).toHaveLength(1);
      expect(await business()).toEqual(before);
    },
  );
  it("rolls back the whole new attempt, command and order lock if automatic work creation fails", async () => {
    const item = await reserved();
    const before = await business();
    await db
      .prepare(
        "CREATE TRIGGER work_fixture_failure BEFORE INSERT ON commerce_payment_work BEGIN SELECT RAISE(ABORT,'fictional failure'); END",
      )
      .run();
    try {
      await expect(
        beginTestPaymentAttempt(
          db,
          startContext,
          {
            requestId: crypto.randomUUID(),
            reference: item.order.id,
            expectedVersion: 1,
          },
          now + 1,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      await db.prepare("DROP TRIGGER work_fixture_failure").run();
    }
    expect(await business()).toEqual(before);
  });
  it.each([
    { instanceId: "33333333-3333-4333-8333-333333333333" },
    { accountRef: "fixture-wrong" },
  ])("fails mismatched scope before business reads: %j", async (change) => {
    const prepare = vi.fn((sql: string) => db.prepare(sql));
    await expect(
      claimTestPaymentWork(
        { prepare } as unknown as D1Database,
        { ...context, ...change },
        command(historical[0].started.requestId),
        now + 2,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0][0]).toContain("commerce_payment_scope");
  });
  it("copies inputs before awaits and canonicalizes property order for replay", async () => {
    const item = await attempt();
    const input = command(item.started.requestId);
    const trusted = { ...context };
    let modified = false;
    const intercepted = {
      prepare(sql: string) {
        const statement = db.prepare(sql);
        if (!sql.includes("commerce_payment_scope")) return statement;
        return {
          async first() {
            if (!modified) {
              input.expectedVersion = 2;
              trusted.workerId = crypto.randomUUID();
              modified = true;
            }
            return statement.first();
          },
        };
      },
      batch: db.batch.bind(db),
    } as unknown as D1Database;
    const original = { ...input };
    const receipt = await claimTestPaymentWork(
      intercepted,
      trusted,
      input,
      now + 2,
    );
    expect(receipt.expectedVersion).toBe(1);
    const reordered = {
      expectedVersion: 1,
      requestId: original.requestId,
      claimId: original.claimId,
    };
    const reorderedTrusted = {
      workerId,
      accountRef: context.accountRef,
      provider: context.provider,
      instanceId,
      mode: context.mode,
    };
    expect(
      await claimTestPaymentWork(db, reorderedTrusted, reordered, now + 60_000),
    ).toEqual({ ...receipt, replayed: true });
  });
  it("replays the immutable old receipt without renewing a lease or overriding a new claim", async () => {
    const item = await attempt();
    const first = command(item.started.requestId);
    const before = await business();
    const recorded = await claimTestPaymentWork(db, context, first, now + 2);
    const second = command(item.started.requestId, 2);
    const next = await claimTestPaymentWork(
      db,
      { ...context, workerId: crypto.randomUUID() },
      second,
      recorded.leaseUntil,
    );
    expect(next).toMatchObject({
      operation: "query",
      expectedVersion: 2,
      resultingVersion: 3,
      claimedAt: recorded.leaseUntil,
      createOperationKey: recorded.createOperationKey,
    });
    const savedWork = await work(first.requestId);
    expect(
      await claimTestPaymentWork(db, context, first, now + 1_000_000),
    ).toEqual({ ...recorded, replayed: true });
    expect(await work(first.requestId)).toEqual(savedWork);
    expect(await claims(first.requestId)).toHaveLength(2);
    expect(await business()).toEqual(before);
  });
  it("rejects an active lease, clock rollback, stale versions and wrong provider in service and SQL", async () => {
    const item = await attempt();
    const first = command(item.started.requestId);
    const before = await business();
    await expect(
      claimTestPaymentWork(db, context, first, now),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(rawClaim(first, now)).rejects.toThrow();
    const saved = await claimTestPaymentWork(db, context, first, now + 10);
    const next = command(first.requestId, 2);
    for (const time of [now + 9, saved.leaseUntil - 1]) {
      await expect(
        claimTestPaymentWork(db, context, next, time),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(rawClaim(next, time, "query")).rejects.toThrow();
    }
    await expect(
      claimTestPaymentWork(
        db,
        context,
        command(first.requestId),
        saved.leaseUntil,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      claimTestPaymentWork(
        db,
        { ...context, provider: "paypal", accountRef: "fixture-paypal" },
        next,
        saved.leaseUntil,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      rawClaim(next, saved.leaseUntil, "query", {
        ...context,
        provider: "paypal",
        accountRef: "fixture-paypal",
      }),
    ).rejects.toThrow();
    expect(await claims(first.requestId)).toHaveLength(1);
    expect(await business()).toEqual(before);
  });
  it.each(["quote", "reservation", "held", "confirmed", "failed"])(
    "downgrades a first claim to query when %s makes create unsafe",
    async (kind) => {
      const item = await attempt(
        "stripe",
        kind === "reservation" ? now + 50 : undefined,
      );
      let time =
        kind === "quote"
          ? now + 600_000
          : kind === "reservation"
            ? now + 50
            : now + 2;
      if (kind === "held")
        await db
          .prepare("UPDATE commerce_orders SET fulfillment='held' WHERE id=?")
          .bind(item.order.id)
          .run();
      if (kind === "confirmed")
        await db
          .prepare("UPDATE commerce_orders SET state='confirmed' WHERE id=?")
          .bind(item.order.id)
          .run();
      if (kind === "failed")
        await db
          .prepare(
            "UPDATE commerce_orders SET payment_state='failed' WHERE id=?",
          )
          .bind(item.order.id)
          .run();
      const input = command(item.started.requestId);
      const before = await business();
      await expect(rawClaim(input, time, "create")).rejects.toThrow();
      const receipt = await claimTestPaymentWork(db, context, input, time);
      expect(receipt.operation).toBe("query");
      expect(await work(input.requestId)).toMatchObject({
        next_operation: "query",
        version: 2,
      });
      expect(await business()).toEqual(before);
      time += 30_000;
      expect(
        (
          await claimTestPaymentWork(
            db,
            context,
            command(input.requestId, 2),
            time,
          )
        ).operation,
      ).toBe("query");
    },
  );
  it("allows create immediately before the quote deadline, and permits only query at expired lease", async () => {
    const item = await attempt();
    const first = command(item.started.requestId);
    const receipt = await claimTestPaymentWork(
      db,
      context,
      first,
      now + 599_999,
    );
    expect(receipt.operation).toBe("create");
    const next = command(first.requestId, 2);
    await expect(
      rawClaim(next, receipt.leaseUntil, "create"),
    ).rejects.toThrow();
    expect(
      (await claimTestPaymentWork(db, context, next, receipt.leaseUntil))
        .operation,
    ).toBe("query");
  });
  it("rechecks create safety transactionally if order state changes after the service read", async () => {
    const item = await attempt();
    const input = command(item.started.requestId);
    const intercepted = {
      prepare: db.prepare.bind(db),
      async batch(statements: D1PreparedStatement[]) {
        await db
          .prepare("UPDATE commerce_orders SET fulfillment='held' WHERE id=?")
          .bind(item.order.id)
          .run();
        return db.batch(statements);
      },
    } as unknown as D1Database;
    await expect(
      claimTestPaymentWork(intercepted, context, input, now + 2),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await claims(input.requestId)).toEqual([]);
    expect(await work(input.requestId)).toMatchObject({
      version: 1,
      current_claim_id: null,
    });
    expect(
      (await claimTestPaymentWork(db, context, input, now + 2)).operation,
    ).toBe("query");
  });
  it("gives concurrent identical claim IDs one journal record and one version increment", async () => {
    const item = await attempt();
    const input = command(item.started.requestId);
    const before = await business();
    const results = await Promise.all([
      claimTestPaymentWork(db, context, input, now + 2),
      claimTestPaymentWork(db, context, input, now + 2),
    ]);
    expect(results.map(({ replayed: _, ...rest }) => rest)).toEqual([
      expect.objectContaining({ claimId: input.claimId }),
      expect.objectContaining({ claimId: input.claimId }),
    ]);
    expect({ ...results[0], replayed: true }).toEqual({
      ...results[1],
      replayed: true,
    });
    expect(await work(input.requestId)).toMatchObject({
      version: 2,
      current_claim_id: input.claimId,
    });
    expect(await claims(input.requestId)).toHaveLength(1);
    expect(await business()).toEqual(before);
  });
  it("gives different concurrent claim IDs/workers only one winner", async () => {
    const item = await attempt();
    const first = command(item.started.requestId),
      second = command(item.started.requestId);
    const before = await business();
    const results = await Promise.allSettled([
      claimTestPaymentWork(db, context, first, now + 2),
      claimTestPaymentWork(
        db,
        { ...context, workerId: crypto.randomUUID() },
        second,
        now + 2,
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "conflict" },
    });
    expect(await claims(first.requestId)).toHaveLength(1);
    expect(await work(first.requestId)).toMatchObject({ version: 2 });
    expect(await business()).toEqual(before);
  });
  it("rejects a reused claim ID with changed worker, request, version or provider", async () => {
    const item = await attempt();
    const other = await attempt();
    const input = command(item.started.requestId);
    await claimTestPaymentWork(db, context, input, now + 2);
    const before = await work(input.requestId);
    for (const [trusted, change] of [
      [{ ...context, workerId: crypto.randomUUID() }, {}],
      [context, { requestId: other.started.requestId }],
      [context, { expectedVersion: 2 }],
      [{ ...context, provider: "paypal", accountRef: "fixture-paypal" }, {}],
    ] as const)
      await expect(
        claimTestPaymentWork(
          db,
          trusted,
          { ...input, ...change },
          now + 40_000,
        ),
      ).rejects.toMatchObject({ code: "conflict" });
    expect(await work(input.requestId)).toEqual(before);
    expect(await claims(input.requestId)).toHaveLength(1);
  });
  it.each(["preflight", "failed-batch reconciliation"])(
    "rechecks receipts across the %s state-read race gap",
    async (stage) => {
      const item = await attempt();
      const input = command(item.started.requestId);
      let reads = 0;
      let committed:
        Awaited<ReturnType<typeof claimTestPaymentWork>> | undefined;
      const batch = vi.fn(async () => {
        throw new Error("fictional transient failure");
      });
      const raced = {
        prepare(sql: string) {
          const statement = db.prepare(sql);
          if (!sql.includes("w.next_operation AS nextOperation"))
            return statement;
          return {
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return {
                async first() {
                  reads++;
                  if (reads === (stage === "preflight" ? 1 : 2))
                    committed = await claimTestPaymentWork(
                      db,
                      context,
                      input,
                      now + 2,
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
        await claimTestPaymentWork(raced, context, input, now + 2),
      ).toEqual({ ...committed, replayed: true });
      expect(batch).toHaveBeenCalledTimes(stage === "preflight" ? 0 : 1);
      expect(await claims(input.requestId)).toHaveLength(1);
      expect(await work(input.requestId)).toMatchObject({ version: 2 });
    },
  );
  it("recovers a lost write response by the original durable receipt", async () => {
    const item = await attempt();
    const input = command(item.started.requestId);
    const lost = {
      prepare: db.prepare.bind(db),
      async batch(statements: D1PreparedStatement[]) {
        await db.batch(statements);
        throw new Error("fictional lost response");
      },
    } as unknown as D1Database;
    const saved = await claimTestPaymentWork(lost, context, input, now + 2);
    expect(saved).toMatchObject({
      replayed: true,
      claimedAt: now + 2,
      operation: "create",
    });
    expect(
      await claimTestPaymentWork(db, context, input, now + 60_000),
    ).toEqual(saved);
    expect(await claims(input.requestId)).toHaveLength(1);
  });
  it.each([true, false])(
    "returns unavailable on post-write readback outage (lost response=%s), original ID resolves later",
    async (lostResponse) => {
      const item = await attempt();
      const input = command(item.started.requestId);
      let written = false;
      const lost = {
        prepare(sql: string) {
          if (written) throw new Error("fictional readback outage");
          return db.prepare(sql);
        },
        async batch(statements: D1PreparedStatement[]) {
          const result = await db.batch(statements);
          written = true;
          if (lostResponse) throw new Error("fictional response lost");
          return result;
        },
      } as unknown as D1Database;
      await expect(
        claimTestPaymentWork(lost, context, input, now + 2),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(await claims(input.requestId)).toHaveLength(1);
      expect(
        await claimTestPaymentWork(db, context, input, now + 60_000),
      ).toMatchObject({ replayed: true, claimedAt: now + 2 });
    },
  );
  it("rolls back claim and work on trigger failure and never reports zero-write adapters as success", async () => {
    const item = await attempt();
    const input = command(item.started.requestId);
    const before = await business();
    const initial = await work(input.requestId);
    await db
      .prepare(
        "CREATE TRIGGER work_claim_fixture_failure AFTER INSERT ON commerce_payment_work_claims BEGIN SELECT RAISE(ABORT,'fictional failure'); END",
      )
      .run();
    try {
      await expect(
        claimTestPaymentWork(db, context, input, now + 2),
      ).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      await db.prepare("DROP TRIGGER work_claim_fixture_failure").run();
    }
    expect(await work(input.requestId)).toEqual(initial);
    expect(await claims(input.requestId)).toEqual([]);
    await expect(
      claimTestPaymentWork(
        {
          prepare: db.prepare.bind(db),
          batch: async () => [],
        } as unknown as D1Database,
        context,
        input,
        now + 2,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await work(input.requestId)).toEqual(initial);
    expect(await claims(input.requestId)).toEqual([]);
    expect(await business()).toEqual(before);
  });
  it("protects work identity/version/phase and append-only claims against direct edits, deletes and replacement", async () => {
    const item = await attempt();
    const input = command(item.started.requestId);
    await claimTestPaymentWork(db, context, input, now + 2);
    const initial = await work(input.requestId),
      saved = await claims(input.requestId),
      before = await business();
    for (const sql of [
      "UPDATE commerce_payment_work SET version=1 WHERE attempt_command_id=?",
      "UPDATE commerce_payment_work SET version=version+1 WHERE attempt_command_id=?",
      "UPDATE commerce_payment_work SET next_operation='create' WHERE attempt_command_id=?",
      "UPDATE commerce_payment_work SET current_claim_id=NULL WHERE attempt_command_id=?",
      "UPDATE commerce_payment_work SET attempt_command_id='wrong' WHERE attempt_command_id=?",
      "DELETE FROM commerce_payment_work WHERE attempt_command_id=?",
      "INSERT OR REPLACE INTO commerce_payment_work SELECT * FROM commerce_payment_work WHERE attempt_command_id=?",
      "UPDATE commerce_payment_work_claims SET claimed_at=claimed_at+1 WHERE attempt_command_id=?",
      "UPDATE commerce_payment_work_claims SET worker_id='33333333-3333-4333-8333-333333333333' WHERE attempt_command_id=?",
      "DELETE FROM commerce_payment_work_claims WHERE attempt_command_id=?",
      "INSERT OR REPLACE INTO commerce_payment_work_claims SELECT * FROM commerce_payment_work_claims WHERE attempt_command_id=?",
    ])
      await expect(
        db.prepare(sql).bind(`payment-start-${input.requestId}`).run(),
      ).rejects.toThrow();
    await expect(
      rawClaim({ ...input, claimId: crypto.randomUUID() }, now + 2),
    ).rejects.toThrow();
    expect(await work(input.requestId)).toEqual(initial);
    expect(await claims(input.requestId)).toEqual(saved);
    expect(await business()).toEqual(before);
  });
  it("rejects fresh-work replacement and an initial record forged for a different identity", async () => {
    const item = await attempt();
    const initial = await work(item.started.requestId);
    for (const sql of [
      "INSERT OR REPLACE INTO commerce_payment_work SELECT * FROM commerce_payment_work WHERE attempt_command_id=?",
      "UPDATE commerce_payment_work SET next_operation='query',version=version+1 WHERE attempt_command_id=?",
      "DELETE FROM commerce_payment_work WHERE attempt_command_id=?",
    ])
      await expect(
        db.prepare(sql).bind(`payment-start-${item.started.requestId}`).run(),
      ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT INTO commerce_payment_work(attempt_command_id) VALUES ('payment-start-nonexistent')",
        )
        .run(),
    ).rejects.toThrow();
    expect(await work(item.started.requestId)).toEqual(initial);
  });
  it("rejects direct claim invalid scope, kind, lease duration and backwards time", async () => {
    const item = await attempt();
    const input = command(item.started.requestId);
    await expect(
      rawClaim(input, now + 2, "create", {
        ...context,
        instanceId: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      rawClaim(input, now + 2, "create", {
        ...context,
        accountRef: "fixture-other",
      }),
    ).rejects.toThrow();
    await expect(rawClaim(input, now + 2, "query")).rejects.toThrow();
    await expect(
      db
        .prepare(
          `INSERT INTO commerce_payment_work_claims(claim_id,attempt_command_id,worker_id,request_hash,mode,instance_id,provider,account_ref,expected_version,kind,claimed_at,lease_until)
      VALUES (?,?,?,?,'local-test',?,'stripe','fixture-stripe',1,'create',?,?)`,
        )
        .bind(
          input.claimId,
          `payment-start-${input.requestId}`,
          workerId,
          "b".repeat(64),
          instanceId,
          now + 2,
          now + 30_003,
        )
        .run(),
    ).rejects.toThrow();
    expect(await claims(input.requestId)).toEqual([]);
    expect(await work(input.requestId)).toMatchObject({ version: 1 });
  });
  it("strictly validates context, request shapes and bounded versions/clocks before touching D1", async () => {
    const prepare = vi.fn();
    const absent = { prepare } as unknown as D1Database;
    const input = command(historical[0].started.requestId);
    const accessor = { ...input };
    Object.defineProperty(accessor, "claimId", {
      get() {
        return input.claimId;
      },
      enumerable: true,
    });
    const cases: [unknown, unknown, number][] = [
      [null, input, now],
      [{ ...context, mode: "sandbox" }, input, now],
      [{ ...context, extra: true }, input, now],
      [Object.create(context), input, now],
      [{ ...context, workerId: "not-a-uuid" }, input, now],
      [{ ...context, instanceId: "not-a-uuid" }, input, now],
      [{ ...context, accountRef: "acct_real-looking" }, input, now],
      [context, null, now],
      [context, accessor, now],
      [context, { ...input, extra: 1 }, now],
      [context, { ...input, [Symbol("hidden")]: true }, now],
      [
        context,
        { ...input, claimId: "11111111-1111-1111-8111-111111111111" },
        now,
      ],
      [context, { ...input, requestId: "not-a-uuid" }, now],
      [context, { ...input, expectedVersion: 0 }, now],
      [context, { ...input, expectedVersion: 1.5 }, now],
      [context, { ...input, expectedVersion: "1" }, now],
      [context, { ...input, expectedVersion: Number.MAX_SAFE_INTEGER }, now],
      [context, input, -1],
      [context, input, Number.NaN],
      [context, input, 8_639_999_999_970_001],
    ];
    for (const [trusted, request, time] of cases)
      await expect(
        claimTestPaymentWork(
          absent,
          trusted as TestPaymentWorkContext,
          request as TestPaymentWorkClaimInput,
          time,
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    expect(prepare).not.toHaveBeenCalled();
  });
});
