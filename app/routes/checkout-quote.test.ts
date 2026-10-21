import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cloudflareContext } from "../cloudflare-context";
import { action, headers, loader } from "./checkout-quote";
import { quoteLocalCheckout } from "../lib/commerce/checkout-quote.server";
import { CheckoutInputError } from "../lib/commerce/checkout";
import { QuoteError } from "../lib/commerce/quote";

vi.mock("../lib/commerce/checkout-quote.server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../lib/commerce/checkout-quote.server")
  >()),
  quoteLocalCheckout: vi.fn(),
}));
function args(request: Request, mode = "local-test") {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: { DB: {}, COMMERCE_MODE: mode } as unknown as Env,
    ctx: {} as ExecutionContext,
  });
  return {
    request,
    context,
    params: {},
    url: new URL(request.url),
    pattern: "/checkout/quote",
  };
}
function post(
  body = new URLSearchParams({ checkout: "{}" }).toString(),
  origin: string | null = "http://localhost",
) {
  return new Request("http://localhost/checkout/quote", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(origin === null ? {} : { Origin: origin }),
    },
    body,
  });
}
beforeEach(() => vi.clearAllMocks());
describe("local-only transient quote HTTP boundary", () => {
  it.each(["", "live"])(
    "rejects mode %s before input or data access",
    async (mode) => {
      await expect(action(args(post(), mode))).rejects.toMatchObject({
        status: 404,
      });
      expect(quoteLocalCheckout).not.toHaveBeenCalled();
    },
  );
  it("rejects remote/forged host before DB; GET has no side effects", async () => {
    await expect(
      action(
        args(
          new Request("https://example.com/checkout/quote", {
            headers: { Host: "localhost" },
          }),
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
    const result = loader(args(new Request("http://localhost/checkout/quote")));
    expect(result.init?.status).toBe(405);
    expect(new Headers(result.init?.headers).get("Allow")).toBe("POST");
    expect(quoteLocalCheckout).not.toHaveBeenCalled();
  });
  it.each([
    [null, 403],
    ["https://other.invalid", 404],
  ] as const)("rejects Origin %s", async (origin, status) => {
    if (status === 404)
      await expect(action(args(post(undefined, origin)))).rejects.toMatchObject(
        { status },
      );
    else
      expect(await action(args(post(undefined, origin)))).toMatchObject({
        status,
      });
    expect(quoteLocalCheckout).not.toHaveBeenCalled();
  });
  it.each([
    ["checkout={}&checkout={}", 400],
    ["checkout=%7Bbad", 422],
    ["checkout=" + "x".repeat(8193), 413],
  ])("rejects bounded/duplicate/invalid forms", async (body, status) => {
    const result = await action(args(post(body as string)));
    expect("status" in result ? result.status : result.init?.status).toBe(
      status,
    );
    expect(quoteLocalCheckout).not.toHaveBeenCalled();
  });
  it("returns only computed quote, private headers and no session", async () => {
    const quote = { testOnly: true, totalCents: 123 } as Awaited<
      ReturnType<typeof quoteLocalCheckout>
    >;
    vi.mocked(quoteLocalCheckout).mockResolvedValue(quote);
    const result = await action(args(post()));
    expect("data" in result && result.data).toEqual({ quote });
    expect(
      new Headers("init" in result ? result.init?.headers : undefined).get(
        "Set-Cookie",
      ),
    ).toBeNull();
    expect(headers()).toEqual({
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    });
  });
  it.each([
    [new CheckoutInputError(["contact.email"]), 422],
    [new QuoteError("UNAVAILABLE_VARIANT"), 409],
    [new Error("private@example.invalid SQL details"), 503],
  ])(
    "handles validation/availability/server failures without echo or logging",
    async (error, status) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        vi.mocked(quoteLocalCheckout).mockRejectedValueOnce(error);
        const result = await action(args(post()));
        expect("init" in result && result.init?.status).toBe(status);
        expect(JSON.stringify(result)).not.toContain("private@example.invalid");
        expect(JSON.stringify(result)).not.toContain("SQL details");
        expect(log).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    },
  );
});
