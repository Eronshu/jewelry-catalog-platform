-- Fictional local work-claim journal only. A historical claim is NOT permission
-- to dispatch. No network work, completion, payment facts or inventory updates.
CREATE TABLE commerce_payment_work (
  attempt_command_id TEXT PRIMARY KEY NOT NULL REFERENCES commerce_payment_attempts(command_id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991),
  next_operation TEXT NOT NULL DEFAULT 'create' CHECK(next_operation IN ('create','query')),
  current_claim_id TEXT REFERENCES commerce_payment_work_claims(claim_id) ON DELETE RESTRICT
);
CREATE TABLE commerce_payment_work_claims (
  claim_id TEXT PRIMARY KEY NOT NULL CHECK(length(claim_id) = 36
    AND substr(claim_id,9,1) = '-' AND substr(claim_id,14,1) = '-'
    AND substr(claim_id,19,1) = '-' AND substr(claim_id,24,1) = '-'
    AND substr(claim_id,15,1) = '4' AND substr(claim_id,20,1) IN ('8','9','a','b')
    AND length(replace(claim_id,'-','')) = 32 AND replace(claim_id,'-','') NOT GLOB '*[^a-f0-9]*'),
  attempt_command_id TEXT NOT NULL REFERENCES commerce_payment_work(attempt_command_id) ON DELETE RESTRICT,
  worker_id TEXT NOT NULL CHECK(length(worker_id) = 36
    AND substr(worker_id,9,1) = '-' AND substr(worker_id,14,1) = '-'
    AND substr(worker_id,19,1) = '-' AND substr(worker_id,24,1) = '-'
    AND substr(worker_id,15,1) = '4' AND substr(worker_id,20,1) IN ('8','9','a','b')
    AND length(replace(worker_id,'-','')) = 32 AND replace(worker_id,'-','') NOT GLOB '*[^a-f0-9]*'),
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  mode TEXT NOT NULL CHECK(mode = 'local-test'),
  instance_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('stripe','paypal')),
  account_ref TEXT NOT NULL,
  expected_version INTEGER NOT NULL CHECK(typeof(expected_version) = 'integer' AND expected_version BETWEEN 1 AND 9007199254740990),
  kind TEXT NOT NULL CHECK(kind IN ('create','query')),
  claimed_at INTEGER NOT NULL CHECK(typeof(claimed_at) = 'integer' AND claimed_at BETWEEN 0 AND 8639999999970000),
  lease_until INTEGER NOT NULL CHECK(typeof(lease_until) = 'integer' AND lease_until = claimed_at + 30000 AND lease_until <= 8640000000000000),
  UNIQUE(attempt_command_id,expected_version)
);
CREATE TRIGGER commerce_payment_work_initial_guard BEFORE INSERT ON commerce_payment_work
WHEN NEW.version != 1 OR NEW.next_operation != 'create' OR NEW.current_claim_id IS NOT NULL
 OR NOT EXISTS (SELECT 1 FROM commerce_payment_attempts WHERE command_id = NEW.attempt_command_id)
 OR EXISTS (SELECT 1 FROM commerce_payment_work WHERE attempt_command_id = NEW.attempt_command_id)
BEGIN SELECT RAISE(ABORT,'commerce_payment_work_initial_conflict'); END;
CREATE TRIGGER commerce_payment_work_no_delete BEFORE DELETE ON commerce_payment_work
BEGIN SELECT RAISE(ABORT,'commerce_payment_work_immutable'); END;
CREATE TRIGGER commerce_payment_work_update_guard BEFORE UPDATE ON commerce_payment_work
WHEN NEW.attempt_command_id IS NOT OLD.attempt_command_id
 OR NEW.version != OLD.version + 1 OR NEW.next_operation != 'query'
 OR NEW.current_claim_id IS NULL OR NEW.current_claim_id IS OLD.current_claim_id
 OR NOT EXISTS (
   SELECT 1 FROM commerce_payment_work_claims n
   LEFT JOIN commerce_payment_work_claims p ON p.claim_id = OLD.current_claim_id
   WHERE n.claim_id = NEW.current_claim_id AND n.attempt_command_id = OLD.attempt_command_id
     AND n.expected_version = OLD.version
     AND (OLD.current_claim_id IS NULL OR (p.attempt_command_id = OLD.attempt_command_id
       AND n.claimed_at >= p.claimed_at AND n.claimed_at >= p.lease_until))
 )
BEGIN SELECT RAISE(ABORT,'commerce_payment_work_update_conflict'); END;
CREATE TRIGGER commerce_payment_work_claims_no_update BEFORE UPDATE ON commerce_payment_work_claims
BEGIN SELECT RAISE(ABORT,'commerce_payment_work_claim_immutable'); END;
CREATE TRIGGER commerce_payment_work_claims_no_delete BEFORE DELETE ON commerce_payment_work_claims
BEGIN SELECT RAISE(ABORT,'commerce_payment_work_claim_immutable'); END;
CREATE TRIGGER commerce_payment_work_claims_no_replace BEFORE INSERT ON commerce_payment_work_claims
WHEN EXISTS (SELECT 1 FROM commerce_payment_work_claims WHERE claim_id = NEW.claim_id
 OR (attempt_command_id = NEW.attempt_command_id AND expected_version = NEW.expected_version))
BEGIN SELECT RAISE(ABORT,'commerce_payment_work_claim_exists'); END;
CREATE TRIGGER commerce_payment_work_claim_guard BEFORE INSERT ON commerce_payment_work_claims
WHEN NOT EXISTS (
 SELECT 1 FROM commerce_payment_work w
 JOIN commerce_payment_attempts a ON a.command_id = w.attempt_command_id
 JOIN commerce_payment_scope s ON s.id = 1
 JOIN commerce_orders o ON o.id = a.order_id
 JOIN commerce_quotes q ON q.id = a.quote_id
 LEFT JOIN commerce_payment_work_claims p ON p.claim_id = w.current_claim_id
 WHERE w.attempt_command_id = NEW.attempt_command_id AND w.version = NEW.expected_version
   AND s.mode = NEW.mode AND s.instance_id = NEW.instance_id
   AND a.mode = NEW.mode AND a.instance_id = NEW.instance_id
   AND a.provider = NEW.provider AND a.account_ref = NEW.account_ref
   AND NEW.account_ref = CASE NEW.provider WHEN 'stripe' THEN s.stripe_account_ref ELSE s.paypal_account_ref END
   AND NEW.claimed_at >= a.occurred_at
   AND (w.current_claim_id IS NULL OR (p.attempt_command_id = w.attempt_command_id
     AND NEW.claimed_at >= p.claimed_at AND NEW.claimed_at >= p.lease_until))
   AND NEW.kind = CASE WHEN w.next_operation = 'create' AND o.state = 'pending_payment'
     AND o.payment_state = 'processing' AND o.fulfillment = 'none'
     AND q.expires_at > NEW.claimed_at AND o.reserve_until > NEW.claimed_at
     THEN 'create' ELSE 'query' END
)
BEGIN SELECT RAISE(ABORT,'commerce_payment_work_claim_conflict'); END;
CREATE TRIGGER commerce_payment_work_claim_apply AFTER INSERT ON commerce_payment_work_claims BEGIN
 UPDATE commerce_payment_work SET version = version + 1, next_operation = 'query', current_claim_id = NEW.claim_id
 WHERE attempt_command_id = NEW.attempt_command_id AND version = NEW.expected_version;
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM commerce_payment_work WHERE attempt_command_id = NEW.attempt_command_id
   AND version = NEW.expected_version + 1 AND next_operation = 'query' AND current_claim_id = NEW.claim_id)
   THEN RAISE(ABORT,'commerce_payment_work_claim_not_applied') END;
END;
-- L03a1 has never dispatched. This one-time backfill must not be reused as an
-- inference that arbitrary historical provider payments were never attempted.
INSERT INTO commerce_payment_work(attempt_command_id) SELECT command_id FROM commerce_payment_attempts;
-- Depends only on the inserted attempt, not on the order-lock trigger's order.
CREATE TRIGGER commerce_payment_attempt_work AFTER INSERT ON commerce_payment_attempts BEGIN
 INSERT INTO commerce_payment_work(attempt_command_id) VALUES (NEW.command_id);
END;
