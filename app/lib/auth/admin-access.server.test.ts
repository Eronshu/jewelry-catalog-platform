import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { RouterContextProvider } from "react-router";
import { beforeAll, describe, expect, it } from "vitest";

import {
  adminPrincipalContext,
  authenticateAdmin,
  requireAdmin,
} from "./admin-access.server";

const issuer = "https://synthetic-team.cloudflareaccess.com";
const audience = "synthetic-admin-audience";
const email = "owner@example.invalid";
const sub = "synthetic-human-id";
const env = {
  ADMIN_ACCESS_ISSUER: issuer,
  ADMIN_ACCESS_AUD: audience,
  ADMIN_IDENTITY_PAIRS: JSON.stringify([{ email, sub }]),
} as unknown as Env;

let privateKey: CryptoKey;
let keys: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey as CryptoKey;
  keys = createLocalJWKSet({
    keys: [
      { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256" },
    ],
  });
});

async function signedToken(
  claims: Record<string, unknown> = {},
  options: { key?: CryptoKey; alg?: string } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: "app", email, sub, ...claims })
    .setProtectedHeader({ alg: options.alg ?? "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(now - 10)
    .setNotBefore(now - 10)
    .setExpirationTime(now + 300)
    .sign(options.key ?? privateKey);
}

async function authenticate(token?: string, config = env) {
  return authenticateAdmin(
    new Request("https://example.invalid/admin", {
      headers: token ? { "Cf-Access-Jwt-Assertion": token } : {},
    }),
    config,
    keys,
  );
}

describe("verified administrator identity", () => {
  it("accepts only the approved human email and sub pair", async () => {
    expect(await authenticate(await signedToken())).toEqual({
      status: "authorized",
      principal: { email, sub },
    });
    expect(
      await authenticate(
        await signedToken({
          email: "another@example.invalid",
          sub: "other-id",
        }),
      ),
    ).toEqual({ status: "unauthorized" });
    expect(await authenticate(await signedToken({ sub: "other-id" }))).toEqual({
      status: "unauthorized",
    });
    expect(
      await authenticate(await signedToken({ email: "other@example.invalid" })),
    ).toEqual({ status: "unauthorized" });
  });

  it.each([
    { email: undefined },
    { email: "" },
    { sub: undefined },
    { sub: "" },
    { type: "org" },
    { common_name: "synthetic-service-token" },
    { service_token_id: "synthetic-service-token" },
    { service_token_status: true },
    { email: undefined, sub: "", common_name: "synthetic-service-token" },
  ])("rejects non-human or incomplete claims %#", async (claims) => {
    expect(await authenticate(await signedToken(claims))).toEqual({
      status: "unauthenticated",
    });
  });

  it("rejects absent, malformed, forged, and wrong-key assertions", async () => {
    expect(await authenticate()).toEqual({ status: "unauthenticated" });
    expect(await authenticate("not.a.jwt")).toEqual({
      status: "unauthenticated",
    });
    const token = await signedToken();
    const [header, payload, signature] = token.split(".");
    const forged = `${header}.${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    expect(await authenticate(forged)).toEqual({
      status: "unauthenticated",
    });
    const other = await generateKeyPair("RS256");
    expect(
      await authenticate(
        await signedToken({}, { key: other.privateKey as CryptoKey }),
      ),
    ).toEqual({ status: "unauthenticated" });
  });

  it("rejects the wrong algorithm, issuer, audience, and time claims", async () => {
    const now = Math.floor(Date.now() / 1000);
    const es = await generateKeyPair("ES256");
    expect(
      await authenticate(
        await new SignJWT({ type: "app", email, sub })
          .setProtectedHeader({ alg: "ES256", kid: "test-key" })
          .setIssuer(issuer)
          .setAudience(audience)
          .setIssuedAt(now)
          .setNotBefore(now)
          .setExpirationTime(now + 300)
          .sign(es.privateKey),
      ),
    ).toEqual({ status: "unauthenticated" });
    expect(
      await authenticate(
        await new SignJWT({ type: "app", email, sub })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setIssuer("https://other.cloudflareaccess.com")
          .setAudience(audience)
          .setIssuedAt(now)
          .setNotBefore(now)
          .setExpirationTime(now + 300)
          .sign(privateKey),
      ),
    ).toEqual({ status: "unauthenticated" });
    expect(
      await authenticate(
        await new SignJWT({ type: "app", email, sub })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setIssuer(issuer)
          .setAudience("wrong-audience")
          .setIssuedAt(now)
          .setNotBefore(now)
          .setExpirationTime(now + 300)
          .sign(privateKey),
      ),
    ).toEqual({ status: "unauthenticated" });
    for (const [iat, nbf, exp] of [
      [now - 600, now - 600, now - 300],
      [now + 300, now + 300, now + 600],
      [now + 300, now - 10, now + 600],
    ]) {
      const token = await new SignJWT({ type: "app", email, sub })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt(iat)
        .setNotBefore(nbf)
        .setExpirationTime(exp)
        .sign(privateKey);
      expect(await authenticate(token)).toEqual({ status: "unauthenticated" });
    }
    const missingNbf = await new SignJWT({ type: "app", email, sub })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
    expect(await authenticate(missingNbf)).toEqual({
      status: "unauthenticated",
    });
  });

  it("fails closed for missing configuration and a failed key source", async () => {
    expect(await authenticate(await signedToken(), {} as Env)).toEqual({
      status: "unavailable",
    });
    expect(
      await authenticate(await signedToken(), {
        ...env,
        ADMIN_IDENTITY_PAIRS: "not-json",
      } as Env),
    ).toEqual({ status: "unavailable" });
    expect(
      await authenticateAdmin(
        new Request("https://example.invalid/admin", {
          headers: { "Cf-Access-Jwt-Assertion": await signedToken() },
        }),
        env,
        async () => {
          throw new TypeError("synthetic JWKS failure");
        },
      ),
    ).toEqual({ status: "unavailable" });
  });

  it("requires the trusted server context in future admin loaders and actions", () => {
    const context = new RouterContextProvider();
    expect(() => requireAdmin(context)).toThrow();
    context.set(adminPrincipalContext, { email, sub });
    expect(requireAdmin(context)).toEqual({ email, sub });
  });
});
