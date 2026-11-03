-- Serial partial fictional Stripe refunds on the existing immutable ledger.
-- Original captured amount, legacy hashes/keys and all historical anchors survive.
-- D1 applies the rebuild atomically; no stock/order/payment facts are rewritten.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE commerce_refund_intents_backup_0030 AS SELECT rowid AS original_rowid,* FROM commerce_owner_refund_intents;
CREATE TABLE commerce_refund_dispatches_backup_0030 AS SELECT rowid AS original_rowid,* FROM commerce_owner_refund_dispatches;
CREATE TABLE commerce_refund_observations_backup_0030 AS SELECT rowid AS original_rowid,* FROM commerce_owner_refund_observations;
DROP TABLE commerce_owner_refund_observations;
DROP TABLE commerce_owner_refund_dispatches;
DROP TABLE commerce_owner_refund_intents;
CREATE TABLE commerce_owner_refund_intents (
 request_id TEXT PRIMARY KEY NOT NULL CHECK(length(request_id)=36 AND substr(request_id,9,1)='-' AND substr(request_id,14,1)='-' AND substr(request_id,19,1)='-' AND substr(request_id,24,1)='-' AND substr(request_id,15,1)='4' AND substr(request_id,20,1) IN ('8','9','a','b') AND length(replace(request_id,'-',''))=32 AND replace(request_id,'-','') NOT GLOB '*[^a-f0-9]*'),
 mode TEXT NOT NULL CHECK(mode='local-test'),instance_id TEXT NOT NULL,
 actor_hash TEXT NOT NULL CHECK(length(actor_hash)=64 AND actor_hash NOT GLOB '*[^a-f0-9]*'),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
 order_id TEXT NOT NULL REFERENCES commerce_orders(id) ON DELETE RESTRICT,
 capture_id TEXT NOT NULL REFERENCES commerce_payment_capture_facts(id) ON DELETE RESTRICT,
 expected_version INTEGER NOT NULL CHECK(typeof(expected_version)='integer' AND expected_version BETWEEN 1 AND 9007199254740990),
 operation_key TEXT NOT NULL UNIQUE CHECK(operation_key=request_id),
 provider TEXT NOT NULL CHECK(provider IN ('stripe','paypal')),
 account_ref TEXT NOT NULL,canonical_origin TEXT NOT NULL,transaction_ref TEXT NOT NULL,payment_intent_ref TEXT,
 provider_object_ref TEXT NOT NULL,payment_request_id TEXT NOT NULL,create_operation_key TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 1 AND 99999999),
 refund_cents INTEGER NOT NULL CHECK(typeof(refund_cents)='integer' AND refund_cents BETWEEN 1 AND 99999999),
 prior_refunded_cents INTEGER NOT NULL CHECK(typeof(prior_refunded_cents)='integer' AND prior_refunded_cents BETWEEN 0 AND 99999999),
 input_contract TEXT NOT NULL CHECK(input_contract IN ('legacy-full-v1','partial-v2')),
 recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at BETWEEN 0 AND 8640000000000000),
 CHECK(refund_cents+prior_refunded_cents<=amount_cents),
 CHECK(input_contract!='legacy-full-v1' OR (refund_cents=amount_cents AND prior_refunded_cents=0)),
 CHECK(provider='stripe' OR input_contract='legacy-full-v1'),
 CHECK((provider='stripe' AND payment_intent_ref IS NOT NULL) OR (provider='paypal' AND payment_intent_ref IS NULL))
);
CREATE TABLE commerce_owner_refund_dispatches (
 request_id TEXT PRIMARY KEY NOT NULL REFERENCES commerce_owner_refund_intents(request_id) ON DELETE RESTRICT,
 dispatch_id TEXT NOT NULL UNIQUE CHECK(length(dispatch_id)=36),
 recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at BETWEEN 0 AND 8640000000000000)
);
CREATE TABLE commerce_owner_refund_observations (
 observation_id TEXT PRIMARY KEY NOT NULL CHECK(length(observation_id)=36),
 request_id TEXT NOT NULL REFERENCES commerce_owner_refund_dispatches(request_id) ON DELETE RESTRICT,
 refund_id TEXT NOT NULL CHECK(length(refund_id) BETWEEN 1 AND 243 AND refund_id NOT GLOB '*[^a-zA-Z0-9_]*'),
 status TEXT NOT NULL CHECK(status IN ('pending','requires_action','succeeded','failed','canceled')),
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer'),
 refunded_cents INTEGER NOT NULL CHECK(typeof(refunded_cents)='integer' AND refunded_cents>=0),
 recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at BETWEEN 0 AND 8640000000000000)
);
INSERT INTO commerce_owner_refund_intents(rowid,request_id,mode,instance_id,actor_hash,request_hash,order_id,capture_id,expected_version,operation_key,provider,account_ref,canonical_origin,transaction_ref,payment_intent_ref,provider_object_ref,payment_request_id,create_operation_key,amount_cents,recorded_at,refund_cents,prior_refunded_cents,input_contract) SELECT original_rowid,request_id,mode,instance_id,actor_hash,request_hash,order_id,capture_id,expected_version,operation_key,provider,account_ref,canonical_origin,transaction_ref,payment_intent_ref,provider_object_ref,payment_request_id,create_operation_key,amount_cents,recorded_at,amount_cents,0,'legacy-full-v1' FROM commerce_refund_intents_backup_0030 ORDER BY original_rowid;
INSERT INTO commerce_owner_refund_dispatches(rowid,request_id,dispatch_id,recorded_at) SELECT original_rowid,request_id,dispatch_id,recorded_at FROM commerce_refund_dispatches_backup_0030 ORDER BY original_rowid;
INSERT INTO commerce_owner_refund_observations(rowid,observation_id,request_id,refund_id,status,amount_cents,refunded_cents,recorded_at) SELECT original_rowid,observation_id,request_id,refund_id,status,amount_cents,refunded_cents,recorded_at FROM commerce_refund_observations_backup_0030 ORDER BY original_rowid;
DROP TABLE commerce_refund_observations_backup_0030;
DROP TABLE commerce_refund_dispatches_backup_0030;
DROP TABLE commerce_refund_intents_backup_0030;
CREATE INDEX commerce_owner_refund_order_history ON commerce_owner_refund_intents(order_id);
CREATE INDEX commerce_owner_refund_capture_history ON commerce_owner_refund_intents(capture_id);
-- EXISTS gives one confirmed amount per intent regardless of repeated GETs.
CREATE VIEW commerce_owner_refund_confirmed AS
 SELECT r.*,v.observation_id,v.recorded_at AS refunded_at
 FROM commerce_owner_refund_intents r JOIN commerce_owner_refund_dispatches d ON d.request_id=r.request_id
 JOIN commerce_owner_refund_observations v ON v.request_id=r.request_id AND v.status='succeeded'
 AND v.amount_cents=r.amount_cents AND v.refunded_cents=r.refund_cents
 WHERE v.rowid=(SELECT MIN(z.rowid) FROM commerce_owner_refund_observations z WHERE z.request_id=r.request_id
 AND z.status='succeeded' AND z.amount_cents=r.amount_cents AND z.refunded_cents=r.refund_cents);
CREATE TRIGGER commerce_owner_refund_serial_budget BEFORE INSERT ON commerce_owner_refund_intents
WHEN EXISTS(SELECT 1 FROM commerce_owner_refund_intents r WHERE (r.order_id=NEW.order_id OR r.capture_id=NEW.capture_id)
 AND NOT EXISTS(SELECT 1 FROM commerce_owner_refund_confirmed c WHERE c.request_id=r.request_id))
 OR NEW.prior_refunded_cents!=(SELECT COALESCE(SUM(c.refund_cents),0) FROM commerce_owner_refund_confirmed c WHERE c.capture_id=NEW.capture_id)
 OR NEW.refund_cents+NEW.prior_refunded_cents>NEW.amount_cents
 OR EXISTS(SELECT 1 FROM commerce_owner_refund_intents r WHERE (r.order_id=NEW.order_id OR r.capture_id=NEW.capture_id)
 AND (r.order_id!=NEW.order_id OR r.capture_id!=NEW.capture_id OR r.mode!=NEW.mode OR r.instance_id!=NEW.instance_id
 OR r.provider!=NEW.provider OR r.account_ref!=NEW.account_ref OR r.canonical_origin!=NEW.canonical_origin
 OR r.transaction_ref!=NEW.transaction_ref OR r.payment_intent_ref IS NOT NEW.payment_intent_ref
 OR r.provider_object_ref!=NEW.provider_object_ref OR r.payment_request_id!=NEW.payment_request_id
 OR r.create_operation_key!=NEW.create_operation_key OR r.amount_cents!=NEW.amount_cents OR r.expected_version!=NEW.expected_version))
BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_budget_conflict'); END;
CREATE TRIGGER commerce_owner_refund_intent_source BEFORE INSERT ON commerce_owner_refund_intents
WHEN NOT EXISTS(SELECT 1 FROM commerce_owner_refund_sources s WHERE s.order_id=NEW.order_id AND s.mode=NEW.mode AND s.instance_id=NEW.instance_id
 AND s.version=NEW.expected_version AND s.provider=NEW.provider AND s.capture_id=NEW.capture_id AND s.account_ref=NEW.account_ref AND s.canonical_origin=NEW.canonical_origin
 AND s.transaction_ref=NEW.transaction_ref AND s.payment_intent_ref IS NEW.payment_intent_ref AND s.provider_object_ref=NEW.provider_object_ref
 AND s.payment_request_id=NEW.payment_request_id AND s.create_operation_key=NEW.create_operation_key
 AND s.amount_cents=NEW.amount_cents AND NEW.recorded_at>=s.paid_at)
BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_conflict'); END;
CREATE TRIGGER commerce_owner_refund_dispatch_source BEFORE INSERT ON commerce_owner_refund_dispatches
WHEN NOT EXISTS(SELECT 1 FROM commerce_owner_refund_intents r JOIN commerce_owner_refund_sources s ON s.capture_id=r.capture_id
 WHERE r.request_id=NEW.request_id AND s.provider=r.provider AND s.order_id=r.order_id AND s.mode=r.mode AND s.instance_id=r.instance_id
 AND s.version=r.expected_version AND s.account_ref=r.account_ref AND s.canonical_origin=r.canonical_origin
 AND s.transaction_ref=r.transaction_ref AND s.payment_intent_ref IS r.payment_intent_ref AND s.provider_object_ref=r.provider_object_ref
 AND s.payment_request_id=r.payment_request_id AND s.create_operation_key=r.create_operation_key AND s.amount_cents=r.amount_cents AND NEW.recorded_at>=r.recorded_at)
BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_dispatch_conflict'); END;
CREATE TRIGGER commerce_owner_refund_observation_source BEFORE INSERT ON commerce_owner_refund_observations
WHEN NOT EXISTS(SELECT 1 FROM commerce_owner_refund_intents r JOIN commerce_owner_refund_dispatches d ON d.request_id=r.request_id
 WHERE r.request_id=NEW.request_id AND ((r.provider='stripe' AND substr(NEW.refund_id,1,3)='re_' AND length(NEW.refund_id) BETWEEN 11 AND 243) OR (r.provider='paypal' AND length(NEW.refund_id) BETWEEN 1 AND 20 AND NEW.refund_id NOT GLOB '*[^A-Z0-9]*' AND NEW.status!='requires_action')) AND NEW.amount_cents=r.amount_cents AND NEW.refunded_cents<=r.refund_cents
 AND ((NEW.status='succeeded' AND NEW.refunded_cents=r.refund_cents) OR (NEW.status!='succeeded' AND NEW.refunded_cents=0)) AND NEW.recorded_at>=d.recorded_at
 AND NOT EXISTS(SELECT 1 FROM commerce_owner_refund_observations o WHERE (o.request_id=r.request_id AND o.refund_id!=NEW.refund_id) OR (o.request_id!=r.request_id AND o.refund_id=NEW.refund_id))
 AND NOT EXISTS(SELECT 1 FROM commerce_owner_refund_confirmed c WHERE c.request_id=r.request_id AND NEW.status!='succeeded'))
BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_observation_conflict'); END;
CREATE TRIGGER commerce_owner_refund_intents_no_update BEFORE UPDATE ON commerce_owner_refund_intents BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_immutable'); END;
CREATE TRIGGER commerce_owner_refund_intents_no_delete BEFORE DELETE ON commerce_owner_refund_intents BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_immutable'); END;
CREATE TRIGGER commerce_owner_refund_intents_no_replace BEFORE INSERT ON commerce_owner_refund_intents WHEN EXISTS(SELECT 1 FROM commerce_owner_refund_intents WHERE request_id=NEW.request_id OR operation_key=NEW.operation_key) BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_exists'); END;
CREATE TRIGGER commerce_owner_refund_dispatches_no_update BEFORE UPDATE ON commerce_owner_refund_dispatches BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_immutable'); END;
CREATE TRIGGER commerce_owner_refund_dispatches_no_delete BEFORE DELETE ON commerce_owner_refund_dispatches BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_immutable'); END;
CREATE TRIGGER commerce_owner_refund_dispatches_no_replace BEFORE INSERT ON commerce_owner_refund_dispatches WHEN EXISTS(SELECT 1 FROM commerce_owner_refund_dispatches WHERE request_id=NEW.request_id OR dispatch_id=NEW.dispatch_id) BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_exists'); END;
CREATE TRIGGER commerce_owner_refund_observations_no_update BEFORE UPDATE ON commerce_owner_refund_observations BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_immutable'); END;
CREATE TRIGGER commerce_owner_refund_observations_no_delete BEFORE DELETE ON commerce_owner_refund_observations BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_immutable'); END;
CREATE TRIGGER commerce_owner_refund_observations_no_replace BEFORE INSERT ON commerce_owner_refund_observations WHEN EXISTS(SELECT 1 FROM commerce_owner_refund_observations WHERE observation_id=NEW.observation_id) BEGIN SELECT RAISE(ABORT,'commerce_owner_refund_exists'); END;
-- Only a complete serial, same-capture sum authorizes existing stock workflows.
-- Select the first success of the final request, so later duplicate GETs cannot
-- replace the anchor held by an existing return/release receipt.
CREATE VIEW commerce_owner_refund_full AS
 SELECT r.*,v.observation_id,v.recorded_at AS refunded_at
 FROM commerce_owner_refund_confirmed c JOIN commerce_owner_refund_intents r ON r.request_id=c.request_id
 JOIN commerce_owner_refund_observations v ON v.request_id=r.request_id AND v.status='succeeded'
 AND v.amount_cents=r.amount_cents AND v.refunded_cents=r.refund_cents
 -- Legacy receipts could anchor any succeeded observation before this migration.
 -- Preserve every such original anchor; v2 chooses the first immutable success.
 WHERE (r.input_contract='legacy-full-v1' OR v.observation_id=c.observation_id)
 AND c.prior_refunded_cents+c.refund_cents=c.amount_cents
 AND c.amount_cents=(SELECT SUM(q.refund_cents) FROM commerce_owner_refund_confirmed q WHERE q.capture_id=c.capture_id)
 AND NOT EXISTS(SELECT 1 FROM commerce_owner_refund_intents z WHERE z.capture_id=c.capture_id
 AND NOT EXISTS(SELECT 1 FROM commerce_owner_refund_confirmed q WHERE q.request_id=z.request_id));
DROP VIEW commerce_owner_return_refunds;
CREATE VIEW commerce_owner_return_refunds AS
 SELECT h.order_id,h.handoff_request_id,h.capture_id,r.request_id AS refund_request_id,r.observation_id,r.refunded_at
 FROM commerce_owner_return_handoffs h JOIN commerce_owner_refund_full r ON r.order_id=h.order_id AND r.capture_id=h.capture_id
 AND r.mode=h.mode AND r.instance_id=h.instance_id AND r.provider=h.provider AND r.account_ref=h.account_ref
 AND r.transaction_ref=h.transaction_ref AND r.payment_intent_ref IS h.payment_intent_ref AND r.provider_object_ref=h.provider_object_ref
 AND r.payment_request_id=h.payment_request_id AND r.create_operation_key=h.create_operation_key AND r.canonical_origin=h.canonical_origin
 AND r.amount_cents=h.amount_cents AND r.expected_version=h.version
;
DROP VIEW commerce_owner_allocation_release_sources;
CREATE VIEW commerce_owner_allocation_release_sources AS
 SELECT p.*,r.request_id AS refund_request_id,r.observation_id,r.refunded_at
 FROM commerce_owner_return_orders p JOIN commerce_owner_refund_full r ON r.order_id=p.order_id AND r.capture_id=p.capture_id
 AND r.mode=p.mode AND r.instance_id=p.instance_id AND r.provider=p.provider AND r.account_ref=p.account_ref
 AND r.transaction_ref=p.transaction_ref AND r.payment_intent_ref IS p.payment_intent_ref AND r.provider_object_ref=p.provider_object_ref
 AND r.payment_request_id=p.payment_request_id AND r.create_operation_key=p.create_operation_key AND r.canonical_origin=p.canonical_origin
 AND r.amount_cents=p.amount_cents AND r.expected_version=p.version

 WHERE p.fulfillment='ready_to_pack'
 AND NOT EXISTS(SELECT 1 FROM commerce_owner_fulfillment_commands h WHERE h.order_id=p.order_id AND h.operation!='pack')
 AND NOT EXISTS(SELECT 1 FROM commerce_owner_return_commands t WHERE t.order_id=p.order_id);
PRAGMA defer_foreign_keys=OFF;
