import type { Route } from "./+types/admin-commerce-review";
import { cloudflareContext } from "../cloudflare-context";
import { requireAdmin } from "../lib/auth/admin-access.server";
import { requireLocalCommerce } from "../lib/commerce/environment.server";
import {
  inspectReservation,
  listReservationReview,
  ReservationReviewError,
} from "../lib/commerce/reservation-review.server";

const headers = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
};
export async function loader({ request, context }: Route.LoaderArgs) {
  requireAdmin(context);
  const env = context.get(cloudflareContext).env;
  requireLocalCommerce(request, env);
  if (request.method !== "GET")
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { ...headers, Allow: "GET" },
    });
  try {
    const params = new URL(request.url).searchParams;
    if (
      [...params.keys()].some((key) => !["reference", "after"].includes(key)) ||
      params.getAll("reference").length > 1 ||
      params.getAll("after").length > 1 ||
      (params.has("reference") && params.has("after"))
    )
      throw new ReservationReviewError("invalid_request");
    if (params.has("reference")) {
      const result = await inspectReservation(env.DB, params.get("reference")!);
      return result
        ? Response.json(result, { headers })
        : new Response("Test reservation not found", { status: 404, headers });
    }
    const raw = params.get("after");
    let after;
    if (raw !== null) {
      if (raw.length > 160) throw new ReservationReviewError("invalid_request");
      try {
        after = JSON.parse(raw);
      } catch {
        throw new ReservationReviewError("invalid_request");
      }
    }
    return Response.json(await listReservationReview(env.DB, { after }), {
      headers,
    });
  } catch (error) {
    const invalid =
      error instanceof ReservationReviewError &&
      error.code === "invalid_request";
    return new Response(
      invalid
        ? "Invalid local review request"
        : "Local review temporarily unavailable",
      { status: invalid ? 400 : 503, headers },
    );
  }
}
export const action = loader;
