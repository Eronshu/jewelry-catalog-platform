import type { Route } from "./+types/shop-page";
import { cloudflareContext } from "../cloudflare-context";
import { shopData } from "../lib/shop-data.server";

export async function loader({ context, request }: Route.LoaderArgs) {
  try {
    const result = await shopData(
      context.get(cloudflareContext).env.DB,
      new URL(request.url),
      true,
    );
    if ("resetUrl" in result)
      return Response.json(result, {
        status: 409,
        headers: { "Cache-Control": "private, no-store" },
      });
    return Response.json(result.page, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("Shop page load failed", error);
    return new Response(null, {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
