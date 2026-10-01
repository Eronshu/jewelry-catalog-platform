import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import { createContext, type RouterContextProvider } from "react-router";

import { isAdminPath } from "../admin-path";

export interface AdminPrincipal {
  readonly email: string;
  readonly sub: string;
}

export type AdminAccessResult =
  | { readonly status: "authorized"; readonly principal: AdminPrincipal }
  | { readonly status: "unauthenticated" | "unauthorized" | "unavailable" };

type AdminEnv = Env & {
  ADMIN_ACCESS_ISSUER?: string;
  ADMIN_ACCESS_AUD?: string;
  ADMIN_IDENTITY_PAIRS?: string;
};

interface AdminConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly identities: readonly AdminPrincipal[];
}

const issuerPattern = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
const jwksByIssuer = new Map<string, JWTVerifyGetKey>();

function readConfig(env: AdminEnv): AdminConfig | null {
  const issuer = env.ADMIN_ACCESS_ISSUER;
  const audience = env.ADMIN_ACCESS_AUD;
  const rawIdentities = env.ADMIN_IDENTITY_PAIRS;
  if (
    !issuer ||
    !issuerPattern.test(issuer) ||
    !audience ||
    !audience.trim() ||
    !rawIdentities
  ) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(rawIdentities);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const identities: AdminPrincipal[] = [];
    for (const item of parsed) {
      if (
        typeof item !== "object" ||
        item === null ||
        typeof item.email !== "string" ||
        typeof item.sub !== "string" ||
        !item.email.trim() ||
        !item.sub.trim() ||
        item.email !== item.email.trim() ||
        item.sub !== item.sub.trim()
      ) {
        return null;
      }
      identities.push({ email: item.email.toLowerCase(), sub: item.sub });
    }
    return { issuer, audience, identities };
  } catch {
    return null;
  }
}

function remoteKeys(issuer: string): JWTVerifyGetKey {
  let keys = jwksByIssuer.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksByIssuer.set(issuer, keys);
  }
  return keys;
}

// The optional key source is for tests using synthetic signing keys. The Worker
// always calls this without it, so requests cannot select a different key set.
export async function authenticateAdmin(
  request: Request,
  env: AdminEnv,
  testKeys?: JWTVerifyGetKey,
): Promise<AdminAccessResult> {
  const config = readConfig(env);
  if (!config) return { status: "unavailable" };

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { status: "unauthenticated" };

  try {
    const { payload } = await jwtVerify(
      token,
      testKeys ?? remoteKeys(config.issuer),
      {
        algorithms: ["RS256"],
        issuer: config.issuer,
        audience: config.audience,
        requiredClaims: ["exp", "iat", "nbf"],
        clockTolerance: 60,
      },
    );

    const now = Math.floor(Date.now() / 1000);
    if (
      typeof payload.iat !== "number" ||
      typeof payload.nbf !== "number" ||
      typeof payload.exp !== "number" ||
      payload.iat > now + 60 ||
      payload.iat > payload.exp ||
      payload.type !== "app" ||
      typeof payload.email !== "string" ||
      !payload.email.trim() ||
      typeof payload.sub !== "string" ||
      !payload.sub.trim() ||
      "common_name" in payload ||
      "service_token_id" in payload ||
      payload.service_token_status === true
    ) {
      return { status: "unauthenticated" };
    }

    const email = payload.email.toLowerCase();
    const approved = config.identities.some(
      (identity) => identity.email === email && identity.sub === payload.sub,
    );
    return approved
      ? { status: "authorized", principal: { email, sub: payload.sub } }
      : { status: "unauthorized" };
  } catch (error) {
    if (
      error instanceof errors.JWKSTimeout ||
      (error instanceof errors.JOSEError &&
        ["ERR_JWKS_INVALID", "ERR_JOSE_GENERIC"].includes(error.code)) ||
      !(error instanceof errors.JOSEError)
    ) {
      return { status: "unavailable" };
    }
    return { status: "unauthenticated" };
  }
}

export const adminPrincipalContext = createContext<AdminPrincipal | null>(null);

/** Every future admin loader, action, and resource route must call this guard. */
export function requireAdmin(
  context: Pick<RouterContextProvider, "get">,
): AdminPrincipal {
  const principal = context.get(adminPrincipalContext);
  if (!principal) {
    throw new Response("Access required", {
      status: 401,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  return principal;
}

export { isAdminPath };
