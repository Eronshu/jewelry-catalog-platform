import { commandHash } from "./inventory.server";
import { isLocalCommerceEnabled } from "./environment.server";
import type { TestCheckoutContext } from "./checkout-acceptance.server";

export type TestCheckoutSessionConfig = {
  mode: "local-test";
  instanceId: string;
  canonicalOrigin: string;
};
export class CheckoutSessionError extends Error {
  constructor(
    public readonly code:
      "invalid_request" | "forbidden" | "unauthorized" | "unavailable",
  ) {
    super("The local test checkout session could not be authorized.");
    this.name = "CheckoutSessionError";
  }
}
/** Internal server result: never serialize context/owner into a loader response.
 * Only csrfToken may enter the future same-origin form; cookie uses Set-Cookie. */
export type TestCheckoutSession = {
  testOnly: true;
  context: TestCheckoutContext;
  createdAt: number;
  expiresAt: number;
  csrfToken: string;
  headers: Record<string, string>;
  setCookie?: string;
};
export type TestCheckoutRevocation = {
  testOnly: true;
  revokedAt: number;
  headers: Record<string, string>;
  setCookie: string;
};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hex = /^[a-f0-9]{64}$/;
const duration = 86_400_000; // Fixed local fixture assumption, not customer policy.
const maxDate = 8_640_000_000_000_000;
function fail(code: CheckoutSessionError["code"]): never {
  throw new CheckoutSessionError(code);
}
function configCopy(raw: unknown): TestCheckoutSessionConfig {
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
    Reflect.ownKeys(raw).length !== 3
  )
    fail("invalid_request");
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of ["mode", "instanceId", "canonicalOrigin"]) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !("value" in descriptor)) fail("invalid_request");
    copy[key] = descriptor.value;
  }
  if (
    copy.mode !== "local-test" ||
    typeof copy.instanceId !== "string" ||
    !uuid.test(copy.instanceId) ||
    typeof copy.canonicalOrigin !== "string" ||
    !/^http:\/\/(localhost|127\.0\.0\.1)(:[1-9][0-9]{0,4})?$/.test(
      copy.canonicalOrigin,
    )
  )
    fail("invalid_request");
  let url: URL;
  try {
    url = new URL(copy.canonicalOrigin);
  } catch {
    fail("invalid_request");
  }
  if (url.origin !== copy.canonicalOrigin || Number(url.port) > 65535)
    fail("invalid_request");
  return {
    mode: "local-test",
    instanceId: copy.instanceId,
    canonicalOrigin: copy.canonicalOrigin,
  };
}
function cookieName(config: TestCheckoutSessionConfig) {
  return `commerce_checkout_guest_v1_${config.instanceId}`;
}
function requestData(raw: unknown, request: Request, method: "GET" | "POST") {
  const config = configCopy(raw);
  if (!(request instanceof Request) || request.method !== method)
    fail("forbidden");
  // Request URL and trusted config decide the gate; never Host/Forwarded/query switches.
  if (
    !isLocalCommerceEnabled(request, { COMMERCE_MODE: config.mode }) ||
    new URL(request.url).origin !== config.canonicalOrigin
  )
    fail("forbidden");
  const origin = request.headers.get("Origin");
  if (
    (method === "POST" && origin !== config.canonicalOrigin) ||
    (origin !== null && origin !== config.canonicalOrigin)
  )
    fail("forbidden");
  const site = request.headers.get("Sec-Fetch-Site");
  const header = request.headers.get("Cookie");
  let token: string | null = null;
  if (header !== null) {
    // Reject an ambiguous/malformed credential, never treat it as absent bootstrap.
    const name = cookieName(config);
    const pairs = header.split(";").map((part) => part.trim());
    // Cookie headers are semicolon-delimited, not comma-combinable. Validate
    // all pairs before deciding our credential is absent, preserving legal
    // unrelated cookies (including quoted cookie-octet values).
    const pair =
      /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=(?:[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*|"[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*")$/;
    if (pairs.some((value) => !pair.test(value))) fail("unauthorized");
    const candidates = pairs.filter(
      (part) => part.split("=", 1)[0].trim() === name,
    );
    if (candidates.length > 1) fail("unauthorized");
    if (candidates.length === 1) {
      if (!candidates[0].startsWith(`${name}=`)) fail("unauthorized");
      token = candidates[0].slice(name.length + 1);
      if (!hex.test(token)) fail("unauthorized");
    }
  }
  // Cross-site top-level returns can resolve an existing credential, never
  // bootstrap or mutate. These browser headers do not authenticate non-browsers.
  if (
    site !== null &&
    site !== "same-origin" &&
    !(
      method === "GET" &&
      (site === "none" ||
        ((site === "cross-site" || site === "same-site") &&
          token !== null &&
          request.headers.get("Sec-Fetch-Mode") === "navigate" &&
          request.headers.get("Sec-Fetch-Dest") === "document"))
    )
  )
    fail("forbidden");
  return { config, token };
}
function sample(clock: () => number) {
  if (typeof clock !== "function") fail("invalid_request");
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0 || now > maxDate)
    fail("invalid_request");
  return now;
}
function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
function hashes(config: TestCheckoutSessionConfig, token: string) {
  // CSRF requires the raw capability; the stored authentication digest is not enough.
  return Promise.all([
    commandHash([
      "local-checkout-session-token-v1",
      config.mode,
      config.instanceId,
      config.canonicalOrigin,
      token,
    ]),
    commandHash([
      "local-checkout-session-csrf-v1",
      config.mode,
      config.instanceId,
      config.canonicalOrigin,
      token,
    ]),
  ]);
}
function equalProof(a: string, b: string) {
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
function responseHeaders() {
  return {
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    Vary: "Cookie, Origin",
  };
}
type SessionRow = {
  token_hash: string;
  mode: string;
  instance_id: string;
  canonical_origin: string;
  owner_hash: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
};
async function read(
  db: D1Database,
  config: TestCheckoutSessionConfig,
  tokenHash: string,
) {
  const row = await db
    .prepare(
      "SELECT * FROM commerce_checkout_guest_sessions WHERE token_hash=?",
    )
    .bind(tokenHash)
    .first<SessionRow>();
  if (
    row &&
    (row.mode !== config.mode ||
      row.instance_id !== config.instanceId ||
      row.canonical_origin !== config.canonicalOrigin)
  )
    fail("unauthorized");
  return row;
}
function active(
  row: SessionRow | null,
  now: number,
): asserts row is SessionRow {
  if (
    !row ||
    now < row.created_at ||
    now >= row.expires_at ||
    row.revoked_at !== null
  )
    fail("unauthorized");
}
function result(row: SessionRow, csrfToken: string): TestCheckoutSession {
  return {
    testOnly: true,
    context: {
      mode: "local-test",
      instanceId: row.instance_id,
      ownerHash: row.owner_hash,
    },
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    csrfToken,
    headers: responseHeaders(),
  };
}
function cleared(
  config: TestCheckoutSessionConfig,
  revokedAt: number,
): TestCheckoutRevocation {
  return {
    testOnly: true,
    revokedAt,
    headers: responseHeaders(),
    setCookie: `${cookieName(config)}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
  };
}
async function boundary<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CheckoutSessionError) throw error;
    throw new CheckoutSessionError("unavailable");
  }
}

/** GET only. Bootstrap when this credential is completely absent; never silently
 * rotate invalid credentials/owners. No routes consume this internal primitive. */
export function loadTestCheckoutSession(
  db: D1Database,
  raw: TestCheckoutSessionConfig,
  request: Request,
  clock: () => number = Date.now,
): Promise<TestCheckoutSession> {
  return boundary(async () => {
    const { config, token } = requestData(raw, request, "GET");
    if (typeof clock !== "function") fail("invalid_request");
    if (token !== null) {
      const [tokenHash, csrfToken] = await hashes(config, token);
      const row = await read(db, config, tokenHash);
      active(row, sample(clock));
      return result(row, csrfToken);
    }
    const createdToken = randomToken();
    const ownerHash = randomToken();
    const [tokenHash, csrfToken] = await hashes(config, createdToken);
    const statement = db.prepare(
      "INSERT INTO commerce_checkout_guest_sessions(token_hash,mode,instance_id,canonical_origin,owner_hash,created_at,expires_at) VALUES (?,?,?,?,?,?,?)",
    );
    const createdAt = sample(clock);
    if (createdAt > maxDate - duration) fail("invalid_request");
    const expiresAt = createdAt + duration;
    let row: SessionRow | null;
    try {
      await statement
        .bind(
          tokenHash,
          config.mode,
          config.instanceId,
          config.canonicalOrigin,
          ownerHash,
          createdAt,
          expiresAt,
        )
        .run();
      row = await read(db, config, tokenHash);
    } catch (error) {
      row = await read(db, config, tokenHash);
      if (!row) throw error;
    }
    // Recover only this generated identity and exact immutable persisted lifetime.
    if (
      !row ||
      row.token_hash !== tokenHash ||
      row.owner_hash !== ownerHash ||
      row.created_at !== createdAt ||
      row.expires_at !== expiresAt
    )
      fail("unavailable");
    const now = sample(clock);
    active(row, now);
    return {
      ...result(row, csrfToken),
      // Round a positive subsecond remainder up; the exact DB deadline remains
      // authoritative, and must never be rounded into a deleting cookie here.
      setCookie: `${cookieName(config)}=${createdToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.ceil((expiresAt - now) / 1000)}; Expires=${new Date(expiresAt).toUTCString()}`,
    };
  });
}
async function mutationIdentity(
  raw: TestCheckoutSessionConfig,
  request: Request,
  csrfProof: unknown,
) {
  const { config, token } = requestData(raw, request, "POST");
  if (token === null || typeof csrfProof !== "string" || !hex.test(csrfProof))
    fail("unauthorized");
  const [tokenHash, csrfToken] = await hashes(config, token);
  if (!equalProof(csrfProof, csrfToken)) fail("unauthorized");
  return { config, tokenHash, csrfToken };
}
/** Authorization is a point-in-time check, not atomic with a later business write.
 * Future consumers must explicitly address in-flight revocation/expiry. */
export function authorizeTestCheckoutMutation(
  db: D1Database,
  raw: TestCheckoutSessionConfig,
  request: Request,
  csrfProof: unknown,
  clock: () => number = Date.now,
): Promise<TestCheckoutSession> {
  return boundary(async () => {
    const { config, tokenHash, csrfToken } = await mutationIdentity(
      raw,
      request,
      csrfProof,
    );
    const row = await read(db, config, tokenHash);
    active(row, sample(clock));
    return result(row, csrfToken);
  });
}
/** Revocation never releases orders, changes their owner or restores lost cookies. */
export function revokeTestCheckoutSession(
  db: D1Database,
  raw: TestCheckoutSessionConfig,
  request: Request,
  csrfProof: unknown,
  clock: () => number = Date.now,
): Promise<TestCheckoutRevocation> {
  return boundary(async () => {
    const { config, tokenHash } = await mutationIdentity(
      raw,
      request,
      csrfProof,
    );
    const originalRevocation = (row: SessionRow | null) => {
      const now = sample(clock);
      if (
        !row ||
        now < row.created_at ||
        (row.revoked_at !== null && now < row.revoked_at)
      )
        fail("unauthorized");
      return row.revoked_at === null ? null : cleared(config, row.revoked_at);
    };
    try {
      const previous = await read(db, config, tokenHash);
      const original = originalRevocation(previous);
      if (original) return original;
      active(previous, sample(clock));
      const statement = db.prepare(
        "UPDATE commerce_checkout_guest_sessions SET revoked_at=? WHERE token_hash=? AND mode=? AND instance_id=? AND canonical_origin=? AND revoked_at IS NULL",
      );
      const occurredAt = sample(clock);
      active(previous, occurredAt);
      await statement
        .bind(
          occurredAt,
          tokenHash,
          config.mode,
          config.instanceId,
          config.canonicalOrigin,
        )
        .run();
      const saved = await read(db, config, tokenHash);
      const result = originalRevocation(saved);
      if (!result) fail("unavailable");
      return result;
    } catch (error) {
      // Recover a concurrent or lost-response revocation before stale eligibility.
      const recovered = await read(db, config, tokenHash);
      if (recovered?.revoked_at !== null && recovered?.revoked_at !== undefined)
        return originalRevocation(recovered)!;
      throw error;
    }
  });
}

/** Private status GET must never bootstrap a new identity when its cookie is lost. */
export function resolveTestCheckoutSession(
  db: D1Database,
  raw: TestCheckoutSessionConfig,
  request: Request,
  clock: () => number = Date.now,
): Promise<TestCheckoutSession> {
  return boundary(async () => {
    const { config, token } = requestData(raw, request, "GET");
    if (token === null) fail("unauthorized");
    const [tokenHash, csrfToken] = await hashes(config, token);
    const row = await read(db, config, tokenHash);
    active(row, sample(clock));
    return result(row, csrfToken);
  });
}
