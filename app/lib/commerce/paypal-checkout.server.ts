import { checkoutConfig } from "./checkout-config.server";
import { paypalRuntimeConfig } from "./paypal-runtime-config.server";
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
  startOwnedPayPalPayment,
  reconcileOwnedPayPalPayment,
  captureOwnedPayPalPayment,
  recordOwnedPayPalEvent,
} from "./owned-paypal.server";
import {
  verifyPayPalSandboxWebhook,
  type PayPalSandboxFetch,
} from "./paypal-sandbox.server";

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: checkoutHeaders });
/** Only this server opt-in boundary supplies native transport. Offline tests inject HTTP fixtures. */
const providerFetch: PayPalSandboxFetch = (url, init) => fetch(url, init);
export async function actPayPalCheckout(
  request: Request,
  env: Env,
  orderId: string,
  fetcher: PayPalSandboxFetch = providerFetch,
  clock: () => number = Date.now,
) {
  try {
    const local = checkoutConfig(request, env),
      config = paypalRuntimeConfig(request, env);
    if (!config)
      return json(
        {
          error:
            "PayPal Sandbox is not configured. No provider request was sent.",
        },
        503,
      );
    const form = await readCommerceForm(request),
      keys = ["csrf", "operation", "requestId", "expectedVersion"];
    if (
      keys.some((k) => !form.has(k)) ||
      [...form.keys()].some((k) => !keys.includes(k)) ||
      !["start", "query", "capture"].includes(form.get("operation")!) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        form.get("requestId")!,
      ) ||
      !/^[1-9][0-9]{0,15}$/.test(form.get("expectedVersion")!)
    )
      return json({ error: "Invalid PayPal test request." }, 422);
    const authorize = () =>
      authorizeTestCheckoutMutation(
        env.DB,
        local,
        request,
        form.get("csrf"),
        clock,
      );
    const session = await authorize(),
      input = { ownerHash: session.context.ownerHash, orderId };
    const order = await readOwnedCheckoutOrder(
      env.DB,
      session.context,
      orderId,
    );
    if (!order) return json({ error: "Private test order unavailable." }, 404);
    if (
      (await readOwnedPaymentProvider(env.DB, session.context, orderId)) ===
      "stripe"
    )
      return json(
        {
          error:
            "This order already has a Stripe attempt. Check the same payment; do not switch methods.",
        },
        409,
      );
    const operation = form.get("operation");
    if (
      (operation === "start" && !config.canStart) ||
      (operation === "capture" && !config.canCapture)
    )
      return json(
        {
          error:
            "New PayPal payment operations are paused. Existing payments can still be checked.",
        },
        503,
      );
    if (operation === "start" && order.paymentState === "not_started")
      await beginOwnedCheckoutPaymentAttempt(
        env.DB,
        {
          ...session.context,
          provider: "paypal",
          accountRef: "fixture-paypal",
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
    const run =
      operation === "start"
        ? startOwnedPayPalPayment
        : operation === "capture"
          ? captureOwnedPayPalPayment
          : reconcileOwnedPayPalPayment;
    const paypal = await run(
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
      paypal: {
        ...paypal,
        canStart: paypal.canStart && config.canStart,
        canCapture: paypal.canCapture && config.canCapture,
      },
      order: await readOwnedCheckoutOrder(env.DB, current.context, orderId),
    });
  } catch (error) {
    if (error instanceof Response)
      return json(
        {
          error:
            error.status === 404
              ? "Local test checkout unavailable."
              : "This test request could not be accepted.",
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
          "Payment has not been verified. Check this same order; do not start another payment or capture. Stock remains protected.",
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
/** Local forwarding endpoint only. Signature verification still requires the configured real app webhook ID. */
export async function actPayPalWebhook(
  request: Request,
  env: Env,
  fetcher: PayPalSandboxFetch = providerFetch,
  clock: () => number = Date.now,
) {
  try {
    const config = paypalRuntimeConfig(request, env);
    if (!config || !config.webhookId) return json({ error: "Not Found" }, 404);
    if (request.method !== "POST")
      return new Response(null, {
        status: 405,
        headers: { ...checkoutHeaders, Allow: "POST" },
      });
    const event = await verifyPayPalSandboxWebhook(
      config.provider,
      {
        webhookId: config.webhookId,
        rawBody: await eventBytes(request),
        headers: request.headers,
      },
      fetcher,
    );
    await recordOwnedPayPalEvent(
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
