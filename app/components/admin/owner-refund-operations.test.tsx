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
  testOnly: true as const,
  requestId,
  orderId,
  state: "pending" as const,
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
it("shows no refund start for missing captures, confirmed refunds or ineligible orders", async () => {
  await render({ ...detail, provider: null, canStart: false });
  expect(button("Refund full test amount")).toBeUndefined();
  expect(document.body.textContent).toContain("no eligible online capture");
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

it("uses the original PayPal payment and the same one-shot request recovery", async () => {
  send.mockResolvedValue(Response.json({ state: "recorded", receipt }));
  await render({ ...detail, provider: "paypal" });
  expect(document.body.textContent).toContain("entire original PayPal capture");
  await confirm();
  await act(async () => {
    button("Refund full test amount").click();
    button("Refund full test amount").click();
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("Refund pending with PayPal");
  expect(button("Check PayPal refund status")).toBeDefined();
  expect(button("Check Stripe refund status")).toBeUndefined();
  send.mockResolvedValueOnce(
    Response.json({
      state: "recorded",
      receipt: { ...receipt, state: "succeeded", refundedCents: 4400 },
    }),
  );
  await act(async () => button("Check PayPal refund status").click());
  const form = new URLSearchParams(String(send.mock.calls[1][1]?.body));
  expect(form.get("intent")).toBe("query");
  expect(form.get("requestId")).toBe(requestId);
  expect(form.has("provider")).toBe(false);
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(document.body.textContent).toContain("Full test refund verified");
});

const partialDetail: OwnerRefundDetail = {
  ...detail,
  canStart: false,
  canStartPartial: true,
  state: "partially_refunded",
  refundedCents: 1500,
  remainingCents: 2900,
  requestId: "44444444-4444-4444-8444-444444444444",
  requestVersion: 3,
  currentRequestRefundCents: 1500,
  currentRequestPriorRefundedCents: 0,
  history: [
    {
      ...receipt,
      requestId: "44444444-4444-4444-8444-444444444444",
      state: "succeeded",
      refundedCents: 1500,
      refundCents: 1500,
      expectedRefundedCents: 0,
    },
  ],
};
async function enterAmount(value: string) {
  const input = document.querySelector(
    'input[type="text"]',
  ) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
it("allows an exact remaining Stripe refund after a verified partial, preserving requested amount and prior budget before dispatch", async () => {
  const expected = {
    ...original,
    refundCents: 2900,
    expectedRefundedCents: 1500,
  };
  send.mockImplementation(async (_url, init) => {
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(expected);
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("refundCents")).toBe("2900");
    expect(form.get("expectedRefundedCents")).toBe("1500");
    return Response.json({
      state: "recorded",
      receipt: {
        ...receipt,
        state: "succeeded",
        refundedCents: 2900,
        refundCents: 2900,
        expectedRefundedCents: 1500,
      },
    });
  });
  await render(partialDetail);
  expect(document.body.textContent).toContain("Partial test refund verified");
  expect(
    document.querySelector('[aria-label="Recorded test refunds"]')!.textContent,
  ).toContain("15.00 CAD requested");
  expect(button("Check saved request")).toBeUndefined();
  await confirm();
  await act(async () => {
    button("Refund test amount").click();
    button("Refund test amount").click();
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(document.querySelectorAll("dd")[2].textContent).toContain("44.00");
  expect(document.querySelectorAll("dd")[3].textContent).toContain("0.00");
  expect(button("Refund test amount")).toBeUndefined();
  expect(document.body.textContent).toContain("Reload verified refund status");
});
it("rejects fractional cents, exponent, negative, zero and over-budget amounts and resets confirmation when amount changes", async () => {
  await render(partialDetail);
  await confirm();
  for (const invalid of ["1.001", "1e1", "-1", "0", "29.01", " 1.00"]) {
    await enterAmount(invalid);
    expect(
      (document.querySelector('input[type="checkbox"]') as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(button("Refund test amount").disabled).toBe(true);
    await confirm();
    expect(button("Refund test amount").disabled).toBe(true);
  }
  await enterAmount("0.01");
  expect(button("Refund test amount").disabled).toBe(true);
  await confirm();
  send.mockRejectedValueOnce(Error("lost"));
  await act(async () => button("Refund test amount").click());
  expect(JSON.parse(sessionStorage.getItem(key)!)).toMatchObject({
    refundCents: 1,
    expectedRefundedCents: 1500,
  });
  expect(send).toHaveBeenCalledOnce();
});
it("recovers the persisted v2 amount and original budget across devices while writes are paused", async () => {
  await render(
    {
      ...partialDetail,
      state: "pending",
      canStartPartial: false,
      canQuery: true,
      orderVersion: 12,
      requestId,
      currentRequestRefundCents: 500,
      currentRequestPriorRefundedCents: 1500,
    },
    false,
  );
  send.mockResolvedValueOnce(
    Response.json({
      state: "recorded",
      receipt: { ...receipt, refundCents: 500, expectedRefundedCents: 1500 },
    }),
  );
  await act(async () => button("Check Stripe refund status").click());
  expect(
    Object.fromEntries(
      new URLSearchParams(String(send.mock.calls[0][1]?.body)),
    ),
  ).toMatchObject({
    intent: "query",
    expectedVersion: "3",
    refundCents: "500",
    expectedRefundedCents: "1500",
  });
  expect(document.querySelectorAll("dd")[2].textContent).toContain("15.00");
  expect(button("Refund test amount")).toBeUndefined();
});
it("does not clear the original partial request for a mismatched budget or a non-success receipt claiming money", async () => {
  const input = { ...original, refundCents: 500, expectedRefundedCents: 1500 };
  sessionStorage.setItem(key, JSON.stringify(input));
  await render(
    { ...partialDetail, state: "pending", canStartPartial: false, requestId },
    false,
  );
  for (const r of [
    {
      ...receipt,
      refundCents: 500,
      expectedRefundedCents: 0,
      state: "succeeded",
      refundedCents: 500,
    },
    {
      ...receipt,
      refundCents: 500,
      expectedRefundedCents: 1500,
      refundedCents: 500,
    },
  ]) {
    send.mockResolvedValueOnce(
      Response.json({ state: "recorded", receipt: r }),
    );
    await act(async () => button("Check saved request").click());
    expect(sessionStorage.getItem(key)).toBe(JSON.stringify(input));
    expect(document.querySelectorAll("dd")[2].textContent).toContain("15.00");
  }
});

it("preserves a stale saved request without allowing its older success to replace the current unresolved refund", async () => {
  const older = { ...original, refundCents: 1500, expectedRefundedCents: 0 };
  sessionStorage.setItem(key, JSON.stringify(older));
  const nextRequest = "55555555-5555-4555-8555-555555555555";
  await render({
    ...partialDetail,
    state: "pending",
    canStartPartial: false,
    requestId: nextRequest,
    canQuery: true,
    currentRequestRefundCents: 500,
    currentRequestPriorRefundedCents: 1500,
    history: [
      {
        ...receipt,
        requestId,
        state: "succeeded",
        refundCents: 1500,
        expectedRefundedCents: 0,
        refundedCents: 1500,
      },
      {
        ...receipt,
        requestId: nextRequest,
        refundCents: 500,
        expectedRefundedCents: 1500,
      },
    ],
  });
  expect(document.body.textContent).toContain("Refund pending with Stripe");
  expect(document.body.textContent).toContain("Keep the saved request");
  expect(document.querySelectorAll("dd")[2].textContent).toContain("15.00");
  expect(button("Check saved request")).toBeUndefined();
  expect(button("Check Stripe refund status")).toBeUndefined();
  expect(button("Refund test amount")).toBeUndefined();
  expect(send).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(key)).toBe(JSON.stringify(older));
});
