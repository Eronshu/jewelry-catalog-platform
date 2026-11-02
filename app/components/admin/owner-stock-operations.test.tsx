// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OwnerStockOperations } from "./owner-stock-operations";
import type { OwnerStockDetail } from "../../lib/commerce/owner-stock";
const instanceId = "11111111-1111-4111-8111-111111111111",
  requestId = "22222222-2222-4222-8222-222222222222";
const detail: OwnerStockDetail = {
  variantVersion: 1,
  item: {
    variantId: "gold-1",
    productId: 1,
    productName: "Fictional necklace",
    sku: "GOLD-1",
    colour: "Gold-tone",
    sizeDescription: "Fictional single size",
    priceCents: 2500,
    active: true,
    productStatus: "available",
    onHand: 10,
    facebookReserved: 0,
    checkoutReserved: 2,
    allocated: 3,
    websiteAvailable: 5,
  },
};
const key = `commerce-owner-stock-v1:${instanceId}:gold-1`;
const original = {
  requestId,
  variantId: "gold-1",
  operation: "receive",
  quantity: 1,
  acknowledge: true,
  expected: {
    variantVersion: 1,
    onHand: 10,
    facebookReserved: 0,
    checkoutReserved: 2,
    allocated: 3,
  },
};
const receipt = {
  testOnly: true,
  requestId,
  variantId: "gold-1",
  operation: "receive",
  quantity: 1,
  recordedAt: 1,
  replayed: true,
  after: { ...original.expected, onHand: 11 },
};
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
async function render(canWrite = true, d = detail) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <OwnerStockOperations
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
it("requires explicit acknowledgement, preserves the request before dispatch and confirms one receipt", async () => {
  send.mockImplementation(async (_url, init) => {
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(original);
    expect(new URLSearchParams(String(init?.body)).get("intent")).toBe("apply");
    return Response.json({ state: "recorded", receipt });
  });
  await render();
  expect(button("Record test stock change").disabled).toBe(true);
  await confirm();
  await act(async () => {
    button("Record test stock change").click();
    button("Record test stock change").click();
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(document.body.textContent).toContain("Stock change recorded once");
  expect(document.body.textContent).toContain("checkout 2; allocated 3");
  expect(document.querySelector("fieldset")!.disabled).toBe(true);
});
it("keeps an uncertain original request across remount and never automatically resends", async () => {
  send.mockRejectedValueOnce(Error("Synthetic lost response"));
  await render();
  await confirm();
  await act(async () => button("Record test stock change").click());
  const saved = sessionStorage.getItem(key);
  expect(saved).not.toBeNull();
  expect(document.querySelector("fieldset")!.disabled).toBe(true);
  await act(async () => root.unmount());
  root = createRoot(document.querySelector("#root")!);
  await render(false);
  expect(send).toHaveBeenCalledTimes(1);
  expect(button("Retry same request").disabled).toBe(true);
  send.mockResolvedValueOnce(Response.json({ state: "recorded", receipt }));
  await act(async () => button("Check original request").click());
  const form = new URLSearchParams(String(send.mock.calls[1][1]?.body));
  expect(form.get("intent")).toBe("lookup");
  expect(form.get("requestId")).toBe(requestId);
  expect(form.get("onHand")).toBe("10");
  expect(document.body.textContent).toContain("Stock change recorded once");
});
it("absence and conflicting receipts cannot clear an uncertain request or permit a new key", async () => {
  sessionStorage.setItem(key, JSON.stringify(original));
  await render();
  expect(send).not.toHaveBeenCalled();
  send.mockResolvedValueOnce(Response.json({ state: "not_recorded" }));
  await act(async () => button("Check original request").click());
  expect(document.body.textContent).toContain("does not prove it failed");
  expect(sessionStorage.getItem(key)).toBe(JSON.stringify(original));
  send.mockResolvedValueOnce(
    Response.json({
      state: "recorded",
      receipt: { ...receipt, requestId: crypto.randomUUID() + "wrong" },
    }),
  );
  await act(async () => button("Check original request").click());
  expect(sessionStorage.getItem(key)).not.toBeNull();
  expect(document.body.textContent).toContain("result is unconfirmed");
});
it("blocks writes when saved storage is corrupt without overwriting it", async () => {
  sessionStorage.setItem(key, '{"broken":true}');
  await render();
  expect(document.querySelector("fieldset")!.disabled).toBe(true);
  expect(sessionStorage.getItem(key)).toBe('{"broken":true}');
  expect(send).not.toHaveBeenCalled();
});
it("blocks writes before dispatch when the original request cannot be stored", async () => {
  await render();
  vi.stubGlobal("sessionStorage", {
    getItem: () => null,
    setItem: () => {
      throw Error("Storage unavailable");
    },
  });
  await confirm();
  await act(async () => button("Record test stock change").click());
  expect(send).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("No stock request was sent");
});
it("limits Facebook controls to a single reserved unit and does not offer release of checkout allocations", async () => {
  await render();
  const select = document.querySelector(
    "#stock-operation",
  ) as unknown as HTMLSelectElement;
  await act(async () => {
    select.value = "fb_sale";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(document.body.textContent).toContain(
    "must be reserved before release or sale",
  );
  expect(button("Record test stock change").disabled).toBe(true);
  expect([...select.options].map((x) => x.value)).toEqual([
    "receive",
    "fb_reserve",
    "fb_release",
    "fb_sale",
  ]);
});
