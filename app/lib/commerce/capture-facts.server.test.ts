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
import { applyStockCommand, commandHash } from "./inventory.server";
import { createTestQuote, reserveTestOrder } from "./orders.server";
import { recoverExpiredReservation } from "./reservation-recovery.server";
import { beginTestPaymentAttempt } from "./payment-start.server";
import { claimTestPaymentWork } from "./payment-work.server";
import {
  recordTestCaptureFact,
  type TestCaptureFactContext,
  type TestCaptureFactInput,
} from "./capture-facts.server";

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
async function row(factId: string) {
  return db
    .prepare("SELECT * FROM commerce_payment_capture_facts WHERE id=?")
    .bind(factId)
    .first<Record<string, unknown>>();
}
async function raw(changes: Record<string, unknown> = {}, replace = false) {
  const item = historical[0];
  const values: Record<string, unknown> = {
    id: "c".repeat(64),
    attempt_command_id: `payment-start-${item.started.requestId}`,
    source_claim_id: item.claim.claimId,
    source_worker_id: workerId,
    mode: "local-test",
    instance_id: instanceId,
    provider: "stripe",
    account_ref: "fixture-stripe",
    provider_object_ref: "fixture-direct-object",
    transaction_ref: `fixture-direct-${crypto.randomUUID()}`,
    actual_amount_cents: 2500,
    actual_currency: "CAD",
    expected_amount_cents: 2500,
    expected_currency: "CAD",
    amount_match: "match",
    payload_hash: "d".repeat(64),
    recorded_at: now + 3,
    ...changes,
  };
  return db
    .prepare(
      `${replace ? "INSERT OR REPLACE" : "INSERT"} INTO commerce_payment_capture_facts
    (${Object.keys(values).join(",")}) VALUES (${Object.keys(values)
      .map(() => "?")
      .join(",")})`,
    )
    .bind(...Object.values(values))
    .run();
}
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "jewelry-capture-facts-"));
  const migrations = join(directory, "migrations");
  mkdirSync(migrations);
  for (const file of readdirSync(join(root, "migrations")).filter(
    (file) => file.endsWith(".sql") && file < "0011",
  ))
    copyFileSync(join(root, "migrations", file), join(migrations, file));
  configPath = join(directory, "wrangler.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "fictional-capture-facts-test",
      compatibility_date: "2026-09-29",
      d1_databases: [
        {
          binding: "DB",
          database_name: "fictional-capture-facts-test",
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
    recordTestCaptureFact(
      adapter({
        prepare(sql) {
          absentScopeReads.push(sql);
          return db.prepare(sql);
        },
      }),
      context,
      {
        requestId: crypto.randomUUID(),
        claimId: crypto.randomUUID(),
        providerObjectRef: "fixture-object",
        transactionRef: "fixture-transaction",
        amountCents: 2500,
        currency: "CAD",
      },
      now,
    ),
  ).rejects.toMatchObject({ code: "unavailable" });
  await db
    .prepare(
      "INSERT INTO commerce_payment_scope(id,mode,instance_id,stripe_account_ref,paypal_account_ref) VALUES (1,'local-test',?,'fixture-stripe','fixture-paypal')",
    )
    .bind(instanceId)
    .run();
  historical = [await claimed("stripe"), await claimed("paypal")];
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
    join(root, "migrations/0011_commerce_capture_facts.sql"),
    join(migrations, "0011_commerce_capture_facts.sql"),
  );
  migrate();
  await connect();
}, 30_000);
afterAll(async () => {
  await platform?.dispose();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("internal synthetic capture facts on real temporary D1", () => {
  it("upgrades 0001–0010 with both providers, historical claims and recovered stock without backfilling a financial fact", async () => {
    expect(await business()).toEqual(beforeUpgrade);
    expect(await table("commerce_payment_capture_facts")).toEqual([]);
    expect(absentScopeReads).toHaveLength(1);
    expect(absentScopeReads[0]).toContain("commerce_payment_scope");
  });
  it.each(["stripe", "paypal"] as const)(
    "persists one %s matching fact and returns only economic receipt fields",
    async (provider) => {
      const item = historical.find(
        (item) => item.trusted.provider === provider,
      )!;
      const command = input(item);
      const before = await business();
      const receipt = await recordTestCaptureFact(
        db,
        item.trusted,
        command,
        now + 3,
      );
      const expectedId = await commandHash({
        operation: "test-capture-identity-v1",
        mode: "local-test",
        instanceId,
        provider,
        accountRef: item.trusted.accountRef,
        transactionRef: command.transactionRef,
      });
      expect(receipt).toEqual({
        testOnly: true,
        factId: expectedId,
        requestId: command.requestId,
        sourceClaimId: command.claimId,
        reference: item.order.id,
        provider,
        providerObjectRef: command.providerObjectRef,
        transactionRef: command.transactionRef,
        actualAmountCents: 2500,
        actualCurrency: "CAD",
        expectedAmountCents: 2500,
        expectedCurrency: "CAD",
        amountMatch: "match",
        recordedAt: now + 3,
        replayed: false,
      });
      expect(await row(receipt.factId)).toMatchObject({
        attempt_command_id: `payment-start-${command.requestId}`,
        source_claim_id: command.claimId,
        source_worker_id: workerId,
        actual_amount_cents: 2500,
        expected_amount_cents: 2500,
        amount_match: "match",
      });
      expect(await business()).toEqual(before);
    },
  );
  it.each([
    { amountCents: 2499, currency: "CAD" },
    { amountCents: 2500, currency: "USD" },
    { amountCents: Number.MAX_SAFE_INTEGER, currency: "ZZZ" },
  ])(
    "keeps actual mismatch evidence without changing order/work/stock: %j",
    async (change) => {
      const command = { ...input(), ...change };
      const before = await business();
      const receipt = await recordTestCaptureFact(
        db,
        context,
        command,
        now + 3,
      );
      expect(receipt).toMatchObject({
        actualAmountCents: change.amountCents,
        actualCurrency: change.currency,
        amountMatch: "mismatch",
        expectedAmountCents: 2500,
        expectedCurrency: "CAD",
      });
      expect(await row(receipt.factId)).toMatchObject({
        actual_amount_cents: change.amountCents,
        actual_currency: change.currency,
        amount_match: "mismatch",
      });
      expect(await business()).toEqual(before);
    },
  );
  it("concurrent identical transactions append once and replay original receipt despite later clock and expiry", async () => {
    const command = input();
    const before = await business();
    const receipts = await Promise.all([
      recordTestCaptureFact(db, context, command, now + 4),
      recordTestCaptureFact(db, context, command, now + 5),
    ]);
    expect(receipts.filter((r) => !r.replayed)).toHaveLength(1);
    const first = receipts.find((r) => !r.replayed)!;
    expect(
      receipts.every(
        (r) => r.factId === first.factId && r.recordedAt === first.recordedAt,
      ),
    ).toBe(true);
    expect(
      await recordTestCaptureFact(db, context, command, now + 900_000),
    ).toEqual({ ...first, replayed: true });
    expect(
      (await table("commerce_payment_capture_facts")).filter(
        (r) => r.id === first.factId,
      ),
    ).toHaveLength(1);
    expect(await business()).toEqual(before);
  });
  it("accepts a late old claim after replacement/order change and replays through a new legitimate query worker without rewriting provenance", async () => {
    const item = await claimed();
    const command = input(item);
    const other = { ...context, workerId: crypto.randomUUID() };
    const query = await claimTestPaymentWork(
      db,
      other,
      {
        claimId: crypto.randomUUID(),
        requestId: command.requestId,
        expectedVersion: 2,
      },
      now + 30_002,
    );
    await db
      .prepare(
        "UPDATE commerce_orders SET state='cancelled',payment_state='failed',version=version+1 WHERE id=?",
      )
      .bind(item.order.id)
      .run();
    const before = await business();
    const first = await recordTestCaptureFact(
      db,
      context,
      command,
      now + 900_000,
    );
    const replay = await recordTestCaptureFact(
      db,
      other,
      { ...command, claimId: query.claimId },
      now + 900_001,
    );
    expect(replay).toEqual({ ...first, replayed: true });
    expect(replay.sourceClaimId).toBe(item.claim.claimId);
    expect(await business()).toEqual(before);
    const afterQuery = await claimTestPaymentWork(
      db,
      other,
      {
        claimId: crypto.randomUUID(),
        requestId: command.requestId,
        expectedVersion: 3,
      },
      now + 950_000,
    );
    expect(
      await recordTestCaptureFact(
        db,
        other,
        { ...command, claimId: afterQuery.claimId },
        now + 950_001,
      ),
    ).toEqual({ ...first, replayed: true });
  });
  it("concurrent different historical claims/workers deduplicate one transaction retaining the first proof/time", async () => {
    const item = await claimed();
    const command = input(item);
    const other = { ...context, workerId: crypto.randomUUID() };
    const query = await claimTestPaymentWork(
      db,
      other,
      {
        claimId: crypto.randomUUID(),
        requestId: command.requestId,
        expectedVersion: 2,
      },
      now + 30_002,
    );
    const before = await business();
    const results = await Promise.all([
      recordTestCaptureFact(db, context, command, now + 30_003),
      recordTestCaptureFact(
        db,
        other,
        { ...command, claimId: query.claimId },
        now + 30_004,
      ),
    ]);
    const first = results.find((r) => !r.replayed)!;
    expect(first).toBeDefined();
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(
      results.every(
        (r) =>
          r.factId === first.factId &&
          r.sourceClaimId === first.sourceClaimId &&
          r.recordedAt === first.recordedAt,
      ),
    ).toBe(true);
    expect(await business()).toEqual(before);
  });
  it.each([
    { amountCents: 2499 },
    { currency: "USD" },
    { providerObjectRef: "fixture-changed-object" },
  ])(
    "rejects reuse of one economic identity with changed payload: %j",
    async (change) => {
      const command = input();
      await recordTestCaptureFact(db, context, command, now + 3);
      const before = await table("commerce_payment_capture_facts");
      await expect(
        recordTestCaptureFact(db, context, { ...command, ...change }, now + 4),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await table("commerce_payment_capture_facts")).toEqual(before);
    },
  );
  it("concurrent conflicting payloads for one transaction persist exactly one immutable economic fact", async () => {
    const command = input();
    const before = await business();
    const results = await Promise.allSettled([
      recordTestCaptureFact(db, context, command, now + 3),
      recordTestCaptureFact(
        db,
        context,
        { ...command, amountCents: 2499 },
        now + 4,
      ),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: "conflict" });
    const persisted = (await table("commerce_payment_capture_facts")).filter(
      (fact) => fact.transaction_ref === command.transactionRef,
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0].actual_amount_cents).toBe(
      fulfilled[0].value.actualAmountCents,
    );
    expect(await business()).toEqual(before);
  });
  it("rejects a transaction reassigned to another valid attempt and preserves multiple distinct captures for one attempt", async () => {
    const one = await claimed();
    const two = await claimed();
    const command = input(one);
    const first = await recordTestCaptureFact(db, context, command, now + 3);
    await expect(
      recordTestCaptureFact(
        db,
        context,
        {
          ...command,
          requestId: two.started.requestId,
          claimId: two.claim.claimId,
        },
        now + 4,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const before = await business();
    const second = await recordTestCaptureFact(
      db,
      context,
      { ...command, transactionRef: "fixture-additional-transaction" },
      now + 5,
    );
    expect(second.factId).not.toBe(first.factId);
    expect(
      (await table("commerce_payment_capture_facts")).filter(
        (r) => r.attempt_command_id === `payment-start-${command.requestId}`,
      ),
    ).toHaveLength(2);
    expect(await business()).toEqual(before);
  });
  it("allows identical synthetic transaction text under two distinct provider accounts without cross-deduplication", async () => {
    const stripe = input(historical[0]);
    const paypal = {
      ...input(historical[1]),
      transactionRef: stripe.transactionRef,
    };
    const one = await recordTestCaptureFact(
      db,
      historical[0].trusted,
      stripe,
      now + 3,
    );
    const two = await recordTestCaptureFact(
      db,
      historical[1].trusted,
      paypal,
      now + 3,
    );
    expect(one.factId).not.toBe(two.factId);
  });
  it.each([
    { instanceId: "33333333-3333-4333-8333-333333333333" },
    { accountRef: "fixture-wrong" },
  ])(
    "rejects mismatched scope before any business read: %j",
    async (change) => {
      const prepare = vi.fn((sql: string) => db.prepare(sql));
      await expect(
        recordTestCaptureFact(
          adapter({ prepare }),
          { ...context, ...change },
          input(),
          now + 3,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(prepare.mock.calls[0][0]).toContain("commerce_payment_scope");
    },
  );
  it("requires this caller's valid historical claim even when an existing transaction receipt is known", async () => {
    const command = input();
    await recordTestCaptureFact(db, context, command, now + 3);
    const cases = [
      {
        trusted: { ...context, workerId: crypto.randomUUID() },
        command,
        code: "conflict",
      },
      {
        trusted: context,
        command: { ...command, claimId: crypto.randomUUID() },
        code: "not_found",
      },
      {
        trusted: context,
        command: { ...command, requestId: crypto.randomUUID() },
        code: "conflict",
      },
      { trusted: historical[1].trusted, command, code: "conflict" },
      { trusted: context, command, time: now + 1, code: "conflict" },
    ];
    for (const item of cases)
      await expect(
        recordTestCaptureFact(
          db,
          item.trusted,
          item.command,
          item.time ?? now + 4,
        ),
      ).rejects.toMatchObject({ code: item.code });
  });
  it("copies context and input data synchronously before the scope read awaits", async () => {
    const trusted = { ...context };
    const command = input();
    const original = { ...command };
    let mutated = false;
    const wrapped = adapter({
      prepare(sql) {
        if (!mutated) {
          mutated = true;
          trusted.workerId = crypto.randomUUID();
          command.transactionRef = "fixture-mutated";
          command.amountCents = 1;
        }
        return db.prepare(sql);
      },
    });
    const receipt = await recordTestCaptureFact(
      wrapped,
      trusted,
      command,
      now + 3,
    );
    expect(receipt).toMatchObject({
      transactionRef: original.transactionRef,
      actualAmountCents: 2500,
    });
  });
  it("rejects invalid own shapes/accessors/types/bounds before database access", async () => {
    const prepare = vi.fn(() => {
      throw new Error("must not read");
    });
    const blocked = { prepare } as unknown as D1Database;
    const valid = input();
    const getter = Object.defineProperty({ ...valid }, "currency", {
      enumerable: true,
      get() {
        throw new Error("getter invoked");
      },
    });
    const invalidInputs: unknown[] = [
      null,
      [],
      { ...valid, extra: 1 },
      Object.assign(Object.create(valid), {}),
      getter,
      { ...valid, [Symbol("x")]: 1 },
      ...[
        0,
        -1,
        NaN,
        Infinity,
        1.1,
        Number.MAX_SAFE_INTEGER + 1,
        "2500",
        null,
      ].map((amountCents) => ({ ...valid, amountCents })),
      ...["cad", "CA", "CADA", "123", null].map((currency) => ({
        ...valid,
        currency,
      })),
      ...[
        "real-provider-reference",
        "fixture-",
        `fixture-${"x".repeat(93)}`,
        "fixture-x.y",
        null,
      ].flatMap((ref) => [
        { ...valid, providerObjectRef: ref },
        { ...valid, transactionRef: ref },
      ]),
      { ...valid, claimId: "bad" },
      { ...valid, requestId: "bad" },
    ];
    for (const command of invalidInputs)
      await expect(
        recordTestCaptureFact(
          blocked,
          context,
          command as TestCaptureFactInput,
          now + 3,
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    const invalidContexts: unknown[] = [
      null,
      [],
      { ...context, extra: 1 },
      { ...context, mode: "sandbox" },
      { ...context, instanceId: "bad" },
      { ...context, workerId: "bad" },
      { ...context, provider: "other" },
      { ...context, accountRef: "real-account" },
    ];
    for (const trusted of invalidContexts)
      await expect(
        recordTestCaptureFact(
          blocked,
          trusted as TestCaptureFactContext,
          valid,
          now + 3,
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    for (const time of [-1, NaN, Infinity, 1.1, 8_640_000_000_000_001])
      await expect(
        recordTestCaptureFact(blocked, context, valid, time),
      ).rejects.toMatchObject({ code: "invalid_request" });
    expect(prepare).not.toHaveBeenCalled();
  });
  it("accepts null prototypes, maximum fixture-reference length, and the maximum supported recorded clock", async () => {
    const command = Object.assign(Object.create(null), input(), {
      providerObjectRef: `fixture-${"x".repeat(92)}`,
      transactionRef: `fixture-${"y".repeat(92)}`,
    }) as TestCaptureFactInput;
    const trusted = Object.assign(
      Object.create(null),
      context,
    ) as TestCaptureFactContext;
    expect(
      await recordTestCaptureFact(db, trusted, command, 8_640_000_000_000_000),
    ).toMatchObject({
      recordedAt: 8_640_000_000_000_000,
      amountMatch: "match",
    });
  });
  it.each([
    { source_worker_id: "33333333-3333-4333-8333-333333333333" },
    { source_claim_id: "33333333-3333-4333-8333-333333333333" },
    { instance_id: "33333333-3333-4333-8333-333333333333" },
    { provider: "paypal", account_ref: "fixture-paypal" },
    { account_ref: "fixture-other" },
    { expected_amount_cents: 2499 },
    { expected_currency: "USD" },
    { amount_match: "mismatch" },
    { actual_amount_cents: 2499 },
    { actual_currency: "USD" },
    { recorded_at: now + 1 },
    { actual_amount_cents: null },
    { actual_amount_cents: 0 },
    { actual_amount_cents: 1.1 },
    { actual_amount_cents: Number.MAX_SAFE_INTEGER + 1 },
    { actual_currency: null },
    { actual_currency: "cad" },
    { provider_object_ref: "fixture-" },
    { transaction_ref: "not-fixture" },
    { payload_hash: "g".repeat(64) },
    { id: "bad" },
    { recorded_at: -1 },
    { recorded_at: 8_640_000_000_000_001 },
  ])(
    "SQL independently rejects forged binding, amount classification and invalid data: %j",
    async (change) => {
      const before = await table("commerce_payment_capture_facts");
      await expect(raw(change)).rejects.toThrow();
      expect(await table("commerce_payment_capture_facts")).toEqual(before);
    },
  );
  it("SQL rejects a real claim belonging to a different attempt", async () => {
    await expect(
      raw({ source_claim_id: historical[1].claim.claimId }),
    ).rejects.toThrow();
    await expect(
      raw({
        attempt_command_id: `payment-start-${historical[1].started.requestId}`,
      }),
    ).rejects.toThrow();
  });
  it("forbids UPDATE, DELETE and REPLACE through either the hash or full natural identity", async () => {
    const command = input();
    const receipt = await recordTestCaptureFact(db, context, command, now + 3);
    const original = await row(receipt.factId);
    const before = await business();
    await expect(
      db
        .prepare(
          "UPDATE commerce_payment_capture_facts SET actual_amount_cents=1 WHERE id=?",
        )
        .bind(receipt.factId)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare("DELETE FROM commerce_payment_capture_facts WHERE id=?")
        .bind(receipt.factId)
        .run(),
    ).rejects.toThrow();
    await expect(
      raw(
        { ...original, transaction_ref: "fixture-different-natural-key" },
        true,
      ),
    ).rejects.toThrow();
    await expect(
      raw({ ...original, id: "f".repeat(64) }, true),
    ).rejects.toThrow();
    expect(await row(receipt.factId)).toEqual(original);
    expect(await business()).toEqual(before);
  });
  it("reconciles a lost successful batch response from durable history and never invents another transaction", async () => {
    const command = input();
    const before = await business();
    const wrapped = adapter({
      async batch(statements) {
        await db.batch(statements);
        throw new Error("lost response");
      },
    });
    const receipt = await recordTestCaptureFact(
      wrapped,
      context,
      command,
      now + 3,
    );
    expect(receipt).toMatchObject({
      transactionRef: command.transactionRef,
      replayed: true,
    });
    expect(await recordTestCaptureFact(db, context, command, now + 4)).toEqual({
      ...receipt,
      replayed: true,
    });
    expect(await business()).toEqual(before);
  });
  it.each([true, false])(
    "returns unavailable after %s committed batch when readback is unavailable; same identity remains retryable",
    async (committed) => {
      const command = input();
      const before = await business();
      let afterBatch = false;
      const wrapped = adapter({
        prepare(sql) {
          if (afterBatch && sql.includes("FROM commerce_payment_capture_facts"))
            throw new Error("readback offline");
          return db.prepare(sql);
        },
        async batch(statements) {
          if (committed) await db.batch(statements);
          afterBatch = true;
          throw new Error("response unavailable");
        },
      });
      await expect(
        recordTestCaptureFact(wrapped, context, command, now + 3),
      ).rejects.toMatchObject({ code: "unavailable" });
      const later = await recordTestCaptureFact(db, context, command, now + 4);
      expect(later).toMatchObject({
        transactionRef: command.transactionRef,
        replayed: committed,
        recordedAt: committed ? now + 3 : now + 4,
      });
      expect(await business()).toEqual(before);
    },
  );
  it("requires durable readback even when batch reports success", async () => {
    const command = input();
    let afterBatch = false;
    const wrapped = adapter({
      prepare(sql) {
        if (afterBatch && sql.includes("FROM commerce_payment_capture_facts"))
          throw new Error("readback unavailable");
        return db.prepare(sql);
      },
      async batch<T>(statements: D1PreparedStatement[]) {
        const result = await db.batch<T>(statements);
        afterBatch = true;
        return result;
      },
    });
    await expect(
      recordTestCaptureFact(wrapped, context, command, now + 3),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(
      await recordTestCaptureFact(db, context, command, now + 4),
    ).toMatchObject({ replayed: true, recordedAt: now + 3 });
  });
  it("does not return false success for a zero-write adapter", async () => {
    const command = input();
    const before = await table("commerce_payment_capture_facts");
    await expect(
      recordTestCaptureFact(
        adapter({
          async batch() {
            return [];
          },
        }),
        context,
        command,
        now + 3,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await table("commerce_payment_capture_facts")).toEqual(before);
  });
  it("rolls back a trigger failure without changing order, work or stock, and permits the same identity retry", async () => {
    const command = input();
    const before = await business();
    const facts = await table("commerce_payment_capture_facts");
    await db
      .prepare(
        "CREATE TRIGGER capture_fixture_failure AFTER INSERT ON commerce_payment_capture_facts BEGIN SELECT RAISE(ABORT,'fictional failure'); END",
      )
      .run();
    try {
      await expect(
        recordTestCaptureFact(db, context, command, now + 3),
      ).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      await db.prepare("DROP TRIGGER capture_fixture_failure").run();
    }
    expect(await business()).toEqual(before);
    expect(await table("commerce_payment_capture_facts")).toEqual(facts);
    expect(
      await recordTestCaptureFact(db, context, command, now + 4),
    ).toMatchObject({ replayed: false });
  });
});
