import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { AdminShell } from "./admin-shell";
import type { OwnerAllocationReleasePage } from "../../lib/commerce/owner-allocation-release-http.server";
import type {
  OwnerAllocationReleaseInput,
  OwnerAllocationReleaseReceipt,
} from "../../lib/commerce/owner-allocation-release";
const subscribe = () => () => {};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function original(key: string, orderId: string) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return { input: null, error: "" };
    const v = JSON.parse(raw) as OwnerAllocationReleaseInput;
    if (
      !v ||
      Object.keys(v).sort().join() !==
        [
          "requestId",
          "orderId",
          "expectedVersion",
          "expectedStockHash",
          "acknowledge",
        ]
          .sort()
          .join() ||
      v.orderId !== orderId ||
      !uuid.test(v.requestId) ||
      !Number.isSafeInteger(v.expectedVersion) ||
      v.expectedVersion < 1 ||
      !/^[a-f0-9]{64}$/.test(v.expectedStockHash) ||
      v.acknowledge !== true
    )
      throw Error();
    return { input: v, error: "" };
  } catch {
    return {
      input: null,
      error:
        "Saved release request or browser storage is unavailable. Ask the developer to recover it before another stock action.",
    };
  }
}
type Props = OwnerAllocationReleasePage & { transport?: typeof fetch };
export function OwnerAllocationReleaseOperations(props: Props) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  return (
    <AdminShell localReservations>
      <section className="admin-panel owner-stock-operations">
        <h1>Release refunded order stock</h1>
        <p>
          <strong>Local fictional orders only.</strong> This action releases
          goods set aside for a fully refunded order that was never handed over.
          It does not add physical goods or change payment, refund or delivery
          history. It does not set the store’s real refund policy.
        </p>
        <p className="commerce-workspace-reference">{props.detail.orderId}</p>
        {hydrated ? (
          <Controls
            key={`${props.instanceId}:${props.detail.orderId}`}
            {...props}
          />
        ) : (
          <p>Preparing stock controls…</p>
        )}
        <p>
          <Link
            to={`/admin/commerce/orders/${encodeURIComponent(props.detail.orderId)}`}
          >
            Back to order details
          </Link>
        </p>
      </section>
    </AdminShell>
  );
}
function Controls({ detail, instanceId, canWrite, transport = fetch }: Props) {
  const key = `commerce-owner-allocation-release-v1:${instanceId}:${detail.orderId}`;
  const [initial] = useState(() => original(key, detail.orderId));
  const [pending, setPending] = useState<OwnerAllocationReleaseInput | null>(
      initial.input,
    ),
    [blocked, setBlocked] = useState(!!initial.error),
    [busy, setBusy] = useState(false),
    [ack, setAck] = useState(false),
    [receipt, setReceipt] = useState<OwnerAllocationReleaseReceipt | null>(
      null,
    ),
    [message, setMessage] = useState(initial.error);
  const active = useRef(false),
    mounted = useRef(true),
    abort = useRef<AbortController | null>(null),
    status = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (message) status.current?.focus();
  }, [message]);
  async function perform(
    input: OwnerAllocationReleaseInput,
    intent: "apply" | "lookup",
  ) {
    if (active.current || blocked || (intent === "apply" && !canWrite)) return;
    active.current = true;
    setBusy(true);
    setMessage("");
    const controller = new AbortController();
    abort.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 25000);
    try {
      const response = await transport(
        `/admin/commerce/orders/${encodeURIComponent(detail.orderId)}/release-allocation/commands`,
        {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            intent,
            requestId: input.requestId,
            expectedVersion: String(input.expectedVersion),
            expectedStockHash: input.expectedStockHash,
            acknowledge: "true",
          }),
        },
      );
      const body = (await response.json()) as {
        state?: string;
        receipt?: OwnerAllocationReleaseReceipt;
      };
      if (!mounted.current) return;
      if (!response.ok) throw Error();
      if (intent === "lookup" && body.state === "not_recorded") {
        setMessage(
          "The original request is not visible yet. This does not prove failure. Keep it and ask the developer to investigate; do not submit a new stock action.",
        );
        return;
      }
      const r = body.receipt;
      if (
        body.state !== "recorded" ||
        !r ||
        r.testOnly !== true ||
        r.requestId !== input.requestId ||
        r.orderId !== input.orderId ||
        r.expectedVersion !== input.expectedVersion ||
        r.expectedStockHash !== input.expectedStockHash ||
        r.result !== "allocation_released" ||
        !Number.isSafeInteger(r.recordedAt) ||
        r.recordedAt < 0 ||
        typeof r.replayed !== "boolean"
      )
        throw Error();
      setReceipt(r);
      setMessage(
        "Order stock released once. Physical stock was not increased. Reload the recorded order before any next step.",
      );
      try {
        sessionStorage.removeItem(key);
        if (sessionStorage.getItem(key) !== null) throw Error();
        setPending(null);
      } catch {
        setBlocked(true);
        setMessage(
          "Release recorded, but browser recovery storage could not be cleared. Ask the developer to recover it before another stock action.",
        );
      }
    } catch {
      if (mounted.current)
        setMessage(
          "The result is unconfirmed. Keep the original request and check it before another stock action. Do not assume the allocation was released.",
        );
    } finally {
      window.clearTimeout(timer);
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function start() {
    if (
      active.current ||
      blocked ||
      pending ||
      receipt ||
      !canWrite ||
      !ack ||
      !detail.canRelease
    )
      return;
    const input: OwnerAllocationReleaseInput = {
      requestId: crypto.randomUUID(),
      orderId: detail.orderId,
      expectedVersion: detail.orderVersion,
      expectedStockHash: detail.stockHash,
      acknowledge: true,
    };
    try {
      sessionStorage.setItem(key, JSON.stringify(input));
      if (sessionStorage.getItem(key) !== JSON.stringify(input)) throw Error();
    } catch {
      setBlocked(true);
      setMessage(
        "The original request could not be saved. No action was sent. Ask the developer to recover browser storage.",
      );
      return;
    }
    setPending(input);
    void perform(input, "apply");
  }
  return (
    <>
      <dl className="commerce-workspace-facts">
        <div>
          <dt>Original handoff</dt>
          <dd>
            {detail.fulfillment === "handed_over" ? "Recorded" : "Not recorded"}
          </dd>
        </div>
        <div>
          <dt>Recorded full refund</dt>
          <dd>
            {detail.refundState === "succeeded" ? "Verified" : "Not verified"}
          </dd>
        </div>
        <div>
          <dt>Order stock release</dt>
          <dd>{detail.released ? "Recorded" : "Not recorded"}</dd>
        </div>
      </dl>
      <h2>Whole-order goods to check</h2>
      <ul className="commerce-workspace-lines">
        {detail.lines.map((line) => (
          <li
            className="commerce-workspace-card commerce-workspace-reference"
            key={line.position}
          >
            <strong>{line.name}</strong>
            <p>
              {line.colour} · {line.sku} · Quantity {line.quantity}
            </p>
            <p>
              Physical {line.onHand} · Facebook {line.facebookReserved} ·
              Checkout {line.checkoutReserved} · Allocated {line.allocated}
            </p>
          </li>
        ))}
      </ul>
      {detail.fulfillment === "handed_over" && (
        <p>
          These goods were handed over. This release action cannot receive goods
          or restore stock. Use the separate physical return inspection flow if
          goods come back.
        </p>
      )}
      {detail.refundState !== "succeeded" && (
        <p>
          A matching full refund has not been verified. All allocated goods
          remain protected. This page does not request or retry a refund.
        </p>
      )}
      {detail.released && (
        <p>
          The original whole-order allocation has already been released. It
          cannot be released again.
        </p>
      )}
      {!canWrite && (
        <p>
          New stock releases are paused. Recorded history and original-request
          lookup remain available.
        </p>
      )}
      {message && (
        <div role="status" aria-live="polite" tabIndex={-1} ref={status}>
          {message}
        </div>
      )}
      {pending && (
        <div>
          <p>Keep this original request until its result is confirmed.</p>
          <p className="commerce-workspace-reference">{pending.requestId}</p>
          <button
            type="button"
            disabled={busy || blocked}
            onClick={() => void perform(pending, "lookup")}
          >
            {busy ? "Checking…" : "Check saved release request"}
          </button>
        </div>
      )}
      {receipt && (
        <p>
          <Link
            to={`/admin/commerce/orders/${encodeURIComponent(detail.orderId)}/release-allocation`}
          >
            Reload recorded stock status
          </Link>
        </p>
      )}
      {!pending && !receipt && detail.canRelease && (
        <fieldset disabled={!canWrite || busy || blocked}>
          <legend>Confirm goods are still here before releasing them</legend>
          <label>
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />{" "}
            I checked that every listed item is still in the store, was never
            handed over and is sellable. I authorize releasing this order’s
            exact stock allocation.
          </label>
          <button
            type="button"
            disabled={!ack || !canWrite || busy || blocked}
            onClick={start}
          >
            Release this refunded order’s stock
          </button>
        </fieldset>
      )}
      <h2>Recorded stock release history</h2>
      {detail.history.length ? (
        <ul>
          {detail.history.map((r) => (
            <li key={r.requestId}>
              Order stock released once{" "}
              <span className="commerce-workspace-reference">
                {r.requestId}
              </span>
              <time dateTime={new Date(r.recordedAt).toISOString()}>
                {new Date(r.recordedAt).toLocaleString("en-CA")}
              </time>
            </li>
          ))}
        </ul>
      ) : (
        <p>No stock release recorded.</p>
      )}
      <p>
        This test releases a whole order once. Physical goods are not received
        again, and the original payment, refund and handoff remain historical
        records. If any item is missing or unsuitable, keep the allocation and
        ask the developer to review it.
      </p>
    </>
  );
}
