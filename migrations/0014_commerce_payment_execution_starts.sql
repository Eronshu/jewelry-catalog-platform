-- Internal synthetic execution registration only, never dispatch permission.
-- Empty additive journal: no backfill or order/work/payment/inventory changes.
CREATE TABLE commerce_payment_execution_starts (
  claim_id TEXT PRIMARY KEY NOT NULL CHECK(typeof(claim_id) = 'text') REFERENCES commerce_payment_work_claims(claim_id) ON DELETE RESTRICT,
  attempt_command_id TEXT NOT NULL CHECK(typeof(attempt_command_id) = 'text') REFERENCES commerce_payment_attempts(command_id) ON DELETE RESTRICT,
  worker_id TEXT NOT NULL CHECK(typeof(worker_id) = 'text'),
  mode TEXT NOT NULL CHECK(typeof(mode) = 'text' AND mode = 'local-test'),
  instance_id TEXT NOT NULL CHECK(typeof(instance_id) = 'text'),
  provider TEXT NOT NULL CHECK(typeof(provider) = 'text' AND provider IN ('stripe','paypal')),
  account_ref TEXT NOT NULL CHECK(typeof(account_ref) = 'text' AND length(account_ref) BETWEEN 9 AND 100
    AND substr(account_ref,1,8) = 'fixture-' AND account_ref NOT GLOB '*[^a-zA-Z0-9_-]*'),
  expected_work_version INTEGER NOT NULL CHECK(typeof(expected_work_version) = 'integer' AND expected_work_version BETWEEN 2 AND 9007199254740991),
  operation TEXT NOT NULL CHECK(typeof(operation) = 'text' AND operation IN ('create','query')),
  request_hash TEXT NOT NULL CHECK(typeof(request_hash) = 'text' AND length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  started_at INTEGER NOT NULL CHECK(typeof(started_at) = 'integer' AND started_at BETWEEN 0 AND 8640000000000000)
);
CREATE TRIGGER commerce_execution_starts_no_update BEFORE UPDATE ON commerce_payment_execution_starts
BEGIN SELECT RAISE(ABORT,'commerce_execution_start_immutable'); END;
CREATE TRIGGER commerce_execution_starts_no_delete BEFORE DELETE ON commerce_payment_execution_starts
BEGIN SELECT RAISE(ABORT,'commerce_execution_start_immutable'); END;
CREATE TRIGGER commerce_execution_starts_no_replace BEFORE INSERT ON commerce_payment_execution_starts
WHEN EXISTS (SELECT 1 FROM commerce_payment_execution_starts WHERE claim_id = NEW.claim_id)
BEGIN SELECT RAISE(ABORT,'commerce_execution_start_exists'); END;
CREATE TRIGGER commerce_execution_start_source BEFORE INSERT ON commerce_payment_execution_starts
WHEN NOT EXISTS (
  SELECT 1 FROM commerce_payment_work_claims c
  JOIN commerce_payment_attempts a ON a.command_id = c.attempt_command_id
  JOIN commerce_payment_work w ON w.attempt_command_id = a.command_id
  JOIN commerce_payment_scope s ON s.id = 1
  WHERE c.claim_id = NEW.claim_id AND c.attempt_command_id = NEW.attempt_command_id
    AND c.worker_id = NEW.worker_id AND c.mode = NEW.mode AND c.instance_id = NEW.instance_id
    AND c.provider = NEW.provider AND c.account_ref = NEW.account_ref
    AND a.mode = NEW.mode AND a.instance_id = NEW.instance_id
    AND a.provider = NEW.provider AND a.account_ref = NEW.account_ref
    AND s.mode = NEW.mode AND s.instance_id = NEW.instance_id
    AND NEW.account_ref = CASE NEW.provider WHEN 'stripe' THEN s.stripe_account_ref ELSE s.paypal_account_ref END
    AND w.current_claim_id = c.claim_id AND w.version = NEW.expected_work_version
    AND NEW.expected_work_version = c.expected_version + 1 AND w.next_operation = 'query'
    AND NEW.operation = c.kind AND NEW.started_at >= c.claimed_at
    AND NEW.started_at >= a.occurred_at AND NEW.started_at < c.lease_until
)
BEGIN SELECT RAISE(ABORT,'commerce_execution_start_source'); END;
-- Any prior observation prevents CREATE, even processed not_found/reported_failed.
-- Cross-attempt/provider/account joins are intentionally scoped by order/instance.
CREATE TRIGGER commerce_execution_start_create BEFORE INSERT ON commerce_payment_execution_starts
WHEN NEW.operation = 'create' AND NOT EXISTS (
  SELECT 1 FROM commerce_payment_work_claims c
  JOIN commerce_payment_attempts a ON a.command_id = c.attempt_command_id
  JOIN commerce_orders o ON o.id = a.order_id
  JOIN commerce_quotes q ON q.id = a.quote_id
  WHERE c.claim_id = NEW.claim_id AND c.expected_version = 1
    AND o.state = 'pending_payment' AND o.payment_state = 'processing' AND o.fulfillment = 'none'
    AND q.expires_at > NEW.started_at AND o.reserve_until > NEW.started_at
    AND NOT EXISTS (SELECT 1 FROM commerce_payment_capture_facts f
      JOIN commerce_payment_attempts fa ON fa.command_id = f.attempt_command_id
      WHERE fa.order_id = a.order_id AND f.mode = NEW.mode AND f.instance_id = NEW.instance_id)
    AND NOT EXISTS (SELECT 1 FROM commerce_payment_observations b
      JOIN commerce_payment_attempts ba ON ba.command_id = b.attempt_command_id
      WHERE ba.order_id = a.order_id AND b.mode = NEW.mode AND b.instance_id = NEW.instance_id)
)
BEGIN SELECT RAISE(ABORT,'commerce_execution_start_create'); END;
