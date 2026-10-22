import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link } from "react-router";
import { useShoppingCart } from "./shopping-cart-context";
import {
  CANADIAN_REGIONS,
  CHECKOUT_CONTRACT_VERSION,
  CheckoutInputError,
  parseCheckoutInput,
  type CheckoutField,
  type CheckoutInput,
  type CheckoutQuote,
} from "../../lib/commerce/checkout";
import type { DeliveryMethod } from "../../lib/commerce/quote";
import { formatCad } from "../../lib/format-cad";
import { GoogleAddressSearch } from "./google-address-search";

const fields = [
  {
    key: "name",
    path: "contact.name",
    label: "Full name",
    autoComplete: "name",
    maxLength: 100,
  },
  {
    key: "email",
    path: "contact.email",
    label: "Email",
    autoComplete: "email",
    type: "email",
    maxLength: 254,
  },
  {
    key: "line1",
    path: "delivery.address.line1",
    label: "Street address",
    autoComplete: "shipping address-line1",
    maxLength: 150,
  },
  {
    key: "line2",
    path: "delivery.address.line2",
    label: "Apartment, unit, etc. (optional)",
    autoComplete: "shipping address-line2",
    maxLength: 150,
  },
  {
    key: "city",
    path: "delivery.address.city",
    label: "City",
    autoComplete: "shipping address-level2",
    maxLength: 100,
  },
  {
    key: "postalCode",
    path: "delivery.address.postalCode",
    label: "Postal code",
    autoComplete: "shipping postal-code",
    maxLength: 7,
  },
] as const;
const idFor = (path: string) => `checkout-${path.replaceAll(".", "-")}`;
const regionNames = {
  AB: "Alberta",
  BC: "British Columbia",
  MB: "Manitoba",
  NB: "New Brunswick",
  NL: "Newfoundland and Labrador",
  NS: "Nova Scotia",
  NT: "Northwest Territories",
  NU: "Nunavut",
  ON: "Ontario",
  PE: "Prince Edward Island",
  QC: "Quebec",
  SK: "Saskatchewan",
  YT: "Yukon",
};
type Details = Record<(typeof fields)[number]["key"], string> & {
  province: string;
  method: DeliveryMethod;
};
type Problem = { message: string; fields: CheckoutField[]; key: string };
type Review = { quote: CheckoutQuote; key: string };
type Attempt = {
  id: string;
  key: string;
  controller: AbortController;
  timer?: number;
};
const initialDetails: Details = {
  name: "",
  email: "",
  line1: "",
  line2: "",
  city: "",
  postalCode: "",
  province: "",
  method: "pickup",
};

// This is transient form state. Do not put it in the cart provider, browser
// storage, route search parameters or analytics. The optional Places adapter
// updates these same editable address fields and invalidates the quote.
export function DeliveryCheckout({
  placesKey = null,
}: {
  placesKey?: string | null;
}) {
  const cart = useShoppingCart();
  const cartKey = JSON.stringify(cart.lines);
  const [observedCart, setObservedCart] = useState(cartKey);
  const [details, setDetails] = useState(initialDetails);
  const [review, setReview] = useState<Review | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const errorSummary = useRef<HTMLDivElement>(null);
  const active = useRef<Attempt | null>(null);
  const detailsRevision = useRef(0);
  // A changed-then-restored cart must not resurrect its old quote/confirmation.
  if (observedCart !== cartKey) {
    setObservedCart(cartKey);
    setReview(null);
    setProblem(null);
    setPending(null);
    setConfirmed(null);
  }
  // Memory-only comparison, not sent as a URL or persisted correlation token.
  const key = JSON.stringify([cart.lines, details]);
  const current = review?.key === key ? review.quote : null;
  const expired = !!current && current.expiresAt <= now;
  const quote = expired ? null : current;
  const error = problem?.key === key ? problem : null;
  const busy = pending === key;

  useLayoutEffect(() => {
    return () => {
      // Invalidate in the cart commit, before the keyed Places adapter's passive
      // cleanup. Even A → B → A must reject a selection started for the old A.
      // Keep ref mutations out of render, which React may discard or retry.
      detailsRevision.current += 1;
      active.current?.controller.abort();
      window.clearTimeout(active.current?.timer);
      active.current = null;
    };
  }, [cartKey]);
  useEffect(() => {
    if (error) errorSummary.current?.focus();
  }, [error]);
  useEffect(() => {
    if (!current) return;
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 1000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [current]);

  function invalidate() {
    detailsRevision.current++;
    active.current?.controller.abort();
    window.clearTimeout(active.current?.timer);
    active.current = null;
    setPending(null);
    setReview(null);
    setConfirmed(null);
    setProblem(null);
  }
  function change(field: keyof Details, value: string) {
    invalidate();
    setDetails((previous) => ({ ...previous, [field]: value }));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cart.ready || !cart.lines.length || active.current?.key === key)
      return;
    invalidate();
    const attempt: Attempt = {
      id: crypto.randomUUID(),
      key,
      controller: new AbortController(),
    };
    const input = {
      contractVersion: CHECKOUT_CONTRACT_VERSION,
      requestId: attempt.id,
      lines: cart.lines,
      contact: { name: details.name, email: details.email },
      delivery: {
        method: details.method,
        address: {
          line1: details.line1,
          line2: details.line2,
          city: details.city,
          province: details.province,
          postalCode: details.postalCode,
          country: "CA",
        },
      },
    };
    let normalized: CheckoutInput;
    try {
      normalized = parseCheckoutInput(input);
    } catch (error) {
      setProblem({
        message: "Check the highlighted delivery details.",
        fields: error instanceof CheckoutInputError ? error.fields : [],
        key,
      });
      return;
    }
    active.current = attempt;
    setPending(key);
    attempt.timer = window.setTimeout(() => {
      if (active.current !== attempt) return;
      attempt.controller.abort();
      active.current = null;
      setPending(null);
      setProblem({
        message: "The test quote request timed out. Please retry.",
        fields: [],
        key,
      });
    }, 15_000);
    try {
      const response = await fetch("/checkout/quote", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        credentials: "same-origin",
        cache: "no-store",
        body: new URLSearchParams({ checkout: JSON.stringify(normalized) }),
        signal: attempt.controller.signal,
      });
      const raw: unknown = await response.json();
      if (!raw || typeof raw !== "object") throw new Error("Invalid response");
      const result = raw as Record<string, unknown>;
      if (active.current !== attempt) return;
      if (!response.ok) {
        setProblem({
          message:
            typeof result.error === "string"
              ? result.error
              : "A test quote could not be loaded. Please retry.",
          fields: Array.isArray(result.fields)
            ? result.fields.filter(
                (field: unknown): field is CheckoutField =>
                  typeof field === "string" &&
                  (fields.some((item) => item.path === field) ||
                    field === "delivery.address.province"),
              )
            : [],
          key,
        });
        return;
      }
      const value = result.quote as CheckoutQuote | undefined;
      if (
        !value ||
        value.requestId !== attempt.id ||
        value.contractVersion !== CHECKOUT_CONTRACT_VERSION ||
        value.testOnly !== true ||
        value.currency !== "CAD" ||
        !/^fictional-[a-z0-9-]{1,80}$/.test(value.rulesVersion) ||
        ![
          value.subtotalCents,
          value.shippingCents,
          value.taxCents,
          value.totalCents,
        ].every((amount) => Number.isSafeInteger(amount) && amount >= 0) ||
        value.delivery !== details.method ||
        !Number.isSafeInteger(value.expiresAt) ||
        value.expiresAt <= Date.now() ||
        JSON.stringify(
          value.lines?.map((line) => ({
            variantId: line.variantId,
            quantity: line.quantity,
          })),
        ) !== cartKey
      ) {
        throw new Error("Invalid quote response");
      }
      setNow(Date.now());
      setReview({ quote: value, key });
    } catch {
      if (active.current === attempt)
        setProblem({
          message: "A test quote could not be loaded. Please retry.",
          fields: [],
          key,
        });
    } finally {
      window.clearTimeout(attempt.timer);
      if (active.current === attempt) {
        active.current = null;
        setPending(null);
      }
    }
  }
  function input(field: (typeof fields)[number]) {
    const invalid = error?.fields.includes(field.path);
    return (
      <div className="checkout-field" key={field.key}>
        <label htmlFor={idFor(field.path)}>{field.label}</label>
        <input
          id={idFor(field.path)}
          name={field.key}
          autoComplete={field.autoComplete}
          type={"type" in field ? field.type : "text"}
          maxLength={field.maxLength}
          required={field.key !== "line2"}
          value={details[field.key]}
          onChange={(event) => change(field.key, event.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${idFor(field.path)}-error` : undefined}
        />
        {invalid && (
          <p id={`${idFor(field.path)}-error`}>
            Check {field.label.toLowerCase()}.
          </p>
        )}
      </div>
    );
  }
  if (!cart.ready) return <p role="status">Loading your saved cart…</p>;
  if (!cart.lines.length)
    return (
      <div className="commerce-empty-cart">
        <h2>Your cart is empty</h2>
        <Link to="/shop">Browse products</Link>
      </div>
    );
  return (
    <div className="checkout-layout">
      <form
        className="checkout-form"
        method="post"
        action="/checkout/quote"
        noValidate
        onSubmit={submit}
      >
        <h2>Contact &amp; delivery</h2>
        <p>
          Details stay in this page for this visit. Use a fictional name, an
          example.invalid email and a fictional address.
        </p>
        {error && (
          <div
            className="commerce-alert"
            role="alert"
            ref={errorSummary}
            tabIndex={-1}
          >
            <p>{error.message}</p>
            {!!error.fields.length && (
              <ul>
                {error.fields.map((path) => (
                  <li key={path}>
                    <a
                      href={`#${idFor(path)}`}
                      onClick={(event) => {
                        event.preventDefault();
                        document.getElementById(idFor(path))?.focus();
                      }}
                    >
                      {fields.find((field) => field.path === path)?.label ??
                        "Province or territory"}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {fields.slice(0, 2).map(input)}
        <div className="checkout-field">
          <label htmlFor="checkout-method">Delivery method</label>
          <select
            id="checkout-method"
            value={details.method}
            onChange={(event) => change("method", event.target.value)}
          >
            <option value="pickup">Pickup</option>
            <option value="local_delivery">Local delivery</option>
            <option value="shipping">Shipping within Canada</option>
          </select>
        </div>
        {details.method !== "pickup" && (
          <fieldset className="checkout-address">
            <legend>Delivery address</legend>
            <GoogleAddressSearch
              key={`${details.method}:${cartKey}`}
              apiKey={placesKey}
              onSearchEdit={invalidate}
              onBegin={() => {
                invalidate();
                const revision = detailsRevision.current;
                return (address) => {
                  if (detailsRevision.current !== revision) return false;
                  invalidate();
                  setDetails((previous) => ({
                    ...previous,
                    ...address,
                    line2: previous.line2 || address.line2,
                  }));
                  return true;
                };
              }}
            />
            {fields.slice(2).map(input)}
            <div className="checkout-field">
              <label htmlFor={idFor("delivery.address.province")}>
                Province or territory
              </label>
              <select
                id={idFor("delivery.address.province")}
                name="province"
                autoComplete="shipping address-level1"
                required
                value={details.province}
                onChange={(event) => change("province", event.target.value)}
                aria-invalid={
                  error?.fields.includes("delivery.address.province") ||
                  undefined
                }
                aria-describedby={
                  error?.fields.includes("delivery.address.province")
                    ? "checkout-province-error"
                    : undefined
                }
              >
                <option value="">Choose a province or territory</option>
                {CANADIAN_REGIONS.map((region) => (
                  <option key={region} value={region}>
                    {regionNames[region]}
                  </option>
                ))}
              </select>
              {error?.fields.includes("delivery.address.province") && (
                <p id="checkout-province-error">
                  Choose a province or territory.
                </p>
              )}
            </div>
            <p>Country: Canada</p>
          </fieldset>
        )}
        <p className="commerce-small-print">
          Fictional test rules: pickup CAD 0; local delivery CAD 5 (ON, K1A
          only); Canadian shipping CAD 15. Test tax is 10% on items plus
          delivery. These are not business rates or delivery promises.
        </p>
        <button
          className="commerce-primary-button"
          type="submit"
          disabled={busy}
        >
          {busy ? "Checking test quote…" : "Get test quote"}
        </button>
        {busy && (
          <p role="status">
            Checking current prices, stock and test delivery charges…
          </p>
        )}
      </form>
      <aside className="commerce-summary" aria-label="Test quote review">
        <h2>Review your test quote</h2>
        {!quote && (
          <p role="status">
            {expired
              ? "This quote expired. Request a new quote before reviewing the amounts."
              : "Request a quote to see current items, delivery and tax. Changes require a new quote."}
          </p>
        )}
        {quote && (
          <>
            <ul className="checkout-quote-lines">
              {quote.lines.map((line) => (
                <li key={line.variantId}>
                  {line.name} · {line.colour} × {line.quantity}
                  <strong>{formatCad(line.lineTotalCents)}</strong>
                </li>
              ))}
            </ul>
            <dl className="commerce-totals">
              <dt>Items</dt>
              <dd>{formatCad(quote.subtotalCents)}</dd>
              <dt>Test delivery</dt>
              <dd>{formatCad(quote.shippingCents)}</dd>
              <dt>Fictional test tax</dt>
              <dd>{formatCad(quote.taxCents)}</dd>
              <dt>Total (CAD)</dt>
              <dd>{formatCad(quote.totalCents)}</dd>
            </dl>
            <p className="commerce-small-print">
              Test rules: {quote.rulesVersion}. Valid for up to 10 minutes.
              Items are not reserved.
            </p>
            <label className="checkout-confirm">
              <input
                type="checkbox"
                checked={confirmed === quote.requestId}
                onChange={(event) => {
                  setNow(Date.now());
                  setConfirmed(
                    event.target.checked && quote.expiresAt > Date.now()
                      ? quote.requestId
                      : null,
                  );
                }}
              />
              I have reviewed these fictional items and charges.
            </label>
            {confirmed === quote.requestId && (
              <p role="status">
                Test quote reviewed. No order or payment has been created.
              </p>
            )}
          </>
        )}
        <p>No payment is available in this local preview.</p>
      </aside>
    </div>
  );
}
