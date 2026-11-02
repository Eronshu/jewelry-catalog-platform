import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { AdminShell } from "./admin-shell";
import type { OwnerFulfillmentPage } from "../../lib/commerce/owner-fulfillment-http.server";
import type {
  OwnerFulfillmentInput,
  OwnerFulfillmentOperation,
  OwnerFulfillmentReceipt,
} from "../../lib/commerce/owner-fulfillment";
const subscribe = () => () => {};
const labels: Record<OwnerFulfillmentOperation, string> = {
  pack: "Mark the full order packed",
  collect: "Record customer pickup",
  deliver: "Record local delivery completed",
  ship: "Record handoff to the postal carrier",
};
const states = {
  blocked: "Needs review — actions unavailable",
  ready_to_pack: "Ready to pack",
  packed: "Packed — awaiting handoff",
  handed_over: "Handoff recorded",
};
const methods: Record<string, string> = {
  pickup: "Customer pickup",
  local_delivery: "Local delivery",
  shipping: "Canadian shipping",
};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function saved(key: string, orderId: string) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return { input: null, error: "" };
    const value = JSON.parse(raw) as OwnerFulfillmentInput;
    if (
      !value ||
      Object.keys(value).sort().join() !==
        ["requestId", "orderId", "operation", "expectedVersion", "acknowledge"]
          .sort()
          .join() ||
      value.orderId !== orderId ||
      !uuid.test(value.requestId) ||
      !Object.hasOwn(labels, value.operation) ||
      value.acknowledge !== true ||
      !Number.isSafeInteger(value.expectedVersion) ||
      value.expectedVersion < 1
    )
      throw Error();
    return { input: value, error: "" };
  } catch {
    return {
      input: null,
      error:
        "Saved request or browser storage is unavailable. Ask the developer to recover it before another handoff.",
    };
  }
}
type Props = OwnerFulfillmentPage & { transport?: typeof fetch };
export function OwnerFulfillmentOperations(props: Props) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  return (
    <AdminShell localReservations>
      <section className="admin-panel owner-stock-operations owner-fulfillment-operations">
        <h1>Pack and hand over a test order</h1>
        <p>
          <strong>Local fictional fulfillment only.</strong> These actions do
          not send goods, buy postage, contact a customer or issue a refund.
        </p>
        <p className="commerce-workspace-reference">{props.detail.orderId}</p>
        {hydrated ? (
          <Controls
            key={`${props.instanceId}:${props.detail.orderId}`}
            {...props}
          />
        ) : (
          <p>Preparing fulfillment controls…</p>
        )}
        <p>
          <Link
            to={`/admin/commerce/orders/${encodeURIComponent(props.detail.orderId)}`}
          >
            Back to order details and items
          </Link>
        </p>
      </section>
    </AdminShell>
  );
}
function Controls({ detail, instanceId, canWrite, transport = fetch }: Props) {
  const storageKey = `commerce-owner-fulfillment-v1:${instanceId}:${detail.orderId}`;
  const [initial] = useState(() => saved(storageKey, detail.orderId));
  const [pending, setPending] = useState(initial.input),
    [blocked, setBlocked] = useState(!!initial.error),
    [busy, setBusy] = useState(false),
    [ack, setAck] = useState(false),
    [message, setMessage] = useState(
      initial.error ||
        (initial.input
          ? "A previous request needs checking. Keep its original details."
          : ""),
    ),
    [receipt, setReceipt] = useState<OwnerFulfillmentReceipt | null>(null);
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
  const handoff: OwnerFulfillmentOperation | null =
    detail.delivery === "pickup"
      ? "collect"
      : detail.delivery === "local_delivery"
        ? "deliver"
        : detail.delivery === "shipping"
          ? "ship"
          : null;
  const operation = detail.canPack
    ? "pack"
    : detail.canHandoff
      ? handoff
      : null;
  async function perform(
    input: OwnerFulfillmentInput,
    intent: "apply" | "lookup",
  ) {
    if (active.current || blocked || (intent === "apply" && !canWrite)) return;
    active.current = true;
    setBusy(true);
    setMessage("");
    const controller = new AbortController();
    abort.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 20000);
    try {
      const response = await transport(
        `/admin/commerce/orders/${encodeURIComponent(detail.orderId)}/fulfillment/commands`,
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
            acknowledge: "true",
          }),
        },
      );
      const body = (await response.json()) as {
        state?: string;
        receipt?: OwnerFulfillmentReceipt;
      };
      if (!mounted.current) return;
      if (!response.ok) throw Error();
      if (body.state === "not_recorded" && intent === "lookup") {
        setMessage(
          "The original request is not visible yet. That does not prove failure. Retry only this same request or ask the developer to review it.",
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
        r.resultingVersion !== input.expectedVersion + 1 ||
        typeof r.replayed !== "boolean" ||
        !Number.isSafeInteger(r.recordedAt) ||
        r.recordedAt < 0 ||
        r.recordedAt > 8640000000000000
      )
        throw Error();
      setReceipt(r);
      setMessage(
        "Action recorded once. Reload the latest order before the next action.",
      );
      try {
        sessionStorage.removeItem(storageKey);
        if (sessionStorage.getItem(storageKey) !== null) throw Error();
        setPending(null);
      } catch {
        setBlocked(true);
        setMessage(
          "Action recorded, but the saved browser request could not be cleared. Ask the developer to recover storage before another action.",
        );
      }
    } catch {
      if (mounted.current)
        setMessage(
          "The result is unconfirmed or the order changed. Keep this request and check it; do not record a second handoff. Ask the developer if it cannot be resolved.",
        );
    } finally {
      window.clearTimeout(timer);
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function submit() {
    if (
      active.current ||
      blocked ||
      pending ||
      receipt ||
      !canWrite ||
      !ack ||
      !operation
    )
      return;
    const input: OwnerFulfillmentInput = {
      requestId: crypto.randomUUID(),
      orderId: detail.orderId,
      operation,
      expectedVersion: detail.version,
      acknowledge: true,
    };
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(input));
      if (sessionStorage.getItem(storageKey) !== JSON.stringify(input))
        throw Error();
    } catch {
      setBlocked(true);
      setMessage(
        "Browser storage could not preserve the request. No action was sent. Ask the developer to check storage.",
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
          <dt>Fulfillment</dt>
          <dd>{states[detail.state]}</dd>
        </div>
        <div>
          <dt>Delivery method fixed at checkout</dt>
          <dd>{methods[detail.delivery] ?? "Unavailable — needs review"}</dd>
        </div>
      </dl>
      <p>
        Review all items on the order details page before packing. Packing keeps
        the order's stock allocated. Recording the full handoff removes its
        units from physical and allocated stock once; Facebook stock and other
        orders stay protected.
      </p>
      {detail.delivery === "shipping" && (
        <p>
          “Handed to carrier” records dispatch only. It does not prove delivery
          to the customer. Postage, tracking and customer notification are not
          sent from this test page.
        </p>
      )}
      {!canWrite && (
        <p role="status">
          New fulfillment actions are paused. Original requests can still be
          checked.
        </p>
      )}
      {detail.state === "blocked" && (
        <p className="admin-alert">
          Payment or order needs review. Do not pack or hand over goods; ask the
          developer to investigate.
        </p>
      )}
      {operation && (
        <fieldset
          disabled={busy || blocked || !!pending || !!receipt || !canWrite}
        >
          <legend>{labels[operation]}</legend>
          <p>
            {operation === "pack"
              ? "Confirm all items in this fictional order have been checked and packed."
              : operation === "collect"
                ? "Confirm the customer has collected the entire fictional order."
                : operation === "deliver"
                  ? "Confirm the entire fictional order has been delivered locally."
                  : "Confirm the entire fictional order has been handed to the postal carrier."}
          </p>
          <label className="owner-stock-confirm">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            I checked the entire fictional order and confirm this action. This
            records no real shipment.
          </label>
          <button
            type="button"
            className="admin-primary-button"
            disabled={!ack}
            onClick={submit}
          >
            {labels[operation]}
          </button>
        </fieldset>
      )}
      {pending && (
        <section aria-label="Saved fulfillment request">
          <h2>Original request</h2>
          <p>{labels[pending.operation]}</p>
          <p className="commerce-workspace-reference">
            Reference: {pending.requestId}
          </p>
          <div className="checkout-order-actions">
            <button
              type="button"
              disabled={busy || blocked}
              onClick={() => void perform(pending, "lookup")}
            >
              Check original request
            </button>
            <button
              type="button"
              disabled={busy || blocked || !canWrite}
              onClick={() => void perform(pending, "apply")}
            >
              Retry same request
            </button>
          </div>
        </section>
      )}
      <div ref={status} tabIndex={-1} role="status" aria-live="polite">
        {busy ? "Checking the original fulfillment request…" : message}
      </div>
      {receipt && (
        <section aria-label="Recorded fulfillment receipt">
          <h2>Action recorded</h2>
          <p>{labels[receipt.operation]}</p>
          <p className="commerce-workspace-reference">
            Reference: {receipt.requestId}
          </p>
          <a
            className="admin-primary-link"
            href={`/admin/commerce/orders/${encodeURIComponent(detail.orderId)}/fulfillment`}
          >
            Reload the latest order
          </a>
        </section>
      )}
      <section aria-label="Fulfillment history">
        <h2>Recorded history</h2>
        {detail.history.length ? (
          <ol>
            {detail.history.map((r) => (
              <li key={r.requestId}>
                <strong>{labels[r.operation]}</strong> ·{" "}
                <time dateTime={new Date(r.recordedAt).toISOString()}>
                  {new Intl.DateTimeFormat("en-CA", {
                    timeZone: "America/Toronto",
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(r.recordedAt)}{" "}
                  (Toronto)
                </time>
                <p className="commerce-workspace-reference">{r.requestId}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p>No packing or handoff has been recorded.</p>
        )}
      </section>
    </>
  );
}
