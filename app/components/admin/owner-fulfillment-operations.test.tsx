// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OwnerFulfillmentOperations } from "./owner-fulfillment-operations";
import type { OwnerFulfillmentDetail } from "../../lib/commerce/owner-fulfillment";
const instanceId = "11111111-1111-4111-8111-111111111111",
  requestId = "22222222-2222-4222-8222-222222222222",
  orderId = "order-33333333-3333-4333-8333-333333333333";
const detail: OwnerFulfillmentDetail = {
  orderId,
  version: 3,
  delivery: "shipping",
  state: "ready_to_pack",
  canPack: true,
  canHandoff: false,
  history: [],
};
const original = {
  requestId,
  orderId,
  operation: "pack",
  expectedVersion: 3,
  acknowledge: true,
};
const receipt = {
  testOnly: true,
  requestId,
  orderId,
  operation: "pack",
  recordedAt: 1,
  replayed: false,
  resultingVersion: 4,
};
const key = `commerce-owner-fulfillment-v1:${instanceId}:${orderId}`;
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
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  )!;
async function render(d = detail, canWrite = true) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <OwnerFulfillmentOperations
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
it("requires acknowledgement, saves before dispatch and records only one pack despite double click", async () => {
  send.mockImplementation(async (_url, init) => {
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(original);
    expect(new URLSearchParams(String(init?.body)).get("operation")).toBe(
      "pack",
    );
    return Response.json({ state: "recorded", receipt });
  });
  await render();
  expect(button("Mark the full order packed").disabled).toBe(true);
  await confirm();
  await act(async () => {
    button("Mark the full order packed").click();
    button("Mark the full order packed").click();
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(document.body.textContent).toContain("Action recorded once");
  expect(document.querySelector("fieldset")!.disabled).toBe(true);
});
it("recovers an uncertain original request while new writes are paused, without auto resending", async () => {
  send.mockRejectedValueOnce(Error("Synthetic lost response"));
  await render();
  await confirm();
  await act(async () => button("Mark the full order packed").click());
  expect(sessionStorage.getItem(key)).not.toBeNull();
  await act(async () => root.unmount());
  root = createRoot(document.querySelector("#root")!);
  await render(detail, false);
  expect(send).toHaveBeenCalledTimes(1);
  expect(button("Retry same request").disabled).toBe(true);
  send.mockResolvedValueOnce(
    Response.json({
      state: "recorded",
      receipt: { ...receipt, replayed: true },
    }),
  );
  await act(async () => button("Check original request").click());
  const form = new URLSearchParams(String(send.mock.calls[1][1]?.body));
  expect(form.get("intent")).toBe("lookup");
  expect(form.get("expectedVersion")).toBe("3");
  expect(form.get("requestId")).toBe(requestId);
  expect(sessionStorage.getItem(key)).toBeNull();
});
it("absence or a mismatched receipt cannot clear the request or authorize another handoff", async () => {
  sessionStorage.setItem(key, JSON.stringify(original));
  await render();
  expect(send).not.toHaveBeenCalled();
  send.mockResolvedValueOnce(Response.json({ state: "not_recorded" }));
  await act(async () => button("Check original request").click());
  expect(document.body.textContent).toContain("does not prove failure");
  send.mockResolvedValueOnce(
    Response.json({
      state: "recorded",
      receipt: { ...receipt, operation: "ship" },
    }),
  );
  await act(async () => button("Check original request").click());
  expect(sessionStorage.getItem(key)).toBe(JSON.stringify(original));
  expect(document.body.textContent).toContain("result is unconfirmed");
});
it("blocks dispatch if storage is corrupt or cannot preserve the request", async () => {
  sessionStorage.setItem(key, "broken");
  await render();
  expect(document.querySelector("fieldset")!.disabled).toBe(true);
  expect(sessionStorage.getItem(key)).toBe("broken");
  expect(send).not.toHaveBeenCalled();
});
it("does not send a handoff when storage cannot be written", async () => {
  await render();
  vi.stubGlobal("sessionStorage", {
    getItem: () => null,
    setItem: () => {
      throw Error();
    },
  });
  await confirm();
  await act(async () => button("Mark the full order packed").click());
  expect(send).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("No action was sent");
});
it.each([
  ["pickup", "collect", "Record customer pickup"],
  ["local_delivery", "deliver", "Record local delivery completed"],
  ["shipping", "ship", "Record handoff to the postal carrier"],
])(
  "offers only the frozen %s handoff after packing",
  async (delivery, operation, label) => {
    await render({
      ...detail,
      delivery,
      state: "packed",
      canPack: false,
      canHandoff: true,
    });
    await confirm();
    send.mockResolvedValueOnce(
      Response.json({ state: "recorded", receipt: { ...receipt, operation } }),
    );
    await act(async () => button(label).click());
    expect(
      new URLSearchParams(String(send.mock.calls[0][1]?.body)).get("operation"),
    ).toBe(operation);
    if (delivery === "shipping")
      expect(document.body.textContent).toContain("does not prove delivery");
  },
);
it("exposes no packing or handoff controls for blocked and completed orders", async () => {
  await render({
    ...detail,
    state: "blocked",
    canPack: false,
    canHandoff: false,
  });
  expect(document.querySelector("fieldset")).toBeNull();
  expect(document.body.textContent).toContain("Do not pack or hand over goods");
  await render({
    ...detail,
    state: "handed_over",
    canPack: false,
    canHandoff: false,
    history: [{ ...receipt, testOnly: true, operation: "pack" }],
  });
  expect(document.querySelector("fieldset")).toBeNull();
  expect(document.body.textContent).toContain("Handoff recorded");
  expect(
    document.querySelector('section[aria-label="Fulfillment history"] time'),
  ).not.toBeNull();
});
