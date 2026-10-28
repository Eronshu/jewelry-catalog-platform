-- Normalized synthetic local observations only: not verified webhooks, payment
-- outcome, capture facts, sending permission or authority to release/fulfill.
-- No seed, backfill, processing or changes to existing business state.
CREATE TABLE commerce_payment_observations (
  observation_id TEXT PRIMARY KEY NOT NULL CHECK(typeof(observation_id) = 'text' AND length(observation_id) = 36
    AND substr(observation_id,9,1) = '-' AND substr(observation_id,14,1) = '-'
    AND substr(observation_id,19,1) = '-' AND substr(observation_id,24,1) = '-'
    AND substr(observation_id,15,1) = '4' AND substr(observation_id,20,1) IN ('8','9','a','b')
    AND length(replace(observation_id,'-','')) = 32 AND replace(observation_id,'-','') NOT GLOB '*[^a-f0-9]*'),
  attempt_command_id TEXT NOT NULL CHECK(typeof(attempt_command_id) = 'text') REFERENCES commerce_payment_attempts(command_id) ON DELETE RESTRICT,
  source_claim_id TEXT NOT NULL CHECK(typeof(source_claim_id) = 'text') REFERENCES commerce_payment_work_claims(claim_id) ON DELETE RESTRICT,
  source_worker_id TEXT NOT NULL CHECK(typeof(source_worker_id) = 'text'),
  mode TEXT NOT NULL CHECK(typeof(mode) = 'text' AND mode = 'local-test'),
  instance_id TEXT NOT NULL CHECK(typeof(instance_id) = 'text'),
  provider TEXT NOT NULL CHECK(typeof(provider) = 'text' AND provider IN ('stripe','paypal')),
  account_ref TEXT NOT NULL CHECK(typeof(account_ref) = 'text' AND length(account_ref) BETWEEN 9 AND 100
    AND substr(account_ref,1,8) = 'fixture-' AND account_ref NOT GLOB '*[^a-zA-Z0-9_-]*'),
  kind TEXT NOT NULL CHECK(typeof(kind) = 'text' AND kind IN ('unknown','not_found','pending','approved','reported_failed','captured')),
  provider_object_ref TEXT CHECK(provider_object_ref IS NULL OR (typeof(provider_object_ref) = 'text'
    AND length(provider_object_ref) BETWEEN 9 AND 100 AND substr(provider_object_ref,1,8) = 'fixture-'
    AND provider_object_ref NOT GLOB '*[^a-zA-Z0-9_-]*')),
  transaction_ref TEXT CHECK(transaction_ref IS NULL OR (typeof(transaction_ref) = 'text'
    AND length(transaction_ref) BETWEEN 9 AND 100 AND substr(transaction_ref,1,8) = 'fixture-'
    AND transaction_ref NOT GLOB '*[^a-zA-Z0-9_-]*')),
  amount_cents INTEGER CHECK(amount_cents IS NULL OR (typeof(amount_cents) = 'integer' AND amount_cents BETWEEN 1 AND 9007199254740991)),
  -- A synthetic three-uppercase-letter type, not an assertion of ISO support.
  currency TEXT CHECK(currency IS NULL OR (typeof(currency) = 'text' AND length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*')),
  request_hash TEXT NOT NULL CHECK(typeof(request_hash) = 'text' AND length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at) = 'integer' AND recorded_at BETWEEN 0 AND 8640000000000000),
  CHECK (
    (kind = 'captured' AND provider_object_ref IS NOT NULL AND transaction_ref IS NOT NULL AND amount_cents IS NOT NULL AND currency IS NOT NULL)
    OR (kind IN ('pending','approved','reported_failed') AND provider_object_ref IS NOT NULL AND transaction_ref IS NULL AND amount_cents IS NULL AND currency IS NULL)
    OR (kind IN ('unknown','not_found') AND transaction_ref IS NULL AND amount_cents IS NULL AND currency IS NULL)
  )
);
CREATE TRIGGER commerce_payment_observations_no_update BEFORE UPDATE ON commerce_payment_observations
BEGIN SELECT RAISE(ABORT,'commerce_payment_observation_immutable'); END;
CREATE TRIGGER commerce_payment_observations_no_delete BEFORE DELETE ON commerce_payment_observations
BEGIN SELECT RAISE(ABORT,'commerce_payment_observation_immutable'); END;
CREATE TRIGGER commerce_payment_observations_no_replace BEFORE INSERT ON commerce_payment_observations
WHEN EXISTS (SELECT 1 FROM commerce_payment_observations WHERE observation_id = NEW.observation_id)
BEGIN SELECT RAISE(ABORT,'commerce_payment_observation_exists'); END;
-- Immutable historical claim binding deliberately ignores current lease/order
-- state: late observations must survive worker replacement or order evolution.
CREATE TRIGGER commerce_payment_observation_guard BEFORE INSERT ON commerce_payment_observations
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
)
BEGIN SELECT RAISE(ABORT,'commerce_payment_observation_conflict'); END;
