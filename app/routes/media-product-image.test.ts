import { RouterContextProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { Route } from "./+types/media-product-image";
import { cloudflareContext } from "../cloudflare-context";
import { getPublicImageSource } from "../lib/db/products.server";
import { deliverProductImage } from "../lib/images/product-image.server";

import { loader } from "./media-product-image";

vi.mock("../lib/db/products.server", () => ({ getPublicImageSource: vi.fn() }));
vi.mock("../lib/images/product-image.server", () => ({
  deliverProductImage: vi.fn(),
}));

const db = {} as D1Database;
const env = { DB: db } as Env;

function args(
  productId: string,
  imageId: string,
  profile: string,
  suffix = "",
) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env, ctx: {} as ExecutionContext });
  return {
    context,
    params: { productId, imageId, profile },
    request: new Request(
      `https://example.test/media/products/${productId}/${imageId}/${profile}${suffix}`,
    ),
  } as unknown as Route.LoaderArgs;
}

describe("public image resource route", () => {
  it("rejects invalid identities, profiles and queries before D1", async () => {
    for (const input of [
      args("0", "2", "card"),
      args("1", "-2", "card"),
      args("1", "2", "raw"),
      args("1", "2", "card", "?width=9999"),
    ]) {
      const result = await loader(input);
      expect(result.status).toBe(404);
      expect(result.headers.get("Cache-Control")).toContain("no-store");
    }
    expect(getPublicImageSource).not.toHaveBeenCalled();
  });

  it("returns the same generic 404 when D1 cannot authorize an image", async () => {
    vi.mocked(getPublicImageSource).mockResolvedValueOnce(null);
    const result = await loader(args("1001", "2001", "card"));
    expect(getPublicImageSource).toHaveBeenCalledWith(db, 1001, 2001);
    expect(deliverProductImage).not.toHaveBeenCalled();
    expect(result.status).toBe(404);
  });

  it("delivers the D1-selected key through the service", async () => {
    const response = new Response("image", { status: 200 });
    vi.mocked(getPublicImageSource).mockResolvedValueOnce({
      r2Key: "products/1001/example.jpg",
    });
    vi.mocked(deliverProductImage).mockResolvedValueOnce(response);
    expect(await loader(args("1001", "2001", "card"))).toBe(response);
    expect(deliverProductImage).toHaveBeenCalledWith(
      env,
      1001,
      "products/1001/example.jpg",
      "card",
    );
  });

  it("hides D1 failures", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(getPublicImageSource).mockRejectedValueOnce(
        new Error("private SQL"),
      );
      const result = await loader(args("1001", "2001", "card"));
      expect(result.status).toBe(503);
      expect(await result.text()).toBe("");
      expect(result.headers.get("Cache-Control")).toContain("no-store");
    } finally {
      log.mockRestore();
    }
  });
});
