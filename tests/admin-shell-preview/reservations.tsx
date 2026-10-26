import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import {
  ReservationReview,
  reservationReviewPath,
} from "../../app/components/admin/reservation-review";
import type { ReservationReviewView } from "../../app/lib/commerce/reservation-review-request.server";

// Presentation fixtures only. Never imported by a runtime route or used as an identity.
export const fixtureReference = "order-00000000-0000-0000-0000-000000000001";
const now = Date.UTC(2026, 9, 26, 14, 30);
export const fixtureList: Extract<ReservationReviewView, { kind: "list" }> = {
  kind: "list",
  result: {
    testOnly: true,
    observedAt: now,
    items: [
      {
        id: fixtureReference,
        state: "pending_payment",
        paymentState: "not_started",
        fulfillment: "none",
        reserveUntil: now - 120000,
        version: 1,
        reasons: ["overdue_unpaid"],
      },
      {
        id: fixtureReference.slice(0, -1) + "2",
        state: "pending_payment",
        paymentState: "unknown",
        fulfillment: "held",
        reserveUntil: now + 120000,
        version: 2,
        reasons: ["fulfillment_held", "payment_review"],
      },
    ],
    nextCursor: {
      reserveUntil: now + 120000,
      orderId: fixtureReference.slice(0, -1) + "2",
    },
  },
};
export const fixtureDetail: Extract<ReservationReviewView, { kind: "detail" }> =
  {
    kind: "detail",
    result: {
      testOnly: true,
      observedAt: now,
      order: fixtureList.result.items[0],
      lines: [
        { position: 0, variantId: "fictional-necklace-gold", quantity: 2 },
        { position: 1, variantId: "fictional-necklace-silver", quantity: 1 },
      ],
      history: [
        { kind: "cancel", occurredAt: now - 60000, expectedVersion: 1 },
      ],
      historyTruncated: true,
    },
  };
// Keep the detail internally consistent with its recorded cancellation.
fixtureDetail.result.order = {
  ...fixtureDetail.result.order,
  state: "cancelled",
  version: 2,
  reasons: [],
};

export function reservationFixtureLoader({
  request,
}: Pick<LoaderFunctionArgs, "request">): ReservationReviewView {
  const params = new URL(request.url).searchParams;
  const scene = params.get("scene");
  if (scene === "error")
    return {
      kind: "error",
      status: 503,
      message: "Local review temporarily unavailable",
    };
  if (params.has("reference")) {
    const order = fixtureList.result.items.find(
      (item) => item.id === params.get("reference"),
    );
    return order
      ? {
          ...fixtureDetail,
          result: {
            ...fixtureDetail.result,
            order:
              order.id === fixtureReference
                ? fixtureDetail.result.order
                : order,
          },
        }
      : { kind: "error", status: 404, message: "Test reservation not found" };
  }
  if (scene === "empty" || params.has("after"))
    return {
      kind: "list",
      result: { ...fixtureList.result, items: [], nextCursor: null },
    };
  return fixtureList;
}
export function ReservationPreview() {
  const view = useLoaderData<ReservationReviewView>();
  return (
    <>
      <ReservationReview view={view} />
      <nav
        aria-label="Reservation preview scenes"
        className="admin-main admin-nav"
      >
        <Link to={reservationReviewPath}>Attention list</Link>
        <Link to={`${reservationReviewPath}?reference=${fixtureReference}`}>
          Detail
        </Link>
        <Link to={`${reservationReviewPath}?scene=empty`}>Empty</Link>
        <Link to={`${reservationReviewPath}?scene=error`}>Unavailable</Link>
        <Link to="/">Other Admin fixtures</Link>
      </nav>
    </>
  );
}
export const reservationPreviewRoute = {
  path: reservationReviewPath,
  loader: reservationFixtureLoader,
  element: <ReservationPreview />,
};
