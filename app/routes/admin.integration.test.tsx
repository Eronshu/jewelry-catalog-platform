import { createRequestHandler } from "react-router";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

import handleDocument from "../entry.server";
import * as Root from "../root";
import * as Home from "./home";
import * as Admin from "./admin";
import { handleWorkerRequest } from "../../workers/app";

const issuer = "https://integration-team.cloudflareaccess.com";
const audience = "integration-admin-aud";
const email = "owner@example.invalid";
const sub = "integration-human-id";
const env = {
  ADMIN_ACCESS_ISSUER: issuer,
  ADMIN_ACCESS_AUD: audience,
  ADMIN_IDENTITY_PAIRS: JSON.stringify([{ email, sub }]),
} as unknown as Env;

const routeEntries = {
  root: {
    id: "root",
    module: Root,
    children: [
      {
        id: "routes/home",
        parentId: "root",
        index: true,
        module: Home,
        children: [],
      },
      {
        id: "routes/admin",
        parentId: "root",
        path: "admin",
        module: Admin,
        children: [],
      },
    ],
  },
  "routes/home": {
    id: "routes/home",
    parentId: "root",
    index: true,
    module: Home,
  },
  "routes/admin": {
    id: "routes/admin",
    parentId: "root",
    path: "admin",
    module: Admin,
  },
};

const assetRoute = (id: string, module: string, hasLoader = false) => ({
  id,
  module,
  hasAction: false,
  hasLoader,
  hasClientAction: false,
  hasClientLoader: false,
  hasClientMiddleware: false,
  hasErrorBoundary: id !== "routes/home",
  clientActionModule: undefined,
  clientLoaderModule: undefined,
  clientMiddlewareModule: undefined,
  hydrateFallbackModule: undefined,
});

const build = {
  entry: { module: { default: handleDocument } },
  routes: routeEntries,
  assets: {
    entry: { imports: [], module: "/entry.js" },
    routes: {
      root: assetRoute("root", "/root.js"),
      "routes/home": {
        ...assetRoute("routes/home", "/home.js"),
        parentId: "root",
        index: true,
      },
      "routes/admin": {
        ...assetRoute("routes/admin", "/admin.js", true),
        parentId: "root",
        path: "admin",
      },
    },
    url: "/manifest.js",
    version: "synthetic",
  },
  publicPath: "/",
  assetsBuildDirectory: "build/client",
  future: {},
  ssr: true,
  isSpaMode: false,
  prerender: [],
  routeDiscovery: { mode: "initial", manifestPath: "/manifest.js" },
};

const routeHandler = createRequestHandler(
  build as unknown as Parameters<typeof createRequestHandler>[0],
  "test",
);

let privateKey: CryptoKey;
let publicJwk: object;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey as CryptoKey;
  publicJwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "integration-key",
    alg: "RS256",
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (String(input) === `${issuer}/cdn-cgi/access/certs`) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error("Unexpected external fetch");
  });
});

afterAll(() => {
  vi.stubGlobal("fetch", originalFetch);
});

async function token(claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: "app", email, sub, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "integration-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

async function request(path: string, assertion?: string, config = env) {
  return handleWorkerRequest(
    new Request(`https://example.invalid${path}`, {
      headers: assertion ? { "Cf-Access-Jwt-Assertion": assertion } : {},
    }),
    config,
    {} as ExecutionContext,
    routeHandler,
  );
}

describe("Worker to React Router admin boundary", () => {
  it("denies absent, invalid, unapproved, and misconfigured admin requests", async () => {
    for (const [assertion, config, status] of [
      [undefined, env, 401],
      ["invalid", env, 401],
      [await token({ sub: "unapproved-id" }), env, 403],
      [await token(), {} as Env, 503],
    ] as const) {
      const response = await request("/admin", assertion, config);
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      const html = await response.text();
      expect(html).not.toContain(assertion ?? "synthetic-token-placeholder");
      expect(html).not.toContain(email);
      expect(html).not.toContain(issuer);
    }
  });

  it("renders the route only for a verified approved human", async () => {
    const response = await request("/admin", await token());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const html = await response.text();
    expect(html).toContain("Your catalog workspace");
    expect(html).toContain("Catalog admin");
    expect(html).not.toContain("site-shell");
    expect(html).not.toContain(email);
    expect(html).not.toContain(sub);
  });

  it("authenticates an approved admin data request before the loader runs", async () => {
    const approved = await request("/admin.data", await token());
    expect(approved.status).toBe(200);
    expect(approved.headers.get("Cache-Control")).toBe("private, no-store");

    const absent = await request("/admin.data");
    expect(absent.status).toBe(401);
    expect(absent.headers.get("Cache-Control")).toBe("private, no-store");

    const unapproved = await request(
      "/admin.data",
      await token({ sub: "unapproved-id" }),
    );
    expect(unapproved.status).toBe(403);
    expect(unapproved.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("guards nested and alternate spellings of the admin namespace", async () => {
    for (const path of ["/admin/next", "/Admin", "/%61dmin"]) {
      const response = await request(path);
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    const nested = await request("/admin/next", await token());
    expect(nested.status).toBe(404);
    expect(nested.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("keeps unexpected admin route errors generic and uncacheable", async () => {
    const response = await handleWorkerRequest(
      new Request("https://example.invalid/admin", {
        headers: { "Cf-Access-Jwt-Assertion": await token() },
      }),
      env,
      {} as ExecutionContext,
      async () => {
        throw new Error("sensitive synthetic detail");
      },
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.text()).not.toContain("sensitive synthetic detail");
  });

  it("keeps public Home accessible and preserves the public image cache exception", async () => {
    const home = await request("/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("site-shell");

    const image = await handleWorkerRequest(
      new Request("https://example.invalid/media/products/1/2/card"),
      {} as Env,
      {} as ExecutionContext,
      async () =>
        new Response("synthetic image", {
          headers: { "Cache-Control": "public, max-age=86400" },
        }),
    );
    expect(image.headers.get("Cache-Control")).toBe("public, max-age=86400");
  });
});
