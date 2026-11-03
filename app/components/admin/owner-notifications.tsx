import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import type { OwnerNotificationPage } from "../../lib/commerce/order-notification-http.server";
import type { OwnerNotificationInput } from "../../lib/commerce/order-notification";
import { AdminShell } from "./admin-shell";
const subscribe = () => () => {};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const names = {
  capture_confirmed: "Payment confirmed",
  refund_confirmed: "Refund verified",
  packed: "Packing recorded",
  handed_over: "Handoff recorded",
};
function saved(
  key: string,
  orderId: string,
): { input: OwnerNotificationInput | null; blocked: boolean } {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return { input: null, blocked: false };
    const v = JSON.parse(raw) as OwnerNotificationInput;
    if (
      !v ||
      Object.keys(v).sort().join() !==
        "notificationId,operation,orderId,requestId" ||
      v.orderId !== orderId ||
      !uuid.test(v.requestId) ||
      !["prepare", "test_delivered", "test_failed", "revoke"].includes(
        v.operation,
      ) ||
      (v.operation === "prepare"
        ? v.notificationId !== null
        : typeof v.notificationId !== "string" || !uuid.test(v.notificationId))
    )
      throw new Error();
    return { input: v, blocked: false };
  } catch {
    return { input: null, blocked: true };
  }
}
function Controls({ detail, instanceId, canWrite }: OwnerNotificationPage) {
  const key = `commerce:notification:${instanceId}:${detail.orderId}`;
  const [pending, setPending] = useState(() => saved(key, detail.orderId));
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [reload, setReload] = useState(false);
  const active = useRef(false),
    mounted = useRef(true),
    controller = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  async function submit(input: OwnerNotificationInput, lookup: boolean) {
    if (active.current || pending.blocked || reload) return;
    active.current = true;
    setBusy(true);
    setMessage("");
    const abort = new AbortController();
    controller.current = abort;
    const timer = setTimeout(() => abort.abort(), 15000);
    try {
      if (!lookup) {
        setPending({ input, blocked: false });
        sessionStorage.setItem(key, JSON.stringify(input));
        if (sessionStorage.getItem(key) !== JSON.stringify(input))
          throw new Error();
        setPending({ input, blocked: false });
      }
      const response = await fetch(
        `/admin/commerce/orders/${encodeURIComponent(detail.orderId)}/notifications/commands`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            intent: lookup ? "lookup" : "apply",
            requestId: input.requestId,
            operation: input.operation,
            notificationId: input.notificationId ?? "",
          }),
          redirect: "error",
          signal: abort.signal,
        },
      );
      const body = (await response.json()) as {
        state?: string;
        receipt?: {
          testOnly?: boolean;
          recorded?: boolean;
          requestId?: string;
          orderId?: string;
          operation?: string;
        };
      };
      if (!response.ok) throw new Error();
      if (body.state === "not_recorded" && lookup) {
        if (mounted.current)
          setMessage(
            "Not recorded. The original request is preserved; retry that request when writes are available.",
          );
        return;
      }
      const r = body.receipt;
      if (
        body.state !== "recorded" ||
        r?.testOnly !== true ||
        r.recorded !== true ||
        r.requestId !== input.requestId ||
        r.orderId !== input.orderId ||
        r.operation !== input.operation
      )
        throw new Error();
      sessionStorage.removeItem(key);
      if (mounted.current) {
        setPending({ input: null, blocked: false });
        setReload(true);
        setMessage(
          "Recorded. Reload this order’s notifications before another action.",
        );
      }
    } catch {
      if (mounted.current)
        setMessage(
          "The result is uncertain. Keep the original request and check its receipt before another action.",
        );
    } finally {
      clearTimeout(timer);
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function start(
    operation: OwnerNotificationInput["operation"],
    notificationId: string | null,
  ) {
    if (pending.input || pending.blocked || !canWrite || reload) return;
    void submit(
      {
        requestId: crypto.randomUUID(),
        orderId: detail.orderId,
        operation,
        notificationId,
      },
      false,
    );
  }
  const blocked =
    busy || !!pending.input || pending.blocked || reload || !canWrite;
  return (
    <>
      {!canWrite && (
        <p>New actions are paused. You can still check an original request.</p>
      )}
      {pending.blocked && (
        <p role="alert">
          Saved request storage is unavailable or invalid. Preserve it and use
          another browser for read-only history; do not replace the request.
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {reload && (
        <a
          className="admin-primary-link"
          href={`/admin/commerce/orders/${encodeURIComponent(detail.orderId)}/notifications`}
        >
          Reload notification history
        </a>
      )}
      {pending.input && (
        <section
          className="commerce-workspace-card"
          aria-label="Original notification request"
        >
          <p>
            An original {pending.input.operation.replaceAll("_", " ")} request
            is saved.
          </p>
          <button
            className="commerce-secondary-button"
            disabled={busy}
            onClick={() => void submit(pending.input!, true)}
          >
            Check original receipt
          </button>
          <button
            className="commerce-secondary-button"
            disabled={busy || !canWrite}
            onClick={() => void submit(pending.input!, false)}
          >
            Retry original request
          </button>
        </section>
      )}
      <button
        className="commerce-secondary-button"
        disabled={blocked || !detail.canPrepare}
        onClick={() => start("prepare", null)}
      >
        Prepare next test notification batch
      </button>
      {!detail.canPrepare && (
        <p>No missing verified order events are ready to notify.</p>
      )}
      {detail.notifications.length === 0 && (
        <p>No test notifications have been prepared for this order.</p>
      )}
      {detail.notifications.map((n) => (
        <article className="commerce-workspace-card" key={n.id}>
          <h2>{names[n.kind]}</h2>
          <p>To: {n.recipient} · Fictional recipient</p>
          <p>
            <strong>{n.subject}</strong>
          </p>
          <p>{n.body}</p>
          <p>Status: {n.state.replaceAll("_", " ")}</p>
          <p>Private link expires: {new Date(n.expiresAt).toISOString()}</p>
          <ul aria-label="Simulation history">
            {n.attempts.map((a, i) => (
              <li key={i}>
                {a.outcome.replaceAll("_", " ")} ·{" "}
                {new Date(a.at).toISOString()}
              </li>
            ))}
          </ul>
          <button
            className="commerce-secondary-button"
            disabled={blocked || !n.canDeliver}
            onClick={() => start("test_delivered", n.id)}
          >
            Simulate delivery
          </button>
          <button
            className="commerce-secondary-button"
            disabled={blocked || !n.canDeliver}
            onClick={() => start("test_failed", n.id)}
          >
            Simulate delivery failure
          </button>
          <button
            className="commerce-secondary-button"
            disabled={blocked || !n.canRevoke}
            onClick={() => start("revoke", n.id)}
          >
            Revoke private status link
          </button>
          {n.statusUrl && (
            <button
              className="commerce-secondary-button"
              disabled={busy}
              onClick={() =>
                void navigator.clipboard.writeText(n.statusUrl!).then(
                  () =>
                    setMessage(
                      "Private test status link copied. Share only with the intended test recipient.",
                    ),
                  () =>
                    setMessage("Clipboard unavailable. No link was copied."),
                )
              }
            >
              Copy private test status link
            </button>
          )}
        </article>
      ))}
    </>
  );
}
export function OwnerNotifications(props: OwnerNotificationPage) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  return (
    <AdminShell>
      <section className="admin-panel order-notifications">
        <Link
          to={`/admin/commerce/orders/${encodeURIComponent(props.detail.orderId)}`}
        >
          Back to order
        </Link>
        <h1>Test order notifications</h1>
        <p className="commerce-workspace-reference">{props.detail.orderId}</p>
        <p>
          Local simulation only. These actions record test delivery outcomes; no
          email is sent. Private links show order status only and do not allow
          payment or order changes.
        </p>
        {hydrated ? (
          <Controls
            key={`${props.instanceId}:${props.detail.orderId}`}
            {...props}
          />
        ) : (
          <p>Loading notification controls…</p>
        )}
      </section>
    </AdminShell>
  );
}
