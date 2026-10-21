import { describe, expect, it, vi } from "vitest";
import { readPlacesTestSettings } from "../../../scripts/commerce-places-config.mjs";
const key = "AIza" + "x".repeat(35);
describe("explicit local Places key-file bridge", () => {
  it("never reads a file or inherited Google credentials by default", () => {
    const read = vi.fn();
    expect(
      readPlacesTestSettings({ GOOGLE_API_KEY: "unapproved" }, read),
    ).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { COMMERCE_PLACES_MODE: "live", COMMERCE_PLACES_KEY_FILE: "/tmp/test-key" },
    {
      COMMERCE_PLACES_MODE: "google-test",
      COMMERCE_PLACES_KEY_FILE: "relative",
    },
  ])("requires both explicit mode and absolute path", (env) => {
    const read = vi.fn();
    if (!Object.keys(env).length)
      expect(readPlacesTestSettings(env, read)).toBeNull();
    else
      expect(() => readPlacesTestSettings(env, read)).toThrow(
        "explicit absolute",
      );
    expect(read).not.toHaveBeenCalled();
  });
  it("accepts only the key file and never copies unrelated environment settings", () => {
    const read = vi.fn(() => key + "\n");
    expect(
      readPlacesTestSettings(
        {
          COMMERCE_PLACES_MODE: "google-test",
          COMMERCE_PLACES_KEY_FILE: "/tmp/test-key",
          OTHER_SECRET: "private",
        },
        read,
      ),
    ).toEqual({
      COMMERCE_PLACES_MODE: "google-test",
      COMMERCE_PLACES_BROWSER_KEY: key,
    });
    expect(read).toHaveBeenCalledWith("/tmp/test-key", "utf8");
  });
  it("reports generic errors without the key or underlying private path", () => {
    const env = {
      COMMERCE_PLACES_MODE: "google-test",
      COMMERCE_PLACES_KEY_FILE: "/private/path",
    };
    expect(() =>
      readPlacesTestSettings(env, () => "private-invalid-key"),
    ).toThrow("browser key is invalid");
    expect(() =>
      readPlacesTestSettings(env, () => {
        throw new Error("sensitive underlying error");
      }),
    ).toThrow("configuration could not be read");
  });
});
