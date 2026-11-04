import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Route } from "./+types/checkout-status";
import { cloudflareContext } from "../cloudflare-context";
import {
  loadNotificationStatusLanding,
  notificationHeaders,
} from "../lib/commerce/order-notification-http.server";
import type { NotificationStatus } from "../lib/commerce/order-notification";
import { formatCad } from "../lib/format-cad";
export const loader = ({ request, context }: Route.LoaderArgs) =>
  loadNotificationStatusLanding(request, context.get(cloudflareContext).env);
export const action = loader;
export const headers = () => notificationHeaders;
export const meta = () => [
  { title: "Private test order status" },
  { name: "robots", content: "noindex, nofollow" },
  { name: "referrer", content: "no-referrer" },
];
const subscribe = () => () => {};
const unavailable =
  "This private test link is unavailable, expired or revoked.";
function valid(v: unknown): v is NotificationStatus {
  if (!v || typeof v !== "object") return false;
  const s = v as NotificationStatus;
  return (
    /^order-[a-f0-9-]{36}$/.test(s.orderId) &&
    [s.state, s.paymentState, s.fulfillment, s.delivery].every(
      (x) => typeof x === "string" && x.length < 50,
    ) &&
    Number.isSafeInteger(s.totalCents) &&
    s.totalCents >= 0 &&
    Number.isSafeInteger(s.refundedCents) &&
    s.refundedCents >= 0 &&
    s.refundedCents <= s.totalCents
  );
}
function ReadStatus() {
  const [token, setToken] = useState(() => {
    const raw = window.location.hash.slice(1);
    return /^[a-f0-9]{64}$/.test(raw) ? raw : null;
  });
  const [status, setStatus] = useState<NotificationStatus | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const active = useRef(false),
    mounted = useRef(true),
    controller = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    const receiveFragment = () => {
      const raw = window.location.hash.slice(1);
      if (!raw) return;
      controller.current?.abort();
      controller.current = null;
      active.current = false;
      setToken(/^[a-f0-9]{64}$/.test(raw) ? raw : null);
      setStatus(null);
      setError("");
      setBusy(false);
      history.replaceState(
        history.state,
        "",
        location.pathname + location.search,
      );
    };
    window.addEventListener("hashchange", receiveFragment);
    history.replaceState(
      history.state,
      "",
      location.pathname + location.search,
    );
    return () => {
      mounted.current = false;
      window.removeEventListener("hashchange", receiveFragment);
      controller.current?.abort();
    };
  }, []);
  async function read() {
    if (!token || active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    const timer = setTimeout(() => abort.abort(), 15000);
    try {
      const response = await fetch("/checkout/status/read", {
        method: "POST",
        body: new URLSearchParams({ token }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        redirect: "error",
        signal: abort.signal,
      });
      const body = (await response.json()) as {
        testOnly?: boolean;
        status?: unknown;
      };
      if (!response.ok || body.testOnly !== true || !valid(body.status))
        throw new Error();
      if (mounted.current && controller.current === abort)
        setStatus(body.status);
    } catch {
      if (mounted.current && controller.current === abort) {
        setStatus(null);
        setError(unavailable);
      }
    } finally {
      clearTimeout(timer);
      if (controller.current === abort) {
        active.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  }
  return (
    <>
      {!token ? (
        <p>{unavailable}</p>
      ) : (
        <button
          className="commerce-secondary-button"
          disabled={busy}
          onClick={() => void read()}
        >
          {busy ? "Checking…" : "Show my test order status"}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {status && (
        <section aria-label="Current test order status">
          <h2>Current test order status</h2>
          <p className="commerce-workspace-reference">{status.orderId}</p>
          <dl>
            <dt>Order</dt>
            <dd>{status.state.replaceAll("_", " ")}</dd>
            <dt>Payment</dt>
            <dd>{status.paymentState.replaceAll("_", " ")}</dd>
            <dt>Fulfillment</dt>
            <dd>{status.fulfillment.replaceAll("_", " ")}</dd>
            <dt>Delivery</dt>
            <dd>{status.delivery.replaceAll("_", " ")}</dd>
            <dt>Order total</dt>
            <dd>{formatCad(status.totalCents)} CAD</dd>
            <dt>Verified refunds</dt>
            <dd>{formatCad(status.refundedCents)} CAD</dd>
          </dl>
          <p>
            Recorded handoff does not confirm arrival. This page is read only.
          </p>
        </section>
      )}
    </>
  );
}
export default function StatusPage() {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  return (
    <section className="container admin-panel order-notifications">
      <h1>Private test order status</h1>
      <p>
        Fictional local order. No email address or login is required. This link
        cannot pay, cancel or change an order.
      </p>
      {hydrated ? <ReadStatus /> : <p>Loading private link…</p>}
    </section>
  );
}
export function ErrorBoundary() {
  return (
    <section className="container admin-panel order-notifications">
      <h1>Private test status unavailable</h1>
      <p>{unavailable}</p>
    </section>
  );
}
