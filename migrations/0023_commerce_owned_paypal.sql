-- Local injected PayPal transport. Same canonical order, attempt, work, facts and
-- stock ledger. No provider calls, credentials, channel switching or paid backfill.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE commerce_capture_backup_0023 AS SELECT * FROM commerce_payment_capture_facts;
DROP TABLE commerce_payment_capture_facts;
CREATE TABLE commerce_payment_capture_facts (
  id TEXT PRIMARY KEY NOT NULL CHECK(typeof(id) = 'text' AND length(id) = 64 AND id NOT GLOB '*[^a-f0-9]*'),
  attempt_command_id TEXT NOT NULL CHECK(typeof(attempt_command_id) = 'text') REFERENCES commerce_payment_attempts(command_id) ON DELETE RESTRICT,
  source_claim_id TEXT NOT NULL CHECK(typeof(source_claim_id) = 'text') REFERENCES commerce_payment_work_claims(claim_id) ON DELETE RESTRICT,
  source_worker_id TEXT NOT NULL CHECK(typeof(source_worker_id) = 'text'),
  mode TEXT NOT NULL CHECK(typeof(mode) = 'text' AND mode = 'local-test'),
  instance_id TEXT NOT NULL CHECK(typeof(instance_id) = 'text'),
  provider TEXT NOT NULL CHECK(typeof(provider) = 'text' AND provider IN ('stripe','paypal')),
  account_ref TEXT NOT NULL CHECK(typeof(account_ref) = 'text' AND length(account_ref) BETWEEN 9 AND 105
    AND (substr(account_ref,1,8) = 'fixture-' OR (provider='stripe' AND substr(account_ref,1,5)='acct_') OR (provider='paypal' AND length(account_ref)=13 AND account_ref NOT GLOB '*[^2-9A-HJ-NP-Z]*')) AND account_ref NOT GLOB '*[^a-zA-Z0-9_-]*'),
  provider_object_ref TEXT NOT NULL CHECK(typeof(provider_object_ref) = 'text' AND length(provider_object_ref) BETWEEN 1 AND 248
    AND (substr(provider_object_ref,1,8) = 'fixture-' OR (provider='stripe' AND substr(provider_object_ref,1,8)='cs_test_') OR (provider='paypal' AND length(provider_object_ref) BETWEEN 1 AND 20 AND provider_object_ref NOT GLOB '*[^A-Z0-9]*')) AND provider_object_ref NOT GLOB '*[^a-zA-Z0-9_-]*'),
  transaction_ref TEXT NOT NULL CHECK(typeof(transaction_ref) = 'text' AND length(transaction_ref) BETWEEN 1 AND 248
    AND (substr(transaction_ref,1,8) = 'fixture-' OR (provider='stripe' AND substr(transaction_ref,1,3)='ch_') OR (provider='paypal' AND length(transaction_ref) BETWEEN 1 AND 20 AND transaction_ref NOT GLOB '*[^A-Z0-9]*')) AND transaction_ref NOT GLOB '*[^a-zA-Z0-9_-]*'),
  actual_amount_cents INTEGER NOT NULL CHECK(typeof(actual_amount_cents) = 'integer' AND actual_amount_cents BETWEEN 1 AND 9007199254740991),
  -- Only a synthetic three-letter token; this does not assert an ISO currency.
  actual_currency TEXT NOT NULL CHECK(typeof(actual_currency) = 'text' AND length(actual_currency) = 3 AND actual_currency NOT GLOB '*[^A-Z]*'),
  expected_amount_cents INTEGER NOT NULL CHECK(typeof(expected_amount_cents) = 'integer' AND expected_amount_cents BETWEEN 1 AND 9007199254740991),
  expected_currency TEXT NOT NULL CHECK(typeof(expected_currency) = 'text' AND expected_currency = 'CAD'),
  amount_match TEXT NOT NULL CHECK(typeof(amount_match) = 'text' AND amount_match IN ('match','mismatch')),
  payload_hash TEXT NOT NULL CHECK(typeof(payload_hash) = 'text' AND length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^a-f0-9]*'),
  recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at) = 'integer' AND recorded_at BETWEEN 0 AND 8640000000000000),
  payment_intent_ref TEXT CHECK(payment_intent_ref IS NULL OR (length(payment_intent_ref) BETWEEN 11 AND 243 AND substr(payment_intent_ref,1,3)='pi_' AND payment_intent_ref NOT GLOB '*[^a-zA-Z0-9_]*')),
  UNIQUE(mode,instance_id,provider,account_ref,transaction_ref)
);
INSERT INTO commerce_payment_capture_facts SELECT * FROM commerce_capture_backup_0023;
DROP TABLE commerce_capture_backup_0023;
CREATE INDEX commerce_capture_facts_by_attempt ON commerce_payment_capture_facts(attempt_command_id);
CREATE TRIGGER commerce_capture_facts_no_update BEFORE UPDATE ON commerce_payment_capture_facts
BEGIN SELECT RAISE(ABORT,'commerce_capture_fact_immutable'); END;
CREATE TRIGGER commerce_capture_facts_no_delete BEFORE DELETE ON commerce_payment_capture_facts
BEGIN SELECT RAISE(ABORT,'commerce_capture_fact_immutable'); END;
CREATE TRIGGER commerce_capture_facts_no_replace BEFORE INSERT ON commerce_payment_capture_facts
WHEN EXISTS (SELECT 1 FROM commerce_payment_capture_facts WHERE id = NEW.id OR
  (mode = NEW.mode AND instance_id = NEW.instance_id AND provider = NEW.provider
    AND account_ref = NEW.account_ref AND transaction_ref = NEW.transaction_ref))
BEGIN SELECT RAISE(ABORT,'commerce_capture_fact_exists'); END;
DROP TRIGGER commerce_payment_owned_source;
CREATE TRIGGER commerce_payment_owned_source BEFORE INSERT ON commerce_payment_attempts
WHEN NEW.rules_version='fictional-checkout-acceptance-v1' AND NOT EXISTS (
 SELECT 1 FROM commerce_checkout_order_origins x
 JOIN commerce_checkout_acceptances a ON a.acceptance_id=x.acceptance_id
 JOIN commerce_checkout_quotes q ON q.quote_id=x.checkout_quote_id AND q.quote_id=a.quote_id
 JOIN commerce_quotes p ON p.id=x.promoted_quote_id
 JOIN commerce_orders o ON o.id=x.order_id
 WHERE NEW.provider IN ('stripe','paypal') AND NEW.order_id=x.order_id AND NEW.quote_id=x.promoted_quote_id
 AND NEW.mode=x.mode AND NEW.instance_id=x.instance_id AND NEW.owner_hash=x.owner_hash
 AND a.mode=x.mode AND a.instance_id=x.instance_id AND a.owner_hash=x.owner_hash
 AND q.mode=x.mode AND q.instance_id=x.instance_id AND q.owner_hash=x.owner_hash
 AND o.owner_hash=x.owner_hash AND p.owner_hash=x.owner_hash
 AND o.quote_id=p.id AND o.reserve_command_id=x.command_id
 AND o.created_at=x.created_at AND p.created_at=x.created_at
 AND o.reserve_until=x.reserve_until AND p.expires_at=x.reserve_until AND q.expires_at=x.reserve_until
 AND q.created_at<=a.accepted_at AND a.accepted_at<=x.created_at
 AND x.created_at<=NEW.occurred_at AND NEW.occurred_at<q.expires_at
 AND q.rules_hash=x.rules_hash
 AND q.rules_json='{"testOnly":true,"version":"fictional-checkout-acceptance-v1","taxBasisPoints":1000,"rounding":"half-up-items-and-delivery","methods":{"pickup":0,"local_delivery":500,"shipping":1500}}'
 AND o.snapshot=json_remove(q.snapshot_json,'$.fixtureProfile') AND p.snapshot=o.snapshot
 AND json_extract(o.snapshot,'$.totalCents')=NEW.amount_cents
)
BEGIN SELECT RAISE(ABORT,'commerce_payment_owned_source'); END;
CREATE TABLE commerce_owned_paypal_associations (
 attempt_command_id TEXT PRIMARY KEY NOT NULL REFERENCES commerce_payment_attempts(command_id) ON DELETE RESTRICT,
 actual_merchant_id TEXT NOT NULL CHECK(length(actual_merchant_id)=13 AND actual_merchant_id NOT GLOB '*[^2-9A-HJ-NP-Z]*'),
 canonical_origin TEXT NOT NULL CHECK(length(canonical_origin) BETWEEN 18 AND 40 AND canonical_origin GLOB 'http://127.0.0.1:[0-9]*'),
 capture_operation_key TEXT NOT NULL UNIQUE CHECK(length(capture_operation_key)=36 AND substr(capture_operation_key,15,1)='4' AND substr(capture_operation_key,20,1) IN ('8','9','a','b') AND length(replace(capture_operation_key,'-',''))=32 AND replace(capture_operation_key,'-','') NOT GLOB '*[^a-f0-9]*'),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 8639999999970000)
);
CREATE TRIGGER commerce_owned_paypal_association_source BEFORE INSERT ON commerce_owned_paypal_associations
WHEN NOT EXISTS (
 SELECT 1 FROM commerce_payment_attempts a JOIN commerce_checkout_order_origins x ON x.order_id=a.order_id
 JOIN commerce_orders o ON o.id=a.order_id JOIN commerce_payment_scope s ON s.id=1
 JOIN commerce_payment_work w ON w.attempt_command_id=a.command_id
 WHERE a.command_id=NEW.attempt_command_id AND a.rules_version='fictional-checkout-acceptance-v1'
 AND a.provider='paypal' AND a.account_ref='fixture-paypal' AND s.paypal_account_ref=a.account_ref
 AND a.mode=x.mode AND a.instance_id=x.instance_id AND a.owner_hash=x.owner_hash
 AND s.mode=a.mode AND s.instance_id=a.instance_id AND a.quote_id=x.promoted_quote_id
 AND o.owner_hash=x.owner_hash AND o.quote_id=x.promoted_quote_id
 AND o.state='pending_payment' AND o.payment_state='processing' AND o.fulfillment='none'
 AND o.version=a.expected_version+1 AND a.occurred_at<=NEW.created_at AND NEW.created_at<o.reserve_until
 AND NEW.capture_operation_key!=a.create_operation_key AND w.version=1 AND w.next_operation='create' AND w.current_claim_id IS NULL
)
BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_source'); END;
CREATE TABLE commerce_owned_paypal_dispatches (
 claim_id TEXT PRIMARY KEY NOT NULL REFERENCES commerce_payment_work_claims(claim_id) DEFERRABLE INITIALLY DEFERRED,
 attempt_command_id TEXT NOT NULL REFERENCES commerce_owned_paypal_associations(attempt_command_id) ON DELETE RESTRICT,
 worker_id TEXT NOT NULL,
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
 expected_version INTEGER NOT NULL CHECK(typeof(expected_version)='integer' AND expected_version BETWEEN 1 AND 9007199254740990),
 kind TEXT NOT NULL CHECK(kind IN ('create','query')),
 claimed_at INTEGER NOT NULL CHECK(typeof(claimed_at)='integer' AND claimed_at BETWEEN 0 AND 8639999999970000),
 UNIQUE(attempt_command_id,expected_version)
);
CREATE UNIQUE INDEX commerce_owned_paypal_one_create ON commerce_owned_paypal_dispatches(attempt_command_id) WHERE kind='create';
CREATE TABLE commerce_owned_paypal_orders (
 attempt_command_id TEXT PRIMARY KEY NOT NULL REFERENCES commerce_owned_paypal_associations(attempt_command_id) ON DELETE RESTRICT,
 provider_order_id TEXT NOT NULL UNIQUE CHECK(length(provider_order_id) BETWEEN 1 AND 20 AND provider_order_id NOT GLOB '*[^A-Z0-9]*'),
 recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at BETWEEN 0 AND 8640000000000000)
);
CREATE TRIGGER commerce_owned_paypal_order_source BEFORE INSERT ON commerce_owned_paypal_orders
WHEN NOT EXISTS (SELECT 1 FROM commerce_owned_paypal_dispatches d WHERE d.attempt_command_id=NEW.attempt_command_id
 AND d.kind='create' AND NEW.recorded_at>=d.claimed_at)
BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_order_source'); END;
CREATE TRIGGER commerce_owned_paypal_dispatch_source BEFORE INSERT ON commerce_owned_paypal_dispatches
WHEN NOT EXISTS (
 SELECT 1 FROM commerce_owned_paypal_associations b JOIN commerce_payment_work w ON w.attempt_command_id=b.attempt_command_id
 JOIN commerce_payment_attempts a ON a.command_id=b.attempt_command_id JOIN commerce_orders o ON o.id=a.order_id
 WHERE b.attempt_command_id=NEW.attempt_command_id AND NEW.claimed_at>=b.created_at
 AND w.version=NEW.expected_version AND o.state='pending_payment' AND o.payment_state='processing' AND o.fulfillment='none'
 AND ((NEW.kind='create' AND w.version=1 AND w.next_operation='create' AND w.current_claim_id IS NULL
   AND NEW.claimed_at<o.reserve_until)
  OR (NEW.kind='query' AND w.next_operation='query' AND EXISTS (SELECT 1 FROM commerce_owned_paypal_orders z WHERE z.attempt_command_id=b.attempt_command_id)))
)
BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_dispatch_source'); END;
DROP TRIGGER commerce_payment_owned_work_fence;
CREATE TRIGGER commerce_payment_owned_work_fence BEFORE INSERT ON commerce_payment_work_claims
WHEN EXISTS (SELECT 1 FROM commerce_payment_attempts a WHERE a.command_id=NEW.attempt_command_id
 AND (a.rules_version!='local-test-v1' OR EXISTS (SELECT 1 FROM commerce_checkout_order_origins x WHERE x.order_id=a.order_id)))
 AND NOT EXISTS (SELECT 1 FROM commerce_owned_stripe_dispatches d WHERE d.claim_id=NEW.claim_id
 AND d.attempt_command_id=NEW.attempt_command_id AND d.worker_id=NEW.worker_id AND d.request_hash=NEW.request_hash
 AND d.expected_version=NEW.expected_version AND d.kind=NEW.kind AND d.claimed_at=NEW.claimed_at)
 AND NOT EXISTS (SELECT 1 FROM commerce_owned_paypal_dispatches d WHERE d.claim_id=NEW.claim_id
 AND d.attempt_command_id=NEW.attempt_command_id AND d.worker_id=NEW.worker_id AND d.request_hash=NEW.request_hash
 AND d.expected_version=NEW.expected_version AND d.kind=NEW.kind AND d.claimed_at=NEW.claimed_at)
BEGIN SELECT RAISE(ABORT,'commerce_owned_payment_dispatch_closed'); END;
CREATE TRIGGER commerce_owned_paypal_dispatch_apply AFTER INSERT ON commerce_owned_paypal_dispatches BEGIN
 INSERT INTO commerce_payment_work_claims(claim_id,attempt_command_id,worker_id,request_hash,mode,instance_id,provider,account_ref,expected_version,kind,claimed_at,lease_until)
 SELECT NEW.claim_id,a.command_id,NEW.worker_id,NEW.request_hash,a.mode,a.instance_id,a.provider,a.account_ref,NEW.expected_version,NEW.kind,NEW.claimed_at,NEW.claimed_at+30000
 FROM commerce_payment_attempts a WHERE a.command_id=NEW.attempt_command_id;
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM commerce_payment_work w JOIN commerce_payment_work_claims c ON c.claim_id=w.current_claim_id
 WHERE w.attempt_command_id=NEW.attempt_command_id AND w.version=NEW.expected_version+1
 AND c.claim_id=NEW.claim_id AND c.worker_id=NEW.worker_id AND c.kind=NEW.kind)
 THEN RAISE(ABORT,'commerce_owned_paypal_dispatch_incomplete') END;
END;
CREATE TABLE commerce_owned_paypal_status (
 claim_id TEXT PRIMARY KEY NOT NULL REFERENCES commerce_owned_paypal_dispatches(claim_id) ON DELETE RESTRICT,
 provider_order_id TEXT NOT NULL REFERENCES commerce_owned_paypal_orders(provider_order_id) ON DELETE RESTRICT,
 status TEXT NOT NULL CHECK(status IN ('CREATED','PAYER_ACTION_REQUIRED','APPROVED','COMPLETED','VOIDED','SAVED')),
 approval_url TEXT CHECK(approval_url IS NULL OR (length(approval_url)<=8192 AND approval_url GLOB 'https://www.sandbox.paypal.com/*')),
 recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at BETWEEN 0 AND 8640000000000000)
);
CREATE TRIGGER commerce_owned_paypal_status_source BEFORE INSERT ON commerce_owned_paypal_status
WHEN NOT EXISTS (SELECT 1 FROM commerce_owned_paypal_dispatches d JOIN commerce_owned_paypal_orders z ON z.attempt_command_id=d.attempt_command_id
 WHERE d.claim_id=NEW.claim_id AND z.provider_order_id=NEW.provider_order_id AND NEW.recorded_at>=d.claimed_at)
BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_status_source'); END;
-- Explicit CAPTURE transport boundary, not a third canonical work kind. The
-- latest query remains the source claim. A consumed receipt is NEVER re-sent.
CREATE TABLE commerce_owned_paypal_capture_dispatches (
 attempt_command_id TEXT PRIMARY KEY NOT NULL REFERENCES commerce_owned_paypal_associations(attempt_command_id) ON DELETE RESTRICT,
 receipt_id TEXT NOT NULL UNIQUE CHECK(length(receipt_id)=36 AND substr(receipt_id,15,1)='4' AND substr(receipt_id,20,1) IN ('8','9','a','b') AND length(replace(receipt_id,'-',''))=32 AND replace(receipt_id,'-','') NOT GLOB '*[^a-f0-9]*'),
 source_claim_id TEXT NOT NULL REFERENCES commerce_owned_paypal_status(claim_id) ON DELETE RESTRICT,
 source_worker_id TEXT NOT NULL,
 capture_operation_key TEXT NOT NULL UNIQUE,
 provider_order_id TEXT NOT NULL REFERENCES commerce_owned_paypal_orders(provider_order_id) ON DELETE RESTRICT,
 approved_at INTEGER NOT NULL CHECK(typeof(approved_at)='integer' AND approved_at BETWEEN 0 AND 8639999999970000),
 recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at>=approved_at AND recorded_at<=approved_at+30000)
);
CREATE TRIGGER commerce_owned_paypal_capture_dispatch_source BEFORE INSERT ON commerce_owned_paypal_capture_dispatches
WHEN NOT EXISTS (
 SELECT 1 FROM commerce_owned_paypal_associations b JOIN commerce_payment_attempts a ON a.command_id=b.attempt_command_id
 JOIN commerce_orders o ON o.id=a.order_id JOIN commerce_payment_work w ON w.attempt_command_id=a.command_id
 JOIN commerce_owned_paypal_dispatches d ON d.claim_id=w.current_claim_id
 JOIN commerce_owned_paypal_status t ON t.claim_id=d.claim_id
 JOIN commerce_owned_paypal_orders z ON z.attempt_command_id=a.command_id
 WHERE a.command_id=NEW.attempt_command_id AND b.capture_operation_key=NEW.capture_operation_key
 AND d.claim_id=NEW.source_claim_id AND d.worker_id=NEW.source_worker_id AND d.kind='query'
 AND d.attempt_command_id=a.command_id AND w.version=d.expected_version+1 AND w.next_operation='query'
 AND t.status='APPROVED' AND t.provider_order_id=z.provider_order_id AND NEW.provider_order_id=z.provider_order_id
 AND NEW.approved_at>=t.recorded_at AND NEW.approved_at>=d.claimed_at
 AND o.state='pending_payment' AND o.payment_state='processing' AND o.fulfillment='none' AND o.version=a.expected_version+1
 AND NOT EXISTS (SELECT 1 FROM commerce_payment_capture_facts f WHERE f.attempt_command_id=a.command_id)
 AND NOT EXISTS (SELECT 1 FROM commerce_owned_paypal_events e WHERE e.attempt_command_id=a.command_id AND e.event_type IN ('PAYMENT.CAPTURE.REFUNDED','PAYMENT.CAPTURE.REVERSED','PAYMENT.CAPTURE.DENIED','PAYMENT.CAPTURE.DECLINED'))
)
BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_capture_source'); END;
CREATE TABLE commerce_owned_paypal_events (
 event_type TEXT NOT NULL CHECK(length(event_type) BETWEEN 1 AND 100 AND event_type NOT GLOB '*[^A-Z._]*'),
 event_id TEXT NOT NULL CHECK(length(event_id) BETWEEN 1 AND 100 AND event_id NOT GLOB '*[^a-zA-Z0-9_-]*'),
 attempt_command_id TEXT NOT NULL REFERENCES commerce_owned_paypal_associations(attempt_command_id) ON DELETE RESTRICT,
 provider_order_id TEXT NOT NULL CHECK(length(provider_order_id) BETWEEN 1 AND 20 AND provider_order_id NOT GLOB '*[^A-Z0-9]*'),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^a-f0-9]*'),
 recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at BETWEEN 0 AND 8640000000000000),
 PRIMARY KEY(event_id,attempt_command_id)
);
CREATE TRIGGER commerce_owned_paypal_associations_no_update BEFORE UPDATE ON commerce_owned_paypal_associations BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_immutable'); END;
CREATE TRIGGER commerce_owned_paypal_associations_no_delete BEFORE DELETE ON commerce_owned_paypal_associations BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_immutable'); END;
CREATE TRIGGER commerce_owned_paypal_associations_no_replace BEFORE INSERT ON commerce_owned_paypal_associations WHEN EXISTS (SELECT 1 FROM commerce_owned_paypal_associations WHERE attempt_command_id=NEW.attempt_command_id OR capture_operation_key=NEW.capture_operation_key) BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_exists'); END;
CREATE TRIGGER commerce_owned_paypal_dispatches_no_update BEFORE UPDATE ON commerce_owned_paypal_dispatches BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_immutable'); END;
CREATE TRIGGER commerce_owned_paypal_dispatches_no_delete BEFORE DELETE ON commerce_owned_paypal_dispatches BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_immutable'); END;
CREATE TRIGGER commerce_owned_paypal_dispatches_no_replace BEFORE INSERT ON commerce_owned_paypal_dispatches WHEN EXISTS (SELECT 1 FROM commerce_owned_paypal_dispatches WHERE claim_id=NEW.claim_id OR (attempt_command_id=NEW.attempt_command_id AND (expected_version=NEW.expected_version OR (kind='create' AND NEW.kind='create')))) BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_exists'); END;
CREATE TRIGGER commerce_owned_paypal_orders_no_update BEFORE UPDATE ON commerce_owned_paypal_orders BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_immutable'); END;
CREATE TRIGGER commerce_owned_paypal_orders_no_delete BEFORE DELETE ON commerce_owned_paypal_orders BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_immutable'); END;
CREATE TRIGGER commerce_owned_paypal_orders_no_replace BEFORE INSERT ON commerce_owned_paypal_orders WHEN EXISTS (SELECT 1 FROM commerce_owned_paypal_orders WHERE attempt_command_id=NEW.attempt_command_id OR provider_order_id=NEW.provider_order_id) BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_exists'); END;
CREATE TRIGGER commerce_owned_paypal_status_no_update BEFORE UPDATE ON commerce_owned_paypal_status BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_immutable'); END;
CREATE TRIGGER commerce_owned_paypal_status_no_delete BEFORE DELETE ON commerce_owned_paypal_status BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_immutable'); END;
CREATE TRIGGER commerce_owned_paypal_status_no_replace BEFORE INSERT ON commerce_owned_paypal_status WHEN EXISTS (SELECT 1 FROM commerce_owned_paypal_status WHERE claim_id=NEW.claim_id) BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_exists'); END;
CREATE TRIGGER commerce_owned_paypal_capture_dispatches_no_update BEFORE UPDATE ON commerce_owned_paypal_capture_dispatches BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_immutable'); END;
CREATE TRIGGER commerce_owned_paypal_capture_dispatches_no_delete BEFORE DELETE ON commerce_owned_paypal_capture_dispatches BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_immutable'); END;
CREATE TRIGGER commerce_owned_paypal_capture_dispatches_no_replace BEFORE INSERT ON commerce_owned_paypal_capture_dispatches WHEN EXISTS (SELECT 1 FROM commerce_owned_paypal_capture_dispatches WHERE attempt_command_id=NEW.attempt_command_id OR receipt_id=NEW.receipt_id OR capture_operation_key=NEW.capture_operation_key) BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_exists'); END;
CREATE TRIGGER commerce_owned_paypal_events_no_update BEFORE UPDATE ON commerce_owned_paypal_events BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_immutable'); END;
CREATE TRIGGER commerce_owned_paypal_events_no_delete BEFORE DELETE ON commerce_owned_paypal_events BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_immutable'); END;
CREATE TRIGGER commerce_owned_paypal_events_no_replace BEFORE INSERT ON commerce_owned_paypal_events WHEN EXISTS (SELECT 1 FROM commerce_owned_paypal_events WHERE event_id=NEW.event_id AND attempt_command_id=NEW.attempt_command_id) BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_exists'); END;
CREATE TRIGGER commerce_capture_fact_guard BEFORE INSERT ON commerce_payment_capture_facts
WHEN NOT EXISTS (
  SELECT 1 FROM commerce_payment_work_claims c
  JOIN commerce_payment_attempts a ON a.command_id = c.attempt_command_id
  JOIN commerce_payment_scope s ON s.id = 1
  WHERE c.claim_id = NEW.source_claim_id AND c.worker_id = NEW.source_worker_id
    AND c.attempt_command_id = NEW.attempt_command_id
    AND a.rules_version='local-test-v1' AND NEW.payment_intent_ref IS NULL
    AND NOT EXISTS (SELECT 1 FROM commerce_checkout_order_origins x WHERE x.order_id=a.order_id)
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

 AND NOT EXISTS (
 SELECT 1 FROM commerce_owned_stripe_associations b
 JOIN commerce_payment_attempts a ON a.command_id=b.attempt_command_id
 JOIN commerce_checkout_order_origins x ON x.order_id=a.order_id
 JOIN commerce_owned_stripe_sessions z ON z.attempt_command_id=a.command_id
 JOIN commerce_owned_stripe_dispatches d ON d.claim_id=NEW.source_claim_id AND d.attempt_command_id=a.command_id
 JOIN commerce_payment_work w ON w.attempt_command_id=a.command_id
 JOIN commerce_payment_work_claims c ON c.claim_id=d.claim_id
 JOIN commerce_orders o ON o.id=a.order_id
 WHERE a.command_id=NEW.attempt_command_id AND a.provider='stripe' AND NEW.provider='stripe'
 AND a.rules_version='fictional-checkout-acceptance-v1' AND a.account_ref='fixture-stripe'
 AND a.mode=x.mode AND a.instance_id=x.instance_id AND a.owner_hash=x.owner_hash
 AND NEW.mode=a.mode AND NEW.instance_id=a.instance_id AND NEW.account_ref=b.actual_account_id
 AND NEW.provider_object_ref=z.session_id AND substr(NEW.transaction_ref,1,3)='ch_' AND NEW.payment_intent_ref IS NOT NULL
 AND d.kind='query' AND d.worker_id=NEW.source_worker_id AND c.worker_id=d.worker_id
 AND w.current_claim_id=d.claim_id AND w.version=d.expected_version+1
 AND NEW.recorded_at>=c.claimed_at AND NEW.recorded_at>=a.occurred_at
 -- Slow canonical reads may outlast a lease, but a replaced claim cannot finalize.
 AND NEW.actual_amount_cents=a.amount_cents AND NEW.expected_amount_cents=a.amount_cents
 AND NEW.actual_currency='CAD' AND NEW.expected_currency='CAD' AND NEW.amount_match='match'
 AND o.state='pending_payment' AND o.payment_state='processing' AND o.fulfillment='none'
 AND o.version=a.expected_version+1 AND o.owner_hash=x.owner_hash AND o.quote_id=x.promoted_quote_id
 AND NOT EXISTS (SELECT 1 FROM commerce_payment_capture_facts f WHERE f.attempt_command_id=a.command_id)
 AND NOT EXISTS (SELECT 1 FROM commerce_commands WHERE id='stripe-allocate-'||NEW.id)
)
 AND NOT EXISTS (
 SELECT 1 FROM commerce_owned_paypal_associations b
 JOIN commerce_payment_attempts a ON a.command_id=b.attempt_command_id
 JOIN commerce_checkout_order_origins x ON x.order_id=a.order_id
 JOIN commerce_owned_paypal_orders z ON z.attempt_command_id=a.command_id
 JOIN commerce_owned_paypal_dispatches d ON d.claim_id=NEW.source_claim_id AND d.attempt_command_id=a.command_id
 JOIN commerce_payment_work w ON w.attempt_command_id=a.command_id
 JOIN commerce_payment_work_claims c ON c.claim_id=d.claim_id
 JOIN commerce_orders o ON o.id=a.order_id
 WHERE a.command_id=NEW.attempt_command_id AND a.provider='paypal' AND NEW.provider='paypal'
 AND a.rules_version='fictional-checkout-acceptance-v1' AND a.account_ref='fixture-paypal'
 AND a.mode=x.mode AND a.instance_id=x.instance_id AND a.owner_hash=x.owner_hash
 AND NEW.mode=a.mode AND NEW.instance_id=a.instance_id AND NEW.account_ref=b.actual_merchant_id
 AND NEW.provider_object_ref=z.provider_order_id AND length(NEW.transaction_ref) BETWEEN 1 AND 20 AND NEW.transaction_ref NOT GLOB '*[^A-Z0-9]*' AND NEW.payment_intent_ref IS NULL
 AND d.kind='query' AND d.worker_id=NEW.source_worker_id AND c.worker_id=d.worker_id
 AND w.current_claim_id=d.claim_id AND w.version=d.expected_version+1
 AND NEW.recorded_at>=c.claimed_at AND NEW.recorded_at>=a.occurred_at
 -- Slow canonical reads may outlast a lease, but a replaced claim cannot finalize.
 AND NEW.actual_amount_cents=a.amount_cents AND NEW.expected_amount_cents=a.amount_cents
 AND NEW.actual_currency='CAD' AND NEW.expected_currency='CAD' AND NEW.amount_match='match'
 AND o.state='pending_payment' AND o.payment_state='processing' AND o.fulfillment='none'
 AND o.version=a.expected_version+1 AND o.owner_hash=x.owner_hash AND o.quote_id=x.promoted_quote_id
 AND NOT EXISTS (SELECT 1 FROM commerce_payment_capture_facts f WHERE f.attempt_command_id=a.command_id)
 AND NOT EXISTS (SELECT 1 FROM commerce_owned_paypal_events e WHERE e.attempt_command_id=a.command_id AND e.event_type IN ('PAYMENT.CAPTURE.REFUNDED','PAYMENT.CAPTURE.REVERSED','PAYMENT.CAPTURE.DENIED','PAYMENT.CAPTURE.DECLINED'))
 AND NOT EXISTS (SELECT 1 FROM commerce_commands WHERE id='paypal-allocate-'||NEW.id)
)
BEGIN SELECT RAISE(ABORT,'commerce_capture_fact_conflict'); END;
CREATE VIEW commerce_owned_payment_bindings AS
 SELECT attempt_command_id,actual_account_id AS account_ref,'stripe' AS provider FROM commerce_owned_stripe_associations
 UNION ALL SELECT attempt_command_id,actual_merchant_id AS account_ref,'paypal' AS provider FROM commerce_owned_paypal_associations;
DROP TRIGGER commerce_checkout_inventory_floor;
CREATE TRIGGER commerce_checkout_inventory_floor BEFORE UPDATE ON commerce_inventory
WHEN NEW.checkout_reserved < (
 SELECT COALESCE(SUM(l.quantity),0) FROM commerce_order_lines l JOIN commerce_checkout_order_origins x ON x.order_id=l.order_id
 WHERE l.variant_id=OLD.variant_id
 AND NOT EXISTS (SELECT 1 FROM commerce_checkout_order_releases r WHERE r.order_id=x.order_id AND r.mode=x.mode AND r.instance_id=x.instance_id AND r.owner_hash=x.owner_hash)
 AND NOT EXISTS (SELECT 1 FROM commerce_payment_capture_facts f JOIN commerce_payment_attempts a ON a.command_id=f.attempt_command_id
 JOIN commerce_owned_payment_bindings b ON b.attempt_command_id=a.command_id WHERE a.order_id=x.order_id AND f.account_ref=b.account_ref AND f.provider=b.provider)
) OR NEW.allocated < (
 SELECT COALESCE(SUM(l.quantity),0) FROM commerce_order_lines l JOIN commerce_checkout_order_origins x ON x.order_id=l.order_id
 WHERE l.variant_id=OLD.variant_id AND EXISTS (SELECT 1 FROM commerce_payment_capture_facts f JOIN commerce_payment_attempts a ON a.command_id=f.attempt_command_id
 JOIN commerce_owned_payment_bindings b ON b.attempt_command_id=a.command_id WHERE a.order_id=x.order_id AND f.account_ref=b.account_ref AND f.provider=b.provider)
)
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_hold_protected'); END;
DROP TRIGGER commerce_checkout_inventory_insert_floor;
CREATE TRIGGER commerce_checkout_inventory_insert_floor BEFORE INSERT ON commerce_inventory
WHEN NEW.checkout_reserved < (
 SELECT COALESCE(SUM(l.quantity),0) FROM commerce_order_lines l JOIN commerce_checkout_order_origins x ON x.order_id=l.order_id
 WHERE l.variant_id=NEW.variant_id
 AND NOT EXISTS (SELECT 1 FROM commerce_checkout_order_releases r WHERE r.order_id=x.order_id AND r.mode=x.mode AND r.instance_id=x.instance_id AND r.owner_hash=x.owner_hash)
 AND NOT EXISTS (SELECT 1 FROM commerce_payment_capture_facts f JOIN commerce_payment_attempts a ON a.command_id=f.attempt_command_id
 JOIN commerce_owned_payment_bindings b ON b.attempt_command_id=a.command_id WHERE a.order_id=x.order_id AND f.account_ref=b.account_ref AND f.provider=b.provider)
) OR NEW.allocated < (
 SELECT COALESCE(SUM(l.quantity),0) FROM commerce_order_lines l JOIN commerce_checkout_order_origins x ON x.order_id=l.order_id
 WHERE l.variant_id=NEW.variant_id AND EXISTS (SELECT 1 FROM commerce_payment_capture_facts f JOIN commerce_payment_attempts a ON a.command_id=f.attempt_command_id
 JOIN commerce_owned_payment_bindings b ON b.attempt_command_id=a.command_id WHERE a.order_id=x.order_id AND f.account_ref=b.account_ref AND f.provider=b.provider)
)
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_hold_protected'); END;
DROP TRIGGER commerce_checkout_order_no_update;
CREATE TRIGGER commerce_checkout_order_no_update BEFORE UPDATE ON commerce_orders
WHEN EXISTS (SELECT 1 FROM commerce_checkout_order_origins WHERE order_id=OLD.id)
 AND NOT EXISTS (
 SELECT 1 FROM commerce_checkout_order_releases r JOIN commerce_checkout_order_origins x ON x.order_id=r.order_id
 JOIN commerce_commands c ON c.id=r.command_id
 WHERE r.order_id=OLD.id AND r.mode=x.mode AND r.instance_id=x.instance_id AND r.owner_hash=x.owner_hash
 AND OLD.owner_hash=x.owner_hash AND OLD.quote_id=x.promoted_quote_id AND OLD.reserve_command_id=x.command_id
 AND OLD.created_at=x.created_at AND OLD.reserve_until=x.reserve_until
 AND OLD.state='pending_payment' AND OLD.payment_state='not_started' AND OLD.fulfillment='none'
 AND OLD.version=r.expected_version AND r.occurred_at>=OLD.created_at
 AND (r.kind='cancel' OR OLD.reserve_until<=r.occurred_at)
 AND c.request_hash=r.request_hash AND c.created_at=r.occurred_at
 AND NOT EXISTS (SELECT 1 FROM commerce_payment_attempts a WHERE a.order_id=OLD.id)
 AND NEW.state='cancelled' AND NEW.version=r.resulting_version AND NEW.version=OLD.version+1
 AND NEW.id IS OLD.id AND NEW.quote_id IS OLD.quote_id AND NEW.owner_hash IS OLD.owner_hash
 AND NEW.reserve_command_id IS OLD.reserve_command_id AND NEW.snapshot IS OLD.snapshot
 AND NEW.created_at IS OLD.created_at AND NEW.reserve_until IS OLD.reserve_until
 AND NEW.payment_state IS OLD.payment_state AND NEW.fulfillment IS OLD.fulfillment
 AND (SELECT COUNT(*) FROM commerce_stock_movements WHERE command_id=r.command_id)
     =(SELECT COUNT(*) FROM commerce_order_lines WHERE order_id=OLD.id)
 AND NOT EXISTS (SELECT 1 FROM commerce_order_lines l WHERE l.order_id=OLD.id AND NOT EXISTS (
  SELECT 1 FROM commerce_stock_movements m WHERE m.command_id=r.command_id AND m.position=l.position
  AND m.variant_id=l.variant_id AND m.quantity=l.quantity AND m.kind='release' AND m.expected_variant_version IS NULL
 ))
)
 AND NOT EXISTS (
 SELECT 1 FROM commerce_payment_attempts a JOIN commerce_checkout_order_origins x ON x.order_id=a.order_id
 JOIN commerce_commands c ON c.id=a.command_id
 WHERE a.order_id=OLD.id AND a.rules_version='fictional-checkout-acceptance-v1' AND a.provider IN ('stripe','paypal')
 AND a.mode=x.mode AND a.instance_id=x.instance_id AND a.owner_hash=x.owner_hash
 AND OLD.owner_hash=x.owner_hash AND OLD.quote_id=x.promoted_quote_id AND OLD.reserve_command_id=x.command_id
 AND OLD.created_at=x.created_at AND OLD.reserve_until=x.reserve_until
 AND OLD.state='pending_payment' AND OLD.payment_state='not_started' AND OLD.fulfillment='none'
 AND OLD.version=a.expected_version AND a.quote_id=OLD.quote_id
 AND c.created_at=a.occurred_at AND OLD.created_at<=a.occurred_at AND a.occurred_at<OLD.reserve_until
 AND NEW.payment_state='processing' AND NEW.version=OLD.version+1
 AND NEW.id IS OLD.id AND NEW.quote_id IS OLD.quote_id AND NEW.owner_hash IS OLD.owner_hash
 AND NEW.reserve_command_id IS OLD.reserve_command_id AND NEW.snapshot IS OLD.snapshot
 AND NEW.created_at IS OLD.created_at AND NEW.reserve_until IS OLD.reserve_until
 AND NEW.state IS OLD.state AND NEW.fulfillment IS OLD.fulfillment
 )

 AND NOT EXISTS (
 SELECT 1 FROM commerce_payment_capture_facts f JOIN commerce_payment_attempts a ON a.command_id=f.attempt_command_id
 JOIN commerce_owned_payment_bindings b ON b.attempt_command_id=a.command_id
 JOIN commerce_commands c ON c.id=(CASE f.provider WHEN 'stripe' THEN 'stripe-allocate-' ELSE 'paypal-allocate-' END)||f.id
 WHERE a.order_id=OLD.id AND f.account_ref=b.account_ref AND f.provider=b.provider AND f.amount_match='match'
 AND OLD.state='pending_payment' AND OLD.payment_state='processing' AND OLD.fulfillment='none'
 AND OLD.version=a.expected_version+1 AND NEW.version=OLD.version+1
 AND NEW.state='confirmed' AND NEW.payment_state='succeeded' AND NEW.fulfillment='ready_to_pack'
 AND NEW.id IS OLD.id AND NEW.quote_id IS OLD.quote_id AND NEW.owner_hash IS OLD.owner_hash
 AND NEW.reserve_command_id IS OLD.reserve_command_id AND NEW.snapshot IS OLD.snapshot
 AND NEW.created_at IS OLD.created_at AND NEW.reserve_until IS OLD.reserve_until
 AND c.created_at=f.recorded_at AND c.request_hash=f.payload_hash
 AND (SELECT COUNT(*) FROM commerce_stock_movements WHERE command_id=c.id)=(SELECT COUNT(*) FROM commerce_order_lines WHERE order_id=OLD.id)
 AND NOT EXISTS (SELECT 1 FROM commerce_order_lines l WHERE l.order_id=OLD.id AND NOT EXISTS (
 SELECT 1 FROM commerce_stock_movements m WHERE m.command_id=c.id AND m.position=l.position AND m.variant_id=l.variant_id
 AND m.quantity=l.quantity AND m.kind='allocate' AND m.expected_variant_version IS NULL AND m.reason=CASE f.provider WHEN 'stripe' THEN 'Verified Stripe Sandbox capture' ELSE 'Verified PayPal Sandbox capture' END))
 )
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_immutable'); END;
CREATE TRIGGER commerce_owned_paypal_allocate_source BEFORE INSERT ON commerce_stock_movements
WHEN substr(NEW.command_id,1,16)='paypal-allocate-' AND NOT EXISTS (
 SELECT 1 FROM commerce_payment_capture_facts f JOIN commerce_payment_attempts a ON a.command_id=f.attempt_command_id
 JOIN commerce_owned_paypal_associations b ON b.attempt_command_id=a.command_id
 JOIN commerce_order_lines l ON l.order_id=a.order_id
 WHERE NEW.command_id='paypal-allocate-'||f.id AND f.account_ref=b.actual_merchant_id
 AND NEW.position=l.position AND NEW.variant_id=l.variant_id AND NEW.quantity=l.quantity
 AND NEW.kind='allocate' AND NEW.expected_variant_version IS NULL AND NEW.reason='Verified PayPal Sandbox capture'
)
BEGIN SELECT RAISE(ABORT,'commerce_owned_paypal_allocation_source'); END;
CREATE TRIGGER commerce_owned_stripe_capture_apply AFTER INSERT ON commerce_payment_capture_facts
WHEN EXISTS (SELECT 1 FROM commerce_owned_stripe_associations b WHERE b.attempt_command_id=NEW.attempt_command_id AND b.actual_account_id=NEW.account_ref)
BEGIN
 INSERT INTO commerce_commands(id,request_hash,created_at) VALUES ('stripe-allocate-'||NEW.id,NEW.payload_hash,NEW.recorded_at);
 INSERT INTO commerce_stock_movements(command_id,position,variant_id,kind,quantity,expected_variant_version,reason)
 SELECT 'stripe-allocate-'||NEW.id,l.position,l.variant_id,'allocate',l.quantity,NULL,'Verified Stripe Sandbox capture'
 FROM commerce_order_lines l JOIN commerce_payment_attempts a ON a.order_id=l.order_id WHERE a.command_id=NEW.attempt_command_id ORDER BY l.position;
 UPDATE commerce_orders SET state='confirmed',payment_state='succeeded',fulfillment='ready_to_pack',version=version+1
 WHERE id=(SELECT order_id FROM commerce_payment_attempts WHERE command_id=NEW.attempt_command_id);
 SELECT CASE WHEN NOT EXISTS (
 SELECT 1 FROM commerce_payment_attempts a JOIN commerce_orders o ON o.id=a.order_id JOIN commerce_commands c ON c.id='stripe-allocate-'||NEW.id
 WHERE a.command_id=NEW.attempt_command_id AND o.state='confirmed' AND o.payment_state='succeeded' AND o.fulfillment='ready_to_pack'
 AND o.version=a.expected_version+2 AND c.request_hash=NEW.payload_hash AND c.created_at=NEW.recorded_at
 AND (SELECT COUNT(*) FROM commerce_order_lines WHERE order_id=o.id) BETWEEN 1 AND 20
 AND (SELECT COUNT(*) FROM commerce_stock_movements WHERE command_id=c.id)=(SELECT COUNT(*) FROM commerce_order_lines WHERE order_id=o.id)
 AND NOT EXISTS (SELECT 1 FROM commerce_order_lines l WHERE l.order_id=o.id AND NOT EXISTS (
 SELECT 1 FROM commerce_stock_movements m WHERE m.command_id=c.id AND m.position=l.position AND m.variant_id=l.variant_id
 AND m.quantity=l.quantity AND m.kind='allocate' AND m.expected_variant_version IS NULL AND m.reason='Verified Stripe Sandbox capture'))
 ) THEN RAISE(ABORT,'commerce_owned_stripe_capture_incomplete') END;
END;
CREATE TRIGGER commerce_owned_paypal_capture_apply AFTER INSERT ON commerce_payment_capture_facts
WHEN EXISTS (SELECT 1 FROM commerce_owned_paypal_associations b WHERE b.attempt_command_id=NEW.attempt_command_id AND b.actual_merchant_id=NEW.account_ref)
BEGIN
 INSERT INTO commerce_commands(id,request_hash,created_at) VALUES ('paypal-allocate-'||NEW.id,NEW.payload_hash,NEW.recorded_at);
 INSERT INTO commerce_stock_movements(command_id,position,variant_id,kind,quantity,expected_variant_version,reason)
 SELECT 'paypal-allocate-'||NEW.id,l.position,l.variant_id,'allocate',l.quantity,NULL,'Verified PayPal Sandbox capture'
 FROM commerce_order_lines l JOIN commerce_payment_attempts a ON a.order_id=l.order_id WHERE a.command_id=NEW.attempt_command_id ORDER BY l.position;
 UPDATE commerce_orders SET state='confirmed',payment_state='succeeded',fulfillment='ready_to_pack',version=version+1
 WHERE id=(SELECT order_id FROM commerce_payment_attempts WHERE command_id=NEW.attempt_command_id);
 SELECT CASE WHEN NOT EXISTS (
 SELECT 1 FROM commerce_payment_attempts a JOIN commerce_orders o ON o.id=a.order_id JOIN commerce_commands c ON c.id='paypal-allocate-'||NEW.id
 WHERE a.command_id=NEW.attempt_command_id AND o.state='confirmed' AND o.payment_state='succeeded' AND o.fulfillment='ready_to_pack'
 AND o.version=a.expected_version+2 AND c.request_hash=NEW.payload_hash AND c.created_at=NEW.recorded_at
 AND (SELECT COUNT(*) FROM commerce_order_lines WHERE order_id=o.id) BETWEEN 1 AND 20
 AND (SELECT COUNT(*) FROM commerce_stock_movements WHERE command_id=c.id)=(SELECT COUNT(*) FROM commerce_order_lines WHERE order_id=o.id)
 AND NOT EXISTS (SELECT 1 FROM commerce_order_lines l WHERE l.order_id=o.id AND NOT EXISTS (
 SELECT 1 FROM commerce_stock_movements m WHERE m.command_id=c.id AND m.position=l.position AND m.variant_id=l.variant_id
 AND m.quantity=l.quantity AND m.kind='allocate' AND m.expected_variant_version IS NULL AND m.reason='Verified PayPal Sandbox capture'))
 ) THEN RAISE(ABORT,'commerce_owned_paypal_capture_incomplete') END;
END;
PRAGMA defer_foreign_keys=OFF;
