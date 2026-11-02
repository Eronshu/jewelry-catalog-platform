-- Full Stripe test refund: one immutable intent per canonical capture/order.
-- The intent permanently blocks fulfillment even on failure/uncertainty. No stock
-- or paid-order changes, retry policy, returns, live refunds, or provider calls.
CREATE TABLE commerce_owner_refund_intents (
 request_id TEXT PRIMARY KEY NOT NULL CHECK(length(request_id)=36 AND substr(request_id,9,1)='-' AND substr(request_id,14,1)='-' AND substr(request_id,19,1)='-' AND substr(request_id,24,1)='-' AND substr(request_id,15,1)='4' AND substr(request_id,20,1) IN ('8','9','a','b') AND length(replace(request_id,'-',''))=32 AND replace(request_id,'-','') NOT GLOB '*[^a-f0-9]*'),
 mode TEXT NOT NULL CHECK(mode='local-test'),instance_id TEXT NOT NULL,
 actor_hash TEXT NOT NULL CHECK(length(actor_hash)=64 AND actor_hash NOT GLOB '*[^a-f0-9]*'),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
 order_id TEXT NOT NULL UNIQUE REFERENCES commerce_orders(id) ON DELETE RESTRICT,
 capture_id TEXT NOT NULL UNIQUE REFERENCES commerce_payment_capture_facts(id) ON DELETE RESTRICT,
 expected_version INTEGER NOT NULL CHECK(typeof(expected_version)='integer' AND expected_version BETWEEN 1 AND 9007199254740990),
 operation_key TEXT NOT NULL UNIQUE CHECK(operation_key=request_id),
 account_ref TEXT NOT NULL,canonical_origin TEXT NOT NULL,charge_id TEXT NOT NULL,payment_intent_id TEXT NOT NULL,
 session_id TEXT NOT NULL,payment_request_id TEXT NOT NULL,create_operation_key TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 1 AND 99999999),
 recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at BETWEEN 0 AND 8640000000000000)
);
CREATE VIEW commerce_owner_refund_sources AS
 SELECT o.id AS order_id,o.version,o.fulfillment,x.mode,x.instance_id,f.id AS capture_id,f.recorded_at AS paid_at,
 a.command_id AS attempt_command_id,a.request_id AS payment_request_id,a.create_operation_key,
 f.account_ref,f.transaction_ref AS charge_id,f.payment_intent_ref AS payment_intent_id,
 f.provider_object_ref AS session_id,a.amount_cents,b.canonical_origin
 FROM commerce_checkout_order_origins x JOIN commerce_orders o ON o.id=x.order_id
 JOIN commerce_payment_scope s ON s.id=1 AND s.mode=x.mode AND s.instance_id=x.instance_id AND s.stripe_account_ref='fixture-stripe'
 JOIN commerce_payment_attempts a ON a.order_id=o.id AND a.mode=x.mode AND a.instance_id=x.instance_id AND a.owner_hash=x.owner_hash
 AND a.quote_id=x.promoted_quote_id AND a.rules_version='fictional-checkout-acceptance-v1' AND a.provider='stripe' AND a.account_ref=s.stripe_account_ref
 JOIN commerce_owned_stripe_associations b ON b.attempt_command_id=a.command_id
 JOIN commerce_payment_capture_facts f ON f.attempt_command_id=a.command_id AND f.mode=a.mode AND f.instance_id=a.instance_id
 AND f.provider='stripe' AND f.account_ref=b.actual_account_id
 JOIN commerce_owned_stripe_sessions z ON z.attempt_command_id=a.command_id AND z.session_id=f.provider_object_ref
 WHERE o.owner_hash=x.owner_hash AND o.quote_id=x.promoted_quote_id AND o.reserve_command_id=x.command_id
 AND o.created_at=x.created_at AND o.reserve_until=x.reserve_until
 AND o.state='confirmed' AND o.payment_state='succeeded' AND o.fulfillment IN ('ready_to_pack','completed')
 AND f.amount_match='match' AND f.actual_amount_cents=a.amount_cents AND f.expected_amount_cents=a.amount_cents
 AND a.amount_cents=json_extract(o.snapshot,'$.totalCents') AND f.actual_currency='CAD' AND f.expected_currency='CAD'
 AND f.payment_intent_ref IS NOT NULL AND substr(f.transaction_ref,1,3)='ch_'
 AND (SELECT COUNT(*) FROM commerce_payment_capture_facts c WHERE c.attempt_command_id=a.command_id)=1
 AND (SELECT COUNT(*) FROM commerce_order_lines l WHERE l.order_id=o.id) BETWEEN 1 AND 20;

CREATE TRIGGER commerce_owner_refund_intent_source BEFORE INSERT ON commerce_owner_refund_intents
WHEN NOT EXISTS(SELECT 1 FROM commerce_owner_refund_sources s WHERE s.order_id=NEW.order_id AND s.mode=NEW.mode AND s.instance_id=NEW.instance_id
 AND s.version=NEW.expected_version AND s.capture_id=NEW.capture_id AND s.account_ref=NEW.account_ref AND s.canonical_origin=NEW.canonical_origin
 AND s.charge_id=NEW.charge_id AND s.payment_intent_id=NEW.payment_intent_id AND s.session_id=NEW.session_id
 AND s.payment_request_id=NEW.payment_request_id AND s.create_operation_key=NEW.create_operation_key
 AND s.amount_cents=NEW.amount_cents AND NEW.recorded_at>=s.paid_at)
BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_conflict'); END;
CREATE TABLE commerce_owner_refund_dispatches (
 request_id TEXT PRIMARY KEY NOT NULL REFERENCES commerce_owner_refund_intents(request_id) ON DELETE RESTRICT,
 dispatch_id TEXT NOT NULL UNIQUE CHECK(length(dispatch_id)=36),
 recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at BETWEEN 0 AND 8640000000000000)
);
CREATE TRIGGER commerce_owner_refund_dispatch_source BEFORE INSERT ON commerce_owner_refund_dispatches
WHEN NOT EXISTS(SELECT 1 FROM commerce_owner_refund_intents r JOIN commerce_owner_refund_sources s ON s.capture_id=r.capture_id
 WHERE r.request_id=NEW.request_id AND s.order_id=r.order_id AND s.mode=r.mode AND s.instance_id=r.instance_id
 AND s.version=r.expected_version AND s.account_ref=r.account_ref AND s.canonical_origin=r.canonical_origin
 AND s.charge_id=r.charge_id AND s.payment_intent_id=r.payment_intent_id AND s.session_id=r.session_id
 AND s.payment_request_id=r.payment_request_id AND s.create_operation_key=r.create_operation_key AND s.amount_cents=r.amount_cents AND NEW.recorded_at>=r.recorded_at)
BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_dispatch_conflict'); END;
CREATE TABLE commerce_owner_refund_observations (
 observation_id TEXT PRIMARY KEY NOT NULL CHECK(length(observation_id)=36),
 request_id TEXT NOT NULL REFERENCES commerce_owner_refund_dispatches(request_id) ON DELETE RESTRICT,
 refund_id TEXT NOT NULL CHECK(substr(refund_id,1,3)='re_' AND length(refund_id) BETWEEN 11 AND 243 AND refund_id NOT GLOB '*[^a-zA-Z0-9_]*'),
 status TEXT NOT NULL CHECK(status IN ('pending','requires_action','succeeded','failed','canceled')),
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer'),
 refunded_cents INTEGER NOT NULL CHECK(typeof(refunded_cents)='integer' AND refunded_cents>=0),
 recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at BETWEEN 0 AND 8640000000000000)
);
CREATE TRIGGER commerce_owner_refund_observation_source BEFORE INSERT ON commerce_owner_refund_observations
WHEN NOT EXISTS(SELECT 1 FROM commerce_owner_refund_intents r JOIN commerce_owner_refund_dispatches d ON d.request_id=r.request_id
 WHERE r.request_id=NEW.request_id AND NEW.amount_cents=r.amount_cents AND NEW.refunded_cents<=r.amount_cents
 AND (NEW.status!='succeeded' OR NEW.refunded_cents=r.amount_cents) AND NEW.recorded_at>=d.recorded_at
 AND NOT EXISTS(SELECT 1 FROM commerce_owner_refund_observations o WHERE o.request_id=r.request_id AND o.refund_id!=NEW.refund_id))
BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_observation_conflict'); END;
DROP VIEW commerce_owner_fulfillment_orders;
CREATE VIEW commerce_owner_fulfillment_orders AS
 SELECT o.id AS order_id,o.version,o.state,o.payment_state,o.fulfillment,
 x.mode,x.instance_id,json_extract(o.snapshot,'$.delivery') AS delivery,
 f.recorded_at AS paid_at,a.command_id AS attempt_command_id
 FROM commerce_checkout_order_origins x JOIN commerce_orders o ON o.id=x.order_id
 JOIN commerce_payment_scope s ON s.id=1 AND s.mode=x.mode AND s.instance_id=x.instance_id
 JOIN commerce_payment_attempts a ON a.order_id=o.id AND a.mode=x.mode AND a.instance_id=x.instance_id
 AND a.owner_hash=x.owner_hash AND a.quote_id=x.promoted_quote_id AND a.rules_version='fictional-checkout-acceptance-v1'
 JOIN commerce_payment_capture_facts f ON f.attempt_command_id=a.command_id AND f.mode=a.mode AND f.instance_id=a.instance_id AND f.provider=a.provider
 JOIN commerce_owned_payment_bindings b ON b.attempt_command_id=a.command_id AND b.provider=f.provider AND b.account_ref=f.account_ref
 WHERE o.owner_hash=x.owner_hash AND o.quote_id=x.promoted_quote_id AND o.reserve_command_id=x.command_id
 AND o.created_at=x.created_at AND o.reserve_until=x.reserve_until
 AND f.amount_match='match' AND f.actual_amount_cents=a.amount_cents AND f.expected_amount_cents=a.amount_cents
 AND a.amount_cents=json_extract(o.snapshot,'$.totalCents') AND f.actual_currency='CAD' AND f.expected_currency='CAD'
 AND ((a.provider='stripe' AND a.account_ref=s.stripe_account_ref AND a.account_ref='fixture-stripe'
 AND f.payment_intent_ref IS NOT NULL AND substr(f.transaction_ref,1,3)='ch_'
 AND EXISTS(SELECT 1 FROM commerce_owned_stripe_sessions z WHERE z.attempt_command_id=a.command_id AND z.session_id=f.provider_object_ref))
 OR (a.provider='paypal' AND a.account_ref=s.paypal_account_ref AND a.account_ref='fixture-paypal'
 AND f.payment_intent_ref IS NULL
 AND EXISTS(SELECT 1 FROM commerce_owned_paypal_orders z WHERE z.attempt_command_id=a.command_id AND z.provider_order_id=f.provider_object_ref)))
 AND (SELECT COUNT(*) FROM commerce_payment_capture_facts c WHERE c.attempt_command_id=a.command_id)=1
 AND (SELECT COUNT(*) FROM commerce_order_lines l WHERE l.order_id=o.id) BETWEEN 1 AND 20
 AND NOT EXISTS(SELECT 1 FROM commerce_owned_paypal_events e WHERE e.attempt_command_id=a.command_id
 AND e.event_type IN ('PAYMENT.CAPTURE.REFUNDED','PAYMENT.CAPTURE.REVERSED','PAYMENT.CAPTURE.DENIED','PAYMENT.CAPTURE.DECLINED'))
 AND NOT EXISTS(SELECT 1 FROM commerce_owner_refund_intents r WHERE r.order_id=o.id);
CREATE TRIGGER commerce_owner_refund_intents_no_update BEFORE UPDATE ON commerce_owner_refund_intents BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_immutable'); END;
CREATE TRIGGER commerce_owner_refund_intents_no_delete BEFORE DELETE ON commerce_owner_refund_intents BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_immutable'); END;
CREATE TRIGGER commerce_owner_refund_intents_no_replace BEFORE INSERT ON commerce_owner_refund_intents WHEN EXISTS(SELECT 1 FROM commerce_owner_refund_intents WHERE request_id=NEW.request_id OR order_id=NEW.order_id OR capture_id=NEW.capture_id OR operation_key=NEW.operation_key) BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_exists'); END;
CREATE TRIGGER commerce_owner_refund_dispatches_no_update BEFORE UPDATE ON commerce_owner_refund_dispatches BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_immutable'); END;
CREATE TRIGGER commerce_owner_refund_dispatches_no_delete BEFORE DELETE ON commerce_owner_refund_dispatches BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_immutable'); END;
CREATE TRIGGER commerce_owner_refund_dispatches_no_replace BEFORE INSERT ON commerce_owner_refund_dispatches WHEN EXISTS(SELECT 1 FROM commerce_owner_refund_dispatches WHERE request_id=NEW.request_id OR dispatch_id=NEW.dispatch_id) BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_exists'); END;
CREATE TRIGGER commerce_owner_refund_observations_no_update BEFORE UPDATE ON commerce_owner_refund_observations BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_immutable'); END;
CREATE TRIGGER commerce_owner_refund_observations_no_delete BEFORE DELETE ON commerce_owner_refund_observations BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_immutable'); END;
CREATE TRIGGER commerce_owner_refund_observations_no_replace BEFORE INSERT ON commerce_owner_refund_observations WHEN EXISTS(SELECT 1 FROM commerce_owner_refund_observations WHERE observation_id=NEW.observation_id) BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_exists'); END;
