import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { AdminShell } from "./admin-shell";
import type { OwnerReturnPage } from "../../lib/commerce/owner-return-http.server";
import type {
  OwnerReturnInput,
  OwnerReturnOperation,
  OwnerReturnReceipt,
} from "../../lib/commerce/owner-return";
const subscribe = () => () => {};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const labels = {
  inspect_sellable: "Received and inspected — sellable",
  inspect_unsuitable: "Received and inspected — keep aside",
  restock: "Returned stock restored once",
};
const results = {
  inspect_sellable: "sellable_received",
  inspect_unsuitable: "unsuitable_received",
  restock: "stock_restored",
};
function original(key: string, orderId: string) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return { input: null, error: "" };
    const v = JSON.parse(raw) as OwnerReturnInput;
    if (
      !v ||
      Object.keys(v).sort().join() !==
        [
          "requestId",
          "orderId",
          "operation",
          "expectedVersion",
          "expectedStockHash",
          "acknowledge",
        ]
          .sort()
          .join() ||
      v.orderId !== orderId ||
      !uuid.test(v.requestId) ||
      !Object.hasOwn(labels, v.operation) ||
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
        "Saved return request or browser storage is unavailable. Ask the developer to recover it before another stock action.",
    };
  }
}
type Props = OwnerReturnPage & { transport?: typeof fetch };
export function OwnerReturnOperations(props: Props) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  return (
    <AdminShell localReservations>
      <section className="admin-panel owner-stock-operations">
        <h1>Inspect a test return</h1>
        <p>
          <strong>Local fictional orders only.</strong> Receiving goods,
          refunding money and restoring sellable stock are separate actions.
          This does not set the store’s real return policy.
        </p>
        <p className="commerce-workspace-reference">{props.detail.orderId}</p>
        {hydrated ? (
          <Controls
            key={`${props.instanceId}:${props.detail.orderId}`}
            {...props}
          />
        ) : (
          <p>Preparing return controls…</p>
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
  const key = `commerce-owner-return-v1:${instanceId}:${detail.orderId}`;
  const [initial] = useState(() => original(key, detail.orderId));
  const [pending, setPending] = useState<OwnerReturnInput | null>(
      initial.input,
    ),
    [blocked, setBlocked] = useState(!!initial.error),
    [busy, setBusy] = useState(false),
    [ack, setAck] = useState(false),
    [receipt, setReceipt] = useState<OwnerReturnReceipt | null>(null),
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
  async function perform(input: OwnerReturnInput, intent: "apply" | "lookup") {
    if (active.current || blocked || (intent === "apply" && !canWrite)) return;
    active.current = true;
    setBusy(true);
    setMessage("");
    const controller = new AbortController();
    abort.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 25000);
    try {
      const response = await transport(
        `/admin/commerce/orders/${encodeURIComponent(detail.orderId)}/return/commands`,
        {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            intent,
            requestId: input.requestId,
            operation: input.operation,
            expectedVersion: String(input.expectedVersion),
            expectedStockHash: input.expectedStockHash,
            acknowledge: "true",
          }),
        },
      );
      const body = (await response.json()) as {
        state?: string;
        receipt?: OwnerReturnReceipt;
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
        r.operation !== input.operation ||
        r.expectedVersion !== input.expectedVersion ||
        r.expectedStockHash !== input.expectedStockHash ||
        r.result !== results[input.operation] ||
        !Number.isSafeInteger(r.recordedAt) ||
        r.recordedAt < 0 ||
        typeof r.replayed !== "boolean"
      )
        throw Error();
      setReceipt(r);
      setMessage(
        labels[r.operation] +
          ". Reload the recorded order before any next step.",
      );
      try {
        sessionStorage.removeItem(key);
        if (sessionStorage.getItem(key) !== null) throw Error();
        setPending(null);
      } catch {
        setBlocked(true);
        setMessage(
          "Action recorded, but browser recovery storage could not be cleared. Ask the developer to recover it before another action.",
        );
      }
    } catch {
      if (mounted.current)
        setMessage(
          "The result is unconfirmed. Keep the original request and check it before another stock action. Do not assume goods were added back.",
        );
    } finally {
      window.clearTimeout(timer);
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function start(operation: OwnerReturnOperation) {
    if (
      active.current ||
      blocked ||
      pending ||
      receipt ||
      !canWrite ||
      !ack ||
      (operation === "restock" ? !detail.canRestock : !detail.canInspect)
    )
      return;
    const input: OwnerReturnInput = {
      requestId: crypto.randomUUID(),
      orderId: detail.orderId,
      operation,
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
          <dt>Return inspection</dt>
          <dd>
            {detail.inspection === "sellable"
              ? "Received — sellable"
              : detail.inspection === "unsuitable"
                ? "Received — keep aside"
                : "Not recorded"}
          </dd>
        </div>
        <div>
          <dt>Stock restoration</dt>
          <dd>
            {detail.stockState === "restored"
              ? "Restored once"
              : "Not restored"}
          </dd>
        </div>
        <div>
          <dt>Recorded full refund</dt>
          <dd>
            {detail.refundState === "succeeded" ? "Verified" : "Not verified"}
          </dd>
        </div>
      </dl>
      <h2>Whole-order items</h2>
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
      {detail.fulfillment === "not_handed_over" && (
        <p>
          No handoff was recorded. This is not a physical return. Any paid stock
          allocation stays protected; ask the developer to review a separate
          allocation release. Do not add the goods to physical stock again.
        </p>
      )}
      {detail.inspection === "unsuitable" && (
        <p>
          Keep these goods aside, outside sellable stock. This test workflow
          does not reclassify or dispose of unsuitable items.
        </p>
      )}
      {detail.inspection === "sellable" &&
        detail.stockState !== "restored" &&
        !detail.canRestock && (
          <p>
            Keep the returned goods aside. This test allows stock restoration
            only after the matching full refund is verified. Recording receipt
            never triggers a refund.
          </p>
        )}
      {!canWrite && (
        <p>
          New return actions are paused. Recorded history and original-request
          lookup remain available.
        </p>
      )}
      {!pending && !receipt && (detail.canInspect || detail.canRestock) && (
        <fieldset disabled={busy || blocked || !canWrite}>
          <legend>
            {detail.canInspect
              ? "Step 1: confirm physical receipt and inspection"
              : "Step 2: separately authorize stock restoration"}
          </legend>
          <label className="owner-stock-confirm">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            {detail.canInspect
              ? "I physically received every listed item and inspected the whole test return."
              : "I checked the sellable items and authorize restoring these exact quantities to stock."}
          </label>
          {detail.canInspect ? (
            <>
              <button
                type="button"
                className="admin-primary-button"
                disabled={!ack}
                onClick={() => start("inspect_sellable")}
              >
                Record received — sellable
              </button>
              <button
                type="button"
                disabled={!ack}
                onClick={() => start("inspect_unsuitable")}
              >
                Record received — keep aside
              </button>
            </>
          ) : (
            <button
              type="button"
              className="admin-primary-button"
              disabled={!ack}
              onClick={() => start("restock")}
            >
              Restore inspected test stock
            </button>
          )}
        </fieldset>
      )}
      {pending && !receipt && (
        <section aria-label="Original return request">
          <h2>Keep this original request</h2>
          <p className="commerce-workspace-reference">{pending.requestId}</p>
          <p>
            Checking this request does not repeat inspection or add stock again.
          </p>
          <button
            type="button"
            disabled={busy || blocked}
            onClick={() => void perform(pending, "lookup")}
          >
            Check saved return request
          </button>
        </section>
      )}
      {receipt && (
        <p>
          <a
            className="admin-primary-link"
            href={`/admin/commerce/orders/${encodeURIComponent(detail.orderId)}/return`}
          >
            Reload recorded return status
          </a>
        </p>
      )}
      <div ref={status} role="status" aria-live="polite" tabIndex={-1}>
        {busy ? "Checking the original return action…" : message}
      </div>
      <h2>Recorded return history</h2>
      {detail.history.length ? (
        <ul className="commerce-workspace-lines">
          {detail.history.map((item) => (
            <li key={item.requestId}>
              <strong>{labels[item.operation]}</strong>
              <p className="commerce-workspace-reference">{item.requestId}</p>
              <time dateTime={new Date(item.recordedAt).toISOString()}>
                {new Date(item.recordedAt).toLocaleString("en-CA")}
              </time>
            </li>
          ))}
        </ul>
      ) : (
        <p>No return action recorded.</p>
      )}
      <p>
        Inspection does not change stock. Restoring sellable goods changes
        physical stock only; the original payment, refund and handoff remain
        historical records. This test supports one whole-order inspection and
        one restoration.
      </p>
    </>
  );
}
