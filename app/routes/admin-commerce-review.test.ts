import {
  createRequestHandler,
  RouterContextProvider,
  useLoaderData,
} from "react-router";
import { createElement } from "react";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cloudflareContext } from "../cloudflare-context";
import { adminPrincipalContext } from "../lib/auth/admin-access.server";
import { handleWorkerRequest } from "../../workers/app";
import * as ReviewRoute from "./admin-commerce-review";
import * as ScreenRoute from "./admin-commerce-reservations";
import handleDocument from "../entry.server";

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
const handler = createRequestHandler(
  {
    entry: { module: { default: handleDocument } },
    routes: { [route.id]: route, [screen.id]: screen },
    assets: {
      entry: { imports: [], module: "/entry.js" },
      routes: {
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
