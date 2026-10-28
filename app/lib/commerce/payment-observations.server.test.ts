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
import { recordTestCaptureFact } from "./capture-facts.server";
import {
  recordTestPaymentObservation,
  type TestPaymentObservationContext,
  type TestPaymentObservationInput,
} from "./payment-observations.server";

const root = resolve(process.cwd());
const now = 1_800_000_000_000;
const ownerHash = "a".repeat(64);
const instanceId = "11111111-1111-4111-8111-111111111111";
const workerId = "22222222-2222-4222-8222-222222222222";
const context: TestPaymentObservationContext = {
  mode: "local-test",
  instanceId,
  provider: "stripe",
  accountRef: "fixture-stripe",
  workerId,
};
const kinds = [
  "unknown",
  "not_found",
  "pending",
  "approved",
  "reported_failed",
  "captured",
] as const;
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
  const id = `observation-fixture-${++sequence}`;
  const product = await db
    .prepare(
      `INSERT INTO products(name,slug,price_cents,quantity,category_id,status,created_at,updated_at)
    VALUES ('Fictional observation test',?,999,999,1,'draft',1,1) RETURNING id`,
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
function input(
  item = historical[0],
  kind: TestPaymentObservationInput["kind"] = "captured",
): TestPaymentObservationInput {
  return {
    observationId: crypto.randomUUID(),
    requestId: item.started.requestId,
    claimId: item.claim.claimId,
    kind,
    providerObjectRef: `fixture-object-${crypto.randomUUID()}`,
    capture:
      kind === "captured"
        ? {
            transactionRef: `fixture-transaction-${crypto.randomUUID()}`,
            amountCents: 2500,
            currency: "CAD",
          }
        : null,
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
      "commerce_payment_capture_facts",
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
async function row(observationId: string) {
  return db
    .prepare(
      "SELECT * FROM commerce_payment_observations WHERE observation_id=?",
    )
    .bind(observationId)
    .first<Record<string, unknown>>();
}
async function raw(changes: Record<string, unknown> = {}, replace = false) {
  const item = historical[0];
  const values: Record<string, unknown> = {
    observation_id: crypto.randomUUID(),
    attempt_command_id: `payment-start-${item.started.requestId}`,
    source_claim_id: item.claim.claimId,
    source_worker_id: workerId,
    mode: "local-test",
    instance_id: instanceId,
    provider: "stripe",
    account_ref: "fixture-stripe",
    kind: "captured",
    provider_object_ref: "fixture-direct-object",
    transaction_ref: `fixture-direct-${crypto.randomUUID()}`,
    amount_cents: 2500,
    currency: "CAD",
    request_hash: "d".repeat(64),
    recorded_at: now + 3,
    ...changes,
  };
  return db
    .prepare(
      `${replace ? "INSERT OR REPLACE" : "INSERT"} INTO commerce_payment_observations
    (${Object.keys(values).join(",")}) VALUES (${Object.keys(values)
      .map(() => "?")
      .join(",")})`,
    )
    .bind(...Object.values(values))
    .run();
}
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "jewelry-payment-observations-"));
  const migrations = join(directory, "migrations");
  mkdirSync(migrations);
  for (const file of readdirSync(join(root, "migrations")).filter(
    (file) => file.endsWith(".sql") && file < "0012",
  ))
    copyFileSync(join(root, "migrations", file), join(migrations, file));
  configPath = join(directory, "wrangler.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "fictional-observations-test",
      compatibility_date: "2026-09-29",
      d1_databases: [
        {
          binding: "DB",
          database_name: "fictional-observations-test",
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
    recordTestPaymentObservation(
      adapter({
        prepare(sql) {
          absentScopeReads.push(sql);
          return db.prepare(sql);
        },
      }),
      context,
      {
        observationId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        claimId: crypto.randomUUID(),
        kind: "unknown",
        providerObjectRef: null,
        capture: null,
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
  for (const item of historical) {
    for (const amountCents of [2500, 2499])
      await recordTestCaptureFact(
        db,
        item.trusted,
        {
          requestId: item.started.requestId,
          claimId: item.claim.claimId,
          providerObjectRef: `fixture-historical-object-${item.id}`,
          transactionRef: `fixture-historical-${item.id}-${amountCents}`,
          amountCents,
          currency: "CAD",
        },
        now + 3,
      );
  }
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
    join(root, "migrations/0012_commerce_payment_observations.sql"),
    join(migrations, "0012_commerce_payment_observations.sql"),
  );
  migrate();
  await connect();
}, 30_000);
afterAll(async () => {
  await platform?.dispose();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("normalized synthetic local payment observations on real temporary D1", () => {
  it("upgrades 0001–0011 with two-provider intents, claims, captures, mismatch facts and recovery audit untouched, with no observations backfill", async () => {
    expect(await business()).toEqual(beforeUpgrade);
    expect(await table("commerce_payment_capture_facts")).toHaveLength(4);
    expect(await table("commerce_payment_observations")).toEqual([]);
    expect(absentScopeReads).toHaveLength(1);
    expect(absentScopeReads[0]).toContain("commerce_payment_scope");
  });
  it.each(
    (["stripe", "paypal"] as const).flatMap((provider) =>
      kinds.map((kind) => ({ provider, kind })),
    ),
  )(
    "persists $provider/$kind as a minimal normalized projection without any business-state change",
    async ({ provider, kind }) => {
      const item = historical.find(
        (item) => item.trusted.provider === provider,
      )!;
      const command = input(item, kind);
      const before = await business();
      const receipt = await recordTestPaymentObservation(
        db,
        item.trusted,
        command,
        now + 4,
      );
      expect(receipt).toEqual({
        testOnly: true,
        observationId: command.observationId,
        requestId: command.requestId,
        sourceClaimId: command.claimId,
        reference: item.order.id,
        provider,
        kind,
        providerObjectRef: command.providerObjectRef,
        capture: command.capture,
        recordedAt: now + 4,
        replayed: false,
      });
      expect(await row(receipt.observationId)).toMatchObject({
        attempt_command_id: `payment-start-${command.requestId}`,
        source_claim_id: command.claimId,
        source_worker_id: workerId,
        kind,
        transaction_ref: command.capture?.transactionRef ?? null,
        amount_cents: command.capture?.amountCents ?? null,
        currency: command.capture?.currency ?? null,
      });
      expect(await business()).toEqual(before);
    },
  );
  it.each(["unknown", "not_found"] as const)(
    "allows nullable object refs for %s without treating it as no-charge evidence",
    async (kind) => {
      const command = {
        ...input(historical[0], kind),
        providerObjectRef: null,
      };
      const before = await business();
      expect(
        await recordTestPaymentObservation(db, context, command, now + 4),
      ).toMatchObject({ kind, providerObjectRef: null, capture: null });
      expect(await business()).toEqual(before);
    },
  );
  it("keeps same-transaction captured observations under distinct observation IDs without creating/deduplicating economic capture facts", async () => {
    const command = input();
    const before = await business();
    const one = await recordTestPaymentObservation(
      db,
      context,
      command,
      now + 4,
    );
    const two = await recordTestPaymentObservation(
      db,
      context,
      { ...command, observationId: crypto.randomUUID() },
      now + 5,
    );
    expect(two.observationId).not.toBe(one.observationId);
    expect(two.capture).toEqual(one.capture);
    expect(
      (await table("commerce_payment_observations")).filter(
        (saved) => saved.transaction_ref === command.capture!.transactionRef,
      ),
    ).toHaveLength(2);
    expect(await business()).toEqual(before);
  });
  it("deduplicates concurrent exact observation IDs and replays original record time after expiry", async () => {
    const command = input();
    const before = await business();
    const results = await Promise.all([
      recordTestPaymentObservation(db, context, command, now + 4),
      recordTestPaymentObservation(db, context, command, now + 5),
    ]);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const first = results.find((r) => !r.replayed)!;
    expect(results.every((r) => r.recordedAt === first.recordedAt)).toBe(true);
    expect(
      await recordTestPaymentObservation(db, context, command, now + 900_000),
    ).toEqual({ ...first, replayed: true });
    expect(
      (await table("commerce_payment_observations")).filter(
        (saved) => saved.observation_id === command.observationId,
      ),
    ).toHaveLength(1);
    expect(await business()).toEqual(before);
  });
  it("canonicalizes own property order and preserves original timestamps even when a later replay clock decreases after the historical proof time", async () => {
    const command = input();
    const first = await recordTestPaymentObservation(
      db,
      context,
      command,
      now + 100,
    );
    const reordered = {
      capture: {
        currency: command.capture!.currency,
        amountCents: command.capture!.amountCents,
        transactionRef: command.capture!.transactionRef,
      },
      providerObjectRef: command.providerObjectRef,
      kind: command.kind,
      claimId: command.claimId,
      requestId: command.requestId,
      observationId: command.observationId,
    };
    const reorderedContext = {
      workerId,
      accountRef: context.accountRef,
      provider: context.provider,
      instanceId,
      mode: context.mode,
    };
    expect(
      await recordTestPaymentObservation(
        db,
        reorderedContext,
        reordered,
        now + 3,
      ),
    ).toEqual({ ...first, replayed: true });
  });
  it.each([
    { kind: "pending", capture: null },
    { providerObjectRef: "fixture-changed-object" },
    {
      capture: {
        transactionRef: "fixture-changed-transaction",
        amountCents: 2500,
        currency: "CAD",
      },
    },
    {
      capture: {
        transactionRef: "fixture-shared-transaction",
        amountCents: 2499,
        currency: "CAD",
      },
    },
    {
      capture: {
        transactionRef: "fixture-shared-transaction",
        amountCents: 2500,
        currency: "USD",
      },
    },
  ] as const)(
    "rejects an existing observation ID reused with a changed normalized payload: %j",
    async (change) => {
      const command = input();
      command.capture!.transactionRef = "fixture-shared-transaction";
      await recordTestPaymentObservation(db, context, command, now + 4);
      const before = await table("commerce_payment_observations");
      await expect(
        recordTestPaymentObservation(
          db,
          context,
          { ...command, ...change },
          now + 5,
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await table("commerce_payment_observations")).toEqual(before);
    },
  );
  it("concurrent conflicting payloads with one observation ID persist exactly one unmodified observation", async () => {
    const command = input();
    const before = await business();
    const results = await Promise.allSettled([
      recordTestPaymentObservation(db, context, command, now + 4),
      recordTestPaymentObservation(
        db,
        context,
        { ...command, capture: { ...command.capture!, amountCents: 2499 } },
        now + 5,
      ),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: "conflict" });
    expect(await row(command.observationId)).toMatchObject({
      amount_cents: fulfilled[0].value.capture!.amountCents,
    });
    expect(await business()).toEqual(before);
  });
  it("binds an observation ID to its historical claim and worker, rather than allowing another legitimate query claim to replay it", async () => {
    const item = await claimed();
    const command = input(item);
    const first = await recordTestPaymentObservation(
      db,
      context,
      command,
      now + 4,
    );
    const sameWorker = await claimTestPaymentWork(
      db,
      context,
      {
        claimId: crypto.randomUUID(),
        requestId: command.requestId,
        expectedVersion: 2,
      },
      now + 30_002,
    );
    await expect(
      recordTestPaymentObservation(
        db,
        context,
        { ...command, claimId: sameWorker.claimId },
        now + 30_003,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const other = { ...context, workerId: crypto.randomUUID() };
    const otherClaim = await claimTestPaymentWork(
      db,
      other,
      {
        claimId: crypto.randomUUID(),
        requestId: command.requestId,
        expectedVersion: 3,
      },
      now + 60_002,
    );
    await expect(
      recordTestPaymentObservation(
        db,
        other,
        { ...command, claimId: otherClaim.claimId },
        now + 60_003,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const fresh = await recordTestPaymentObservation(
      db,
      other,
      {
        ...command,
        claimId: otherClaim.claimId,
        observationId: crypto.randomUUID(),
      },
      now + 60_004,
    );
    expect(fresh.sourceClaimId).toBe(otherClaim.claimId);
    expect(
      await recordTestPaymentObservation(db, context, command, now + 60_005),
    ).toEqual({ ...first, replayed: true });
  });
  it("rejects an existing ID reassigned to a different valid request or channel", async () => {
    const command = input();
    await recordTestPaymentObservation(db, context, command, now + 4);
    const different = await claimed();
    await expect(
      recordTestPaymentObservation(
        db,
        context,
        {
          ...command,
          requestId: different.started.requestId,
          claimId: different.claim.claimId,
        },
        now + 5,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      recordTestPaymentObservation(
        db,
        historical[1].trusted,
        {
          ...command,
          requestId: historical[1].started.requestId,
          claimId: historical[1].claim.claimId,
        },
        now + 5,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("records late old-claim evidence after lease expiry, worker replacement and order change without changing current work, stock or capture facts", async () => {
    const item = await claimed();
    const command = input(item);
    const other = { ...context, workerId: crypto.randomUUID() };
    await claimTestPaymentWork(
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
    const receipt = await recordTestPaymentObservation(
      db,
      context,
      command,
      now + 900_000,
    );
    expect(receipt).toMatchObject({
      sourceClaimId: item.claim.claimId,
      recordedAt: now + 900_000,
    });
    expect(await business()).toEqual(before);
  });
  it.each([
    { instanceId: "33333333-3333-4333-8333-333333333333" },
    { accountRef: "fixture-wrong" },
  ])(
    "rejects mismatched scope before reading business data or a known receipt: %j",
    async (change) => {
      const command = input();
      await recordTestPaymentObservation(db, context, command, now + 4);
      const prepare = vi.fn((sql: string) => db.prepare(sql));
      await expect(
        recordTestPaymentObservation(
          adapter({ prepare }),
          { ...context, ...change },
          command,
          now + 5,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(prepare.mock.calls[0][0]).toContain("commerce_payment_scope");
    },
  );
  it("requires this caller's proof before any receipt lookup, including a known ID", async () => {
    const command = input();
    await recordTestPaymentObservation(db, context, command, now + 4);
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
    for (const test of cases) {
      const reads: string[] = [];
      await expect(
        recordTestPaymentObservation(
          adapter({
            prepare(sql) {
              reads.push(sql);
              return db.prepare(sql);
            },
          }),
          test.trusted,
          test.command,
          test.time ?? now + 5,
        ),
      ).rejects.toMatchObject({ code: test.code });
      expect(
        reads.some((sql) => sql.includes("FROM commerce_payment_observations")),
      ).toBe(false);
    }
  });
  it("copies trusted, input and nested capture synchronously before awaiting scope", async () => {
    const trusted = { ...context };
    const command = input();
    const original = { ...command, capture: { ...command.capture! } };
    let mutated = false;
    const wrapped = adapter({
      prepare(sql) {
        if (!mutated) {
          mutated = true;
          trusted.workerId = crypto.randomUUID();
          command.kind = "unknown";
          command.providerObjectRef = null;
          command.capture!.amountCents = 1;
          command.capture!.currency = "USD";
          command.capture!.transactionRef = "fixture-mutated";
        }
        return db.prepare(sql);
      },
    });
    const receipt = await recordTestPaymentObservation(
      wrapped,
      trusted,
      command,
      now + 4,
    );
    expect(receipt).toMatchObject({
      kind: original.kind,
      providerObjectRef: original.providerObjectRef,
      capture: original.capture,
    });
  });
  it("rejects strict-shape/accessor/type/kind combinations before touching the database", async () => {
    const prepare = vi.fn(() => {
      throw new Error("must not read");
    });
    const blocked = { prepare } as unknown as D1Database;
    const valid = input();
    const getter = Object.defineProperty({ ...valid }, "capture", {
      enumerable: true,
      get() {
        throw new Error("getter invoked");
      },
    });
    const nestedGetter = Object.defineProperty(
      { ...valid.capture! },
      "amountCents",
      {
        enumerable: true,
        get() {
          throw new Error("nested getter invoked");
        },
      },
    );
    const invalidInputs: unknown[] = [
      null,
      [],
      { ...valid, extra: 1 },
      Object.assign(Object.create(valid), {}),
      getter,
      { ...valid, [Symbol("x")]: 1 },
      { ...valid, observationId: "bad" },
      { ...valid, requestId: "bad" },
      { ...valid, claimId: "bad" },
      { ...valid, kind: "failed" },
      { ...valid, kind: null },
      { ...valid, kind: "pending" },
      { ...valid, kind: "unknown" },
      { ...valid, kind: "not_found" },
      { ...valid, capture: null },
      { ...valid, providerObjectRef: null },
      { ...valid, capture: undefined },
      { ...valid, capture: [] },
      { ...valid, capture: { ...valid.capture!, extra: 1 } },
      { ...valid, capture: nestedGetter },
      { ...valid, capture: Object.create(valid.capture!) },
      { ...valid, capture: { ...valid.capture!, [Symbol("nested")]: 1 } },
      ...["pending", "approved", "reported_failed"].map((kind) => ({
        ...valid,
        kind,
        providerObjectRef: null,
        capture: null,
      })),
      ...[
        0,
        -1,
        NaN,
        Infinity,
        1.1,
        Number.MAX_SAFE_INTEGER + 1,
        "2500",
        null,
      ].map((amountCents) => ({
        ...valid,
        capture: { ...valid.capture!, amountCents },
      })),
      ...["cad", "CA", "CADA", "123", null].map((currency) => ({
        ...valid,
        capture: { ...valid.capture!, currency },
      })),
      ...[
        "real-reference",
        "fixture-",
        `fixture-${"x".repeat(93)}`,
        "fixture-x.y",
        null,
      ].map((ref) => ({
        ...valid,
        capture: { ...valid.capture!, transactionRef: ref },
      })),
      ...[
        "real-reference",
        "fixture-",
        `fixture-${"x".repeat(93)}`,
        "fixture-x.y",
        1,
      ].map((providerObjectRef) => ({ ...valid, providerObjectRef })),
    ];
    for (const command of invalidInputs)
      await expect(
        recordTestPaymentObservation(
          blocked,
          context,
          command as TestPaymentObservationInput,
          now + 4,
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    const contextGetter = Object.defineProperty({ ...context }, "workerId", {
      get() {
        throw new Error("context accessor invoked");
      },
    });
    const invalidContexts: unknown[] = [
      null,
      [],
      { ...context, extra: 1 },
      { ...context, mode: "sandbox" },
      { ...context, instanceId: "bad" },
      { ...context, workerId: "bad" },
      { ...context, provider: "other" },
      { ...context, accountRef: "real-account" },
      contextGetter,
    ];
    for (const trusted of invalidContexts)
      await expect(
        recordTestPaymentObservation(
          blocked,
          trusted as TestPaymentObservationContext,
          valid,
          now + 4,
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    for (const time of [-1, NaN, Infinity, 1.1, 8_640_000_000_000_001])
      await expect(
        recordTestPaymentObservation(blocked, context, valid, time),
      ).rejects.toMatchObject({ code: "invalid_request" });
    expect(prepare).not.toHaveBeenCalled();
  });
  it("accepts null prototypes, maximal fixture refs, positive safe amount and synthetic currency token at the supported clock limit", async () => {
    const command = Object.assign(Object.create(null), input(), {
      providerObjectRef: `fixture-${"x".repeat(92)}`,
      capture: Object.assign(Object.create(null), {
        transactionRef: `fixture-${"y".repeat(92)}`,
        amountCents: Number.MAX_SAFE_INTEGER,
        currency: "ZZZ",
      }),
    }) as TestPaymentObservationInput;
    const trusted = Object.assign(
      Object.create(null),
      context,
    ) as TestPaymentObservationContext;
    expect(
      await recordTestPaymentObservation(
        db,
        trusted,
        command,
        8_640_000_000_000_000,
      ),
    ).toMatchObject({
      capture: command.capture,
      recordedAt: 8_640_000_000_000_000,
    });
  });
  it.each([
    { source_worker_id: "33333333-3333-4333-8333-333333333333" },
    { source_claim_id: "33333333-3333-4333-8333-333333333333" },
    { instance_id: "33333333-3333-4333-8333-333333333333" },
    { provider: "paypal", account_ref: "fixture-paypal" },
    { account_ref: "fixture-other" },
    { mode: "sandbox" },
    { observation_id: "bad" },
    { observation_id: null },
    { kind: "failed" },
    { kind: null },
    { provider_object_ref: null },
    { transaction_ref: null },
    { amount_cents: null },
    { currency: null },
    { amount_cents: 0 },
    { amount_cents: -1 },
    { amount_cents: 1.1 },
    { amount_cents: Number.MAX_SAFE_INTEGER + 1 },
    { currency: "cad" },
    { currency: "CADA" },
    { provider_object_ref: "fixture-" },
    { transaction_ref: "not-fixture" },
    { request_hash: "g".repeat(64) },
    { request_hash: null },
    { recorded_at: now + 1 },
    { recorded_at: -1 },
    { recorded_at: 1.1 },
    { recorded_at: null },
    { recorded_at: 8_640_000_000_000_001 },
    ...["unknown", "not_found", "pending", "approved", "reported_failed"].map(
      (kind) => ({ kind }),
    ),
    ...["pending", "approved", "reported_failed"].map((kind) => ({
      kind,
      provider_object_ref: null,
      transaction_ref: null,
      amount_cents: null,
      currency: null,
    })),
    { kind: "unknown", transaction_ref: null, amount_cents: 1, currency: null },
    {
      kind: "not_found",
      transaction_ref: null,
      amount_cents: null,
      currency: "CAD",
    },
  ])(
    "SQL independently rejects binding/shape/null/range violations: %j",
    async (change) => {
      const before = await table("commerce_payment_observations");
      await expect(raw(change)).rejects.toThrow();
      expect(await table("commerce_payment_observations")).toEqual(before);
    },
  );
  it.each(kinds)(
    "SQL independently accepts the exact %s nullable shape without business side effects",
    async (kind) => {
      const observationId = crypto.randomUUID();
      const before = await business();
      const nullable =
        kind === "captured"
          ? {}
          : { transaction_ref: null, amount_cents: null, currency: null };
      await raw({
        observation_id: observationId,
        kind,
        ...nullable,
        ...(["unknown", "not_found"].includes(kind)
          ? { provider_object_ref: null }
          : {}),
      });
      expect(await row(observationId)).toMatchObject({ kind });
      expect(await business()).toEqual(before);
    },
  );
  it("SQL independently rejects claims and attempts crossed between two real fixture identities", async () => {
    await expect(
      raw({ source_claim_id: historical[1].claim.claimId }),
    ).rejects.toThrow();
    await expect(
      raw({
        attempt_command_id: `payment-start-${historical[1].started.requestId}`,
      }),
    ).rejects.toThrow();
  });
  it("forbids UPDATE, DELETE and INSERT OR REPLACE of an observation ID", async () => {
    const command = input();
    await recordTestPaymentObservation(db, context, command, now + 4);
    const original = await row(command.observationId);
    const before = await business();
    await expect(
      db
        .prepare(
          "UPDATE commerce_payment_observations SET kind='pending' WHERE observation_id=?",
        )
        .bind(command.observationId)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "DELETE FROM commerce_payment_observations WHERE observation_id=?",
        )
        .bind(command.observationId)
        .run(),
    ).rejects.toThrow();
    await expect(raw({ ...original, amount_cents: 1 }, true)).rejects.toThrow();
    expect(await row(command.observationId)).toEqual(original);
    expect(await business()).toEqual(before);
  });
  it("recovers a lost successful batch response using the original observation ID", async () => {
    const command = input();
    const before = await business();
    const wrapped = adapter({
      async batch<T>(statements: D1PreparedStatement[]) {
        await db.batch<T>(statements);
        throw new Error("lost response");
      },
    });
    const receipt = await recordTestPaymentObservation(
      wrapped,
      context,
      command,
      now + 4,
    );
    expect(receipt).toMatchObject({
      observationId: command.observationId,
      replayed: true,
    });
    expect(
      await recordTestPaymentObservation(db, context, command, now + 5),
    ).toEqual({ ...receipt, replayed: true });
    expect(await business()).toEqual(before);
  });
  it.each([true, false])(
    "returns unavailable after batch failure with committed=%s when readback also fails; original ID remains retryable",
    async (committed) => {
      const command = input();
      const before = await business();
      let afterBatch = false;
      const wrapped = adapter({
        prepare(sql) {
          if (afterBatch && sql.includes("FROM commerce_payment_observations"))
            throw new Error("readback offline");
          return db.prepare(sql);
        },
        async batch<T>(statements: D1PreparedStatement[]) {
          if (committed) await db.batch<T>(statements);
          afterBatch = true;
          throw new Error("response unavailable");
        },
      });
      await expect(
        recordTestPaymentObservation(wrapped, context, command, now + 4),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(
        await recordTestPaymentObservation(db, context, command, now + 5),
      ).toMatchObject({
        observationId: command.observationId,
        replayed: committed,
        recordedAt: committed ? now + 4 : now + 5,
      });
      expect(await business()).toEqual(before);
    },
  );
  it("requires durable readback even after reported batch success", async () => {
    const command = input();
    let afterBatch = false;
    const wrapped = adapter({
      prepare(sql) {
        if (afterBatch && sql.includes("FROM commerce_payment_observations"))
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
      recordTestPaymentObservation(wrapped, context, command, now + 4),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(
      await recordTestPaymentObservation(db, context, command, now + 5),
    ).toMatchObject({ replayed: true, recordedAt: now + 4 });
  });
  it("refuses success when a zero-write adapter reports an empty successful batch", async () => {
    const command = input();
    const before = await table("commerce_payment_observations");
    await expect(
      recordTestPaymentObservation(
        adapter({
          async batch<T>(): Promise<D1Result<T>[]> {
            return [];
          },
        }),
        context,
        command,
        now + 4,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await table("commerce_payment_observations")).toEqual(before);
  });
  it("rolls back a trigger failure while preserving all other records and allows retry with the original observation ID", async () => {
    const command = input();
    const before = await business();
    const observations = await table("commerce_payment_observations");
    await db
      .prepare(
        "CREATE TRIGGER observation_fixture_failure AFTER INSERT ON commerce_payment_observations BEGIN SELECT RAISE(ABORT,'fictional failure'); END",
      )
      .run();
    try {
      await expect(
        recordTestPaymentObservation(db, context, command, now + 4),
      ).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      await db.prepare("DROP TRIGGER observation_fixture_failure").run();
    }
    expect(await business()).toEqual(before);
    expect(await table("commerce_payment_observations")).toEqual(observations);
    expect(
      await recordTestPaymentObservation(db, context, command, now + 5),
    ).toMatchObject({ replayed: false });
  });
});
