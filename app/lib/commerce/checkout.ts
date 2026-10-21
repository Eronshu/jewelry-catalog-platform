import type { CartLine, DeliveryMethod, TestQuote } from "./quote";
import { parseShoppingLines } from "./shopping-cart";

export const CHECKOUT_CONTRACT_VERSION = "local-checkout-v1";
export const CANADIAN_REGIONS = [
  "AB",
  "BC",
  "MB",
  "NB",
  "NL",
  "NS",
  "NT",
  "NU",
  "ON",
  "PE",
  "QC",
  "SK",
  "YT",
] as const;
export type CanadianRegion = (typeof CANADIAN_REGIONS)[number];
export type CheckoutAddress = {
  line1: string;
  line2: string;
  city: string;
  province: CanadianRegion;
  postalCode: string;
  country: "CA";
};
export type CheckoutInput = {
  contractVersion: typeof CHECKOUT_CONTRACT_VERSION;
  // UI correlation only: never an order, quote-acceptance or authorization token.
  requestId: string;
  lines: CartLine[];
  contact: { name: string; email: string };
  delivery:
    | { method: "pickup" }
    | { method: "local_delivery" | "shipping"; address: CheckoutAddress };
};
export type CheckoutField =
  | "contractVersion"
  | "requestId"
  | "lines"
  | "contact.name"
  | "contact.email"
  | "delivery.method"
  | "delivery.address.line1"
  | "delivery.address.line2"
  | "delivery.address.city"
  | "delivery.address.province"
  | "delivery.address.postalCode"
  | "delivery.address.country";
export class CheckoutInputError extends Error {
  constructor(public readonly fields: CheckoutField[]) {
    super("Check the test delivery details.");
    this.name = "CheckoutInputError";
  }
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown, max: number, optional = false): string | null {
  if (optional && value === undefined) return "";
  if (typeof value !== "string" || /\p{Cc}/u.test(value)) return null;
  const trimmed = value.trim();
  return trimmed.length <= max && (optional || trimmed.length > 0)
    ? trimmed
    : null;
}

/** Validate in memory only. Never echo this object to clients or persist it in
 * cart storage, cookies, quote snapshots, analytics or logs. Address syntax is
 * not evidence of deliverability. Use fictional identities in this local slice.
 */
export function parseCheckoutInput(value: unknown): CheckoutInput {
  const input = object(value);
  const contact = object(input.contact);
  const delivery = object(input.delivery);
  const fields: CheckoutField[] = [];
  if (input.contractVersion !== CHECKOUT_CONTRACT_VERSION)
    fields.push("contractVersion");
  if (
    typeof input.requestId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      input.requestId,
    )
  )
    fields.push("requestId");
  let lines: CartLine[] = [];
  try {
    lines = parseShoppingLines(input.lines);
    if (!lines.length) fields.push("lines");
  } catch {
    fields.push("lines");
  }
  const name = text(contact.name, 100);
  const email = text(contact.email, 254);
  if (!name) fields.push("contact.name");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    fields.push("contact.email");
  const method = delivery.method;
  let address: CheckoutAddress | undefined;
  if (
    method !== "pickup" &&
    method !== "local_delivery" &&
    method !== "shipping"
  )
    fields.push("delivery.method");
  if (method === "local_delivery" || method === "shipping") {
    const raw = object(delivery.address);
    const line1 = text(raw.line1, 150);
    const line2 = text(raw.line2, 150, true);
    const city = text(raw.city, 100);
    const province = text(raw.province, 2)?.toUpperCase();
    const country = text(raw.country, 2)?.toUpperCase();
    const postalCode = text(raw.postalCode, 7)?.toUpperCase().replace(/ /g, "");
    if (!line1) fields.push("delivery.address.line1");
    if (line2 === null) fields.push("delivery.address.line2");
    if (!city) fields.push("delivery.address.city");
    if (!CANADIAN_REGIONS.includes(province as CanadianRegion))
      fields.push("delivery.address.province");
    if (country !== "CA") fields.push("delivery.address.country");
    if (
      !postalCode ||
      !/^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTVWXYZ]\d[ABCEGHJ-NPRSTVWXYZ]\d$/.test(
        postalCode,
      )
    )
      fields.push("delivery.address.postalCode");
    address = {
      line1: line1!,
      line2: line2!,
      city: city!,
      province: province as CanadianRegion,
      postalCode: postalCode!,
      country: "CA",
    };
  }
  if (fields.length) throw new CheckoutInputError(fields);
  return {
    contractVersion: CHECKOUT_CONTRACT_VERSION,
    requestId: input.requestId as string,
    lines,
    contact: { name: name!, email: email! },
    // Drop incidental address fields for pickup, and all unrecognized fields.
    delivery:
      method === "pickup"
        ? { method }
        : {
            method: method as "shipping" | "local_delivery",
            address: address!,
          },
  };
}

export type CheckoutQuote = Omit<TestQuote, "rulesVersion"> & {
  contractVersion: typeof CHECKOUT_CONTRACT_VERSION;
  requestId: string;
  rulesVersion: string;
  taxBasisPoints: number;
  taxBaseCents: number;
  delivery: DeliveryMethod;
};
