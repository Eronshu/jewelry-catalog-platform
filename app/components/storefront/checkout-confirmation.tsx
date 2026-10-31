import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useShoppingCart } from "./shopping-cart-context";
import { formatCad } from "../../lib/format-cad";
import type { TestCheckoutSelection } from "../../lib/commerce/checkout-acceptance.server";
import type {
  CheckoutConfirmationData,
  OwnedCheckoutOrder,
} from "../../lib/commerce/checkout-flow.server";
type Quote = Pick<
  OwnedCheckoutOrder,
  "lines" | "subtotalCents" | "shippingCents" | "taxCents" | "totalCents"
> & { quoteId: string; expiresAt: number };
type Attempt = {
  selection: TestCheckoutSelection;
  key: string;
  issueKey: string;
  acceptanceKey: string;
  createKey: string;
  revision: number;
};
export function CheckoutAmounts({
  quote,
}: {
  quote: Pick<
    OwnedCheckoutOrder,
    "subtotalCents" | "shippingCents" | "taxCents" | "totalCents"
  >;
}) {
  return (
    <dl className="commerce-totals">
      <dt>Items</dt>
      <dd>{formatCad(quote.subtotalCents)}</dd>
      <dt>Fictional delivery</dt>
      <dd>{formatCad(quote.shippingCents)}</dd>
      <dt>Fictional test tax</dt>
      <dd>{formatCad(quote.taxCents)}</dd>
      <dt>Total (CAD)</dt>
      <dd>{formatCad(quote.totalCents)}</dd>
    </dl>
  );
}
export function CheckoutConfirmation({
  data,
}: {
  data: CheckoutConfirmationData;
}) {
  const cart = useShoppingCart();
  const navigate = useNavigate();
  const [profile, setProfile] =
    useState<TestCheckoutSelection["fixtureProfileId"]>("fixture-ontario");
  const [method, setMethod] =
    useState<TestCheckoutSelection["deliveryMethod"]>("pickup");
  const [quote, setQuote] = useState<
    (Quote & { selectionKey: string; revision: number }) | null
  >(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [now, setNow] = useState(Date.now);
  const attempt = useRef<Attempt | null>(null);
  const active = useRef(false);
  const errorBox = useRef<HTMLDivElement>(null);
  const selection: TestCheckoutSelection = {
    contractVersion: "local-checkout-v1",
    lines: cart.lines,
    fixtureProfileId: profile,
    deliveryMethod: method,
  };
  const key = JSON.stringify(selection);
  const [observedKey, setObservedKey] = useState(key);
  const [revision, setRevision] = useState(0);
  const [lastOperation, setLastOperation] = useState<"quote" | "confirm">(
    "quote",
  );
  if (observedKey !== key) {
    setObservedKey(key);
    setRevision(revision + 1);
    setAgreed(false);
  }
  const validQuote =
    quote &&
    ((quote.selectionKey === key && quote.revision === revision) || uncertain)
      ? quote
      : null;
  useEffect(() => {
    if (error) errorBox.current?.focus();
  }, [error]);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  // Displayed consent is tied to the current immutable quote and selection.
  const reviewed = agreed && validQuote !== null && validQuote.expiresAt > now;
  function changeSelection(change: () => void) {
    if (active.current || uncertain) return;
    change();
    setQuote(null);
    setAgreed(false);
    attempt.current = null;
    setError("");
  }
  async function send(operation: "quote" | "confirm", fresh = false) {
    if (active.current || !data.canCreate || !cart.ready || !cart.lines.length)
      return;
    if (operation === "confirm" && !reviewed && !uncertain) return;
    if (
      !attempt.current ||
      (!uncertain && (fresh || attempt.current.key !== key))
    ) {
      attempt.current = {
        selection: structuredClone(selection),
        key,
        issueKey: crypto.randomUUID(),
        acceptanceKey: crypto.randomUUID(),
        createKey: crypto.randomUUID(),
        revision,
      };
      setAgreed(false);
    }
    const current = attempt.current;
    setLastOperation(operation);
    if (operation === "quote" && !uncertain) {
      setQuote(null);
      setAgreed(false);
    }
    active.current = true;
    setBusy(true);
    setError("");
    const form = new URLSearchParams({
      operation,
      csrf: data.csrfToken,
      selection: JSON.stringify(current.selection),
    });
    if (operation === "quote") form.set("issueKey", current.issueKey);
    else {
      form.set("quoteId", quote!.quoteId);
      form.set("acceptanceKey", current.acceptanceKey);
      form.set("createKey", current.createKey);
      form.set("acknowledge", "yes");
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("/checkout/commands", {
        method: "POST",
        body: form,
        signal: controller.signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        redirect: "error",
      });
      const body = (await response.json()) as {
        quote?: Quote;
        orderId?: string;
        error?: string;
        retrySame?: boolean;
      };
      if (!response.ok) {
        setUncertain(body.retrySame ?? response.status >= 500);
        setError(body.error ?? "The request could not be completed.");
        return;
      }
      setUncertain(false);
      if (body.orderId) {
        await navigate(`/checkout/orders/${encodeURIComponent(body.orderId)}`);
        return;
      }
      if (!body.quote) throw new Error();
      setQuote({
        ...body.quote,
        selectionKey: current.key,
        revision: current.revision,
      });
      setAgreed(false);
      setNow(Date.now());
    } catch {
      setUncertain(true);
      setError(
        "The response was lost or timed out. Retry this same request, or reload Your pending orders before starting again. Your cart is unchanged.",
      );
    } finally {
      window.clearTimeout(timer);
      active.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <p>
        <strong>Fictional local order only.</strong> This step uses a fixed
        synthetic profile. The name/address you entered in delivery preview is
        not saved or carried forward. No real purchase or payment is possible.
      </p>
      <section
        className="checkout-pending-orders"
        aria-label="Your pending orders"
      >
        <h2>Your pending orders</h2>
        {data.pending.length ? (
          <ul>
            {data.pending.map((order) => (
              <li key={order.id}>
                <Link to={`/checkout/orders/${order.id}`}>
                  Open test order · {formatCad(order.totalCents)}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p>No pending order is visible in this browser session.</p>
        )}
        <a href="/checkout/confirm">Reload your pending orders</a>
      </section>
      {error && (
        <div
          ref={errorBox}
          role="alert"
          tabIndex={-1}
          className="commerce-alert"
        >
          <p>{error}</p>
        </div>
      )}
      {!data.canCreate ? (
        <p role="status">
          New test orders are paused. Your existing orders can still be opened,
          refreshed or cancelled.
        </p>
      ) : !cart.ready ? (
        <p role="status">Restoring your cart…</p>
      ) : !cart.lines.length ? (
        <p>
          Your cart is empty. <Link to="/shop">Browse fictional products</Link>
        </p>
      ) : (
        <div className="checkout-layout">
          <section className="checkout-form">
            <h2>Choose fixed test details</h2>
            <fieldset className="checkout-address" disabled={busy || uncertain}>
              <legend>Fictional profile and delivery</legend>
              <div className="checkout-field">
                <label htmlFor="fixture-profile">Synthetic profile</label>
                <select
                  id="fixture-profile"
                  value={profile}
                  onChange={(event) =>
                    changeSelection(() => {
                      setProfile(event.target.value as typeof profile);
                      if (
                        event.target.value === "fixture-bc" &&
                        method === "local_delivery"
                      )
                        setMethod("shipping");
                    })
                  }
                >
                  <option value="fixture-ontario">
                    Fictional Ontario profile
                  </option>
                  <option value="fixture-bc">
                    Fictional British Columbia profile
                  </option>
                </select>
              </div>
              <div className="checkout-field">
                <label htmlFor="fixture-delivery">Delivery method</label>
                <select
                  id="fixture-delivery"
                  value={method}
                  onChange={(event) =>
                    changeSelection(() =>
                      setMethod(event.target.value as typeof method),
                    )
                  }
                >
                  <option value="pickup">Pickup · test CAD 0</option>
                  <option
                    value="local_delivery"
                    disabled={profile !== "fixture-ontario"}
                  >
                    Local delivery · test CAD 5 (Ontario only)
                  </option>
                  <option value="shipping">
                    Canadian shipping · test CAD 15
                  </option>
                </select>
              </div>
            </fieldset>
            <p>
              Test tax: 10% on items and delivery. These are invented test
              rules, not Canadian tax advice or business promises. Stock is held
              only after you confirm.
            </p>
            <button
              className="commerce-primary-button"
              type="button"
              disabled={busy || uncertain}
              onClick={() => void send("quote", true)}
            >
              Review final test amount
            </button>
            {uncertain && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void send(lastOperation)}
              >
                Retry the same request
              </button>
            )}
            <p>
              <Link to="/cart">Edit cart</Link>
            </p>
          </section>
          <section
            className="commerce-summary"
            aria-label="Final order confirmation"
          >
            <h2>Final test amount</h2>
            {validQuote ? (
              <>
                <ul className="checkout-quote-lines">
                  {validQuote.lines.map((line, index) => (
                    <li key={index}>
                      {line.name} · {line.colour} × {line.quantity}
                      <strong>{formatCad(line.lineTotalCents)}</strong>
                    </li>
                  ))}
                </ul>
                <CheckoutAmounts quote={validQuote} />
                <p>
                  Reservation ends at{" "}
                  {new Date(validQuote.expiresAt).toLocaleTimeString()}. This
                  confirmation does not take payment.
                </p>
                {validQuote.expiresAt <= now && !uncertain && (
                  <p role="status">
                    Quote expired. Review a fresh amount before confirming.
                  </p>
                )}
                <label className="checkout-confirm">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    disabled={busy || uncertain || validQuote.expiresAt <= now}
                    onChange={(event) => setAgreed(event.target.checked)}
                  />
                  I agree to this fictional total and want to reserve these test
                  items.
                </label>
                <button
                  type="button"
                  className="commerce-primary-button"
                  disabled={busy || uncertain || !reviewed}
                  onClick={() => void send("confirm")}
                >
                  Create unpaid test order
                </button>
              </>
            ) : (
              <p>
                Review the server-calculated total before agreeing. A changed
                cart or selection requires a fresh quote.
              </p>
            )}
            {busy && (
              <p role="status">
                Checking your request… Do not start another order.
              </p>
            )}
          </section>
        </div>
      )}
    </>
  );
}
