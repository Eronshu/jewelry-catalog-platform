import { AdminProductError } from "../db/admin-products.server";

export async function readAdminForm(request: Request): Promise<FormData> {
  if (request.method !== "POST")
    throw new AdminProductError("This action is unavailable.", 405);
  const url = new URL(request.url);
  if (request.headers.get("Origin") !== url.origin)
    throw new AdminProductError("Refresh this page and try again.", 403);
  if (
    !request.headers
      .get("Content-Type")
      ?.startsWith("application/x-www-form-urlencoded")
  )
    throw new AdminProductError("This form could not be read.", 415);
  const length = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > 32_768)
    throw new AdminProductError("This form is too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AdminProductError("This form could not be read.", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 32_768) {
      await reader.cancel();
      throw new AdminProductError("This form is too large.", 413);
    }
    chunks.push(value);
  }
  const body = new TextDecoder().decode(
    Uint8Array.from(chunks.flatMap((chunk) => Array.from(chunk))),
  );
  const form = new FormData();
  for (const [key, value] of new URLSearchParams(body)) form.append(key, value);
  return form;
}
