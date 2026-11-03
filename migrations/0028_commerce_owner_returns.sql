-- Fictional whole-order physical inspection and explicit restock. Additive only.
-- Inspection does not alter stock. Restock is independent of refund execution:
-- only sellable received goods + same-capture verified full refund may return.
CREATE VIEW commerce_owner_return_orders AS
 SELECT o.id AS order_id,o.version,o.fulfillment,json_extract(o.snapshot,'$.delivery') AS delivery,x.mode,x.instance_id,f.id AS capture_id,f.recorded_at AS paid_at,
 a.command_id AS attempt_command_id,a.request_id AS payment_request_id,a.create_operation_key,a.provider,
 f.account_ref,f.transaction_ref,f.payment_intent_ref,f.provider_object_ref,a.amount_cents,b.canonical_origin
 FROM commerce_checkout_order_origins x JOIN commerce_orders o ON o.id=x.order_id
 JOIN commerce_payment_scope s ON s.id=1 AND s.mode=x.mode AND s.instance_id=x.instance_id
 JOIN commerce_payment_attempts a ON a.order_id=o.id AND a.mode=x.mode AND a.instance_id=x.instance_id AND a.owner_hash=x.owner_hash
 AND a.quote_id=x.promoted_quote_id AND a.rules_version='fictional-checkout-acceptance-v1'
 JOIN (SELECT attempt_command_id,actual_account_id AS account_ref,canonical_origin,'stripe' AS provider FROM commerce_owned_stripe_associations
 UNION ALL SELECT attempt_command_id,actual_merchant_id AS account_ref,canonical_origin,'paypal' AS provider FROM commerce_owned_paypal_associations) b
 ON b.attempt_command_id=a.command_id AND b.provider=a.provider
 JOIN commerce_payment_capture_facts f ON f.attempt_command_id=a.command_id AND f.mode=a.mode AND f.instance_id=a.instance_id
 AND f.provider=a.provider AND f.account_ref=b.account_ref
 WHERE o.owner_hash=x.owner_hash AND o.quote_id=x.promoted_quote_id AND o.reserve_command_id=x.command_id
 AND o.created_at=x.created_at AND o.reserve_until=x.reserve_until
 AND o.state='confirmed' AND o.payment_state='succeeded' AND o.fulfillment IN ('ready_to_pack','completed')
 AND f.amount_match='match' AND f.actual_amount_cents=a.amount_cents AND f.expected_amount_cents=a.amount_cents
 AND a.amount_cents=json_extract(o.snapshot,'$.totalCents') AND f.actual_currency='CAD' AND f.expected_currency='CAD'
 AND ((a.provider='stripe' AND a.account_ref=s.stripe_account_ref AND a.account_ref='fixture-stripe'
 AND f.payment_intent_ref IS NOT NULL AND substr(f.transaction_ref,1,3)='ch_'
 AND EXISTS(SELECT 1 FROM commerce_owned_stripe_sessions z WHERE z.attempt_command_id=a.command_id AND z.session_id=f.provider_object_ref))
 OR (a.provider='paypal' AND a.account_ref=s.paypal_account_ref AND a.account_ref='fixture-paypal' AND f.payment_intent_ref IS NULL
 AND EXISTS(SELECT 1 FROM commerce_owned_paypal_orders z WHERE z.attempt_command_id=a.command_id AND z.provider_order_id=f.provider_object_ref)))
 AND (SELECT COUNT(*) FROM commerce_payment_capture_facts c WHERE c.attempt_command_id=a.command_id)=1
 AND (SELECT COUNT(*) FROM commerce_order_lines l WHERE l.order_id=o.id) BETWEEN 1 AND 20;

CREATE VIEW commerce_owner_return_handoffs AS
 SELECT p.*,h.request_id AS handoff_request_id,h.recorded_at AS handed_at
 FROM commerce_owner_return_orders p JOIN commerce_owner_fulfillment_commands h ON h.order_id=p.order_id AND h.mode=p.mode AND h.instance_id=p.instance_id
 JOIN commerce_commands c ON c.id=h.command_id AND c.request_hash=h.request_hash AND c.created_at=h.recorded_at
 WHERE p.fulfillment='completed' AND h.operation=CASE p.delivery WHEN 'pickup' THEN 'collect' WHEN 'local_delivery' THEN 'deliver' WHEN 'shipping' THEN 'ship' END
 AND h.resulting_version=p.version AND h.resulting_version=h.expected_version+1
 AND EXISTS(SELECT 1 FROM commerce_owner_fulfillment_commands k WHERE k.order_id=p.order_id AND k.mode=p.mode AND k.instance_id=p.instance_id
 AND k.operation='pack' AND k.resulting_version=h.expected_version AND k.recorded_at<=h.recorded_at)
 AND (SELECT COUNT(*) FROM commerce_owner_fulfillment_lines l WHERE l.request_id=h.request_id)=(SELECT COUNT(*) FROM commerce_order_lines l WHERE l.order_id=p.order_id)
 AND (SELECT COUNT(*) FROM commerce_stock_movements m WHERE m.command_id=h.command_id)=(SELECT COUNT(*) FROM commerce_order_lines l WHERE l.order_id=p.order_id)
 AND NOT EXISTS(SELECT 1 FROM commerce_order_lines l WHERE l.order_id=p.order_id AND NOT EXISTS(
 SELECT 1 FROM commerce_owner_fulfillment_lines x JOIN commerce_stock_movements m ON m.command_id=h.command_id AND m.position=x.position
 WHERE x.request_id=h.request_id AND x.position=l.position AND x.variant_id=l.variant_id AND x.quantity=l.quantity
 AND m.variant_id=l.variant_id AND m.quantity=l.quantity AND m.kind='fulfill' AND m.expected_variant_version IS NULL AND m.reason='Owner recorded whole-order test handoff'));
CREATE VIEW commerce_owner_return_refunds AS
 SELECT h.order_id,h.handoff_request_id,h.capture_id,r.request_id AS refund_request_id,v.observation_id,v.recorded_at AS refunded_at
 FROM commerce_owner_return_handoffs h JOIN commerce_owner_refund_intents r ON r.order_id=h.order_id AND r.capture_id=h.capture_id
 AND r.mode=h.mode AND r.instance_id=h.instance_id AND r.provider=h.provider AND r.account_ref=h.account_ref
 AND r.transaction_ref=h.transaction_ref AND r.payment_intent_ref IS h.payment_intent_ref AND r.provider_object_ref=h.provider_object_ref
 AND r.payment_request_id=h.payment_request_id AND r.create_operation_key=h.create_operation_key AND r.canonical_origin=h.canonical_origin
 AND r.amount_cents=h.amount_cents AND r.expected_version=h.version
 JOIN commerce_owner_refund_dispatches d ON d.request_id=r.request_id
 JOIN commerce_owner_refund_observations v ON v.request_id=r.request_id AND v.status='succeeded' AND v.amount_cents=r.amount_cents AND v.refunded_cents=r.amount_cents;
CREATE TABLE commerce_owner_return_commands (
 request_id TEXT PRIMARY KEY NOT NULL CHECK(length(request_id)=36 AND substr(request_id,9,1)='-' AND substr(request_id,14,1)='-' AND substr(request_id,19,1)='-' AND substr(request_id,24,1)='-' AND substr(request_id,15,1)='4' AND substr(request_id,20,1) IN ('8','9','a','b') AND length(replace(request_id,'-',''))=32 AND replace(request_id,'-','') NOT GLOB '*[^a-f0-9]*'),
 command_id TEXT NOT NULL UNIQUE CHECK(command_id='owner-return-'||request_id) REFERENCES commerce_commands(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 mode TEXT NOT NULL CHECK(mode='local-test'),instance_id TEXT NOT NULL,
 actor_hash TEXT NOT NULL CHECK(length(actor_hash)=64 AND actor_hash NOT GLOB '*[^a-f0-9]*'),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
 order_id TEXT NOT NULL REFERENCES commerce_orders(id) ON DELETE RESTRICT,
 capture_id TEXT NOT NULL REFERENCES commerce_payment_capture_facts(id) ON DELETE RESTRICT,
 handoff_request_id TEXT NOT NULL REFERENCES commerce_owner_fulfillment_commands(request_id) ON DELETE RESTRICT,
 inspection_request_id TEXT REFERENCES commerce_owner_return_commands(request_id) ON DELETE RESTRICT,
 refund_observation_id TEXT REFERENCES commerce_owner_refund_observations(observation_id) ON DELETE RESTRICT,
 operation TEXT NOT NULL CHECK(operation IN ('inspect_sellable','inspect_unsuitable','restock')),
 expected_version INTEGER NOT NULL CHECK(typeof(expected_version)='integer' AND expected_version BETWEEN 1 AND 9007199254740991),
 expected_stock_hash TEXT NOT NULL CHECK(length(expected_stock_hash)=64 AND expected_stock_hash NOT GLOB '*[^a-f0-9]*'),
 expected_lines_json TEXT NOT NULL CHECK(json_valid(expected_lines_json) AND json_type(expected_lines_json)='array' AND json_array_length(expected_lines_json) BETWEEN 1 AND 20),
 recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at BETWEEN 0 AND 8640000000000000),
 CHECK((operation='restock' AND inspection_request_id IS NOT NULL AND refund_observation_id IS NOT NULL) OR (operation!='restock' AND inspection_request_id IS NULL AND refund_observation_id IS NULL))
);
CREATE UNIQUE INDEX commerce_owner_return_one_inspection ON commerce_owner_return_commands(order_id) WHERE operation!='restock';
CREATE UNIQUE INDEX commerce_owner_return_one_restock ON commerce_owner_return_commands(order_id) WHERE operation='restock';
CREATE TABLE commerce_owner_return_lines (
 request_id TEXT NOT NULL REFERENCES commerce_owner_return_commands(request_id) ON DELETE RESTRICT,
 position INTEGER NOT NULL,variant_id TEXT NOT NULL REFERENCES commerce_inventory(variant_id) ON DELETE RESTRICT,
 quantity INTEGER NOT NULL,before_on_hand INTEGER NOT NULL,before_facebook INTEGER NOT NULL,before_checkout INTEGER NOT NULL,before_allocated INTEGER NOT NULL,
 PRIMARY KEY(request_id,position),UNIQUE(request_id,variant_id)
);
CREATE TRIGGER commerce_owner_return_source BEFORE INSERT ON commerce_owner_return_commands
WHEN NOT EXISTS(SELECT 1 FROM commerce_owner_return_handoffs h WHERE h.order_id=NEW.order_id AND h.mode=NEW.mode AND h.instance_id=NEW.instance_id
 AND h.version=NEW.expected_version AND h.capture_id=NEW.capture_id AND h.handoff_request_id=NEW.handoff_request_id AND NEW.recorded_at>=h.handed_at
 AND ((NEW.operation!='restock' AND NOT EXISTS(SELECT 1 FROM commerce_owner_return_commands x WHERE x.order_id=h.order_id))
 OR (NEW.operation='restock' AND EXISTS(SELECT 1 FROM commerce_owner_return_commands x WHERE x.request_id=NEW.inspection_request_id
 AND x.order_id=h.order_id AND x.capture_id=h.capture_id AND x.handoff_request_id=h.handoff_request_id AND x.mode=h.mode AND x.instance_id=h.instance_id AND x.operation='inspect_sellable' AND x.recorded_at<=NEW.recorded_at)
 AND EXISTS(SELECT 1 FROM commerce_owner_return_refunds r WHERE r.order_id=h.order_id AND r.capture_id=h.capture_id AND r.handoff_request_id=h.handoff_request_id AND r.observation_id=NEW.refund_observation_id AND r.refunded_at<=NEW.recorded_at)
 AND NOT EXISTS(SELECT 1 FROM commerce_owner_return_commands x WHERE x.order_id=h.order_id AND x.operation='restock')))
 AND json_array_length(NEW.expected_lines_json)=(SELECT COUNT(*) FROM commerce_order_lines l WHERE l.order_id=h.order_id)
 AND NOT EXISTS(SELECT 1 FROM commerce_order_lines l JOIN commerce_inventory i ON i.variant_id=l.variant_id WHERE l.order_id=h.order_id AND NOT EXISTS(
 SELECT 1 FROM json_each(NEW.expected_lines_json) j WHERE j.key=l.position AND json_extract(j.value,'$.position') IS l.position
 AND json_extract(j.value,'$.variantId') IS l.variant_id AND json_extract(j.value,'$.quantity') IS l.quantity
 AND json_extract(j.value,'$.onHand') IS i.on_hand AND json_extract(j.value,'$.facebookReserved') IS i.facebook_reserved
 AND json_extract(j.value,'$.checkoutReserved') IS i.checkout_reserved AND json_extract(j.value,'$.allocated') IS i.allocated
 AND (NEW.operation!='restock' OR i.on_hand+l.quantity<=1000000))))
 OR EXISTS(SELECT 1 FROM commerce_commands c WHERE c.id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'commerce_owner_return_conflict'); END;
CREATE TRIGGER commerce_owner_return_line_source BEFORE INSERT ON commerce_owner_return_lines
WHEN NOT EXISTS(SELECT 1 FROM commerce_owner_return_commands r JOIN commerce_order_lines l ON l.order_id=r.order_id JOIN commerce_inventory i ON i.variant_id=l.variant_id
 WHERE r.request_id=NEW.request_id AND NEW.position=l.position AND NEW.variant_id=l.variant_id AND NEW.quantity=l.quantity
 AND NEW.before_on_hand=i.on_hand AND NEW.before_facebook=i.facebook_reserved AND NEW.before_checkout=i.checkout_reserved AND NEW.before_allocated=i.allocated
 AND NOT EXISTS(SELECT 1 FROM commerce_commands c WHERE c.id=r.command_id))
BEGIN SELECT RAISE(ABORT,'commerce_owner_return_line_source'); END;
CREATE TRIGGER commerce_owner_return_movement_source BEFORE INSERT ON commerce_stock_movements
WHEN substr(NEW.command_id,1,13)='owner-return-' AND NOT EXISTS(
 SELECT 1 FROM commerce_owner_return_commands r JOIN commerce_owner_return_lines l ON l.request_id=r.request_id
 WHERE r.command_id=NEW.command_id AND r.operation='restock' AND NEW.position=l.position AND NEW.variant_id=l.variant_id AND NEW.quantity=l.quantity
 AND NEW.kind='return' AND NEW.expected_variant_version IS NULL AND NEW.reason='Owner restocked inspected whole-order test return')
BEGIN SELECT RAISE(ABORT,'commerce_owner_return_movement_source'); END;
CREATE TRIGGER commerce_owner_return_apply AFTER INSERT ON commerce_owner_return_commands BEGIN
 INSERT INTO commerce_owner_return_lines(request_id,position,variant_id,quantity,before_on_hand,before_facebook,before_checkout,before_allocated)
 SELECT NEW.request_id,l.position,l.variant_id,l.quantity,i.on_hand,i.facebook_reserved,i.checkout_reserved,i.allocated FROM commerce_order_lines l JOIN commerce_inventory i ON i.variant_id=l.variant_id WHERE l.order_id=NEW.order_id;
 INSERT INTO commerce_commands(id,request_hash,created_at) VALUES(NEW.command_id,NEW.request_hash,NEW.recorded_at);
 INSERT INTO commerce_stock_movements(command_id,position,variant_id,kind,quantity,expected_variant_version,reason)
 SELECT NEW.command_id,l.position,l.variant_id,'return',l.quantity,NULL,'Owner restocked inspected whole-order test return' FROM commerce_owner_return_lines l WHERE l.request_id=NEW.request_id AND NEW.operation='restock' ORDER BY l.position;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM commerce_commands c JOIN commerce_owner_return_handoffs h ON h.order_id=NEW.order_id
 WHERE c.id=NEW.command_id AND c.request_hash=NEW.request_hash AND c.created_at=NEW.recorded_at
 AND h.mode=NEW.mode AND h.instance_id=NEW.instance_id AND h.version=NEW.expected_version AND h.capture_id=NEW.capture_id AND h.handoff_request_id=NEW.handoff_request_id
 AND (SELECT COUNT(*) FROM commerce_owner_return_lines l WHERE l.request_id=NEW.request_id)=(SELECT COUNT(*) FROM commerce_order_lines l WHERE l.order_id=NEW.order_id)
 AND (SELECT COUNT(*) FROM commerce_stock_movements m WHERE m.command_id=NEW.command_id)=CASE NEW.operation WHEN 'restock' THEN (SELECT COUNT(*) FROM commerce_order_lines l WHERE l.order_id=NEW.order_id) ELSE 0 END
 AND NOT EXISTS(SELECT 1 FROM commerce_owner_return_lines l JOIN commerce_inventory i ON i.variant_id=l.variant_id WHERE l.request_id=NEW.request_id AND
 (i.on_hand!=l.before_on_hand+CASE NEW.operation WHEN 'restock' THEN l.quantity ELSE 0 END OR i.facebook_reserved!=l.before_facebook OR i.checkout_reserved!=l.before_checkout OR i.allocated!=l.before_allocated))
 ) THEN RAISE(ABORT,'commerce_owner_return_incomplete') END;
END;
CREATE TRIGGER commerce_owner_return_commands_no_update BEFORE UPDATE ON commerce_owner_return_commands BEGIN SELECT RAISE(ABORT,'commerce_owner_return_immutable'); END;
CREATE TRIGGER commerce_owner_return_commands_no_delete BEFORE DELETE ON commerce_owner_return_commands BEGIN SELECT RAISE(ABORT,'commerce_owner_return_immutable'); END;
CREATE TRIGGER commerce_owner_return_commands_no_replace BEFORE INSERT ON commerce_owner_return_commands WHEN EXISTS(SELECT 1 FROM commerce_owner_return_commands WHERE request_id=NEW.request_id OR command_id=NEW.command_id OR (order_id=NEW.order_id AND (operation='restock' AND NEW.operation='restock' OR operation!='restock' AND NEW.operation!='restock'))) BEGIN SELECT RAISE(ABORT,'commerce_owner_return_exists'); END;
CREATE TRIGGER commerce_owner_return_lines_no_update BEFORE UPDATE ON commerce_owner_return_lines BEGIN SELECT RAISE(ABORT,'commerce_owner_return_immutable'); END;
CREATE TRIGGER commerce_owner_return_lines_no_delete BEFORE DELETE ON commerce_owner_return_lines BEGIN SELECT RAISE(ABORT,'commerce_owner_return_immutable'); END;
CREATE TRIGGER commerce_owner_return_lines_no_replace BEFORE INSERT ON commerce_owner_return_lines WHEN EXISTS(SELECT 1 FROM commerce_owner_return_lines WHERE request_id=NEW.request_id AND (position=NEW.position OR variant_id=NEW.variant_id)) BEGIN SELECT RAISE(ABORT,'commerce_owner_return_exists'); END;
