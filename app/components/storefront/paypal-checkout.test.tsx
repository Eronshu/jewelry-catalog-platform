// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PayPalCheckout } from "./paypal-checkout";
import type { OwnedCheckoutOrder } from "../../lib/commerce/checkout-flow.server";
import type { OwnedPayPalPayment } from "../../lib/commerce/owned-paypal.server";
let host: HTMLDivElement,
  root: Root,
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const changed = vi.fn(),
  busy = vi.fn();
const order: OwnedCheckoutOrder = {
  id: "order-11111111-1111-4111-8111-111111111111",
  state: "pending_payment",
  paymentState: "processing",
  version: 2,
  reserveUntil: Date.now() + 600000,
  totalCents: 4400,
  subtotalCents: 2500,
  shippingCents: 1500,
  taxCents: 400,
  delivery: "shipping",
  lines: [],
};
const open: OwnedPayPalPayment = {
  state: "open",
  approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=FICTIONAL123",
  canStart: false,
  canQuery: true,
  canCapture: false,
};
const approved: OwnedPayPalPayment = {
  state: "approved",
  canStart: false,
  canQuery: true,
  canCapture: true,
};
function button(text: string) {
  return [...host.querySelectorAll("button")].find((x) =>
    x.textContent?.includes(text),
  );
}
async function click(text: string) {
  await act(async () => button(text)!.click());
}
async function render(initial = open, returned = false) {
  await act(async () =>
    root.render(
      <PayPalCheckout
        order={order}
        initial={initial}
        csrfToken={"c".repeat(64)}
        returned={returned}
        onOrderChanged={changed}
        onBusyChanged={busy}
      />,
    ),
  );
}
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  changed.mockClear();
  busy.mockClear();
  fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
describe("PayPal approval and explicit capture UI", () => {
  it("does not treat returning as payment or auto capture; approval only enables an explicit capture", async () => {
    await render(open, true);
    expect(fetcher).not.toHaveBeenCalled();
    expect(host.textContent).toContain("do not prove payment");
    expect(button("Complete PayPal")).toBeUndefined();
    expect(host.querySelector("a")?.href).toBe(open.approvalUrl);
    fetcher.mockResolvedValueOnce(Response.json({ paypal: approved, order }));
    await click("Check PayPal");
    expect(
      (fetcher.mock.calls[0][1]!.body as URLSearchParams).get("operation"),
    ).toBe("query");
    expect(button("Complete PayPal")).toBeDefined();
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ paymentState: "processing" }),
    );
    fetcher.mockResolvedValueOnce(
      Response.json({
        paypal: {
          ...approved,
          state: "paid",
          canCapture: false,
          canQuery: false,
        },
        order: {
          ...order,
          state: "confirmed",
          paymentState: "succeeded",
          version: 3,
        },
      }),
    );
    await click("Complete PayPal");
    expect(
      (fetcher.mock.calls[1][1]!.body as URLSearchParams).get("operation"),
    ).toBe("capture");
    expect(host.textContent).toContain("verified and items allocated");
  });
  it("blocks duplicate capture and changes an uncertain result to query-only without losing the original request key", async () => {
    let reject!: (error: Error) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await render(approved);
    await act(async () => {
      button("Complete PayPal")!.click();
      button("Complete PayPal")!.click();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(button("Completing test")?.disabled).toBe(true);
    await act(async () => reject(new Error("Lost capture response")));
    expect(button("Complete PayPal")).toBeUndefined();
    expect(document.activeElement).toBe(host.querySelector('[role="alert"]'));
    fetcher.mockResolvedValueOnce(
      Response.json({
        paypal: { ...approved, state: "checking", canCapture: false },
        order,
      }),
    );
    await click("Check PayPal");
    const first = fetcher.mock.calls[0][1]!.body as URLSearchParams,
      second = fetcher.mock.calls[1][1]!.body as URLSearchParams;
    expect(second.get("requestId")).toBe(first.get("requestId"));
    expect(second.get("operation")).toBe("query");
  });
  it.each([
    "https://www.paypal.com/checkoutnow",
    "https://www.sandbox.paypal.com.evil.example/pay",
    "https://user:password@www.sandbox.paypal.com/checkoutnow",
  ])("never links to %s", async (approvalUrl) => {
    await render({ ...open, approvalUrl });
    expect(host.querySelector("a")).toBeNull();
  });
});
