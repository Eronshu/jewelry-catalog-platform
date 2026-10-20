import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capturePayPalOrder,
  createPayPalOrder,
  createStripeSession,
  getStripeSession,
  validateTestCredentials,
} from "./providers.mjs";

const response = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});

test("rejects live Stripe keys", () => {
  assert.throws(() =>
    validateTestCredentials({ STRIPE_SECRET_KEY: "sk_live_example" }),
  );
});

test("creates only a fixed CAD 1.00 Stripe test session", async () => {
  const calls = [];
  const fetcher = async (...args) => {
    calls.push(args);
    return response({
      id: "cs_test_123",
      livemode: false,
      url: "https://checkout.stripe.com/c/test",
    });
  };
  await createStripeSession(
    "sk_test_example",
    "http://127.0.0.1:8789",
    fetcher,
  );
  const [, request] = calls[0];
  assert.equal(
    request.body.get("line_items[0][price_data][unit_amount]"),
    "100",
  );
  assert.equal(request.body.get("line_items[0][price_data][currency]"), "cad");
  assert.equal(request.body.get("payment_method_types[0]"), "card");
});

test("rejects a live Stripe session response", async () => {
  await assert.rejects(
    createStripeSession("sk_test_example", "http://127.0.0.1:8789", async () =>
      response({
        id: "cs_live_123",
        livemode: true,
        url: "https://checkout.stripe.com/c/test",
      }),
    ),
  );
  await assert.rejects(
    getStripeSession("sk_test_example", "cs_live_123", async () => {
      throw new Error("should not fetch");
    }),
  );
});

test("creates a PayPal order only on the Sandbox host for a fixed amount", async () => {
  const calls = [];
  const responses = [
    response({ access_token: "test-token" }),
    response({
      id: "TEST123",
      links: [
        {
          rel: "payer-action",
          href: "https://www.sandbox.paypal.com/checkoutnow?token=TEST123",
        },
      ],
    }),
  ];
  const fetcher = async (...args) => {
    calls.push(args);
    return responses.shift();
  };
  const order = await createPayPalOrder(
    "id",
    "secret",
    "http://127.0.0.1:8789",
    "state",
    fetcher,
  );
  assert.equal(order.id, "TEST123");
  assert.match(calls[1][0], /api-m\.sandbox\.paypal\.com/);
  assert.deepEqual(JSON.parse(calls[1][1].body).purchase_units[0].amount, {
    currency_code: "CAD",
    value: "1.00",
  });
});

test("refuses PayPal capture when approved amount differs", async () => {
  const responses = [
    response({ access_token: "test-token" }),
    response({
      id: "TEST123",
      status: "APPROVED",
      purchase_units: [{ amount: { currency_code: "CAD", value: "2.00" } }],
    }),
  ];
  let count = 0;
  const fetcher = async () => {
    count += 1;
    return responses.shift();
  };
  await assert.rejects(capturePayPalOrder("id", "secret", "TEST123", fetcher));
  assert.equal(count, 2);
});

test("accepts only a completed PayPal Sandbox capture for the fixed amount", async () => {
  const responses = [
    response({ access_token: "test-token" }),
    response({
      id: "TEST123",
      status: "APPROVED",
      purchase_units: [{ amount: { currency_code: "CAD", value: "1.00" } }],
    }),
    response({
      id: "TEST123",
      status: "COMPLETED",
      purchase_units: [
        {
          payments: {
            captures: [
              {
                status: "COMPLETED",
                amount: { currency_code: "CAD", value: "1.00" },
              },
            ],
          },
        },
      ],
    }),
  ];
  const urls = [];
  const fetcher = async (url) => {
    urls.push(url);
    return responses.shift();
  };
  await capturePayPalOrder("id", "secret", "TEST123", fetcher);
  assert.match(
    urls[2],
    /api-m\.sandbox\.paypal\.com\/v2\/checkout\/orders\/TEST123\/capture/,
  );
});
