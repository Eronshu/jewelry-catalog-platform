// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OwnerReturnOperations } from "./owner-return-operations";
import type {
  OwnerReturnDetail,
  OwnerReturnInput,
} from "../../lib/commerce/owner-return";
const instanceId = "11111111-1111-4111-8111-111111111111",
  requestId = "22222222-2222-4222-8222-222222222222",
  orderId = "order-33333333-3333-4333-8333-333333333333";
const detail: OwnerReturnDetail = {
  orderId,
  orderVersion: 5,
  delivery: "shipping",
  fulfillment: "handed_over",
  refundState: "succeeded",
  inspection: "not_recorded",
  stockState: "not_restored",
  canInspect: true,
  canRestock: false,
  stockHash: "a".repeat(64),
  lines: [
    {
      position: 0,
      variantId: "fictional-necklace-gold",
      name: "Fictional necklace",
      sku: "FICTIONAL-GOLD",
      colour: "Gold",
      quantity: 1,
      onHand: 4,
      facebookReserved: 1,
      checkoutReserved: 0,
      allocated: 0,
    },
  ],
  history: [],
};
const original: OwnerReturnInput = {
  requestId,
  orderId,
  operation: "inspect_sellable",
  expectedVersion: 5,
  expectedStockHash: "a".repeat(64),
  acknowledge: true,
};
const receipt = {
  testOnly: true,
  ...original,
  recordedAt: 1800000000000,
  result: "sellable_received",
  replayed: false,
};
const key = `commerce-owner-return-v1:${instanceId}:${orderId}`;
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
  [...document.querySelectorAll("button")].find((x) => x.textContent === name);
async function render(d = detail, canWrite = true) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <OwnerReturnOperations
          detail={d}
          instanceId={instanceId}
          canWrite={canWrite}
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
it("records physical inspection once and requires fresh reload before a separate restock", async () => {
  send.mockImplementation(async (_url, init) => {
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(original);
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("operation")).toBe("inspect_sellable");
    expect(form.has("quantity")).toBe(false);
    return Response.json({ state: "recorded", receipt });
  });
  await render();
  expect(button("Record received — sellable")!.disabled).toBe(true);
  await confirm();
  await act(async () => {
    button("Record received — sellable")!.click();
    button("Record received — sellable")!.click();
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(button("Restore inspected test stock")).toBeUndefined();
  expect(document.body.textContent).toContain(
    "Reload the recorded order before any next step",
  );
  expect(document.querySelector('a[href$="/return"]')?.textContent).toBe(
    "Reload recorded return status",
  );
});
it("restores only the inspected whole order using the server snapshot and explicit acknowledgement", async () => {
  await render({
    ...detail,
    inspection: "sellable",
    canInspect: false,
    canRestock: true,
  });
  expect(button("Record received — sellable")).toBeUndefined();
  expect(button("Restore inspected test stock")!.disabled).toBe(true);
  send.mockResolvedValue(
    Response.json({
      state: "recorded",
      receipt: { ...receipt, operation: "restock", result: "stock_restored" },
    }),
  );
  await confirm();
  await act(async () => button("Restore inspected test stock")!.click());
  const form = new URLSearchParams(String(send.mock.calls[0][1]?.body));
  expect(form.get("operation")).toBe("restock");
  expect(form.get("expectedStockHash")).toBe(detail.stockHash);
  expect(form.get("expectedVersion")).toBe("5");
  expect(form.has("onHand")).toBe(false);
  expect(document.body.textContent).toContain("Returned stock restored once");
});
it("recovers only the original lookup after a lost response while writes are paused and stock has moved", async () => {
  send.mockRejectedValueOnce(Error("Lost response"));
  await render();
  await confirm();
  await act(async () => button("Record received — sellable")!.click());
  await act(async () => root.unmount());
  root = createRoot(document.querySelector("#root")!);
  await render({ ...detail, stockHash: "b".repeat(64) }, false);
  expect(send).toHaveBeenCalledTimes(1);
  expect(button("Record received — sellable")).toBeUndefined();
  send.mockResolvedValueOnce(
    Response.json({
      state: "recorded",
      receipt: { ...receipt, replayed: true },
    }),
  );
  await act(async () => button("Check saved return request")!.click());
  const form = new URLSearchParams(String(send.mock.calls[1][1]?.body));
  expect(form.get("intent")).toBe("lookup");
  expect(form.get("requestId")).toBe(requestId);
  expect(form.get("expectedStockHash")).toBe(original.expectedStockHash);
  expect(sessionStorage.getItem(key)).toBeNull();
});
it("preserves the request on absent or mismatched recovery receipts", async () => {
  sessionStorage.setItem(key, JSON.stringify(original));
  await render();
  for (const payload of [
    { state: "not_recorded" },
    {
      state: "recorded",
      receipt: { ...receipt, expectedStockHash: "b".repeat(64) },
    },
    { state: "recorded", receipt: { ...receipt, result: "stock_restored" } },
  ]) {
    send.mockResolvedValueOnce(Response.json(payload));
    await act(async () => button("Check saved return request")!.click());
    expect(sessionStorage.getItem(key)).toBe(JSON.stringify(original));
    expect(button("Record received — sellable")).toBeUndefined();
  }
});
it("offers no physical return for unhanded stock and no restock for unsuitable or financially unconfirmed returns", async () => {
  await render({
    ...detail,
    fulfillment: "not_handed_over",
    canInspect: false,
  });
  expect(button("Record received — sellable")).toBeUndefined();
  expect(document.body.textContent).toContain(
    "Do not add the goods to physical stock again",
  );
  await render({ ...detail, inspection: "unsuitable", canInspect: false });
  expect(button("Restore inspected test stock")).toBeUndefined();
  expect(document.body.textContent).toContain("outside sellable stock");
  await render({
    ...detail,
    inspection: "sellable",
    refundState: "pending",
    canInspect: false,
    canRestock: false,
  });
  expect(button("Restore inspected test stock")).toBeUndefined();
  expect(document.body.textContent).toContain(
    "matching full refund is verified",
  );
  expect(send).not.toHaveBeenCalled();
});
it("blocks before dispatch when browser recovery storage is corrupt", async () => {
  sessionStorage.setItem(key, "broken");
  await render();
  expect(document.querySelector("fieldset")!.disabled).toBe(true);
  expect(send).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(key)).toBe("broken");
});
