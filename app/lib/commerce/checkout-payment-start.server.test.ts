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
} from "vitest";
import { applyStockCommand } from "./inventory.server";
import { createTestQuote, reserveTestOrder } from "./orders.server";
import {
  issueTestCheckoutQuote,
  acceptTestCheckoutQuote,
  type TestCheckoutSelection,
} from "./checkout-acceptance.server";
import { createTestCheckoutOrder } from "./checkout-orders.server";
import { releaseTestCheckoutOrder } from "./checkout-release.server";
import {
  beginOwnedCheckoutPaymentAttempt as begin,
  beginTestPaymentAttempt as legacyBegin,
  type TestPaymentStartInput,
  type TrustedTestPaymentContext,
} from "./payment-start.server";
import { claimTestPaymentWork } from "./payment-work.server";
import { executeTestPaymentWork } from "./payment-executor.server";
import { createTestPaymentSimulator } from "./payment-simulator.server";
import { recordTestPaymentEvent } from "./payment-event-inbox.server";
import { CheckoutSessionError } from "./checkout-session.server";

const root = resolve(process.cwd()),
  now = 1_800_000_000_000;
const trusted: TrustedTestPaymentContext = {
  mode: "local-test",
  instanceId: "11111111-1111-4111-8111-111111111111",
  provider: "stripe",
  accountRef: "fixture-stripe",
  ownerHash: "a".repeat(64),
};
const owner = {
  mode: trusted.mode,
  instanceId: trusted.instanceId,
  ownerHash: trusted.ownerHash,
};
const worker = {
  mode: trusted.mode,
  instanceId: trusted.instanceId,
  provider: trusted.provider,
  accountRef: trusted.accountRef,
  workerId: "22222222-2222-4222-8222-222222222222",
};
const migrationName = "0021_commerce_owned_payment_preparation.sql";
const migration = () =>
  readFileSync(join(root, "migrations", migrationName), "utf8");
let directory: string,
  baseline: string,
  upgraded: string,
  current: string,
  configPath: string,
  platform: PlatformProxy<Env> | undefined,
  db: D1Database,
  sequence = 0;
function configuration(path: string, migrations: string) {
  const filename = join(path, "wrangler.json");
  writeFileSync(
    filename,
    JSON.stringify({
      name: "fictional-owned-payment",
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
  return filename;
}
function migrate(path: string, config: string) {
  execFileSync(
    join(root, "node_modules/.bin/wrangler"),
    [
      "d1",
      "migrations",
      "apply",
      "DB",
      "--config",
      config,
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
      timeout: 20000,
    },
  );
}
async function connect() {
  platform = await getPlatformProxy<Env>({
    configPath,
    envFiles: [],
    remoteBindings: false,
    persist: { path: join(current, "state/v3") },
  });
  db = platform.env.DB;
}
async function selectBaseline() {
  await platform?.dispose();
  platform = undefined;
  rmSync(join(current, "state"), { recursive: true, force: true });
  cpSync(join(baseline, "state"), join(current, "state"), { recursive: true });
  await connect();
  await seedScope();
}
async function seedScope() {
  await db
    .prepare(
      "INSERT INTO commerce_payment_scope(id,mode,instance_id,stripe_account_ref,paypal_account_ref) VALUES (1,'local-test',?,'fixture-stripe','fixture-paypal')",
    )
    .bind(trusted.instanceId)
    .run();
}
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "owned-payment-start-"));
  baseline = join(directory, "empty-0020");
  mkdirSync(baseline);
  const oldMigrations = join(baseline, "migrations");
  mkdirSync(oldMigrations);
  for (const file of readdirSync(join(root, "migrations")).filter(
    (file) => file.endsWith(".sql") && file < "0021",
  ))
    copyFileSync(join(root, "migrations", file), join(oldMigrations, file));
  migrate(baseline, configuration(baseline, oldMigrations));
  upgraded = join(directory, "empty-0021");
  mkdirSync(upgraded);
  cpSync(join(baseline, "state"), join(upgraded, "state"), { recursive: true });
  migrate(upgraded, configuration(upgraded, join(root, "migrations")));
}, 30000);
beforeEach(async () => {
  current = mkdtempSync(join(directory, "case-"));
  cpSync(join(upgraded, "state"), join(current, "state"), { recursive: true });
  configPath = configuration(current, join(root, "migrations"));
  await connect();
  await seedScope();
});
afterEach(async () => {
  await platform?.dispose();
  platform = undefined;
  if (current) rmSync(current, { recursive: true, force: true });
});
afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});
async function fixture() {
  const id = `owned-payment-${++sequence}`;
  const product = await db
    .prepare(
      "INSERT INTO products(name,slug,price_cents,quantity,category_id,status,created_at,updated_at) VALUES ('Fictional payment fixture',?,999,99,1,'draft',1,1) RETURNING id",
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
        "INSERT INTO commerce_variants(id,product_id,sku,colour,size_description,price_cents,active) VALUES (?,?,?,'Gold-tone','Fictional',2505,1)",
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
        quantity: 4,
        reason: "Fictional inspected receipt",
      },
    ],
    now,
  );
  return id;
}
async function held(legacy = false) {
  const variantId = await fixture();
  if (legacy) {
    const q = await createTestQuote(
      db,
      trusted.ownerHash,
      [{ variantId, quantity: 1 }],
      "shipping",
      now,
    );
    const o = await reserveTestOrder(db, trusted.ownerHash, q.id, now);
    return { variantId, orderId: o.id, reserveUntil: o.reserveUntil };
  }
  const selection: TestCheckoutSelection = {
    contractVersion: "local-checkout-v1",
    lines: [{ variantId, quantity: 1 }],
    fixtureProfileId: "fixture-ontario",
    deliveryMethod: "shipping",
  };
  const q = await issueTestCheckoutQuote(
    db,
    owner,
    { issueKey: crypto.randomUUID(), selection },
    () => now,
  );
  const accepted = await acceptTestCheckoutQuote(
    db,
    owner,
    {
      acceptanceKey: crypto.randomUUID(),
      quoteId: q.quoteId,
      selection,
      acknowledge: true,
    },
    () => now,
  );
  return {
    variantId,
    ...(await createTestCheckoutOrder(
      db,
      owner,
      { createKey: crypto.randomUUID(), acceptanceId: accepted.acceptanceId },
      () => now,
    )),
  };
}
const input = (reference: string): TestPaymentStartInput => ({
  requestId: crypto.randomUUID(),
  reference,
  expectedVersion: 1,
});
const rows = async (name: string) =>
  (await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results;
async function allHistory() {
  const tables = (
    await db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'commerce_%' ORDER BY name",
      )
      .all<{ name: string }>()
  ).results;
  return Object.fromEntries(
    await Promise.all(tables.map(async ({ name }) => [name, await rows(name)])),
  );
}
async function legacyHistory() {
  const item = await held(true),
    request = input(item.orderId);
  const started = await legacyBegin(db, trusted, request, now + 1);
  const claim = await claimTestPaymentWork(
    db,
    worker,
    {
      claimId: crypto.randomUUID(),
      requestId: started.requestId,
      expectedVersion: 1,
    },
    now + 2,
  );
  await executeTestPaymentWork(
    db,
    worker,
    {
      claimId: claim.claimId,
      requestId: started.requestId,
      expectedVersion: claim.resultingVersion,
    },
    createTestPaymentSimulator([{ kind: "captured" }]),
    () => now + 3,
  );
  await recordTestPaymentEvent(
    db,
    {
      mode: worker.mode,
      instanceId: worker.instanceId,
      provider: worker.provider,
      accountRef: worker.accountRef,
    },
    {
      eventRef: `fixture-event-${crypto.randomUUID()}`,
      kind: "unknown",
      providerObjectRef: null,
      candidateRequestId: null,
      capture: null,
      occurredAt: now + 4,
    },
    now + 4,
  );
  return { item, request, started };
}
async function upgrade(sql = migration()) {
  await platform?.dispose();
  platform = undefined;
  const migrations = join(current, "upgrade-migrations");
  mkdirSync(migrations);
  for (const file of readdirSync(join(root, "migrations")).filter(
    (file) => file.endsWith(".sql") && file < "0021",
  ))
    copyFileSync(join(root, "migrations", file), join(migrations, file));
  writeFileSync(join(migrations, migrationName), sql);
  configPath = configuration(current, migrations);
  try {
    migrate(current, configPath);
  } finally {
    await connect();
  }
}
async function order(id: string) {
  return db
    .prepare(
      "SELECT state,payment_state,version FROM commerce_orders WHERE id=?",
    )
    .bind(id)
    .first();
}
async function balance(id: string) {
  return db
    .prepare(
      "SELECT on_hand,facebook_reserved,checkout_reserved,allocated FROM commerce_inventory WHERE variant_id=?",
    )
    .bind(id)
    .first();
}
function intercept(
  batch: (statements: D1PreparedStatement[]) => Promise<D1Result<unknown>[]>,
) {
  return new Proxy(db, {
    get(target, key) {
      if (key === "batch") return batch;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("owned checkout payment preparation on real local D1", () => {
  it("upgrades populated 0020 without relocking orders, duplicating work or losing financial dependencies", async () => {
    await selectBaseline();
    const old = await legacyHistory(),
      owned = await held();
    const before = await allHistory();
    for (const table of [
      "commerce_payment_work",
      "commerce_payment_work_claims",
      "commerce_payment_capture_facts",
      "commerce_payment_observations",
      "commerce_payment_observation_results",
      "commerce_payment_execution_starts",
      "commerce_payment_event_receipts",
    ])
      expect(before[table]).toHaveLength(1);
    const externalBefore = (
      await db
        .prepare(
          "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name!='commerce_payment_attempts' AND name!='commerce_checkout_order_no_update' ORDER BY name",
        )
        .all()
    ).results;
    await upgrade();
    expect(await allHistory()).toEqual(before);
    const externalAfter = (
      await db
        .prepare(
          "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name!='commerce_payment_attempts' AND name NOT IN ('commerce_checkout_order_no_update','commerce_payment_owned_work_fence') ORDER BY name",
        )
        .all()
    ).results;
    expect(externalAfter).toEqual(externalBefore);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
    expect(
      (await db.prepare("PRAGMA index_list(commerce_payment_attempts)").all())
        .results,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "commerce_payment_attempts_one_per_order",
          unique: 1,
        }),
      ]),
    );
    expect(await legacyBegin(db, trusted, old.request, now + 10)).toMatchObject(
      { ...old.started, replayed: true },
    );
    expect(
      await begin(db, trusted, input(owned.orderId), () => now + 10),
    ).toMatchObject({ amountCents: 4406, resultingVersion: 2 });
  }, 30000);
  it("rolls back the real parent rebuild and all restored objects if a later migration statement fails", async () => {
    await selectBaseline();
    await legacyHistory();
    await held();
    const before = await allHistory(),
      schema = (
        await db
          .prepare(
            "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name LIKE 'commerce_%' ORDER BY name",
          )
          .all()
      ).results;
    await expect(
      upgrade(
        migration().replace(
          "DROP TABLE commerce_payment_attempts_backup_0021;",
          "DROP TABLE commerce_payment_attempts_backup_0021;\nINSERT INTO missing_0021_fault_table VALUES (1);",
        ),
      ),
    ).rejects.toThrow();
    expect(await allHistory()).toEqual(before);
    expect(
      (
        await db
          .prepare(
            "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name LIKE 'commerce_%' ORDER BY name",
          )
          .all()
      ).results,
    ).toEqual(schema);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  }, 30000);
  it("prepares the exact frozen amount including half-up tax, without repricing or changing stock", async () => {
    const item = await held(),
      command = input(item.orderId),
      stock = await balance(item.variantId);
    await db
      .prepare(
        "UPDATE commerce_variants SET price_cents=9999,version=version+1 WHERE id=?",
      )
      .bind(item.variantId)
      .run();
    const receipt = await begin(db, trusted, command, () => now + 20);
    expect(receipt).toMatchObject({
      amountCents: 4406,
      currency: "CAD",
      expectedVersion: 1,
      resultingVersion: 2,
      recordedAt: now + 20,
      replayed: false,
    });
    expect(await order(item.orderId)).toEqual({
      state: "pending_payment",
      payment_state: "processing",
      version: 2,
    });
    expect(await balance(item.variantId)).toEqual(stock);
    expect(await rows("commerce_payment_attempts")).toEqual([
      expect.objectContaining({
        rules_version: "fictional-checkout-acceptance-v1",
        amount_cents: 4406,
      }),
    ]);
    expect(await rows("commerce_payment_work")).toEqual([
      expect.objectContaining({
        version: 1,
        next_operation: "create",
        current_claim_id: null,
      }),
    ]);
    expect(await rows("commerce_payment_capture_facts")).toEqual([]);
    await expect(
      releaseTestCheckoutOrder(
        db,
        owner,
        {
          releaseKey: crypto.randomUUID(),
          orderId: item.orderId,
          kind: "expire",
          expectedVersion: 2,
        },
        () => item.reserveUntil,
      ),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "UPDATE commerce_orders SET payment_state='not_started',version=3 WHERE id=?",
        )
        .bind(item.orderId)
        .run(),
    ).rejects.toThrow();
    await expect(
      db.prepare("UPDATE commerce_payment_attempts SET amount_cents=1").run(),
    ).rejects.toThrow();
    await expect(
      db.prepare("DELETE FROM commerce_payment_attempts").run(),
    ).rejects.toThrow();
  });
  it("keeps legacy/owned entry points, scopes, providers and the old simulator isolated", async () => {
    const owned = await held(),
      old = await held(true);
    await expect(
      legacyBegin(db, trusted, input(owned.orderId), now + 1),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      begin(db, trusted, input(old.orderId), () => now + 1),
    ).rejects.toMatchObject({ code: "not_found" });
    for (const scope of [
      { ...trusted, ownerHash: "b".repeat(64) },
      { ...trusted, instanceId: crypto.randomUUID() },
      { ...trusted, accountRef: "fixture-wrong" },
      { ...trusted, provider: "paypal" as const },
    ])
      await expect(
        begin(db, scope, input(owned.orderId), () => now + 1),
      ).rejects.toThrow();
    const started = await begin(
      db,
      trusted,
      input(owned.orderId),
      () => now + 1,
    );
    await expect(
      claimTestPaymentWork(
        db,
        worker,
        {
          claimId: crypto.randomUUID(),
          requestId: started.requestId,
          expectedVersion: 1,
        },
        now + 2,
      ),
    ).rejects.toThrow();
    expect(await rows("commerce_payment_work_claims")).toEqual([]);
    const legacy = await legacyBegin(db, trusted, input(old.orderId), now + 1);
    expect(
      await claimTestPaymentWork(
        db,
        worker,
        {
          claimId: crypto.randomUUID(),
          requestId: legacy.requestId,
          expectedVersion: 1,
        },
        now + 2,
      ),
    ).toMatchObject({ operation: "create" });
  });
  it("retains direct-SQL source/scope guards and attempt immutability after rebuild", async () => {
    const first = await held();
    await begin(db, trusted, input(first.orderId), () => now + 1);
    const saved = (await rows("commerce_payment_attempts"))[0] as Record<
      string,
      string | number
    >;
    await expect(
      db
        .prepare(
          "INSERT OR REPLACE INTO commerce_payment_attempts SELECT * FROM commerce_payment_attempts",
        )
        .run(),
    ).rejects.toThrow();
    for (const changes of [
      { rules_version: "local-test-v1" },
      { provider: "paypal", account_ref: "fixture-paypal" },
      { amount_cents: 4405 },
      { instance_id: crypto.randomUUID() },
    ]) {
      const item = await held();
      const origin = (await db
        .prepare(
          "SELECT promoted_quote_id FROM commerce_checkout_order_origins WHERE order_id=?",
        )
        .bind(item.orderId)
        .first<{ promoted_quote_id: string }>())!;
      const requestId = crypto.randomUUID();
      const row = {
        ...saved,
        command_id: `payment-start-${requestId}`,
        request_id: requestId,
        order_id: item.orderId,
        quote_id: origin.promoted_quote_id,
        create_operation_key: crypto.randomUUID(),
        ...changes,
      };
      const before = await allHistory();
      await expect(
        db.batch([
          db
            .prepare(
              "INSERT INTO commerce_commands(id,request_hash,created_at) VALUES (?,?,?)",
            )
            .bind(row.command_id, "a".repeat(64), saved.occurred_at),
          db
            .prepare(
              `INSERT INTO commerce_payment_attempts(${Object.keys(row).join(",")}) VALUES (${Object.keys(
                row,
              )
                .map(() => "?")
                .join(",")})`,
            )
            .bind(...Object.values(row)),
        ]),
      ).rejects.toThrow();
      expect(await allHistory()).toEqual(before);
    }
  });
  it("replays one original key after expiry and recovers committed response loss without a second intent", async () => {
    const item = await held(),
      command = input(item.orderId);
    const lost = intercept(async (statements) => {
      await db.batch(statements);
      throw new Error("private write response lost");
    });
    const receipt = await begin(lost, trusted, command, () => now + 1);
    expect(receipt).toMatchObject({ replayed: true });
    expect(
      await begin(db, trusted, command, () => item.reserveUntil + 1),
    ).toMatchObject({ ...receipt, replayed: true });
    await expect(
      begin(db, trusted, { ...command, expectedVersion: 2 }, () => now + 2),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      begin(db, trusted, input(item.orderId), () => now + 2),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await rows("commerce_payment_attempts")).toHaveLength(1);
    expect(await rows("commerce_payment_work")).toHaveLength(1);
  });
  it("uses a fresh post-hook clock, propagates rejected authorization unchanged and leaves no partial command", async () => {
    const item = await held(),
      before = await allHistory();
    let time = now + 1;
    await expect(
      begin(
        db,
        trusted,
        input(item.orderId),
        () => time,
        async () => {
          time = item.reserveUntil;
        },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const denied = new CheckoutSessionError("unauthorized");
    await expect(
      begin(
        db,
        trusted,
        input(item.orderId),
        () => now + 1,
        async () => {
          throw denied;
        },
      ),
    ).rejects.toBe(denied);
    expect(await allHistory()).toEqual(before);
  });
  it("rejects backdated/final expired clocks and resolves a same-key winner before late eligibility checks", async () => {
    const item = await held(),
      command = input(item.orderId),
      before = await allHistory();
    let currentTime = now + 1;
    await expect(
      begin(
        db,
        trusted,
        command,
        () => currentTime,
        async () => {
          currentTime = now;
        },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await allHistory()).toEqual(before);
    currentTime = now + 1;
    const first = await begin(
      db,
      trusted,
      command,
      () => currentTime,
      async () => {
        await begin(db, trusted, command, () => now + 2);
        currentTime = item.reserveUntil;
      },
    );
    expect(first).toMatchObject({ replayed: true, recordedAt: now + 2 });
    expect(await rows("commerce_payment_attempts")).toHaveLength(1);
  });
  it("handles same/different-key concurrency and cancel/prepare competition with one durable winner", async () => {
    const item = await held(),
      command = input(item.orderId);
    const same = await Promise.all([
      begin(db, trusted, command, () => now + 1),
      begin(db, trusted, command, () => now + 1),
    ]);
    expect(same[0].createOperationKey).toBe(same[1].createOperationKey);
    const other = await held();
    const different = await Promise.allSettled([
      begin(db, trusted, input(other.orderId), () => now + 1),
      begin(db, trusted, input(other.orderId), () => now + 1),
    ]);
    expect(
      different.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const race = await held();
    const results = await Promise.allSettled([
      begin(db, trusted, input(race.orderId), () => now + 1),
      releaseTestCheckoutOrder(
        db,
        owner,
        {
          releaseKey: crypto.randomUUID(),
          orderId: race.orderId,
          kind: "cancel",
          expectedVersion: 1,
        },
        () => now + 1,
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const state = (await order(race.orderId)) as {
      state: string;
      payment_state: string;
    };
    expect(await balance(race.variantId)).toMatchObject({
      checkout_reserved: state.state === "cancelled" ? 0 : 1,
    });
    expect(
      state.state === "cancelled"
        ? state.payment_state === "not_started"
        : state.payment_state === "processing",
    ).toBe(true);
  });
  it.each(["attempt", "work", "lock"])(
    "rolls back commands and every partial effect on silently ignored %s writes",
    async (kind) => {
      const item = await held(),
        before = await allHistory();
      const sql =
        kind === "attempt"
          ? "CREATE TRIGGER fault_ignore BEFORE INSERT ON commerce_payment_attempts BEGIN SELECT RAISE(IGNORE); END;"
          : kind === "work"
            ? "CREATE TRIGGER fault_ignore BEFORE INSERT ON commerce_payment_work BEGIN SELECT RAISE(IGNORE); END;"
            : "CREATE TRIGGER fault_ignore BEFORE UPDATE ON commerce_orders WHEN NEW.payment_state='processing' BEGIN SELECT RAISE(IGNORE); END;";
      await db.prepare(sql).run();
      try {
        await expect(
          begin(db, trusted, input(item.orderId), () => now + 1),
        ).rejects.toMatchObject({ code: "unavailable" });
        expect(await allHistory()).toEqual(before);
      } finally {
        await db.prepare("DROP TRIGGER fault_ignore").run();
      }
    },
  );
});
