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
import {
  createTestQuote,
  getTestOrder,
  releaseTestOrder,
  reserveTestOrder,
} from "./orders.server";
import {
  lookupReservationRecovery,
  recoverExpiredReservation,
  type ReservationRecoveryInput,
} from "./reservation-recovery.server";

const root = resolve(process.cwd());
const now = 1_800_000_000_000;
const actor = {
  email: "fictional-owner@example.invalid",
  sub: "fictional-approved-operator",
};
const owner = "a".repeat(64);
let directory: string;
let configPath: string;
let platform: PlatformProxy<Env>;
let db: D1Database;
let sequence = 0;
let legacy: Awaited<ReturnType<typeof reserved>>;
let beforeUpgrade: unknown;

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
      timeout: 20000,
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
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "jewelry-recovery-"));
  const migrations = join(directory, "migrations");
  mkdirSync(migrations);
  for (const file of readdirSync(join(root, "migrations")).filter(
    (file) => file.endsWith(".sql") && file < "0008",
  ))
    copyFileSync(join(root, "migrations", file), join(migrations, file));
  configPath = join(directory, "wrangler.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "fictional-recovery-test",
      compatibility_date: "2026-09-29",
      d1_databases: [
        {
          binding: "DB",
          database_name: "fictional-recovery-local",
          migrations_dir: "migrations",
          migrations_table: "catalog_migrations",
        },
      ],
    }),
  );
  migrate();
  await connect();
  legacy = await reserved();
  beforeUpgrade = await snapshot(legacy);
  // A 0007 database cannot establish a durable recovery receipt.
  expect(
    await lookupReservationRecovery(db, actor, input(legacy.order.id)),
  ).toEqual({ state: "unavailable" });
  expect(await snapshot(legacy)).toEqual(beforeUpgrade);
  await platform.dispose();
  copyFileSync(
    join(root, "migrations/0008_commerce_reservation_recovery.sql"),
    join(migrations, "0008_commerce_reservation_recovery.sql"),
  );
  migrate();
  await connect();
}, 30000);
afterAll(async () => {
  await platform?.dispose();
  if (directory) rmSync(directory, { recursive: true, force: true });
}, 10000);

async function variant() {
  const id = `recovery-${++sequence}`;
  const product = await db
    .prepare(
      "INSERT INTO products(name,slug,price_cents,quantity,category_id,status,created_at,updated_at) VALUES('Fictional recovery',?,2500,0,1,'draft',1,1) RETURNING id",
    )
    .bind(id)
    .first<{ id: number }>();
  await db.batch([
    db
      .prepare(
        "INSERT INTO product_images(product_id,r2_key,sort_order,created_at) VALUES(?,?,0,1)",
      )
      .bind(product!.id, `fictional/${id}.jpg`),
    db
      .prepare("UPDATE products SET status='available' WHERE id=?")
      .bind(product!.id),
    db
      .prepare(
        "INSERT INTO commerce_variants(id,product_id,sku,colour,size_description,price_cents,active) VALUES(?,?,?,'Gold-tone','Fictional size',2500,1)",
      )
      .bind(id, product!.id, id),
  ]);
  await applyStockCommand(
    db,
    `receipt-${id}`,
    [
      {
        variantId: id,
        kind: "receive",
        quantity: 20,
        reason: "Fictional receipt",
      },
      {
        variantId: id,
        kind: "fb_reserve",
        quantity: 1,
        reason: "Fictional FB separation",
      },
    ],
    now,
  );
  return id;
}
async function reserved() {
  const ids = [await variant(), await variant()];
  const quote = await createTestQuote(
    db,
    owner,
    ids.map((variantId) => ({ variantId, quantity: 2 })),
    "pickup",
    now,
  );
  const order = await reserveTestOrder(db, owner, quote.id, now + 1);
  const other = await createTestQuote(
    db,
    "b".repeat(64),
    [{ variantId: ids[0], quantity: 1 }],
    "pickup",
    now + 2,
  );
  await reserveTestOrder(db, "b".repeat(64), other.id, now + 3);
  return { order, ids };
}
function input(
  reference: string,
  expectedVersion = 1,
): ReservationRecoveryInput {
  return {
    requestId: crypto.randomUUID(),
    reference,
    expectedVersion,
    confirmation: reference,
    reason: "overdue_unpaid",
  };
}
async function snapshot(item: Awaited<ReturnType<typeof reserved>>) {
  return {
    order: await db
      .prepare(
        "SELECT state,payment_state,fulfillment,version FROM commerce_orders WHERE id=?",
      )
      .bind(item.order.id)
      .first(),
    stock: (
      await db
        .prepare(
          "SELECT * FROM commerce_inventory WHERE variant_id IN (?,?) ORDER BY variant_id",
        )
        .bind(...item.ids)
        .all()
    ).results,
    audit: (
      await db
        .prepare(
          "SELECT * FROM commerce_reservation_recoveries WHERE order_id=?",
        )
        .bind(item.order.id)
        .all()
        .catch(() => ({ results: [] }))
    ).results,
    transitions: (
      await db
        .prepare("SELECT * FROM commerce_order_transitions WHERE order_id=?")
        .bind(item.order.id)
        .all()
    ).results,
  };
}
function wrap(beforeBatch: () => Promise<unknown>, loseResponse = false) {
  return {
    prepare: db.prepare.bind(db),
    async batch(statements: D1PreparedStatement[]) {
      await beforeBatch();
      const result = await db.batch(statements);
      if (loseResponse) throw new Error("private lost response details");
      return result;
    },
  } as D1Database;
}

describe("operator recovery atomicity and audit on migrated local D1", () => {
  it("reads only durable matching receipts, preserving commands, audit, orders and inventory", async () => {
    const item = await reserved();
    const command = input(item.order.id);
    const tables = [
      "commerce_commands",
      "commerce_reservation_recoveries",
      "commerce_orders",
      "commerce_order_transitions",
      "commerce_inventory",
      "commerce_stock_movements",
    ];
    const allRecords = () =>
      Promise.all(
        tables.map(
          async (table) =>
            (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
              .results,
        ),
      );
    const absentBefore = await allRecords();
    expect(await lookupReservationRecovery(db, actor, command)).toEqual({
      state: "not_recorded",
    });
    expect(await allRecords()).toEqual(absentBefore);
    const original = await recoverExpiredReservation(
      db,
      actor,
      command,
      item.order.reserveUntil,
    );
    const before = await allRecords();
    expect(await lookupReservationRecovery(db, actor, command)).toEqual({
      state: "recorded",
      receipt: { ...original, replayed: true },
    });
    expect(
      await lookupReservationRecovery(
        db,
        { ...actor, sub: "another-approved-human" },
        command,
      ),
    ).toEqual({ state: "conflict" });
    expect(
      await lookupReservationRecovery(db, actor, {
        ...command,
        expectedVersion: 2,
      }),
    ).toEqual({ state: "conflict" });
    const otherReference = `order-${"0".repeat(36)}`;
    expect(
      await lookupReservationRecovery(db, actor, {
        ...command,
        reference: otherReference,
        confirmation: otherReference,
      }),
    ).toEqual({ state: "conflict" });
    expect(
      await lookupReservationRecovery(db, actor, {
        ...command,
        requestId: crypto.randomUUID(),
      }),
    ).toEqual({ state: "not_recorded" });
    const outage = {
      prepare() {
        throw new Error("private receipt outage");
      },
    } as unknown as D1Database;
    expect(await lookupReservationRecovery(outage, actor, command)).toEqual({
      state: "unavailable",
    });
    expect(await allRecords()).toEqual(before);
  });
  it("upgrades an existing reservation without changing stock, order or history", async () => {
    expect(await snapshot(legacy)).toEqual(beforeUpgrade);
    const result = await recoverExpiredReservation(
      db,
      actor,
      input(legacy.order.id),
      legacy.order.reserveUntil,
    );
    expect(result).toMatchObject({
      testOnly: true,
      reference: legacy.order.id,
      resultingVersion: 2,
      replayed: false,
    });
  });
  it("releases only its own lines, preserves FB/another order, and writes one immutable pseudonymous audit", async () => {
    const item = await reserved();
    const command = input(item.order.id);
    const before = await snapshot(item);
    const result = await recoverExpiredReservation(
      db,
      actor,
      command,
      item.order.reserveUntil,
    );
    expect(Object.keys(result).sort()).toEqual(
      [
        "testOnly",
        "requestId",
        "reference",
        "expectedVersion",
        "recordedAt",
        "resultingVersion",
        "replayed",
      ].sort(),
    );
    const after = await snapshot(item);
    expect(after.order).toMatchObject({
      state: "cancelled",
      payment_state: "not_started",
      fulfillment: "none",
      version: 2,
    });
    for (let index = 0; index < 2; index++) {
      expect(after.stock[index]).toEqual({
        ...before.stock[index],
        checkout_reserved: Number(before.stock[index].checkout_reserved) - 2,
      });
      expect(after.stock[index].facebook_reserved).toBe(1);
    }
    expect(after.audit).toHaveLength(1);
    expect(after.transitions).toHaveLength(1);
    expect(after.audit[0]).toMatchObject({
      command_id: `recovery-${command.requestId}`,
      reason: "overdue_unpaid",
      expected_version: 1,
      occurred_at: item.order.reserveUntil,
      actor_hash: await commandHash({
        kind: "admin-recovery-actor-v1",
        ...actor,
      }),
    });
    expect(JSON.stringify({ result, audit: after.audit })).not.toMatch(
      /fictional-owner|fictional-approved-operator|owner_hash|snapshot/,
    );
    for (const sql of [
      "UPDATE commerce_reservation_recoveries SET reason='overdue_unpaid' WHERE command_id=?",
      "DELETE FROM commerce_reservation_recoveries WHERE command_id=?",
      "INSERT OR REPLACE INTO commerce_reservation_recoveries SELECT * FROM commerce_reservation_recoveries WHERE command_id=?",
    ])
      await expect(
        db.prepare(sql).bind(`recovery-${command.requestId}`).run(),
      ).rejects.toThrow();
    expect((await snapshot(item)).audit).toEqual(after.audit);
  });
  it("replays the same canonical input across property order and time, rejecting changed actors/payloads", async () => {
    const item = await reserved();
    const command = input(item.order.id);
    const first = await recoverExpiredReservation(
      db,
      actor,
      command,
      item.order.reserveUntil,
    );
    const before = await snapshot(item);
    const reordered = {
      reason: command.reason,
      confirmation: command.confirmation,
      expectedVersion: command.expectedVersion,
      reference: command.reference,
      requestId: command.requestId,
    };
    expect(
      await recoverExpiredReservation(
        db,
        actor,
        reordered,
        item.order.reserveUntil + 100,
      ),
    ).toEqual({ ...first, replayed: true });
    await expect(
      recoverExpiredReservation(
        db,
        { ...actor, sub: "other-approved-person" },
        command,
        item.order.reserveUntil,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      recoverExpiredReservation(
        db,
        actor,
        { ...command, expectedVersion: 2 },
        item.order.reserveUntil,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const other = await reserved();
    await expect(
      recoverExpiredReservation(
        db,
        actor,
        { ...command, reference: other.order.id, confirmation: other.order.id },
        item.order.reserveUntil,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await snapshot(item)).toEqual(before);
  });
  it("handles simultaneous identical/different requests and ordinary expiry without a double release", async () => {
    const item = await reserved();
    const command = input(item.order.id);
    const same = await Promise.all([
      recoverExpiredReservation(db, actor, command, item.order.reserveUntil),
      recoverExpiredReservation(db, actor, command, item.order.reserveUntil),
    ]);
    expect(same.filter((result) => !result.replayed)).toHaveLength(1);
    const other = await reserved();
    const different = await Promise.allSettled([
      recoverExpiredReservation(
        db,
        actor,
        input(other.order.id),
        other.order.reserveUntil,
      ),
      recoverExpiredReservation(
        db,
        actor,
        input(other.order.id),
        other.order.reserveUntil,
      ),
    ]);
    expect(
      different.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect((await snapshot(other)).audit).toHaveLength(1);
    expect((await snapshot(other)).transitions).toHaveLength(1);
    const expired = await reserved();
    await expect(
      recoverExpiredReservation(
        wrap(() =>
          releaseTestOrder(
            db,
            owner,
            expired.order.id,
            "expire",
            expired.order.reserveUntil,
          ),
        ),
        actor,
        input(expired.order.id),
        expired.order.reserveUntil,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await snapshot(expired)).audit).toHaveLength(0);
    expect((await snapshot(expired)).transitions).toHaveLength(1);
  });
  it.each([
    "processing",
    "unknown",
    "succeeded",
    "failed",
    "held",
    "confirmed",
    "version",
    "future",
  ])(
    "rejects a %s race inside the transaction, even after the initial check",
    async (change) => {
      const item = await reserved();
      const command = input(item.order.id);
      const raced = wrap(async () => {
        if (change === "held")
          await db
            .prepare("UPDATE commerce_orders SET fulfillment='held' WHERE id=?")
            .bind(item.order.id)
            .run();
        else if (change === "confirmed")
          await db
            .prepare("UPDATE commerce_orders SET state='confirmed' WHERE id=?")
            .bind(item.order.id)
            .run();
        else if (change === "version")
          await db
            .prepare("UPDATE commerce_orders SET version=version+1 WHERE id=?")
            .bind(item.order.id)
            .run();
        else if (change === "future")
          await db
            .prepare(
              "UPDATE commerce_orders SET reserve_until=reserve_until+10000 WHERE id=?",
            )
            .bind(item.order.id)
            .run();
        else
          await db
            .prepare("UPDATE commerce_orders SET payment_state=? WHERE id=?")
            .bind(change, item.order.id)
            .run();
      });
      const before = await snapshot(item);
      await expect(
        recoverExpiredReservation(
          raced,
          actor,
          command,
          item.order.reserveUntil,
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      const after = await snapshot(item);
      expect(after.stock).toEqual(before.stock);
      expect(after.audit).toHaveLength(0);
      expect(after.transitions).toHaveLength(0);
      expect(
        await db
          .prepare("SELECT id FROM commerce_commands WHERE id=?")
          .bind(`recovery-${command.requestId}`)
          .first(),
      ).toBeNull();
    },
  );
  it("refuses future/stale/missing/already-cancelled records without treating them as recovery success", async () => {
    const item = await reserved();
    const command = input(item.order.id);
    await expect(
      recoverExpiredReservation(
        db,
        actor,
        command,
        item.order.reserveUntil - 1,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      recoverExpiredReservation(
        db,
        actor,
        { ...command, expectedVersion: 2 },
        item.order.reserveUntil,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const missing = `order-${"0".repeat(36)}`;
    await expect(
      recoverExpiredReservation(
        db,
        actor,
        input(missing),
        item.order.reserveUntil,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await releaseTestOrder(
      db,
      owner,
      item.order.id,
      "cancel",
      item.order.reserveUntil,
    );
    await expect(
      recoverExpiredReservation(db, actor, command, item.order.reserveUntil),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await snapshot(item)).audit).toHaveLength(0);
  });
  it("rolls back all lines, command and audit if a later stock release cannot be applied", async () => {
    const item = await reserved();
    const command = input(item.order.id);
    // Deliberately corrupt a fixture balance to exercise a later-line CHECK failure.
    await db
      .prepare(
        "UPDATE commerce_inventory SET checkout_reserved=0 WHERE variant_id=?",
      )
      .bind(item.ids[1])
      .run();
    const before = await snapshot(item);
    await expect(
      recoverExpiredReservation(db, actor, command, item.order.reserveUntil),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: "Local reservation recovery could not be confirmed",
    });
    expect(await snapshot(item)).toEqual(before);
    expect(
      await db
        .prepare("SELECT id FROM commerce_commands WHERE id=?")
        .bind(`recovery-${command.requestId}`)
        .first(),
    ).toBeNull();
  });
  it("recognizes a committed write after response loss and allows safe replay after a read outage", async () => {
    const item = await reserved();
    const command = input(item.order.id);
    const result = await recoverExpiredReservation(
      wrap(async () => {}, true),
      actor,
      command,
      item.order.reserveUntil,
    );
    expect(result.replayed).toBe(true);
    const before = await snapshot(item);
    await expect(
      recoverExpiredReservation(
        {
          prepare() {
            throw new Error("private database path");
          },
        } as unknown as D1Database,
        actor,
        command,
        item.order.reserveUntil,
      ),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: "Local reservation recovery could not be confirmed",
    });
    expect(
      await recoverExpiredReservation(
        db,
        actor,
        command,
        item.order.reserveUntil + 1,
      ),
    ).toMatchObject({ replayed: true, recordedAt: item.order.reserveUntil });
    expect(await snapshot(item)).toEqual(before);
    expect((await getTestOrder(db, owner, item.order.id))?.state).toBe(
      "cancelled",
    );
  });
  it("validates confirmation, reason, fields, version, identity and clock before touching storage", async () => {
    const prepare = vi.fn();
    const absent = { prepare } as unknown as D1Database;
    const valid = input(`order-${"0".repeat(36)}`);
    for (const bad of [
      { ...valid, requestId: "bad" },
      { ...valid, reference: "bad" },
      { ...valid, confirmation: "yes" },
      { ...valid, reason: "private customer notes" },
      { ...valid, expectedVersion: 0 },
      { ...valid, expectedVersion: Number.MAX_SAFE_INTEGER },
      { ...valid, extra: "ignored" },
      null,
    ])
      await expect(
        recoverExpiredReservation(
          absent,
          actor,
          bad as ReservationRecoveryInput,
          now,
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      recoverExpiredReservation(absent, { ...actor, sub: "" }, valid, now),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      recoverExpiredReservation(absent, actor, valid, -1),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(prepare).not.toHaveBeenCalled();
  });
  it("does not claim success when both the write response and audit read are lost; same-key replay resolves it", async () => {
    const item = await reserved();
    const command = input(item.order.id);
    let committed = false;
    const unavailable = {
      prepare(sql: string) {
        if (committed) throw new Error("private audit-read outage");
        return db.prepare(sql);
      },
      async batch(statements: D1PreparedStatement[]) {
        await db.batch(statements);
        committed = true;
        throw new Error("private response loss");
      },
    } as unknown as D1Database;
    await expect(
      recoverExpiredReservation(
        unavailable,
        actor,
        command,
        item.order.reserveUntil,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    const after = await snapshot(item);
    expect(after.audit).toHaveLength(1);
    expect(after.transitions).toHaveLength(1);
    expect(
      await recoverExpiredReservation(
        db,
        actor,
        command,
        item.order.reserveUntil + 1,
      ),
    ).toMatchObject({ replayed: true });
    expect(await snapshot(item)).toEqual(after);
  });
  it.each(["preflight", "failed-batch reconciliation"])(
    "reconciles an identical commit between receipt lookup and the %s order read",
    async (stage) => {
      const item = await reserved();
      const command = input(item.order.id);
      let committed:
        Awaited<ReturnType<typeof recoverExpiredReservation>> | undefined;
      let orderReads = 0;
      const batch = vi.fn(async () => {
        throw new Error("Fictional transient write failure");
      });
      const interleaved = {
        prepare(sql: string) {
          const statement = db.prepare(sql);
          if (
            !sql.includes(
              "reserve_until AS reserveUntil, version FROM commerce_orders",
            )
          )
            return statement;
          return {
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return {
                async first() {
                  orderReads += 1;
                  // A receipt lookup has returned null. Commit the identical
                  // request before this preflight/reconciliation read resolves.
                  if (orderReads === (stage === "preflight" ? 1 : 2))
                    committed = await recoverExpiredReservation(
                      db,
                      actor,
                      command,
                      item.order.reserveUntil,
                    );
                  return bound.first();
                },
              };
            },
          };
        },
        batch,
      } as unknown as D1Database;
      const result = await recoverExpiredReservation(
        interleaved,
        actor,
        command,
        item.order.reserveUntil,
      );
      expect(committed?.replayed).toBe(false);
      expect(result).toEqual({ ...committed, replayed: true });
      expect(batch).toHaveBeenCalledTimes(stage === "preflight" ? 0 : 1);
      const after = await snapshot(item);
      expect(after.audit).toHaveLength(1);
      expect(after.transitions).toHaveLength(1);
      expect(after.stock[0].checkout_reserved).toBe(1);
      expect(after.stock[1].checkout_reserved).toBe(0);
    },
  );
});
