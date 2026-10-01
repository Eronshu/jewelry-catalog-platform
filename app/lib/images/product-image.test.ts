import { describe, expect, it, vi } from "vitest";

import {
  deliverProductImage,
  imageKeyContentType,
} from "./product-image.server";

const validKey = "products/1001/123e4567-e89b-12d3-a456-426614174000.jpg";

describe("product image delivery", () => {
  it("accepts only a key for the selected product", () => {
    expect(imageKeyContentType(validKey, 1001)).toBe("image/jpeg");
    for (const key of [
      "dev/products/demo/01.jpg",
      "products/1002/123e4567-e89b-12d3-a456-426614174000.jpg",
      "products/1001/../private.jpg",
      "products/1001/%2e%2e/private.jpg",
      "products/1001/123e4567-e89b-12d3-a456-426614174000.svg",
      "products/1001/123e4567-e89b-12d3-a456-426614174000.jpg/extra",
    ]) {
      expect(imageKeyContentType(key, 1001)).toBeNull();
    }
  });

  it("never reads R2 for an invalid key", async () => {
    const get = vi.fn();
    const env = { PRODUCT_IMAGES: { get }, IMAGES: {} } as unknown as Pick<
      Env,
      "PRODUCT_IMAGES" | "IMAGES"
    >;
    const response = await deliverProductImage(
      env,
      1001,
      "private/key",
      "card",
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(get).not.toHaveBeenCalled();
  });

  it("returns a generic 404 for a missing object", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = {
      PRODUCT_IMAGES: { get: vi.fn().mockResolvedValue(null) },
      IMAGES: {},
    } as unknown as Pick<Env, "PRODUCT_IMAGES" | "IMAGES">;
    try {
      const response = await deliverProductImage(env, 1001, validKey, "card");
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.text()).toBe("");
      expect(log).toHaveBeenCalledExactlyOnceWith(
        "Product image R2 object missing",
        { productId: 1001 },
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(validKey);
      expect(JSON.stringify(log.mock.calls)).not.toContain("PRODUCT_IMAGES");
    } finally {
      log.mockRestore();
    }
  });

  it("rejects mismatched R2 content type without transforming", async () => {
    const input = vi.fn();
    const env = {
      PRODUCT_IMAGES: {
        get: vi.fn().mockResolvedValue({
          body: new ReadableStream(),
          size: 100,
          httpMetadata: { contentType: "text/html" },
        }),
      },
      IMAGES: { input },
    } as unknown as Pick<Env, "PRODUCT_IMAGES" | "IMAGES">;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await deliverProductImage(env, 1001, validKey, "card");
      expect(result.status).toBe(502);
      expect(result.headers.get("Cache-Control")).toContain("no-store");
      expect(input).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("passes a bounded transformation and public cache header", async () => {
    const response = new Response("webp", {
      headers: { "Content-Type": "image/webp" },
    });
    const responseFn = vi.fn().mockReturnValue(response);
    const output = vi.fn().mockReturnValue({ response: responseFn });
    const transform = vi.fn().mockReturnValue({ output });
    const input = vi.fn().mockReturnValue({ transform });
    const env = {
      PRODUCT_IMAGES: {
        get: vi.fn().mockResolvedValue({
          body: new ReadableStream(),
          size: 100,
          httpMetadata: { contentType: "image/jpeg" },
        }),
      },
      IMAGES: { input },
    } as unknown as Pick<Env, "PRODUCT_IMAGES" | "IMAGES">;
    const result = await deliverProductImage(env, 1001, validKey, "card");
    expect(transform).toHaveBeenCalledWith({ width: 640, fit: "scale-down" });
    expect(output).toHaveBeenCalledWith({ format: "image/webp", quality: 80 });
    expect(responseFn).toHaveBeenCalledWith({
      headers: {
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
      },
    });
    expect(result.headers.get("Content-Type")).toBe("image/webp");
  });

  it("hides R2 and transformation failures", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r2Failure = {
        PRODUCT_IMAGES: {
          get: vi.fn().mockRejectedValue(new Error("private bucket")),
        },
        IMAGES: {},
      } as unknown as Pick<Env, "PRODUCT_IMAGES" | "IMAGES">;
      const r2Result = await deliverProductImage(
        r2Failure,
        1001,
        validKey,
        "card",
      );
      expect(r2Result.status).toBe(503);
      expect(await r2Result.text()).toBe("");

      const imageFailure = {
        PRODUCT_IMAGES: {
          get: vi.fn().mockResolvedValue({
            body: new ReadableStream(),
            size: 100,
            httpMetadata: { contentType: "image/jpeg" },
          }),
        },
        IMAGES: {
          input: vi.fn().mockImplementation(() => {
            throw new Error("internal transform");
          }),
        },
      } as unknown as Pick<Env, "PRODUCT_IMAGES" | "IMAGES">;
      const imageResult = await deliverProductImage(
        imageFailure,
        1001,
        validKey,
        "card",
      );
      expect(imageResult.status).toBe(502);
      expect(imageResult.headers.get("Cache-Control")).toContain("no-store");
      expect(await imageResult.text()).toBe("");
    } finally {
      log.mockRestore();
    }
  });
});
