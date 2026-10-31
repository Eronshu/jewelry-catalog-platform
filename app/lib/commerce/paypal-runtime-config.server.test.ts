import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { paypalRuntimeConfig } from "./paypal-runtime-config.server";
import { readPayPalTestSettings } from "../../../scripts/commerce-paypal-config.mjs";
const origin = "http://127.0.0.1:8794",
  merchant = "2".repeat(13),
  client = "0".repeat(24),
  secret = "1".repeat(24);
const local = {
  COMMERCE_MODE: "local-test",
  COMMERCE_CHECKOUT_INSTANCE_ID: "11111111-1111-4111-8111-111111111111",
  COMMERCE_CHECKOUT_ORIGIN: origin,
};
const enabled = {
  ...local,
  COMMERCE_PAYPAL_SANDBOX: "local-test",
  COMMERCE_PAYPAL_NEW_ORDERS: "local-test",
  COMMERCE_PAYPAL_CAPTURE: "local-test",
  COMMERCE_PAYPAL_MERCHANT_ID: merchant,
  COMMERCE_PAYPAL_CLIENT_ID: client,
  COMMERCE_PAYPAL_CLIENT_SECRET: secret,
};
let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});
function fixture() {
  directory = mkdtempSync(join(tmpdir(), "paypal-nonfunctional-config-"));
  const repository = join(directory, "repo");
  mkdirSync(repository);
  const path = join(directory, "private.json");
  writeFileSync(
    path,
    JSON.stringify({
      merchantId: merchant,
      clientId: client,
      clientSecret: secret,
    }),
    { mode: 0o600 },
  );
  return {
    repository,
    path,
    env: { COMMERCE_PAYPAL_MODE: "sandbox", COMMERCE_PAYPAL_CONFIG_FILE: path },
  };
}
describe("default-off PayPal runtime and private configuration", () => {
  it("does not inherit opaque credentials or load files unless explicitly opted in", () => {
    expect(
      readPayPalTestSettings({ PAYPAL_CLIENT_SECRET: secret }, "/repo"),
    ).toBeNull();
    expect(paypalRuntimeConfig(new Request(origin), local)).toBeNull();
    expect(
      paypalRuntimeConfig(
        new Request(origin),
        Object.assign(Object.create(enabled), local),
      ),
    ).toBeNull();
  });
  it("can pause starts and captures independently without losing query credentials", () => {
    expect(paypalRuntimeConfig(new Request(origin), enabled)).toMatchObject({
      canStart: true,
      canCapture: true,
    });
    expect(
      paypalRuntimeConfig(new Request(origin), {
        ...enabled,
        COMMERCE_PAYPAL_NEW_ORDERS: undefined,
        COMMERCE_PAYPAL_CAPTURE: undefined,
      }),
    ).toMatchObject({
      canStart: false,
      canCapture: false,
      provider: { expectedMerchantId: merchant },
    });
  });
  it.each([
    "https://example.com",
    "http://192.168.1.2:8794",
    "http://127.0.0.1:8795",
  ])("rejects %s before returning configuration", (url) => {
    expect(() => paypalRuntimeConfig(new Request(url), enabled)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });
  it.each([
    { COMMERCE_PAYPAL_MERCHANT_ID: "invalid" },
    { COMMERCE_PAYPAL_CLIENT_ID: "user:name".repeat(3) },
    { COMMERCE_PAYPAL_CLIENT_SECRET: "secret\n".repeat(3) },
    { COMMERCE_PAYPAL_WEBHOOK_ID: "invalid-hyphen" },
  ])("rejects malformed server configuration", (values) => {
    expect(() =>
      paypalRuntimeConfig(new Request(origin), { ...enabled, ...values }),
    ).toThrow(expect.objectContaining({ status: 503 }));
  });
  it("reads only a private external file and never adds a host or unrelated inherited variable", () => {
    const f = fixture();
    expect(readPayPalTestSettings(f.env, f.repository)).toEqual({
      COMMERCE_PAYPAL_MERCHANT_ID: merchant,
      COMMERCE_PAYPAL_CLIENT_ID: client,
      COMMERCE_PAYPAL_CLIENT_SECRET: secret,
    });
  });
  it("rejects repository files, symlinks and permissive file modes", () => {
    const f = fixture(),
      inside = join(f.repository, "config.json"),
      alias = join(directory!, "alias.json");
    writeFileSync(inside, "{}", { mode: 0o600 });
    symlinkSync(f.path, alias);
    for (const path of [inside, alias])
      expect(() =>
        readPayPalTestSettings(
          { ...f.env, COMMERCE_PAYPAL_CONFIG_FILE: path },
          f.repository,
        ),
      ).toThrow("private configuration");
    chmodSync(f.path, 0o644);
    expect(() => readPayPalTestSettings(f.env, f.repository)).toThrow(
      "private configuration",
    );
  });
});
