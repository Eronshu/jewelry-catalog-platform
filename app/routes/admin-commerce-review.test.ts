import { createRequestHandler, RouterContextProvider } from "react-router";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cloudflareContext } from "../cloudflare-context";
import { adminPrincipalContext } from "../lib/auth/admin-access.server";
import { handleWorkerRequest } from "../../workers/app";
import * as ReviewRoute from "./admin-commerce-review";

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
const handler = createRequestHandler(
  {
    entry: { module: { default: () => new Response("Test document") } },
    routes: { [route.id]: route },
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
  });
});
