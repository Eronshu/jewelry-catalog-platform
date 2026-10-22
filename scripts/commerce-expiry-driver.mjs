// Only the isolated runner supplies this capability. No CLI/DB path/remote mode.
export const EXPIRY_INTERVAL_MS = 30_000;
const path = "/_local/commerce/expiry";

/** @typedef {{reserveUntil: number, orderId: string}} Cursor */
/** @param {unknown} value */
function readResult(value) {
  const result =
    /** @type {import('../app/lib/commerce/order-expiry.server').ExpiryBatchResult} */ (
      value
    );
  const cursor = result?.nextCursor;
  if (
    !result ||
    typeof result !== "object" ||
    !Array.isArray(result.outcomes) ||
    result.outcomes.length > 10 ||
    typeof result.stopped !== "boolean" ||
    result.outcomes.some(
      (item) =>
        !item ||
        !/^order-[a-f0-9-]{36}$/.test(item.orderId) ||
        !["cancelled", "skipped", "failed"].includes(item.outcome),
    ) ||
    (cursor !== null &&
      (!cursor ||
        !Number.isSafeInteger(cursor.reserveUntil) ||
        cursor.reserveUntil < 0 ||
        !/^order-[a-f0-9-]{36}$/.test(cursor.orderId)))
  )
    throw new Error("Invalid local expiry response");
  return result;
}

/**
 * One awaited batch per tick. 503 means scan failed before item processing;
 * retry with bounded backoff. Ambiguous transport/timeout/bad replies stop the
 * driver: never assume an aborted HTTP request rolled back a D1 transaction.
 * @param {{origin: string, token: string, fetcher?: typeof fetch, report?: (message: string) => void}} options
 */
export function createLocalExpiryDriver({
  origin,
  token,
  fetcher = fetch,
  report = console.log,
}) {
  const url = new URL(origin);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.origin !== origin ||
    !/^[a-f0-9]{64}$/.test(token)
  )
    throw new Error("Isolated loopback expiry settings required");
  const headers = {
    Origin: origin,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  /** @type {Cursor | undefined} */
  let cursor;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {AbortController | undefined} */
  let active;
  let stopped = true;
  let started = false;
  let ready = false;
  let startupFailures = 0;
  let failures = 0;
  function stop() {
    stopped = true;
    clearTimeout(timer);
    active?.abort();
  }
  /** @param {number} delay */
  function schedule(delay) {
    if (!stopped) timer = setTimeout(tick, delay);
  }
  async function tick() {
    if (stopped) return;
    active = new AbortController();
    const timeout = setTimeout(() => active?.abort(), 15_000);
    let delay = EXPIRY_INTERVAL_MS;
    try {
      // Authorized GET checks startup readiness without any database work.
      const response = await fetcher(`${origin}${path}`, {
        method: ready ? "POST" : "GET",
        headers,
        ...(ready
          ? { body: JSON.stringify(cursor ? { after: cursor } : {}) }
          : {}),
        signal: active.signal,
        redirect: "error",
      });
      if (stopped) return;
      if (!ready) {
        if (response.status !== 405 || response.headers.get("Allow") !== "POST")
          throw new Error();
        ready = true;
        report("Local expiry ready (fictional data only).");
        delay = 0;
      } else if (response.status === 503) {
        failures++;
        delay = Math.min(
          EXPIRY_INTERVAL_MS * 2 ** Math.min(failures, 4),
          300_000,
        );
        report(
          `Local expiry scan unavailable; retry in ${delay / 1000}s. Reservations retained.`,
        );
      } else {
        if (!response.ok) throw new Error();
        const result = readResult(await response.json());
        if (stopped) return;
        if (result.stopped) throw new Error();
        cursor = result.nextCursor ?? undefined;
        failures = 0;
        const counts = { cancelled: 0, skipped: 0, failed: 0 };
        for (const item of result.outcomes) counts[item.outcome]++;
        report(
          `Local expiry observed: cancelled=${counts.cancelled}, skipped=${counts.skipped}, failed=${counts.failed}; ${cursor ? "continue page" : "fresh sweep next tick"}.`,
        );
        if (counts.failed)
          report(
            "Local expiry failed reservations retained; retry next sweep. Repeated failures need developer investigation.",
          );
      }
    } catch {
      if (!stopped) {
        if (!ready && ++startupFailures <= 30 && !active.signal.aborted) {
          delay = 1000;
        } else {
          stop();
          report(
            "Local expiry stopped: unavailable or uncertain response. Inspect local state before restarting; no rollback assumed.",
          );
        }
      }
    } finally {
      clearTimeout(timeout);
      active = undefined;
      schedule(delay);
    }
  }
  return {
    start() {
      // A stopped instance is not reused while its old request may settle.
      if (started) return;
      started = true;
      stopped = false;
      schedule(0);
    },
    stop,
  };
}
