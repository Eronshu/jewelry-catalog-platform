-- Append-only synthetic local capture facts, not verification, dispatch authority,
-- payment outcome or fulfillment permission. No seed, backfill or state updates.
CREATE TABLE commerce_payment_capture_facts (
  id TEXT PRIMARY KEY NOT NULL CHECK(typeof(id) = 'text' AND length(id) = 64 AND id NOT GLOB '*[^a-f0-9]*'),
  attempt_command_id TEXT NOT NULL CHECK(typeof(attempt_command_id) = 'text') REFERENCES commerce_payment_attempts(command_id) ON DELETE RESTRICT,
  source_claim_id TEXT NOT NULL CHECK(typeof(source_claim_id) = 'text') REFERENCES commerce_payment_work_claims(claim_id) ON DELETE RESTRICT,
  source_worker_id TEXT NOT NULL CHECK(typeof(source_worker_id) = 'text'),
  mode TEXT NOT NULL CHECK(typeof(mode) = 'text' AND mode = 'local-test'),
  instance_id TEXT NOT NULL CHECK(typeof(instance_id) = 'text'),
  provider TEXT NOT NULL CHECK(typeof(provider) = 'text' AND provider IN ('stripe','paypal')),
  account_ref TEXT NOT NULL CHECK(typeof(account_ref) = 'text' AND length(account_ref) BETWEEN 9 AND 100
    AND substr(account_ref,1,8) = 'fixture-' AND account_ref NOT GLOB '*[^a-zA-Z0-9_-]*'),
  provider_object_ref TEXT NOT NULL CHECK(typeof(provider_object_ref) = 'text' AND length(provider_object_ref) BETWEEN 9 AND 100
    AND substr(provider_object_ref,1,8) = 'fixture-' AND provider_object_ref NOT GLOB '*[^a-zA-Z0-9_-]*'),
  transaction_ref TEXT NOT NULL CHECK(typeof(transaction_ref) = 'text' AND length(transaction_ref) BETWEEN 9 AND 100
    AND substr(transaction_ref,1,8) = 'fixture-' AND transaction_ref NOT GLOB '*[^a-zA-Z0-9_-]*'),
  actual_amount_cents INTEGER NOT NULL CHECK(typeof(actual_amount_cents) = 'integer' AND actual_amount_cents BETWEEN 1 AND 9007199254740991),
  -- Only a synthetic three-letter token; this does not assert an ISO currency.
  actual_currency TEXT NOT NULL CHECK(typeof(actual_currency) = 'text' AND length(actual_currency) = 3 AND actual_currency NOT GLOB '*[^A-Z]*'),
  expected_amount_cents INTEGER NOT NULL CHECK(typeof(expected_amount_cents) = 'integer' AND expected_amount_cents BETWEEN 1 AND 9007199254740991),
  expected_currency TEXT NOT NULL CHECK(typeof(expected_currency) = 'text' AND expected_currency = 'CAD'),
  amount_match TEXT NOT NULL CHECK(typeof(amount_match) = 'text' AND amount_match IN ('match','mismatch')),
  payload_hash TEXT NOT NULL CHECK(typeof(payload_hash) = 'text' AND length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^a-f0-9]*'),
  recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at) = 'integer' AND recorded_at BETWEEN 0 AND 8640000000000000),
  UNIQUE(mode,instance_id,provider,account_ref,transaction_ref)
);
CREATE TRIGGER commerce_capture_facts_no_update BEFORE UPDATE ON commerce_payment_capture_facts
BEGIN SELECT RAISE(ABORT,'commerce_capture_fact_immutable'); END;
CREATE TRIGGER commerce_capture_facts_no_delete BEFORE DELETE ON commerce_payment_capture_facts
BEGIN SELECT RAISE(ABORT,'commerce_capture_fact_immutable'); END;
-- INSERT OR REPLACE must never erase evidence through either unique identity.
CREATE TRIGGER commerce_capture_facts_no_replace BEFORE INSERT ON commerce_payment_capture_facts
WHEN EXISTS (SELECT 1 FROM commerce_payment_capture_facts WHERE id = NEW.id OR
  (mode = NEW.mode AND instance_id = NEW.instance_id AND provider = NEW.provider
    AND account_ref = NEW.account_ref AND transaction_ref = NEW.transaction_ref))
BEGIN SELECT RAISE(ABORT,'commerce_capture_fact_exists'); END;
CREATE TRIGGER commerce_capture_fact_guard BEFORE INSERT ON commerce_payment_capture_facts
WHEN NOT EXISTS (
  SELECT 1 FROM commerce_payment_work_claims c
  JOIN commerce_payment_attempts a ON a.command_id = c.attempt_command_id
  JOIN commerce_payment_scope s ON s.id = 1
  WHERE c.claim_id = NEW.source_claim_id AND c.worker_id = NEW.source_worker_id
    AND c.attempt_command_id = NEW.attempt_command_id
    AND c.mode = NEW.mode AND c.instance_id = NEW.instance_id
    AND c.provider = NEW.provider AND c.account_ref = NEW.account_ref
    AND a.mode = NEW.mode AND a.instance_id = NEW.instance_id
    AND a.provider = NEW.provider AND a.account_ref = NEW.account_ref
    AND s.mode = NEW.mode AND s.instance_id = NEW.instance_id
    AND NEW.account_ref = CASE NEW.provider WHEN 'stripe' THEN s.stripe_account_ref ELSE s.paypal_account_ref END
    AND NEW.recorded_at >= c.claimed_at AND NEW.recorded_at >= a.occurred_at
    AND NEW.expected_amount_cents = a.amount_cents AND NEW.expected_currency = a.currency
    AND NEW.amount_match = CASE WHEN NEW.actual_amount_cents = a.amount_cents
      AND NEW.actual_currency = a.currency THEN 'match' ELSE 'mismatch' END
)
BEGIN SELECT RAISE(ABORT,'commerce_capture_fact_conflict'); END;
