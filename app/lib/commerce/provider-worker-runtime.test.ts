import { readFileSync } from "node:fs";
import { Miniflare, Response as RuntimeResponse } from "miniflare";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Actual workerd Request/fetch semantics, with all outbound traffic intercepted.
// No credential files, real providers, orders or inventory are used by this test.
describe("provider transport in workerd", () => {
  it.each(["stripe", "paypal"] as const)(
    "%s sends its first request but never follows a credential-bearing redirect",
    async (provider) => {
      const now = 1_800_000_000_000;
      const common = {
        enabled: true,
        mode: "local-test",
        instanceId: "11111111-1111-4111-8111-111111111111",
        canonicalOrigin: "http://127.0.0.1:8791",
      };
      const config =
        provider === "stripe"
          ? {
              ...common,
              expectedAccountId: "acct_FictionalOnly123",
              testSecretKey: ["sk", "test", "0".repeat(24)].join("_"),
            }
          : {
              ...common,
              expectedMerchantId: "ABCDEFGHJKLMN",
              clientId: "0".repeat(32),
              clientSecret: "1".repeat(32),
            };
      const input = {
        orderId: "order-22222222-2222-4222-8222-222222222222",
        attemptId: "33333333-3333-4333-8333-333333333333",
        createOperationKey: "44444444-4444-4444-8444-444444444444",
        amountCents: 4400,
        ...(provider === "stripe"
          ? { sessionExpiresAt: now / 1000 + 3600 }
          : {}),
      };
      const source = readFileSync(
        new URL(`./${provider}-sandbox.server.ts`, import.meta.url),
        "utf8",
      );
      const adapter = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2023,
        },
      }).outputText;
      const operation =
        provider === "stripe"
          ? "createStripeSandboxSession"
          : "createPayPalSandboxOrder";
      const calls: {
        url: string;
        method: string;
        hasAuthorization: boolean;
      }[] = [];
      const script = `import { ${operation} } from "./adapter.js";
export default {
  async fetch() {
    try {
      await ${operation}(${JSON.stringify(config)}, ${JSON.stringify(input)},
        (url, init) => fetch(url, init), () => ${now});
      return Response.json({ unexpectedlySucceeded: true });
    } catch (error) {
      return Response.json({ code: error.code });
    }
  }
};`;
      const runtime = new Miniflare({
        cf: false,
        host: "127.0.0.1",
        port: 0,
        inspectorPort: 0,
        telemetry: { enabled: false },
        workers: [
          {
            config: {
              name: "payment-redirect-regression",
              compatibilityDate: "2026-09-29",
              manifest: {
                mainModule: "worker.js",
                modules: {
                  "worker.js": { type: "esm", contents: script },
                  "adapter.js": { type: "esm", contents: adapter },
                },
              },
            },
            dev: {
              outboundService: {
                type: "fetcher",
                handler: async (request) => {
                  calls.push({
                    url: request.url,
                    method: request.method,
                    hasAuthorization: request.headers.has("Authorization"),
                  });
                  return new RuntimeResponse(null, {
                    status: 302,
                    headers: {
                      Location: "https://redirect.example.invalid/collect",
                    },
                  });
                },
              },
            },
          },
        ],
      });
      try {
        const response = await runtime.dispatchFetch("http://localhost/test");
        expect(await response.json()).toEqual({ code: "unavailable" });
        expect(calls).toEqual([
          {
            url:
              provider === "stripe"
                ? "https://api.stripe.com/v1/account"
                : "https://api-m.sandbox.paypal.com/v1/oauth2/token",
            method: provider === "stripe" ? "GET" : "POST",
            hasAuthorization: true,
          },
        ]);
      } finally {
        await runtime.dispose();
      }
    },
    20_000,
  );
});
