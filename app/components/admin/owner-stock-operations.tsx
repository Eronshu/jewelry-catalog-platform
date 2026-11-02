import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { AdminShell } from "./admin-shell";
import type {
  OwnerStockDetail,
  OwnerStockInput,
  OwnerStockOperation,
  OwnerStockReceipt,
} from "../../lib/commerce/owner-stock";
const subscribe = () => () => {};
const labels: Record<OwnerStockOperation, string> = {
  receive: "Receive inspected stock",
  fb_reserve: "Keep one item for Facebook",
  fb_release: "Return the Facebook item to shared stock",
  fb_sale: "Record the Facebook item as sold",
};
const operations = Object.keys(labels) as OwnerStockOperation[];
const keyFor = (instanceId: string, variantId: string) =>
  `commerce-owner-stock-v1:${instanceId}:${variantId}`;
function saved(
  key: string,
  variantId: string,
): { input: OwnerStockInput | null; error: string } {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return { input: null, error: "" };
    const value = JSON.parse(raw) as OwnerStockInput;
    if (
      !value ||
      Object.keys(value).sort().join() !==
        [
          "requestId",
          "variantId",
          "operation",
          "quantity",
          "expected",
          "acknowledge",
        ]
          .sort()
          .join() ||
      value.variantId !== variantId ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        value.requestId,
      ) ||
      !operations.includes(value.operation) ||
      value.acknowledge !== true ||
      !Number.isInteger(value.quantity) ||
      value.quantity < 1 ||
      value.quantity > 1000 ||
      (value.operation !== "receive" && value.quantity !== 1) ||
      !value.expected ||
      Object.keys(value.expected).sort().join() !==
        [
          "variantVersion",
          "onHand",
          "facebookReserved",
          "checkoutReserved",
          "allocated",
        ]
          .sort()
          .join() ||
      Object.values(value.expected).some(
        (x) => !Number.isSafeInteger(x) || x < 0,
      ) ||
      value.expected.variantVersion < 1
    )
      throw Error();
    return { input: value, error: "" };
  } catch {
    return {
      input: null,
      error:
        "Saved request or browser storage is unavailable. Do not start another stock change; ask the developer to recover it.",
    };
  }
}
type Props = {
  detail: OwnerStockDetail;
  instanceId: string;
  canWrite: boolean;
  transport?: typeof fetch;
};
export function OwnerStockOperations(props: Props) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  return (
    <AdminShell>
      <section className="admin-panel owner-stock-operations">
        <h1>Manage test stock</h1>
        <p>
          <strong>Local fictional inventory only.</strong> No actual goods,
          customer details or payment are recorded here.
        </p>
        {hydrated ? (
          <Controls
            key={`${props.instanceId}:${props.detail.item.variantId}`}
            {...props}
          />
        ) : (
          <p>Preparing stock controls…</p>
        )}
        <p>
          <Link to="/admin/commerce/inventory">Back to inventory</Link>
        </p>
      </section>
    </AdminShell>
  );
}
function Controls({ detail, instanceId, canWrite, transport = fetch }: Props) {
  const { item } = detail,
    storageKey = keyFor(instanceId, item.variantId);
  const [initial] = useState(() => saved(storageKey, item.variantId));
  const [pending, setPending] = useState(initial.input),
    [blocked, setBlocked] = useState(!!initial.error),
    [operation, setOperation] = useState<OwnerStockOperation>("receive"),
    [quantity, setQuantity] = useState("1"),
    [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(
      initial.error ||
        (initial.input
          ? "A previous request needs checking. Keep its original details."
          : ""),
    ),
    [receipt, setReceipt] = useState<OwnerStockReceipt | null>(null);
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
  const free =
    item.onHand -
    item.facebookReserved -
    item.checkoutReserved -
    item.allocated;
  const eligible =
    operation === "receive"
      ? true
      : operation === "fb_reserve"
        ? item.facebookReserved === 0 && free >= 1
        : item.facebookReserved === 1;
  async function perform(input: OwnerStockInput, intent: "apply" | "lookup") {
    if (active.current || blocked || (intent === "apply" && !canWrite)) return;
    active.current = true;
    setBusy(true);
    setMessage("");
    const controller = new AbortController();
    abort.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 20000);
    try {
      const response = await transport(
        `/admin/commerce/inventory/${encodeURIComponent(item.variantId)}/commands`,
        {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            intent,
            requestId: input.requestId,
            operation: input.operation,
            quantity: String(input.quantity),
            acknowledge: "true",
            ...Object.fromEntries(
              Object.entries(input.expected).map(([k, v]) => [k, String(v)]),
            ),
          }),
        },
      );
      const body = (await response.json()) as {
        state?: string;
        receipt?: OwnerStockReceipt;
      };
      if (!mounted.current) return;
      if (!response.ok) throw Error();
      if (body.state === "not_recorded" && intent === "lookup") {
        setMessage(
          "This request is not visible in the records yet. This does not prove it failed. Retry only this same request or ask the developer to review it.",
        );
        return;
      }
      const r = body.receipt;
      const expectedAfter = {
        ...input.expected,
        onHand:
          input.expected.onHand +
          (input.operation === "receive"
            ? input.quantity
            : input.operation === "fb_sale"
              ? -1
              : 0),
        facebookReserved:
          input.expected.facebookReserved +
          (input.operation === "fb_reserve"
            ? 1
            : input.operation === "receive"
              ? 0
              : -1),
      };
      if (
        body.state !== "recorded" ||
        !r ||
        r.testOnly !== true ||
        r.requestId !== input.requestId ||
        r.variantId !== input.variantId ||
        r.operation !== input.operation ||
        r.quantity !== input.quantity ||
        typeof r.replayed !== "boolean" ||
        !Number.isSafeInteger(r.recordedAt) ||
        r.recordedAt < 0 ||
        !r.after ||
        Object.keys(r.after).sort().join() !==
          Object.keys(expectedAfter).sort().join() ||
        Object.entries(expectedAfter).some(
          ([key, value]) =>
            r.after![key as keyof typeof expectedAfter] !== value,
        ) ||
        Object.values(r.after).some((v) => !Number.isSafeInteger(v) || v < 0)
      )
        throw Error();
      setReceipt(r);
      setMessage(
        "Stock change recorded once. Reload the latest stock before another action.",
      );
      try {
        sessionStorage.removeItem(storageKey);
        if (sessionStorage.getItem(storageKey) !== null) throw Error();
        setPending(null);
      } catch {
        setBlocked(true);
        setMessage(
          "The change is recorded, but its saved browser request could not be cleared. Ask the developer to recover storage before another action.",
        );
      }
    } catch {
      if (mounted.current)
        setMessage(
          "The result is unconfirmed or stock has changed. Keep this request and check its result; do not start another stock change. Ask the developer if it cannot be resolved.",
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
      pending ||
      blocked ||
      receipt ||
      !canWrite ||
      !ack ||
      !eligible
    )
      return;
    const units = operation === "receive" ? Number(quantity) : 1;
    if (!/^[1-9][0-9]{0,3}$/.test(String(units)) || units > 1000) return;
    const input: OwnerStockInput = {
      requestId: crypto.randomUUID(),
      variantId: item.variantId,
      operation,
      quantity: units,
      acknowledge: true,
      expected: {
        variantVersion: detail.variantVersion,
        onHand: item.onHand,
        facebookReserved: item.facebookReserved,
        checkoutReserved: item.checkoutReserved,
        allocated: item.allocated,
      },
    };
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(input));
      if (sessionStorage.getItem(storageKey) !== JSON.stringify(input))
        throw Error();
    } catch {
      setBlocked(true);
      setMessage(
        "Browser storage could not preserve the original request. No stock request was sent. Ask the developer to check storage.",
      );
      return;
    }
    setPending(input);
    void perform(input, "apply");
  }
  const locked = busy || !!pending || blocked || !!receipt || !canWrite;
  return (
    <>
      <h2>{item.productName}</h2>
      <p>
        {item.colour} · {item.sizeDescription} · SKU: {item.sku}
      </p>
      <dl className="commerce-workspace-facts">
        <div>
          <dt>Physical stock</dt>
          <dd>{item.onHand}</dd>
        </div>
        <div>
          <dt>Facebook reserved</dt>
          <dd>{item.facebookReserved}</dd>
        </div>
        <div>
          <dt>Checkout reserved</dt>
          <dd>{item.checkoutReserved}</dd>
        </div>
        <div>
          <dt>Allocated to orders</dt>
          <dd>{item.allocated}</dd>
        </div>
        <div>
          <dt>Website available</dt>
          <dd>{item.websiteAvailable}</dd>
        </div>
      </dl>
      <p>
        These are the quantities loaded with this page. Receiving stock does not
        publish a product. Only inspected, accepted units count; goods in
        transit or rejected at inspection do not.
      </p>
      {!canWrite && (
        <p role="status">
          New stock changes are paused. Existing requests can still be checked.
        </p>
      )}
      <fieldset disabled={locked}>
        <legend>Choose one stock action</legend>
        <label htmlFor="stock-operation">
          Action
          <select
            id="stock-operation"
            value={operation}
            onChange={(e) => {
              setOperation(e.target.value as OwnerStockOperation);
              setAck(false);
            }}
          >
            {operations.map((op) => (
              <option key={op} value={op}>
                {labels[op]}
              </option>
            ))}
          </select>
        </label>
        {operation === "receive" ? (
          <label htmlFor="stock-quantity">
            Accepted units (1–1000 per entry)
            <input
              id="stock-quantity"
              type="number"
              inputMode="numeric"
              min={1}
              max={1000}
              step={1}
              value={quantity}
              onChange={(e) => {
                setQuantity(e.target.value);
                setAck(false);
              }}
            />
          </label>
        ) : (
          <p>
            This action changes exactly one Facebook unit. Checkout holds and
            allocated orders stay protected.
          </p>
        )}
        {!eligible && (
          <p role="status">
            This action is unavailable for the loaded stock. Facebook can hold
            one unit per variant; it must be reserved before release or sale.
          </p>
        )}
        <label className="owner-stock-confirm">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
          />
          I checked this fictional item and these quantities. Received units
          have passed inspection.
        </label>
        <button
          type="button"
          className="admin-primary-button"
          disabled={
            !ack ||
            !eligible ||
            (operation === "receive" &&
              (!/^[1-9][0-9]{0,3}$/.test(quantity) || Number(quantity) > 1000))
          }
          onClick={submit}
        >
          Record test stock change
        </button>
      </fieldset>
      {pending && (
        <section aria-label="Saved stock request">
          <h3>Original request</h3>
          <p>
            {labels[pending.operation]} · {pending.quantity} unit(s)
          </p>
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
        {busy ? "Checking and recording only the original request…" : message}
      </div>
      {receipt && (
        <section aria-label="Recorded stock receipt">
          <h3>Recorded stock change</h3>
          <p>
            {labels[receipt.operation]} · {receipt.quantity} unit(s)
          </p>
          <p>
            Snapshot immediately after this change: physical{" "}
            {receipt.after.onHand}; Facebook {receipt.after.facebookReserved};
            checkout {receipt.after.checkoutReserved}; allocated{" "}
            {receipt.after.allocated}. Other activity may have changed these
            since.
          </p>
        </section>
      )}
      {!pending && !blocked && (
        <p>
          <a
            href={`/admin/commerce/inventory/${encodeURIComponent(item.variantId)}`}
          >
            Reload latest stock
          </a>
        </p>
      )}
    </>
  );
}
