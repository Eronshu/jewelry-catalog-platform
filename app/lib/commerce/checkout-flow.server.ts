import {
  checkoutConfig,
  checkoutAvailable,
  checkoutPaymentPreparationEnabled,
} from "./checkout-config.server";
import {
  beginOwnedCheckoutPaymentAttempt,
  PaymentStartError,
} from "./payment-start.server";
import {
  loadTestCheckoutSession,
  resolveTestCheckoutSession,
  authorizeTestCheckoutMutation,
  CheckoutSessionError,
} from "./checkout-session.server";
import {
  issueTestCheckoutQuote,
  acceptTestCheckoutQuote,
  CheckoutAcceptanceError,
  type TestCheckoutContext,
} from "./checkout-acceptance.server";
import {
  createTestCheckoutOrder,
  CheckoutOrderError,
} from "./checkout-orders.server";
import {
  releaseTestCheckoutOrder,
  CheckoutReleaseError,
} from "./checkout-release.server";
import { readCommerceForm } from "./request.server";

export const checkoutHeaders = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
};
export type OwnedCheckoutOrder = {
  id: string;
  state: string;
  paymentState: string;
  version: number;
  reserveUntil: number;
  totalCents: number;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  delivery: string;
  lines: {
    name: string;
    colour: string;
    quantity: number;
    lineTotalCents: number;
  }[];
};
export type CheckoutConfirmationData = {
  canCreate: boolean;
  csrfToken: string;
  pending: { id: string; reserveUntil: number; totalCents: number }[];
};
function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: { ...checkoutHeaders, ...extra },
  });
}
export function checkoutCommandGet(request: Request, env: Env) {
  try {
    checkoutConfig(request, env);
    return json({ error: "Use POST for this test checkout command." }, 405, {
      Allow: "POST",
    });
  } catch (error) {
    return failure(error);
  }
}
function inaccessible() {
  return json(
    {
      error:
        "This private test order is unavailable. Use the original browser session.",
    },
    404,
  );
}
function failure(error: unknown): Response {
  if (error instanceof Response)
    return json(
      {
        error:
          error.status === 404
            ? "This local test checkout is unavailable."
            : error.status === 422
              ? "Review the fictional selection and final agreement."
              : error.status === 403
                ? "This request could not be authorized."
                : "New test orders are paused or reservation cleanup is unavailable. Existing orders can still be checked.",
      },
      error.status,
      error.status === 405 ? { Allow: "POST" } : {},
    );
  if (error instanceof CheckoutSessionError)
    return json(
      {
        error:
          "Your test session cannot authorize this request. Return to confirmation in the original browser; no new order was requested.",
      },
      error.code === "unavailable" ? 503 : 403,
    );
  if (
    error instanceof CheckoutAcceptanceError ||
    error instanceof CheckoutOrderError ||
    error instanceof CheckoutReleaseError ||
    error instanceof PaymentStartError
  ) {
    if (error.code === "unavailable")
      return json(
        {
          error:
            "The result is uncertain. Retry the same request or open Your pending orders before starting again.",
          retrySame: true,
        },
        503,
      );
    return json(
      {
        error:
          "Items, amounts or reservation status changed. Check your pending orders; review a fresh quote before confirming again.",
        retrySame: false,
      },
      409,
    );
  }
  return json(
    {
      error:
        "The result could not be checked. Retry the same request or check your pending orders.",
      retrySame: true,
    },
    503,
  );
}
function fields(form: URLSearchParams, names: string[]) {
  if (
    [...form.keys()].some((key) => !names.includes(key)) ||
    names.some((key) => !form.has(key))
  )
    throw new Response("Invalid test request", { status: 422 });
}
async function pending(db: D1Database, scope: TestCheckoutContext) {
  return (
    await db
      .prepare(
        `SELECT o.id,o.reserve_until AS reserveUntil,json_extract(o.snapshot,'$.totalCents') AS totalCents
 FROM commerce_checkout_order_origins x JOIN commerce_orders o ON o.id=x.order_id
 WHERE x.mode=? AND x.instance_id=? AND x.owner_hash=? AND o.owner_hash=x.owner_hash AND o.state='pending_payment'
 ORDER BY o.created_at DESC,o.id DESC LIMIT 10`,
      )
      .bind(scope.mode, scope.instanceId, scope.ownerHash)
      .all<{ id: string; reserveUntil: number; totalCents: number }>()
  ).results;
}
async function owned(
  db: D1Database,
  scope: TestCheckoutContext,
  id: string,
): Promise<OwnedCheckoutOrder | null> {
  if (
    !/^order-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      id,
    )
  )
    return null;
  const order = await db
    .prepare(
      `SELECT o.id,o.state,o.payment_state AS paymentState,o.version,o.reserve_until AS reserveUntil,
 json_extract(o.snapshot,'$.totalCents') AS totalCents,json_extract(o.snapshot,'$.subtotalCents') AS subtotalCents,
 json_extract(o.snapshot,'$.shippingCents') AS shippingCents,json_extract(o.snapshot,'$.taxCents') AS taxCents,json_extract(o.snapshot,'$.delivery') AS delivery
 FROM commerce_checkout_order_origins x JOIN commerce_orders o ON o.id=x.order_id
 WHERE x.order_id=? AND x.mode=? AND x.instance_id=? AND x.owner_hash=? AND o.owner_hash=x.owner_hash`,
    )
    .bind(id, scope.mode, scope.instanceId, scope.ownerHash)
    .first<Omit<OwnedCheckoutOrder, "lines">>();
  if (!order) return null;
  const lines = (
    await db
      .prepare(
        `SELECT json_extract(j.value,'$.name') AS name,json_extract(j.value,'$.colour') AS colour,
 json_extract(j.value,'$.quantity') AS quantity,json_extract(j.value,'$.lineTotalCents') AS lineTotalCents
 FROM commerce_checkout_order_origins x JOIN commerce_orders o ON o.id=x.order_id,json_each(o.snapshot,'$.lines') j
 WHERE x.order_id=? AND x.mode=? AND x.instance_id=? AND x.owner_hash=? AND o.owner_hash=x.owner_hash ORDER BY j.key`,
      )
      .bind(id, scope.mode, scope.instanceId, scope.ownerHash)
      .all<OwnedCheckoutOrder["lines"][number]>()
  ).results;
  return { ...order, lines };
}
export async function loadCheckoutConfirmation(
  request: Request,
  env: Env,
  clock: () => number = Date.now,
) {
  try {
    const config = checkoutConfig(request, env);
    const canCreate = checkoutAvailable(request, env);
    const session = await (
      canCreate ? loadTestCheckoutSession : resolveTestCheckoutSession
    )(env.DB, config, request, clock);
    return json(
      {
        csrfToken: session.csrfToken,
        canCreate,
        pending: await pending(env.DB, session.context),
      },
      200,
      session.setCookie ? { "Set-Cookie": session.setCookie } : {},
    );
  } catch (error) {
    return failure(error);
  }
}
export async function actCheckoutConfirmation(
  request: Request,
  env: Env,
  clock: () => number = Date.now,
) {
  try {
    const config = checkoutConfig(request, env);
    if (!checkoutAvailable(request, env))
      throw new Response("Local reservation expiry is not configured", {
        status: 503,
      });
    const form = await readCommerceForm(request);
    const session = await authorizeTestCheckoutMutation(
      env.DB,
      config,
      request,
      form.get("csrf"),
      clock,
    );
    const operation = form.get("operation");
    if (operation === "quote") {
      fields(form, ["operation", "csrf", "issueKey", "selection"]);
      const quote = await issueTestCheckoutQuote(
        env.DB,
        session.context,
        {
          issueKey: form.get("issueKey"),
          selection: JSON.parse(form.get("selection")!),
        },
        clock,
      );
      // Explicit projection: no rules hash, owner, raw snapshot or fixture address.
      return json({
        quote: {
          quoteId: quote.quoteId,
          expiresAt: quote.expiresAt,
          fixtureProfileId: quote.fixtureProfileId,
          lines: quote.snapshot.lines.map(
            ({ name, colour, quantity, lineTotalCents }) => ({
              name,
              colour,
              quantity,
              lineTotalCents,
            }),
          ),
          subtotalCents: quote.snapshot.subtotalCents,
          shippingCents: quote.snapshot.shippingCents,
          taxCents: quote.snapshot.taxCents,
          totalCents: quote.snapshot.totalCents,
        },
      });
    }
    if (operation !== "confirm")
      throw new Response("Invalid test request", { status: 422 });
    fields(form, [
      "operation",
      "csrf",
      "acceptanceKey",
      "createKey",
      "quoteId",
      "selection",
      "acknowledge",
    ]);
    if (form.get("acknowledge") !== "yes")
      throw new Response(
        "Review and agree to the displayed fictional total first",
        { status: 422 },
      );
    const accepted = await acceptTestCheckoutQuote(
      env.DB,
      session.context,
      {
        acceptanceKey: form.get("acceptanceKey"),
        quoteId: form.get("quoteId"),
        selection: JSON.parse(form.get("selection")!),
        acknowledge: true,
      },
      clock,
    );
    // Session auth is a point-in-time check. Refresh it after the asynchronous
    // acceptance before the stock-writing command; its SQL remains order-atomic.
    const current = await authorizeTestCheckoutMutation(
      env.DB,
      config,
      request,
      form.get("csrf"),
      clock,
    );
    const order = await createTestCheckoutOrder(
      env.DB,
      current.context,
      { createKey: form.get("createKey"), acceptanceId: accepted.acceptanceId },
      clock,
    );
    return json({ orderId: order.orderId });
  } catch (error) {
    if (error instanceof SyntaxError)
      return json(
        { error: "Invalid fictional selection. Review your cart." },
        422,
      );
    return failure(error);
  }
}
export async function loadCheckoutOrder(
  request: Request,
  env: Env,
  id: string,
  clock: () => number = Date.now,
) {
  try {
    const config = checkoutConfig(request, env);
    const session = await resolveTestCheckoutSession(
      env.DB,
      config,
      request,
      clock,
    );
    const order = await owned(env.DB, session.context, id);
    if (!order) return inaccessible();
    return json({
      csrfToken: session.csrfToken,
      order,
      canPreparePayment: checkoutPaymentPreparationEnabled(request, env),
    });
  } catch (error) {
    if (error instanceof CheckoutSessionError && error.code !== "unavailable")
      return inaccessible();
    return failure(error);
  }
}

/** Local synthetic preparation only. No provider client or transport is imported. */
export async function prepareCheckoutPayment(
  request: Request,
  env: Env,
  id: string,
  clock: () => number = Date.now,
) {
  try {
    const config = checkoutConfig(request, env);
    if (!checkoutPaymentPreparationEnabled(request, env))
      throw new Response("Test payment preparation is disabled", {
        status: 503,
      });
    const form = await readCommerceForm(request);
    fields(form, ["csrf", "requestId", "expectedVersion"]);
    const session = await authorizeTestCheckoutMutation(
      env.DB,
      config,
      request,
      form.get("csrf"),
      clock,
    );
    if (!(await owned(env.DB, session.context, id))) return inaccessible();
    const version = form.get("expectedVersion")!;
    if (!/^[1-9][0-9]{0,15}$/.test(version))
      throw new Response("Invalid order version", { status: 422 });
    const current = await authorizeTestCheckoutMutation(
      env.DB,
      config,
      request,
      form.get("csrf"),
      clock,
    );
    await beginOwnedCheckoutPaymentAttempt(
      env.DB,
      { ...current.context, provider: "stripe", accountRef: "fixture-stripe" },
      {
        requestId: form.get("requestId")!,
        reference: id,
        expectedVersion: Number(version),
      },
      clock,
      async () => {
        await authorizeTestCheckoutMutation(
          env.DB,
          config,
          request,
          form.get("csrf"),
          clock,
        );
      },
    );
    return json({ order: await owned(env.DB, current.context, id) });
  } catch (error) {
    return failure(error);
  }
}
export async function cancelCheckoutOrder(
  request: Request,
  env: Env,
  id: string,
  clock: () => number = Date.now,
) {
  try {
    const config = checkoutConfig(request, env);
    const form = await readCommerceForm(request);
    fields(form, ["csrf", "releaseKey", "expectedVersion"]);
    const session = await authorizeTestCheckoutMutation(
      env.DB,
      config,
      request,
      form.get("csrf"),
      clock,
    );
    if (!(await owned(env.DB, session.context, id))) return inaccessible();
    const version = form.get("expectedVersion")!;
    if (!/^[1-9][0-9]{0,15}$/.test(version))
      throw new Response("Invalid order version", { status: 422 });
    const current = await authorizeTestCheckoutMutation(
      env.DB,
      config,
      request,
      form.get("csrf"),
      clock,
    );
    await releaseTestCheckoutOrder(
      env.DB,
      current.context,
      {
        releaseKey: form.get("releaseKey"),
        orderId: id,
        kind: "cancel",
        expectedVersion: Number(version),
      },
      clock,
    );
    return json({ order: await owned(env.DB, session.context, id) });
  } catch (error) {
    return failure(error);
  }
}
