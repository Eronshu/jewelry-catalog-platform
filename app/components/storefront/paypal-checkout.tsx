import { useEffect, useRef, useState } from "react";
import type { OwnedCheckoutOrder } from "../../lib/commerce/checkout-flow.server";
import type { OwnedPayPalPayment } from "../../lib/commerce/owned-paypal.server";

function approvalLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.origin === "https://www.sandbox.paypal.com" &&
      !url.username &&
      !url.password
      ? value
      : null;
  } catch {
    return null;
  }
}
export function PayPalCheckout({
  order,
  initial,
  csrfToken,
  returned = false,
  disabled = false,
  onOrderChanged,
  onBusyChanged,
}: {
  order: OwnedCheckoutOrder;
  initial: OwnedPayPalPayment;
  csrfToken: string;
  returned?: boolean;
  disabled?: boolean;
  onOrderChanged: (order: OwnedCheckoutOrder) => void;
  onBusyChanged: (busy: boolean) => void;
}) {
  const [payment, setPayment] = useState(initial),
    [busy, setBusy] = useState<"start" | "query" | "capture" | null>(null),
    [error, setError] = useState("");
  const active = useRef(false),
    key = useRef<string | null>(null),
    alert = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);
  async function submit(operation: "start" | "query" | "capture") {
    if (active.current || disabled) return;
    active.current = true;
    setBusy(operation);
    onBusyChanged(true);
    setError("");
    key.current ??= crypto.randomUUID();
    const controller = new AbortController(),
      timer = window.setTimeout(() => controller.abort(), 55000);
    try {
      const response = await fetch(`/checkout/orders/${order.id}/paypal`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          csrf: csrfToken,
          operation,
          requestId: key.current,
          expectedVersion: String(order.version),
        }),
      });
      const body = (await response.json()) as {
        paypal?: OwnedPayPalPayment;
        order?: OwnedCheckoutOrder;
      };
      if (
        !response.ok ||
        !body.paypal ||
        !body.order ||
        body.order.id !== order.id ||
        ![
          "not_started",
          "open",
          "approved",
          "checking",
          "paid",
          "review_required",
        ].includes(body.paypal.state)
      )
        throw new Error("Unverified result");
      setPayment(body.paypal);
      onOrderChanged(body.order);
    } catch {
      setError(
        "The payment result is uncertain. Check this same order again; do not start another payment or repeat capture. Items remain protected while payment is reviewed.",
      );
      setPayment((previous) => ({
        ...previous,
        state: "checking",
        approvalUrl: null,
        canStart: false,
        canCapture: false,
        canQuery: true,
      }));
    } finally {
      window.clearTimeout(timer);
      active.current = false;
      setBusy(null);
      onBusyChanged(false);
    }
  }
  const hosted =
    payment.state === "open" ? approvalLink(payment.approvalUrl) : null;
  return (
    <section
      className="checkout-order stripe-checkout"
      aria-label="PayPal test payment"
      aria-busy={busy !== null}
    >
      <h2>PayPal Sandbox payment</h2>
      <p>
        Fictional order and test funds only. Use your PayPal Sandbox personal
        account on PayPal’s hosted page. No real purchase is available.
      </p>
      {returned && (
        <p role="status">
          You returned from PayPal. Approval and a return URL do not prove
          payment; check the provider result before completing payment.
        </p>
      )}
      {error && (
        <div role="alert" tabIndex={-1} ref={alert}>
          <p>{error}</p>
        </div>
      )}
      <p role="status">
        {
          (
            {
              not_started: "Ready to start one PayPal test payment.",
              open: "A PayPal test approval page is ready. Continue the same payment, then check the result here.",
              approved:
                "PayPal approval verified. Complete the test payment below when available; approval alone is not a receipt.",
              checking:
                "Payment is being checked. Keep this order and do not pay again.",
              paid: "Test payment verified and items allocated to this order.",
              review_required:
                "Payment needs review. Items stay protected; contact the test operator before trying again.",
            } as const
          )[payment.state]
        }
      </p>
      <div className="checkout-order-actions">
        {payment.canStart && (
          <button
            className="commerce-primary-button"
            type="button"
            disabled={busy !== null || disabled}
            onClick={() => void submit("start")}
          >
            {busy === "start" ? "Preparing PayPal…" : "Pay with PayPal (test)"}
          </button>
        )}
        {hosted && !busy && !disabled && (
          <a
            className="commerce-primary-button"
            href={hosted}
            rel="noreferrer"
            referrerPolicy="no-referrer"
          >
            Continue to PayPal test approval
          </a>
        )}
        {payment.canCapture && (
          <button
            className="commerce-primary-button"
            type="button"
            disabled={busy !== null || disabled}
            onClick={() => void submit("capture")}
          >
            {busy === "capture"
              ? "Completing test payment…"
              : "Complete PayPal test payment"}
          </button>
        )}
        {payment.canQuery && (
          <button
            className="commerce-secondary-button"
            type="button"
            disabled={busy !== null || disabled}
            onClick={() => void submit("query")}
          >
            {busy === "query" ? "Checking PayPal…" : "Check PayPal result"}
          </button>
        )}
      </div>
      <p>
        Returning, cancelling at PayPal, a timeout or approval alone never
        releases protected items or confirms payment. Do not switch payment
        methods to work around an unknown result.
      </p>
    </section>
  );
}
