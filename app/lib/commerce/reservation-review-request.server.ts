import type { RouterContextProvider } from "react-router";
import { cloudflareContext } from "../../cloudflare-context";
import { requireAdmin } from "../auth/admin-access.server";
import { requireLocalCommerce } from "./environment.server";
import {
  inspectReservation,
  listReservationReview,
  ReservationReviewError,
} from "./reservation-review.server";

export const reviewHeaders = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
};

export type ReservationReviewView =
  | { kind: "list"; result: Awaited<ReturnType<typeof listReservationReview>> }
  | {
      kind: "detail";
      result: NonNullable<Awaited<ReturnType<typeof inspectReservation>>>;
    }
  | { kind: "error"; status: 400 | 404 | 405 | 503; message: string };

// The resource and owner screen share the same authorization, input and read boundary.
export async function readReservationReview(
  request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<ReservationReviewView> {
  requireAdmin(context);
  const env = context.get(cloudflareContext).env;
  requireLocalCommerce(request, env);
  if (request.method !== "GET")
    return { kind: "error", status: 405, message: "Method Not Allowed" };
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
        ? { kind: "detail", result }
        : { kind: "error", status: 404, message: "Test reservation not found" };
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
    return {
      kind: "list",
      result: await listReservationReview(env.DB, { after }),
    };
  } catch (error) {
    const invalid =
      error instanceof ReservationReviewError &&
      error.code === "invalid_request";
    return {
      kind: "error",
      status: invalid ? 400 : 503,
      message: invalid
        ? "Invalid local review request"
        : "Local review temporarily unavailable",
    };
  }
}
