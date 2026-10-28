-- Empty append-only local processing journal. No seed, backfill or business-state mutation.
-- Existing per-order attempt index can join to this index when counting facts.
CREATE INDEX commerce_capture_facts_by_attempt ON commerce_payment_capture_facts(attempt_command_id);
-- Candidate/hash columns are application witnesses, not SQL recomputation of SHA.
CREATE TABLE commerce_payment_observation_results (
  observation_id TEXT PRIMARY KEY NOT NULL CHECK(typeof(observation_id) = 'text') REFERENCES commerce_payment_observations(observation_id) ON DELETE RESTRICT,
  attempt_command_id TEXT NOT NULL CHECK(typeof(attempt_command_id) = 'text') REFERENCES commerce_payment_attempts(command_id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK(typeof(mode) = 'text' AND mode = 'local-test'),
  instance_id TEXT NOT NULL CHECK(typeof(instance_id) = 'text'),
  provider TEXT NOT NULL CHECK(typeof(provider) = 'text' AND provider IN ('stripe','paypal')),
  account_ref TEXT NOT NULL CHECK(typeof(account_ref) = 'text' AND length(account_ref) BETWEEN 9 AND 100
    AND substr(account_ref,1,8) = 'fixture-' AND account_ref NOT GLOB '*[^a-zA-Z0-9_-]*'),
  request_hash TEXT NOT NULL CHECK(typeof(request_hash) = 'text' AND length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  outcome TEXT NOT NULL CHECK(typeof(outcome) = 'text' AND outcome IN ('observation_only','capture_fact','capture_conflict')),
  fact_id TEXT CHECK(fact_id IS NULL OR (typeof(fact_id) = 'text' AND length(fact_id) = 64 AND fact_id NOT GLOB '*[^a-f0-9]*')) REFERENCES commerce_payment_capture_facts(id) ON DELETE RESTRICT,
  candidate_fact_id TEXT CHECK(candidate_fact_id IS NULL OR (typeof(candidate_fact_id) = 'text' AND length(candidate_fact_id) = 64 AND candidate_fact_id NOT GLOB '*[^a-f0-9]*')),
  payload_hash TEXT CHECK(payload_hash IS NULL OR (typeof(payload_hash) = 'text' AND length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^a-f0-9]*')),
  amount_mismatch INTEGER NOT NULL CHECK(typeof(amount_mismatch) = 'integer' AND amount_mismatch IN (0,1)),
  additional_capture_at_processing INTEGER NOT NULL CHECK(typeof(additional_capture_at_processing) = 'integer' AND additional_capture_at_processing IN (0,1)),
  processed_at INTEGER NOT NULL CHECK(typeof(processed_at) = 'integer' AND processed_at BETWEEN 0 AND 8640000000000000),
  CHECK ((outcome = 'capture_fact' AND fact_id IS NOT NULL)
    OR (outcome IN ('observation_only','capture_conflict') AND fact_id IS NULL)),
  CHECK ((candidate_fact_id IS NULL AND payload_hash IS NULL)
    OR (candidate_fact_id IS NOT NULL AND payload_hash IS NOT NULL))
);
CREATE TRIGGER commerce_observation_results_no_update BEFORE UPDATE ON commerce_payment_observation_results
BEGIN SELECT RAISE(ABORT,'commerce_observation_result_immutable'); END;
CREATE TRIGGER commerce_observation_results_no_delete BEFORE DELETE ON commerce_payment_observation_results
BEGIN SELECT RAISE(ABORT,'commerce_observation_result_immutable'); END;
CREATE TRIGGER commerce_observation_results_no_replace BEFORE INSERT ON commerce_payment_observation_results
WHEN EXISTS (SELECT 1 FROM commerce_payment_observation_results WHERE observation_id = NEW.observation_id)
BEGIN SELECT RAISE(ABORT,'commerce_observation_result_exists'); END;
-- Separate guards keep expression depth below the D1 limit.
CREATE TRIGGER commerce_observation_result_source BEFORE INSERT ON commerce_payment_observation_results
WHEN NOT EXISTS (
  SELECT 1 FROM commerce_payment_observations o
  JOIN commerce_payment_work_claims c ON c.claim_id = o.source_claim_id
  JOIN commerce_payment_attempts a ON a.command_id = o.attempt_command_id
  JOIN commerce_payment_scope s ON s.id = 1
  WHERE o.observation_id = NEW.observation_id AND o.attempt_command_id = NEW.attempt_command_id
    AND o.mode = NEW.mode AND o.instance_id = NEW.instance_id AND o.provider = NEW.provider AND o.account_ref = NEW.account_ref
    AND c.attempt_command_id = a.command_id AND c.worker_id = o.source_worker_id
    AND c.mode = o.mode AND c.instance_id = o.instance_id AND c.provider = o.provider AND c.account_ref = o.account_ref
    AND a.mode = o.mode AND a.instance_id = o.instance_id AND a.provider = o.provider AND a.account_ref = o.account_ref
    AND s.mode = o.mode AND s.instance_id = o.instance_id
    AND o.account_ref = CASE o.provider WHEN 'stripe' THEN s.stripe_account_ref ELSE s.paypal_account_ref END
    AND o.recorded_at >= c.claimed_at AND c.claimed_at >= a.occurred_at AND NEW.processed_at >= o.recorded_at
)
BEGIN SELECT RAISE(ABORT,'commerce_observation_result_source'); END;
CREATE TRIGGER commerce_observation_result_kind BEFORE INSERT ON commerce_payment_observation_results
WHEN NOT EXISTS (
  SELECT 1 FROM commerce_payment_observations o JOIN commerce_payment_attempts a ON a.command_id = o.attempt_command_id
  WHERE o.observation_id = NEW.observation_id AND (
    (o.kind <> 'captured' AND NEW.outcome = 'observation_only' AND NEW.fact_id IS NULL
      AND NEW.candidate_fact_id IS NULL AND NEW.payload_hash IS NULL AND NEW.amount_mismatch = 0
      AND NEW.additional_capture_at_processing = 0)
    OR (o.kind = 'captured' AND NEW.outcome IN ('capture_fact','capture_conflict')
      AND NEW.candidate_fact_id IS NOT NULL AND NEW.payload_hash IS NOT NULL
      AND NEW.amount_mismatch = CASE WHEN o.amount_cents = a.amount_cents AND o.currency = a.currency THEN 0 ELSE 1 END)
  )
)
BEGIN SELECT RAISE(ABORT,'commerce_observation_result_kind'); END;
CREATE TRIGGER commerce_observation_result_fact BEFORE INSERT ON commerce_payment_observation_results
WHEN NEW.outcome = 'capture_fact' AND NOT EXISTS (
  SELECT 1 FROM commerce_payment_observations o JOIN commerce_payment_attempts a ON a.command_id = o.attempt_command_id
  WHERE o.observation_id = NEW.observation_id AND NEW.fact_id = NEW.candidate_fact_id
    AND EXISTS (SELECT 1 FROM commerce_payment_capture_facts f WHERE f.id = NEW.candidate_fact_id AND f.payload_hash = NEW.payload_hash
      AND f.mode = o.mode AND f.instance_id = o.instance_id AND f.provider = o.provider AND f.account_ref = o.account_ref
      AND f.transaction_ref = o.transaction_ref AND f.attempt_command_id = o.attempt_command_id
      AND f.provider_object_ref = o.provider_object_ref AND f.actual_amount_cents = o.amount_cents
      AND f.actual_currency = o.currency AND f.expected_amount_cents = a.amount_cents
      AND f.expected_currency = a.currency AND f.amount_match = CASE WHEN o.amount_cents = a.amount_cents
        AND o.currency = a.currency THEN 'match' ELSE 'mismatch' END)
    AND NOT EXISTS (SELECT 1 FROM commerce_payment_capture_facts f WHERE (f.id = NEW.candidate_fact_id OR (f.mode = o.mode AND f.instance_id = o.instance_id
      AND f.provider = o.provider AND f.account_ref = o.account_ref AND f.transaction_ref = o.transaction_ref)) AND NOT (f.id = NEW.candidate_fact_id AND f.payload_hash = NEW.payload_hash
      AND f.mode = o.mode AND f.instance_id = o.instance_id AND f.provider = o.provider AND f.account_ref = o.account_ref
      AND f.transaction_ref = o.transaction_ref AND f.attempt_command_id = o.attempt_command_id
      AND f.provider_object_ref = o.provider_object_ref AND f.actual_amount_cents = o.amount_cents
      AND f.actual_currency = o.currency AND f.expected_amount_cents = a.amount_cents
      AND f.expected_currency = a.currency AND f.amount_match = CASE WHEN o.amount_cents = a.amount_cents
        AND o.currency = a.currency THEN 'match' ELSE 'mismatch' END))
)
BEGIN SELECT RAISE(ABORT,'commerce_observation_result_fact'); END;
CREATE TRIGGER commerce_observation_result_conflict BEFORE INSERT ON commerce_payment_observation_results
WHEN NEW.outcome = 'capture_conflict' AND NOT EXISTS (
  SELECT 1 FROM commerce_payment_observations o JOIN commerce_payment_attempts a ON a.command_id = o.attempt_command_id
  WHERE o.observation_id = NEW.observation_id AND NEW.fact_id IS NULL AND NEW.additional_capture_at_processing = 0
    AND EXISTS (SELECT 1 FROM commerce_payment_capture_facts f WHERE (f.id = NEW.candidate_fact_id OR (f.mode = o.mode AND f.instance_id = o.instance_id
      AND f.provider = o.provider AND f.account_ref = o.account_ref AND f.transaction_ref = o.transaction_ref)) AND NOT (f.id = NEW.candidate_fact_id AND f.payload_hash = NEW.payload_hash
      AND f.mode = o.mode AND f.instance_id = o.instance_id AND f.provider = o.provider AND f.account_ref = o.account_ref
      AND f.transaction_ref = o.transaction_ref AND f.attempt_command_id = o.attempt_command_id
      AND f.provider_object_ref = o.provider_object_ref AND f.actual_amount_cents = o.amount_cents
      AND f.actual_currency = o.currency AND f.expected_amount_cents = a.amount_cents
      AND f.expected_currency = a.currency AND f.amount_match = CASE WHEN o.amount_cents = a.amount_cents
        AND o.currency = a.currency THEN 'match' ELSE 'mismatch' END))
)
BEGIN SELECT RAISE(ABORT,'commerce_observation_result_conflict'); END;
-- Historical slice at insertion; replay must never recalculate this flag.
CREATE TRIGGER commerce_observation_result_additional BEFORE INSERT ON commerce_payment_observation_results
WHEN NEW.outcome = 'capture_fact' AND NOT EXISTS (
  SELECT 1 FROM commerce_payment_observations o JOIN commerce_payment_attempts a ON a.command_id = o.attempt_command_id
  WHERE o.observation_id = NEW.observation_id AND NEW.additional_capture_at_processing = CASE WHEN (
    SELECT count(*) FROM commerce_payment_capture_facts f JOIN commerce_payment_attempts fa ON fa.command_id = f.attempt_command_id
    WHERE f.mode = o.mode AND f.instance_id = o.instance_id AND fa.order_id = a.order_id
  ) > 1 THEN 1 ELSE 0 END
)
BEGIN SELECT RAISE(ABORT,'commerce_observation_result_additional'); END;
