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
import { beginTestPaymentAttempt } from "./payment-start.server";
import { claimTestPaymentWork } from "./payment-work.server";
import {
  recordTestCaptureFact,
  type TestCaptureFactContext,
  type TestCaptureFactInput,
} from "./capture-facts.server";

import { captureFactDescriptor } from "./capture-fact-descriptor.server";
import {
  recordTestPaymentObservation,
  type TestPaymentObservationInput,
} from "./payment-observations.server";
import {
  processTestPaymentObservation,
  type TestPaymentProcessingContext,
  type TestPaymentProcessingInput,
} from "./observation-processing.server";

const root = resolve(process.cwd());
const now = 1_800_000_000_000;
const ownerHash = "a".repeat(64);
const instanceId = "11111111-1111-4111-8111-111111111111";
const workerId = "22222222-2222-4222-8222-222222222222";
const context: TestCaptureFactContext = {
  mode: "local-test",
  instanceId,
  provider: "stripe",
  accountRef: "fixture-stripe",
  workerId,
};
let directory: string;
let configPath: string;
let platform: PlatformProxy<Env>;
let db: D1Database;
let sequence = 0;
let historical: Awaited<ReturnType<typeof claimed>>[];
let beforeUpgrade: unknown;
let absentScopeReads: string[];
let oldHistory: unknown;
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
async function reserved() {
  const id = `capture-fixture-${++sequence}`;
  const product = await db
    .prepare(
      `INSERT INTO products(name,slug,price_cents,quantity,category_id,status,created_at,updated_at)
    VALUES ('Fictional capture test',?,999,999,1,'draft',1,1) RETURNING id`,
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
    ownerHash,
    [{ variantId: id, quantity: 1 }],
    "pickup",
    now,
  );
  const order = await reserveTestOrder(db, ownerHash, quote.id, now);
  return { id, quote, order };
}
async function claimed(provider: "stripe" | "paypal" = "stripe") {
  const item = await reserved();
  const trusted = { ...context, provider, accountRef: `fixture-${provider}` };
  const started = await beginTestPaymentAttempt(
    db,
    {
      mode: trusted.mode,
      instanceId,
      provider,
      accountRef: trusted.accountRef,
      ownerHash,
    },
    {
      requestId: crypto.randomUUID(),
      reference: item.order.id,
      expectedVersion: 1,
    },
    now + 1,
  );
  const claim = await claimTestPaymentWork(
    db,
    trusted,
    {
      claimId: crypto.randomUUID(),
      requestId: started.requestId,
      expectedVersion: 1,
    },
    now + 2,
  );
  return { ...item, trusted, started, claim };
}
function input(item = historical[0]): TestCaptureFactInput {
  return {
    requestId: item.started.requestId,
    claimId: item.claim.claimId,
    providerObjectRef: `fixture-object-${crypto.randomUUID()}`,
    transactionRef: `fixture-transaction-${crypto.randomUUID()}`,
    amountCents: 2500,
    currency: "CAD",
  };
}
async function table(name: string) {
  return (await db.prepare(`SELECT * FROM ${name} ORDER BY 1,2`).all()).results;
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
      "commerce_payment_work",
      "commerce_payment_work_claims",
      "commerce_payment_scope",
    ].map(table),
  );
}
function adapter(
  change: Partial<Pick<D1Database, "prepare" | "batch">>,
): D1Database {
  return {
    prepare: db.prepare.bind(db),
    batch: db.batch.bind(db),
    ...change,
  } as D1Database;
}

type Item = Awaited<ReturnType<typeof claimed>>;
function processingContext(
  item: Item = historical[0],
): TestPaymentProcessingContext {
  return {
    mode: "local-test",
    instanceId,
    provider: item.trusted.provider,
    accountRef: item.trusted.accountRef,
  };
}
async function observation(
  item: Item = historical[0],
  changes: Partial<TestPaymentObservationInput> = {},
) {
  const fact = input(item);
  const command: TestPaymentObservationInput = {
    observationId: crypto.randomUUID(),
    requestId: fact.requestId,
    claimId: fact.claimId,
    kind: "captured",
    providerObjectRef: fact.providerObjectRef,
    capture: {
      transactionRef: fact.transactionRef,
      amountCents: fact.amountCents,
      currency: fact.currency,
    },
    ...changes,
  };
  await recordTestPaymentObservation(db, item.trusted, command, now + 3);
  return command;
}
function processObservation(
  item: Item,
  command: TestPaymentProcessingInput,
  time = now + 4,
  database = db,
) {
  return processTestPaymentObservation(
    database,
    processingContext(item),
    { observationId: command.observationId },
    time,
  );
}
function factInput(command: TestPaymentObservationInput): TestCaptureFactInput {
  return {
    requestId: command.requestId,
    claimId: command.claimId,
    providerObjectRef: command.providerObjectRef!,
    ...command.capture!,
  };
}
async function history() {
  return Promise.all(
    ["commerce_payment_capture_facts", "commerce_payment_observations"].map(
      table,
    ),
  );
}
async function insert(
  tableName: string,
  values: Record<string, unknown>,
  replace = false,
) {
  return db
    .prepare(
      `${replace ? "INSERT OR REPLACE" : "INSERT"} INTO ${tableName} (${Object.keys(values).join(",")}) VALUES (${Object.keys(
        values,
      )
        .map(() => "?")
        .join(",")})`,
    )
    .bind(...Object.values(values))
    .run();
}
async function descriptor(item: Item, command: TestPaymentObservationInput) {
  return captureFactDescriptor(processingContext(item), {
    attemptCommandId: `payment-start-${command.requestId}`,
    reference: item.order.id,
    providerObjectRef: command.providerObjectRef!,
    ...command.capture!,
    expectedAmountCents: 2500,
    expectedCurrency: "CAD",
  });
}
async function rawFact(
  item: Item,
  command: TestPaymentObservationInput,
  changes: Record<string, unknown> = {},
) {
  const d = await descriptor(item, command);
  return insert("commerce_payment_capture_facts", {
    id: d.id,
    attempt_command_id: `payment-start-${command.requestId}`,
    source_claim_id: command.claimId,
    source_worker_id: item.trusted.workerId,
    mode: "local-test",
    instance_id: instanceId,
    provider: item.trusted.provider,
    account_ref: item.trusted.accountRef,
    provider_object_ref: command.providerObjectRef,
    transaction_ref: command.capture!.transactionRef,
    actual_amount_cents: command.capture!.amountCents,
    actual_currency: command.capture!.currency,
    expected_amount_cents: 2500,
    expected_currency: "CAD",
    amount_match: d.amountMatch,
    payload_hash: d.payloadHash,
    recorded_at: now + 4,
    ...changes,
  });
}
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "jewelry-observation-processing-"));
  const migrations = join(directory, "migrations");
  mkdirSync(migrations);
  for (const file of readdirSync(join(root, "migrations")).filter(
    (file) => file.endsWith(".sql") && file < "0013",
  ))
    copyFileSync(join(root, "migrations", file), join(migrations, file));
  configPath = join(directory, "wrangler.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "fictional-observation-processing-test",
      compatibility_date: "2026-09-29",
      d1_databases: [
        {
          binding: "DB",
          database_name: "fictional-observation-processing-test",
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
    processTestPaymentObservation(
      adapter({
        prepare(sql) {
          absentScopeReads.push(sql);
          return db.prepare(sql);
        },
      }),
      {
        mode: "local-test",
        instanceId,
        provider: "stripe",
        accountRef: "fixture-stripe",
      },
      { observationId: crypto.randomUUID() },
      now,
    ),
  ).rejects.toMatchObject({ code: "unavailable" });
  await db
    .prepare(
      "INSERT INTO commerce_payment_scope(id,mode,instance_id,stripe_account_ref,paypal_account_ref) VALUES (1,'local-test',?,'fixture-stripe','fixture-paypal')",
    )
    .bind(instanceId)
    .run();
  historical = [await claimed(), await claimed("paypal")];
  const old = await observation();
  await recordTestCaptureFact(
    db,
    historical[0].trusted,
    { ...factInput(old), amountCents: 2499 },
    now + 3,
  );
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
  oldHistory = await history();
  await platform.dispose();
  copyFileSync(
    join(root, "migrations/0013_commerce_observation_results.sql"),
    join(migrations, "0013_commerce_observation_results.sql"),
  );
  migrate();
  await connect();
}, 30000);
afterAll(async () => {
  await platform?.dispose();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("internal atomic observation processing on real temporary D1", () => {
  it("upgrades 0001–0012 without changing old observations, mismatched finance, recovery audit or other business data", async () => {
    expect(await business()).toEqual(beforeUpgrade);
    expect(await history()).toEqual(oldHistory);
    expect(await table("commerce_payment_observation_results")).toEqual([]);
    expect(absentScopeReads).toHaveLength(1);
    expect(absentScopeReads[0]).toContain("commerce_payment_scope");
  });
  it("retains the v1 golden identity and payload property order", async () => {
    expect(
      await captureFactDescriptor(
        {
          mode: "local-test",
          instanceId,
          provider: "stripe",
          accountRef: "fixture-stripe",
        },
        {
          attemptCommandId:
            "payment-start-22222222-2222-4222-8222-222222222222",
          reference: "order-33333333-3333-4333-8333-333333333333",
          providerObjectRef: "fixture-object",
          transactionRef: "fixture-transaction",
          amountCents: 2500,
          currency: "CAD",
          expectedAmountCents: 2500,
          expectedCurrency: "CAD",
        },
      ),
    ).toEqual({
      id: "a438effaff8b79e1b87718514d8bdf116c14791294e93c93b1553217f9a21396",
      payloadHash:
        "8fe0073c8ab0e31ca4304b49c49568ab9d3888d6eb6abc175bbbcf5eb26e1015",
      amountMatch: "match",
    });
  });
  it.each(["stripe", "paypal"] as const)(
    "processes all six %s kinds with minimal receipts and unchanged work/order/stock",
    async (provider) => {
      const item = await claimed(provider),
        before = await business();
      for (const kind of [
        "unknown",
        "not_found",
        "pending",
        "approved",
        "reported_failed",
        "captured",
      ] as const) {
        const command = await observation(item, {
          kind,
          ...(kind === "captured" ? {} : { capture: null }),
          ...(["unknown", "not_found"].includes(kind)
            ? { providerObjectRef: null }
            : {}),
        });
        const r = await processObservation(item, command);
        expect(r).toEqual({
          testOnly: true,
          observationId: command.observationId,
          requestId: item.started.requestId,
          reference: item.order.id,
          provider,
          kind,
          outcome: kind === "captured" ? "capture_fact" : "observation_only",
          factId:
            kind === "captured"
              ? expect.stringMatching(/^[a-f0-9]{64}$/)
              : null,
          amountMismatch: false,
          additionalCaptureAtProcessing: false,
          processedAt: now + 4,
          replayed: false,
        });
        expect(await processObservation(item, command, now + 3)).toEqual({
          ...r,
          replayed: true,
        });
      }
      expect(await business()).toEqual(before);
    },
  );
  it("deduplicates simultaneous processing of one observation", async () => {
    const item = await claimed(),
      o = await observation(item);
    const results = await Promise.all([
      processObservation(item, o),
      processObservation(item, o),
    ]);
    expect(results[0]).toEqual({
      ...results[1],
      replayed: results[0].replayed,
    });
    expect(results.some((r) => r.replayed)).toBe(true);
    expect(
      (
        await db
          .prepare(
            "SELECT * FROM commerce_payment_observation_results WHERE observation_id=?",
          )
          .bind(o.observationId)
          .all()
      ).results,
    ).toHaveLength(1);
  });
  it("deduplicates different concurrent observations of one transaction but retains both sources", async () => {
    const item = await claimed(),
      first = await observation(item),
      second = await observation(item, {
        ...first,
        observationId: crypto.randomUUID(),
      });
    const [a, b] = await Promise.all([
      processObservation(item, first),
      processObservation(item, second),
    ]);
    expect(a.factId).toBe(b.factId);
    expect(a.outcome).toBe("capture_fact");
    expect(b.outcome).toBe("capture_fact");
    const facts = await db
      .prepare(
        "SELECT * FROM commerce_payment_capture_facts WHERE attempt_command_id=?",
      )
      .bind(`payment-start-${item.started.requestId}`)
      .all();
    expect(facts.results).toHaveLength(1);
    expect(
      (
        await db
          .prepare(
            "SELECT * FROM commerce_payment_observation_results WHERE attempt_command_id=?",
          )
          .bind(`payment-start-${item.started.requestId}`)
          .all()
      ).results,
    ).toHaveLength(2);
  });
  it.each([
    { amountCents: 2499, currency: "CAD" },
    { amountCents: 2500, currency: "USD" },
  ])("retains actual mismatched captures %j", async (capture) => {
    const item = await claimed(),
      o = await observation(item, {
        capture: {
          transactionRef: `fixture-${crypto.randomUUID()}`,
          ...capture,
        },
      });
    const r = await processObservation(item, o);
    expect(r).toMatchObject({ outcome: "capture_fact", amountMismatch: true });
    expect(
      await recordTestCaptureFact(db, item.trusted, factInput(o), now + 5),
    ).toMatchObject({
      factId: r.factId,
      amountMatch: "mismatch",
      replayed: true,
    });
  });
  it.each(["amount", "currency", "object", "attempt"] as const)(
    "persists %s conflicts with stable flags and source",
    async (change) => {
      const item = await claimed(),
        o = await observation(item);
      await processObservation(item, o);
      const target = change === "attempt" ? await claimed() : item;
      const bad = await observation(target, {
        providerObjectRef:
          change === "object" ? "fixture-other-object" : o.providerObjectRef,
        capture: {
          ...o.capture!,
          ...(change === "amount" ? { amountCents: 2499 } : {}),
          ...(change === "currency" ? { currency: "USD" } : {}),
        },
      });
      const r = await processObservation(target, bad);
      expect(r).toMatchObject({
        outcome: "capture_conflict",
        factId: null,
        amountMismatch: ["amount", "currency"].includes(change),
        additionalCaptureAtProcessing: false,
      });
      expect(await processObservation(target, bad, now + 3)).toEqual({
        ...r,
        replayed: true,
      });
      expect(
        await db
          .prepare(
            "SELECT * FROM commerce_payment_observations WHERE observation_id=?",
          )
          .bind(bad.observationId)
          .first(),
      ).not.toBeNull();
    },
  );
  it.each([false, true])(
    "preserves different transactions on the same order (concurrent=%s) and freezes historical extra flags",
    async (concurrent) => {
      const item = await claimed(),
        a = await observation(item),
        b = await observation(item);
      const receipts = concurrent
        ? await Promise.all([
            processObservation(item, a),
            processObservation(item, b),
          ])
        : [
            await processObservation(item, a),
            await processObservation(item, b),
          ];
      expect(
        receipts.map((r) => r.additionalCaptureAtProcessing).sort(),
      ).toEqual([false, true]);
      expect(receipts[0].factId).not.toBe(receipts[1].factId);
      for (const [i, o] of [a, b].entries())
        expect(await processObservation(item, o, now + 3)).toEqual({
          ...receipts[i],
          replayed: true,
        });
      const unrelated = await claimed();
      expect(
        await processObservation(unrelated, await observation(unrelated)),
      ).toMatchObject({ additionalCaptureAtProcessing: false });
    },
  );
  it("counts across provider/attempt boundaries in an explicit diagnostic fixture, without changing production eligibility", async () => {
    const first = await claimed(),
      second = await claimed("paypal");
    await processObservation(first, await observation(first));
    const o = await observation(second);
    // Ordinary commands still enforce one intent per order. Temporarily alias an
    // immutable attempt only inside this disposable diagnostic database, then restore.
    await db
      .prepare("DROP INDEX commerce_payment_attempts_one_per_order")
      .run();
    await db.prepare("DROP TRIGGER commerce_payment_attempts_no_update").run();
    try {
      await db
        .prepare(
          "UPDATE commerce_payment_attempts SET order_id=? WHERE command_id=?",
        )
        .bind(first.order.id, `payment-start-${second.started.requestId}`)
        .run();
      const r = await processObservation(second, o);
      expect(r).toMatchObject({
        additionalCaptureAtProcessing: true,
        reference: first.order.id,
      });
    } finally {
      await db
        .prepare(
          "UPDATE commerce_payment_attempts SET order_id=? WHERE command_id=?",
        )
        .bind(second.order.id, `payment-start-${second.started.requestId}`)
        .run();
      await db
        .prepare(
          "CREATE UNIQUE INDEX commerce_payment_attempts_one_per_order ON commerce_payment_attempts(order_id)",
        )
        .run();
      await db
        .prepare(
          "CREATE TRIGGER commerce_payment_attempts_no_update BEFORE UPDATE ON commerce_payment_attempts BEGIN SELECT RAISE(ABORT,'commerce_payment_attempt_immutable'); END",
        )
        .run();
    }
  });
  it("interoperates with the old capture API in both directions and preserves original fact provenance", async () => {
    for (const apiFirst of [true, false]) {
      const item = await claimed(),
        o = await observation(item);
      if (apiFirst)
        await recordTestCaptureFact(db, item.trusted, factInput(o), now + 3);
      const r = await processObservation(item, o);
      const f = await recordTestCaptureFact(
        db,
        item.trusted,
        factInput(o),
        now + 5,
      );
      expect(f).toMatchObject({
        factId: r.factId,
        replayed: true,
        recordedAt: apiFirst ? now + 3 : now + 4,
      });
    }
  });
  it("processes late original-worker observations after a replacement claim and order evolution without altering current work", async () => {
    const item = await claimed(),
      o = await observation(item);
    await claimTestPaymentWork(
      db,
      { ...item.trusted, workerId: crypto.randomUUID() },
      {
        claimId: crypto.randomUUID(),
        requestId: item.started.requestId,
        expectedVersion: 2,
      },
      now + 30_002,
    );
    await db
      .prepare(
        "UPDATE commerce_orders SET state='cancelled',version=version+1 WHERE id=?",
      )
      .bind(item.order.id)
      .run();
    const before = await business();
    expect(await processObservation(item, o, now + 31_000)).toMatchObject({
      outcome: "capture_fact",
    });
    expect(await business()).toEqual(before);
    const later = await observation(item, {
      kind: "reported_failed",
      capture: null,
    });
    expect(await processObservation(item, later, now + 32_000)).toMatchObject({
      outcome: "observation_only",
    });
    expect(
      (
        await db
          .prepare(
            "SELECT * FROM commerce_payment_capture_facts WHERE attempt_command_id=?",
          )
          .bind(`payment-start-${item.started.requestId}`)
          .all()
      ).results,
    ).toHaveLength(1);
  });
  it("gives conflict precedence when candidate id and natural tuple hit different facts", async () => {
    const item = await claimed(),
      o = await observation(item),
      d = await descriptor(item, o);
    await rawFact(item, o, {
      transaction_ref: "fixture-collision-other",
      payload_hash: "c".repeat(64),
    });
    await rawFact(item, o, { id: "f".repeat(64) });
    expect(await processObservation(item, o)).toMatchObject({
      outcome: "capture_conflict",
      factId: null,
    });
    expect(
      (
        await db
          .prepare(
            "SELECT id FROM commerce_payment_capture_facts WHERE id=? OR transaction_ref=?",
          )
          .bind(d.id, o.capture!.transactionRef)
          .all()
      ).results,
    ).toHaveLength(2);
  });
});

function alteredRows(
  match: string,
  changes: Record<string, unknown>,
): D1Database {
  function wrap(statement: D1PreparedStatement): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values));
        if (key === "first")
          return async <T>() => {
            const result = await target.first<Record<string, unknown>>();
            return (result ? { ...result, ...changes } : null) as T | null;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  return adapter({
    prepare(sql) {
      const statement = db.prepare(sql);
      return sql.includes(match) ? wrap(statement) : statement;
    },
  });
}

describe("scope, immutable sources, strict inputs and durable recovery", () => {
  it("checks scope before any business lookup, and source before result lookup even on replay", async () => {
    const item = await claimed(),
      o = await observation(item);
    await processObservation(item, o);
    const reads: string[] = [];
    const wrapped = adapter({
      prepare(sql) {
        reads.push(sql);
        if (sql.includes("FROM commerce_payment_observation_results"))
          throw new Error("must not read a result without source proof");
        return db.prepare(sql);
      },
    });
    await expect(
      processTestPaymentObservation(
        wrapped,
        { ...processingContext(item), accountRef: "fixture-other" },
        { observationId: o.observationId },
        now + 5,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain("commerce_payment_scope");
    reads.length = 0;
    await expect(
      processTestPaymentObservation(
        wrapped,
        {
          ...processingContext(item),
          provider: "paypal",
          accountRef: "fixture-paypal",
        },
        { observationId: o.observationId },
        now + 5,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(reads).toHaveLength(2);
    await expect(
      processObservation(item, { observationId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
  it.each([
    { source_worker_id: crypto.randomUUID() },
    { source_claim_id: crypto.randomUUID() },
    { claimAttempt: "payment-start-other" },
    { claimMode: "other" },
    { claimInstance: crypto.randomUUID() },
    { claimProvider: "paypal" },
    { claimAccount: "fixture-other" },
    { claimWorker: crypto.randomUUID() },
    { attemptMode: "other" },
    { attemptInstance: crypto.randomUUID() },
    { attemptProvider: "paypal" },
    { attemptAccount: "fixture-other" },
    { requestId: crypto.randomUUID() },
    { reference: "order-bad" },
    { expectedAmount: 0 },
    { expectedCurrency: "USD" },
    { claimedAt: now + 4 },
    { occurredAt: now + 3 },
    { recorded_at: now + 5 },
    { kind: "paid" },
    { kind: "pending" },
    { amount_cents: null },
    { request_hash: "b".repeat(64) },
  ])(
    "rejects a tampered source before any old-result replay: %j",
    async (changes) => {
      const item = historical[0],
        o = await observation(item);
      await processObservation(item, o);
      const batch = vi.fn();
      const wrapped = alteredRows("SELECT o.*", changes);
      await expect(
        processObservation(
          item,
          o,
          now + 4,
          adapter({ prepare: wrapped.prepare.bind(wrapped), batch }),
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(batch).not.toHaveBeenCalled();
    },
  );
  it("rejects accessors, inherited/extra/symbol fields, worker impersonation and invalid bounds synchronously before database access", async () => {
    const context = processingContext(),
      valid = { observationId: crypto.randomUUID() };
    const getter = Object.defineProperty({}, "observationId", {
      enumerable: true,
      get() {
        throw new Error("getter invoked");
      },
    });
    const invalid: unknown[] = [
      null,
      [],
      "x",
      {},
      { ...valid, extra: 1 },
      { ...valid, [Symbol("x")]: 1 },
      Object.create(valid),
      getter,
      { observationId: "bad" },
    ];
    const prepare = vi.fn(() => {
      throw new Error("database touched");
    });
    const wrapped = adapter({ prepare });
    for (const value of invalid)
      await expect(
        processTestPaymentObservation(
          wrapped,
          context,
          value as TestPaymentProcessingInput,
          now,
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    for (const value of [
      null,
      [],
      Object.create(context),
      { ...context, workerId },
      { ...context, mode: "production" },
      { ...context, provider: "other" },
      { ...context, instanceId: "bad" },
      { ...context, accountRef: "real-account" },
      { ...context, accountRef: "fixture-" },
      { ...context, accountRef: `fixture-${"x".repeat(93)}` },
      { ...context, accountRef: "fixture-x.y" },
      { ...context, [Symbol("x")]: true },
      Object.defineProperty({ ...context }, "accountRef", {
        get() {
          throw new Error("getter invoked");
        },
      }),
    ])
      await expect(
        processTestPaymentObservation(
          wrapped,
          value as TestPaymentProcessingContext,
          valid,
          now,
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    for (const time of [-1, NaN, Infinity, 1.1, 8_640_000_000_000_001])
      await expect(
        processTestPaymentObservation(wrapped, context, valid, time),
      ).rejects.toMatchObject({ code: "invalid_request" });
    expect(prepare).not.toHaveBeenCalled();
  });
  it("copies data before await, accepts null prototypes and fixes hash insertion order", async () => {
    const item = await claimed(),
      o = await observation(item);
    const context = Object.assign(Object.create(null), {
      accountRef: item.trusted.accountRef,
      provider: item.trusted.provider,
      instanceId,
      mode: "local-test",
    }) as TestPaymentProcessingContext;
    const input = Object.assign(Object.create(null), {
      observationId: o.observationId,
    }) as TestPaymentProcessingInput;
    const pending = processTestPaymentObservation(db, context, input, now + 4);
    context.accountRef = "fixture-other";
    input.observationId = crypto.randomUUID();
    const r = await pending;
    expect(r).toMatchObject({
      observationId: o.observationId,
      outcome: "capture_fact",
    });
    expect(await processObservation(item, o, now + 3)).toEqual({
      ...r,
      replayed: true,
    });
  });
  it("rejects a clock before the observation even on replay, but preserves a later original processing time", async () => {
    const item = await claimed(),
      o = await observation(item);
    await expect(processObservation(item, o, now + 2)).rejects.toMatchObject({
      code: "conflict",
    });
    const r = await processObservation(item, o, maxClock);
    expect(await processObservation(item, o, now + 3)).toEqual({
      ...r,
      replayed: true,
      processedAt: maxClock,
    });
    await expect(processObservation(item, o, now + 2)).rejects.toMatchObject({
      code: "conflict",
    });
  });
  it.each([
    { observation_id: crypto.randomUUID() },
    { attempt_command_id: "payment-start-other" },
    { mode: "other" },
    { instance_id: crypto.randomUUID() },
    { provider: "paypal" },
    { account_ref: "fixture-other" },
    { request_hash: "a".repeat(64) },
    { candidate_fact_id: "a".repeat(64) },
    { payload_hash: "a".repeat(64) },
    { fact_id: null },
    { outcome: "observation_only" },
    { outcome: null },
    { amount_mismatch: 1 },
    { additional_capture_at_processing: null },
    { additional_capture_at_processing: 2 },
    { processed_at: now + 2 },
    { processed_at: Infinity },
  ])(
    "checks durable result identity, witnesses, type and stable flags: %j",
    async (changes) => {
      const item = await claimed(),
        o = await observation(item);
      await processObservation(item, o);
      await expect(
        processObservation(
          item,
          o,
          now + 5,
          alteredRows(
            "SELECT * FROM commerce_payment_observation_results",
            changes,
          ),
        ),
      ).rejects.toMatchObject({ code: "conflict" });
    },
  );
  it("rolls back the first fact when the second batch statement fails", async () => {
    const item = await claimed(),
      o = await observation(item),
      facts = await table("commerce_payment_capture_facts"),
      before = await business();
    await db
      .prepare(
        "CREATE TRIGGER processing_fixture_failure AFTER INSERT ON commerce_payment_observation_results BEGIN SELECT RAISE(ABORT,'fictional second statement failure'); END",
      )
      .run();
    try {
      await expect(processObservation(item, o)).rejects.toMatchObject({
        code: "unavailable",
      });
    } finally {
      await db.prepare("DROP TRIGGER processing_fixture_failure").run();
    }
    expect(await table("commerce_payment_capture_facts")).toEqual(facts);
    expect(await business()).toEqual(before);
    expect(await processObservation(item, o, now + 5)).toMatchObject({
      replayed: false,
      processedAt: now + 5,
    });
  });
  it("recovers a lost successful batch response using only the original observation id", async () => {
    const item = await claimed(),
      o = await observation(item);
    const wrapped = adapter({
      async batch<T>(
        statements: D1PreparedStatement[],
      ): Promise<D1Result<T>[]> {
        await db.batch<T>(statements);
        throw new Error("lost response");
      },
    });
    const r = await processObservation(item, o, now + 4, wrapped);
    expect(r).toMatchObject({ replayed: true, processedAt: now + 4 });
    expect(await processObservation(item, o, now + 5)).toEqual(r);
  });
  it.each([true, false])(
    "remains retryable when committed=%s and response plus readback are unavailable",
    async (committed) => {
      const item = await claimed(),
        o = await observation(item);
      let afterBatch = false;
      const wrapped = adapter({
        prepare(sql) {
          if (
            afterBatch &&
            sql.includes("FROM commerce_payment_observation_results")
          )
            throw new Error("offline readback");
          return db.prepare(sql);
        },
        async batch<T>(
          statements: D1PreparedStatement[],
        ): Promise<D1Result<T>[]> {
          if (committed) await db.batch<T>(statements);
          afterBatch = true;
          throw new Error("response lost");
        },
      });
      await expect(
        processObservation(item, o, now + 4, wrapped),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(await processObservation(item, o, now + 5)).toMatchObject({
        replayed: committed,
        processedAt: committed ? now + 4 : now + 5,
      });
    },
  );
  it("requires durable readback even after a successful batch", async () => {
    const item = await claimed(),
      o = await observation(item);
    let afterBatch = false;
    const wrapped = adapter({
      prepare(sql) {
        if (
          afterBatch &&
          sql.includes("FROM commerce_payment_observation_results")
        )
          throw new Error("offline readback");
        return db.prepare(sql);
      },
      async batch<T>(statements: D1PreparedStatement[]) {
        const r = await db.batch<T>(statements);
        afterBatch = true;
        return r;
      },
    });
    await expect(
      processObservation(item, o, now + 4, wrapped),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await processObservation(item, o)).toMatchObject({ replayed: true });
  });
  it.each([true, false])(
    "never invents a result when a zero-write adapter skips the capture insertion (step2=%s)",
    async (step2) => {
      const item = await claimed(),
        o = await observation(item),
        before = await history();
      const wrapped = adapter({
        async batch<T>(
          statements: D1PreparedStatement[],
        ): Promise<D1Result<T>[]> {
          return step2 ? db.batch<T>(statements.slice(1)) : [];
        },
      });
      await expect(
        processObservation(item, o, now + 4, wrapped),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(await history()).toEqual(before);
      expect(
        await db
          .prepare(
            "SELECT * FROM commerce_payment_observation_results WHERE observation_id=?",
          )
          .bind(o.observationId)
          .first(),
      ).toBeNull();
    },
  );
});
const maxClock = 8_640_000_000_000_000;

let sqlFixture: {
  item: Item;
  o: TestPaymentObservationInput;
  values: Record<string, unknown>;
};
async function rawResult(
  changes: Record<string, unknown> = {},
  replace = false,
) {
  if (!sqlFixture) {
    const item = await claimed(),
      o = await observation(item),
      d = await descriptor(item, o);
    await recordTestCaptureFact(db, item.trusted, factInput(o), now + 4);
    sqlFixture = {
      item,
      o,
      values: {
        observation_id: o.observationId,
        attempt_command_id: `payment-start-${o.requestId}`,
        mode: "local-test",
        instance_id: instanceId,
        provider: "stripe",
        account_ref: "fixture-stripe",
        request_hash: "a".repeat(64),
        outcome: "capture_fact",
        fact_id: d.id,
        candidate_fact_id: d.id,
        payload_hash: d.payloadHash,
        amount_mismatch: 0,
        additional_capture_at_processing: 0,
        processed_at: now + 4,
      },
    };
  }
  return insert(
    "commerce_payment_observation_results",
    { ...sqlFixture.values, ...changes },
    replace,
  );
}
describe("SQL independently protects processing history", () => {
  it.each([
    { observation_id: null },
    { observation_id: crypto.randomUUID() },
    { attempt_command_id: null },
    { attempt_command_id: `payment-start-${crypto.randomUUID()}` },
    { instance_id: crypto.randomUUID() },
    { mode: null },
    { mode: "production" },
    { provider: "paypal", account_ref: "fixture-paypal" },
    { account_ref: "fixture-other" },
    { request_hash: null },
    { request_hash: "a".repeat(63) },
    { request_hash: "g".repeat(64) },
    { request_hash: 123 },
    { outcome: null },
    { outcome: "paid" },
    {
      outcome: "observation_only",
      fact_id: null,
      candidate_fact_id: null,
      payload_hash: null,
    },
    { outcome: "capture_conflict", fact_id: null },
    { fact_id: null },
    { fact_id: "g".repeat(64) },
    { fact_id: "b".repeat(64) },
    { candidate_fact_id: null },
    { payload_hash: null },
    { candidate_fact_id: null, payload_hash: null },
    { candidate_fact_id: "b".repeat(64) },
    { payload_hash: "b".repeat(64) },
    { candidate_fact_id: "g".repeat(64) },
    { payload_hash: "g".repeat(64) },
    { candidate_fact_id: 1 },
    { amount_mismatch: null },
    { amount_mismatch: 2 },
    { amount_mismatch: 1 },
    { amount_mismatch: 0.5 },
    { additional_capture_at_processing: null },
    { additional_capture_at_processing: 2 },
    { additional_capture_at_processing: 1 },
    { additional_capture_at_processing: 0.5 },
    { processed_at: null },
    { processed_at: now + 2 },
    { processed_at: -1 },
    { processed_at: maxClock + 1 },
    { processed_at: 0.5 },
  ])(
    "rejects forged result binding, null/type/witness/fact/flag/time fields: %j",
    async (change) => {
      const before = await table("commerce_payment_observation_results");
      await expect(rawResult(change)).rejects.toThrow();
      expect(await table("commerce_payment_observation_results")).toEqual(
        before,
      );
    },
  );
  it("rejects a fabricated captured conflict with no related economic fact", async () => {
    const item = await claimed(),
      o = await observation(item),
      d = await descriptor(item, o);
    await expect(
      rawResult({
        observation_id: o.observationId,
        attempt_command_id: `payment-start-${o.requestId}`,
        outcome: "capture_conflict",
        fact_id: null,
        candidate_fact_id: d.id,
        payload_hash: d.payloadHash,
      }),
    ).rejects.toThrow();
    expect(
      await db
        .prepare(
          "SELECT * FROM commerce_payment_observation_results WHERE observation_id=?",
        )
        .bind(o.observationId)
        .first(),
    ).toBeNull();
  });
  it("requires noncaptured results to have null financial witnesses and false flags", async () => {
    const item = await claimed(),
      o = await observation(item, { kind: "approved", capture: null });
    const common = {
      observation_id: o.observationId,
      attempt_command_id: `payment-start-${o.requestId}`,
      outcome: "observation_only",
      fact_id: null,
      candidate_fact_id: null,
      payload_hash: null,
    };
    for (const change of [
      { candidate_fact_id: "c".repeat(64), payload_hash: "d".repeat(64) },
      { amount_mismatch: 1 },
      { additional_capture_at_processing: 1 },
      { outcome: "capture_conflict" },
    ])
      await expect(rawResult({ ...common, ...change })).rejects.toThrow();
    await rawResult(common);
  });
  it("independently recomputes the historical extra-capture flag across the same order", async () => {
    const item = sqlFixture.item,
      o = await observation(item);
    await recordTestCaptureFact(db, item.trusted, factInput(o), now + 4);
    await expect(rawResult()).rejects.toThrow();
    await rawResult({ additional_capture_at_processing: 1 });
  });
  it("forbids UPDATE, DELETE and REPLACE without disturbing either economic or processing history", async () => {
    const before = await history(),
      results = await table("commerce_payment_observation_results");
    const id = sqlFixture.o.observationId;
    await expect(
      db
        .prepare(
          "UPDATE commerce_payment_observation_results SET processed_at=processed_at+1 WHERE observation_id=?",
        )
        .bind(id)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "DELETE FROM commerce_payment_observation_results WHERE observation_id=?",
        )
        .bind(id)
        .run(),
    ).rejects.toThrow();
    await expect(
      rawResult({ additional_capture_at_processing: 1 }, true),
    ).rejects.toThrow();
    expect(await history()).toEqual(before);
    expect(await table("commerce_payment_observation_results")).toEqual(
      results,
    );
  });
});

describe("shared economic descriptor and distinct historical sources", () => {
  it("snapshots identity, payload and classification before hashing yields", async () => {
    const context = processingContext();
    const fact = {
      attemptCommandId: "payment-start-22222222-2222-4222-8222-222222222222",
      reference: "order-33333333-3333-4333-8333-333333333333",
      providerObjectRef: "fixture-object",
      transactionRef: "fixture-transaction",
      amountCents: 2500,
      currency: "CAD",
      expectedAmountCents: 2500,
      expectedCurrency: "CAD",
    };
    const pending = captureFactDescriptor(context, fact);
    context.accountRef = "fixture-mutated";
    fact.amountCents = 1;
    fact.providerObjectRef = "fixture-mutated";
    expect(await pending).toEqual({
      id: "a438effaff8b79e1b87718514d8bdf116c14791294e93c93b1553217f9a21396",
      payloadHash:
        "8fe0073c8ab0e31ca4304b49c49568ab9d3888d6eb6abc175bbbcf5eb26e1015",
      amountMatch: "match",
    });
  });
  it("keeps the first fact's worker while processing a second observation from a legitimate replacement worker", async () => {
    const item = await claimed(),
      first = await observation(item);
    const a = await processObservation(item, first);
    const trusted = { ...item.trusted, workerId: crypto.randomUUID() };
    const claim = await claimTestPaymentWork(
      db,
      trusted,
      {
        claimId: crypto.randomUUID(),
        requestId: item.started.requestId,
        expectedVersion: 2,
      },
      now + 30_002,
    );
    const second: TestPaymentObservationInput = {
      ...first,
      observationId: crypto.randomUUID(),
      claimId: claim.claimId,
    };
    await recordTestPaymentObservation(db, trusted, second, now + 30_003);
    expect(await processObservation(item, second, now + 30_004)).toMatchObject({
      factId: a.factId,
      outcome: "capture_fact",
    });
    expect(
      await db
        .prepare(
          "SELECT source_claim_id,source_worker_id FROM commerce_payment_capture_facts WHERE id=?",
        )
        .bind(a.factId)
        .first(),
    ).toEqual({
      source_claim_id: first.claimId,
      source_worker_id: item.trusted.workerId,
    });
    expect(
      await recordTestCaptureFact(db, trusted, factInput(second), now + 30_005),
    ).toMatchObject({
      factId: a.factId,
      sourceClaimId: first.claimId,
      replayed: true,
    });
  });
});
