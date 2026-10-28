-- INERT synthetic local normalized event variants; no verified provider provenance.
-- No attempt/order foreign key or lookup: candidate_request_id is an untrusted hint.
-- No facts, observations, work or business changes. The 0014 CREATE gate does NOT
-- inspect this inbox. Verified external events require a future source-proof and
-- pending-event gate bridge before any real provider integration.
CREATE TABLE commerce_payment_event_receipts (
  receipt_id TEXT PRIMARY KEY NOT NULL CHECK(typeof(receipt_id) = 'text' AND length(receipt_id) = 64 AND receipt_id NOT GLOB '*[^a-f0-9]*'),
  mode TEXT NOT NULL CHECK(typeof(mode) = 'text' AND mode = 'local-test'),
  instance_id TEXT NOT NULL CHECK(typeof(instance_id) = 'text' AND length(instance_id) = 36 AND substr(instance_id,9,1) = '-' AND substr(instance_id,14,1) = '-' AND substr(instance_id,19,1) = '-' AND substr(instance_id,24,1) = '-' AND substr(instance_id,15,1) = '4' AND substr(instance_id,20,1) IN ('8','9','a','b') AND length(replace(instance_id,'-','')) = 32 AND replace(instance_id,'-','') NOT GLOB '*[^a-f0-9]*'),
  provider TEXT NOT NULL CHECK(typeof(provider) = 'text' AND provider IN ('stripe','paypal')),
  account_ref TEXT NOT NULL CHECK(typeof(account_ref) = 'text' AND length(account_ref) BETWEEN 9 AND 100 AND substr(account_ref,1,8) = 'fixture-' AND account_ref NOT GLOB '*[^a-zA-Z0-9_-]*'),
  event_ref TEXT NOT NULL CHECK(typeof(event_ref) = 'text' AND length(event_ref) BETWEEN 9 AND 100 AND substr(event_ref,1,8) = 'fixture-' AND event_ref NOT GLOB '*[^a-zA-Z0-9_-]*'),
  payload_hash TEXT NOT NULL CHECK(typeof(payload_hash) = 'text' AND length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^a-f0-9]*'),
  candidate_request_id TEXT CHECK(candidate_request_id IS NULL OR (typeof(candidate_request_id) = 'text' AND length(candidate_request_id) = 36 AND substr(candidate_request_id,9,1) = '-' AND substr(candidate_request_id,14,1) = '-' AND substr(candidate_request_id,19,1) = '-' AND substr(candidate_request_id,24,1) = '-' AND substr(candidate_request_id,15,1) = '4' AND substr(candidate_request_id,20,1) IN ('8','9','a','b') AND length(replace(candidate_request_id,'-','')) = 32 AND replace(candidate_request_id,'-','') NOT GLOB '*[^a-f0-9]*')),
  kind TEXT NOT NULL CHECK(typeof(kind) = 'text' AND kind IN ('unknown','not_found','pending','approved','reported_failed','captured','unmapped')),
  provider_object_ref TEXT CHECK(provider_object_ref IS NULL OR (typeof(provider_object_ref) = 'text' AND length(provider_object_ref) BETWEEN 9 AND 100 AND substr(provider_object_ref,1,8) = 'fixture-' AND provider_object_ref NOT GLOB '*[^a-zA-Z0-9_-]*')),
  transaction_ref TEXT CHECK(transaction_ref IS NULL OR (typeof(transaction_ref) = 'text' AND length(transaction_ref) BETWEEN 9 AND 100 AND substr(transaction_ref,1,8) = 'fixture-' AND transaction_ref NOT GLOB '*[^a-zA-Z0-9_-]*')),
  amount_cents INTEGER CHECK(amount_cents IS NULL OR (typeof(amount_cents) = 'integer' AND amount_cents BETWEEN 1 AND 9007199254740991)),
  -- Fixture token type only, not a claim of supported provider currencies.
  currency TEXT CHECK(currency IS NULL OR (typeof(currency) = 'text' AND length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*')),
  occurred_at INTEGER CHECK(occurred_at IS NULL OR (typeof(occurred_at) = 'integer' AND occurred_at BETWEEN 0 AND 8640000000000000)),
  received_at INTEGER NOT NULL CHECK(typeof(received_at) = 'integer' AND received_at BETWEEN 0 AND 8640000000000000),
  CHECK (
    (kind = 'captured' AND provider_object_ref IS NOT NULL AND transaction_ref IS NOT NULL AND amount_cents IS NOT NULL AND currency IS NOT NULL)
    OR (kind IN ('pending','approved','reported_failed') AND provider_object_ref IS NOT NULL AND transaction_ref IS NULL AND amount_cents IS NULL AND currency IS NULL)
    OR (kind IN ('unknown','not_found','unmapped') AND transaction_ref IS NULL AND amount_cents IS NULL AND currency IS NULL)
  ),
  UNIQUE(mode,instance_id,provider,account_ref,event_ref,payload_hash)
);
CREATE TRIGGER commerce_payment_event_receipts_no_update BEFORE UPDATE ON commerce_payment_event_receipts
BEGIN SELECT RAISE(ABORT,'commerce_payment_event_receipt_immutable'); END;
CREATE TRIGGER commerce_payment_event_receipts_no_delete BEFORE DELETE ON commerce_payment_event_receipts
BEGIN SELECT RAISE(ABORT,'commerce_payment_event_receipt_immutable'); END;
CREATE TRIGGER commerce_payment_event_receipts_no_replace BEFORE INSERT ON commerce_payment_event_receipts
WHEN EXISTS (SELECT 1 FROM commerce_payment_event_receipts WHERE receipt_id = NEW.receipt_id
  OR (mode = NEW.mode AND instance_id = NEW.instance_id AND provider = NEW.provider
    AND account_ref = NEW.account_ref AND event_ref = NEW.event_ref AND payload_hash = NEW.payload_hash))
BEGIN SELECT RAISE(ABORT,'commerce_payment_event_receipt_exists'); END;
-- Hashes/IDs are application witnesses, not SQL-recomputed hashes or provenance.
-- Provider clock has no causal ordering relationship with received_at.
CREATE TRIGGER commerce_payment_event_receipt_scope BEFORE INSERT ON commerce_payment_event_receipts
WHEN NOT EXISTS (SELECT 1 FROM commerce_payment_scope s WHERE s.id = 1
  AND s.mode = NEW.mode AND s.instance_id = NEW.instance_id
  AND NEW.account_ref = CASE NEW.provider WHEN 'stripe' THEN s.stripe_account_ref ELSE s.paypal_account_ref END)
BEGIN SELECT RAISE(ABORT,'commerce_payment_event_receipt_scope'); END;
