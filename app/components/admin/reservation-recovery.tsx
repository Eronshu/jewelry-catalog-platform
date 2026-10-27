import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import type {
  ReservationRecoveryInput,
  ReservationRecoveryReceipt,
} from "../../lib/commerce/reservation-recovery.server";

type Order = {
  id: string;
  state: string;
  paymentState: string;
  fulfillment: string;
  reserveUntil: number;
  version: number;
};
type Phase =
  | "idle"
  | "submitting"
  | "checking"
  | "uncertain"
  | "success"
  | "conflict"
  | "blocked";
const requestPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const referencePattern = /^order-[a-f0-9-]{36}$/;
const storagePrefix = "velaform-local-admin-recovery-v1:";
const timeoutMs = 15_000;
const subscribe = () => () => {};
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
type Props = {
  order: Order;
  lineCount: number;
  observedAt: number;
  reviewBusy: boolean;
};

function validCommand(value: unknown): value is ReservationRecoveryInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    Object.keys(item).length === 5 &&
    typeof item.requestId === "string" &&
    requestPattern.test(item.requestId) &&
    typeof item.reference === "string" &&
    referencePattern.test(item.reference) &&
    item.confirmation === item.reference &&
    item.reason === "overdue_unpaid" &&
    typeof item.expectedVersion === "number" &&
    Number.isSafeInteger(item.expectedVersion) &&
    item.expectedVersion > 0 &&
    item.expectedVersion < Number.MAX_SAFE_INTEGER
  );
}
function validReceipt(
  value: unknown,
  command: ReservationRecoveryInput,
): value is ReservationRecoveryReceipt {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    item.testOnly === true &&
    item.requestId === command.requestId &&
    item.reference === command.reference &&
    item.expectedVersion === command.expectedVersion &&
    item.resultingVersion === command.expectedVersion + 1 &&
    typeof item.recordedAt === "number" &&
    Number.isSafeInteger(item.recordedAt) &&
    item.recordedAt >= 0 &&
    item.recordedAt <= 8_640_000_000_000_000 &&
    typeof item.replayed === "boolean"
  );
}

function readSaved(reference: string) {
  try {
    const raw = sessionStorage.getItem(`${storagePrefix}${reference}`);
    if (raw === null)
      return {
        command: null,
        phase: "idle" as Phase,
        message: "",
        ready: true,
      };
    if (raw.length > 1024) throw new Error();
    const saved: unknown = JSON.parse(raw);
    if (!validCommand(saved) || saved.reference !== reference)
      throw new Error();
    return {
      command: saved,
      phase: "uncertain" as Phase,
      message:
        "A saved request needs checking. Nothing was submitted by opening this page. Query the original request before considering a retry.",
      ready: true,
    };
  } catch {
    return {
      command: null,
      phase: "blocked" as Phase,
      message:
        "This tab cannot safely read its saved request. No action is available. Ask the developer to inspect browser storage; do not clear a possibly unfinished request.",
      ready: false,
    };
  }
}

export function ReservationRecovery(props: Props) {
  // Mount the storage-backed interaction only after hydration. SSR never reads
  // browser storage and cannot render a fresh action over an unfinished key.
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  return hydrated ? (
    <RecoveryReady key={props.order.id} {...props} />
  ) : (
    <p>Preparing local recovery controls…</p>
  );
}

function RecoveryReady({ order, lineCount, observedAt, reviewBusy }: Props) {
  const [initial] = useState(() => readSaved(order.id));
  const [confirmation, setConfirmation] = useState("");
  const [command, setCommand] = useState<ReservationRecoveryInput | null>(
    initial.command,
  );
  const [phase, setPhase] = useState<Phase>(initial.phase);
  const [message, setMessage] = useState(initial.message);
  const [receipt, setReceipt] = useState<ReservationRecoveryReceipt | null>(
    null,
  );
  const [storageReady, setStorageReady] = useState(initial.ready);
  const active = useRef(false);
  const busy = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const status = useRef<HTMLDivElement>(null);
  const key = `${storagePrefix}${order.id}`;
  const eligible =
    order.state === "pending_payment" &&
    order.paymentState === "not_started" &&
    order.fulfillment === "none" &&
    Number.isSafeInteger(order.version) &&
    order.version > 0 &&
    order.version < Number.MAX_SAFE_INTEGER &&
    order.reserveUntil <= observedAt &&
    lineCount >= 1 &&
    lineCount <= 20;

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (phase !== "idle" && phase !== "submitting" && phase !== "checking")
      status.current?.focus();
  }, [phase, message]);

  async function perform(saved: ReservationRecoveryInput, query: boolean) {
    if (busy.current || !active.current) return;
    busy.current = true;
    setPhase(query ? "checking" : "submitting");
    setMessage("");
    const abort = new AbortController();
    controller.current = abort;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const params = new URLSearchParams({
        reference: saved.reference,
        requestId: saved.requestId,
        expectedVersion: String(saved.expectedVersion),
      });
      // The timeout covers body reading too. Aborting transport cannot prove
      // that a POST failed to commit, so every uncertain outcome keeps its key.
      const response = await Promise.race([
        (async () => {
          const result = await fetch(
            query
              ? `/admin/commerce/review?${params}`
              : "/admin/commerce/reservations/recover",
            {
              method: query ? "GET" : "POST",
              credentials: "same-origin",
              cache: "no-store",
              redirect: "error",
              signal: abort.signal,
              headers: { Accept: "application/json" },
              ...(query
                ? {}
                : {
                    body: new URLSearchParams({
                      ...saved,
                      expectedVersion: String(saved.expectedVersion),
                    }),
                  }),
            },
          );
          return {
            status: result.status,
            body: result.ok ? await result.json() : null,
          };
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new Error("Outcome unavailable"));
          }, timeoutMs);
        }),
      ]);
      if (!active.current || abort.signal.aborted) return;
      if (response.status === 409) {
        setPhase("conflict");
        setMessage(
          "The record or request conflicts with this confirmation. Refresh results and ask the developer to review it. Do not change the request ID or force a release.",
        );
        return;
      }
      if ([400, 401, 403, 404].includes(response.status)) {
        setPhase("blocked");
        setMessage(
          "This request is unavailable or your authorization needs attention. Keep the saved request and ask the developer to review it before another action.",
        );
        return;
      }
      if (response.status !== 200) throw new Error();
      const detail = response.body;
      if (
        query &&
        (!record(detail) ||
          detail.testOnly !== true ||
          !record(detail.order) ||
          detail.order.id !== saved.reference)
      )
        throw new Error();
      // The resource serializes the detail itself, not the page-loader view.
      const result =
        query && record(detail) && record(detail.recoveryLookup)
          ? detail.recoveryLookup
          : null;
      if (query && result?.state === "conflict") {
        setPhase("conflict");
        setMessage(
          "This request does not match the original operator or confirmed details. Refresh results and ask the developer to investigate. Do not replace its ID.",
        );
        return;
      }
      const found = query
        ? result?.state === "recorded"
          ? result.receipt
          : null
        : response.body;
      if (validReceipt(found, saved)) {
        setReceipt(found);
        setPhase("success");
        setMessage(
          "The original recovery was recorded. Refresh results to check the current order; this receipt does not verify a payment.",
        );
      } else if (query && result?.state === "not_recorded") {
        setPhase(receipt ? "success" : "uncertain");
        setMessage(
          "No original receipt was found in this read. The request may still finish. Keep its ID and details; this is not proof of failure.",
        );
      } else throw new Error();
    } catch {
      if (active.current) {
        setPhase(receipt ? "success" : "uncertain");
        setMessage(
          receipt
            ? "The recorded receipt is retained. The latest query is unavailable; refresh results separately to check the current order."
            : "The outcome is not confirmed. Keep the original request. Query its receipt or explicitly retry the same request; do not create a replacement.",
        );
      }
    } finally {
      clearTimeout(timer);
      busy.current = false;
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (
      busy.current ||
      command ||
      !storageReady ||
      !eligible ||
      reviewBusy ||
      confirmation !== order.id
    )
      return;
    try {
      const saved: ReservationRecoveryInput = {
        requestId: crypto.randomUUID(),
        reference: order.id,
        expectedVersion: order.version,
        confirmation: order.id,
        reason: "overdue_unpaid",
      };
      if (!validCommand(saved)) throw new Error();
      sessionStorage.setItem(key, JSON.stringify(saved));
      if (sessionStorage.getItem(key) !== JSON.stringify(saved))
        throw new Error();
      setCommand(saved);
      void perform(saved, false);
    } catch {
      setPhase("blocked");
      setStorageReady(false);
      setMessage(
        "The request could not be safely saved in this tab, so nothing was submitted. Ask the developer to check browser storage before trying again.",
      );
    }
  }

  return (
    <section className="reservation-card" aria-labelledby="recovery-title">
      <h2 id="recovery-title">Cancel an expired unpaid test reservation</h2>
      <p>
        Only this order's own reserved quantities are released. Physical stock
        and Facebook quantities are unchanged. This does not refund or verify a
        payment. Viewing, querying and refreshing never execute this action.
      </p>
      {!command && eligible && phase !== "blocked" ? (
        <form className="reservation-recovery-form" onSubmit={submit}>
          <p>
            Confirm test order <strong>{order.id}</strong>, reviewed version{" "}
            <strong>{order.version}</strong>. It will be cancelled; the server
            checks its current eligibility again.
          </p>
          <label htmlFor="recovery-confirmation">
            Type the complete order reference to confirm
            <input
              id="recovery-confirmation"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={42}
              required
              aria-describedby="recovery-confirmation-help"
            />
          </label>
          <p id="recovery-confirmation-help" className="reservation-help">
            Use fictional test orders only. Pending payment, a hold, a future
            deadline or a changed version prevents this operation.
          </p>
          <button
            className="reservation-button"
            disabled={confirmation !== order.id || !storageReady || reviewBusy}
          >
            Confirm cancellation and release
          </button>
        </form>
      ) : !command && phase !== "blocked" ? (
        <p>
          This viewed order is not eligible. A cancelled order, started payment,
          hold, future deadline or invalid item count needs a separate review.
          Refresh results; do not force a release.
        </p>
      ) : null}
      <div
        ref={status}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="reservation-recovery-status"
      >
        {phase === "submitting"
          ? "Submitting the saved request… Closing this page will not undo a committed action."
          : phase === "checking"
            ? "Querying the original request without making a change…"
            : message}
        {receipt && (
          <dl className="reservation-facts">
            <div>
              <dt>First recorded (UTC)</dt>
              <dd>{new Date(receipt.recordedAt).toISOString()}</dd>
            </div>
            <div>
              <dt>Recorded version change</dt>
              <dd>
                {receipt.expectedVersion} → {receipt.resultingVersion}
              </dd>
            </div>
            <div>
              <dt>Receipt</dt>
              <dd>
                {receipt.replayed ? "Original receipt found" : "Recorded"}
              </dd>
            </div>
          </dl>
        )}
      </div>
      {command && (
        <>
          <div className="reservation-recovery-actions">
            <button
              type="button"
              className="reservation-button"
              disabled={phase === "submitting" || phase === "checking"}
              onClick={() => void perform(command, true)}
            >
              Query original request (read only)
            </button>
            {phase === "uncertain" && (
              <button
                type="button"
                className="reservation-button"
                onClick={() => void perform(command, false)}
              >
                Retry the same confirmed request
              </button>
            )}
          </div>
          <details className="reservation-help">
            <summary>Saved test request for developer support</summary>
            <p>Request ID: {command.requestId}</p>
            <p>Order reference: {command.reference}</p>
            <p>Confirmed version: {command.expectedVersion}</p>
            <p>
              This tab retains these test references, without customer details.
              Keep this tab until the outcome is resolved; do not clear its
              saved request during an uncertain outcome.
            </p>
          </details>
        </>
      )}
    </section>
  );
}
