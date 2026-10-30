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
  issueTestCheckoutQuote,
  acceptTestCheckoutQuote,
  type TestCheckoutSelection,
  type TestCheckoutContext,
} from "./checkout-acceptance.server";
import { createTestCheckoutOrder } from "./checkout-orders.server";
import { createTestQuote, reserveTestOrder } from "./orders.server";
import { releaseTestCheckoutOrder } from "./checkout-release.server";
import {
  loadTestCheckoutSession,
  authorizeTestCheckoutMutation,
  revokeTestCheckoutSession,
  type TestCheckoutSessionConfig,
  type TestCheckoutSession,
} from "./checkout-session.server";
import { commandHash } from "./inventory.server";

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
const clock = () => now;
let historical: Awaited<ReturnType<typeof reserveTestOrder>>;
let historicalHeld: Awaited<ReturnType<typeof held>>;
let beforeUpgrade: unknown;

async function item(stock = 5) {
  const id = `checkout-order-${++sequence}`;
  const product = await db
    .prepare(
      "INSERT INTO products(name,slug,price_cents,category_id,status,created_at,updated_at) VALUES ('Fictional order',?,999,1,'draft',1,1) RETURNING id",
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
    `receipt-${id}`,
    [
      {
        variantId: id,
        quantity: stock,
        kind: "receive",
        reason: "Fictional inspected receipt",
      },
    ],
    now,
  );
  return { id, productId: product!.id };
}
async function accepted(
  lines?: { variantId: string; quantity: number }[],
  trusted = context,
  deliveryMethod: TestCheckoutSelection["deliveryMethod"] = "shipping",
) {
  const fixture = lines ? null : await item();
  const selection: TestCheckoutSelection = {
    contractVersion: "local-checkout-v1",
    lines: lines ?? [{ variantId: fixture!.id, quantity: 2 }],
    fixtureProfileId: "fixture-ontario",
    deliveryMethod,
  };
  const quote = await issueTestCheckoutQuote(
    db,
    trusted,
    { issueKey: crypto.randomUUID(), selection },
    clock,
  );
  const receipt = await acceptTestCheckoutQuote(
    db,
    trusted,
    {
      acceptanceKey: crypto.randomUUID(),
      quoteId: quote.quoteId,
      selection,
      acknowledge: true,
    },
    clock,
  );
  return { selection, quote, receipt, fixture };
}
async function snapshot(includeSessions = true) {
  const tables = [
    "commerce_inventory",
    "commerce_stock_movements",
    "commerce_commands",
    "commerce_quotes",
    "commerce_orders",
    "commerce_order_lines",
    "commerce_order_transitions",
    "commerce_reservation_recoveries",
    "commerce_payment_attempts",
    "commerce_checkout_quotes",
    "commerce_checkout_acceptances",
  ];
  tables.push("commerce_checkout_order_origins");
  tables.push("commerce_checkout_order_releases");
  if (includeSessions) tables.push("commerce_checkout_guest_sessions");
  const result: Record<string, unknown> = {};
  for (const table of tables)
    result[table] = (
      await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
    ).results;
  return result;
}
// Timing/failure injection only: every successful query executes on real local D1.
function queries(
  database: D1Database,
  intercept: (
    sql: string,
    method: string,
    execute: () => Promise<unknown>,
  ) => Promise<unknown>,
): D1Database {
  const wrap = (
    statement: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (property === "run" || property === "all" || property === "first")
          return () => intercept(sql, property, () => target[property]());
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => wrap(target.prepare(sql), sql);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
async function held(
  lines?: { variantId: string; quantity: number }[],
  trusted = context,
) {
  const source = await accepted(lines, trusted);
  const order = await createTestCheckoutOrder(
    db,
    trusted,
    {
      createKey: crypto.randomUUID(),
      acceptanceId: source.receipt.acceptanceId,
    },
    clock,
  );
  return { ...source, order };
}
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "jewelry-checkout-session-"));
  const migrations = join(directory, "migrations");
  mkdirSync(migrations);
  for (const file of readdirSync(join(root, "migrations")).filter(
    (file) => file.endsWith(".sql") && file < "0020",
  ))
    copyFileSync(join(root, "migrations", file), join(migrations, file));
  const configPath = join(directory, "wrangler.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "fictional-checkout-orders-test",
      compatibility_date: "2026-09-29",
      d1_databases: [
        {
          binding: "DB",
          database_name: "fictional-checkout-orders-test",
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
  const legacyItem = await item();
  const legacyQuote = await createTestQuote(
    db,
    context.ownerHash,
    [{ variantId: legacyItem.id, quantity: 1 }],
    "pickup",
    now,
  );
  historical = await reserveTestOrder(
    db,
    context.ownerHash,
    legacyQuote.id,
    now,
  );
  historicalHeld = await held();
  const released = await held();
  await releaseTestCheckoutOrder(
    db,
    context,
    {
      releaseKey: crypto.randomUUID(),
      orderId: released.order.orderId,
      kind: "cancel",
      expectedVersion: 1,
    },
    clock,
  );
  beforeUpgrade = await snapshot(false);
  await platform.dispose();
  copyFileSync(
    join(root, "migrations/0020_commerce_checkout_guest_sessions.sql"),
    join(migrations, "0020_commerce_checkout_guest_sessions.sql"),
  );
  migrate();
  await connect();
}, 30_000);
afterAll(async () => {
  await platform?.dispose();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

const config: TestCheckoutSessionConfig = {
  mode: "local-test",
  instanceId: context.instanceId,
  canonicalOrigin: "http://localhost:4173",
};
function name(trusted = config) {
  return `commerce_checkout_guest_v1_${trusted.instanceId}`;
}
function get(
  cookie?: string,
  headers: Record<string, string> = {},
  trusted = config,
) {
  return new Request(`${trusted.canonicalOrigin}/future-checkout`, {
    headers: {
      ...(cookie === undefined ? {} : { Cookie: cookie }),
      ...headers,
    },
  });
}
function post(
  cookie?: string,
  headers: Record<string, string> = {},
  trusted = config,
) {
  return new Request(`${trusted.canonicalOrigin}/future-checkout`, {
    method: "POST",
    headers: {
      Origin: trusted.canonicalOrigin,
      ...(cookie === undefined ? {} : { Cookie: cookie }),
      ...headers,
    },
  });
}
function cookie(session: TestCheckoutSession) {
  return session.setCookie!.split(";", 1)[0];
}
function token(session: TestCheckoutSession) {
  return cookie(session).split("=", 2)[1];
}
async function sessions() {
  return (
    await db
      .prepare("SELECT * FROM commerce_checkout_guest_sessions ORDER BY rowid")
      .all<Record<string, string | number | null>>()
  ).results;
}
async function boot(trusted = config) {
  return loadTestCheckoutSession(
    db,
    trusted,
    get(undefined, {}, trusted),
    clock,
  );
}
function noDatabase() {
  let calls = 0;
  return {
    database: new Proxy(db, {
      get(target, property) {
        if (property === "prepare")
          return () => {
            calls++;
            throw new Error("Forbidden test DB access");
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    calls: () => calls,
  };
}

describe("internal local guest session capabilities on real temporary D1", () => {
  it("upgrades populated0019 without changing orders, release history or held stock", async () => {
    expect(await snapshot(false)).toEqual(beforeUpgrade);
    expect(await sessions()).toEqual([]);
    expect(
      await db
        .prepare("SELECT state FROM commerce_orders WHERE id=?")
        .bind(historical.id)
        .first(),
    ).toEqual({ state: "pending_payment" });
    expect(
      await db
        .prepare(
          "SELECT checkout_reserved FROM commerce_inventory WHERE variant_id=?",
        )
        .bind(historicalHeld.fixture!.id)
        .first(),
    ).toEqual({ checkout_reserved: 2 });
  });
  it("stores independent random owner and domain hashes, returns cookie only after persistence, and reuses without renewal", async () => {
    const first = await boot();
    const second = await boot();
    expect(first).toMatchObject({
      testOnly: true,
      createdAt: now,
      expiresAt: now + 86_400_000,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
    expect(first.setCookie).toContain(
      `commerce_checkout_guest_v1_${config.instanceId}=`,
    );
    expect(first.setCookie).toContain(
      "HttpOnly; SameSite=Lax; Path=/; Max-Age=86400",
    );
    expect(first.setCookie).not.toContain("Secure");
    expect(first.setCookie).not.toContain("Domain=");
    expect(token(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(first.csrfToken).toMatch(/^[a-f0-9]{64}$/);
    expect(
      new Set([
        token(first),
        token(second),
        first.context.ownerHash,
        second.context.ownerHash,
        first.csrfToken,
        second.csrfToken,
      ]).size,
    ).toBe(6);
    const row = (await sessions()).find(
      (row) => row.owner_hash === first.context.ownerHash,
    )!;
    expect(row.token_hash).toBe(
      await commandHash([
        "local-checkout-session-token-v1",
        config.mode,
        config.instanceId,
        config.canonicalOrigin,
        token(first),
      ]),
    );
    expect(first.csrfToken).toBe(
      await commandHash([
        "local-checkout-session-csrf-v1",
        config.mode,
        config.instanceId,
        config.canonicalOrigin,
        token(first),
      ]),
    );
    expect(JSON.stringify(row)).not.toContain(token(first));
    expect(JSON.stringify(row)).not.toContain(first.csrfToken);
    const reused = await loadTestCheckoutSession(
      db,
      config,
      get(cookie(first)),
      () => now + 100,
    );
    expect(reused).toEqual({ ...first, setCookie: undefined });
    expect(reused).not.toHaveProperty("setCookie");
    expect(Object.keys(first).sort()).toEqual(
      [
        "testOnly",
        "context",
        "createdAt",
        "expiresAt",
        "csrfToken",
        "headers",
        "setCookie",
      ].sort(),
    );
    const authorized = await authorizeTestCheckoutMutation(
      db,
      config,
      post(cookie(first)),
      first.csrfToken,
      () => now + 200,
    );
    expect(authorized.context).toEqual(first.context);
    expect(authorized).not.toHaveProperty("setCookie");
  });
  it.each(["http://localhost", "http://127.0.0.1", "http://127.0.0.1:4173"])(
    "accepts canonical local origin %s",
    async (canonicalOrigin) => {
      const trusted = { ...config, canonicalOrigin };
      const session = await boot(trusted);
      expect(
        (
          await authorizeTestCheckoutMutation(
            db,
            trusted,
            post(cookie(session), {}, trusted),
            session.csrfToken,
            clock,
          )
        ).context,
      ).toEqual(session.context);
    },
  );
  it("isolates instance/origin and ignores lab cookies as authorization", async () => {
    const first = await boot();
    const before = await sessions();
    const otherInstance = { ...config, instanceId: crypto.randomUUID() };
    const otherOrigin = { ...config, canonicalOrigin: "http://localhost:4174" };
    for (const trusted of [otherInstance, otherOrigin]) {
      const renamed = `${name(trusted)}=${token(first)}`;
      await expect(
        loadTestCheckoutSession(db, trusted, get(renamed, {}, trusted), clock),
      ).rejects.toMatchObject({ code: "unauthorized" });
      await expect(
        authorizeTestCheckoutMutation(
          db,
          trusted,
          post(renamed, {}, trusted),
          first.csrfToken,
          clock,
        ),
      ).rejects.toMatchObject({ code: "unauthorized" });
    }
    await expect(
      authorizeTestCheckoutMutation(
        db,
        config,
        post(`commerce_lab_session_v1=${token(first)}`),
        first.csrfToken,
        clock,
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(await sessions()).toEqual(before);
    const unrelated = await loadTestCheckoutSession(
      db,
      config,
      get(`commerce_lab_session_v1=${token(first)}`),
      clock,
    );
    expect(unrelated.context.ownerHash).not.toBe(first.context.ownerHash);
  });
  it("rejects noncanonical/nonlocal/mode configuration and wrong request origin without database access", async () => {
    const guarded = noDatabase();
    let getterCalled = false;
    const accessor = { ...config };
    Object.defineProperty(accessor, "canonicalOrigin", {
      get() {
        getterCalled = true;
        return config.canonicalOrigin;
      },
    });
    const invalid: unknown[] = [
      null,
      [],
      { ...config, mode: "sandbox" },
      { ...config, mode: "live" },
      { ...config, instanceId: "bad" },
      { ...config, extra: true },
      { ...config, [Symbol("extra")]: true },
      accessor,
      ...[
        "https://localhost:4173",
        "http://example.com:4173",
        "http://localhost:80",
        "http://localhost:04173",
        "http://localhost:0",
        "http://localhost:65536",
        "http://localhost:4173/",
        "http://localhost:4173?mode=local-test",
        "http://user@localhost:4173",
        "http://LOCALHOST:4173",
        "http://localhost.:4173",
        "http://[::1]:4173",
      ].map((canonicalOrigin) => ({ ...config, canonicalOrigin })),
    ];
    for (const raw of invalid)
      await expect(
        loadTestCheckoutSession(
          guarded.database,
          raw as TestCheckoutSessionConfig,
          get(),
          clock,
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    for (const url of [
      "https://localhost:4173",
      "http://example.com:4173",
      "http://localhost:4174",
      "http://127.0.0.1:4173",
    ])
      await expect(
        loadTestCheckoutSession(
          guarded.database,
          config,
          new Request(url, {
            headers: {
              Host: "localhost:4173",
              Forwarded: "host=localhost:4173",
              "X-Forwarded-Host": "localhost:4173",
            },
          }),
          clock,
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
    expect(getterCalled).toBe(false);
    expect(guarded.calls()).toBe(0);
  });
  it("copies trusted config and mutable request headers before its first await", async () => {
    const trusted = { ...config };
    const request = get();
    const pending = loadTestCheckoutSession(db, trusted, request, clock);
    trusted.instanceId = crypto.randomUUID();
    trusted.canonicalOrigin = "http://localhost:4174";
    request.headers.set("Origin", "http://evil.invalid");
    const session = await pending;
    expect(session.context.instanceId).toBe(config.instanceId);
    expect(
      (await loadTestCheckoutSession(db, config, get(cookie(session)), clock))
        .context,
    ).toEqual(session.context);
    expect(
      (
        await loadTestCheckoutSession(
          db,
          Object.assign(Object.create(null), config),
          get(),
          clock,
        )
      ).testOnly,
    ).toBe(true);
  });
  it("rejects malformed/duplicate/unknown credentials instead of replacing ownership", async () => {
    const first = await boot();
    const before = await sessions();
    for (const value of [
      `${name()}`,
      `${name()}=`,
      `${name()} =${token(first)}`,
      `${name()}="${token(first)}"`,
      `${name()}=${token(first).toUpperCase()}`,
      `${name()}=${token(first)}=`,
      `x=ok; ${cookie(first)}; ${cookie(first)}`,
      `${name()}=${"f".repeat(64)}`,
    ])
      await expect(
        loadTestCheckoutSession(db, config, get(value), clock),
      ).rejects.toMatchObject({ code: "unauthorized" });
    expect(await sessions()).toEqual(before);
  });
  it("rejects comma-merged or invalid Cookie grammar without replacing identity", async () => {
    const session = await boot();
    const before = await sessions();
    const guarded = noDatabase();
    for (const header of [
      `unrelated=x, ${cookie(session)}`,
      `unrelated=x, ${name()}=bad`,
      "invalid cookie=value",
      "unrelated=has space",
      'unrelated=unterminated"',
      `unrelated=x;; ${cookie(session)}`,
    ])
      await expect(
        loadTestCheckoutSession(guarded.database, config, get(header), clock),
      ).rejects.toMatchObject({ code: "unauthorized" });
    expect(guarded.calls()).toBe(0);
    expect(await sessions()).toEqual(before);
    const valid = await loadTestCheckoutSession(
      db,
      config,
      get(`ordinary=\"legal-value\"; empty=; ${cookie(session)}`),
      clock,
    );
    expect(valid.context).toEqual(session.context);
  });
  it("never issues a deleting cookie for a positive subsecond remaining lifetime", async () => {
    let at = now;
    const delayed = queries(db, async (_sql, method, execute) => {
      const result = await execute();
      if (method === "first") at = now + 86_400_000 - 1;
      return result;
    });
    const session = await loadTestCheckoutSession(
      delayed,
      config,
      get(),
      () => at,
    );
    expect(session.setCookie).toContain("Max-Age=1;");
    expect(
      (
        await loadTestCheckoutSession(
          db,
          config,
          get(cookie(session)),
          () => at,
        )
      ).context,
    ).toEqual(session.context);
    await expect(
      loadTestCheckoutSession(
        db,
        config,
        get(cookie(session)),
        () => session.expiresAt,
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
  it("does not issue cookies for failed creation and recovers revocation after postcommit read loss", async () => {
    const before = await sessions();
    const failedCreate = queries(db, async (_sql, method, execute) => {
      if (method === "run") throw new Error("private insert failure");
      return execute();
    });
    await expect(
      loadTestCheckoutSession(failedCreate, config, get(), clock),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await sessions()).toEqual(before);
    const session = await boot();
    let committed = false;
    const failedRead = queries(db, async (_sql, method, execute) => {
      if (committed) throw new Error("private read failure");
      const result = await execute();
      if (method === "run") committed = true;
      return result;
    });
    await expect(
      revokeTestCheckoutSession(
        failedRead,
        config,
        post(cookie(session)),
        session.csrfToken,
        clock,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(
      (
        await revokeTestCheckoutSession(
          db,
          config,
          post(cookie(session)),
          session.csrfToken,
          () => now + 1,
        )
      ).revokedAt,
    ).toBe(now);
  });
  it("requires POST and exact Origin plus fixed proof before any mutation DB read or bootstrap", async () => {
    const session = await boot();
    const guarded = noDatabase();
    for (const proof of [
      undefined,
      null,
      "",
      session.csrfToken.toUpperCase(),
      "a".repeat(63),
      "f".repeat(64),
      { proof: session.csrfToken },
    ])
      await expect(
        authorizeTestCheckoutMutation(
          guarded.database,
          config,
          post(cookie(session)),
          proof,
          clock,
        ),
      ).rejects.toMatchObject({ code: "unauthorized" });
    const missingOrigin = post(cookie(session));
    missingOrigin.headers.delete("Origin");
    for (const request of [
      get(cookie(session)),
      missingOrigin,
      ...[
        "null",
        "http://localhost:4174",
        "http://evil.invalid",
        config.canonicalOrigin + "/",
      ].map((Origin) => post(cookie(session), { Origin })),
      post(),
    ]) {
      await expect(
        authorizeTestCheckoutMutation(
          guarded.database,
          config,
          request,
          session.csrfToken,
          clock,
        ),
      ).rejects.toBeInstanceOf(Error);
      await expect(
        revokeTestCheckoutSession(
          guarded.database,
          config,
          request,
          session.csrfToken,
          clock,
        ),
      ).rejects.toBeInstanceOf(Error);
    }
    const stored = (await sessions()).find(
      (row) => row.owner_hash === session.context.ownerHash,
    )!;
    await expect(
      authorizeTestCheckoutMutation(
        guarded.database,
        config,
        post(cookie(session)),
        stored.token_hash,
        clock,
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(guarded.calls()).toBe(0);
  });
  it("permits only existing sessions on cross-site document GET returns; never bootstrap or mutate", async () => {
    const session = await boot();
    const before = await sessions();
    for (const site of ["same-site", "cross-site"]) {
      const headers = {
        "Sec-Fetch-Site": site,
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
      };
      expect(
        (
          await loadTestCheckoutSession(
            db,
            config,
            get(cookie(session), headers),
            clock,
          )
        ).context,
      ).toEqual(session.context);
      const guarded = noDatabase();
      await expect(
        loadTestCheckoutSession(
          guarded.database,
          config,
          get(undefined, headers),
          clock,
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      for (const changed of [
        { "Sec-Fetch-Mode": "cors" },
        { "Sec-Fetch-Dest": "iframe" },
      ])
        await expect(
          loadTestCheckoutSession(
            guarded.database,
            config,
            get(cookie(session), { ...headers, ...changed }),
            clock,
          ),
        ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        authorizeTestCheckoutMutation(
          guarded.database,
          config,
          post(cookie(session), headers),
          session.csrfToken,
          clock,
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(guarded.calls()).toBe(0);
    }
    for (const site of ["none", "same-origin"])
      expect(
        (
          await loadTestCheckoutSession(
            db,
            config,
            get(cookie(session), { "Sec-Fetch-Site": site }),
            clock,
          )
        ).context,
      ).toEqual(session.context);
    await expect(
      authorizeTestCheckoutMutation(
        db,
        config,
        post(cookie(session), { "Sec-Fetch-Site": "none" }),
        session.csrfToken,
        clock,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      loadTestCheckoutSession(
        db,
        config,
        get(cookie(session), {
          Origin: "https://provider.invalid",
          "Sec-Fetch-Site": "cross-site",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
        }),
        clock,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await sessions()).toEqual(before);
  });
  it("checks expiry equality/backward and unsafe clocks after asynchronous reads", async () => {
    const session = await boot();
    const before = await sessions();
    for (const at of [now - 1, session.expiresAt]) {
      await expect(
        loadTestCheckoutSession(db, config, get(cookie(session)), () => at),
      ).rejects.toMatchObject({ code: "unauthorized" });
      await expect(
        authorizeTestCheckoutMutation(
          db,
          config,
          post(cookie(session)),
          session.csrfToken,
          () => at,
        ),
      ).rejects.toMatchObject({ code: "unauthorized" });
      await expect(
        revokeTestCheckoutSession(
          db,
          config,
          post(cookie(session)),
          session.csrfToken,
          () => at,
        ),
      ).rejects.toMatchObject({ code: "unauthorized" });
    }
    for (const at of [NaN, Infinity, -1, 1.1, 8_640_000_000_000_001])
      await expect(
        loadTestCheckoutSession(db, config, get(cookie(session)), () => at),
      ).rejects.toMatchObject({ code: "invalid_request" });
    let at = now;
    const delayed = queries(db, async (_sql, method, execute) => {
      const value = await execute();
      if (method === "first") at = session.expiresAt;
      return value;
    });
    await expect(
      loadTestCheckoutSession(delayed, config, get(cookie(session)), () => at),
    ).rejects.toMatchObject({ code: "unauthorized" });
    at = now;
    await expect(
      authorizeTestCheckoutMutation(
        delayed,
        config,
        post(cookie(session)),
        session.csrfToken,
        () => at,
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(await sessions()).toEqual(before);
  });
  it("revokes once without changing commerce, replaying original revocation after expiry", async () => {
    const session = await boot();
    const commerce = await snapshot(false);
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        revokeTestCheckoutSession(
          db,
          config,
          post(cookie(session)),
          session.csrfToken,
          () => now + 10,
        ),
      ),
    );
    expect(
      results.every(
        (value) => JSON.stringify(value) === JSON.stringify(results[0]),
      ),
    ).toBe(true);
    expect(results[0]).toMatchObject({ testOnly: true, revokedAt: now + 10 });
    expect(results[0].setCookie).toContain("Max-Age=0");
    expect(
      await revokeTestCheckoutSession(
        db,
        config,
        post(cookie(session)),
        session.csrfToken,
        () => session.expiresAt + 100,
      ),
    ).toEqual(results[0]);
    await expect(
      revokeTestCheckoutSession(
        db,
        config,
        post(cookie(session)),
        session.csrfToken,
        () => now + 9,
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      loadTestCheckoutSession(db, config, get(cookie(session)), () => now + 11),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      authorizeTestCheckoutMutation(
        db,
        config,
        post(cookie(session)),
        session.csrfToken,
        () => now + 11,
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(await snapshot(false)).toEqual(commerce);
  });
  it("recovers concurrent revocation before stale expiry qualification", async () => {
    const session = await boot();
    let done = false;
    let at = now;
    const delayed = queries(db, async (_sql, method, execute) => {
      const value = await execute();
      if (method === "first" && !done) {
        done = true;
        await revokeTestCheckoutSession(
          db,
          config,
          post(cookie(session)),
          session.csrfToken,
          () => now + 1,
        );
        at = session.expiresAt;
      }
      return value;
    });
    expect(
      (
        await revokeTestCheckoutSession(
          delayed,
          config,
          post(cookie(session)),
          session.csrfToken,
          () => at,
        )
      ).revokedAt,
    ).toBe(now + 1);
  });
  it("makes lost cookie a new unrelated identity and does not claim concurrent initial GET serialization", async () => {
    const first = await boot();
    const concurrent = await Promise.all([boot(), boot()]);
    expect(
      new Set([
        first.context.ownerHash,
        ...concurrent.map((value) => value.context.ownerHash),
      ]).size,
    ).toBe(3);
    const newRequest = post(cookie(concurrent[0]));
    await expect(
      authorizeTestCheckoutMutation(
        db,
        config,
        newRequest,
        first.csrfToken,
        clock,
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
  it("enforces strict SQL scope/lifetime/identity and monotonic revocation including REPLACE/UPSERT", async () => {
    const session = await boot();
    const row = (await sessions()).find(
      (row) => row.owner_hash === session.context.ownerHash,
    )!;
    const before = await sessions();
    for (const change of [
      "mode='live'",
      "owner_hash='" + "b".repeat(64) + "'",
      "canonical_origin='http://localhost:4174'",
      "created_at=created_at+1",
      "expires_at=expires_at+1",
      "revoked_at=created_at-1",
      "revoked_at=expires_at",
    ])
      await expect(
        db
          .prepare(
            `UPDATE commerce_checkout_guest_sessions SET ${change} WHERE token_hash=?`,
          )
          .bind(row.token_hash)
          .run(),
      ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "DELETE FROM commerce_checkout_guest_sessions WHERE token_hash=?",
        )
        .bind(row.token_hash)
        .run(),
    ).rejects.toThrow();
    const columns = Object.keys(row);
    const values = columns.map((column) => row[column]);
    await expect(
      db
        .prepare(
          `INSERT OR REPLACE INTO commerce_checkout_guest_sessions(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        )
        .bind(...values)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          `INSERT INTO commerce_checkout_guest_sessions(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")}) ON CONFLICT(token_hash) DO UPDATE SET revoked_at=excluded.created_at`,
        )
        .bind(...values)
        .run(),
    ).rejects.toThrow();
    const insertionChanges: Record<string, string | number | null>[] = [
      { canonical_origin: "http://localhost:80" },
      { canonical_origin: "https://localhost:4173" },
      { canonical_origin: "http://localhost:04173" },
      { expires_at: now + 1 },
      { revoked_at: now },
      { created_at: "bad" },
      { instance_id: "bad" },
      { owner_hash: "z".repeat(64) },
    ];
    for (const change of insertionChanges) {
      const candidate: Record<string, string | number | null> = {
        ...row,
        token_hash: crypto.randomUUID().replaceAll("-", "").repeat(2),
        owner_hash: crypto.randomUUID().replaceAll("-", "").repeat(2),
        ...change,
      };
      await expect(
        db
          .prepare(
            `INSERT INTO commerce_checkout_guest_sessions(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
          )
          .bind(...columns.map((column) => candidate[column]))
          .run(),
      ).rejects.toThrow();
    }
    expect(await sessions()).toEqual(before);
    await revokeTestCheckoutSession(
      db,
      config,
      post(cookie(session)),
      session.csrfToken,
      clock,
    );
    for (const expression of ["NULL", "revoked_at", "revoked_at+1"])
      await expect(
        db
          .prepare(
            `UPDATE commerce_checkout_guest_sessions SET revoked_at=${expression} WHERE token_hash=?`,
          )
          .bind(row.token_hash)
          .run(),
      ).rejects.toThrow();
  });
  it.each(["create", "revoke"])(
    "recovers %s committed write response loss",
    async (operation) => {
      const session = operation === "revoke" ? await boot() : null;
      let lost = false;
      const fault = queries(db, async (_sql, method, execute) => {
        const result = await execute();
        if (method === "run" && !lost) {
          lost = true;
          throw new Error("private SQL cookie proof response");
        }
        return result;
      });
      if (session) {
        const result = await revokeTestCheckoutSession(
          fault,
          config,
          post(cookie(session)),
          session.csrfToken,
          clock,
        );
        expect(result.revokedAt).toBe(now);
      } else {
        const result = await loadTestCheckoutSession(
          fault,
          config,
          get(),
          clock,
        );
        expect(
          (
            await loadTestCheckoutSession(
              db,
              config,
              get(cookie(result)),
              clock,
            )
          ).context,
        ).toEqual(result.context);
      }
    },
  );
  it.each(["load", "authorize", "revoke", "create-postcommit"])(
    "sanitizes %s read failures without cookie/proof/SQL leakage",
    async (operation) => {
      const session = await boot();
      let committed = false;
      const fault = queries(db, async (_sql, method, execute) => {
        if (operation !== "create-postcommit" || committed)
          throw new Error(
            `private SQL ${cookie(session)} ${session.csrfToken}`,
          );
        const result = await execute();
        if (method === "run") committed = true;
        return result;
      });
      const perform = () =>
        operation === "load"
          ? loadTestCheckoutSession(fault, config, get(cookie(session)), clock)
          : operation === "authorize"
            ? authorizeTestCheckoutMutation(
                fault,
                config,
                post(cookie(session)),
                session.csrfToken,
                clock,
              )
            : operation === "revoke"
              ? revokeTestCheckoutSession(
                  fault,
                  config,
                  post(cookie(session)),
                  session.csrfToken,
                  clock,
                )
              : loadTestCheckoutSession(fault, config, get(), clock);
      const error = await perform().catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        name: "CheckoutSessionError",
        code: "unavailable",
      });
      expect(String(error)).not.toContain("private");
      expect(String(error)).not.toContain(session.csrfToken);
      expect(error).not.toHaveProperty("cause");
      expect(error).not.toHaveProperty("setCookie");
    },
  );
});
