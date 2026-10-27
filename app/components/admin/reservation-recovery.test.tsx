// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReservationRecovery } from "./reservation-recovery";
import { loader as reviewResource } from "../../routes/admin-commerce-review";

const { readReview } = vi.hoisted(() => ({ readReview: vi.fn() }));
vi.mock("../../lib/commerce/reservation-review-request.server", () => ({
  readReservationReview: readReview,
  reviewHeaders: {
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow",
  },
}));

const reference = "order-00000000-0000-0000-0000-000000000001";
const now = Date.UTC(2026, 9, 27, 12);
const order = {
  id: reference,
  state: "pending_payment",
  paymentState: "not_started",
  fulfillment: "none",
  reserveUntil: now - 1000,
  version: 1,
};
const key = `velaform-local-admin-recovery-v1:${reference}`;
const saved = {
  requestId: "00000000-0000-4000-8000-000000000001",
  reference,
  expectedVersion: 1,
  confirmation: reference,
  reason: "overdue_unpaid",
} as const;
const receipt = {
  testOnly: true,
  requestId: saved.requestId,
  reference,
  expectedVersion: 1,
  resultingVersion: 2,
  recordedAt: now,
  replayed: true,
};
let root: Root;
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  document.body.innerHTML = '<div id="test-root"></div>';
  root = createRoot(document.getElementById("test-root")!);
  sessionStorage.clear();
  fetcher.mockReset();
  readReview.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(crypto, "randomUUID").mockReturnValue(saved.requestId);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(
  changes: Partial<typeof order> = {},
  lineCount = 2,
  reviewBusy = false,
) {
  await act(async () =>
    root.render(
      <ReservationRecovery
        key={changes.id ?? reference}
        order={{ ...order, ...changes }}
        observedAt={now}
        lineCount={lineCount}
        reviewBusy={reviewBusy}
      />,
    ),
  );
}
function button(text: string) {
  return Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent === text,
  )!;
}
async function confirm(value = reference) {
  await act(async () => {
    const input = document.querySelector("input")!;
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
async function click(text: string) {
  await act(async () => button(text).click());
}
function queryReply(lookup: unknown) {
  return Response.json({
    testOnly: true,
    observedAt: now,
    order,
    lines: [],
    history: [],
    historyTruncated: false,
    recoveryLookup: lookup,
  });
}

it("reads the flat receipt projection serialized by the actual JSON resource", async () => {
  sessionStorage.setItem(key, JSON.stringify(saved));
  readReview.mockResolvedValue({
    kind: "detail",
    result: {
      testOnly: true,
      order,
      recoveryLookup: { state: "recorded", receipt },
    },
  });
  fetcher.mockImplementation(async (url) =>
    reviewResource({
      request: new Request(new URL(String(url), "http://localhost")),
    } as Parameters<typeof reviewResource>[0]),
  );
  await render();
  await click("Query original request (read only)");
  expect(readReview.mock.calls[0][0].method).toBe("GET");
  expect(document.body.textContent).toContain("Original receipt found");
  expect(document.body.textContent).toContain("original recovery was recorded");
  expect(button("Retry the same confirmed request")).toBeUndefined();
});

it("requires exact confirmation and saves the five immutable fields before POST", async () => {
  fetcher.mockImplementation(async (_url, init) => {
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(saved);
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.redirect).toBe("error");
    expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({
      ...saved,
      expectedVersion: "1",
    });
    return Response.json({ ...receipt, replayed: false });
  });
  await render();
  expect(button("Confirm cancellation and release").disabled).toBe(true);
  await confirm(reference + "wrong");
  await submit();
  expect(fetcher).not.toHaveBeenCalled();
  await confirm();
  await submit();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("original recovery was recorded");
  expect(document.body.textContent).toContain("1 → 2");
  expect(document.body.textContent).toContain("does not verify a payment");
  expect(document.activeElement).toBe(
    document.querySelector('[role="status"]'),
  );
});
it.each([
  { state: "cancelled" },
  { paymentState: "processing" },
  { paymentState: "unknown" },
  { paymentState: "succeeded" },
  { paymentState: "failed" },
  { fulfillment: "held" },
  { reserveUntil: now + 1 },
  { version: 0 },
])("does not offer a new recovery for %j", async (changes) => {
  await render(changes);
  expect(document.querySelector("form")).toBeNull();
  expect(document.body.textContent).toContain("not eligible");
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([0, 21])("rejects an invalid line count %s", async (count) => {
  await render({}, count);
  expect(document.querySelector("form")).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
it("prevents a new confirmation while review is refreshing", async () => {
  await render({}, 2, true);
  await confirm();
  await submit();
  expect(button("Confirm cancellation and release").disabled).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});
it("blocks double submit and retries a lost response using exactly the saved request", async () => {
  let fail!: (error: Error) => void;
  fetcher.mockImplementationOnce(
    () => new Promise((_, reject) => (fail = reject)),
  );
  await render();
  await confirm();
  await act(async () => {
    const form = document.querySelector("form")!;
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => fail(new Error("private transport exception")));
  expect(document.body.textContent).toContain("outcome is not confirmed");
  expect(document.body.textContent).not.toContain("private transport");
  await render({ state: "cancelled", version: 2 });
  fetcher.mockResolvedValueOnce(Response.json(receipt));
  await click("Retry the same confirmed request");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(String(fetcher.mock.calls[0][1]?.body)).toBe(
    String(fetcher.mock.calls[1][1]?.body),
  );
  expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("Original receipt found");
});
it("restores an uncertain saved request on remount without auto-POST or auto-query", async () => {
  sessionStorage.setItem(key, JSON.stringify(saved));
  await render({ state: "cancelled", version: 2 });
  expect(fetcher).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Nothing was submitted");
  fetcher.mockResolvedValueOnce(queryReply({ state: "recorded", receipt }));
  await click("Query original request (read only)");
  expect(fetcher.mock.calls[0][1]?.method).toBe("GET");
  expect(
    new URL(
      String(fetcher.mock.calls[0][0]),
      "http://localhost",
    ).searchParams.get("expectedVersion"),
  ).toBe("1");
  expect(document.body.textContent).toContain("Original receipt found");
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(saved);
});
it("keeps a missing receipt uncertain and retains a known receipt during a later query outage", async () => {
  sessionStorage.setItem(key, JSON.stringify(saved));
  await render();
  fetcher.mockResolvedValueOnce(queryReply({ state: "not_recorded" }));
  await click("Query original request (read only)");
  expect(document.body.textContent).toContain("not proof of failure");
  expect(button("Retry the same confirmed request")).toBeDefined();
  fetcher.mockResolvedValueOnce(queryReply({ state: "recorded", receipt }));
  await click("Query original request (read only)");
  fetcher.mockResolvedValueOnce(
    new Response("private db error", { status: 503 }),
  );
  await click("Query original request (read only)");
  expect(document.body.textContent).toContain("recorded receipt is retained");
  expect(document.body.textContent).toContain("1 → 2");
  expect(button("Retry the same confirmed request")).toBeUndefined();
  expect(document.body.textContent).not.toContain("private db error");
});
it.each([409, 400, 401, 403, 404])(
  "retains a %s response for review without allowing blind retry",
  async (code) => {
    fetcher.mockResolvedValueOnce(
      new Response("secret response", { status: code }),
    );
    await render();
    await confirm();
    await submit();
    expect(button("Retry the same confirmed request")).toBeUndefined();
    expect(button("Confirm cancellation and release")).toBeUndefined();
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(saved);
    expect(document.body.textContent).toContain("developer");
    expect(document.body.textContent).not.toContain("secret response");
  },
);
it("does not present a different operator/payload lookup as success", async () => {
  sessionStorage.setItem(key, JSON.stringify(saved));
  await render();
  fetcher.mockResolvedValueOnce(queryReply({ state: "conflict" }));
  await click("Query original request (read only)");
  expect(document.body.textContent).toContain("original operator");
  expect(button("Retry the same confirmed request")).toBeUndefined();
});
it.each([
  { testOnly: false },
  { requestId: "different" },
  { reference: reference.slice(0, -1) + "2" },
  { expectedVersion: 2 },
  { resultingVersion: 7 },
  { recordedAt: -1 },
])("rejects a mismatched or malformed receipt %j", async (changes) => {
  fetcher.mockResolvedValueOnce(Response.json({ ...receipt, ...changes }));
  await render();
  await confirm();
  await submit();
  expect(document.body.textContent).toContain("outcome is not confirmed");
  expect(document.body.textContent).not.toContain("recovery was recorded");
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(saved);
});
it("times out even when fetch ignores abort, then ignores its late success", async () => {
  vi.useFakeTimers();
  let finish!: (result: Response) => void;
  fetcher.mockImplementationOnce(
    () => new Promise((resolve) => (finish = resolve)),
  );
  await render();
  await confirm();
  await submit();
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(document.body.textContent).toContain("outcome is not confirmed");
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  await act(async () => finish(Response.json(receipt)));
  expect(document.body.textContent).not.toContain("recovery was recorded");
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(saved);
});
it("blocks before POST if browser storage fails", async () => {
  await render();
  vi.stubGlobal("sessionStorage", {
    getItem: () => null,
    setItem: () => {
      throw new Error("storage unavailable");
    },
  });
  await confirm();
  await submit();
  expect(fetcher).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("nothing was submitted");
});
it("also times out while reading a hanging response body", async () => {
  vi.useFakeTimers();
  const response = Response.json(receipt);
  vi.spyOn(response, "json").mockImplementation(() => new Promise(() => {}));
  fetcher.mockResolvedValueOnce(response);
  await render();
  await confirm();
  await submit();
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(document.body.textContent).toContain("outcome is not confirmed");
  expect(button("Retry the same confirmed request")).toBeDefined();
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(saved);
});
it("rejects a query detail for another order instead of claiming its receipt", async () => {
  sessionStorage.setItem(key, JSON.stringify(saved));
  fetcher.mockResolvedValueOnce(
    Response.json({
      testOnly: true,
      order: { ...order, id: reference.slice(0, -1) + "2" },
      recoveryLookup: { state: "recorded", receipt },
    }),
  );
  await render();
  await click("Query original request (read only)");
  expect(document.body.textContent).toContain("outcome is not confirmed");
  expect(document.body.textContent).not.toContain("recovery was recorded");
});
it("does not overwrite a malformed saved request", async () => {
  sessionStorage.setItem(key, '{"broken":true}');
  await render();
  expect(document.querySelector("form")).toBeNull();
  expect(document.body.textContent).toContain("do not clear");
  expect(sessionStorage.getItem(key)).toBe('{"broken":true}');
  expect(fetcher).not.toHaveBeenCalled();
});
it("cannot apply an old response to another selected order", async () => {
  let finish!: (response: Response) => void;
  fetcher.mockImplementationOnce(
    () => new Promise((resolve) => (finish = resolve)),
  );
  await render();
  await confirm();
  await submit();
  await render({ id: reference.slice(0, -1) + "2" });
  await act(async () => finish(Response.json(receipt)));
  expect(document.body.textContent).not.toContain("recovery was recorded");
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(saved);
});
