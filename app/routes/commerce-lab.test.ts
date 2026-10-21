import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cloudflareContext } from "../cloudflare-context";
import { action, loader, headers } from "./commerce-lab";
import { listCommerceVariants } from "../lib/commerce/inventory.server";
import {
  createTestQuote,
  listTestOrders,
  OrderError,
  reserveTestOrder,
  releaseTestOrder,
} from "../lib/commerce/orders.server";

vi.mock("../lib/commerce/inventory.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listCommerceVariants: vi.fn(),
}));
vi.mock("../lib/commerce/orders.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createTestQuote: vi.fn(),
  listTestOrders: vi.fn(),
  reserveTestOrder: vi.fn(),
  releaseTestOrder: vi.fn(),
}));
const origin = "http://127.0.0.1:8791";
function args(request: Request, enabled = true) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: { DB: {}, ...(enabled ? { COMMERCE_MODE: "local-test" } : {}) } as Env,
    ctx: {} as ExecutionContext,
  });
  return {
    request,
    context,
    params: {},
    url: new URL(request.url),
    pattern: "/commerce-lab",
  };
}
function post(
  body: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return new Request(`${origin}/commerce-lab`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: `commerce_lab_session_v1=${"a".repeat(64)}`,
      ...headers,
    },
    body: new URLSearchParams(body),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listCommerceVariants).mockResolvedValue([]);
  vi.mocked(listTestOrders).mockResolvedValue([]);
});
describe("local commerce route trust boundary", () => {
  it("denies loader and action before accessing storage when disabled or remote", async () => {
    for (const input of [
      args(new Request(`${origin}/commerce-lab`), false),
      args(new Request("https://example.com/commerce-lab")),
    ]) {
      await expect(loader(input)).rejects.toMatchObject({ status: 404 });
      await expect(action(input)).rejects.toMatchObject({ status: 404 });
    }
    expect(listCommerceVariants).not.toHaveBeenCalled();
    expect(listTestOrders).not.toHaveBeenCalled();
    expect(createTestQuote).not.toHaveBeenCalled();
  });
  it("issues a private browser session with no-store and noindex", async () => {
    const result = await loader(args(new Request(`${origin}/commerce-lab`)));
    const headers = new Headers(result.init?.headers);
    expect(headers.get("Set-Cookie")).toContain(
      "HttpOnly; SameSite=Strict; Path=/",
    );
    expect(headers.get("Cache-Control")).toBe("private, no-store");
    expect(headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(listTestOrders).toHaveBeenCalledWith(
      {},
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
  });
  it("keeps document and action responses private and unindexed", () => {
    const result = headers({
      loaderHeaders: new Headers({ "Set-Cookie": "fictional-cookie" }),
      actionHeaders: new Headers(),
      parentHeaders: new Headers(),
      errorHeaders: undefined,
    });
    expect(result.get("Set-Cookie")).toBe("fictional-cookie");
    expect(result.get("Cache-Control")).toBe("private, no-store");
    expect(result.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("requires an existing session and exact Origin for mutations", async () => {
    expect(
      (await action(args(post({ intent: "reserve" }, { Cookie: "" })))).init
        ?.status,
    ).toBe(409);
    const missingOrigin = post({ intent: "reserve" });
    missingOrigin.headers.delete("Origin");
    await expect(action(args(missingOrigin))).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      action(
        args(post({ intent: "reserve" }, { Origin: "https://evil.example" })),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(reserveTestOrder).not.toHaveBeenCalled();
  });
  it("passes only cart identifiers and delivery to authoritative quoting", async () => {
    vi.mocked(createTestQuote).mockResolvedValue({
      id: "test",
      quote: { testOnly: true },
    } as never);
    const lines = [{ variantId: "v1", quantity: 1 }];
    await action(
      args(
        post({
          intent: "quote",
          lines: JSON.stringify(lines),
          delivery: "pickup",
          totalCents: "1",
          owner: "attacker",
        }),
      ),
    );
    expect(createTestQuote).toHaveBeenCalledWith(
      {},
      expect.stringMatching(/^[a-f0-9]{64}$/),
      lines,
      "pickup",
    );
  });
  it("does not trust client order ownership or reservation amounts", async () => {
    await action(
      args(
        post({
          intent: "reserve",
          quoteId: "q1",
          owner: "attacker",
          quantity: "999",
        }),
      ),
    );
    expect(reserveTestOrder).toHaveBeenCalledWith(
      {},
      expect.stringMatching(/^[a-f0-9]{64}$/),
      "q1",
    );
    await action(
      args(post({ intent: "cancel", orderId: "o1", owner: "attacker" })),
    );
    expect(releaseTestOrder).toHaveBeenCalledWith(
      {},
      expect.stringMatching(/^[a-f0-9]{64}$/),
      "o1",
      "cancel",
    );
  });
  it("returns safe errors for missing orders, database failures and bad JSON", async () => {
    vi.mocked(reserveTestOrder)
      .mockRejectedValueOnce(new OrderError("not_found"))
      .mockRejectedValueOnce(new Error("secret database detail"));
    expect(
      (await action(args(post({ intent: "reserve", quoteId: "q" })))).init
        ?.status,
    ).toBe(404);
    const failed = await action(
      args(post({ intent: "reserve", quoteId: "q" })),
    );
    expect(failed.init?.status).toBe(503);
    expect(JSON.stringify(failed)).not.toContain("secret database detail");
    expect(
      (await action(args(post({ intent: "quote", lines: "{" })))).init?.status,
    ).toBe(422);
  });
});
