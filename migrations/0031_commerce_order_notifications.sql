-- Fictional notifications only. Additive ledger: no financial, order or stock writes.
-- Recover the fixed recipient exclusively from the immutable checkout witness.
CREATE VIEW commerce_notification_orders AS
 SELECT o.id AS order_id,x.mode,x.instance_id,o.state,o.payment_state,o.fulfillment,
 json_extract(o.snapshot,'$.totalCents') AS total_cents,json_extract(o.snapshot,'$.delivery') AS delivery,
 json_extract(q.snapshot_json,'$.fixtureProfile.email') AS recipient
 FROM commerce_checkout_order_origins x JOIN commerce_orders o ON o.id=x.order_id
 JOIN commerce_payment_scope s ON s.id=1 AND s.mode=x.mode AND s.instance_id=x.instance_id
 JOIN commerce_checkout_quotes q ON q.quote_id=x.checkout_quote_id AND q.mode=x.mode AND q.instance_id=x.instance_id AND q.owner_hash=x.owner_hash
 JOIN commerce_quotes p ON p.id=x.promoted_quote_id AND p.owner_hash=x.owner_hash
 WHERE o.owner_hash=x.owner_hash AND o.quote_id=x.promoted_quote_id AND o.reserve_command_id=x.command_id
 AND o.created_at=x.created_at AND o.reserve_until=x.reserve_until AND o.snapshot=json_remove(q.snapshot_json,'$.fixtureProfile') AND p.snapshot=o.snapshot
 AND json_extract(q.snapshot_json,'$.testOnly')=1 AND json_extract(q.snapshot_json,'$.currency')='CAD'
 AND json_extract(q.snapshot_json,'$.contractVersion')='local-checkout-v1'
 AND ((json_extract(q.snapshot_json,'$.fixtureProfile.id')='fixture-ontario' AND json_extract(q.snapshot_json,'$.fixtureProfile.name')='Fictional Ontario Customer' AND json_extract(q.snapshot_json,'$.fixtureProfile.email')='ontario@example.invalid')
 OR (json_extract(q.snapshot_json,'$.fixtureProfile.id')='fixture-bc' AND json_extract(q.snapshot_json,'$.fixtureProfile.name')='Fictional BC Customer' AND json_extract(q.snapshot_json,'$.fixtureProfile.email')='bc@example.invalid'));

-- The existing owned paid-order view binds capture, association, account, amount,
-- currency, order origin and provider object. Refunds use the first confirmed
-- observation per request in 0030, so repeated observations never create events.
CREATE VIEW commerce_notification_sources AS
 SELECT n.order_id,n.mode,n.instance_id,n.recipient,p.canonical_origin,'capture_confirmed' AS kind,p.capture_id AS source_id,p.paid_at AS event_at
 FROM commerce_notification_orders n JOIN commerce_owner_return_orders p ON p.order_id=n.order_id AND p.mode=n.mode AND p.instance_id=n.instance_id
 UNION ALL
 SELECT n.order_id,n.mode,n.instance_id,n.recipient,p.canonical_origin,'refund_confirmed',r.request_id,r.refunded_at
 FROM commerce_notification_orders n JOIN commerce_owner_return_orders p ON p.order_id=n.order_id AND p.mode=n.mode AND p.instance_id=n.instance_id
 JOIN commerce_owner_refund_confirmed r ON r.order_id=p.order_id AND r.capture_id=p.capture_id AND r.mode=p.mode AND r.instance_id=p.instance_id
 AND r.provider=p.provider AND r.account_ref=p.account_ref AND r.canonical_origin=p.canonical_origin AND r.transaction_ref=p.transaction_ref
 AND r.payment_intent_ref IS p.payment_intent_ref AND r.provider_object_ref=p.provider_object_ref AND r.amount_cents=p.amount_cents
 AND r.payment_request_id=p.payment_request_id AND r.create_operation_key=p.create_operation_key
 UNION ALL
 SELECT n.order_id,n.mode,n.instance_id,n.recipient,p.canonical_origin,'packed',k.request_id,k.recorded_at
 FROM commerce_notification_orders n JOIN commerce_owner_return_orders p ON p.order_id=n.order_id AND p.mode=n.mode AND p.instance_id=n.instance_id
 JOIN commerce_owner_fulfillment_commands k ON k.order_id=p.order_id AND k.mode=p.mode AND k.instance_id=p.instance_id AND k.operation='pack'
 JOIN commerce_commands c ON c.id=k.command_id AND c.request_hash=k.request_hash AND c.created_at=k.recorded_at
 WHERE k.resulting_version=k.expected_version+1 AND k.recorded_at>=p.paid_at
 AND NOT EXISTS(SELECT 1 FROM commerce_stock_movements m WHERE m.command_id=k.command_id)
 AND NOT EXISTS(SELECT 1 FROM commerce_owner_fulfillment_lines l WHERE l.request_id=k.request_id)
 UNION ALL
 SELECT n.order_id,n.mode,n.instance_id,n.recipient,p.canonical_origin,'handed_over',p.handoff_request_id,p.handed_at
 FROM commerce_notification_orders n JOIN commerce_owner_return_handoffs p ON p.order_id=n.order_id AND p.mode=n.mode AND p.instance_id=n.instance_id;

CREATE TABLE commerce_notification_commands (
 request_id TEXT PRIMARY KEY NOT NULL CHECK(length(request_id)=36 AND substr(request_id,9,1)='-' AND substr(request_id,14,1)='-' AND substr(request_id,19,1)='-' AND substr(request_id,24,1)='-' AND substr(request_id,15,1)='4' AND substr(request_id,20,1) IN ('8','9','a','b') AND length(replace(request_id,'-',''))=32 AND replace(request_id,'-','') NOT GLOB '*[^a-f0-9]*'),
 mode TEXT NOT NULL CHECK(mode='local-test'),instance_id TEXT NOT NULL CHECK(length(instance_id)=36 AND substr(instance_id,9,1)='-' AND substr(instance_id,14,1)='-' AND substr(instance_id,19,1)='-' AND substr(instance_id,24,1)='-' AND substr(instance_id,15,1)='4' AND substr(instance_id,20,1) IN ('8','9','a','b') AND length(replace(instance_id,'-',''))=32 AND replace(instance_id,'-','') NOT GLOB '*[^a-f0-9]*'),
 actor_hash TEXT NOT NULL CHECK(length(actor_hash)=64 AND actor_hash NOT GLOB '*[^a-f0-9]*'),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
 order_id TEXT NOT NULL REFERENCES commerce_orders(id) ON DELETE RESTRICT,
 operation TEXT NOT NULL CHECK(operation IN ('prepare','test_delivered','test_failed','revoke')),
 notification_id TEXT,canonical_origin TEXT NOT NULL,
 intents_json TEXT NOT NULL CHECK(json_valid(intents_json) AND json_type(intents_json)='array' AND json_array_length(intents_json)<=100),
 recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at BETWEEN 0 AND 8639999913600000),
 CHECK((operation='prepare' AND notification_id IS NULL) OR (operation!='prepare' AND notification_id IS NOT NULL AND json_array_length(intents_json)=0))
);
CREATE TABLE commerce_notification_intents (
 id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND substr(id,15,1)='4' AND substr(id,20,1) IN ('8','9','a','b') AND length(replace(id,'-',''))=32 AND replace(id,'-','') NOT GLOB '*[^a-f0-9]*'),
 prepare_request_id TEXT NOT NULL REFERENCES commerce_notification_commands(request_id) ON DELETE RESTRICT,
 order_id TEXT NOT NULL REFERENCES commerce_orders(id) ON DELETE RESTRICT,
 mode TEXT NOT NULL CHECK(mode='local-test'),instance_id TEXT NOT NULL CHECK(length(instance_id)=36 AND substr(instance_id,9,1)='-' AND substr(instance_id,14,1)='-' AND substr(instance_id,19,1)='-' AND substr(instance_id,24,1)='-' AND substr(instance_id,15,1)='4' AND substr(instance_id,20,1) IN ('8','9','a','b') AND length(replace(instance_id,'-',''))=32 AND replace(instance_id,'-','') NOT GLOB '*[^a-f0-9]*'),
 kind TEXT NOT NULL CHECK(kind IN ('capture_confirmed','refund_confirmed','packed','handed_over')),
 source_id TEXT NOT NULL,recipient TEXT NOT NULL CHECK(recipient IN ('ontario@example.invalid','bc@example.invalid')),
 token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^a-f0-9]*'),
 created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL CHECK(expires_at=created_at+86400000),
 UNIQUE(mode,instance_id,kind,source_id)
);
CREATE INDEX commerce_notification_order_history ON commerce_notification_intents(order_id,created_at);
CREATE TABLE commerce_notification_attempts (
 request_id TEXT PRIMARY KEY NOT NULL REFERENCES commerce_notification_commands(request_id) ON DELETE RESTRICT,
 notification_id TEXT NOT NULL REFERENCES commerce_notification_intents(id) ON DELETE RESTRICT,
 outcome TEXT NOT NULL CHECK(outcome IN ('test_delivered','test_failed')),recorded_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX commerce_notification_one_delivery ON commerce_notification_attempts(notification_id) WHERE outcome='test_delivered';
CREATE TABLE commerce_notification_revocations (
 request_id TEXT PRIMARY KEY NOT NULL REFERENCES commerce_notification_commands(request_id) ON DELETE RESTRICT,
 notification_id TEXT NOT NULL UNIQUE REFERENCES commerce_notification_intents(id) ON DELETE RESTRICT,recorded_at INTEGER NOT NULL
);
CREATE TRIGGER commerce_notification_command_source BEFORE INSERT ON commerce_notification_commands
WHEN NOT EXISTS(SELECT 1 FROM commerce_notification_orders o WHERE o.order_id=NEW.order_id AND o.mode=NEW.mode AND o.instance_id=NEW.instance_id)
 OR (NEW.operation='prepare' AND (
 NOT EXISTS(SELECT 1 FROM commerce_notification_sources s WHERE s.order_id=NEW.order_id AND s.mode=NEW.mode AND s.instance_id=NEW.instance_id AND s.canonical_origin=NEW.canonical_origin)
 OR json_array_length(NEW.intents_json)!=MIN(100,(SELECT COUNT(*) FROM commerce_notification_sources s WHERE s.order_id=NEW.order_id AND s.mode=NEW.mode AND s.instance_id=NEW.instance_id AND s.canonical_origin=NEW.canonical_origin AND NOT EXISTS(SELECT 1 FROM commerce_notification_intents i WHERE i.mode=s.mode AND i.instance_id=s.instance_id AND i.kind=s.kind AND i.source_id=s.source_id)))))
 OR (NEW.operation='prepare' AND EXISTS(SELECT 1 FROM commerce_notification_sources s WHERE s.order_id=NEW.order_id AND s.mode=NEW.mode AND s.instance_id=NEW.instance_id AND s.canonical_origin=NEW.canonical_origin AND s.event_at>NEW.recorded_at))
 OR (NEW.operation!='prepare' AND NOT EXISTS(SELECT 1 FROM commerce_notification_intents i JOIN commerce_notification_commands p ON p.request_id=i.prepare_request_id
 WHERE i.id=NEW.notification_id AND i.order_id=NEW.order_id AND i.mode=NEW.mode AND i.instance_id=NEW.instance_id AND p.canonical_origin=NEW.canonical_origin AND NEW.recorded_at>=i.created_at
 AND NOT EXISTS(SELECT 1 FROM commerce_notification_revocations r WHERE r.notification_id=i.id)
 AND (NEW.operation='revoke' OR (NEW.recorded_at<i.expires_at AND (SELECT COUNT(*) FROM commerce_notification_attempts a WHERE a.notification_id=i.id)<3 AND NOT EXISTS(SELECT 1 FROM commerce_notification_attempts a WHERE a.notification_id=i.id AND a.outcome='test_delivered')))))
BEGIN SELECT RAISE(ABORT,'commerce_notification_conflict'); END;
CREATE TRIGGER commerce_notification_intent_source BEFORE INSERT ON commerce_notification_intents
WHEN NOT EXISTS(SELECT 1 FROM commerce_notification_commands c JOIN commerce_notification_sources s ON s.order_id=c.order_id AND s.mode=c.mode AND s.instance_id=c.instance_id AND s.canonical_origin=c.canonical_origin
 WHERE c.request_id=NEW.prepare_request_id AND c.operation='prepare' AND NEW.order_id=s.order_id AND NEW.mode=s.mode AND NEW.instance_id=s.instance_id
 AND NEW.kind=s.kind AND NEW.source_id=s.source_id AND NEW.recipient=s.recipient AND NEW.created_at=c.recorded_at AND NEW.created_at>=s.event_at
 AND EXISTS(SELECT 1 FROM json_each(c.intents_json) j WHERE json_extract(j.value,'$.id')=NEW.id AND json_extract(j.value,'$.kind')=NEW.kind AND json_extract(j.value,'$.sourceId')=NEW.source_id AND json_extract(j.value,'$.tokenHash')=NEW.token_hash))
BEGIN SELECT RAISE(ABORT,'commerce_notification_invalid_source'); END;
CREATE TRIGGER commerce_notification_attempt_source BEFORE INSERT ON commerce_notification_attempts
WHEN NOT EXISTS(SELECT 1 FROM commerce_notification_commands c WHERE c.request_id=NEW.request_id AND c.notification_id=NEW.notification_id AND c.operation=NEW.outcome AND c.recorded_at=NEW.recorded_at)
 OR EXISTS(SELECT 1 FROM commerce_notification_revocations r WHERE r.notification_id=NEW.notification_id)
 OR EXISTS(SELECT 1 FROM commerce_notification_attempts a WHERE a.notification_id=NEW.notification_id AND a.outcome='test_delivered')
 OR (SELECT COUNT(*) FROM commerce_notification_attempts a WHERE a.notification_id=NEW.notification_id)>=3
BEGIN SELECT RAISE(ABORT,'commerce_notification_invalid_attempt'); END;
CREATE TRIGGER commerce_notification_revoke_source BEFORE INSERT ON commerce_notification_revocations
WHEN NOT EXISTS(SELECT 1 FROM commerce_notification_commands c WHERE c.request_id=NEW.request_id AND c.notification_id=NEW.notification_id AND c.operation='revoke' AND c.recorded_at=NEW.recorded_at)
BEGIN SELECT RAISE(ABORT,'commerce_notification_invalid_revoke'); END;
CREATE TRIGGER commerce_notification_materialize AFTER INSERT ON commerce_notification_commands BEGIN
 INSERT INTO commerce_notification_intents(id,prepare_request_id,order_id,mode,instance_id,kind,source_id,recipient,token_hash,created_at,expires_at)
 SELECT json_extract(j.value,'$.id'),NEW.request_id,NEW.order_id,NEW.mode,NEW.instance_id,s.kind,s.source_id,s.recipient,json_extract(j.value,'$.tokenHash'),NEW.recorded_at,NEW.recorded_at+86400000
 FROM json_each(NEW.intents_json) j JOIN commerce_notification_sources s ON s.order_id=NEW.order_id AND s.mode=NEW.mode AND s.instance_id=NEW.instance_id AND s.canonical_origin=NEW.canonical_origin AND s.kind=json_extract(j.value,'$.kind') AND s.source_id=json_extract(j.value,'$.sourceId') WHERE NEW.operation='prepare';
 INSERT INTO commerce_notification_attempts(request_id,notification_id,outcome,recorded_at) SELECT NEW.request_id,NEW.notification_id,NEW.operation,NEW.recorded_at WHERE NEW.operation IN ('test_delivered','test_failed');
 INSERT INTO commerce_notification_revocations(request_id,notification_id,recorded_at) SELECT NEW.request_id,NEW.notification_id,NEW.recorded_at WHERE NEW.operation='revoke';
 SELECT CASE WHEN
 (SELECT COUNT(*) FROM commerce_notification_intents WHERE prepare_request_id=NEW.request_id)!=json_array_length(NEW.intents_json)

 OR (SELECT COUNT(*) FROM commerce_notification_attempts WHERE request_id=NEW.request_id)!=CASE WHEN NEW.operation IN ('test_delivered','test_failed') THEN 1 ELSE 0 END
 OR (SELECT COUNT(*) FROM commerce_notification_revocations WHERE request_id=NEW.request_id)!=CASE WHEN NEW.operation='revoke' THEN 1 ELSE 0 END
 THEN RAISE(ABORT,'commerce_notification_incomplete') END;
END;
CREATE TRIGGER commerce_notification_commands_no_update BEFORE UPDATE ON commerce_notification_commands BEGIN SELECT RAISE(ABORT,'commerce_notification_immutable'); END;
CREATE TRIGGER commerce_notification_commands_no_delete BEFORE DELETE ON commerce_notification_commands BEGIN SELECT RAISE(ABORT,'commerce_notification_immutable'); END;
CREATE TRIGGER commerce_notification_commands_no_replace BEFORE INSERT ON commerce_notification_commands WHEN EXISTS(SELECT 1 FROM commerce_notification_commands WHERE request_id=NEW.request_id) BEGIN SELECT RAISE(ABORT,'commerce_notification_exists'); END;
CREATE TRIGGER commerce_notification_intents_no_update BEFORE UPDATE ON commerce_notification_intents BEGIN SELECT RAISE(ABORT,'commerce_notification_immutable'); END;
CREATE TRIGGER commerce_notification_intents_no_delete BEFORE DELETE ON commerce_notification_intents BEGIN SELECT RAISE(ABORT,'commerce_notification_immutable'); END;
CREATE TRIGGER commerce_notification_intents_no_replace BEFORE INSERT ON commerce_notification_intents WHEN EXISTS(SELECT 1 FROM commerce_notification_intents WHERE id=NEW.id OR token_hash=NEW.token_hash OR (mode=NEW.mode AND instance_id=NEW.instance_id AND kind=NEW.kind AND source_id=NEW.source_id)) BEGIN SELECT RAISE(ABORT,'commerce_notification_exists'); END;
CREATE TRIGGER commerce_notification_attempts_no_update BEFORE UPDATE ON commerce_notification_attempts BEGIN SELECT RAISE(ABORT,'commerce_notification_immutable'); END;
CREATE TRIGGER commerce_notification_attempts_no_delete BEFORE DELETE ON commerce_notification_attempts BEGIN SELECT RAISE(ABORT,'commerce_notification_immutable'); END;
CREATE TRIGGER commerce_notification_attempts_no_replace BEFORE INSERT ON commerce_notification_attempts WHEN EXISTS(SELECT 1 FROM commerce_notification_attempts WHERE request_id=NEW.request_id OR (notification_id=NEW.notification_id AND outcome='test_delivered' AND NEW.outcome='test_delivered')) BEGIN SELECT RAISE(ABORT,'commerce_notification_exists'); END;
CREATE TRIGGER commerce_notification_revocations_no_update BEFORE UPDATE ON commerce_notification_revocations BEGIN SELECT RAISE(ABORT,'commerce_notification_immutable'); END;
CREATE TRIGGER commerce_notification_revocations_no_delete BEFORE DELETE ON commerce_notification_revocations BEGIN SELECT RAISE(ABORT,'commerce_notification_immutable'); END;
CREATE TRIGGER commerce_notification_revocations_no_replace BEFORE INSERT ON commerce_notification_revocations WHEN EXISTS(SELECT 1 FROM commerce_notification_revocations WHERE request_id=NEW.request_id OR notification_id=NEW.notification_id) BEGIN SELECT RAISE(ABORT,'commerce_notification_exists'); END;
