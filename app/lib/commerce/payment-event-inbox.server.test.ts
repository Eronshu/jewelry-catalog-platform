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
import { registerTestPaymentExecution } from "./payment-execution-start.server";
import { processTestPaymentObservation } from "./observation-processing.server";
import { commandHash } from "./inventory.server";
import { beginTestPaymentAttempt } from "./payment-start.server";
import { claimTestPaymentWork } from "./payment-work.server";
import { recordTestCaptureFact } from "./capture-facts.server";
import {
  recordTestPaymentEvent,
  type TestPaymentEventContext,
  type TestPaymentEventInput,
} from "./payment-event-inbox.server";
import { recordTestPaymentObservation } from "./payment-observations.server";

const root = resolve(process.cwd());
const now = 1_800_000_000_000;
const ownerHash = "a".repeat(64);
const instanceId = "11111111-1111-4111-8111-111111111111";
const workerId = "22222222-2222-4222-8222-222222222222";
const context: TestPaymentEventContext = {
  mode: "local-test",
  instanceId,
  provider: "stripe",
  accountRef: "fixture-stripe",
};
let directory: string;
let configPath: string;
let platform: PlatformProxy<Env>;
let db: D1Database;
let sequence = 0;
let historical: Awaited<ReturnType<typeof claimed>>[];
let beforeUpgrade: unknown;
let absentScopeReads: string[];
let beforeInbox: unknown;
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
  const trusted = {
    ...context,
    provider,
    accountRef: `fixture-${provider}`,
    workerId,
  };
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
  kind: TestPaymentEventInput["kind"] = "captured",
): TestPaymentEventInput {
  return {
    eventRef: `fixture-event-${crypto.randomUUID()}`,
    kind,
    providerObjectRef: ["unknown", "not_found", "unmapped"].includes(kind)
      ? null
      : "fixture-object",
    candidateRequestId: null,
    capture:
      kind === "captured"
        ? {
            transactionRef: "fixture-transaction",
            amountCents: 2500,
            currency: "CAD",
          }
        : null,
    occurredAt: null,
  };
}
async function table(name: string) {
  return (await db.prepare(`SELECT * FROM ${name} ORDER BY 1,2`).all()).results;
}
async function business() {
  const names = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT IN ('commerce_payment_event_receipts','catalog_migrations') ORDER BY name",
    )
    .all<{ name: string }>();
  return Promise.all(names.results.map(({ name }) => table(name)));
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
async function row(receiptId: string) {
  return db
    .prepare("SELECT * FROM commerce_payment_event_receipts WHERE receipt_id=?")
    .bind(receiptId)
    .first<Record<string, unknown>>();
}
async function raw(changes: Record<string, unknown> = {}, replace = false) {
  const values = {
    receipt_id: await commandHash(crypto.randomUUID()),
    mode: "local-test",
    instance_id: instanceId,
    provider: "stripe",
    account_ref: "fixture-stripe",
    event_ref: `fixture-direct-${crypto.randomUUID()}`,
    payload_hash: "d".repeat(64),
    candidate_request_id: null,
    kind: "captured",
    provider_object_ref: "fixture-object",
    transaction_ref: "fixture-transaction",
    amount_cents: 2500,
    currency: "CAD",
    occurred_at: null,
    received_at: now,
    ...changes,
  };
  return db
    .prepare(
      `${replace ? "INSERT OR REPLACE" : "INSERT"} INTO commerce_payment_event_receipts
    (${Object.keys(values).join(",")}) VALUES (${Object.keys(values)
      .map(() => "?")
      .join(",")})`,
    )
    .bind(...Object.values(values))
    .run();
}
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "jewelry-payment-event-inbox-"));
  const migrations = join(directory, "migrations");
  mkdirSync(migrations);
  for (const file of readdirSync(join(root, "migrations")).filter(
    (file) => file.endsWith(".sql") && file < "0015",
  ))
    copyFileSync(join(root, "migrations", file), join(migrations, file));
  configPath = join(directory, "wrangler.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "fictional-event-inbox-test",
      compatibility_date: "2026-09-29",
      d1_databases: [
        {
          binding: "DB",
          database_name: "fictional-event-inbox-test",
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
    recordTestPaymentEvent(
      adapter({
        prepare(sql) {
          absentScopeReads.push(sql);
          return db.prepare(sql);
        },
      }),
      context,
      input(),
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
    await registerTestPaymentExecution(
      db,
      item.trusted,
      {
        claimId: item.claim.claimId,
        requestId: item.started.requestId,
        expectedVersion: 2,
      },
      () => now + 3,
    );
    const observationId = crypto.randomUUID();
    await recordTestPaymentObservation(
      db,
      item.trusted,
      {
        observationId,
        requestId: item.started.requestId,
        claimId: item.claim.claimId,
        kind: "captured",
        providerObjectRef: "fixture-history-object",
        capture: {
          transactionRef: `fixture-history-${item.id}`,
          amountCents: 2500,
          currency: "CAD",
        },
      },
      now + 4,
    );
    const processingContext = {
      ...context,
      provider: item.trusted.provider,
      accountRef: item.trusted.accountRef,
    };
    await processTestPaymentObservation(
      db,
      processingContext,
      { observationId },
      now + 5,
    );
    await recordTestCaptureFact(
      db,
      item.trusted,
      {
        requestId: item.started.requestId,
        claimId: item.claim.claimId,
        providerObjectRef: "fixture-history-object",
        transactionRef: `fixture-extra-${item.id}`,
        amountCents: 2499,
        currency: "CAD",
      },
      now + 6,
    );
  }
  beforeUpgrade = await business();
  await platform.dispose();
  copyFileSync(
    join(root, "migrations/0015_commerce_payment_event_receipts.sql"),
    join(migrations, "0015_commerce_payment_event_receipts.sql"),
  );
  migrate();
  await connect();
}, 30_000);
afterAll(async () => {
  await platform?.dispose();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("inert normalized local fixture event inbox on real temporary D1", () => {
  it("upgrades 0014 to 0015 empty, preserving orders, stock, intents, claims, execution starts, observations, facts and processing history", async () => {
    expect(await business()).toEqual(beforeUpgrade);
    expect(await table("commerce_payment_event_receipts")).toEqual([]);
    expect(absentScopeReads).toHaveLength(1);
    beforeInbox = await business();
  });
  it.each(
    (["stripe", "paypal"] as const).flatMap((provider) =>
      [
        "unknown",
        "not_found",
        "pending",
        "approved",
        "reported_failed",
        "captured",
        "unmapped",
      ].map((kind) => ({
        provider,
        kind: kind as TestPaymentEventInput["kind"],
      })),
    ),
  )(
    "records and replays $provider $kind with only receipt metadata",
    async ({ provider, kind }) => {
      const command = input(kind);
      const trusted = {
        ...context,
        provider,
        accountRef: `fixture-${provider}`,
      };
      const receipt = await recordTestPaymentEvent(db, trusted, command, now);
      expect(receipt).toEqual({
        testOnly: true,
        receiptId: expect.stringMatching(/^[a-f0-9]{64}$/),
        eventRef: command.eventRef,
        receivedAt: now,
        replayed: false,
      });
      expect(await recordTestPaymentEvent(db, trusted, command, 0)).toEqual({
        ...receipt,
        replayed: true,
      });
      expect(await business()).toEqual(beforeInbox);
    },
  );
  it("uses two fixed versioned canonical descriptors independent of input key insertion order", async () => {
    const command: TestPaymentEventInput = {
      occurredAt: 0,
      capture: {
        currency: "CAD",
        amountCents: 2500,
        transactionRef: "fixture-transaction",
      },
      candidateRequestId: null,
      providerObjectRef: "fixture-object",
      kind: "captured",
      eventRef: "fixture-fixed-vector",
    };
    const receipt = await recordTestPaymentEvent(db, context, command, now);
    // Hash vectors are independently fixed by canonical JSON, not a round trip
    // through this module's normalization helper.
    expect(receipt.receiptId).toBe(
      "96c3e613956658c2094fd9d4c8b50f1f17d55dd0979be925c6510529e64b92b2",
    );
    expect(await row(receipt.receiptId)).toMatchObject({
      payload_hash:
        "ff2567c3b6ef169479450795911e9d3950a480d480fb19f5a448830299380500",
      occurred_at: 0,
      received_at: now,
    });
    expect(
      await recordTestPaymentEvent(
        db,
        {
          accountRef: context.accountRef,
          provider: context.provider,
          instanceId,
          mode: "local-test",
        },
        command,
        now + 1,
      ),
    ).toEqual({ ...receipt, replayed: true });
  });
  it.each([
    { kind: "pending", capture: null },
    { providerObjectRef: "fixture-other-object" },
    { candidateRequestId: "33333333-3333-4333-8333-333333333333" },
    { occurredAt: now + 999_999 },
    {
      capture: {
        transactionRef: "fixture-other-transaction",
        amountCents: 2500,
        currency: "CAD",
      },
    },
    {
      capture: {
        transactionRef: "fixture-transaction",
        amountCents: 2501,
        currency: "CAD",
      },
    },
    {
      capture: {
        transactionRef: "fixture-transaction",
        amountCents: 2500,
        currency: "USD",
      },
    },
  ])(
    "retains changed normalized payload under the same event reference: %j",
    async (change) => {
      const original = input();
      const first = await recordTestPaymentEvent(db, context, original, now);
      const command = { ...original, ...change } as TestPaymentEventInput;
      const second = await recordTestPaymentEvent(
        db,
        context,
        command,
        now + 1,
      );
      expect(second.receiptId).not.toBe(first.receiptId);
      expect(second.replayed).toBe(false);
      expect(await recordTestPaymentEvent(db, context, original, 0)).toEqual({
        ...first,
        replayed: true,
      });
      expect(await recordTestPaymentEvent(db, context, command, 0)).toEqual({
        ...second,
        replayed: true,
      });
      expect(
        (
          await db
            .prepare(
              "SELECT * FROM commerce_payment_event_receipts WHERE event_ref=?",
            )
            .bind(original.eventRef)
            .all()
        ).results,
      ).toHaveLength(2);
    },
  );
  it("binds the same event and payload to each provider account scope independently", async () => {
    const command = input();
    const paypal: TestPaymentEventContext = {
      ...context,
      provider: "paypal",
      accountRef: "fixture-paypal",
    };
    const stripeReceipt = await recordTestPaymentEvent(
      db,
      context,
      command,
      now,
    );
    const paypalReceipt = await recordTestPaymentEvent(
      db,
      paypal,
      command,
      now + 1,
    );
    expect(paypalReceipt.receiptId).not.toBe(stripeReceipt.receiptId);
    const stripeRow = await row(stripeReceipt.receiptId);
    const paypalRow = await row(paypalReceipt.receiptId);
    expect(stripeRow!.payload_hash).toBe(paypalRow!.payload_hash);
    expect(stripeRow).toMatchObject({
      provider: "stripe",
      account_ref: "fixture-stripe",
    });
    expect(paypalRow).toMatchObject({
      provider: "paypal",
      account_ref: "fixture-paypal",
    });
    expect(await recordTestPaymentEvent(db, context, command, 0)).toEqual({
      ...stripeReceipt,
      replayed: true,
    });
    expect(await recordTestPaymentEvent(db, paypal, command, 0)).toEqual({
      ...paypalReceipt,
      replayed: true,
    });
    expect(await business()).toEqual(beforeInbox);
  });
  it("retains different event IDs reporting the same economic transaction without creating facts", async () => {
    const original = input();
    const first = await recordTestPaymentEvent(db, context, original, now);
    const second = await recordTestPaymentEvent(
      db,
      context,
      { ...original, eventRef: `fixture-other-${crypto.randomUUID()}` },
      now,
    );
    expect(second.receiptId).not.toBe(first.receiptId);
    expect(await business()).toEqual(beforeInbox);
  });
  it.each([null, "33333333-3333-4333-8333-333333333333", "foreign-provider"])(
    "accepts absent, unknown or foreign request hints without business reads: %s",
    async (hint) => {
      const command = {
        ...input(),
        candidateRequestId:
          hint === "foreign-provider" ? historical[1].started.requestId : hint,
      };
      const reads: string[] = [];
      await recordTestPaymentEvent(
        adapter({
          prepare(sql) {
            reads.push(sql);
            return db.prepare(sql);
          },
        }),
        context,
        command,
        now,
      );
      expect(
        reads.every(
          (sql) =>
            sql.includes("commerce_payment_scope") ||
            sql.includes("commerce_payment_event_receipts"),
        ),
      ).toBe(true);
      expect(await business()).toEqual(beforeInbox);
    },
  );
  it.each([0, now - 1, now + 1, 8_640_000_000_000_000, null])(
    "accepts independent provider occurredAt=%s",
    async (occurredAt) => {
      const command = { ...input(), occurredAt };
      const receipt = await recordTestPaymentEvent(db, context, command, now);
      expect(await row(receipt.receiptId)).toMatchObject({
        occurred_at: occurredAt,
        received_at: now,
      });
    },
  );
  it.each([
    { instanceId: "33333333-3333-4333-8333-333333333333" },
    { accountRef: "fixture-wrong" },
    { provider: "paypal", accountRef: "fixture-stripe" },
  ] as const)(
    "checks scope before any new or replay receipt lookup: %j",
    async (change) => {
      const command = input();
      await recordTestPaymentEvent(db, context, command, now);
      for (const candidate of [command, input()]) {
        const prepare = vi.fn((sql: string) => db.prepare(sql));
        await expect(
          recordTestPaymentEvent(
            adapter({ prepare }),
            { ...context, ...change },
            candidate,
            now,
          ),
        ).rejects.toMatchObject({ code: "unavailable" });
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(prepare.mock.calls[0][0]).toContain("commerce_payment_scope");
      }
    },
  );
  it("snapshots context, input and nested capture before the first database await", async () => {
    const trusted = { ...context };
    const command = input();
    const original = structuredClone(command);
    let mutated = false;
    const receipt = await recordTestPaymentEvent(
      adapter({
        prepare(sql) {
          if (!mutated) {
            mutated = true;
            trusted.accountRef = "fixture-mutated";
            command.eventRef = "fixture-mutated";
            command.candidateRequestId = crypto.randomUUID();
            command.occurredAt = 9;
            command.capture!.amountCents = 1;
            command.capture!.transactionRef = "fixture-mutated";
            command.capture!.currency = "USD";
          }
          return db.prepare(sql);
        },
      }),
      trusted,
      command,
      now,
    );
    expect(await row(receipt.receiptId)).toMatchObject({
      event_ref: original.eventRef,
      candidate_request_id: null,
      occurred_at: null,
      amount_cents: 2500,
      transaction_ref: original.capture!.transactionRef,
      currency: "CAD",
      account_ref: context.accountRef,
    });
    expect(await recordTestPaymentEvent(db, context, original, now)).toEqual({
      ...receipt,
      replayed: true,
    });
  });
  it("rejects getters, extra/inherited/symbol keys and strict value violations before database access", async () => {
    const prepare = vi.fn(() => {
      throw new Error("must not read");
    });
    const blocked = { prepare } as unknown as D1Database;
    const valid = input();
    const getter = (base: object, key: string) =>
      Object.defineProperty({ ...base }, key, {
        get() {
          throw new Error("getter invoked");
        },
        enumerable: true,
      });
    const invalidInputs: unknown[] = [
      null,
      [],
      { ...valid, extra: 1 },
      Object.create(valid),
      getter(valid, "capture"),
      { ...valid, [Symbol("x")]: 1 },
      ...[
        "eventRef",
        "kind",
        "providerObjectRef",
        "candidateRequestId",
        "capture",
        "occurredAt",
      ].map((key) => {
        const copy = { ...valid } as Record<string, unknown>;
        delete copy[key];
        return copy;
      }),
      { ...valid, kind: "real-provider-type" },
      { ...valid, kind: null },
      { ...valid, candidateRequestId: "bad" },
      { ...valid, candidateRequestId: undefined },
      ...["eventRef", "providerObjectRef"].flatMap((key) =>
        [
          "real-ref",
          "fixture-",
          `fixture-${"x".repeat(93)}`,
          "fixture-x.y",
          1,
        ].map((value) => ({ ...valid, [key]: value })),
      ),
      { ...valid, capture: null },
      { ...valid, providerObjectRef: null },
      { ...valid, capture: undefined },
      { ...valid, capture: [] },
      { ...valid, capture: Object.create(valid.capture) },
      { ...valid, capture: { ...valid.capture, extra: 1 } },
      { ...valid, capture: { ...valid.capture, [Symbol("x")]: 1 } },
      { ...valid, capture: getter(valid.capture!, "amountCents") },
      ...[
        0,
        -1,
        1.1,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        "2500",
        null,
      ].map((amountCents) => ({
        ...valid,
        capture: { ...valid.capture, amountCents },
      })),
      ...["cad", "CA", "CADA", "123", null].map((currency) => ({
        ...valid,
        capture: { ...valid.capture, currency },
      })),
      ...[
        "real-ref",
        "fixture-",
        `fixture-${"x".repeat(93)}`,
        "fixture-x.y",
        null,
      ].map((transactionRef) => ({
        ...valid,
        capture: { ...valid.capture, transactionRef },
      })),
      ...[
        "unknown",
        "not_found",
        "pending",
        "approved",
        "reported_failed",
        "unmapped",
      ].map((kind) => ({ ...valid, kind })),
      ...["pending", "approved", "reported_failed"].map((kind) => ({
        ...valid,
        kind,
        providerObjectRef: null,
        capture: null,
      })),
      ...[-1, 1.1, NaN, Infinity, 8_640_000_000_000_001, undefined, "0"].map(
        (occurredAt) => ({ ...valid, occurredAt }),
      ),
    ];
    for (const command of invalidInputs)
      await expect(
        recordTestPaymentEvent(
          blocked,
          context,
          command as TestPaymentEventInput,
          now,
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    for (const trusted of [
      null,
      [],
      { ...context, extra: 1 },
      Object.create(context),
      { ...context, [Symbol("x")]: 1 },
      getter(context, "mode"),
      { ...context, mode: "sandbox" },
      { ...context, instanceId: "bad" },
      { ...context, provider: "other" },
      { ...context, accountRef: "real-account" },
    ])
      await expect(
        recordTestPaymentEvent(
          blocked,
          trusted as TestPaymentEventContext,
          valid,
          now,
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    for (const time of [-1, 1.1, NaN, Infinity, 8_640_000_000_000_001])
      await expect(
        recordTestPaymentEvent(blocked, context, valid, time),
      ).rejects.toMatchObject({ code: "invalid_request" });
    expect(prepare).not.toHaveBeenCalled();
  });
  it("accepts null prototypes and maximum valid reference, money and clock bounds", async () => {
    const command = Object.assign(Object.create(null), input(), {
      eventRef: `fixture-${"x".repeat(92)}`,
      providerObjectRef: `fixture-${"y".repeat(92)}`,
      capture: Object.assign(Object.create(null), {
        transactionRef: `fixture-${"z".repeat(92)}`,
        amountCents: Number.MAX_SAFE_INTEGER,
        currency: "ZZZ",
      }),
      occurredAt: 8_640_000_000_000_000,
    });
    const receipt = await recordTestPaymentEvent(
      db,
      Object.assign(Object.create(null), context),
      command,
      8_640_000_000_000_000,
    );
    expect(receipt.receivedAt).toBe(8_640_000_000_000_000);
    expect(await row(receipt.receiptId)).toMatchObject({
      amount_cents: Number.MAX_SAFE_INTEGER,
      currency: "ZZZ",
    });
  });
  it("concurrent exact variants preserve the first committed timestamp with one new receipt", async () => {
    const command = input();
    const receipts = await Promise.all([
      recordTestPaymentEvent(db, context, command, now + 10),
      recordTestPaymentEvent(db, context, command, now + 20),
    ]);
    expect(receipts.filter((r) => !r.replayed)).toHaveLength(1);
    expect(receipts[0].receiptId).toBe(receipts[1].receiptId);
    expect(receipts[0].receivedAt).toBe(receipts[1].receivedAt);
    expect(await recordTestPaymentEvent(db, context, command, 0)).toEqual({
      ...receipts[0],
      replayed: true,
    });
  });
  it("recovers a lost write response by the original variant identity", async () => {
    const command = input();
    const receipt = await recordTestPaymentEvent(
      adapter({
        async batch<T>(statements: D1PreparedStatement[]) {
          await db.batch<T>(statements);
          throw new Error("lost response");
        },
      }),
      context,
      command,
      now,
    );
    expect(receipt.replayed).toBe(true);
    expect(await recordTestPaymentEvent(db, context, command, 0)).toEqual(
      receipt,
    );
  });
  it.each([true, false])(
    "returns unavailable on uncertain write plus read fault, committed=%s",
    async (committed) => {
      const command = input();
      let afterBatch = false;
      await expect(
        recordTestPaymentEvent(
          adapter({
            prepare(sql) {
              if (
                afterBatch &&
                sql.includes("FROM commerce_payment_event_receipts")
              )
                throw new Error("read offline");
              return db.prepare(sql);
            },
            async batch<T>(statements: D1PreparedStatement[]) {
              if (committed) await db.batch<T>(statements);
              afterBatch = true;
              throw new Error("response lost");
            },
          }),
          context,
          command,
          now,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(
        await recordTestPaymentEvent(db, context, command, now + 1),
      ).toMatchObject({
        replayed: committed,
        receivedAt: committed ? now : now + 1,
      });
    },
  );
  it("requires durable readback after reported success", async () => {
    const command = input();
    let afterBatch = false;
    await expect(
      recordTestPaymentEvent(
        adapter({
          prepare(sql) {
            if (
              afterBatch &&
              sql.includes("FROM commerce_payment_event_receipts")
            )
              throw new Error("read offline");
            return db.prepare(sql);
          },
          async batch<T>(statements: D1PreparedStatement[]) {
            const results = await db.batch<T>(statements);
            afterBatch = true;
            return results;
          },
        }),
        context,
        command,
        now,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await recordTestPaymentEvent(db, context, command, 0)).toMatchObject(
      { replayed: true, receivedAt: now },
    );
  });
  it.each(["empty", "zero", "unknown"])(
    "cannot invent records from a successful %s write adapter",
    async (variant) => {
      const command = input();
      const before = await table("commerce_payment_event_receipts");
      await expect(
        recordTestPaymentEvent(
          adapter({
            async batch<T>(): Promise<D1Result<T>[]> {
              return variant === "empty"
                ? []
                : [
                    {
                      success: true,
                      results: [],
                      meta: { changes: variant === "zero" ? 0 : undefined },
                    } as unknown as D1Result<T>,
                  ];
            },
          }),
          context,
          command,
          now,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(await table("commerce_payment_event_receipts")).toEqual(before);
    },
  );
  it("unconfirmed metadata after a durable insert returns only replay metadata", async () => {
    const command = input();
    expect(
      await recordTestPaymentEvent(
        adapter({
          async batch<T>(statements: D1PreparedStatement[]) {
            await db.batch<T>(statements);
            return [];
          },
        }),
        context,
        command,
        now,
      ),
    ).toMatchObject({ replayed: true });
  });
  it("a failed insert rolls back without changing business state and the original variant can retry", async () => {
    const command = input();
    const before = await table("commerce_payment_event_receipts");
    await db
      .prepare(
        "CREATE TRIGGER event_fixture_failure AFTER INSERT ON commerce_payment_event_receipts BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
      )
      .run();
    try {
      await expect(
        recordTestPaymentEvent(db, context, command, now),
      ).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      await db.prepare("DROP TRIGGER event_fixture_failure").run();
    }
    expect(await table("commerce_payment_event_receipts")).toEqual(before);
    expect(await business()).toEqual(beforeInbox);
    expect(
      await recordTestPaymentEvent(db, context, command, now + 1),
    ).toMatchObject({ replayed: false, receivedAt: now + 1 });
  });
  it.each([
    { receipt_id: "a".repeat(64) },
    { payload_hash: "a".repeat(64) },
    { event_ref: "fixture-wrong-event" },
    { provider: "paypal", account_ref: "fixture-paypal" },
    {
      kind: "pending",
      transaction_ref: null,
      amount_cents: null,
      currency: null,
    },
    { provider_object_ref: "fixture-wrong-object" },
    { candidate_request_id: "33333333-3333-4333-8333-333333333333" },
    { transaction_ref: "fixture-wrong-transaction" },
    { amount_cents: 2501 },
    { currency: "USD" },
    { occurred_at: 1 },
  ])(
    "rejects a well-shaped forged identity/hash/normalized-field witness on read: %j",
    async (change) => {
      const command = input();
      const witnesses = await descriptors(command);
      await raw({ ...witnesses, ...change });
      const before = await table("commerce_payment_event_receipts");
      await expect(
        recordTestPaymentEvent(db, context, command, now),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await table("commerce_payment_event_receipts")).toEqual(before);
    },
  );
  it("rejects ID and natural key hitting two different rows regardless of their query order", async () => {
    const command = input();
    const witnesses = await descriptors(command);
    await raw({ ...witnesses, payload_hash: "c".repeat(64) });
    await raw({ ...witnesses, receipt_id: "b".repeat(64) });
    const before = await table("commerce_payment_event_receipts");
    await expect(
      recordTestPaymentEvent(db, context, command, now),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await table("commerce_payment_event_receipts")).toEqual(before);
  });
  it("fully compares durable readback when a writer reports a successful but different payload", async () => {
    const command = input();
    const witnesses = await descriptors(command);
    await expect(
      recordTestPaymentEvent(
        adapter({
          async batch<T>() {
            await raw({ ...witnesses, amount_cents: 1 });
            return [
              {
                success: true,
                results: [],
                meta: { changes: 1 },
              } as unknown as D1Result<T>,
            ];
          },
        }),
        context,
        command,
        now,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await business()).toEqual(beforeInbox);
  });
  it.each([
    { receipt_id: null },
    { receipt_id: "g".repeat(64) },
    { receipt_id: "a".repeat(63) },
    { mode: null },
    { mode: "sandbox" },
    { instance_id: null },
    { instance_id: "bad" },
    { instance_id: "33333333-3333-4333-8333-333333333333" },
    { provider: null },
    { provider: "other" },
    { provider: "paypal" },
    { account_ref: null },
    { account_ref: "fixture-wrong" },
    { event_ref: null },
    { event_ref: "fixture-" },
    { event_ref: "real-event" },
    { event_ref: `fixture-${"x".repeat(93)}` },
    { event_ref: "fixture-x.y" },
    { payload_hash: null },
    { payload_hash: "g".repeat(64) },
    { payload_hash: "d".repeat(63) },
    { candidate_request_id: "bad" },
    { candidate_request_id: "33333333-3333-3333-8333-333333333333" },
    { kind: null },
    { kind: "failed" },
    { provider_object_ref: null },
    { provider_object_ref: "fixture-" },
    { transaction_ref: null },
    { transaction_ref: "real-transaction" },
    { amount_cents: null },
    { amount_cents: 0 },
    { amount_cents: -1 },
    { amount_cents: 1.1 },
    { amount_cents: Number.MAX_SAFE_INTEGER + 1 },
    { currency: null },
    { currency: "cad" },
    { currency: "CADA" },
    { currency: "123" },
    { occurred_at: -1 },
    { occurred_at: 1.1 },
    { occurred_at: 8_640_000_000_000_001 },
    { received_at: null },
    { received_at: -1 },
    { received_at: 1.1 },
    { received_at: 8_640_000_000_000_001 },
    ...[
      "unknown",
      "not_found",
      "pending",
      "approved",
      "reported_failed",
      "unmapped",
    ].map((kind) => ({ kind })),
    ...["pending", "approved", "reported_failed"].map((kind) => ({
      kind,
      provider_object_ref: null,
      transaction_ref: null,
      amount_cents: null,
      currency: null,
    })),
    { kind: "unknown", transaction_ref: null, amount_cents: 1, currency: null },
    {
      kind: "unmapped",
      transaction_ref: null,
      amount_cents: null,
      currency: "CAD",
    },
  ])(
    "SQL independently rejects scope, shape, NULL, type and range violations: %j",
    async (change) => {
      const before = await table("commerce_payment_event_receipts");
      await expect(raw(change)).rejects.toThrow();
      expect(await table("commerce_payment_event_receipts")).toEqual(before);
    },
  );
  it.each([
    "unknown",
    "not_found",
    "pending",
    "approved",
    "reported_failed",
    "captured",
    "unmapped",
  ])(
    "SQL accepts exact %s nullable shape with an orphan candidate and independent clocks",
    async (kind) => {
      const receiptId = await commandHash(crypto.randomUUID());
      await raw({
        receipt_id: receiptId,
        kind,
        candidate_request_id: crypto.randomUUID(),
        occurred_at: 8_640_000_000_000_000,
        received_at: 0,
        ...(kind === "captured"
          ? {}
          : { transaction_ref: null, amount_cents: null, currency: null }),
        ...(["unknown", "not_found", "unmapped"].includes(kind)
          ? { provider_object_ref: null }
          : {}),
      });
      expect(await row(receiptId)).toMatchObject({ kind, received_at: 0 });
      expect(await business()).toEqual(beforeInbox);
    },
  );
  it("has no attempt/order foreign keys and rejects updates, deletes and replacement through either identity", async () => {
    expect(
      (
        await db
          .prepare("PRAGMA foreign_key_list(commerce_payment_event_receipts)")
          .all()
      ).results,
    ).toEqual([]);
    const command = input();
    const receipt = await recordTestPaymentEvent(db, context, command, now);
    const saved = (await row(receipt.receiptId))!;
    await expect(
      db
        .prepare(
          "UPDATE commerce_payment_event_receipts SET received_at=0 WHERE receipt_id=?",
        )
        .bind(receipt.receiptId)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "DELETE FROM commerce_payment_event_receipts WHERE receipt_id=?",
        )
        .bind(receipt.receiptId)
        .run(),
    ).rejects.toThrow();
    await expect(raw({ ...saved, amount_cents: 1 }, true)).rejects.toThrow();
    await expect(
      raw({ ...saved, receipt_id: "f".repeat(64) }, true),
    ).rejects.toThrow();
    expect(await row(receipt.receiptId)).toEqual(saved);
    expect(await business()).toEqual(beforeInbox);
  });
});
async function descriptors(command: TestPaymentEventInput) {
  const payload_hash = await commandHash({
    operation: "test-payment-event-payload-v1",
    payload: {
      kind: command.kind,
      providerObjectRef: command.providerObjectRef,
      candidateRequestId: command.candidateRequestId,
      capture: command.capture,
      occurredAt: command.occurredAt,
    },
  });
  const receipt_id = await commandHash({
    operation: "test-payment-event-receipt-v1",
    context,
    eventRef: command.eventRef,
    payloadHash: payload_hash,
  });
  return {
    receipt_id,
    mode: context.mode,
    instance_id: context.instanceId,
    provider: context.provider,
    account_ref: context.accountRef,
    event_ref: command.eventRef,
    payload_hash,
    kind: command.kind,
    provider_object_ref: command.providerObjectRef,
    candidate_request_id: command.candidateRequestId,
    transaction_ref: command.capture?.transactionRef ?? null,
    amount_cents: command.capture?.amountCents ?? null,
    currency: command.capture?.currency ?? null,
    occurred_at: command.occurredAt,
    received_at: now,
  };
}
