// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OwnerAllocationReleaseOperations } from "./owner-allocation-release-operations";
import type {
  OwnerAllocationReleaseDetail,
  OwnerAllocationReleaseInput,
} from "../../lib/commerce/owner-allocation-release";
const instanceId = "11111111-1111-4111-8111-111111111111",
  requestId = "22222222-2222-4222-8222-222222222222",
  orderId = "order-33333333-3333-4333-8333-333333333333";
const detail: OwnerAllocationReleaseDetail = {
  orderId,
  orderVersion: 5,
  fulfillment: "not_handed_over",
  refundState: "succeeded",
  released: false,
  canRelease: true,
  stockHash: "a".repeat(64),
  lines: [
    {
      position: 0,
      variantId: "fictional-necklace-gold",
      name: "Fictional necklace",
      sku: "FICTIONAL-GOLD",
      colour: "Gold",
      quantity: 1,
      onHand: 5,
      facebookReserved: 1,
      checkoutReserved: 0,
      allocated: 1,
    },
  ],
  history: [],
};
const original: OwnerAllocationReleaseInput = {
  requestId,
  orderId,
  expectedVersion: 5,
  expectedStockHash: "a".repeat(64),
  acknowledge: true,
};
const receipt = {
  testOnly: true,
  ...original,
  recordedAt: 1800000000000,
  result: "allocation_released",
  replayed: false,
};
const key = `commerce-owner-allocation-release-v1:${instanceId}:${orderId}`;
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
        <OwnerAllocationReleaseOperations
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
it("saves original identity before a single explicit whole-order release without caller quantities", async () => {
  send.mockImplementation(async (_url, init) => {
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(original);
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("expectedStockHash")).toBe(detail.stockHash);
    expect(form.has("quantity")).toBe(false);
    expect(form.has("operation")).toBe(false);
    expect(form.has("allocated")).toBe(false);
    return Response.json({ state: "recorded", receipt });
  });
  await render();
  expect(button("Release this refunded order’s stock")!.disabled).toBe(true);
  await confirm();
  await act(async () => {
    button("Release this refunded order’s stock")!.click();
    button("Release this refunded order’s stock")!.click();
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(button("Release this refunded order’s stock")).toBeUndefined();
  expect(document.body.textContent).toContain(
    "Physical stock was not increased",
  );
  expect(
    document.querySelector('a[href$="/release-allocation"]')?.textContent,
  ).toBe("Reload recorded stock status");
});
it("recovers only the original lookup after a lost response while writes are paused and stock has moved", async () => {
  send.mockRejectedValueOnce(Error("Lost response"));
  await render();
  await confirm();
  await act(async () => button("Release this refunded order’s stock")!.click());
  await act(async () => root.unmount());
  root = createRoot(document.querySelector("#root")!);
  await render({ ...detail, stockHash: "b".repeat(64) }, false);
  expect(send).toHaveBeenCalledTimes(1);
  expect(button("Release this refunded order’s stock")).toBeUndefined();
  send.mockResolvedValueOnce(
    Response.json({
      state: "recorded",
      receipt: { ...receipt, replayed: true },
    }),
  );
  await act(async () => button("Check saved release request")!.click());
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
    { state: "recorded", receipt: { ...receipt, result: "invented" } },
  ]) {
    send.mockResolvedValueOnce(Response.json(payload));
    await act(async () => button("Check saved release request")!.click());
    expect(sessionStorage.getItem(key)).toBe(JSON.stringify(original));
    expect(button("Release this refunded order’s stock")).toBeUndefined();
  }
});
it("does not offer release for handed-off, unconfirmed-refund or already released goods", async () => {
  for (const d of [
    { ...detail, fulfillment: "handed_over" as const, canRelease: false },
    { ...detail, refundState: "pending" as const, canRelease: false },
    { ...detail, released: true, canRelease: false },
  ]) {
    await render(d);
    expect(button("Release this refunded order’s stock")).toBeUndefined();
  }
  expect(send).not.toHaveBeenCalled();
});
it("blocks before dispatch when browser recovery storage is corrupt", async () => {
  sessionStorage.setItem(key, "broken");
  await render();
  expect(document.querySelector("fieldset")!.disabled).toBe(true);
  expect(send).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(key)).toBe("broken");
});
