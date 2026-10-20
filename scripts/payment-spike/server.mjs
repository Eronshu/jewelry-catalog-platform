import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  capturePayPalOrder,
  createPayPalOrder,
  createStripeSession,
  getStripeSession,
  TEST_ITEM,
  validateTestCredentials,
} from "./providers.mjs";

validateTestCredentials(process.env);
const port = Number(process.env.PAYMENT_SPIKE_PORT || 8789);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error(
    "PAYMENT_SPIKE_PORT must be a local port from 1024 to 65535.",
  );
}
const baseUrl = `http://127.0.0.1:${port}`;
const paypalOrders = new Map();
const maxAgeMs = 30 * 60 * 1000;

function page(title, body) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font:1rem system-ui;max-width:42rem;margin:3rem auto;padding:0 1rem;line-height:1.6}button{font:inherit;padding:.7rem 1rem;margin:.4rem 0}form{margin:1rem 0}</style><h1>${title}</h1>${body}<p><a href="/">Back to sandbox</a></p></html>`;
}

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(303, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

async function readForm(req) {
  let content = "";
  for await (const chunk of req) {
    content += chunk;
    if (content.length > 1024) throw new Error("Request too large.");
  }
  return new URLSearchParams(content);
}

function localRequest(req) {
  return (
    req.headers.host === `127.0.0.1:${port}` &&
    (!req.headers.origin || req.headers.origin === baseUrl)
  );
}

const server = createServer(async (req, res) => {
  if (!localRequest(req)) {
    send(res, 403, page("Forbidden", "Use the local sandbox address."));
    return;
  }
  const url = new URL(req.url, baseUrl);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      const cancel = url.searchParams.get("cancelled");
      send(
        res,
        200,
        page(
          "Payment provider sandbox",
          `
        <p>${cancel ? "The test checkout was cancelled. " : ""}This is a local-only experiment with one fictional ${TEST_ITEM.currency} 1.00 item. It does not create a shop order or fulfill anything.</p>
        <p>Stripe test mode: ${process.env.STRIPE_SECRET_KEY ? "configured" : "not configured"}. PayPal Sandbox: ${process.env.PAYPAL_CLIENT_ID ? "configured" : "not configured"}.</p>
        <form method="post" action="/stripe-start"><button ${process.env.STRIPE_SECRET_KEY ? "" : "disabled"}>Try Stripe hosted Checkout</button></form>
        <form method="post" action="/paypal-start"><button ${process.env.PAYPAL_CLIENT_ID ? "" : "disabled"}>Try PayPal Sandbox</button></form>
        <p>Use only provider test cards and sandbox buyer accounts. A return page alone does not prove payment.</p>`,
        ),
      );
      return;
    }
    if (req.method === "POST" && url.pathname === "/stripe-start") {
      const session = await createStripeSession(
        process.env.STRIPE_SECRET_KEY,
        baseUrl,
      );
      redirect(res, session.url);
      return;
    }
    if (req.method === "GET" && url.pathname === "/stripe-return") {
      const session = await getStripeSession(
        process.env.STRIPE_SECRET_KEY,
        url.searchParams.get("session_id") || "",
      );
      const paid =
        session.payment_status === "paid" &&
        session.amount_total === TEST_ITEM.cents &&
        session.currency === TEST_ITEM.currency.toLowerCase();
      send(
        res,
        200,
        page(
          "Stripe test result",
          `<p>${paid ? "Stripe reports this CAD 1.00 test session as paid." : "This test session is not verified as paid."}</p><p>No shop order was created.</p>`,
        ),
      );
      return;
    }
    if (req.method === "POST" && url.pathname === "/paypal-start") {
      const state = randomUUID();
      const order = await createPayPalOrder(
        process.env.PAYPAL_CLIENT_ID,
        process.env.PAYPAL_CLIENT_SECRET,
        baseUrl,
        state,
      );
      paypalOrders.set(state, { id: order.id, created: Date.now() });
      redirect(res, order.approveUrl);
      return;
    }
    if (req.method === "GET" && url.pathname === "/paypal-return") {
      const state = url.searchParams.get("state") || "";
      const order = paypalOrders.get(state);
      if (
        !order ||
        Date.now() - order.created > maxAgeMs ||
        url.searchParams.get("token") !== order.id
      ) {
        send(
          res,
          400,
          page(
            "PayPal test result",
            "This Sandbox order is unknown or expired.",
          ),
        );
        return;
      }
      send(
        res,
        200,
        page(
          "PayPal approval returned",
          `<p>Approval alone is not payment. Confirm capture of this CAD 1.00 Sandbox order:</p><form method="post" action="/paypal-capture"><input type="hidden" name="state" value="${state}"><button>Capture Sandbox payment</button></form>`,
        ),
      );
      return;
    }
    if (req.method === "POST" && url.pathname === "/paypal-capture") {
      const state = (await readForm(req)).get("state") || "";
      const order = paypalOrders.get(state);
      if (!order || Date.now() - order.created > maxAgeMs) {
        send(
          res,
          400,
          page(
            "PayPal test result",
            "This Sandbox order is unknown or expired.",
          ),
        );
        return;
      }
      if (order.capturing) {
        send(
          res,
          409,
          page(
            "PayPal test result",
            "This Sandbox capture is already in progress.",
          ),
        );
        return;
      }
      order.capturing = true;
      try {
        await capturePayPalOrder(
          process.env.PAYPAL_CLIENT_ID,
          process.env.PAYPAL_CLIENT_SECRET,
          order.id,
        );
        paypalOrders.delete(state);
      } catch (error) {
        order.capturing = false;
        throw error;
      }
      send(
        res,
        200,
        page(
          "PayPal test result",
          "<p>PayPal reports this CAD 1.00 Sandbox capture as completed.</p><p>No shop order was created.</p>",
        ),
      );
      return;
    }
    send(res, 404, page("Not found", "No such sandbox page."));
  } catch (error) {
    // Keep API responses, credentials and identifiers out of browser output.
    send(
      res,
      502,
      page(
        "Sandbox request failed",
        `<p>${error.message.startsWith("Only Stripe") || error.message.endsWith("missing.") ? error.message : "Check test credentials and the provider dashboard, then retry."}</p>`,
      ),
    );
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Payment sandbox ready at ${baseUrl}\n`);
});
