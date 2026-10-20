const STRIPE_API = "https://api.stripe.com";
const PAYPAL_SANDBOX_API = "https://api-m.sandbox.paypal.com";

export const TEST_ITEM = Object.freeze({
  name: "Payment sandbox sample (not a real product)",
  currency: "CAD",
  cents: 100,
});

export function validateTestCredentials(env) {
  if (env.STRIPE_SECRET_KEY && !env.STRIPE_SECRET_KEY.startsWith("sk_test_")) {
    throw new Error("Only Stripe test secret keys are accepted.");
  }
  if (env.PAYPAL_CLIENT_ID && !env.PAYPAL_CLIENT_SECRET) {
    throw new Error("PayPal Sandbox client secret is missing.");
  }
  if (env.PAYPAL_CLIENT_SECRET && !env.PAYPAL_CLIENT_ID) {
    throw new Error("PayPal Sandbox client ID is missing.");
  }
}

async function apiJson(response, label) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `${label} returned HTTP ${response.status}. Check sandbox credentials and dashboard.`,
    );
  }
  return result;
}

export async function createStripeSession(key, baseUrl, fetcher = fetch) {
  if (!key?.startsWith("sk_test_")) {
    throw new Error("Stripe test key is missing.");
  }
  const body = new URLSearchParams({
    mode: "payment",
    "payment_method_types[0]": "card",
    "line_items[0][price_data][currency]": TEST_ITEM.currency.toLowerCase(),
    "line_items[0][price_data][unit_amount]": String(TEST_ITEM.cents),
    "line_items[0][price_data][product_data][name]": TEST_ITEM.name,
    "line_items[0][quantity]": "1",
    success_url: `${baseUrl}/stripe-return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/?cancelled=stripe`,
  });
  const result = await apiJson(
    await fetcher(`${STRIPE_API}/v1/checkout/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }),
    "Stripe Checkout",
  );
  if (
    result.livemode !== false ||
    !result.id?.startsWith("cs_test_") ||
    !result.url?.startsWith("https://checkout.stripe.com/")
  ) {
    throw new Error("Stripe did not return a test Checkout Session.");
  }
  return result;
}

export async function getStripeSession(key, sessionId, fetcher = fetch) {
  if (
    !key?.startsWith("sk_test_") ||
    !/^cs_test_[A-Za-z0-9]+$/.test(sessionId)
  ) {
    throw new Error("Invalid Stripe test session.");
  }
  const result = await apiJson(
    await fetcher(`${STRIPE_API}/v1/checkout/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${key}` },
    }),
    "Stripe Checkout",
  );
  if (result.livemode !== false || result.id !== sessionId) {
    throw new Error("Stripe session verification failed.");
  }
  return result;
}

async function paypalAccessToken(clientId, secret, fetcher) {
  if (!clientId || !secret)
    throw new Error("PayPal Sandbox credentials are missing.");
  const basic = Buffer.from(`${clientId}:${secret}`).toString("base64");
  const result = await apiJson(
    await fetcher(`${PAYPAL_SANDBOX_API}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    }),
    "PayPal Sandbox authentication",
  );
  if (!result.access_token)
    throw new Error("PayPal Sandbox did not return an access token.");
  return result.access_token;
}

export async function createPayPalOrder(
  clientId,
  secret,
  baseUrl,
  state,
  fetcher = fetch,
) {
  const token = await paypalAccessToken(clientId, secret, fetcher);
  const result = await apiJson(
    await fetcher(`${PAYPAL_SANDBOX_API}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": state,
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            description: TEST_ITEM.name,
            amount: { currency_code: TEST_ITEM.currency, value: "1.00" },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              user_action: "PAY_NOW",
              shipping_preference: "NO_SHIPPING",
              return_url: `${baseUrl}/paypal-return?state=${state}`,
              cancel_url: `${baseUrl}/?cancelled=paypal`,
            },
          },
        },
      }),
    }),
    "PayPal Sandbox order",
  );
  const approveUrl = result.links?.find((link) =>
    ["payer-action", "approve"].includes(link.rel),
  )?.href;
  if (
    !result.id ||
    !approveUrl?.startsWith("https://www.sandbox.paypal.com/")
  ) {
    throw new Error("PayPal did not return a Sandbox approval link.");
  }
  return { id: result.id, approveUrl };
}

export async function capturePayPalOrder(
  clientId,
  secret,
  orderId,
  fetcher = fetch,
) {
  if (!/^[A-Za-z0-9]+$/.test(orderId))
    throw new Error("Invalid PayPal order ID.");
  const token = await paypalAccessToken(clientId, secret, fetcher);
  const order = await apiJson(
    await fetcher(`${PAYPAL_SANDBOX_API}/v2/checkout/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    "PayPal Sandbox order lookup",
  );
  const amount = order.purchase_units?.[0]?.amount;
  if (
    order.id !== orderId ||
    order.status !== "APPROVED" ||
    amount?.currency_code !== TEST_ITEM.currency ||
    amount.value !== "1.00"
  ) {
    throw new Error("PayPal order is not an approved CAD 1.00 sandbox order.");
  }
  const capture = await apiJson(
    await fetcher(
      `${PAYPAL_SANDBOX_API}/v2/checkout/orders/${orderId}/capture`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "PayPal-Request-Id": `capture-${orderId}`,
        },
      },
    ),
    "PayPal Sandbox capture",
  );
  if (capture.id !== orderId || capture.status !== "COMPLETED") {
    throw new Error("PayPal Sandbox capture did not complete.");
  }
  const captured = capture.purchase_units?.[0]?.payments?.captures?.[0];
  if (
    captured?.status !== "COMPLETED" ||
    captured.amount?.currency_code !== TEST_ITEM.currency ||
    captured.amount?.value !== "1.00"
  ) {
    throw new Error("PayPal Sandbox capture amount could not be verified.");
  }
  return capture;
}
