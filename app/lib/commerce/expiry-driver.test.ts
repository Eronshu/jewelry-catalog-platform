import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalExpiryDriver,
  EXPIRY_INTERVAL_MS,
} from "../../../scripts/commerce-expiry-driver.mjs";

const origin = "http://127.0.0.1:8792";
const token = "c".repeat(64);
const cursor = { reserveUntil: 1, orderId: `order-${"0".repeat(36)}` };
const ready = () =>
  new Response(null, { status: 405, headers: { Allow: "POST" } });
const page = (nextCursor: typeof cursor | null = null, outcome = "cancelled") =>
  Response.json({
    outcomes: [{ orderId: cursor.orderId, outcome }],
    nextCursor,
    stopped: false,
  });
afterEach(() => {
  vi.useRealTimers();
});
describe("bounded local expiry driver", () => {
  it("pages once per tick then starts a fresh sweep, logging counts only", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ready())
      .mockResolvedValueOnce(page(cursor, "failed"))
      .mockResolvedValueOnce(page())
      .mockResolvedValue(page());
    const report = vi.fn();
    const driver = createLocalExpiryDriver({ origin, token, fetcher, report });
    driver.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(EXPIRY_INTERVAL_MS);
    expect(JSON.parse(fetcher.mock.calls[2][1]!.body as string)).toEqual({
      after: cursor,
    });
    await vi.advanceTimersByTimeAsync(EXPIRY_INTERVAL_MS);
    expect(JSON.parse(fetcher.mock.calls[3][1]!.body as string)).toEqual({});
    expect(report.mock.calls.flat().join(" ")).toContain("failed=1");
    expect(report.mock.calls.flat().join(" ")).not.toMatch(
      new RegExp(`${token}|${cursor.orderId}`),
    );
    driver.stop();
  });
  it("does not overlap slow requests or schedule after stop/late completion", async () => {
    vi.useFakeTimers();
    let resolve!: (value: Response) => void;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ready())
      .mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
    const driver = createLocalExpiryDriver({
      origin,
      token,
      fetcher,
      report: vi.fn(),
    });
    driver.start();
    driver.start();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1]!.signal!.aborted).toBe(true);
    driver.stop();
    resolve(page());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("backs off completed scan failures, preserves the page and caps retry delay", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ready())
      .mockResolvedValueOnce(page(cursor))
      .mockImplementation(async () => new Response(null, { status: 503 }));
    const driver = createLocalExpiryDriver({
      origin,
      token,
      fetcher,
      report: vi.fn(),
    });
    driver.start();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1 + 120_000 + 240_000 + 300_000);
    expect(fetcher).toHaveBeenCalledTimes(7);
    for (const [, init] of fetcher.mock.calls.slice(2))
      expect(JSON.parse(init!.body as string)).toEqual({ after: cursor });
    driver.stop();
  });
  it.each(["transport", "unauthorized", "malformed", "timeout"])(
    "stops on uncertain %s after readiness instead of retrying writes",
    async (kind) => {
      vi.useFakeTimers();
      const report = vi.fn();
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(ready())
        .mockImplementation(async (_url, init) => {
          if (kind === "transport") throw new Error("secret exception");
          if (kind === "unauthorized")
            return new Response(null, { status: 404 });
          if (kind === "malformed") return Response.json({});
          return new Promise((_done, reject) =>
            init!.signal!.addEventListener("abort", () =>
              reject(new Error("timeout")),
            ),
          );
        });
      const driver = createLocalExpiryDriver({
        origin,
        token,
        fetcher,
        report,
      });
      driver.start();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(report.mock.calls.flat().join(" ")).toContain(
        "no rollback assumed",
      );
      expect(report.mock.calls.flat().join(" ")).not.toContain(
        "secret exception",
      );
      driver.stop();
    },
  );
  it("waits for local startup without writing, then stops if it never becomes available", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("not ready"));
    const driver = createLocalExpiryDriver({
      origin,
      token,
      fetcher,
      report: vi.fn(),
    });
    driver.start();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetcher).toHaveBeenCalledTimes(31);
    expect(fetcher.mock.calls.every(([, init]) => init!.method === "GET")).toBe(
      true,
    );
    driver.stop();
  });
  it.each([
    "https://127.0.0.1:8792",
    "http://example.invalid",
    "http://127.0.0.1:8792/path",
  ])("refuses non-isolated driver origin %s", (badOrigin) => {
    expect(() =>
      createLocalExpiryDriver({ origin: badOrigin, token }),
    ).toThrow();
  });
});
