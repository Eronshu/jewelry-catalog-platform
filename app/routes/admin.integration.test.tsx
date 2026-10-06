import {
  createRequestHandler,
  useActionData,
  useLoaderData,
} from "react-router";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { getPlatformProxy } from "wrangler";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

import handleDocument from "../entry.server";
import * as Root from "../root";
import * as Home from "./home";
import * as Admin from "./admin";
import * as AdminProductNew from "./admin-product-new";
import * as AdminProductCreate from "./admin-product-create";
import * as AdminPhotoUpload from "./admin-product-photo-upload";
import * as AdminPhotoPreview from "./admin-product-photo-preview";
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

function NewProductWithFrameworkProps() {
  return (
    <AdminProductNew.default
      {...({
        loaderData: useLoaderData(),
        actionData: useActionData(),
      } as Parameters<typeof AdminProductNew.default>[0])}
    />
  );
}
function HomeWithFrameworkProps() {
  return (
    <Home.default
      {...({ loaderData: useLoaderData() } as Parameters<
        typeof Home.default
      >[0])}
    />
  );
}
const homeRouteModule = { ...Home, default: HomeWithFrameworkProps };
const newProductRouteModule = {
  ...AdminProductNew,
  default: NewProductWithFrameworkProps,
};

const routeEntries = {
  root: {
    id: "root",
    module: Root,
    children: [
      {
        id: "routes/home",
        parentId: "root",
        index: true,
        module: homeRouteModule,
        children: [],
      },
      {
        id: "routes/admin",
        parentId: "root",
        path: "admin",
        module: Admin,
        children: [],
      },
      {
        id: "routes/admin-product-new",
        parentId: "root",
        path: "admin/products/new",
        module: newProductRouteModule,
        children: [],
      },
      {
        id: "routes/admin-product-create",
        parentId: "root",
        path: "admin/products/new/create",
        module: AdminProductCreate,
        children: [],
      },
      {
        id: "routes/admin-product-photo-upload",
        parentId: "root",
        path: "admin/products/:productId/photos/upload",
        module: AdminPhotoUpload,
        children: [],
      },
      {
        id: "routes/admin-product-photo-preview",
        parentId: "root",
        path: "admin/products/:productId/photos/:photoId/preview",
        module: AdminPhotoPreview,
        children: [],
      },
    ],
  },
  "routes/home": {
    id: "routes/home",
    parentId: "root",
    index: true,
    module: homeRouteModule,
  },
  "routes/admin": {
    id: "routes/admin",
    parentId: "root",
    path: "admin",
    module: Admin,
  },
  "routes/admin-product-new": {
    id: "routes/admin-product-new",
    parentId: "root",
    path: "admin/products/new",
    module: newProductRouteModule,
  },
  "routes/admin-product-create": {
    id: "routes/admin-product-create",
    parentId: "root",
    path: "admin/products/new/create",
    module: AdminProductCreate,
  },
  "routes/admin-product-photo-upload": {
    id: "routes/admin-product-photo-upload",
    parentId: "root",
    path: "admin/products/:productId/photos/upload",
    module: AdminPhotoUpload,
  },
  "routes/admin-product-photo-preview": {
    id: "routes/admin-product-photo-preview",
    parentId: "root",
    path: "admin/products/:productId/photos/:photoId/preview",
    module: AdminPhotoPreview,
  },
};

const assetRoute = (
  id: string,
  module: string,
  hasLoader = false,
  hasAction = false,
) => ({
  id,
  module,
  hasAction,
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
        ...assetRoute("routes/home", "/home.js", true),
        hasErrorBoundary: true,
        parentId: "root",
        index: true,
      },
      "routes/admin": {
        ...assetRoute("routes/admin", "/admin.js", true),
        parentId: "root",
        path: "admin",
      },
      "routes/admin-product-new": {
        ...assetRoute(
          "routes/admin-product-new",
          "/admin-product-new.js",
          true,
          true,
        ),
        parentId: "root",
        path: "admin/products/new",
      },
      "routes/admin-product-create": {
        ...assetRoute(
          "routes/admin-product-create",
          "/admin-product-create.js",
          false,
          true,
        ),
        parentId: "root",
        path: "admin/products/new/create",
      },
      "routes/admin-product-photo-upload": {
        ...assetRoute(
          "routes/admin-product-photo-upload",
          "/admin-product-photo-upload.js",
          false,
          true,
        ),
        parentId: "root",
        path: "admin/products/:productId/photos/upload",
      },
      "routes/admin-product-photo-preview": {
        ...assetRoute(
          "routes/admin-product-photo-preview",
          "/admin-product-photo-preview.js",
          true,
        ),
        parentId: "root",
        path: "admin/products/:productId/photos/:photoId/preview",
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
    for (const path of [
      "/admin/next",
      "/admin/products",
      "/admin/products.data",
      "/admin/products/new.data",
      "/Admin",
      "/%61dmin",
    ]) {
      const response = await request(path);
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    const nested = await request("/admin/next", await token());
    expect(nested.status).toBe(404);
    expect(nested.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("creates one Draft through the Worker and real product action only for an approved human", async () => {
    const root = resolve(process.cwd());
    const localDir = mkdtempSync(
      join(tmpdir(), "jewelry-admin-boundary-test-"),
    );
    let platform: Awaited<ReturnType<typeof getPlatformProxy<Env>>> | undefined;
    try {
      execFileSync(
        join(root, "node_modules", ".bin", "wrangler"),
        [
          "d1",
          "migrations",
          "apply",
          "DB",
          "--local",
          "--persist-to",
          localDir,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            CI: "1",
            WRANGLER_LOG_PATH: join(localDir, "wrangler.log"),
          },
          stdio: "pipe",
        },
      );
      platform = await getPlatformProxy<Env>({
        configPath: join(root, "wrangler.jsonc"),
        envFiles: [],
        persist: { path: join(localDir, "v3") },
        remoteBindings: false,
      });
      const productEnv = { ...platform.env, ...env } as Env;
      const addDocument = await handleWorkerRequest(
        new Request("https://example.invalid/admin/products/new", {
          headers: { "Cf-Access-Jwt-Assertion": await token() },
        }),
        productEnv,
        {} as ExecutionContext,
        routeHandler,
      );
      expect(addDocument.status).toBe(200);
      expect(addDocument.headers.get("Cache-Control")).toBe(
        "private, no-store",
      );
      const addHtml = await addDocument.text();
      expect(addHtml).toContain("Add product");
      expect(addHtml).toContain('name="requestKey"');
      expect(addHtml).toContain('value="create"');
      expect(addHtml).toContain("Saving creates a private Draft");
      expect(addHtml).not.toContain("Checking for a previously saved Draft");
      expect(addHtml).not.toContain('id="photo-picker"');
      const requestKey = crypto.randomUUID();
      const body = new URLSearchParams({
        intent: "create",
        name: "Fictional Boundary Ring",
        price: "31.50",
        categoryId: "4",
        material: "",
        colour: "",
        description: "",
        sku: "",
        quantity: "",
        facebookUrl: "",
        requestKey,
      }).toString();
      const post = (path: string, assertion?: string) =>
        handleWorkerRequest(
          new Request(`https://example.invalid${path}`, {
            method: "POST",
            headers: {
              Origin: "https://example.invalid",
              "Content-Type": "application/x-www-form-urlencoded",
              ...(assertion ? { "Cf-Access-Jwt-Assertion": assertion } : {}),
            },
            body,
          }),
          productEnv,
          {} as ExecutionContext,
          routeHandler,
        );
      const count = async () =>
        (await platform!.env.DB.prepare(
          "SELECT COUNT(*) AS n FROM products",
        ).first<{ n: number }>())!.n;
      for (const [assertion, status] of [
        [undefined, 401],
        [await token({ sub: "unapproved-id" }), 403],
      ] as const) {
        const denied = await post("/admin/products/new.data", assertion);
        expect(denied.status).toBe(status);
        expect(denied.headers.get("Cache-Control")).toBe("private, no-store");
        expect(await count()).toBe(0);
        const deniedEnhanced = await post(
          "/admin/products/new/create",
          assertion,
        );
        expect(deniedEnhanced.status).toBe(status);
        expect(deniedEnhanced.headers.get("Cache-Control")).toBe(
          "private, no-store",
        );
        expect(await count()).toBe(0);
      }
      const approved = await post("/admin/products/new.data", await token());
      expect(approved.headers.get("Cache-Control")).toBe("private, no-store");
      expect(approved.status).toBe(202);
      expect(approved.headers.get("X-Remix-Response")).toBe("yes");
      const row = await platform.env.DB.prepare(
        "SELECT id, name, status, price_cents FROM products",
      ).first<{
        id: number;
        name: string;
        status: string;
        price_cents: number;
      }>();
      expect(row).toMatchObject({
        name: "Fictional Boundary Ring",
        status: "draft",
        price_cents: 3150,
      });
      expect(await approved.text()).toContain(
        `/admin/products/${row!.id}/edit`,
      );
      expect(await count()).toBe(1);
      const enhancedReplay = await post(
        "/admin/products/new/create",
        await token(),
      );
      expect(enhancedReplay.status).toBe(200);
      expect(enhancedReplay.headers.get("Cache-Control")).toBe(
        "private, no-store",
      );
      const enhancedBody = (await enhancedReplay.json()) as {
        product: unknown;
      };
      expect(enhancedBody.product).toMatchObject({
        id: row!.id,
        status: "draft",
      });
      expect(await count()).toBe(1);
      const documentReplay = await post("/admin/products/new", await token());
      expect(documentReplay.status).toBe(302);
      expect(documentReplay.headers.get("Location")).toBe(
        `/admin/products/${row!.id}/edit`,
      );
      expect(documentReplay.headers.get("Cache-Control")).toBe(
        "private, no-store",
      );
      expect(await count()).toBe(1);

      const photoBytes = readFileSync(
        resolve("tests/fixtures/still-photo.png"),
      );
      const photoHash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", photoBytes)),
        (value) => value.toString(16).padStart(2, "0"),
      ).join("");
      const uploadId = crypto.randomUUID();
      const version = (await platform.env.DB.prepare(
        "SELECT updated_at FROM products WHERE id = ?",
      )
        .bind(row!.id)
        .first<{ updated_at: number }>())!.updated_at;
      const upload = async (assertion?: string) =>
        handleWorkerRequest(
          new Request(
            `https://example.invalid/admin/products/${row!.id}/photos/upload`,
            {
              method: "POST",
              headers: {
                Origin: "https://example.invalid",
                "Content-Type": "image/png",
                "Content-Length": String(photoBytes.length),
                "X-Upload-Id": uploadId,
                "X-Photo-Sha256": photoHash,
                "X-Product-Version": String(version),
                ...(assertion ? { "Cf-Access-Jwt-Assertion": assertion } : {}),
              },
              body: Uint8Array.from(photoBytes),
            },
          ),
          productEnv,
          {} as ExecutionContext,
          routeHandler,
        );
      expect((await upload()).status).toBe(401);
      expect(
        (await platform.env.DB.prepare(
          "SELECT COUNT(*) AS n FROM product_images",
        ).first<{ n: number }>())!.n,
      ).toBe(0);
      const uploaded = await upload(await token());
      expect(uploaded.status).toBe(200);
      expect(uploaded.headers.get("Cache-Control")).toBe("private, no-store");
      const image = await platform.env.DB.prepare(
        "SELECT id FROM product_images WHERE product_id = ?",
      )
        .bind(row!.id)
        .first<{ id: number }>();
      expect(image?.id).toBeGreaterThan(0);
      const previewPath = `/admin/products/${row!.id}/photos/${image!.id}/preview`;
      expect((await request(previewPath)).status).toBe(401);
      const preview = await handleWorkerRequest(
        new Request(`https://example.invalid${previewPath}`, {
          headers: { "Cf-Access-Jwt-Assertion": await token() },
        }),
        productEnv,
        {} as ExecutionContext,
        routeHandler,
      );
      expect(preview.status).toBe(200);
      expect(preview.headers.get("Cache-Control")).toBe("private, no-store");
    } finally {
      await platform?.dispose();
      rmSync(localDir, { recursive: true, force: true });
    }
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
    const emptyDb = {
      prepare: () => ({
        bind() {
          return this;
        },
        all: async () => ({ results: [] }),
      }),
    } as unknown as D1Database;
    const home = await request("/", undefined, { ...env, DB: emptyDb });
    const homeHtml = await home.text();
    expect(home.status).toBe(200);
    expect(homeHtml).toContain("site-shell");
    expect(homeHtml).toContain("No pieces to feature right now");

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
