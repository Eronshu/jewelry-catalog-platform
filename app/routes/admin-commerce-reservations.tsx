import { data } from "react-router";
import type { Route } from "./+types/admin-commerce-reservations";
import { ReservationReview } from "../components/admin/reservation-review";
import {
  readReservationReview,
  reviewHeaders,
} from "../lib/commerce/reservation-review-request.server";

export async function loader({ request, context }: Route.LoaderArgs) {
  const view = await readReservationReview(request, context);
  if (view.kind === "error" && view.status === 405)
    throw new Response(view.message, {
      status: 405,
      headers: { ...reviewHeaders, Allow: "GET" },
    });
  return data(view, {
    status: view.kind === "error" ? view.status : 200,
    headers: {
      ...reviewHeaders,
    },
  });
}
export const action = loader;
export const headers: Route.HeadersFunction = ({
  loaderHeaders,
  actionHeaders,
  errorHeaders,
}) => {
  const result = new Headers(reviewHeaders);
  const allow =
    errorHeaders?.get("Allow") ??
    actionHeaders.get("Allow") ??
    loaderHeaders.get("Allow");
  if (allow) result.set("Allow", allow);
  return result;
};
export function meta() {
  return [
    { title: "Test reservation review | Catalog admin" },
    { name: "robots", content: "noindex, nofollow" },
  ];
}
export default function Reservations({ loaderData }: Route.ComponentProps) {
  return <ReservationReview view={loaderData} />;
}
export { ErrorBoundary } from "./admin";
