import { describe, expect, it } from "vitest";

import { formatAdminDate } from "./format-admin-date";

describe("formatAdminDate", () => {
  it("uses the Toronto calendar date across the UTC midnight boundary", () => {
    const timestamp = Date.parse("2026-10-01T02:30:00Z");
    expect(new Date(timestamp).toISOString().slice(0, 10)).toBe("2026-10-01");
    expect(formatAdminDate(timestamp)).toBe("2026-09-30");
    expect(formatAdminDate(Date.parse("2026-10-01T04:30:00Z"))).toBe(
      "2026-10-01",
    );
  });
});
