import {
  createRequestHandler,
  RouterContextProvider,
  useLoaderData,
} from "react-router";
import { createElement } from "react";
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
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cloudflareContext } from "../cloudflare-context";
import { adminPrincipalContext } from "../lib/auth/admin-access.server";
import { handleWorkerRequest } from "../../workers/app";
import * as ReviewRoute from "./admin-commerce-review";
import * as ScreenRoute from "./admin-commerce-reservations";
import * as RecoverRoute from "./admin-commerce-recover";
import handleDocument from "../entry.server";
import { applyStockCommand } from "../lib/commerce/inventory.server";
import {
  createTestQuote,
  reserveTestOrder,
} from "../lib/commerce/orders.server";
import {
  recoverExpiredReservation,
  type ReservationRecoveryInput,
} from "../lib/commerce/reservation-recovery.server";

const origin = "http://127.0.0.1:8792";
const issuer = "https://review-fixture.cloudflareaccess.com";
const audience = "fictional-review-audience";
const human = {
  email: "reviewer@example.invalid",
  sub: "fictional-human-reviewer",
};
const route = {
  id: "routes/admin-commerce-review",
  path: "admin/commerce/review",
  module: ReviewRoute,
};
const screen = {
  id: "routes/admin-commerce-reservations",
  path: "admin/commerce/reservations",
  module: {
    ...ScreenRoute,
    default: function ReviewScreenWithFrameworkProps() {
      return createElement(ScreenRoute.default, {
        loaderData: useLoaderData(),
      } as Parameters<typeof ScreenRoute.default>[0]);
    },
  },
};
const recovery = {
  id: "routes/admin-commerce-recover",
  path: "admin/commerce/reservations/recover",
  module: RecoverRoute,
};
const handler = createRequestHandler(
  {
    entry: { module: { default: handleDocument } },
    routes: { [route.id]: route, [screen.id]: screen, [recovery.id]: recovery },
    assets: {
      entry: { imports: [], module: "/entry.js" },
      routes: {
        [recovery.id]: {
          id: recovery.id,
          path: recovery.path,
          module: "/recovery.js",
          hasLoader: true,
          hasAction: true,
        },
        [route.id]: {
          id: route.id,
          path: route.path,
          module: "/review.js",
          hasLoader: true,
          hasAction: true,
        },
        [screen.id]: {
          id: screen.id,
          path: screen.path,
          module: "/reservations.js",
          hasLoader: true,
          hasAction: true,
          hasErrorBoundary: true,
        },
      },
      url: "/manifest.js",
      version: "test",
    },
    publicPath: "/",
    assetsBuildDirectory: "build/client",
    future: {},
    ssr: true,
    isSpaMode: false,
    prerender: [],
    routeDiscovery: { mode: "initial", manifestPath: "/manifest.js" },
  } as unknown as Parameters<typeof createRequestHandler>[0],
  "test",
);
let privateKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey as CryptoKey;
  const jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "fictional-review-key",
    alg: "RS256",
  };
  vi.stubGlobal("fetch", async (url: RequestInfo | URL) => {
    if (String(url) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected network request");
    return Response.json({ keys: [jwk] });
  });
});

describe("Worker → React Router local recovery command", () => {
  const reference = "order-00000000-0000-0000-0000-000000000001";
  const requestId = "00000000-0000-4000-8000-000000000001";
  const fields = () =>
    new URLSearchParams({
      requestId,
      reference,
      expectedVersion: "1",
      confirmation: reference,
      reason: "overdue_unpaid",
    });
  async function send(
    db: object,
    assertion?: string,
    init: {
      method?: string;
      body?: string;
      path?: string;
      origin?: string | null;
      contentType?: string;
      enabled?: boolean;
      requestOrigin?: string;
    } = {},
  ) {
    const method = init.method ?? "POST";
    return handleWorkerRequest(
      new Request(
        (init.requestOrigin ?? origin) +
          (init.path ?? "/admin/commerce/reservations/recover"),
        {
          method,
          headers: {
            ...(assertion ? { "Cf-Access-Jwt-Assertion": assertion } : {}),
            ...(init.origin === null
              ? {}
              : { Origin: init.origin ?? init.requestOrigin ?? origin }),
            "Content-Type":
              init.contentType ?? "application/x-www-form-urlencoded",
          },
          ...(method === "GET" || method === "HEAD"
            ? {}
            : { body: init.body ?? fields().toString() }),
        },
      ),
      env(db, init.enabled ?? true),
      {} as ExecutionContext,
      handler,
    );
  }
  it.each([
    "/admin/commerce/reservations/recover",
    "/admin/commerce/reservations/recover.data",
  ])(
    "rejects absent, unapproved and service identities before DB on %s",
    async (path) => {
      const prepare = vi.fn();
      const batch = vi.fn();
      for (const [assertion, status] of [
        [undefined, 401],
        [await jwt({ sub: "unapproved" }), 403],
        [await jwt({ common_name: "service-account" }), 401],
      ] as const)
        expect(
          (await send({ prepare, batch }, assertion, { path })).status,
        ).toBe(status);
      expect(prepare).not.toHaveBeenCalled();
      expect(batch).not.toHaveBeenCalled();
    },
  );
  it("requires local mode, an exact same Origin and an independent trusted route principal", async () => {
    const prepare = vi.fn();
    const batch = vi.fn();
    const assertion = await jwt();
    for (const [init, status] of [
      [{ enabled: false }, 404],
      [{ requestOrigin: "https://shop.example.invalid" }, 404],
      [{ origin: "http://127.0.0.1:8793" }, 404],
      [{ origin: null }, 403],
    ] as const)
      expect((await send({ prepare, batch }, assertion, init)).status).toBe(
        status,
      );
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: env({ prepare, batch }),
      ctx: {} as ExecutionContext,
    });
    await expect(
      RecoverRoute.action({
        request: new Request(origin + "/admin/commerce/reservations/recover", {
          method: "POST",
        }),
        context,
        params: {},
        url: new URL(origin + "/admin/commerce/reservations/recover"),
        pattern: "/admin/commerce/reservations/recover",
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });
  it.each(["GET", "PUT", "DELETE"])(
    "rejects %s without DB access and keeps a no-store POST-only contract",
    async (method) => {
      const prepare = vi.fn();
      const batch = vi.fn();
      const response = await send({ prepare, batch }, await jwt(), { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("POST");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      expect(prepare).not.toHaveBeenCalled();
      expect(batch).not.toHaveBeenCalled();
    },
  );
  it("validates strict fields, confirmation, reason, body bounds and query before DB", async () => {
    const prepare = vi.fn();
    const batch = vi.fn();
    const assertion = await jwt();
    const bodies = [
      fields().toString() + "&reference=" + reference,
      fields().toString() + "&actor=someone",
      fields().toString().replace("expectedVersion=1", "expectedVersion=01"),
      fields()
        .toString()
        .replace("expectedVersion=1", "expectedVersion=9007199254740992"),
      fields()
        .toString()
        .replace("confirmation=" + reference, "confirmation=yes"),
      fields()
        .toString()
        .replace("reason=overdue_unpaid", "reason=private-customer-notes"),
      fields()
        .toString()
        .replace("requestId=" + requestId, "requestId=bad"),
    ];
    for (const body of bodies) {
      const response = await send({ prepare, batch }, assertion, { body });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Invalid local recovery request");
    }
    expect(
      (
        await send({ prepare, batch }, assertion, {
          body: "x=" + "x".repeat(9000),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await send({ prepare, batch }, assertion, {
          contentType: "application/json",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await send({ prepare, batch }, assertion, {
          path: "/admin/commerce/reservations/recover?email=private@example.invalid",
        })
      ).status,
    ).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });
  it("runs only the audited command for an approved human without a lab cookie, returning a minimal receipt", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const prepare = vi.fn((sql: string) => ({
      bind: (...values: unknown[]) => {
        const statement = { sql, values };
        statements.push(statement);
        return {
          ...statement,
          first: async () =>
            sql.includes("LEFT JOIN")
              ? null
              : {
                  state: "pending_payment",
                  paymentState: "not_started",
                  fulfillment: "none",
                  reserveUntil: 1,
                  version: 1,
                },
        };
      },
    }));
    const batch = vi.fn(async () => []);
    const response = await send({ prepare, batch }, await jwt());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const result = await response.json();
    expect(result).toMatchObject({
      testOnly: true,
      reference,
      requestId,
      resultingVersion: 2,
      replayed: false,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /actor_hash|owner_hash|snapshot|reviewer|fictional-human/,
    );
    expect(batch).toHaveBeenCalledTimes(1);
    const written = batch.mock.calls[0] as unknown as [
      Array<{ sql: string; values: unknown[] }>,
    ];
    expect(written[0]).toHaveLength(2);
    expect(written[0][1].sql).toContain(
      "INSERT INTO commerce_reservation_recoveries",
    );
    expect(written[0][1].values[2]).toMatch(/^[a-f0-9]{64}$/);
    expect(statements.map((item) => item.sql).join(" ")).not.toMatch(
      /SELECT.*snapshot|owner_hash/,
    );
  });
  it("reports stale state and storage outages without leaking inputs, exceptions or false success", async () => {
    const assertion = await jwt();
    const conflict = await send(
      {
        prepare: (sql: string) => ({
          bind: () => ({
            first: async () =>
              sql.includes("LEFT JOIN")
                ? null
                : {
                    state: "pending_payment",
                    paymentState: "unknown",
                    fulfillment: "none",
                    reserveUntil: 1,
                    version: 1,
                  },
          }),
        }),
      },
      assertion,
    );
    expect(conflict.status).toBe(409);
    const failed = await send(
      {
        prepare() {
          throw new Error("private database details");
        },
      },
      assertion,
    );
    expect(failed.status).toBe(503);
    const body = await failed.text();
    expect(body).toContain("Keep the same request ID and details");
    expect(body).not.toContain("private database");
    expect(failed.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});
async function jwt(claims: Record<string, unknown> = {}) {
  return new SignJWT({ type: "app", ...human, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "fictional-review-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setNotBefore("0s")
    .setExpirationTime("5m")
    .sign(privateKey);
}
function env(db: object, enabled = true) {
  return {
    DB: db,
    ...(enabled ? { COMMERCE_MODE: "local-test" } : {}),
    ADMIN_ACCESS_ISSUER: issuer,
    ADMIN_ACCESS_AUD: audience,
    ADMIN_IDENTITY_PAIRS: JSON.stringify([human]),
  } as unknown as Env;
}
async function throughWorker(
  db: object,
  assertion?: string,
  method = "GET",
  path = "/admin/commerce/review",
  enabled = true,
  requestOrigin = origin,
) {
  return handleWorkerRequest(
    new Request(requestOrigin + path, {
      method,
      headers: {
        ...(assertion ? { "Cf-Access-Jwt-Assertion": assertion } : {}),
      },
    }),
    env(db, enabled),
    {} as ExecutionContext,
    handler,
  );
}
describe("Worker → React Router reservation-review authorization", () => {
  it.each([
    "/admin/commerce/reservations",
    "/admin/commerce/review.data",
    "/admin/commerce/reservations/recover",
    "/%61dmin/commerce/review",
    "/ADMIN/commerce/reservations.data",
  ])(
    "does not promote another authority into an Admin identity on %s",
    async (path) => {
      const prepare = vi.fn();
      const batch = vi.fn();
      const routed = vi.fn(handler);
      const candidates: Array<Record<string, string>> = [
        { Cookie: `commerce_lab_session_v1=${"b".repeat(64)}` },
        { Authorization: `Bearer ${"c".repeat(64)}` },
        { "Cf-Access-Authenticated-User-Email": human.email },
        { "X-Admin-Email": human.email, "X-Admin-Sub": human.sub },
      ];
      for (const headers of candidates) {
        const response = await handleWorkerRequest(
          new Request(origin + path, { headers }),
          env({ prepare, batch }),
          {} as ExecutionContext,
          routed,
        );
        expect(response.status).toBe(401);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        expect(await response.text()).not.toContain(human.email);
      }
      expect(routed).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(batch).not.toHaveBeenCalled();
    },
  );
  it("rejects an otherwise valid human JWT from another environment's Access application before routing", async () => {
    const prepare = vi.fn();
    const batch = vi.fn();
    const routed = vi.fn(handler);
    const response = await handleWorkerRequest(
      new Request(origin + "/admin/commerce/reservations/recover", {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": await jwt() },
      }),
      {
        ...env({ prepare, batch }),
        ADMIN_ACCESS_AUD: "fictional-isolated-sandbox-admin-audience",
      } as Env,
      {} as ExecutionContext,
      routed,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(routed).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });
  it.each(["sandbox", "commerce-sandbox", "live"])(
    "does not activate existing local Admin commerce with a proposed %s mode",
    async (mode) => {
      const prepare = vi.fn();
      const batch = vi.fn();
      const assertion = await jwt();
      for (const requestOrigin of [origin, "https://sandbox.example.invalid"])
        for (const path of [
          "/admin/commerce/review",
          "/admin/commerce/reservations.data",
          "/admin/commerce/reservations/recover",
        ]) {
          const response = await handleWorkerRequest(
            new Request(requestOrigin + path, {
              headers: { "Cf-Access-Jwt-Assertion": assertion },
            }),
            { ...env({ prepare, batch }), COMMERCE_MODE: mode } as Env,
            {} as ExecutionContext,
            handler,
          );
          expect(response.status).toBe(404);
          expect(response.headers.get("Cache-Control")).toBe(
            "private, no-store",
          );
        }
      expect(prepare).not.toHaveBeenCalled();
      expect(batch).not.toHaveBeenCalled();
    },
  );
  it("denies absent, unapproved human and service identities before storage", async () => {
    const prepare = vi.fn(() => {
      throw new Error("private storage");
    });
    for (const [assertion, status] of [
      [undefined, 401],
      [await jwt({ sub: "unapproved" }), 403],
      [await jwt({ common_name: "service-account" }), 401],
    ] as const) {
      const response = await throughWorker({ prepare }, assertion);
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain("private storage");
    }
    expect(prepare).not.toHaveBeenCalled();
  });
  it("requires local availability even for an approved human", async () => {
    const prepare = vi.fn();
    const assertion = await jwt();
    expect(
      (await throughWorker({ prepare }, assertion, "GET", undefined, false))
        .status,
    ).toBe(404);
    expect(
      (
        await throughWorker(
          { prepare },
          assertion,
          "GET",
          undefined,
          true,
          "https://shop.example.invalid",
        )
      ).status,
    ).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
  });
  it("does not accept an expiry bearer as an Admin identity", async () => {
    const response = await handleWorkerRequest(
      new Request(origin + "/admin/commerce/review", {
        headers: { Origin: origin, Authorization: `Bearer ${"c".repeat(64)}` },
      }),
      { ...env({}), COMMERCE_LOCAL_EXPIRY_TOKEN: "c".repeat(64) } as Env,
      {} as ExecutionContext,
      handler,
    );
    expect(response.status).toBe(401);
  });
  it("returns a minimal no-store/noindex resource for approved humans without a lab cookie", async () => {
    const all = vi.fn(async () => ({ results: [], success: true }));
    const prepare = vi.fn(() => ({ bind: () => ({ all }) }));
    const response = await throughWorker({ prepare }, await jwt());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await response.json()).toMatchObject({
      testOnly: true,
      items: [],
      nextCursor: null,
    });
    expect(prepare.mock.calls).toHaveLength(1);
  });
  it.each(["POST", "PUT", "DELETE"])(
    "refuses %s without storage writes",
    async (method) => {
      const prepare = vi.fn();
      const batch = vi.fn();
      const response = await throughWorker(
        { prepare, batch },
        await jwt(),
        method,
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET");
      expect(prepare).not.toHaveBeenCalled();
      expect(batch).not.toHaveBeenCalled();
    },
  );
  it.each([
    "?email=private@example.invalid",
    "?reference=bad",
    "?reference=one&reference=two",
    "?after=null",
    "?after=not-json",
    "?after=%7B%7D",
    "?reference=bad&after=%7B%7D",
    "?requestId=00000000-0000-4000-8000-000000000001&expectedVersion=1",
    "?reference=order-00000000-0000-0000-0000-000000000001&requestId=00000000-0000-4000-8000-000000000001",
    "?reference=order-00000000-0000-0000-0000-000000000001&expectedVersion=1",
    ...[
      "0",
      "01",
      "1.0",
      "1e0",
      "+1",
      "-1",
      "9007199254740991",
      "9007199254740992",
      "",
    ].map(
      (version) =>
        `?reference=order-00000000-0000-0000-0000-000000000001&requestId=00000000-0000-4000-8000-000000000001&expectedVersion=${encodeURIComponent(version)}`,
    ),
    ...[
      "bad",
      "00000000-0000-1000-8000-000000000001",
      "00000000-0000-4000-7000-000000000001",
      "",
    ].map(
      (requestId) =>
        `?reference=order-00000000-0000-0000-0000-000000000001&requestId=${requestId}&expectedVersion=1`,
    ),
    ...[
      "&requestId=00000000-0000-4000-8000-000000000001",
      "&expectedVersion=1",
      "&reference=order-00000000-0000-0000-0000-000000000001",
      "&after=%7B%7D",
      "&actor=private",
      "&confirmation=yes",
      "&reason=overdue_unpaid",
    ].map(
      (extra) =>
        `?reference=order-00000000-0000-0000-0000-000000000001&requestId=00000000-0000-4000-8000-000000000001&expectedVersion=1${extra}`,
    ),
    "?reference=bad&requestId=00000000-0000-4000-8000-000000000001&expectedVersion=1",
  ])("rejects invalid filters before D1: %s", async (query) => {
    const prepare = vi.fn();
    const batch = vi.fn();
    const response = await throughWorker(
      { prepare, batch },
      await jwt(),
      "GET",
      "/admin/commerce/review" + query,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid local review request");
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });
  it("keeps storage errors generic and nonexistent references private", async () => {
    const assertion = await jwt();
    const failed = await throughWorker(
      {
        prepare() {
          throw new Error("private connection details");
        },
      },
      assertion,
    );
    expect(failed.status).toBe(503);
    expect(await failed.text()).toBe("Local review temporarily unavailable");
    const absent = await throughWorker(
      {
        prepare: () => ({ bind: () => ({}) }),
        batch: async () => [{ results: [] }, { results: [] }, { results: [] }],
      },
      assertion,
      "GET",
      `/admin/commerce/review?reference=order-${"0".repeat(36)}`,
    );
    expect(absent.status).toBe(404);
  });
  it("independently denies direct route calls without a trusted context principal", async () => {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: env({}),
      ctx: {} as ExecutionContext,
    });
    expect(context.get(adminPrincipalContext)).toBeNull();
    await expect(
      ReviewRoute.loader({
        request: new Request(origin + "/admin/commerce/review"),
        context,
        url: new URL(origin + "/admin/commerce/review"),
        params: {},
        pattern: "/admin/commerce/review",
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      ScreenRoute.loader({
        request: new Request(origin + "/admin/commerce/reservations"),
        context,
        url: new URL(origin + "/admin/commerce/reservations"),
        params: {},
        pattern: "/admin/commerce/reservations",
      }),
    ).rejects.toMatchObject({ status: 401 });
  });
  it.each([
    "/admin/commerce/reservations",
    "/admin/commerce/reservations.data",
  ])(
    "guards %s before D1 for absent, unapproved and service identities and nonlocal mode",
    async (path) => {
      const prepare = vi.fn();
      const batch = vi.fn();
      const db = { prepare, batch };
      for (const [assertion, status] of [
        [undefined, 401],
        [await jwt({ sub: "unapproved" }), 403],
        [await jwt({ common_name: "service" }), 401],
      ] as const) {
        expect((await throughWorker(db, assertion, "GET", path)).status).toBe(
          status,
        );
      }
      const assertion = await jwt();
      expect(
        (await throughWorker(db, assertion, "GET", path, false)).status,
      ).toBe(404);
      expect(
        (
          await throughWorker(
            db,
            assertion,
            "GET",
            path,
            true,
            "https://shop.example.invalid",
          )
        ).status,
      ).toBe(404);
      expect(prepare).not.toHaveBeenCalled();
      expect(batch).not.toHaveBeenCalled();
    },
  );
  it.each(["", ".data"])(
    "serves an approved minimal read-only screen%s without customer data or a lab cookie",
    async (suffix) => {
      const order = {
        id: `order-${"0".repeat(36)}`,
        state: "pending_payment",
        paymentState: "not_started",
        fulfillment: "none",
        reserveUntil: 1,
        version: 1,
      };
      const queries: string[] = [];
      const prepare = vi.fn((sql: string) => {
        queries.push(sql);
        return {
          bind: () => ({
            all: async () => ({ results: [order], success: true }),
          }),
        };
      });
      const response = await throughWorker(
        { prepare },
        await jwt(),
        "GET",
        "/admin/commerce/reservations" + suffix,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      const body = await response.text();
      if (!suffix) {
        expect(body).toContain("Fictional orders only");
        expect(body).toContain("Unpaid reservation past its deadline");
      }
      expect(body).toContain(order.id);
      expect(queries).toHaveLength(1);
      expect(queries[0]).toMatch(/^SELECT /);
      expect(queries[0]).not.toMatch(
        /snapshot|owner_hash|email|address|provider/,
      );
    },
  );
  it.each(["POST", "PUT", "DELETE"])(
    "denies %s on the screen without running a read or write",
    async (method) => {
      const prepare = vi.fn();
      const batch = vi.fn();
      const response = await throughWorker(
        { prepare, batch },
        await jwt(),
        method,
        "/admin/commerce/reservations",
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(prepare).not.toHaveBeenCalled();
      expect(batch).not.toHaveBeenCalled();
    },
  );
  it("keeps page errors generic and no-store without echoing private inputs or database failures", async () => {
    const assertion = await jwt();
    const prepare = vi.fn(() => {
      throw new Error("private connection details");
    });
    const invalid = await throughWorker(
      { prepare },
      assertion,
      "GET",
      "/admin/commerce/reservations?email=private@example.invalid",
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain("private@example.invalid");
    expect(prepare).not.toHaveBeenCalled();
    const failed = await throughWorker(
      { prepare },
      assertion,
      "GET",
      "/admin/commerce/reservations",
    );
    expect(failed.status).toBe(503);
    const body = await failed.text();
    expect(body).toContain("temporarily unavailable");
    expect(body).not.toContain("private connection details");
    expect(failed.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("Worker → React Router read-only receipts on real isolated D1", () => {
  let directory: string;
  let platform: PlatformProxy<Env>;
  let db: D1Database;
  let command: ReservationRecoveryInput;
  let recorded: Awaited<ReturnType<typeof recoverExpiredReservation>>;
  let missingMigration: { status: number; body: string; unchanged: boolean };
  const query = () =>
    new URLSearchParams({
      reference: command.reference,
      requestId: command.requestId,
      expectedVersion: String(command.expectedVersion),
    });
  const path = () => `/admin/commerce/review?${query()}`;
  const tables = [
    "commerce_commands",
    "commerce_orders",
    "commerce_order_transitions",
    "commerce_inventory",
    "commerce_stock_movements",
  ];
  async function snapshot(withAudit = true) {
    return Promise.all(
      [
        ...tables,
        ...(withAudit ? ["commerce_reservation_recoveries"] : []),
      ].map(
        async (table) =>
          (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
            .results,
      ),
    );
  }
  beforeAll(async () => {
    const root = resolve(process.cwd());
    directory = mkdtempSync(join(tmpdir(), "jewelry-worker-receipt-"));
    const migrations = join(directory, "migrations");
    mkdirSync(migrations);
    for (const file of readdirSync(join(root, "migrations")).filter(
      (file) => file.endsWith(".sql") && file < "0008",
    ))
      copyFileSync(join(root, "migrations", file), join(migrations, file));
    const configPath = join(directory, "wrangler.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        name: "fictional-read-receipt-test",
        compatibility_date: "2026-09-29",
        d1_databases: [
          {
            binding: "DB",
            database_name: "fictional-read-receipt-local",
            migrations_dir: "migrations",
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
    migrate();
    await connect();
    await db.exec(`INSERT INTO products(id,name,slug,price_cents,quantity,category_id,status,created_at,updated_at) VALUES(1,'Fictional receipt','fictional-receipt',2500,0,1,'draft',1,1);
      INSERT INTO product_images(product_id,r2_key,sort_order,created_at) VALUES(1,'fictional/receipt.jpg',0,1);
      UPDATE products SET status='available' WHERE id=1;
      INSERT INTO commerce_variants(id,product_id,sku,colour,size_description,price_cents,active) VALUES('receipt-variant',1,'receipt-sku','Gold-tone','Fictional size',2500,1);`);
    const now = 1_800_000_000_000;
    await applyStockCommand(
      db,
      "receipt-fixture",
      [
        {
          variantId: "receipt-variant",
          kind: "receive",
          quantity: 10,
          reason: "Fictional receipt",
        },
      ],
      now,
    );
    const owner = "a".repeat(64);
    const quote = await createTestQuote(
      db,
      owner,
      [{ variantId: "receipt-variant", quantity: 1 }],
      "pickup",
      now,
    );
    const order = await reserveTestOrder(db, owner, quote.id, now + 1);
    command = {
      requestId: crypto.randomUUID(),
      reference: order.id,
      confirmation: order.id,
      expectedVersion: 1,
      reason: "overdue_unpaid",
    };
    const before = await snapshot(false);
    const response = await throughWorker(db, await jwt(), "GET", path());
    missingMigration = {
      status: response.status,
      body: await response.text(),
      unchanged:
        JSON.stringify(await snapshot(false)) === JSON.stringify(before),
    };
    await platform.dispose();
    copyFileSync(
      join(root, "migrations/0008_commerce_reservation_recovery.sql"),
      join(migrations, "0008_commerce_reservation_recovery.sql"),
    );
    migrate();
    await connect();
    recorded = await recoverExpiredReservation(
      db,
      human,
      command,
      order.reserveUntil,
    );
  }, 30_000);
  afterAll(async () => {
    await platform?.dispose();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  it("fails closed without migration 0008 and leaves the old reservation untouched", () => {
    expect(missingMigration).toEqual({
      status: 503,
      body: "Local review temporarily unavailable",
      unchanged: true,
    });
  });
  it("returns the exact original receipt and safe recovery history without any write", async () => {
    const before = await snapshot();
    const response = await throughWorker(db, await jwt(), "GET", path());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const detail = await response.json();
    expect(detail).toHaveProperty("recoveryLookup", {
      state: "recorded",
      receipt: { ...recorded, replayed: true },
    });
    expect(detail).toHaveProperty("history", [
      {
        kind: "expire",
        occurredAt: recorded.recordedAt,
        expectedVersion: 1,
        recovery: { reason: "overdue_unpaid", resultingVersion: 2 },
      },
    ]);
    expect(JSON.stringify(detail)).not.toMatch(
      /actor_hash|actorHash|request_hash|requestHash|owner_hash|snapshot|reviewer@example|fictional-human/,
    );
    const plain = await throughWorker(
      db,
      await jwt(),
      "GET",
      `/admin/commerce/review?reference=${command.reference}`,
    );
    expect(await plain.json()).not.toHaveProperty("recoveryLookup");
    expect(await snapshot()).toEqual(before);
  });
  it("reports missing receipts and actor/payload conflicts as observations without attempting recovery", async () => {
    const before = await snapshot();
    for (const [changes, state] of [
      [{ requestId: crypto.randomUUID() }, "not_recorded"],
      [{ expectedVersion: "2" }, "conflict"],
    ] as const) {
      const params = query();
      for (const [key, value] of Object.entries(changes))
        params.set(key, value);
      const response = await throughWorker(
        db,
        await jwt(),
        "GET",
        `/admin/commerce/review?${params}`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toHaveProperty("recoveryLookup", { state });
    }
    // A second trusted principal is permitted to review but cannot claim the first actor's receipt.
    const other = {
      email: "other-approved@example.invalid",
      sub: "other-approved-human",
    };
    const response = await handleWorkerRequest(
      new Request(origin + path(), {
        headers: { "Cf-Access-Jwt-Assertion": await jwt(other) },
      }),
      {
        ...env(db),
        ADMIN_IDENTITY_PAIRS: JSON.stringify([human, other]),
      } as Env,
      {} as ExecutionContext,
      handler,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("recoveryLookup", {
      state: "conflict",
    });
    expect(await snapshot()).toEqual(before);
  });
  it("reports receipt read outages without exposing failure details or changing records", async () => {
    const before = await snapshot();
    const outage = {
      prepare(sql: string) {
        if (sql.includes("FROM commerce_commands c"))
          throw new Error("private receipt-read outage");
        return db.prepare(sql);
      },
      batch: db.batch.bind(db),
    };
    const response = await throughWorker(outage, await jwt(), "GET", path());
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("recoveryLookup", {
      state: "unavailable",
    });
    expect(await snapshot()).toEqual(before);
  });
  it("keeps the trusted Admin, local and GET-only boundaries ahead of all receipt storage", async () => {
    const prepare = vi.fn();
    const batch = vi.fn();
    for (const [assertion, status] of [
      [undefined, 401],
      [await jwt({ sub: "unapproved" }), 403],
      [await jwt({ common_name: "service" }), 401],
    ] as const)
      expect(
        (await throughWorker({ prepare, batch }, assertion, "GET", path()))
          .status,
      ).toBe(status);
    expect(
      (
        await throughWorker(
          { prepare, batch },
          await jwt(),
          "GET",
          path(),
          false,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await throughWorker(
          { prepare, batch },
          await jwt(),
          "GET",
          path(),
          true,
          "https://shop.example.invalid",
        )
      ).status,
    ).toBe(404);
    const method = await throughWorker(
      { prepare, batch },
      await jwt(),
      "POST",
      path(),
    );
    expect(method.status).toBe(405);
    expect(method.headers.get("Allow")).toBe("GET");
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });
});
