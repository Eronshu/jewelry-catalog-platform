import { describe, expect, it } from "vitest";

import { formatCad } from "./format-cad";

describe("formatCad", () => {
  it("formats integer cents as Canadian dollars for the storefront", () => {
    expect(formatCad(2400)).toBe("$24.00");
    expect(formatCad(2599)).toBe("$25.99");
  });
});
