import { describe, expect, it } from "vitest";
import {
  CHECKOUT_CONTRACT_VERSION,
  CheckoutInputError,
  parseCheckoutInput,
} from "./checkout";

// Fictional identity/address only, not a real shipping destination.
export const checkoutFixture = () => ({
  contractVersion: CHECKOUT_CONTRACT_VERSION,
  requestId: "11111111-1111-4111-8111-111111111111",
  lines: [{ variantId: "test-gold", quantity: 1 }],
  contact: { name: "Fictional Customer", email: "customer@example.invalid" },
  delivery: {
    method: "shipping",
    address: {
      line1: "100 Fictional Test Street",
      city: "Test City",
      province: "ON",
      postalCode: "K1A 0B1",
      country: "CA",
    },
  },
});
describe("transient local checkout input", () => {
  it("normalizes bounded fields without mutating input; drops unknown data", () => {
    const input = checkoutFixture();
    input.contact.name = "  Fictional Customer  ";
    input.delivery.address.province = "on";
    input.delivery.address.postalCode = "k1a 0b1";
    const normalized = parseCheckoutInput({
      ...input,
      totalCents: 1,
      lines: [{ ...input.lines[0], email: "secret", priceCents: 1 }],
    });
    expect(normalized.contact.name).toBe("Fictional Customer");
    expect(normalized.delivery).toMatchObject({
      address: { province: "ON", postalCode: "K1A0B1", line2: "" },
    });
    expect(normalized.lines).toEqual([{ variantId: "test-gold", quantity: 1 }]);
    expect(normalized).not.toHaveProperty("totalCents");
    expect(input.contact.name).toBe("  Fictional Customer  ");
  });
  it("pickup requires no mailing address and discards an incidental one", () => {
    for (const delivery of [
      { method: "pickup" },
      { method: "pickup", address: { secret: "discard me" } },
    ]) {
      expect(
        parseCheckoutInput({ ...checkoutFixture(), delivery }).delivery,
      ).toEqual({ method: "pickup" });
    }
  });
  it("collects field paths without echoing invalid values", () => {
    try {
      parseCheckoutInput({
        ...checkoutFixture(),
        contact: { name: "", email: "private-invalid-value" },
        delivery: { method: "shipping" },
      });
      expect.fail("must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(CheckoutInputError);
      expect((error as CheckoutInputError).fields).toEqual(
        expect.arrayContaining([
          "contact.name",
          "contact.email",
          "delivery.address.line1",
          "delivery.address.country",
        ]),
      );
      expect(JSON.stringify(error)).not.toContain("private-invalid-value");
    }
  });
  it.each([
    null,
    [],
    {},
    { ...checkoutFixture(), contractVersion: "live" },
    { ...checkoutFixture(), requestId: "customer@example.invalid" },
    { ...checkoutFixture(), lines: [] },
    { ...checkoutFixture(), lines: [{ variantId: "v", quantity: 1.5 }] },
    {
      ...checkoutFixture(),
      lines: Array(2).fill({ variantId: "v", quantity: 1 }),
    },
    {
      ...checkoutFixture(),
      contact: { name: "x".repeat(101), email: "c@example.invalid" },
    },
    {
      ...checkoutFixture(),
      contact: { name: "Test\nCustomer", email: "c@example.invalid" },
    },
    { ...checkoutFixture(), delivery: { method: "supplier_direct" } },
  ])("rejects malformed input %j", (input) =>
    expect(() => parseCheckoutInput(input)).toThrow(CheckoutInputError),
  );
  it.each([
    { line1: "" },
    { line2: "x".repeat(151) },
    { city: "" },
    { country: "US" },
    { province: "XX" },
    { postalCode: "D1A0B1" },
    { postalCode: "K1A\n0B1" },
    { postalCode: "12345" },
  ])("rejects invalid delivery fields %j", (change) => {
    const input = checkoutFixture();
    Object.assign(input.delivery.address, change);
    expect(() => parseCheckoutInput(input)).toThrow(CheckoutInputError);
  });
});
