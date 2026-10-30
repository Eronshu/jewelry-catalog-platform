import { CHECKOUT_CONTRACT_VERSION } from "./checkout";
import { commandHash, getCommerceVariantsByIds } from "./inventory.server";
import {
  buildTestQuote,
  QuoteError,
  type CartLine,
  type DeliveryMethod,
} from "./quote";

export type TestCheckoutContext = {
  mode: "local-test";
  instanceId: string;
  ownerHash: string;
};
export type TestCheckoutSelection = {
  contractVersion: typeof CHECKOUT_CONTRACT_VERSION;
  lines: CartLine[];
  fixtureProfileId: "fixture-ontario" | "fixture-bc";
  deliveryMethod: DeliveryMethod;
};
export class CheckoutAcceptanceError extends Error {
  constructor(
    public readonly code:
      | "invalid_request"
      | "conflict"
      | "stale_quote"
      | "expired_quote"
      | "unavailable",
  ) {
    super("The local test checkout receipt could not be confirmed.");
    this.name = "CheckoutAcceptanceError";
  }
}

const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ttl = 600_000;
const maxDate = 8_640_000_000_000_000;
// Private immutable application witness, NOT an independent SQL policy registry.
// All values and profiles are fictional; no merchant or Canadian tax assertion.
const rules = Object.freeze({
  testOnly: true,
  version: "fictional-checkout-acceptance-v1",
  taxBasisPoints: 1000,
  rounding: "half-up-items-and-delivery",
  methods: Object.freeze({ pickup: 0, local_delivery: 500, shipping: 1500 }),
});
/** Fresh copy of the fixed local policy witness, never a mutable shared registry. */
export function testCheckoutRulesWitness() {
  return structuredClone(rules);
}

const profiles = Object.freeze({
  "fixture-ontario": Object.freeze({
    name: "Fictional Ontario Customer",
    email: "ontario@example.invalid",
    address: Object.freeze({
      line1: "100 Fictional Test Street",
      city: "Test City",
      province: "ON",
      postalCode: "K1A0B1",
      country: "CA",
    }),
  }),
  "fixture-bc": Object.freeze({
    name: "Fictional BC Customer",
    email: "bc@example.invalid",
    address: Object.freeze({
      line1: "200 Fictional Test Street",
      city: "Test City",
      province: "BC",
      postalCode: "V6B1A1",
      country: "CA",
    }),
  }),
});

function invalid(): never {
  throw new CheckoutAcceptanceError("invalid_request");
}
/** Read descriptors, never getters. Copy own data before any asynchronous work. */
function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length
  )
    invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function key(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) invalid();
  return value;
}
function contextCopy(raw: unknown): TestCheckoutContext {
  const data = record(raw, ["mode", "instanceId", "ownerHash"]);
  if (
    data.mode !== "local-test" ||
    typeof data.ownerHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.ownerHash)
  )
    invalid();
  return {
    mode: "local-test",
    instanceId: key(data.instanceId),
    ownerHash: data.ownerHash,
  };
}
function selectionCopy(raw: unknown): TestCheckoutSelection {
  const data = record(raw, [
    "contractVersion",
    "lines",
    "fixtureProfileId",
    "deliveryMethod",
  ]);
  if (
    data.contractVersion !== CHECKOUT_CONTRACT_VERSION ||
    (data.fixtureProfileId !== "fixture-ontario" &&
      data.fixtureProfileId !== "fixture-bc") ||
    (data.deliveryMethod !== "pickup" &&
      data.deliveryMethod !== "local_delivery" &&
      data.deliveryMethod !== "shipping") ||
    (data.deliveryMethod === "local_delivery" &&
      data.fixtureProfileId !== "fixture-ontario")
  )
    invalid();
  const array = data.lines;
  if (!Array.isArray(array) || Object.getPrototypeOf(array) !== Array.prototype)
    invalid();
  const length = Object.getOwnPropertyDescriptor(array, "length")?.value;
  if (
    !Number.isInteger(length) ||
    length < 1 ||
    length > 20 ||
    Reflect.ownKeys(array).length !== length + 1
  )
    invalid();
  const lines: CartLine[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(array, String(i));
    if (!descriptor || !("value" in descriptor)) invalid();
    const line = record(descriptor.value, ["variantId", "quantity"]);
    if (
      typeof line.variantId !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(line.variantId) ||
      !Number.isSafeInteger(line.quantity) ||
      (line.quantity as number) < 1 ||
      (line.quantity as number) > 20
    )
      invalid();
    lines.push({
      variantId: line.variantId,
      quantity: line.quantity as number,
    });
  }
  lines.sort((a, b) =>
    a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0,
  );
  if (new Set(lines.map((line) => line.variantId)).size !== lines.length)
    invalid();
  return {
    contractVersion: CHECKOUT_CONTRACT_VERSION,
    lines,
    fixtureProfileId: data.fixtureProfileId,
    deliveryMethod: data.deliveryMethod,
  };
}
function time(clock: () => number, reserveTtl: boolean): number {
  const value = clock();
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maxDate - (reserveTtl ? ttl : 0)
  )
    invalid();
  return value;
}
type Snapshot = Omit<ReturnType<typeof buildTestQuote>, "rulesVersion"> & {
  contractVersion: typeof CHECKOUT_CONTRACT_VERSION;
  rulesVersion: string;
  fixtureProfile: {
    id: TestCheckoutSelection["fixtureProfileId"];
    name: string;
    email: string;
    address: {
      line1: string;
      city: string;
      province: string;
      postalCode: string;
      country: string;
    } | null;
  };
  taxBasisPoints: number;
  taxBaseCents: number;
};
export type TestCheckoutQuoteReceipt = {
  testOnly: true;
  quoteId: string;
  issuedAt: number;
  expiresAt: number;
  rulesHash: string;
  snapshot: Omit<Snapshot, "fixtureProfile">;
  fixtureProfileId: TestCheckoutSelection["fixtureProfileId"];
};
export type TestCheckoutAcceptanceReceipt = {
  testOnly: true;
  acceptanceId: string;
  quoteId: string;
  acceptedAt: number;
};
type SavedQuote = {
  quote_id: string;
  mode: string;
  instance_id: string;
  owner_hash: string;
  issue_key: string;
  request_hash: string;
  selection_json: string;
  snapshot_json: string;
  rules_json: string;
  rules_hash: string;
  created_at: number;
  expires_at: number;
};
type SavedAcceptance = {
  acceptance_id: string;
  mode: string;
  instance_id: string;
  owner_hash: string;
  acceptance_key: string;
  quote_id: string;
  request_hash: string;
  accepted_at: number;
};
function quoteReceipt(row: SavedQuote): TestCheckoutQuoteReceipt {
  const { fixtureProfile, ...snapshot } = JSON.parse(
    row.snapshot_json,
  ) as Snapshot;
  return {
    testOnly: true,
    quoteId: row.quote_id,
    issuedAt: row.created_at,
    expiresAt: row.expires_at,
    rulesHash: row.rules_hash,
    snapshot,
    fixtureProfileId: fixtureProfile.id,
  };
}
function acceptanceReceipt(
  row: SavedAcceptance,
): TestCheckoutAcceptanceReceipt {
  return {
    testOnly: true,
    acceptanceId: row.acceptance_id,
    quoteId: row.quote_id,
    acceptedAt: row.accepted_at,
  };
}
function sameScope(
  row: { mode: string; instance_id: string; owner_hash: string },
  context: TestCheckoutContext,
) {
  return (
    row.mode === context.mode &&
    row.instance_id === context.instanceId &&
    row.owner_hash === context.ownerHash
  );
}

/** No orders, reservations, payments, routes or arbitrary contact input. The
 * trusted context partitions rows; it does not attest a DB or payment account. */
async function issueQuote(
  db: D1Database,
  trusted: TestCheckoutContext,
  raw: unknown,
  clock: () => number = Date.now,
): Promise<TestCheckoutQuoteReceipt> {
  const context = contextCopy(trusted);
  const input = record(raw, ["issueKey", "selection"]);
  const issueKey = key(input.issueKey);
  const selection = selectionCopy(input.selection);
  if (typeof clock !== "function") invalid();
  const descriptor = structuredClone(rules);
  const profile = structuredClone(profiles[selection.fixtureProfileId]);
  const selectionJson = JSON.stringify(selection);
  const rulesJson = JSON.stringify(descriptor);
  const requestHash = await commandHash({
    operation: "issue-test-checkout-v1",
    context,
    selection,
  });
  const rulesHash = await commandHash(descriptor);
  const find = async (candidateId: string | null = null) => {
    const rows = await db
      .prepare(
        `SELECT * FROM commerce_checkout_quotes WHERE quote_id=? OR (mode=? AND instance_id=? AND owner_hash=? AND issue_key=?)`,
      )
      .bind(
        candidateId,
        context.mode,
        context.instanceId,
        context.ownerHash,
        issueKey,
      )
      .all<SavedQuote>();
    if (rows.results.length === 0) return null;
    const row = rows.results[0];
    if (
      rows.results.length !== 1 ||
      !sameScope(row, context) ||
      row.issue_key !== issueKey ||
      row.request_hash !== requestHash ||
      row.selection_json !== selectionJson
    )
      throw new CheckoutAcceptanceError("conflict");
    return quoteReceipt(row);
  };
  const previous = await find();
  if (previous) return previous;
  let quoteId: string | null = null;
  try {
    const variants = await getCommerceVariantsByIds(
      db,
      selection.lines.map((line) => line.variantId),
    );
    const base = buildTestQuote(
      selection.lines,
      variants,
      selection.deliveryMethod,
      0,
    );
    const shippingCents = descriptor.methods[selection.deliveryMethod];
    const taxBaseCents = base.subtotalCents + shippingCents;
    const taxCents = Number(
      (BigInt(taxBaseCents) * BigInt(descriptor.taxBasisPoints) + 5000n) /
        10000n,
    );
    quoteId = crypto.randomUUID();
    const statement = db.prepare(
      `INSERT INTO commerce_checkout_quotes(quote_id,mode,instance_id,owner_hash,issue_key,request_hash,selection_json,snapshot_json,rules_json,rules_hash,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const issuedAt = time(clock, true);
    const snapshot: Snapshot = {
      ...base,
      expiresAt: issuedAt + ttl,
      contractVersion: CHECKOUT_CONTRACT_VERSION,
      rulesVersion: descriptor.version,
      fixtureProfile: {
        id: selection.fixtureProfileId,
        name: profile.name,
        email: profile.email,
        address: selection.deliveryMethod === "pickup" ? null : profile.address,
      },
      shippingCents,
      taxBaseCents,
      taxBasisPoints: descriptor.taxBasisPoints,
      taxCents,
      totalCents: taxBaseCents + taxCents,
    };
    await statement
      .bind(
        quoteId,
        context.mode,
        context.instanceId,
        context.ownerHash,
        issueKey,
        requestHash,
        selectionJson,
        JSON.stringify(snapshot),
        rulesJson,
        rulesHash,
        issuedAt,
        issuedAt + ttl,
      )
      .run();
    const saved = await find(quoteId);
    if (!saved) throw new CheckoutAcceptanceError("unavailable");
    return saved;
  } catch (error) {
    // A matching caller may commit after our initial lookup, before preparation
    // detects a stale item or clock. Original immutable receipts still win.
    const replay = await find(quoteId);
    if (replay) return replay;
    throw classify(error);
  }
}

async function acceptQuote(
  db: D1Database,
  trusted: TestCheckoutContext,
  raw: unknown,
  clock: () => number = Date.now,
): Promise<TestCheckoutAcceptanceReceipt> {
  const context = contextCopy(trusted);
  const input = record(raw, [
    "acceptanceKey",
    "quoteId",
    "selection",
    "acknowledge",
  ]);
  const acceptanceKey = key(input.acceptanceKey);
  const quoteId = key(input.quoteId);
  const selection = selectionCopy(input.selection);
  if (input.acknowledge !== true || typeof clock !== "function") invalid();
  const descriptor = structuredClone(rules);
  const rulesJson = JSON.stringify(descriptor);
  const selectionJson = JSON.stringify(selection);
  const requestHash = await commandHash({
    operation: "accept-test-checkout-v1",
    context,
    quoteId,
    selection,
    acknowledge: true,
  });
  const rulesHash = await commandHash(descriptor);
  const quote = await db
    .prepare(
      "SELECT * FROM commerce_checkout_quotes WHERE quote_id=? AND mode=? AND instance_id=? AND owner_hash=?",
    )
    .bind(quoteId, context.mode, context.instanceId, context.ownerHash)
    .first<SavedQuote>();
  if (
    !quote ||
    !sameScope(quote, context) ||
    quote.quote_id !== quoteId ||
    quote.selection_json !== selectionJson
  )
    throw new CheckoutAcceptanceError("conflict");
  const find = async (candidateId: string | null = null) => {
    const rows = await db
      .prepare(
        `SELECT * FROM commerce_checkout_acceptances WHERE acceptance_id=? OR quote_id=? OR (mode=? AND instance_id=? AND owner_hash=? AND acceptance_key=?)`,
      )
      .bind(
        candidateId,
        quoteId,
        context.mode,
        context.instanceId,
        context.ownerHash,
        acceptanceKey,
      )
      .all<SavedAcceptance>();
    if (rows.results.length === 0) return null;
    const row = rows.results[0];
    if (
      rows.results.length !== 1 ||
      !sameScope(row, context) ||
      row.quote_id !== quoteId ||
      row.acceptance_key !== acceptanceKey ||
      row.request_hash !== requestHash
    )
      throw new CheckoutAcceptanceError("conflict");
    return acceptanceReceipt(row);
  };
  const previous = await find();
  if (previous) return previous;
  let acceptanceId: string | null = null;
  try {
    if (quote.rules_hash !== rulesHash || quote.rules_json !== rulesJson)
      throw new CheckoutAcceptanceError("stale_quote");
    acceptanceId = crypto.randomUUID();
    const statement = db.prepare(
      `INSERT INTO commerce_checkout_acceptances(acceptance_id,mode,instance_id,owner_hash,acceptance_key,quote_id,request_hash,accepted_at) VALUES (?,?,?,?,?,?,?,?)`,
    );
    // Fresh clock after preparation, not the time at the beginning of the request.
    const acceptedAt = time(clock, false);
    if (acceptedAt < quote.created_at || acceptedAt >= quote.expires_at)
      throw new CheckoutAcceptanceError("expired_quote");
    await statement
      .bind(
        acceptanceId,
        context.mode,
        context.instanceId,
        context.ownerHash,
        acceptanceKey,
        quoteId,
        requestHash,
        acceptedAt,
      )
      .run();
    const saved = await find(acceptanceId);
    if (!saved) throw new CheckoutAcceptanceError("unavailable");
    return saved;
  } catch (error) {
    const replay = await find(acceptanceId);
    if (replay) return replay;
    throw classify(error);
  }
}

function classify(error: unknown): CheckoutAcceptanceError {
  if (error instanceof CheckoutAcceptanceError) return error;
  if (
    error instanceof QuoteError ||
    (error instanceof Error &&
      /commerce_checkout_(quote|acceptance)_stale/.test(error.message))
  )
    return new CheckoutAcceptanceError("stale_quote");
  return new CheckoutAcceptanceError("unavailable");
}

/** Public boundaries never expose storage errors, SQL, inputs or an error cause. */
export async function issueTestCheckoutQuote(
  db: D1Database,
  context: TestCheckoutContext,
  input: unknown,
  clock: () => number = Date.now,
): Promise<TestCheckoutQuoteReceipt> {
  try {
    return await issueQuote(db, context, input, clock);
  } catch (error) {
    throw classify(error);
  }
}
export async function acceptTestCheckoutQuote(
  db: D1Database,
  context: TestCheckoutContext,
  input: unknown,
  clock: () => number = Date.now,
): Promise<TestCheckoutAcceptanceReceipt> {
  try {
    return await acceptQuote(db, context, input, clock);
  } catch (error) {
    throw classify(error);
  }
}
