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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyStockCommand } from "./inventory.server";
import {
  createTestQuote,
  reserveTestOrder,
  getTestOrder,
} from "./orders.server";
import {
  issueTestCheckoutQuote,
  acceptTestCheckoutQuote,
  type TestCheckoutContext,
  type TestCheckoutSelection,
} from "./checkout-acceptance.server";

const root = resolve(process.cwd());
const now = 1_800_000_000_000;
const context: TestCheckoutContext = {
  mode: "local-test",
  instanceId: "11111111-1111-4111-8111-111111111111",
  ownerHash: "a".repeat(64),
};
let directory: string;
let platform: PlatformProxy<Env>;
let db: D1Database;
let sequence = 0;
let beforeUpgrade: unknown;
let preservedOrder: Awaited<ReturnType<typeof reserveTestOrder>>;
const clock = () => now;
const issue = (selection: TestCheckoutSelection) => ({
  issueKey: crypto.randomUUID(),
  selection,
});
const acceptance = (quoteId: string, selection: TestCheckoutSelection) => ({
  acceptanceKey: crypto.randomUUID(),
  quoteId,
  selection,
  acknowledge: true,
});

async function fixture(quantity = 5) {
  const id = `acceptance-fixture-${++sequence}`;
  const product = await db
    .prepare(
      `INSERT INTO products(name,slug,price_cents,quantity,category_id,status,created_at,updated_at) VALUES ('Fictional acceptance test',?,999,999,1,'draft',1,1) RETURNING id`,
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
        "INSERT INTO commerce_variants(id,product_id,sku,colour,size_description,price_cents,active) VALUES (?,?,?,'Gold-tone','Fictional size',1995,1)",
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
        quantity,
        reason: "Fictional inspected receipt",
      },
    ],
    now,
  );
  const selection: TestCheckoutSelection = {
    contractVersion: "local-checkout-v1",
    lines: [{ variantId: id, quantity: 2 }],
    fixtureProfileId: "fixture-ontario",
    deliveryMethod: "pickup",
  };
  return { id, productId: product!.id, selection };
}
async function row(quoteId: string) {
  return (await db
    .prepare("SELECT * FROM commerce_checkout_quotes WHERE quote_id=?")
    .bind(quoteId)
    .first<Record<string, string | number>>())!;
}
async function counts() {
  const result = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM commerce_checkout_quotes) AS quotes, (SELECT COUNT(*) FROM commerce_checkout_acceptances) AS acceptances`,
    )
    .first();
  return result;
}
async function businessState() {
  const tables = [
    "commerce_inventory",
    "commerce_stock_movements",
    "commerce_commands",
    "commerce_orders",
    "commerce_order_lines",
    "commerce_quotes",
    "commerce_payment_attempts",
  ];
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    // Fixed internal table names, no request interpolation.
    result[table] = (await db.prepare(`SELECT * FROM ${table}`).all()).results;
  }
  return result;
}
async function rawQuote(
  source: Record<string, string | number>,
  changes: Record<string, string | number> = {},
) {
  const copied = {
    ...source,
    quote_id: crypto.randomUUID(),
    issue_key: crypto.randomUUID(),
    ...changes,
  };
  const columns = Object.keys(copied);
  return db
    .prepare(
      `INSERT INTO commerce_checkout_quotes(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    )
    .bind(...Object.values(copied))
    .run();
}
/** Fault injection around REAL D1 statements. No query/result simulation. */
function instrument(
  database: D1Database,
  match: string,
  before?: () => Promise<void>,
  after?: () => Promise<void>,
) {
  let fired = false;
  function wrap(
    statement: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (property === "run")
          return async () => {
            const inject = !fired && sql.startsWith(match);
            if (inject) {
              fired = true;
              await before?.();
            }
            const result = await target.run();
            if (inject) await after?.();
            return result;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => wrap(target.prepare(sql), sql);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// Interpose only timing/faults; every successful query uses the real local DB.
function queries(
  database: D1Database,
  intercept: (
    sql: string,
    method: string,
    execute: () => Promise<unknown>,
  ) => Promise<unknown>,
): D1Database {
  function wrap(
    statement: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (property === "first" || property === "all" || property === "run")
          return () => intercept(sql, property, () => target[property]());
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => wrap(target.prepare(sql), sql);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "jewelry-checkout-acceptance-"));
  const migrations = join(directory, "migrations");
  mkdirSync(migrations);
  for (const file of readdirSync(join(root, "migrations")).filter(
    (file) => file.endsWith(".sql") && file < "0017",
  ))
    copyFileSync(join(root, "migrations", file), join(migrations, file));
  const configPath = join(directory, "wrangler.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "fictional-checkout-acceptance-test",
      compatibility_date: "2026-09-29",
      d1_databases: [
        {
          binding: "DB",
          database_name: "fictional-checkout-acceptance-test",
          database_id: "local-test",
          migrations_dir: migrations,
          migrations_table: "catalog_migrations",
        },
      ],
    }),
  );
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
        directory,
      ],
      {
        cwd: root,
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
      persist: { path: join(directory, "v3") },
      remoteBindings: false,
    });
    db = platform.env.DB;
  }
  migrate();
  await connect();
  const historical = await fixture();
  const quote = await createTestQuote(
    db,
    context.ownerHash,
    historical.selection.lines,
    "pickup",
    now,
  );
  preservedOrder = await reserveTestOrder(db, context.ownerHash, quote.id, now);
  beforeUpgrade = await businessState();
  await platform.dispose();
  copyFileSync(
    join(root, "migrations/0017_commerce_checkout_acceptance.sql"),
    join(migrations, "0017_commerce_checkout_acceptance.sql"),
  );
  migrate();
  await connect();
}, 30_000);

afterAll(async () => {
  await platform?.dispose();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("isolated durable test checkout quote acceptance", () => {
  it("upgrades a populated 0016 database without rewriting old lab orders, quotes or stock", async () => {
    expect(await businessState()).toEqual(beforeUpgrade);
    expect(await counts()).toEqual({ quotes: 0, acceptances: 0 });
    expect(
      await getTestOrder(db, context.ownerHash, preservedOrder.id),
    ).toEqual(preservedOrder);
  });

  it.each([
    ["pickup", 0, 399, 4389],
    ["local_delivery", 500, 449, 4939],
    ["shipping", 1500, 549, 6039],
  ] as const)(
    "issues and accepts %s without business writes or response contact data",
    async (deliveryMethod, shippingCents, taxCents, totalCents) => {
      const item = await fixture();
      const selection = { ...item.selection, deliveryMethod };
      const before = await businessState();
      const quote = await issueTestCheckoutQuote(
        db,
        context,
        issue(selection),
        clock,
      );
      expect(quote.snapshot).toMatchObject({
        testOnly: true,
        shippingCents,
        taxCents,
        totalCents,
        subtotalCents: 3990,
        taxBasisPoints: 1000,
      });
      expect(quote.expiresAt).toBe(now + 600000);
      const accepted = await acceptTestCheckoutQuote(
        db,
        context,
        acceptance(quote.quoteId, selection),
        () => now + 1,
      );
      expect(accepted).toMatchObject({
        testOnly: true,
        quoteId: quote.quoteId,
        acceptedAt: now + 1,
      });
      expect(await businessState()).toEqual(before);
      for (const value of [
        "Fictional Ontario Customer",
        "ontario@example.invalid",
        "Fictional Test Street",
        "ownerHash",
        context.ownerHash,
      ])
        expect(JSON.stringify({ quote, accepted })).not.toContain(value);
      const stored = await row(quote.quoteId);
      expect(
        JSON.parse(String(stored.snapshot_json)).fixtureProfile.email,
      ).toBe("ontario@example.invalid");
      const columns = (
        await db
          .prepare("PRAGMA table_info(commerce_checkout_acceptances)")
          .all<{ name: string }>()
      ).results.map((column) => column.name);
      expect(columns).not.toContain("snapshot_json");
    },
  );

  it("supports the bounded BC profile for shipping, but refuses its local-delivery selection", async () => {
    const item = await fixture();
    const selection: TestCheckoutSelection = {
      ...item.selection,
      fixtureProfileId: "fixture-bc",
      deliveryMethod: "shipping",
    };
    const quote = await issueTestCheckoutQuote(
      db,
      context,
      issue(selection),
      clock,
    );
    expect(
      JSON.parse(String((await row(quote.quoteId)).snapshot_json))
        .fixtureProfile.address.province,
    ).toBe("BC");
    await expect(
      issueTestCheckoutQuote(
        db,
        context,
        issue({ ...selection, deliveryMethod: "local_delivery" }),
        clock,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("canonicalizes line order and copies all input before yielding", async () => {
    const a = await fixture();
    const b = await fixture();
    const selection = {
      ...a.selection,
      lines: [
        { variantId: b.id, quantity: 1 },
        { variantId: a.id, quantity: 2 },
      ],
    };
    const input = issue(selection);
    const trusted = { ...context };
    const pending = issueTestCheckoutQuote(db, trusted, input, clock);
    input.selection.lines[0].quantity = 20;
    input.selection.fixtureProfileId = "fixture-bc";
    trusted.ownerHash = "b".repeat(64);
    const quote = await pending;
    const original = {
      ...a.selection,
      lines: [
        { variantId: a.id, quantity: 2 },
        { variantId: b.id, quantity: 1 },
      ],
    };
    expect(
      await issueTestCheckoutQuote(
        db,
        context,
        { issueKey: input.issueKey, selection: original },
        clock,
      ),
    ).toEqual(quote);
    const accepting = acceptance(quote.quoteId, original);
    const acceptanceKey = accepting.acceptanceKey;
    const acceptedPending = acceptTestCheckoutQuote(
      db,
      context,
      accepting,
      clock,
    );
    accepting.selection.lines[0].quantity = 19;
    accepting.quoteId = crypto.randomUUID();
    const accepted = await acceptedPending;
    expect(accepted.quoteId).toBe(quote.quoteId);
    const stable = {
      ...a.selection,
      lines: [
        { variantId: a.id, quantity: 2 },
        { variantId: b.id, quantity: 1 },
      ],
    };
    expect(
      await acceptTestCheckoutQuote(
        db,
        context,
        { ...acceptance(quote.quoteId, stable), acceptanceKey },
        clock,
      ),
    ).toEqual(accepted);
  });

  it("accepts null-prototype own-data records", async () => {
    const item = await fixture();
    const input = Object.assign(Object.create(null), issue(item.selection));
    input.selection = Object.assign(Object.create(null), input.selection);
    input.selection.lines = input.selection.lines.map((line: unknown) =>
      Object.assign(Object.create(null), line),
    );
    expect(
      (
        await issueTestCheckoutQuote(
          db,
          Object.assign(Object.create(null), context),
          input,
          clock,
        )
      ).testOnly,
    ).toBe(true);
  });

  it("rejects extras, getters, inherited fields, symbols, sparse/extended arrays and unsafe quantities before DB access", async () => {
    const item = await fixture();
    let reads = 0;
    let getters = 0;
    const observing = new Proxy(db, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            reads++;
            return target.prepare(sql);
          };
        return Reflect.get(target, property);
      },
    });
    const withGetter = issue(item.selection);
    Object.defineProperty(withGetter, "selection", {
      get() {
        getters++;
        return item.selection;
      },
    });
    const sparse = new Array(1);
    const decorated = [...item.selection.lines];
    Object.assign(decorated, { extra: true });
    const symbol = issue(item.selection);
    Object.defineProperty(symbol, Symbol("x"), { value: 1 });
    const malformed: unknown[] = [
      { ...issue(item.selection), contact: { email: "real@example.com" } },
      issue({ ...item.selection, address: {} } as TestCheckoutSelection),
      issue({
        ...item.selection,
        fixtureProfileId: "arbitrary",
      } as unknown as TestCheckoutSelection),
      issue({
        ...item.selection,
        contractVersion: "other",
      } as unknown as TestCheckoutSelection),
      withGetter,
      symbol,
      Object.create(issue(item.selection)),
      issue({ ...item.selection, lines: sparse }),
      issue({ ...item.selection, lines: decorated }),
      issue({ ...item.selection, lines: [] }),
      issue({
        ...item.selection,
        lines: [...item.selection.lines, ...item.selection.lines],
      }),
      ...[-1, 0, 0.5, NaN, Infinity, 21, Number.MAX_SAFE_INTEGER + 1].map(
        (quantity) =>
          issue({
            ...item.selection,
            lines: [{ variantId: item.id, quantity }],
          }),
      ),
      issue({
        ...item.selection,
        lines: [{ ...item.selection.lines[0], unitPriceCents: 1 }],
      } as unknown as TestCheckoutSelection),
    ];
    for (const input of malformed)
      await expect(
        issueTestCheckoutQuote(observing, context, input, clock),
      ).rejects.toMatchObject({ code: "invalid_request" });
    for (const trusted of [
      { ...context, mode: "live" },
      { ...context, instanceId: "bad" },
      { ...context, ownerHash: "bad" },
      { ...context, extra: true },
    ])
      await expect(
        issueTestCheckoutQuote(
          observing,
          trusted as TestCheckoutContext,
          issue(item.selection),
          clock,
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    expect(getters).toBe(0);
    expect(reads).toBe(0);
    const quote = await issueTestCheckoutQuote(
      db,
      context,
      issue(item.selection),
      clock,
    );
    const accepted = acceptance(quote.quoteId, item.selection);
    for (const input of [
      { ...accepted, acknowledge: false },
      { ...accepted, acknowledge: "true" },
      { ...accepted, totalCents: 1 },
      { ...accepted, quoteId: "bad" },
      { ...accepted, acceptanceKey: "bad" },
    ])
      await expect(
        acceptTestCheckoutQuote(observing, context, input, clock),
      ).rejects.toMatchObject({ code: "invalid_request" });
    expect(reads).toBe(0);
  });

  it("replays original issuance and acceptance after expiry, price/name/stock changes", async () => {
    const item = await fixture();
    const issuing = issue(item.selection);
    const quote = await issueTestCheckoutQuote(db, context, issuing, clock);
    const accepting = acceptance(quote.quoteId, item.selection);
    const accepted = await acceptTestCheckoutQuote(
      db,
      context,
      accepting,
      clock,
    );
    await db
      .prepare(
        "UPDATE commerce_variants SET price_cents=9000,version=version+1 WHERE id=?",
      )
      .bind(item.id)
      .run();
    await db
      .prepare("UPDATE products SET name='Changed name' WHERE id=?")
      .bind(item.productId)
      .run();
    await applyStockCommand(
      db,
      `fb-${item.id}`,
      [
        {
          variantId: item.id,
          kind: "fb_reserve",
          quantity: 5,
          reason: "Separate shelf",
        },
      ],
      now,
    );
    expect(
      await issueTestCheckoutQuote(
        db,
        context,
        issuing,
        () => quote.expiresAt + 10,
      ),
    ).toEqual(quote);
    expect(
      await acceptTestCheckoutQuote(
        db,
        context,
        accepting,
        () => quote.expiresAt + 10,
      ),
    ).toEqual(accepted);
    await expect(
      acceptTestCheckoutQuote(
        db,
        context,
        { ...accepting, acceptanceKey: crypto.randomUUID() },
        clock,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      acceptTestCheckoutQuote(
        db,
        context,
        {
          ...accepting,
          selection: { ...item.selection, deliveryMethod: "shipping" },
        },
        clock,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      issueTestCheckoutQuote(
        db,
        context,
        {
          ...issuing,
          selection: { ...item.selection, deliveryMethod: "shipping" },
        },
        clock,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects owner/instance mismatch and binds one acceptance key to one quote", async () => {
    const item = await fixture();
    const quote = await issueTestCheckoutQuote(
      db,
      context,
      issue(item.selection),
      clock,
    );
    const accepting = acceptance(quote.quoteId, item.selection);
    for (const trusted of [
      { ...context, ownerHash: "b".repeat(64) },
      { ...context, instanceId: crypto.randomUUID() },
    ])
      await expect(
        acceptTestCheckoutQuote(db, trusted, accepting, clock),
      ).rejects.toMatchObject({ code: "conflict" });
    await acceptTestCheckoutQuote(db, context, accepting, clock);
    const next = await issueTestCheckoutQuote(
      db,
      context,
      issue(item.selection),
      clock,
    );
    await expect(
      acceptTestCheckoutQuote(
        db,
        context,
        { ...accepting, quoteId: next.quoteId },
        clock,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    // The same issue key is a different namespace for a different trusted owner.
    const key = crypto.randomUUID();
    const a = await issueTestCheckoutQuote(
      db,
      context,
      { issueKey: key, selection: item.selection },
      clock,
    );
    const b = await issueTestCheckoutQuote(
      db,
      { ...context, ownerHash: "b".repeat(64) },
      { issueKey: key, selection: item.selection },
      clock,
    );
    expect(a.quoteId).not.toBe(b.quoteId);
  });

  it("uses a fresh first-acceptance clock and rejects the exact expiry boundary", async () => {
    const item = await fixture();
    const quote = await issueTestCheckoutQuote(
      db,
      context,
      issue(item.selection),
      clock,
    );
    let prepared = false;
    const observed = new Proxy(db, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            if (sql.startsWith("INSERT INTO commerce_checkout_acceptances"))
              prepared = true;
            return target.prepare(sql);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const before = await counts();
    await expect(
      acceptTestCheckoutQuote(
        observed,
        context,
        acceptance(quote.quoteId, item.selection),
        () => {
          expect(prepared).toBe(true);
          return quote.expiresAt;
        },
      ),
    ).rejects.toMatchObject({ code: "expired_quote" });
    await expect(
      acceptTestCheckoutQuote(
        db,
        context,
        acceptance(quote.quoteId, item.selection),
        () => now - 1,
      ),
    ).rejects.toMatchObject({ code: "expired_quote" });
    expect(await counts()).toEqual(before);
    expect(
      (
        await acceptTestCheckoutQuote(
          db,
          context,
          acceptance(quote.quoteId, item.selection),
          () => quote.expiresAt - 1,
        )
      ).acceptedAt,
    ).toBe(quote.expiresAt - 1);
  });

  it.each(["price", "name", "stock", "hidden", "colour", "sku", "size"])(
    "rechecks %s at first-accept INSERT after preparation",
    async (change) => {
      const item = await fixture();
      const quote = await issueTestCheckoutQuote(
        db,
        context,
        issue(item.selection),
        clock,
      );
      const before = await counts();
      const racing = instrument(
        db,
        "INSERT INTO commerce_checkout_acceptances",
        async () => {
          if (change === "stock")
            await applyStockCommand(
              db,
              `fb-${item.id}`,
              [
                {
                  variantId: item.id,
                  kind: "fb_reserve",
                  quantity: 5,
                  reason: "Shelf",
                },
              ],
              now,
            );
          else if (change === "name")
            await db
              .prepare("UPDATE products SET name='Changed name' WHERE id=?")
              .bind(item.productId)
              .run();
          else if (change === "hidden")
            await db
              .prepare("UPDATE products SET status='hidden' WHERE id=?")
              .bind(item.productId)
              .run();
          else {
            const clauses: Record<string, string> = {
              price: "price_cents=2100",
              colour: "colour='Silver-tone'",
              sku: "sku=sku||'-changed'",
              size: "size_description='Different'",
            };
            await db
              .prepare(
                `UPDATE commerce_variants SET ${clauses[change]},version=version+1 WHERE id=?`,
              )
              .bind(item.id)
              .run();
          }
        },
      );
      await expect(
        acceptTestCheckoutQuote(
          racing,
          context,
          acceptance(quote.quoteId, item.selection),
          clock,
        ),
      ).rejects.toMatchObject({ code: "stale_quote" });
      expect(await counts()).toEqual(before);
    },
  );

  it.each(["name", "stock", "price"])(
    "rechecks %s at issuance INSERT and rolls back the entire multi-line quote",
    async (change) => {
      const a = await fixture();
      const b = await fixture();
      const selection = {
        ...a.selection,
        lines: [a.selection.lines[0], b.selection.lines[0]],
      };
      const before = await counts();
      const racing = instrument(
        db,
        "INSERT INTO commerce_checkout_quotes",
        async () => {
          if (change === "name")
            await db
              .prepare("UPDATE products SET name='Changed name' WHERE id=?")
              .bind(b.productId)
              .run();
          else if (change === "price")
            await db
              .prepare(
                "UPDATE commerce_variants SET price_cents=2100,version=version+1 WHERE id=?",
              )
              .bind(b.id)
              .run();
          else
            await applyStockCommand(
              db,
              `fb-${b.id}`,
              [
                {
                  variantId: b.id,
                  kind: "fb_reserve",
                  quantity: 5,
                  reason: "Shelf",
                },
              ],
              now,
            );
        },
      );
      await expect(
        issueTestCheckoutQuote(racing, context, issue(selection), clock),
      ).rejects.toMatchObject({ code: "stale_quote" });
      expect(await counts()).toEqual(before);
      expect(
        (await db
          .prepare(
            "SELECT checkout_reserved FROM commerce_inventory WHERE variant_id=?",
          )
          .bind(a.id)
          .first<{ checkout_reserved: number }>())!.checkout_reserved,
      ).toBe(0);
    },
  );

  it("recovers committed writes after lost responses and converges exact concurrent requests", async () => {
    const item = await fixture();
    const issuing = issue(item.selection);
    const lostQuote = instrument(
      db,
      "INSERT INTO commerce_checkout_quotes",
      undefined,
      async () => {
        throw new Error("Lost response");
      },
    );
    const quote = await issueTestCheckoutQuote(
      lostQuote,
      context,
      issuing,
      clock,
    );
    const quotes = await Promise.all([
      issueTestCheckoutQuote(db, context, issuing, clock),
      issueTestCheckoutQuote(db, context, issuing, clock),
    ]);
    expect(quotes).toEqual([quote, quote]);
    const accepting = acceptance(quote.quoteId, item.selection);
    const lostAcceptance = instrument(
      db,
      "INSERT INTO commerce_checkout_acceptances",
      undefined,
      async () => {
        throw new Error("Lost response");
      },
    );
    const accepted = await acceptTestCheckoutQuote(
      lostAcceptance,
      context,
      accepting,
      clock,
    );
    expect(
      await acceptTestCheckoutQuote(db, context, accepting, clock),
    ).toEqual(accepted);
    const secondInput = issue(item.selection);
    const fresh = await Promise.all([
      issueTestCheckoutQuote(db, context, secondInput, clock),
      issueTestCheckoutQuote(db, context, secondInput, clock),
    ]);
    expect(fresh[0]).toEqual(fresh[1]);
    const sameAcceptance = acceptance(fresh[0].quoteId, item.selection);
    const results = await Promise.all([
      acceptTestCheckoutQuote(db, context, sameAcceptance, clock),
      acceptTestCheckoutQuote(db, context, sameAcceptance, clock),
    ]);
    expect(results[0]).toEqual(results[1]);
    const third = await issueTestCheckoutQuote(
      db,
      context,
      issue(item.selection),
      clock,
    );
    const differentKeys = await Promise.allSettled([
      acceptTestCheckoutQuote(
        db,
        context,
        acceptance(third.quoteId, item.selection),
        clock,
      ),
      acceptTestCheckoutQuote(
        db,
        context,
        acceptance(third.quoteId, item.selection),
        clock,
      ),
    ]);
    expect(
      differentKeys.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
  });

  it("keeps quote and acceptance immutable including natural-key REPLACE", async () => {
    const item = await fixture();
    const quote = await issueTestCheckoutQuote(
      db,
      context,
      issue(item.selection),
      clock,
    );
    await acceptTestCheckoutQuote(
      db,
      context,
      acceptance(quote.quoteId, item.selection),
      clock,
    );
    const before = await counts();
    for (const table of [
      "commerce_checkout_quotes",
      "commerce_checkout_acceptances",
    ]) {
      const original = (await db
        .prepare(`SELECT * FROM ${table} WHERE quote_id=?`)
        .bind(quote.quoteId)
        .first<Record<string, string | number>>())!;
      const identity =
        table === "commerce_checkout_quotes" ? "quote_id" : "acceptance_id";
      for (const verb of ["UPDATE", "DELETE"]) {
        const sql =
          verb === "UPDATE"
            ? `UPDATE ${table} SET owner_hash=owner_hash WHERE quote_id=?`
            : `DELETE FROM ${table} WHERE quote_id=?`;
        await expect(
          db.prepare(sql).bind(quote.quoteId).run(),
        ).rejects.toThrow();
      }
      const columns = Object.keys(original);
      for (const replacement of [
        original,
        { ...original, [identity]: crypto.randomUUID() },
      ]) {
        await expect(
          db
            .prepare(
              `INSERT OR REPLACE INTO ${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
            )
            .bind(...columns.map((name) => replacement[name]))
            .run(),
        ).rejects.toThrow();
      }
      expect(
        await db
          .prepare(`SELECT * FROM ${table} WHERE quote_id=?`)
          .bind(quote.quoteId)
          .first(),
      ).toEqual(original);
    }
    expect(await counts()).toEqual(before);
  });

  it("SQL rejects typed amount, TTL, line/selection and owner/time mismatches without trusting hashes", async () => {
    const item = await fixture();
    const quote = await issueTestCheckoutQuote(
      db,
      context,
      issue(item.selection),
      clock,
    );
    const original = await row(quote.quoteId);
    const before = await counts();
    for (const [field, value] of [
      ["totalCents", 1],
      ["subtotalCents", "3990"],
      ["taxCents", 0.5],
      ["taxBasisPoints", 10001],
      ["shippingCents", -1],
      ["totalCents", Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      const snapshot = JSON.parse(String(original.snapshot_json));
      snapshot[field] = value;
      await expect(
        rawQuote(original, { snapshot_json: JSON.stringify(snapshot) }),
      ).rejects.toThrow();
    }
    const snapshot = JSON.parse(String(original.snapshot_json));
    snapshot.lines[0].quantity = 3;
    await expect(
      rawQuote(original, { snapshot_json: JSON.stringify(snapshot) }),
    ).rejects.toThrow();
    const selection = JSON.parse(String(original.selection_json));
    selection.lines[0].variantId = "missing";
    await expect(
      rawQuote(original, { selection_json: JSON.stringify(selection) }),
    ).rejects.toThrow();
    for (const expires_at of [now, now + 600001, now + 600000.5])
      await expect(rawQuote(original, { expires_at })).rejects.toThrow();
    const sql =
      "INSERT INTO commerce_checkout_acceptances(acceptance_id,mode,instance_id,owner_hash,acceptance_key,quote_id,request_hash,accepted_at) VALUES (?,'local-test',?,?,?,?,?,?)";
    for (const [owner, at] of [
      ["b".repeat(64), now],
      [context.ownerHash, now - 1],
      [context.ownerHash, quote.expiresAt],
    ] as const) {
      await expect(
        db
          .prepare(sql)
          .bind(
            crypto.randomUUID(),
            context.instanceId,
            owner,
            crypto.randomUUID(),
            quote.quoteId,
            "c".repeat(64),
            at,
          )
          .run(),
      ).rejects.toThrow();
    }
    expect(await counts()).toEqual(before);
  });

  it("validates clock and amount bounds, including maximum supported lines and half-up tax", async () => {
    const item = await fixture(20);
    for (const value of [-1, NaN, Infinity, 0.5, 8_640_000_000_000_000])
      await expect(
        issueTestCheckoutQuote(db, context, issue(item.selection), () => value),
      ).rejects.toMatchObject({ code: "invalid_request" });
    await db
      .prepare(
        "UPDATE commerce_variants SET price_cents=5,version=version+1 WHERE id=?",
      )
      .bind(item.id)
      .run();
    const selection = {
      ...item.selection,
      lines: [{ variantId: item.id, quantity: 1 }],
    };
    expect(
      (await issueTestCheckoutQuote(db, context, issue(selection), clock))
        .snapshot.taxCents,
    ).toBe(1);
    const items = await Promise.all(
      Array.from({ length: 20 }, () => fixture(20)),
    );
    const maximum = {
      ...item.selection,
      lines: items.map(({ id }) => ({ variantId: id, quantity: 20 })),
    };
    const quote = await issueTestCheckoutQuote(
      db,
      context,
      issue(maximum),
      clock,
    );
    expect(quote.snapshot.lines).toHaveLength(20);
    await acceptTestCheckoutQuote(
      db,
      context,
      acceptance(quote.quoteId, maximum),
      clock,
    );
    await expect(
      issueTestCheckoutQuote(
        db,
        context,
        issue({ ...maximum, lines: [...maximum.lines, selection.lines[0]] }),
        clock,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("recovers a concurrent issue-key winner before fresh stock validation fails", async () => {
    const item = await fixture();
    const input = issue(item.selection);
    let first = true;
    let winner: Awaited<ReturnType<typeof issueTestCheckoutQuote>> | undefined;
    const raced = queries(db, async (sql, method, execute) => {
      const result = await execute();
      if (
        first &&
        method === "all" &&
        sql.startsWith("SELECT * FROM commerce_checkout_quotes")
      ) {
        first = false;
        winner = await issueTestCheckoutQuote(db, context, input, clock);
        await applyStockCommand(
          db,
          `late-fb-${item.id}`,
          [
            {
              variantId: item.id,
              kind: "fb_reserve",
              quantity: 5,
              reason: "All remaining stock moved",
            },
          ],
          now,
        );
      }
      return result;
    });
    expect(await issueTestCheckoutQuote(raced, context, input, clock)).toEqual(
      winner,
    );
  });

  it("recovers a concurrent acceptance-key winner before a fresh expiry rejection", async () => {
    const item = await fixture();
    const quote = await issueTestCheckoutQuote(
      db,
      context,
      issue(item.selection),
      clock,
    );
    const input = acceptance(quote.quoteId, item.selection);
    let first = true;
    let winner: Awaited<ReturnType<typeof acceptTestCheckoutQuote>> | undefined;
    const raced = queries(db, async (sql, method, execute) => {
      const result = await execute();
      if (
        first &&
        method === "all" &&
        sql.startsWith("SELECT * FROM commerce_checkout_acceptances")
      ) {
        first = false;
        winner = await acceptTestCheckoutQuote(db, context, input, clock);
      }
      return result;
    });
    expect(
      await acceptTestCheckoutQuote(
        raced,
        context,
        input,
        () => quote.expiresAt,
      ),
    ).toEqual(winner);
  });

  it("normalizes prewrite read and write outages without SQL or input disclosure", async () => {
    const item = await fixture();
    const issuing = issue(item.selection);
    const brokenRead = queries(db, async () => {
      throw new Error("secret SQL SELECT contact@example.com");
    });
    const quote = await issueTestCheckoutQuote(
      db,
      context,
      issue(item.selection),
      clock,
    );
    const accepting = acceptance(quote.quoteId, item.selection);
    const before = await counts();
    for (const pending of [
      issueTestCheckoutQuote(brokenRead, context, issuing, clock),
      acceptTestCheckoutQuote(brokenRead, context, accepting, clock),
    ]) {
      const error = await pending.catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        name: "CheckoutAcceptanceError",
        code: "unavailable",
      });
      expect(String(error)).not.toContain("secret");
      expect(error).not.toHaveProperty("cause");
    }
    const brokenWrite = queries(db, async (_sql, method, execute) => {
      if (method === "run") throw new Error("database offline");
      return execute();
    });
    await expect(
      issueTestCheckoutQuote(brokenWrite, context, issuing, clock),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      acceptTestCheckoutQuote(brokenWrite, context, accepting, clock),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await counts()).toEqual(before);
  });

  it.each(["lost-response", "postcommit-read"])(
    "normalizes %s readback outages, preserving original-key recovery",
    async (mode) => {
      const item = await fixture();
      const issuing = issue(item.selection);
      function readbackFailure() {
        let committed = false;
        return queries(db, async (_sql, method, execute) => {
          if (committed) throw new Error("readback unavailable: private SQL");
          const result = await execute();
          if (method === "run") {
            committed = true;
            if (mode === "lost-response")
              throw new Error("response lost after commit");
          }
          return result;
        });
      }
      await expect(
        issueTestCheckoutQuote(readbackFailure(), context, issuing, clock),
      ).rejects.toMatchObject({ code: "unavailable" });
      const quote = await issueTestCheckoutQuote(db, context, issuing, clock);
      const accepting = acceptance(quote.quoteId, item.selection);
      await expect(
        acceptTestCheckoutQuote(readbackFailure(), context, accepting, clock),
      ).rejects.toMatchObject({ code: "unavailable" });
      const accepted = await acceptTestCheckoutQuote(
        db,
        context,
        accepting,
        () => quote.expiresAt + 1,
      );
      expect(accepted.acceptedAt).toBe(now);
      expect(
        await issueTestCheckoutQuote(
          db,
          context,
          issuing,
          () => quote.expiresAt + 1,
        ),
      ).toEqual(quote);
    },
  );
});
