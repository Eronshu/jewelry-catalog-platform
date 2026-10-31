import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readStripeTestSettings } from "../../../scripts/commerce-stripe-config.mjs";
let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});
const values = {
  accountId: "acct_" + "0".repeat(16),
  testSecretKey: "sk_test_" + "0".repeat(24),
};
function fixture() {
  directory = mkdtempSync(join(tmpdir(), "fictional-stripe-config-"));
  const repository = join(directory, "repo");
  mkdirSync(repository);
  const path = join(directory, "private.json");
  writeFileSync(path, JSON.stringify(values), { mode: 0o600 });
  return {
    repository,
    path,
    env: { COMMERCE_STRIPE_MODE: "sandbox", COMMERCE_STRIPE_CONFIG_FILE: path },
  };
}
describe("explicit Stripe private file bridge", () => {
  it("does not read inherited credential variables or dotenv by default", () => {
    expect(
      readStripeTestSettings(
        { STRIPE_SECRET_KEY: values.testSecretKey },
        "/repo",
      ),
    ).toBeNull();
  });
  it("accepts only a private external test configuration without logging or returning unrelated values", () => {
    const f = fixture();
    expect(readStripeTestSettings(f.env, f.repository)).toEqual({
      COMMERCE_STRIPE_TEST_SECRET: values.testSecretKey,
      COMMERCE_STRIPE_ACCOUNT_ID: values.accountId,
    });
  });
  it("rejects repository files, symlinks and permissive modes", () => {
    const f = fixture();
    const internal = join(f.repository, "settings.json");
    writeFileSync(internal, JSON.stringify(values), { mode: 0o600 });
    const alias = join(directory!, "alias.json");
    symlinkSync(f.path, alias);
    for (const path of [internal, alias])
      expect(() =>
        readStripeTestSettings(
          { ...f.env, COMMERCE_STRIPE_CONFIG_FILE: path },
          f.repository,
        ),
      ).toThrow("private configuration");
    chmodSync(f.path, 0o644);
    expect(() => readStripeTestSettings(f.env, f.repository)).toThrow(
      "private configuration",
    );
  });
  it.each([
    { ...values, testSecretKey: "sk_live_" + "0".repeat(24) },
    { ...values, extra: "forbidden" },
    { ...values, signingSecret: "invalid" },
  ])("rejects non-test/unexpected settings without leaking input", (bad) => {
    const f = fixture();
    writeFileSync(f.path, JSON.stringify(bad));
    expect(() => readStripeTestSettings(f.env, f.repository)).toThrow(
      "No configuration values are logged",
    );
  });
});
