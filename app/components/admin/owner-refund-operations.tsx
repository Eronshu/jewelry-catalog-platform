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
  pending: "Refund pending with payment provider",
  succeeded: "Full test refund verified",
  partially_refunded: "Partial test refund verified",
  review_required: "Refund needs review — do not issue another",
};
function providerName(provider: OwnerRefundPage["detail"]["provider"]) {
  return provider === "stripe"
    ? "Stripe"
    : provider === "paypal"
      ? "PayPal"
      : "payment provider";
}
function statusLabel(
  state: OwnerRefundState,
  provider: OwnerRefundPage["detail"]["provider"],
) {
  return state === "pending"
    ? `Refund pending with ${providerName(provider)}`
    : labels[state];
}
function cents(value: string) {
  if (!/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}
function original(key: string, detail: OwnerRefundPage["detail"]) {
  try {
    const raw = sessionStorage.getItem(key);
    const value = raw
      ? (JSON.parse(raw) as OwnerRefundInput)
      : detail.requestId &&
          detail.requestVersion &&
          !detail.canStart &&
          !detail.canStartPartial &&
          detail.state !== "succeeded" &&
          detail.state !== "partially_refunded"
        ? {
            requestId: detail.requestId,
            orderId: detail.orderId,
            expectedVersion: detail.requestVersion,
            acknowledge: true,
            ...(detail.currentRequestRefundCents != null &&
            detail.currentRequestPriorRefundedCents != null
              ? {
                  refundCents: detail.currentRequestRefundCents,
                  expectedRefundedCents:
                    detail.currentRequestPriorRefundedCents,
                }
              : {}),
          }
        : null;
    const partial =
      value && ("refundCents" in value || "expectedRefundedCents" in value);
    const keys = [
      "requestId",
      "orderId",
      "expectedVersion",
      "acknowledge",
      ...(partial ? ["refundCents", "expectedRefundedCents"] : []),
    ];
    if (
      value &&
      (Object.keys(value).sort().join() !== keys.sort().join() ||
        value.orderId !== detail.orderId ||
        !uuid.test(value.requestId) ||
        value.acknowledge !== true ||
        !Number.isSafeInteger(value.expectedVersion) ||
        value.expectedVersion < 1 ||
        (detail.requestId !== null && detail.requestId !== value.requestId) ||
        (partial &&
          (detail.provider !== "stripe" ||
            !Number.isSafeInteger(value.refundCents) ||
            value.refundCents! <= 0 ||
            !Number.isSafeInteger(value.expectedRefundedCents) ||
            value.expectedRefundedCents! < 0 ||
            value.refundCents! + value.expectedRefundedCents! >
              detail.amountCents)))
    )
      throw Error();
    return { input: value as OwnerRefundInput | null, error: "" };
  } catch {
    return {
      input: null,
      error:
        "Saved refund request conflicts with the current record, or browser storage is unavailable. Keep the saved request and ask the developer to recover it before another action.",
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
          <strong>Local Stripe and PayPal Sandbox only.</strong> This test
          returns fictional funds to the original test payment method. It does
          not set the store's real refund policy.
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
    [amount, setAmount] = useState(
      ((detail.remainingCents ?? detail.amountCents) / 100).toFixed(2),
    ),
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
  const partial =
    detail.provider === "stripe" && detail.canStartPartial === true;
  const requested = cents(amount);
  const remaining =
    detail.remainingCents ??
    Math.max(0, detail.amountCents - detail.refundedCents);
  const validAmount = requested !== null && requested <= remaining;
  const verifiedTotal =
    receipt?.state === "succeeded"
      ? receipt.expectedRefundedCents !== undefined
        ? receipt.expectedRefundedCents + receipt.refundedCents
        : receipt.refundedCents
      : detail.refundedCents;
  const currentLabel =
    receipt?.refundCents !== undefined && receipt.state === "succeeded"
      ? "Test refund verified — reload the remaining balance"
      : statusLabel(current.state, detail.provider);
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
            ...(input.refundCents !== undefined
              ? {
                  refundCents: String(input.refundCents),
                  expectedRefundedCents: String(input.expectedRefundedCents),
                }
              : {}),
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
        r.state === "partially_refunded" ||
        r.amountCents !== detail.amountCents ||
        !Number.isSafeInteger(r.refundedCents) ||
        r.refundedCents < 0 ||
        r.refundedCents > r.amountCents ||
        (input.refundCents !== undefined
          ? r.refundCents !== input.refundCents ||
            r.expectedRefundedCents !== input.expectedRefundedCents ||
            (r.state === "succeeded" &&
              r.refundedCents !== input.refundCents) ||
            (r.state !== "succeeded" && r.refundedCents !== 0)
          : r.refundCents !== undefined ||
            r.expectedRefundedCents !== undefined ||
            (r.state === "succeeded" && r.refundedCents !== r.amountCents))
      )
        throw Error();
      setReceipt(r);
      setMessage(
        (r.refundCents !== undefined && r.state === "succeeded"
          ? "Test refund verified — reload the remaining balance"
          : statusLabel(r.state, detail.provider)) +
          ". Stock has not been returned or released.",
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
      !(detail.canStart || partial) ||
      (partial && !validAmount) ||
      !ack
    )
      return;
    const input: OwnerRefundInput = {
      requestId: crypto.randomUUID(),
      orderId: detail.orderId,
      expectedVersion: detail.orderVersion,
      acknowledge: true,
      ...(partial
        ? {
            refundCents: requested!,
            expectedRefundedCents: detail.refundedCents,
          }
        : {}),
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
          <dd>{currentLabel}</dd>
        </div>
        <div>
          <dt>Original captured amount</dt>
          <dd>{formatCad(detail.amountCents)} CAD</dd>
        </div>
        <div>
          <dt>Verified refunded amount</dt>
          <dd>{formatCad(verifiedTotal)} CAD</dd>
        </div>
        <div>
          <dt>Remaining refundable amount</dt>
          <dd>
            {formatCad(Math.max(0, detail.amountCents - verifiedTotal))} CAD
          </dd>
        </div>
      </dl>
      <p>
        {detail.provider === "stripe" &&
        detail.canStartPartial !== undefined ? (
          "Enter a fictional Stripe refund amount up to the verified remaining balance. Each result must be verified before another refund."
        ) : (
          <>
            This test action refunds the entire original{" "}
            {providerName(detail.provider)} capture, including the saved test
            delivery and tax amount.
          </>
        )}
      </p>
      {!!detail.history?.length && (
        <section aria-label="Recorded test refunds">
          <h2>Refund history</h2>
          <ol>
            {detail.history.map((item) => (
              <li key={item.requestId}>
                {formatCad(item.refundCents ?? item.amountCents)} CAD requested
                ·{" "}
                {item.state === "succeeded"
                  ? "Verified"
                  : statusLabel(item.state, detail.provider)}{" "}
                · {formatCad(item.refundedCents)} CAD verified for this request
              </li>
            ))}
          </ol>
        </section>
      )}
      <p>
        A recorded request stops further packing and handoff. Refunding money
        never automatically adds stock back or releases allocated stock;
        inspection and stock disposition are separate actions.
      </p>
      {!detail.provider && (
        <p role="status">
          This order has no eligible online capture. No refund can be started
          here.
        </p>
      )}
      {!canWrite && (
        <p>
          New refund requests are paused. Saved requests and status can still be
          viewed.
        </p>
      )}
      {(detail.canStart || partial) && !pending && !receipt && (
        <fieldset disabled={busy || blocked || !canWrite}>
          <legend>
            {partial
              ? "Confirm fictional refund amount"
              : "Confirm full fictional refund"}
          </legend>
          {partial && (
            <label>
              Refund amount (CAD)
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                aria-invalid={!validAmount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setAck(false);
                }}
              />
              {!validAmount && (
                <span>
                  Enter an amount from 0.01 to {(remaining / 100).toFixed(2)}{" "}
                  CAD, with at most two decimal places.
                </span>
              )}
            </label>
          )}
          <label className="owner-stock-confirm">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            I reviewed this fictional order and authorize{" "}
            {partial ? "this" : "its full"}{" "}
            {formatCad(partial ? (requested ?? 0) : detail.amountCents)} CAD
            test refund.
          </label>
          <button
            type="button"
            className="admin-primary-button"
            disabled={!ack || (partial && !validAmount)}
            onClick={start}
          >
            {partial ? "Refund test amount" : "Refund full test amount"}
          </button>
        </fieldset>
      )}
      {pending && receipt?.state !== "succeeded" && (
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
              Check {providerName(detail.provider)} refund status
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
