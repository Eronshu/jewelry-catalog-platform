// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StripeCheckout } from "./stripe-checkout";
import type { OwnedCheckoutOrder } from "../../lib/commerce/checkout-flow.server";
import type { OwnedStripePayment } from "../../lib/commerce/owned-stripe.server";
let root: Root, host: HTMLDivElement;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const changed = vi.fn(),
  busy = vi.fn();
const order: OwnedCheckoutOrder = {
  id: "order-11111111-1111-4111-8111-111111111111",
  state: "pending_payment",
  paymentState: "not_started",
  version: 1,
  reserveUntil: Date.now() + 600000,
  totalCents: 4400,
  subtotalCents: 2500,
  shippingCents: 1500,
  taxCents: 400,
  delivery: "shipping",
  lines: [
    {
      name: "Fictional necklace",
      colour: "Gold-tone",
      quantity: 1,
      lineTotalCents: 2500,
    },
  ],
};
const initial: OwnedStripePayment = {
  state: "not_started",
  canStart: true,
  canQuery: false,
};
const open: OwnedStripePayment = {
  state: "open",
  canStart: false,
  canQuery: true,
  hostedUrl: "https://checkout.stripe.com/c/pay/fictional",
};
function button(label: string) {
  return [...host.querySelectorAll("button")].find((x) =>
    x.textContent?.includes(label),
  );
}
async function click(label: string) {
  await act(async () => button(label)!.click());
}
async function render(payment = initial, returned = false) {
  await act(async () =>
    root.render(
      <StripeCheckout
        order={order}
        initial={payment}
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
describe("private Stripe hosted test checkout", () => {
  it("starts once, presents only the same hosted payment and keeps provider results separate from the order", async () => {
    let resolve!: (value: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render();
    await act(async () => {
      button("Pay with")!.click();
      button("Pay with")!.click();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(button("Preparing Stripe")?.disabled).toBe(true);
    const params = fetcher.mock.calls[0][1]!.body as URLSearchParams;
    expect([...params.keys()].sort()).toEqual([
      "csrf",
      "expectedVersion",
      "operation",
      "requestId",
    ]);
    expect(params.get("operation")).toBe("start");
    await act(async () =>
      resolve(
        Response.json({
          stripe: open,
          order: { ...order, paymentState: "processing", version: 2 },
        }),
      ),
    );
    const link = host.querySelector("a")!;
    expect(link.href).toBe(open.hostedUrl);
    expect(link.referrerPolicy).toBe("no-referrer");
    expect(button("Pay with")).toBeUndefined();
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ paymentState: "processing" }),
    );
    expect(host.textContent).not.toContain("payment verified");
  });
  it("does not treat a return as paid or query automatically; explicit query shows verified allocation", async () => {
    await render(open, true);
    expect(fetcher).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Returning does not prove payment");
    fetcher.mockResolvedValueOnce(
      Response.json({
        stripe: { state: "paid", canStart: false, canQuery: false },
        order: {
          ...order,
          state: "confirmed",
          paymentState: "succeeded",
          version: 3,
        },
      }),
    );
    await click("Check payment");
    expect(
      (fetcher.mock.calls[0][1]!.body as URLSearchParams).get("operation"),
    ).toBe("query");
    expect(host.textContent).toContain("payment verified and items allocated");
    expect(host.querySelector("a")).toBeNull();
    expect(button("Check payment")).toBeUndefined();
  });
  it("turns a lost start response into query-only recovery with the original browser request key", async () => {
    fetcher.mockRejectedValueOnce(new Error("lost response"));
    await render();
    await click("Pay with");
    expect(document.activeElement).toBe(host.querySelector('[role="alert"]'));
    expect(button("Pay with")).toBeUndefined();
    fetcher.mockResolvedValueOnce(
      Response.json({
        stripe: { state: "review_required", canStart: false, canQuery: false },
        order: { ...order, paymentState: "processing", version: 2 },
      }),
    );
    await click("Check payment");
    const first = fetcher.mock.calls[0][1]!.body as URLSearchParams;
    const retry = fetcher.mock.calls[1][1]!.body as URLSearchParams;
    expect(retry.get("requestId")).toBe(first.get("requestId"));
    expect(retry.get("operation")).toBe("query");
    expect(host.textContent).toContain("needs review");
  });
  it.each([
    "javascript:alert(1)",
    "https://checkout.stripe.com.evil.example/pay",
    "https://user:password@checkout.stripe.com/pay",
  ])("never links to %s", async (hostedUrl) => {
    await render({ ...open, hostedUrl });
    expect(host.querySelector("a")).toBeNull();
  });
});
