import { commandHash } from "./inventory.server";

const COOKIE = "commerce_lab_session_v1";
export function readTestSession(request: Request): string | null {
  const values =
    request.headers
      .get("Cookie")
      ?.split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${COOKIE}=`)) ?? [];
  if (values.length !== 1) return null;
  const token = values[0].slice(COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export async function testSession(request: Request) {
  const existing = readTestSession(request);
  const token =
    existing ??
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  return {
    owner: await commandHash(token),
    cookie: existing
      ? null
      : `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
  };
}
export async function readCommerceForm(
  request: Request,
): Promise<URLSearchParams> {
  if (request.method !== "POST")
    throw new Response("Method not allowed", { status: 405 });
  if (request.headers.get("Origin") !== new URL(request.url).origin)
    throw new Response("Forbidden", { status: 403 });
  if (
    request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !==
    "application/x-www-form-urlencoded"
  )
    throw new Response("Unsupported form", { status: 415 });
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 8192))
    throw new Response("Form too large", { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) throw new Response("Missing form", { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) {
      await reader.cancel();
      throw new Response("Form too large", { status: 413 });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const form = new URLSearchParams(new TextDecoder().decode(bytes));
  for (const key of new Set(form.keys()))
    if (form.getAll(key).length !== 1)
      throw new Response("Repeated field", { status: 400 });
  return form;
}
