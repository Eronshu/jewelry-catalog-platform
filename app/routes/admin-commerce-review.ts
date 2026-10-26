import type { Route } from "./+types/admin-commerce-review";
import {
  readReservationReview,
  reviewHeaders,
} from "../lib/commerce/reservation-review-request.server";

export async function loader({ request, context }: Route.LoaderArgs) {
  const view = await readReservationReview(request, context);
  return view.kind === "error"
    ? new Response(view.message, {
        status: view.status,
        headers: {
          ...reviewHeaders,
          ...(view.status === 405 ? { Allow: "GET" } : {}),
        },
      })
    : Response.json(view.result, { headers: reviewHeaders });
}
export const action = loader;
