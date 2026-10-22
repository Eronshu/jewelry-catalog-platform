import { data, Form, isRouteErrorResponse, useRouteError } from "react-router";
import type { Route } from "./+types/commerce-lab";
import { cloudflareContext } from "../cloudflare-context";
import { CommerceCart } from "../components/storefront/commerce-cart";
import { requireLocalCommerce } from "../lib/commerce/environment.server";
import { localExpiryConfigured } from "../lib/commerce/expiry-trigger.server";
import { listCommerceVariants } from "../lib/commerce/inventory.server";
import {
  createTestQuote,
  listTestOrders,
  OrderError,
  releaseTestOrder,
  reserveTestOrder,
  type TestOrder,
} from "../lib/commerce/orders.server";
import {
  QuoteError,
  type CartLine,
  type DeliveryMethod,
  type TestQuote,
} from "../lib/commerce/quote";
import {
  readCommerceForm,
  readTestSession,
  testSession,
} from "../lib/commerce/request.server";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
};
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.get(cloudflareContext).env;
  requireLocalCommerce(request, env);
  const session = await testSession(request);
  return data(
    {
      variants: await listCommerceVariants(env.DB),
      orders: await listTestOrders(env.DB, session.owner),
      expiryConfigured: localExpiryConfigured(env),
    },
    {
      headers: {
        ...privateHeaders,
        ...(session.cookie ? { "Set-Cookie": session.cookie } : {}),
      },
    },
  );
}
type LabResult = {
  quote?: TestQuote;
  quoteId?: string;
  order?: TestOrder;
  error?: string;
};
export async function action({ request, context }: Route.ActionArgs) {
  const env = context.get(cloudflareContext).env;
  requireLocalCommerce(request, env);
  const form = await readCommerceForm(request);
  if (!readTestSession(request))
    return data<LabResult>(
      { error: "Refresh the test page before submitting." },
      { status: 409, headers: privateHeaders },
    );
  const { owner } = await testSession(request);
  try {
    const intent = form.get("intent");
    if (intent === "quote") {
      let lines: CartLine[];
      try {
        lines = JSON.parse(form.get("lines") ?? "") as CartLine[];
      } catch {
        return data<LabResult>(
          { error: "The test cart could not be read." },
          { status: 422, headers: privateHeaders },
        );
      }
      const result = await createTestQuote(
        env.DB,
        owner,
        lines,
        form.get("delivery") as DeliveryMethod,
      );
      return data<LabResult>(
        { quote: result.quote, quoteId: result.id },
        { headers: privateHeaders },
      );
    }
    if (intent === "reserve") {
      const order = await reserveTestOrder(
        env.DB,
        owner,
        form.get("quoteId") ?? "",
      );
      return data<LabResult>({ order }, { headers: privateHeaders });
    }
    if (intent === "cancel") {
      const order = await releaseTestOrder(
        env.DB,
        owner,
        form.get("orderId") ?? "",
        "cancel",
      );
      return data<LabResult>({ order }, { headers: privateHeaders });
    }
    return data<LabResult>(
      { error: "This test action is unavailable." },
      { status: 400, headers: privateHeaders },
    );
  } catch (error) {
    if (error instanceof QuoteError)
      return data<LabResult>(
        {
          error:
            "Check the quantities and available colours, then request a new test quote.",
        },
        { status: 422, headers: privateHeaders },
      );
    if (error instanceof OrderError)
      return data<LabResult>(
        {
          error:
            error.code === "not_found"
              ? "Test order or quote not found."
              : "The quote or reservation changed. Request a fresh quote; no payment was taken.",
        },
        {
          status: error.code === "not_found" ? 404 : 409,
          headers: privateHeaders,
        },
      );
    // No request bodies, cookies, quote tokens or database details in public errors.
    return data<LabResult>(
      { error: "The local test store is unavailable. Try again later." },
      { status: 503, headers: privateHeaders },
    );
  }
}
export function headers({ loaderHeaders, actionHeaders }: Route.HeadersArgs) {
  const headers = new Headers(loaderHeaders);
  actionHeaders.forEach((value, key) => headers.set(key, value));
  for (const [key, value] of Object.entries(privateHeaders))
    headers.set(key, value);
  return headers;
}
export function meta() {
  return [
    { title: "Local commerce test | Velaform Studio" },
    { name: "robots", content: "noindex, nofollow" },
  ];
}
export default function CommerceLab({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const result = actionData as LabResult | undefined;
  const orders = result?.order
    ? [
        result.order,
        ...loaderData.orders.filter((order) => order.id !== result.order?.id),
      ]
    : loaderData.orders;
  return (
    <div className="commerce-page">
      <div className="container">
        <header className="commerce-intro">
          <p className="commerce-kicker">Local shopping test</p>
          <h1>Your bag</h1>
          <p>
            A private demo with fictional items. You can try adding items and
            checking a total, but no payment or real order is possible.
          </p>
        </header>
        <CommerceCart
          variants={loaderData.variants}
          quote={result?.quote}
          quoteId={result?.quoteId}
          error={result?.error}
        />
        <div className="commerce-reservations">
          <h2>Recent test reservations</h2>
          <p>
            Recent reservations for this browser session (up to 20).{" "}
            {loaderData.expiryConfigured
              ? "Local expiry is configured. Check the runner terminal for task health; refresh this page to see committed cancellations. A deadline alone does not prove stock was released."
              : "Automatic expiry is off. Cancel unpaid reservations here to release test stock; the deadline alone does not release it."}{" "}
            Clearing cookies loses access.
          </p>
          {orders.map((order) => (
            <section
              className="commerce-reservation"
              key={order.id}
              aria-label="Test order"
              role="status"
            >
              <h2>Test order {order.id}</h2>
              <p>
                Order: {order.state}. Payment: {order.paymentState}.
                Fulfillment: {order.fulfillment}.
              </p>
              <p>
                Reservation deadline:{" "}
                {new Date(order.reserveUntil).toISOString()}. No payment was
                taken.
              </p>
              {order.state === "pending_payment" &&
              order.paymentState === "not_started" ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="cancel" />
                  <input type="hidden" name="orderId" value={order.id} />
                  <button className="commerce-secondary-button" type="submit">
                    Cancel this unpaid test reservation
                  </button>
                </Form>
              ) : null}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
export function ErrorBoundary() {
  const error = useRouteError();
  const unavailable = isRouteErrorResponse(error) && error.status === 404;
  return (
    <div className="container space-y-6">
      <h1>{unavailable ? "Page not found" : "Local test unavailable"}</h1>
      <p>
        {unavailable
          ? "This page is not available in this environment."
          : "Please reload the local test page."}
      </p>
    </div>
  );
}
