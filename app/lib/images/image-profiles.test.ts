import { describe, expect, it } from "vitest";

import { imageProfiles, isImageProfile } from "./image-profiles";
import { productImageUrl } from "./image-urls";

describe("image profile contract", () => {
  it("has exactly four bounded profiles", () => {
    expect(Object.keys(imageProfiles)).toEqual([
      "thumb",
      "card",
      "detail",
      "zoom",
    ]);
    expect(imageProfiles.card).toEqual({ width: 640, quality: 80 });
    expect(imageProfiles.zoom.width).toBeLessThanOrEqual(2000);
    expect(isImageProfile("card")).toBe(true);
    expect(isImageProfile("original")).toBe(false);
  });

  it("builds a key-free URL", () => {
    expect(productImageUrl(1001, 2001, "card")).toBe(
      "/media/products/1001/2001/card",
    );
    expect(() => productImageUrl(0, 2001, "card")).toThrow();
  });
});
