import { describe, expect, it } from "vitest";
import { mapCanadianPlace } from "./place-address";
export const component = (
  type: string,
  longText: string,
  shortText = longText,
) => ({ types: [type], longText, shortText });
export const canadianPlace = () => [
  component("street_number", "100"),
  component("route", "Fictional Test Street"),
  component("locality", "Test City"),
  component("administrative_area_level_1", "Ontario", "ON"),
  component("postal_code", "K1A 0B1"),
  component("country", "Canada", "CA"),
];
describe("minimal Canadian address mapping", () => {
  it("maps only editable fields, not IDs, coordinates, formatted response or metadata", () => {
    expect(
      mapCanadianPlace([...canadianPlace(), component("subpremise", "TEST")]),
    ).toEqual({
      line1: "100 Fictional Test Street",
      line2: "TEST",
      city: "Test City",
      province: "ON",
      postalCode: "K1A0B1",
    });
  });
  it.each([
    null,
    {},
    [],
    [component("country", "USA", "US")],
    [...canadianPlace(), component("country", "USA", "US")],
  ])("rejects non-Canadian, missing or ambiguous country %j", (input) =>
    expect(mapCanadianPlace(input)).toBeNull(),
  );
  it.each([
    "street_number",
    "route",
    "locality",
    "administrative_area_level_1",
    "postal_code",
  ])(
    "leaves missing %s fields empty rather than retaining an old address",
    (type) => {
      const address = mapCanadianPlace(
        canadianPlace().filter((c) => !c.types.includes(type)),
      )!;
      const key =
        type === "street_number" || type === "route"
          ? "line1"
          : type === "locality"
            ? "city"
            : type === "postal_code"
              ? "postalCode"
              : "province";
      expect(address[key]).toBe("");
    },
  );
  it("allows postal town but does not mistake county for a city", () => {
    const noCity = canadianPlace().filter((c) => !c.types.includes("locality"));
    expect(
      mapCanadianPlace([...noCity, component("postal_town", "Test Town")])
        ?.city,
    ).toBe("Test Town");
    expect(
      mapCanadianPlace([
        ...noCity,
        component("administrative_area_level_2", "Test County"),
      ])?.city,
    ).toBe("");
  });
  it("does not apply control characters, oversized fields, unknown provinces or invalid postcodes", () => {
    const data = canadianPlace().map((c) =>
      c.types.includes("route")
        ? { ...c, longText: "bad\nvalue" }
        : c.types.includes("locality")
          ? { ...c, longText: "x".repeat(101) }
          : c.types.includes("administrative_area_level_1")
            ? { ...c, shortText: "XX" }
            : c.types.includes("postal_code")
              ? { ...c, longText: "12345" }
              : c,
    );
    expect(mapCanadianPlace(data)).toMatchObject({
      line1: "",
      city: "",
      province: "",
      postalCode: "",
    });
  });
});
