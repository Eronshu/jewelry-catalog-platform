import { useEffect, useRef, useState } from "react";
import type { OwnedCheckoutOrder } from "../../lib/commerce/checkout-flow.server";
import type { OwnedStripePayment } from "../../lib/commerce/owned-stripe.server";

function safeHostedUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.origin === "https://checkout.stripe.com" &&
      !url.username &&
      !url.password
      ? value
      : null;
  } catch {
    return null;
  }
}
export function StripeCheckout({
  order,
  initial,
  csrfToken,
  returned = false,
  disabled = false,
  onOrderChanged,
  onBusyChanged,
}: {
  order: OwnedCheckoutOrder;
  initial: OwnedStripePayment;
  csrfToken: string;
  returned?: boolean;
  onOrderChanged: (order: OwnedCheckoutOrder) => void;
  onBusyChanged: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const [payment, setPayment] = useState(initial);
  const [busy, setBusy] = useState<"start" | "query" | null>(null);
  const [error, setError] = useState("");
  const active = useRef(false);
  const key = useRef<string | null>(null);
  const alert = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);
  async function submit(operation: "start" | "query") {
    if (active.current || disabled) return;
    active.current = true;
    setBusy(operation);
    onBusyChanged(true);
    setError("");
    key.current ??= crypto.randomUUID();
    const controller = new AbortController();
    // Canonical account/Session/PI/Charge reads can take longer than one HTTP request.
    const timer = window.setTimeout(() => controller.abort(), 55000);
    try {
      const response = await fetch(`/checkout/orders/${order.id}/stripe`, {
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
        stripe?: OwnedStripePayment;
        order?: OwnedCheckoutOrder;
      };
      if (
        !response.ok ||
        !body.stripe ||
        !body.order ||
        body.order.id !== order.id ||
        ![
          "not_started",
          "open",
          "checking",
          "paid",
          "expired",
          "review_required",
        ].includes(body.stripe.state)
      )
        throw new Error("unverified");
      setPayment(body.stripe);
      onOrderChanged(body.order);
    } catch {
      setError(
        "The result is uncertain. Check this same order again; do not pay a second time. Your items remain protected while payment is reviewed.",
      );
      // A lost start response can have created a Session. The next action is query, never a new payment.
      setPayment((value) => ({
        ...value,
        state: "checking",
        hostedUrl: null,
        canStart: false,
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
    payment.state === "open" ? safeHostedUrl(payment.hostedUrl) : null;
  return (
    <section
      className="checkout-order stripe-checkout"
      aria-label="Stripe test payment"
      aria-busy={busy !== null}
    >
      <h2>Stripe Sandbox payment</h2>
      <p>
        Fictional order and test funds only. Enter only Stripe test card details
        on Stripe’s hosted page. This does not enable real purchases.
      </p>
      {returned && (
        <p role="status">
          You returned from Stripe. Returning does not prove payment; check the
          provider result below.
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
              not_started: "Ready to start one Stripe test payment.",
              open: "A test payment page is ready. Continue the same payment or check its status.",
              checking:
                "Payment is being checked. Keep this order; do not start another payment.",
              paid: "Test payment verified and items allocated to this order.",
              expired:
                "The test payment page expired. Items remain protected pending review; no new payment is offered.",
              review_required:
                "Payment needs review. Items remain protected; contact the test operator before trying again.",
            } as const
          )[payment.state]
        }
      </p>
      <div className="checkout-order-actions">
        {payment.canStart && (
          <button
            type="button"
            className="commerce-primary-button"
            disabled={busy !== null || disabled}
            onClick={() => void submit("start")}
          >
            {busy === "start" ? "Preparing Stripe…" : "Pay with Stripe (test)"}
          </button>
        )}
        {hosted && busy === null && !disabled && (
          <a
            className="commerce-primary-button"
            href={hosted}
            rel="noreferrer"
            referrerPolicy="no-referrer"
          >
            Continue to Stripe test payment
          </a>
        )}
        {payment.canQuery && (
          <button
            type="button"
            className="commerce-secondary-button"
            disabled={busy !== null || disabled}
            onClick={() => void submit("query")}
          >
            {busy === "query" ? "Checking Stripe…" : "Check payment result"}
          </button>
        )}
      </div>
      <p>
        No automatic second charge or stock release occurs after a timeout,
        cancellation at Stripe, or an expired page. Test operator review may be
        needed.
      </p>
    </section>
  );
}
