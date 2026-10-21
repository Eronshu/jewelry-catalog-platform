import { describe, expect, it } from "vitest";
import { readLocalPlacesKey } from "./places-config.server";
const browserKey = "AIza" + "x".repeat(35);
const config = {
  COMMERCE_MODE: "local-test",
  COMMERCE_PLACES_MODE: "google-test",
  COMMERCE_PLACES_BROWSER_KEY: browserKey,
};
describe("local Places configuration boundary", () => {
  it("returns only the deliberately configured browser key locally", () =>
    expect(
      readLocalPlacesKey(new Request("http://127.0.0.1:8794/checkout"), {
        ...config,
        STRIPE_SECRET: "never-return",
      }),
    ).toBe(browserKey));
  it.each([
    {},
    { ...config, COMMERCE_PLACES_MODE: "live" },
    { ...config, COMMERCE_PLACES_BROWSER_KEY: "invalid" },
    { ...config, COMMERCE_PLACES_BROWSER_KEY: undefined },
    Object.create(config),
  ])("fails closed for absent/wrong/inherited settings", (input) => {
    if (!Object.hasOwn(input, "COMMERCE_MODE"))
      expect(() =>
        readLocalPlacesKey(new Request("http://localhost/checkout"), input),
      ).toThrow(expect.objectContaining({ status: 404 }));
    else
      expect(
        readLocalPlacesKey(new Request("http://localhost/checkout"), input),
      ).toBeNull();
  });
  it.each(["https://example.com/checkout", "http://192.168.1.5/checkout"])(
    "never returns the browser key for %s",
    (url) =>
      expect(() => readLocalPlacesKey(new Request(url), config)).toThrow(
        expect.objectContaining({ status: 404 }),
      ),
  );
});
