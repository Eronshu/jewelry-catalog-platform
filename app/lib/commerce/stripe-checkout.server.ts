import { checkoutConfig } from "./checkout-config.server";
import { stripeRuntimeConfig } from "./stripe-runtime-config.server";
import {
  authorizeTestCheckoutMutation,
  CheckoutSessionError,
} from "./checkout-session.server";
import { readCommerceForm } from "./request.server";
import { beginOwnedCheckoutPaymentAttempt } from "./payment-start.server";
import {
  checkoutHeaders,
  readOwnedCheckoutOrder,
  readOwnedPaymentProvider,
} from "./checkout-flow.server";
import {
  startOwnedStripePayment,
  reconcileOwnedStripePayment,
  recordOwnedStripeEvent,
} from "./owned-stripe.server";
import {
  verifyStripeSandboxWebhook,
  type StripeSandboxFetch,
} from "./stripe-sandbox.server";

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: checkoutHeaders });
/** Only this opted-in server boundary supplies network transport. Tests inject their own. */
const providerFetch: StripeSandboxFetch = (url, init) => fetch(url, init);
export async function actStripeCheckout(
  request: Request,
  env: Env,
  orderId: string,
  fetcher: StripeSandboxFetch = providerFetch,
  clock: () => number = Date.now,
) {
  try {
    const local = checkoutConfig(request, env);
    const config = stripeRuntimeConfig(request, env);
    if (!config)
      return json(
        {
          error:
            "Stripe Sandbox is not configured. No provider request was sent.",
        },
        503,
      );
    const form = await readCommerceForm(request);
    const keys = ["csrf", "operation", "requestId", "expectedVersion"];
    if (
      keys.some((key) => !form.has(key)) ||
      [...form.keys()].some((key) => !keys.includes(key)) ||
      !["start", "query"].includes(form.get("operation")!) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        form.get("requestId")!,
      ) ||
      !/^[1-9][0-9]{0,15}$/.test(form.get("expectedVersion")!)
    )
      return json({ error: "Invalid test payment request." }, 422);
    const authorize = () =>
      authorizeTestCheckoutMutation(
        env.DB,
        local,
        request,
        form.get("csrf"),
        clock,
      );
    const session = await authorize();
    const input = { ownerHash: session.context.ownerHash, orderId };
    const order = await readOwnedCheckoutOrder(
      env.DB,
      session.context,
      orderId,
    );
    if (!order) return json({ error: "Private test order unavailable." }, 404);
    if (
      (await readOwnedPaymentProvider(env.DB, session.context, orderId)) ===
      "paypal"
    )
      return json(
        {
          error:
            "This order already has a PayPal attempt. Check the same payment; do not switch methods.",
        },
        409,
      );
    const isStart = form.get("operation") === "start";
    if (isStart && !config.canStart)
      return json(
        {
          error:
            "New Stripe Sessions are paused. Existing payments can still be checked.",
        },
        503,
      );
    if (isStart && order.paymentState === "not_started") {
      await beginOwnedCheckoutPaymentAttempt(
        env.DB,
        {
          ...session.context,
          provider: "stripe",
          accountRef: "fixture-stripe",
        },
        {
          requestId: form.get("requestId")!,
          reference: orderId,
          expectedVersion: Number(form.get("expectedVersion")),
        },
        clock,
        async () => {
          await authorize();
        },
      );
    }
    const operation = isStart
      ? startOwnedStripePayment
      : reconcileOwnedStripePayment;
    const stripe = await operation(
      env.DB,
      config.provider,
      input,
      fetcher,
      clock,
      async () => {
        await authorize();
      },
    );
    const current = await authorize();
    return json({
      stripe: { ...stripe, canStart: stripe.canStart && config.canStart },
      order: await readOwnedCheckoutOrder(env.DB, current.context, orderId),
    });
  } catch (error) {
    if (error instanceof Response)
      return json(
        {
          error:
            error.status === 404
              ? "Local test checkout unavailable."
              : "This test request could not be authorized or accepted.",
        },
        error.status,
      );
    if (error instanceof CheckoutSessionError)
      return json(
        {
          error:
            "Use the original private browser session to check this order.",
        },
        error.code === "unavailable" ? 503 : 403,
      );
    return json(
      {
        error:
          "Payment could not be verified. Check this same order; do not place another payment. Stock remains protected.",
        retrySame: true,
      },
      503,
    );
  }
}

async function eventBytes(request: Request) {
  const declared = request.headers.get("Content-Length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > 131072)
  )
    throw new Response(null, { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) throw new Response(null, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 131072) {
      await reader.cancel();
      throw new Response(null, { status: 413 });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
/** Only Stripe CLI forwarding to this local gate is intended; not a public webhook. */
export async function actStripeWebhook(
  request: Request,
  env: Env,
  fetcher: StripeSandboxFetch = providerFetch,
  clock: () => number = Date.now,
) {
  try {
    const config = stripeRuntimeConfig(request, env);
    if (!config || !config.signingSecrets.length)
      return json({ error: "Not Found" }, 404);
    if (request.method !== "POST")
      return new Response(null, {
        status: 405,
        headers: { ...checkoutHeaders, Allow: "POST" },
      });
    const event = await verifyStripeSandboxWebhook(
      {
        enabled: true,
        mode: "local-test",
        instanceId: config.provider.instanceId,
        expectedAccountId: config.provider.expectedAccountId,
        signingSecrets: config.signingSecrets,
      },
      await eventBytes(request),
      request.headers.get("Stripe-Signature"),
      clock,
    );
    await recordOwnedStripeEvent(
      env.DB,
      config.provider,
      event,
      fetcher,
      clock,
    );
    return json({ received: true, testOnly: true });
  } catch (error) {
    if (error instanceof Response)
      return json({ error: "Event not accepted." }, error.status);
    // Invalid signatures never reach storage. Unavailable storage/query asks the sender to retry.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["invalid_signature", "invalid_event"].includes(String(error.code))
    )
      return json({ error: "Event not accepted." }, 400);
    return json(
      { error: "Test event could not be reconciled. Retry the same event." },
      503,
    );
  }
}
