// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { ShoppingCartProvider } from "./shopping-cart-context";
import { CheckoutConfirmation } from "./checkout-confirmation";
import { OwnedOrderView } from "../../routes/checkout-order";
import { SHOPPING_CART_KEY } from "../../lib/commerce/shopping-cart";
import type { OwnedCheckoutOrder } from "../../lib/commerce/checkout-flow.server";
let root: Root, host: HTMLDivElement;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const quote = {
  quoteId: "11111111-1111-4111-8111-111111111111",
  expiresAt: Date.now() + 600000,
  lines: [
    {
      name: "Fictional necklace",
      colour: "Gold-tone",
      quantity: 1,
      lineTotalCents: 2500,
    },
  ],
  subtotalCents: 2500,
  shippingCents: 1500,
  taxCents: 400,
  totalCents: 4400,
};
const order: OwnedCheckoutOrder = {
  ...quote,
  id: "order-11111111-1111-4111-8111-111111111111",
  state: "pending_payment",
  paymentState: "not_started",
  version: 1,
  reserveUntil: quote.expiresAt,
  delivery: "shipping",
};
function button(text: string) {
  return [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(text),
  )!;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function mount(status = false) {
  const router = createMemoryRouter(
    [
      {
        path: "/checkout/confirm",
        element: (
          <ShoppingCartProvider>
            <CheckoutConfirmation
              data={{ csrfToken: "c".repeat(64), pending: [], canCreate: true }}
            />
          </ShoppingCartProvider>
        ),
      },
      {
        path: "/checkout/orders/:orderId",
        element: status ? (
          <OwnedOrderView
            order={order}
            csrfToken={"c".repeat(64)}
            refresh={() => {}}
          />
        ) : (
          <p>Private order page</p>
        ),
      },
    ],
    {
      initialEntries: [
        status ? `/checkout/orders/${order.id}` : "/checkout/confirm",
      ],
    },
  );
  await act(async () => root.render(<RouterProvider router={router} />));
  return router;
}
beforeEach(() => {
  host = document.createElement("div");
  host.style.width = "390px";
  document.body.appendChild(host);
  root = createRoot(host);
  window.localStorage.setItem(
    SHOPPING_CART_KEY,
    JSON.stringify([{ variantId: "test-gold", quantity: 1 }]),
  );
  fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});
describe("final fictional order confirmation and private status UI", () => {
  it("requires explicit final-total agreement, invalidates changed selection and prevents duplicate submit", async () => {
    fetcher.mockResolvedValueOnce(Response.json({ quote }));
    await mount();
    expect(host.textContent).toContain("not saved or carried forward");
    await click(button("Review final"));
    expect(host.textContent).toContain("44.00");
    expect(button("Create unpaid").disabled).toBe(true);
    const consent = host.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    consent.focus();
    expect(document.activeElement).toBe(consent);
    await click(consent);
    expect(button("Create unpaid").disabled).toBe(false);
    const method = host.querySelector(
      "#fixture-delivery",
    ) as unknown as HTMLSelectElement;
    await act(async () => {
      method.value = "pickup";
      method.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();
    fetcher.mockResolvedValueOnce(Response.json({ quote }));
    await click(button("Review final"));
    await click(
      host.querySelector<HTMLInputElement>('input[type="checkbox"]')!,
    );
    let resolve!: (response: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await act(async () => {
      button("Create unpaid").click();
      button("Create unpaid").click();
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(
      Array(3).fill("/checkout/commands"),
    );
    expect(button("Create unpaid").disabled).toBe(true);
    const form = fetcher.mock.calls[2][1]!.body as URLSearchParams;
    expect(form.get("acknowledge")).toBe("yes");
    await act(async () => resolve(Response.json({ orderId: order.id })));
    expect(host.textContent).toContain("Private order page");
  });
  it("focuses uncertain errors and retries original acceptance/create keys without clearing the cart", async () => {
    fetcher
      .mockResolvedValueOnce(Response.json({ quote }))
      .mockRejectedValueOnce(new Error("Lost response"))
      .mockResolvedValueOnce(Response.json({ orderId: order.id }));
    await mount();
    await click(button("Review final"));
    await click(
      host.querySelector<HTMLInputElement>('input[type="checkbox"]')!,
    );
    await click(button("Create unpaid"));
    expect(document.activeElement).toBe(host.querySelector('[role="alert"]'));
    expect(button("Review final").disabled).toBe(true);
    expect(window.localStorage.getItem(SHOPPING_CART_KEY)).toContain(
      "test-gold",
    );
    await click(button("Retry the same"));
    const first = fetcher.mock.calls[1][1]!.body as URLSearchParams;
    const retry = fetcher.mock.calls[2][1]!.body as URLSearchParams;
    expect(retry.toString()).toBe(first.toString());
  });
  it("shows item amounts/delivery and changes private status after a single cancellation", async () => {
    fetcher.mockResolvedValueOnce(
      Response.json({ order: { ...order, state: "cancelled", version: 2 } }),
    );
    await mount(true);
    expect(host.textContent).toContain("Canadian shipping");
    expect(host.textContent).toContain("25.00");
    expect(host.textContent).toContain("No payment is available or configured");
    await click(button("Cancel unpaid"));
    expect(host.textContent).toContain("Test order cancelled");
    expect(host.textContent).toContain("reservation has been released");
    expect(button("Cancel unpaid")).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(
      `/checkout/orders/${order.id}/cancel`,
    );
  });
});
