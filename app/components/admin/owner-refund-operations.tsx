import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { AdminShell } from "./admin-shell";
import { formatCad } from "../../lib/format-cad";
import type { OwnerRefundPage } from "../../lib/commerce/owner-refund-http.server";
import type {
  OwnerRefundInput,
  OwnerRefundReceipt,
  OwnerRefundState,
} from "../../lib/commerce/owner-refund";
const subscribe = () => () => {};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const labels: Record<OwnerRefundState, string> = {
  not_started: "No refund request recorded",
  prepared: "Refund request saved — result not verified",
  pending: "Refund pending with Stripe",
  succeeded: "Full test refund verified",
  review_required: "Refund needs review — do not issue another",
};
function original(key: string, detail: OwnerRefundPage["detail"]) {
  try {
    const raw = sessionStorage.getItem(key);
    const value = raw
      ? (JSON.parse(raw) as OwnerRefundInput)
      : detail.requestId && detail.requestVersion
        ? {
            requestId: detail.requestId,
            orderId: detail.orderId,
            expectedVersion: detail.requestVersion,
            acknowledge: true,
          }
        : null;
    if (
      value &&
      (Object.keys(value).sort().join() !==
        ["requestId", "orderId", "expectedVersion", "acknowledge"]
          .sort()
          .join() ||
        value.orderId !== detail.orderId ||
        !uuid.test(value.requestId) ||
        value.acknowledge !== true ||
        !Number.isSafeInteger(value.expectedVersion) ||
        value.expectedVersion < 1 ||
        (detail.requestId && detail.requestId !== value.requestId))
    )
      throw Error();
    return { input: value as OwnerRefundInput | null, error: "" };
  } catch {
    return {
      input: null,
      error:
        "Saved refund request or browser storage is unavailable. Ask the developer to recover the original request before another action.",
    };
  }
}
type Props = OwnerRefundPage & { transport?: typeof fetch };
export function OwnerRefundOperations(props: Props) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  return (
    <AdminShell localReservations>
      <section className="admin-panel owner-stock-operations">
        <h1>Test refund</h1>
        <p>
          <strong>Local Stripe Sandbox only.</strong> This test returns
          fictional funds to the original test payment method. It does not set
          the store's real refund policy.
        </p>
        <p className="commerce-workspace-reference">{props.detail.orderId}</p>
        {hydrated ? (
          <Controls
            key={`${props.instanceId}:${props.detail.orderId}`}
            {...props}
          />
        ) : (
          <p>Preparing refund controls…</p>
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
function Controls({
  detail,
  instanceId,
  canWrite,
  canQuery,
  transport = fetch,
}: Props) {
  const key = `commerce-owner-refund-v1:${instanceId}:${detail.orderId}`;
  const [initial] = useState(() => original(key, detail));
  const [pending, setPending] = useState(initial.input),
    [blocked, setBlocked] = useState(!!initial.error),
    [busy, setBusy] = useState(false),
    [ack, setAck] = useState(false),
    [receipt, setReceipt] = useState<OwnerRefundReceipt | null>(null),
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
  const current = receipt ?? detail;
  async function perform(
    input: OwnerRefundInput,
    intent: "start" | "query" | "lookup",
  ) {
    if (
      active.current ||
      blocked ||
      (intent === "start" && !canWrite) ||
      (intent === "query" && !canQuery)
    )
      return;
    active.current = true;
    setBusy(true);
    setMessage("");
    const controller = new AbortController();
    abort.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 25000);
    try {
      const response = await transport(
        `/admin/commerce/orders/${encodeURIComponent(detail.orderId)}/refund/commands`,
        {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            intent,
            requestId: input.requestId,
            expectedVersion: String(input.expectedVersion),
            acknowledge: "true",
          }),
        },
      );
      const body = (await response.json()) as {
        state?: string;
        receipt?: OwnerRefundReceipt;
      };
      if (!mounted.current) return;
      if (!response.ok) throw Error();
      if (intent === "lookup" && body.state === "not_recorded") {
        setMessage(
          "The original request is not visible yet. This does not prove failure. Keep it and ask the developer to investigate; do not submit another refund.",
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
        !Object.hasOwn(labels, r.state) ||
        r.state === "not_started" ||
        r.amountCents !== detail.amountCents ||
        !Number.isSafeInteger(r.refundedCents) ||
        r.refundedCents < 0 ||
        r.refundedCents > r.amountCents ||
        (r.state === "succeeded" && r.refundedCents !== r.amountCents)
      )
        throw Error();
      setReceipt(r);
      setMessage(
        labels[r.state] + ". Stock has not been returned or released.",
      );
      if (r.state === "succeeded") {
        try {
          sessionStorage.removeItem(key);
          if (sessionStorage.getItem(key) !== null) throw Error();
          setPending(null);
        } catch {
          setBlocked(true);
          setMessage(
            "Refund verified, but browser recovery storage could not be cleared. Ask the developer to recover it.",
          );
        }
      }
    } catch {
      if (mounted.current)
        setMessage(
          "Refund result is unconfirmed. Keep the original request and check its status. Do not issue another refund or hand over goods.",
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
      !detail.canStart ||
      !ack
    )
      return;
    const input: OwnerRefundInput = {
      requestId: crypto.randomUUID(),
      orderId: detail.orderId,
      expectedVersion: detail.orderVersion,
      acknowledge: true,
    };
    try {
      sessionStorage.setItem(key, JSON.stringify(input));
      if (sessionStorage.getItem(key) !== JSON.stringify(input)) throw Error();
    } catch {
      setBlocked(true);
      setMessage(
        "Browser storage could not preserve the request. No refund request was sent.",
      );
      return;
    }
    setPending(input);
    void perform(input, "start");
  }
  return (
    <>
      <dl className="commerce-workspace-facts">
        <div>
          <dt>Refund status</dt>
          <dd>{labels[current.state]}</dd>
        </div>
        <div>
          <dt>Original captured amount</dt>
          <dd>{formatCad(detail.amountCents)} CAD</dd>
        </div>
        <div>
          <dt>Verified refunded amount</dt>
          <dd>{formatCad(current.refundedCents)} CAD</dd>
        </div>
      </dl>
      <p>
        This first test action refunds the entire original Stripe capture,
        including the saved test delivery and tax amount. Partial refunds and
        PayPal refunds are separate upcoming work.
      </p>
      <p>
        A recorded request stops further packing and handoff. Refunding money
        never automatically adds stock back or releases allocated stock;
        inspection and stock disposition are separate actions.
      </p>
      {detail.provider !== "stripe" && (
        <p role="status">
          This order has no eligible Stripe capture. No refund can be started
          here.
        </p>
      )}
      {!canWrite && (
        <p>
          New refund requests are paused. Saved requests and status can still be
          viewed.
        </p>
      )}
      {detail.canStart && !pending && !receipt && (
        <fieldset disabled={busy || blocked || !canWrite}>
          <legend>Confirm full fictional refund</legend>
          <label className="owner-stock-confirm">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            I reviewed this fictional order and authorize its full{" "}
            {formatCad(detail.amountCents)} CAD test refund.
          </label>
          <button
            type="button"
            className="admin-primary-button"
            disabled={!ack}
            onClick={start}
          >
            Refund full test amount
          </button>
        </fieldset>
      )}
      {pending && current.state !== "succeeded" && (
        <section aria-label="Original refund request">
          <h2>Keep this original request</h2>
          <p className="commerce-workspace-reference">{pending.requestId}</p>
          <p>
            Checking a status never starts a second refund. An uncertain request
            cannot be retried with a new reference.
          </p>
          <div className="checkout-order-actions">
            <button
              type="button"
              disabled={busy || blocked}
              onClick={() => void perform(pending, "lookup")}
            >
              Check saved request
            </button>
            <button
              type="button"
              disabled={busy || blocked || !canQuery}
              onClick={() => void perform(pending, "query")}
            >
              Check Stripe refund status
            </button>
          </div>
        </section>
      )}
      <div ref={status} tabIndex={-1} role="status" aria-live="polite">
        {busy ? "Checking only the original refund request…" : message}
      </div>
      {receipt?.state === "succeeded" && (
        <p>
          <a
            className="admin-primary-link"
            href={`/admin/commerce/orders/${encodeURIComponent(detail.orderId)}/refund`}
          >
            Reload verified refund status
          </a>
        </p>
      )}
    </>
  );
}
