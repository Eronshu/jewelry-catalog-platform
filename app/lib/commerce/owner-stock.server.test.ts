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
  vi,
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
import {
  beginTestPaymentAttempt as legacyBegin,
  type TestPaymentStartInput,
  type TrustedTestPaymentContext,
} from "./payment-start.server";
import { claimTestPaymentWork } from "./payment-work.server";
import { executeTestPaymentWork } from "./payment-executor.server";
import { createTestPaymentSimulator } from "./payment-simulator.server";
import { recordTestPaymentEvent } from "./payment-event-inbox.server";
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
const migrationName = "0024_commerce_owner_stock.sql";
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
async function selectBaseline(seed = true) {
  await platform?.dispose();
  platform = undefined;
  rmSync(join(current, "state"), { recursive: true, force: true });
  cpSync(join(baseline, "state"), join(current, "state"), { recursive: true });
  await connect();
  if (seed) await seedScope();
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
  baseline = join(directory, "baseline-0023");
  mkdirSync(baseline);
  const oldMigrations = join(baseline, "migrations");
  mkdirSync(oldMigrations);
  for (const file of readdirSync(join(root, "migrations")).filter(
    (file) => file.endsWith(".sql") && file < "0024",
  ))
    copyFileSync(join(root, "migrations", file), join(oldMigrations, file));
  migrate(baseline, configuration(baseline, oldMigrations));
  upgraded = join(directory, "upgraded-0024");
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
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No actual external transport");
    }),
  );
});
afterEach(async () => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
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
async function held(legacy = false, multi = false) {
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
  const secondVariantId = multi ? await fixture() : null;
  const selection: TestCheckoutSelection = {
    contractVersion: "local-checkout-v1",
    lines: [
      { variantId, quantity: 1 },
      ...(secondVariantId ? [{ variantId: secondVariantId, quantity: 1 }] : []),
    ],
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
    secondVariantId,
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
async function legacyHistory(query = false) {
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
    now + (query ? 700002 : 2),
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
    () => now + (query ? 700003 : 3),
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
    (file) => file.endsWith(".sql") && file < "0024",
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
function faultDatabase(
  predicate: (sql: string) => boolean,
  phase: "before" | "after" | "unknown",
  method = "run",
) {
  let fired = false;
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          function wrap(statement: D1PreparedStatement): D1PreparedStatement {
            return new Proxy(statement, {
              get(s, k) {
                if (k === "bind")
                  return (...values: unknown[]) => wrap(s.bind(...values));
                const fn = Reflect.get(s, k);
                if (k === method)
                  return async (...args: unknown[]) => {
                    const should = !fired && predicate(sql);
                    if (should) {
                      fired = true;
                      if (phase === "before")
                        throw new Error("SQL private fault");
                    }
                    const result = await fn.apply(s, args);
                    if (should && phase === "unknown")
                      return { success: true, meta: {} };
                    if (should) throw new Error("SQL private committed fault");
                    return result;
                  };
                return typeof fn === "function" ? fn.bind(s) : fn;
              },
            });
          }
          return wrap(target.prepare(sql));
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

import {
  applyOwnerStock,
  lookupOwnerStockCommand,
  readOwnerStock,
} from "./owner-stock.server";
import type { OwnerStockInput, OwnerStockOperation } from "./owner-stock";
const actor = { email: "fictional-owner@example.test", sub: "fixture-owner" };
const scope = { mode: "local-test" as const, instanceId: trusted.instanceId };
async function request(
  variantId: string,
  operation: OwnerStockOperation = "receive",
  quantity = 1,
): Promise<OwnerStockInput> {
  const d = await readOwnerStock(db, scope, variantId);
  if (!d) throw new Error("missing fixture");
  return {
    requestId: crypto.randomUUID(),
    variantId,
    operation,
    quantity,
    acknowledge: true,
    expected: {
      variantVersion: d.variantVersion,
      onHand: d.item.onHand,
      facebookReserved: d.item.facebookReserved,
      checkoutReserved: d.item.checkoutReserved,
      allocated: d.item.allocated,
    },
  };
}
const apply = (i: OwnerStockInput) =>
  applyOwnerStock(db, scope, actor, i, () => now);
const ownerCount = async () =>
  (await rows("commerce_owner_stock_commands")).length;
describe("owner stock commands on real temporary D1", () => {
  it("upgrades populated financial and owned reservation history without modifying existing rows or FK integrity", async () => {
    await selectBaseline();
    await legacyHistory();
    await held();
    const before = await allHistory();
    expect(before.commerce_payment_capture_facts.length).toBeGreaterThan(0);
    await upgrade();
    const after = await allHistory();
    for (const [name, value] of Object.entries(before))
      expect(after[name], name).toEqual(value);
    expect(await ownerCount()).toBe(0);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  });
  it("records four operations, preserves unpublished status, and returns immutable historical receipts", async () => {
    const v = await fixture();
    await db
      .prepare(
        "UPDATE commerce_variants SET active=0,version=version+1 WHERE id=?",
      )
      .bind(v)
      .run();
    const first = await request(v, "receive", 3);
    expect((await apply(first)).after.onHand).toBe(7);
    await apply(await request(v, "fb_reserve"));
    await apply(await request(v, "fb_release"));
    await apply(await request(v, "fb_reserve"));
    const sold = await apply(await request(v, "fb_sale"));
    expect(sold.after).toMatchObject({
      onHand: 6,
      facebookReserved: 0,
      checkoutReserved: 0,
      allocated: 0,
    });
    expect(await apply(first)).toMatchObject({
      replayed: true,
      after: { onHand: 7 },
    });
    expect(await ownerCount()).toBe(5);
    expect(
      (await db
        .prepare(
          "SELECT count(*) AS n FROM commerce_stock_movements WHERE command_id LIKE 'owner-stock-%'",
        )
        .first<{ n: number }>())!.n,
    ).toBe(5);
    expect((await readOwnerStock(db, scope, v))!.item).toMatchObject({
      active: false,
      websiteAvailable: 0,
    });
    expect(
      JSON.stringify(await lookupOwnerStockCommand(db, scope, actor, first)),
    ).not.toContain(actor.email);
  });
  it("rejects stale snapshots, double FB slots, and changed actor or payload on the original key", async () => {
    const v = await fixture(),
      r = await request(v, "fb_reserve"),
      stale = await request(v);
    await apply(r);
    await expect(apply(stale)).rejects.toMatchObject({ code: "conflict" });
    await expect(apply(await request(v, "fb_reserve"))).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      applyOwnerStock(db, scope, { ...actor, sub: "other" }, r),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(apply({ ...r, operation: "fb_sale" })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await ownerCount()).toBe(1);
  });
  it("serializes concurrent same-key and different-key attempts with exactly one stock effect", async () => {
    const v = await fixture(),
      r = await request(v, "fb_reserve");
    const same = await Promise.all([apply(r), apply(r)]);
    expect(same.map((x) => x.after.facebookReserved)).toEqual([1, 1]);
    await apply(await request(v, "fb_release"));
    const one = await request(v, "fb_reserve"),
      two = { ...one, requestId: crypto.randomUUID() };
    const results = await Promise.allSettled([apply(one), apply(two)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await readOwnerStock(db, scope, v))!.item.facebookReserved).toBe(1);
  });
  it("preserves owned checkout holds and paid allocated units while receiving and selling the FB unit", async () => {
    const h = await held();
    const paid = await legacyHistory();
    for (const v of [h.variantId, paid.item.variantId]) {
      const before = (await request(v)).expected;
      await apply(await request(v, "fb_reserve"));
      await apply(await request(v, "fb_sale"));
      await apply(await request(v, "receive", 2));
      const after = (await request(v)).expected;
      expect(after.checkoutReserved).toBe(before.checkoutReserved);
      expect(after.allocated).toBe(before.allocated);
      expect(after.onHand).toBe(before.onHand + 1);
    }
    // Remove only unprotected stock with fixture operations, then no FB unit remains.
    await applyStockCommand(
      db,
      `fixture-reserve-${crypto.randomUUID()}`,
      [
        {
          variantId: h.variantId,
          kind: "reserve",
          quantity: 4,
          expectedVersion: 1,
          reason: "Fictional competition",
        },
      ],
      now,
    );
    await expect(
      apply(await request(h.variantId, "fb_reserve")),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("rolls back ignored movement, balance, command and receipt writes without residual audit rows", async () => {
    const v = await fixture();
    for (const [table, event] of [
      ["commerce_stock_movements", "INSERT"],
      ["commerce_inventory", "UPDATE"],
      ["commerce_commands", "INSERT"],
      ["commerce_owner_stock_commands", "INSERT"],
    ]) {
      const before = await allHistory(),
        r = await request(v);
      await db
        .prepare(
          `CREATE TRIGGER fixture_ignore BEFORE ${event} ON ${table} BEGIN SELECT RAISE(IGNORE); END`,
        )
        .run();
      await expect(apply(r)).rejects.toMatchObject({ code: "unavailable" });
      expect(await allHistory()).toEqual(before);
      await db.prepare("DROP TRIGGER fixture_ignore").run();
    }
  });
  it("recovers committed lost responses and unknown acknowledgements using the original receipt only", async () => {
    const v = await fixture();
    for (const phase of ["after", "unknown"] as const) {
      const r = await request(v);
      const fault = faultDatabase(
        (sql) => sql.startsWith("INSERT INTO commerce_owner_stock_commands"),
        phase,
      );
      expect(
        await applyOwnerStock(fault, scope, actor, r, () => now),
      ).toMatchObject({ replayed: true });
      expect(await lookupOwnerStockCommand(db, scope, actor, r)).toMatchObject({
        state: "recorded",
      });
    }
    const r = await request(v);
    await expect(
      applyOwnerStock(
        faultDatabase(() => true, "before", "first"),
        scope,
        actor,
        r,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await lookupOwnerStockCommand(db, scope, actor, r)).toEqual({
      state: "not_recorded",
    });
    expect(await ownerCount()).toBe(2);
  });
  it("keeps committed stock recoverable when readback is unavailable and recovers a same-key concurrent winner", async () => {
    const v = await fixture(),
      r = await request(v);
    let committed = false;
    const faulty = new Proxy(db, {
      get(t, k) {
        if (k === "prepare")
          return (sql: string) => {
            const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(stmt, {
                get(s, key) {
                  if (key === "bind")
                    return (...args: unknown[]) => wrap(s.bind(...args));
                  if (
                    key === "first" &&
                    sql.includes("FROM commerce_owner_stock_commands r")
                  )
                    return async () => {
                      if (committed) throw new Error("Private read failure");
                      return s.first();
                    };
                  if (
                    key === "run" &&
                    sql.startsWith("INSERT INTO commerce_owner_stock_commands")
                  )
                    return async () => {
                      const result = await s.run();
                      committed = true;
                      return result;
                    };
                  const value = Reflect.get(s, key);
                  return typeof value === "function" ? value.bind(s) : value;
                },
              });
            return wrap(t.prepare(sql));
          };
        const value = Reflect.get(t, k);
        return typeof value === "function" ? value.bind(t) : value;
      },
    });
    await expect(
      applyOwnerStock(faulty, scope, actor, r, () => now),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await apply(r)).toMatchObject({
      replayed: true,
      after: { onHand: 5 },
    });
    const next = await request(v);
    expect(
      await applyOwnerStock(
        db,
        scope,
        actor,
        next,
        () => now,
        async () => {
          await apply(next);
        },
      ),
    ).toMatchObject({ replayed: true, after: { onHand: 6 } });
    expect(await ownerCount()).toBe(2);
  });
  it("copies input before awaited auth, samples fresh time, and propagates auth refusal without writes", async () => {
    const v = await fixture(),
      r = await request(v, "receive", 2),
      original = structuredClone(r);
    let clock = now;
    const result = await applyOwnerStock(
      db,
      scope,
      actor,
      r,
      () => clock,
      async () => {
        r.quantity = 999;
        r.expected.onHand = 999;
        clock = now + 50;
      },
    );
    expect(result).toMatchObject({
      quantity: 2,
      recordedAt: now + 50,
      after: { onHand: 6 },
    });
    expect(
      await lookupOwnerStockCommand(db, scope, actor, original),
    ).toMatchObject({ state: "recorded" });
    const denied = new Error("authorization denied");
    await expect(
      applyOwnerStock(
        db,
        scope,
        actor,
        await request(v),
        () => now,
        async () => {
          throw denied;
        },
      ),
    ).rejects.toBe(denied);
    expect(await ownerCount()).toBe(1);
  });
  it("rejects missing or wrong local partition and malformed own-data before database work", async () => {
    const v = await fixture(),
      r = await request(v);
    await expect(
      readOwnerStock(db, { ...scope, instanceId: crypto.randomUUID() }, v),
    ).rejects.toMatchObject({ code: "conflict" });
    const spy = vi.fn();
    const noDb = { prepare: spy } as unknown as D1Database;
    for (const raw of [
      { ...r, extra: true },
      { ...r, quantity: 1001 },
      { ...r, operation: "fb_reserve", quantity: 2 },
      Object.defineProperty({ ...r }, "quantity", {
        get() {
          throw new Error("getter ran");
        },
      }),
    ]) {
      await expect(
        applyOwnerStock(noDb, scope, actor, raw as OwnerStockInput),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(spy).not.toHaveBeenCalled();
    await selectBaseline(false);
    await expect(readOwnerStock(db, scope, v)).rejects.toMatchObject({
      code: "conflict",
    });
  });
  it("keeps receipts immutable and prevents appending or forging owner ledger movements", async () => {
    const v = await fixture(),
      r = await request(v);
    await apply(r);
    for (const sql of [
      "UPDATE commerce_owner_stock_commands SET quantity=2",
      "DELETE FROM commerce_owner_stock_commands",
      "INSERT OR REPLACE INTO commerce_owner_stock_commands SELECT * FROM commerce_owner_stock_commands",
    ])
      await expect(db.prepare(sql).run()).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT INTO commerce_stock_movements(command_id,position,variant_id,kind,quantity,expected_variant_version,reason) VALUES (?,1,?,'receive',1,1,'Owner inspected stock receipt')",
        )
        .bind(`owner-stock-${r.requestId}`, v)
        .run(),
    ).rejects.toThrow();
    expect(await ownerCount()).toBe(1);
  });
});
