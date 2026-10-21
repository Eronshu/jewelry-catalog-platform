import { useEffect, useId, useState } from "react";
import { Form, useNavigation } from "react-router";

import type {
  CartLine,
  DeliveryMethod,
  QuoteVariant,
  TestQuote,
} from "../../lib/commerce/quote";

const STORAGE_KEY = "velaform-local-test-cart-v1";

function restoreLines(raw: string | null): CartLine[] {
  if (!raw) return [];
  if (raw.length > 8192) throw new Error("Invalid stored cart");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length > 20) {
    throw new Error("Invalid stored cart");
  }
  const seen = new Set<string>();
  return parsed.map((line: unknown) => {
    if (!line || typeof line !== "object")
      throw new Error("Invalid stored cart");
    const { variantId, quantity } = line as Partial<CartLine>;
    if (
      typeof variantId !== "string" ||
      !variantId.trim() ||
      variantId.length > 128 ||
      seen.has(variantId) ||
      !Number.isSafeInteger(quantity) ||
      typeof quantity !== "number" ||
      quantity < 1 ||
      quantity > 20
    ) {
      throw new Error("Invalid stored cart");
    }
    seen.add(variantId);
    return { variantId, quantity };
  });
}

function money(cents: number) {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
  }).format(cents / 100);
}

export function CommerceCart({
  variants,
  quote,
  error,
}: {
  variants: QuoteVariant[];
  quote?: TestQuote;
  error?: string;
}) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [ready, setReady] = useState(false);
  const [delivery, setDelivery] = useState<DeliveryMethod>("pickup");
  const [localError, setLocalError] = useState("");
  const [staleQuote, setStaleQuote] = useState<TestQuote>();
  const [verifiedQuote, setVerifiedQuote] = useState<TestQuote>();
  const navigation = useNavigation();
  const prefix = useId();

  useEffect(() => {
    let mounted = true;
    // Read after hydration: SSR and the initial browser render both use an empty cart.
    Promise.resolve().then(() => {
      if (!mounted) return;
      try {
        setLines(restoreLines(window.localStorage.getItem(STORAGE_KEY)));
      } catch {
        setLocalError(
          "Your saved test cart could not be loaded. You can start a new cart.",
        );
      }
      setReady(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!quote) return;
    let mounted = true;
    Promise.resolve().then(() => {
      if (mounted && quote.expiresAt > Date.now()) setVerifiedQuote(quote);
    });
    const timer = window.setTimeout(
      () => setVerifiedQuote(undefined),
      Math.max(0, Math.min(quote.expiresAt - Date.now(), 2_147_483_647)),
    );
    return () => {
      mounted = false;
      window.clearTimeout(timer);
    };
  }, [quote]);

  function changeLines(next: CartLine[]) {
    setLines(next);
    setStaleQuote(quote);
    setLocalError("");
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      setLocalError(
        "This test cart cannot be saved on this device. You can still request a quote.",
      );
    }
  }

  const unavailable = lines.some((line) => {
    const variant = variants.find((item) => item.id === line.variantId);
    return !variant || !variant.active || variant.available < line.quantity;
  });
  const pending = navigation.state !== "idle";
  const quoteMatches =
    !!quote &&
    quote !== staleQuote &&
    quote.delivery === delivery &&
    quote === verifiedQuote &&
    !unavailable &&
    quote.lines.length === lines.length &&
    quote.lines.every((line, i) => {
      const variant = variants.find((item) => item.id === line.variantId);
      return (
        line.variantId === lines[i].variantId &&
        line.quantity === lines[i].quantity &&
        variant?.version === line.version &&
        variant.priceCents === line.unitPriceCents
      );
    });

  return (
    <section aria-labelledby={`${prefix}-heading`} className="space-y-6">
      <h1 id={`${prefix}-heading`}>Local test cart</h1>
      <p>Local test only — fictional fees and tax. No payment is taken.</p>
      <p>
        Your device saves only the selected test items and quantities. Stock is
        checked again by the server; a quote does not reserve it.
      </p>
      <ul className="space-y-4" aria-label="Test products">
        {variants.map((variant) => (
          <li key={variant.id}>
            <h2>
              {variant.name} — {variant.colour}
            </h2>
            <p>{variant.sizeDescription}</p>
            <button
              type="button"
              disabled={!ready || !variant.active || variant.available < 1}
              onClick={() => {
                const existing = lines.find(
                  (line) => line.variantId === variant.id,
                );
                if (
                  (!existing && lines.length >= 20) ||
                  (existing && existing.quantity >= 20)
                ) {
                  setLocalError(
                    "A test cart can contain at most 20 items, with 20 units of each.",
                  );
                  return;
                }
                if ((existing?.quantity ?? 0) + 1 > variant.available) {
                  setLocalError(
                    "There is not enough available stock for that quantity.",
                  );
                  return;
                }
                changeLines(
                  existing
                    ? lines.map((line) =>
                        line.variantId === variant.id
                          ? { ...line, quantity: line.quantity + 1 }
                          : line,
                      )
                    : [...lines, { variantId: variant.id, quantity: 1 }],
                );
              }}
            >
              Add {variant.name} — {variant.colour}
            </button>
            {(!variant.active || variant.available < 1) && (
              <p>Currently unavailable</p>
            )}
          </li>
        ))}
      </ul>
      {!ready && <p role="status">Loading your test cart…</p>}
      {ready && lines.length === 0 && <p>Your test cart is empty.</p>}
      <Form method="post" className="space-y-4">
        <input type="hidden" name="intent" value="quote" />
        <input type="hidden" name="lines" value={JSON.stringify(lines)} />
        <ul aria-label="Cart items" className="space-y-4">
          {lines.map((line, index) => {
            const variant = variants.find((item) => item.id === line.variantId);
            const label = variant
              ? `${variant.name} — ${variant.colour}`
              : "Unavailable item";
            const insufficient =
              !variant || !variant.active || variant.available < line.quantity;
            return (
              <li key={line.variantId}>
                <p>{label}</p>
                <label htmlFor={`${prefix}-quantity-${index}`}>
                  Quantity for {label}
                </label>
                <input
                  id={`${prefix}-quantity-${index}`}
                  type="number"
                  min="1"
                  max="20"
                  step="1"
                  value={line.quantity}
                  aria-invalid={insufficient || undefined}
                  aria-describedby={
                    insufficient ? `${prefix}-stock-${index}` : undefined
                  }
                  onChange={(event) => {
                    const quantity = event.currentTarget.valueAsNumber;
                    if (
                      !Number.isSafeInteger(quantity) ||
                      quantity < 1 ||
                      quantity > 20
                    ) {
                      setLocalError(
                        "Choose a whole quantity from 1 to 20, or remove the item.",
                      );
                      return;
                    }
                    changeLines(
                      lines.map((item) =>
                        item.variantId === line.variantId
                          ? { ...item, quantity }
                          : item,
                      ),
                    );
                  }}
                />
                {insufficient && (
                  <p id={`${prefix}-stock-${index}`}>
                    Not enough available stock. Reduce the quantity or remove
                    this item.
                  </p>
                )}
                <button
                  type="button"
                  onClick={() =>
                    changeLines(
                      lines.filter((item) => item.variantId !== line.variantId),
                    )
                  }
                >
                  Remove {label}
                </button>
              </li>
            );
          })}
        </ul>
        <label htmlFor={`${prefix}-delivery`}>
          Delivery method for test quote
        </label>
        <select
          id={`${prefix}-delivery`}
          name="delivery"
          value={delivery}
          onChange={(event) => {
            setDelivery(event.currentTarget.value as DeliveryMethod);
            setStaleQuote(quote);
          }}
        >
          <option value="pickup">Pickup</option>
          <option value="local_delivery">Local delivery</option>
          <option value="shipping">Shipping within Canada</option>
        </select>
        <button
          type="submit"
          disabled={!ready || !lines.length || unavailable || pending}
        >
          {pending ? "Getting test quote…" : "Get test quote"}
        </button>
      </Form>
      {(error || localError) && <p role="alert">{localError || error}</p>}
      {quote && !quoteMatches && (
        <p role="status">
          The previous quote is no longer current. Request a new test quote.
        </p>
      )}
      {quoteMatches && !pending && !error && (
        <section aria-label="Server test quote" aria-live="polite">
          <h2>Server test quote (CAD)</h2>
          <ul>
            {quote.lines.map((line) => (
              <li key={line.variantId}>
                {line.name} — {line.colour}: {line.quantity} ×{" "}
                {money(line.unitPriceCents)} = {money(line.lineTotalCents)}
              </li>
            ))}
          </ul>
          <dl>
            <dt>Items</dt>
            <dd>{money(quote.subtotalCents)}</dd>
            <dt>Fictional delivery fee</dt>
            <dd>{money(quote.shippingCents)}</dd>
            <dt>Fictional tax</dt>
            <dd>{money(quote.taxCents)}</dd>
            <dt>Total</dt>
            <dd>{money(quote.totalCents)}</dd>
          </dl>
          <p>
            Quote valid until{" "}
            {new Date(quote.expiresAt).toLocaleTimeString("en-CA")}. No stock
            has been reserved.
          </p>
        </section>
      )}
    </section>
  );
}
