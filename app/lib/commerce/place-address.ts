import { CANADIAN_REGIONS, type CanadianRegion } from "./checkout";

export type SuggestedAddress = {
  line1: string;
  line2: string;
  city: string;
  province: CanadianRegion | "";
  postalCode: string;
};
/** Map only editable address fields, never cache the provider response. An
 * incomplete suggestion leaves required fields empty for manual correction;
 * it is not proof of a deliverable address or of tax/delivery eligibility.
 */
export function mapCanadianPlace(components: unknown): SuggestedAddress | null {
  if (!Array.isArray(components) || components.length > 40) return null;
  const read = (type: string, short = false) => {
    const matches = components.filter(
      (c) =>
        c &&
        typeof c === "object" &&
        Array.isArray(c.types) &&
        c.types.includes(type),
    );
    if (matches.length !== 1) return "";
    const value: unknown = matches[0][short ? "shortText" : "longText"];
    return typeof value === "string" &&
      value.length <= 200 &&
      !/\p{Cc}/u.test(value)
      ? value.trim()
      : "";
  };
  if (read("country", true).toUpperCase() !== "CA") return null;
  const number = read("street_number"),
    street = read("route");
  const line1 = number && street ? `${number} ${street}` : "";
  const unit = read("subpremise");
  const city = read("locality") || read("postal_town");
  const province = read("administrative_area_level_1", true).toUpperCase();
  const postalCode = read("postal_code").toUpperCase().replace(/ /g, "");
  return {
    line1: line1.length <= 150 ? line1 : "",
    line2: unit.length <= 150 ? unit : "",
    city: city.length <= 100 ? city : "",
    province: CANADIAN_REGIONS.includes(province as CanadianRegion)
      ? (province as CanadianRegion)
      : "",
    postalCode:
      /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTVWXYZ]\d[ABCEGHJ-NPRSTVWXYZ]\d$/.test(
        postalCode,
      )
        ? postalCode
        : "",
  };
}
