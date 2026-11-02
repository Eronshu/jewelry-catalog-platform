// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OwnerRefundOperations } from "./owner-refund-operations";
import type { OwnerRefundDetail } from "../../lib/commerce/owner-refund";
const instanceId = "11111111-1111-4111-8111-111111111111",
  requestId = "22222222-2222-4222-8222-222222222222",
  orderId = "order-33333333-3333-4333-8333-333333333333";
const detail: OwnerRefundDetail = {
  orderId,
  orderVersion: 3,
  requestVersion: null,
  amountCents: 4400,
  refundedCents: 0,
  provider: "stripe",
  state: "not_started",
  requestId: null,
  canStart: true,
  canQuery: false,
};
const original = { requestId, orderId, expectedVersion: 3, acknowledge: true };
const receipt = {
  testOnly: true,
  requestId,
  orderId,
  state: "pending",
  amountCents: 4400,
  refundedCents: 0,
};
const key = `commerce-owner-refund-v1:${instanceId}:${orderId}`;
let root: Root;
const send = vi.fn<typeof fetch>();
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.querySelector("#root")!);
  sessionStorage.clear();
  send.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(crypto, "randomUUID").mockReturnValue(requestId);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const button = (name: string) =>
  [...document.querySelectorAll("button")].find((x) => x.textContent === name)!;
async function render(d = detail, canWrite = true, canQuery = true) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <OwnerRefundOperations
          detail={d}
          instanceId={instanceId}
          canWrite={canWrite}
          canQuery={canQuery}
          transport={send}
        />
      ),
    },
  ]);
  await act(async () => root.render(<RouterProvider router={router} />));
}
async function confirm() {
  await act(async () =>
    (
      document.querySelector('input[type="checkbox"]') as HTMLInputElement
    ).click(),
  );
}
it("requires full-amount acknowledgement and stores the original request before a single start", async () => {
  send.mockImplementation(async (_url, init) => {
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(original);
    expect(new URLSearchParams(String(init?.body)).get("intent")).toBe("start");
    return Response.json({ state: "recorded", receipt });
  });
  await render();
  expect(button("Refund full test amount").disabled).toBe(true);
  await confirm();
  await act(async () => {
    button("Refund full test amount").click();
    button("Refund full test amount").click();
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(key)).toBe(JSON.stringify(original));
  expect(document.body.textContent).toContain("Refund pending with Stripe");
  expect(document.body.textContent).toContain("Stock has not been returned");
  expect(button("Refund full test amount")).toBeUndefined();
});
it("never re-starts an uncertain refund on remount and queries the original while writes are paused", async () => {
  send.mockRejectedValueOnce(Error("Lost response"));
  await render();
  await confirm();
  await act(async () => button("Refund full test amount").click());
  await act(async () => root.unmount());
  root = createRoot(document.querySelector("#root")!);
  await render(detail, false);
  expect(send).toHaveBeenCalledTimes(1);
  send.mockResolvedValueOnce(
    Response.json({
      state: "recorded",
      receipt: { ...receipt, state: "succeeded", refundedCents: 4400 },
    }),
  );
  await act(async () => button("Check Stripe refund status").click());
  const form = new URLSearchParams(String(send.mock.calls[1][1]?.body));
  expect(form.get("intent")).toBe("query");
  expect(form.get("requestId")).toBe(requestId);
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(document.body.textContent).toContain("Full test refund verified");
});
it("recovers only a query from the server's original version across devices, never a new start", async () => {
  await render(
    {
      ...detail,
      state: "prepared",
      requestId,
      requestVersion: 3,
      orderVersion: 9,
      canStart: false,
      canQuery: true,
    },
    false,
  );
  expect(send).not.toHaveBeenCalled();
  expect(button("Refund full test amount")).toBeUndefined();
  send.mockResolvedValueOnce(Response.json({ state: "recorded", receipt }));
  await act(async () => button("Check Stripe refund status").click());
  const form = new URLSearchParams(String(send.mock.calls[0][1]?.body));
  expect(form.get("expectedVersion")).toBe("3");
  expect(form.get("intent")).toBe("query");
});
it("does not treat a missing, mismatched or partial-success receipt as completion", async () => {
  sessionStorage.setItem(key, JSON.stringify(original));
  await render();
  send.mockResolvedValueOnce(Response.json({ state: "not_recorded" }));
  await act(async () => button("Check saved request").click());
  expect(document.body.textContent).toContain("does not prove failure");
  for (const r of [
    { ...receipt, requestId: "wrong" },
    { ...receipt, state: "succeeded", refundedCents: 1 },
  ]) {
    send.mockResolvedValueOnce(
      Response.json({ state: "recorded", receipt: r }),
    );
    await act(async () => button("Check saved request").click());
    expect(sessionStorage.getItem(key)).toBe(JSON.stringify(original));
  }
});
it("blocks before dispatch if storage is corrupt or cannot preserve the request", async () => {
  sessionStorage.setItem(key, "broken");
  await render();
  expect(document.querySelector("fieldset")!.disabled).toBe(true);
  expect(send).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(key)).toBe("broken");
});
it("shows no refund start for PayPal, confirmed refunds or ineligible orders", async () => {
  await render({ ...detail, provider: "paypal", canStart: false });
  expect(button("Refund full test amount")).toBeUndefined();
  expect(document.body.textContent).toContain("no eligible Stripe capture");
  await render({
    ...detail,
    state: "succeeded",
    requestId,
    requestVersion: 3,
    canStart: false,
    refundedCents: 4400,
  });
  expect(button("Refund full test amount")).toBeUndefined();
  expect(document.body.textContent).toContain("Full test refund verified");
});
