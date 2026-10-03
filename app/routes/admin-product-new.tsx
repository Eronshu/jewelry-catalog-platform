import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  data,
  Link,
  redirect,
  useBeforeUnload,
  useBlocker,
  useNavigate,
} from "react-router";

import type { Route } from "./+types/admin-product-new";
import { AdminShell } from "../components/admin/admin-shell";
import {
  ProductForm,
  type FormFeedback,
} from "../components/admin/product-form";
import {
  ProductPhotos,
  type PhotoQueueState,
} from "../components/admin/product-photos";
import { cloudflareContext } from "../cloudflare-context";
import { requireAdmin } from "../lib/auth/admin-access.server";
import { readAdminForm } from "../lib/auth/admin-mutation.server";
import {
  AdminProductError,
  createDraft,
  fieldsFromForm,
} from "../lib/db/admin-products.server";
import { listActiveCategories } from "../lib/db/categories.server";

export async function loader({ context }: Route.LoaderArgs) {
  requireAdmin(context);
  const categories = await listActiveCategories(
    context.get(cloudflareContext).env.DB,
  );
  return { categories, requestKey: crypto.randomUUID() };
}

export async function action({ request, context }: Route.ActionArgs) {
  requireAdmin(context);
  let fields;
  let requestKey;
  try {
    const form = await readAdminForm(request);
    fields = fieldsFromForm(form);
    requestKey = String(form.get("requestKey") ?? "");
    if (form.get("intent") !== "create")
      throw new AdminProductError("This action is unavailable.", 400);
    const id = await createDraft(
      context.get(cloudflareContext).env.DB,
      fields,
      requestKey,
    );
    return redirect(`/admin/products/${id}/edit`);
  } catch (error) {
    if (error instanceof AdminProductError)
      return data(
        { error: error.message, fieldErrors: error.fields, fields, requestKey },
        { status: error.status },
      );
    if (error instanceof Response || !fields) throw error;
    console.error("Admin product create operation failed");
    return data(
      {
        error:
          "Could not save this product. Your entries are still here. Try again.",
        fields,
        requestKey,
      },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}

export function meta() {
  return [
    { title: "Add product | Catalog admin" },
    { name: "robots", content: "noindex" },
  ];
}

const recoveryKey = "admin-product-create-pending";
const subscribeToHydration = () => () => {};
const browserSnapshot = () => true;
const serverSnapshot = () => false;
const emptyPhotos: [] = [];
const emptyQueue: PhotoQueueState = {
  total: 0,
  unresolved: 0,
  active: false,
  saved: 0,
  failed: 0,
};
type Draft = {
  id: number;
  status: string;
  version: number;
  businessVersion: number;
};

function readRecovery(): { requestKey: string; id?: number } | null {
  try {
    const raw = sessionStorage.getItem(recoveryKey);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const marker = value as Record<string, unknown>;
    if (typeof marker.requestKey !== "string") return null;
    return {
      requestKey: marker.requestKey,
      id: typeof marker.id === "number" ? marker.id : undefined,
    };
  } catch {
    return null;
  }
}
function writeRecovery(requestKey: string, id?: number) {
  try {
    sessionStorage.setItem(recoveryKey, JSON.stringify({ requestKey, id }));
  } catch {
    /* The mounted page still holds the submitted fields and files. */
  }
}
function clearRecovery() {
  try {
    sessionStorage.removeItem(recoveryKey);
  } catch {
    /* Storage can be disabled. */
  }
}

export default function NewProduct({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const navigate = useNavigate();
  const [requestKey, setRequestKey] = useState(
    actionData?.requestKey ?? loaderData.requestKey,
  );
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    browserSnapshot,
    serverSnapshot,
  );
  const [phase, setPhase] = useState<
    "checking" | "editing" | "creating" | "uploading" | "uncertain" | "reloaded"
  >("editing");
  const [feedback, setFeedback] = useState<FormFeedback>(actionData);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [queueState, setQueueState] = useState(emptyQueue);
  const queueRef = useRef(emptyQueue);
  const dirty = useRef(false);
  const submitting = useRef(false);
  const allowNavigation = useRef(false);
  const recoveryChecked = useRef(false);
  const submittedPayload = useRef<URLSearchParams | null>(null);
  const shouldStopQueuedUploads = useCallback(
    () => allowNavigation.current,
    [],
  );
  const onQueueChange = useCallback((state: PhotoQueueState) => {
    queueRef.current = state;
    setQueueState(state);
  }, []);
  const onVersion = useCallback((version: number, businessVersion: number) => {
    setDraft((old) => (old ? { ...old, version, businessVersion } : old));
  }, []);
  const goToEdit = useCallback(
    (id: number, message: "created" | "recovered") => {
      if (allowNavigation.current) return;
      allowNavigation.current = true;
      clearRecovery();
      void navigate(`/admin/products/${id}/edit?message=${message}`);
    },
    [navigate],
  );

  useEffect(() => {
    if (recoveryChecked.current) return;
    recoveryChecked.current = true;
    const marker = readRecovery();
    if (!marker) {
      return;
    }
    // Recovery replaces only the initial key after hydration, once per mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRequestKey(marker.requestKey);
    setPhase("checking");
    void fetch("/admin/products/new/create", {
      method: "POST",
      body: new URLSearchParams({
        intent: "lookup",
        requestKey: marker.requestKey,
      }),
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Lookup failed");
        return (await response.json()) as { product?: Draft | null };
      })
      .then((reply) => {
        if (
          reply.product &&
          Number.isSafeInteger(reply.product.id) &&
          reply.product.id > 0 &&
          (!marker.id || marker.id === reply.product.id)
        )
          goToEdit(reply.product.id, "recovered");
        else setPhase("reloaded");
      })
      .catch(() => setPhase("reloaded"));
  }, [goToEdit]);

  const shouldWarn = () =>
    !allowNavigation.current &&
    (dirty.current ||
      queueRef.current.unresolved > 0 ||
      phase === "creating" ||
      phase === "uploading" ||
      phase === "uncertain");
  const blocker = useBlocker(shouldWarn);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (
      window.confirm(
        "Leave this product? Unsaved details or selected photos may be lost. An upload or Draft creation already in progress may still finish; check Products and saved photos before trying again.",
      )
    ) {
      if (draft && !queueRef.current.active) clearRecovery();
      allowNavigation.current = true;
      blocker.proceed();
    } else blocker.reset();
  }, [blocker, draft]);
  useBeforeUnload((event) => {
    if (shouldWarn()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  async function submitPayload(payload: URLSearchParams) {
    if (submitting.current || draft) return;
    submitting.current = true;
    setPhase("creating");
    setFeedback(undefined);
    writeRecovery(requestKey);
    try {
      const response = await fetch("/admin/products/new/create", {
        method: "POST",
        body: payload,
        credentials: "same-origin",
        cache: "no-store",
      });
      const reply: unknown = await response.json();
      if (!reply || typeof reply !== "object") throw new Error("Invalid reply");
      const result = reply as Record<string, unknown>;
      if (!response.ok) {
        if (response.status === 400 && typeof result.error === "string") {
          setFeedback({
            error: result.error,
            fieldErrors:
              result.fieldErrors as NonNullable<FormFeedback>["fieldErrors"],
          });
          clearRecovery();
          setPhase("editing");
        } else {
          setFeedback({
            error:
              "Could not confirm the Draft. Retry saving these details or check Products.",
          });
          setPhase("uncertain");
        }
        return;
      }
      const product = result.product as Draft | undefined;
      if (
        !product ||
        !Number.isSafeInteger(product.id) ||
        product.id < 1 ||
        product.status !== "draft" ||
        !Number.isSafeInteger(product.version) ||
        product.version < 1 ||
        !Number.isSafeInteger(product.businessVersion) ||
        product.businessVersion < 1 ||
        product.businessVersion > product.version
      )
        throw new Error("Invalid Draft reply");
      setDraft(product);
      writeRecovery(requestKey, product.id);
      setPhase("uploading");
      dirty.current = false;
      setFeedback(undefined);
      if (queueRef.current.unresolved === 0) goToEdit(product.id, "created");
    } catch {
      setFeedback({
        error:
          "Could not confirm the Draft. Retry saving these details or check Products.",
      });
      setPhase("uncertain");
    } finally {
      submitting.current = false;
    }
  }
  function onCreateSubmit(form: HTMLFormElement) {
    if (draft || (phase !== "editing" && phase !== "uncertain")) return;
    if (phase === "uncertain" && submittedPayload.current) {
      void submitPayload(submittedPayload.current);
      return;
    }
    const payload = new URLSearchParams();
    for (const [key, value] of new FormData(form))
      if (typeof value === "string") payload.set(key, value);
    payload.set("intent", "create");
    payload.set("requestKey", requestKey);
    submittedPayload.current = payload;
    void submitPayload(payload);
  }
  useEffect(() => {
    if (phase === "uploading" && draft && queueState.unresolved === 0)
      goToEdit(draft.id, "created");
  }, [phase, draft, queueState.unresolved, goToEdit]);

  return (
    <AdminShell>
      <div className="admin-page-heading">
        <div>
          <h1>
            {draft
              ? queueState.failed > 0 && !queueState.active
                ? "Draft saved — photos need attention"
                : "Draft saved — finishing photos"
              : "Add product"}
          </h1>
          <p>
            {draft
              ? "Product details are saved. Photos upload separately and remain private until publication."
              : "Enter product details, choose photos, then Save once."}
          </p>
        </div>
      </div>
      {phase === "reloaded" ? (
        <div className="admin-alert" role="alert">
          <p>
            This page was reloaded. Selected photos cannot be restored and
            uploads will not resume automatically. We could not confirm the
            previous Draft. Check Products before starting another one.
          </p>
          <Link to="/admin/products">Check Products</Link>
          <button
            type="button"
            onClick={() => {
              clearRecovery();
              setRequestKey(crypto.randomUUID());
              setPhase("editing");
            }}
          >
            Start a new product
          </button>
        </div>
      ) : phase === "checking" ? (
        <p role="status">Checking for a previously saved Draft…</p>
      ) : (
        <>
          <noscript>
            Saving creates a private Draft. Enable JavaScript to select and
            upload photos on this page.
          </noscript>
          {phase === "creating" && (
            <p className="admin-note" role="status">
              Saving your Draft… Keep this page open.
            </p>
          )}
          {draft && (
            <p className="admin-note" role="status">
              Draft saved.{" "}
              {queueState.active
                ? "Uploading photos…"
                : queueState.failed > 0
                  ? "Review failed photos below. Retry or replace them, or open Edit Draft."
                  : "Checking selected photos…"}
            </p>
          )}
          <ProductForm
            categories={loaderData.categories}
            requestKey={requestKey}
            feedback={feedback}
            onCreateSubmit={onCreateSubmit}
            onDirtyChange={(value) => {
              dirty.current = value;
            }}
            locked={
              Boolean(draft) || phase === "uncertain" || phase === "creating"
            }
            saveBusy={phase === "creating"}
            photoEditor={
              hydrated ? (
                <ProductPhotos
                  productId={draft?.id ?? null}
                  status="draft"
                  initialPhotos={emptyPhotos}
                  version={draft?.version ?? 0}
                  businessVersion={draft?.businessVersion ?? 0}
                  onVersion={onVersion}
                  createMode
                  onQueueChange={onQueueChange}
                  selectionLocked={phase === "creating"}
                  shouldStopQueuedUploads={shouldStopQueuedUploads}
                />
              ) : null
            }
          />
          {phase === "uncertain" && !draft && (
            <div className="admin-note">
              <p>
                Retry uses the same submitted details and request key. If you
                leave or reload, check Products before creating another Draft.
              </p>
              <button
                type="button"
                onClick={() => {
                  if (submittedPayload.current)
                    void submitPayload(submittedPayload.current);
                }}
              >
                Retry saving Draft
              </button>
            </div>
          )}
          {draft && (
            <p>
              <Link to={`/admin/products/${draft.id}/edit`}>Edit Draft</Link>
            </p>
          )}
        </>
      )}
    </AdminShell>
  );
}

export function ErrorBoundary() {
  return (
    <AdminShell>
      <div className="admin-alert" role="alert">
        <h1>Product form unavailable</h1>
        <p>Please try again later.</p>
      </div>
    </AdminShell>
  );
}
