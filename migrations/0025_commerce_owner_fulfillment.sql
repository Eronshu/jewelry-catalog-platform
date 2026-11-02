-- Whole-order local-test packing and physical handoff. No provider requests,
-- customer contacts, partial fulfillment, refunds or carrier service integration.
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
 AND e.event_type IN ('PAYMENT.CAPTURE.REFUNDED','PAYMENT.CAPTURE.REVERSED','PAYMENT.CAPTURE.DENIED','PAYMENT.CAPTURE.DECLINED'));
CREATE TABLE commerce_owner_fulfillment_commands (
 request_id TEXT PRIMARY KEY NOT NULL CHECK(length(request_id)=36 AND substr(request_id,9,1)='-' AND substr(request_id,14,1)='-' AND substr(request_id,19,1)='-' AND substr(request_id,24,1)='-' AND substr(request_id,15,1)='4' AND substr(request_id,20,1) IN ('8','9','a','b') AND length(replace(request_id,'-',''))=32 AND replace(request_id,'-','') NOT GLOB '*[^a-f0-9]*'),
 command_id TEXT NOT NULL UNIQUE CHECK(command_id='owner-fulfillment-'||request_id) REFERENCES commerce_commands(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 mode TEXT NOT NULL CHECK(mode='local-test'),instance_id TEXT NOT NULL,
 actor_hash TEXT NOT NULL CHECK(length(actor_hash)=64 AND actor_hash NOT GLOB '*[^a-f0-9]*'),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
 order_id TEXT NOT NULL REFERENCES commerce_orders(id) ON DELETE RESTRICT,
 operation TEXT NOT NULL CHECK(operation IN ('pack','collect','deliver','ship')),
 expected_version INTEGER NOT NULL CHECK(typeof(expected_version)='integer' AND expected_version BETWEEN 1 AND 9007199254740990),
 resulting_version INTEGER NOT NULL CHECK(resulting_version=expected_version+1),
 recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at BETWEEN 0 AND 8640000000000000)
);
CREATE UNIQUE INDEX commerce_owner_fulfillment_pack ON commerce_owner_fulfillment_commands(order_id) WHERE operation='pack';
CREATE UNIQUE INDEX commerce_owner_fulfillment_handoff ON commerce_owner_fulfillment_commands(order_id) WHERE operation!='pack';
CREATE TABLE commerce_owner_fulfillment_lines (
 request_id TEXT NOT NULL REFERENCES commerce_owner_fulfillment_commands(request_id) ON DELETE RESTRICT,
 position INTEGER NOT NULL,variant_id TEXT NOT NULL REFERENCES commerce_inventory(variant_id) ON DELETE RESTRICT,
 quantity INTEGER NOT NULL, before_on_hand INTEGER NOT NULL,before_facebook INTEGER NOT NULL,before_checkout INTEGER NOT NULL,before_allocated INTEGER NOT NULL,
 PRIMARY KEY(request_id,position)
);
CREATE TRIGGER commerce_owner_fulfillment_source BEFORE INSERT ON commerce_owner_fulfillment_commands
WHEN NOT EXISTS (
 SELECT 1 FROM commerce_owner_fulfillment_orders o WHERE o.order_id=NEW.order_id AND o.mode=NEW.mode AND o.instance_id=NEW.instance_id
 AND o.version=NEW.expected_version AND o.state='confirmed' AND o.payment_state='succeeded' AND o.fulfillment='ready_to_pack'
 AND NEW.recorded_at>=o.paid_at AND o.delivery IN ('pickup','local_delivery','shipping')
 AND ((NEW.operation='pack' AND NOT EXISTS(SELECT 1 FROM commerce_owner_fulfillment_commands r WHERE r.order_id=o.order_id))
 OR (NEW.operation=CASE o.delivery WHEN 'pickup' THEN 'collect' WHEN 'local_delivery' THEN 'deliver' ELSE 'ship' END
 AND EXISTS(SELECT 1 FROM commerce_owner_fulfillment_commands r WHERE r.order_id=o.order_id AND r.operation='pack' AND r.resulting_version=NEW.expected_version AND r.recorded_at<=NEW.recorded_at)))
 AND NOT EXISTS(SELECT 1 FROM commerce_order_lines l JOIN commerce_inventory i ON i.variant_id=l.variant_id WHERE l.order_id=o.order_id AND (i.allocated<l.quantity OR i.on_hand<l.quantity))
) OR EXISTS(SELECT 1 FROM commerce_commands WHERE id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'commerce_owner_fulfillment_conflict'); END;
CREATE TRIGGER commerce_owner_fulfillment_line_source BEFORE INSERT ON commerce_owner_fulfillment_lines
WHEN NOT EXISTS(SELECT 1 FROM commerce_owner_fulfillment_commands r JOIN commerce_order_lines l ON l.order_id=r.order_id
 JOIN commerce_inventory i ON i.variant_id=l.variant_id WHERE r.request_id=NEW.request_id AND r.operation!='pack'
 AND NEW.position=l.position AND NEW.variant_id=l.variant_id AND NEW.quantity=l.quantity
 AND NEW.before_on_hand=i.on_hand AND NEW.before_facebook=i.facebook_reserved AND NEW.before_checkout=i.checkout_reserved AND NEW.before_allocated=i.allocated
 AND NOT EXISTS(SELECT 1 FROM commerce_commands c WHERE c.id=r.command_id))
BEGIN SELECT RAISE(ABORT,'commerce_owner_fulfillment_line_source'); END;
CREATE TRIGGER commerce_owner_fulfillment_movement_source BEFORE INSERT ON commerce_stock_movements
WHEN substr(NEW.command_id,1,18)='owner-fulfillment-' AND NOT EXISTS(
 SELECT 1 FROM commerce_owner_fulfillment_commands r JOIN commerce_owner_fulfillment_lines l ON l.request_id=r.request_id
 JOIN commerce_orders o ON o.id=r.order_id WHERE r.command_id=NEW.command_id AND r.operation!='pack'
 AND o.version=r.expected_version AND o.fulfillment='ready_to_pack'
 AND NEW.position=l.position AND NEW.variant_id=l.variant_id AND NEW.quantity=l.quantity
 AND NEW.kind='fulfill' AND NEW.expected_variant_version IS NULL AND NEW.reason='Owner recorded whole-order test handoff')
BEGIN SELECT RAISE(ABORT,'commerce_owner_fulfillment_movement_source'); END;
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
 WHERE l.variant_id=OLD.variant_id AND NOT EXISTS(SELECT 1 FROM commerce_owner_fulfillment_commands r WHERE r.order_id=x.order_id AND r.operation!='pack') AND EXISTS (SELECT 1 FROM commerce_payment_capture_facts f JOIN commerce_payment_attempts a ON a.command_id=f.attempt_command_id
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
 WHERE l.variant_id=NEW.variant_id AND NOT EXISTS(SELECT 1 FROM commerce_owner_fulfillment_commands r WHERE r.order_id=x.order_id AND r.operation!='pack') AND EXISTS (SELECT 1 FROM commerce_payment_capture_facts f JOIN commerce_payment_attempts a ON a.command_id=f.attempt_command_id
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
 AND NOT EXISTS (
 SELECT 1 FROM commerce_owner_fulfillment_commands r JOIN commerce_owner_fulfillment_orders o ON o.order_id=r.order_id
 JOIN commerce_commands c ON c.id=r.command_id
 WHERE r.order_id=OLD.id AND o.mode=r.mode AND o.instance_id=r.instance_id
 AND OLD.state='confirmed' AND OLD.payment_state='succeeded' AND OLD.fulfillment='ready_to_pack'
 AND OLD.version=r.expected_version AND NEW.version=r.resulting_version AND NEW.version=OLD.version+1
 AND NEW.id IS OLD.id AND NEW.quote_id IS OLD.quote_id AND NEW.owner_hash IS OLD.owner_hash
 AND NEW.reserve_command_id IS OLD.reserve_command_id AND NEW.snapshot IS OLD.snapshot
 AND NEW.created_at IS OLD.created_at AND NEW.reserve_until IS OLD.reserve_until
 AND NEW.state IS OLD.state AND NEW.payment_state IS OLD.payment_state
 AND NEW.fulfillment=CASE r.operation WHEN 'pack' THEN 'ready_to_pack' ELSE 'completed' END
 AND c.request_hash=r.request_hash AND c.created_at=r.recorded_at
 AND (SELECT COUNT(*) FROM commerce_stock_movements m WHERE m.command_id=c.id)=CASE r.operation WHEN 'pack' THEN 0 ELSE (SELECT COUNT(*) FROM commerce_order_lines l WHERE l.order_id=OLD.id) END
 AND (r.operation='pack' OR NOT EXISTS(SELECT 1 FROM commerce_order_lines l WHERE l.order_id=OLD.id AND NOT EXISTS(
 SELECT 1 FROM commerce_stock_movements m WHERE m.command_id=c.id AND m.position=l.position AND m.variant_id=l.variant_id
 AND m.quantity=l.quantity AND m.kind='fulfill' AND m.expected_variant_version IS NULL AND m.reason='Owner recorded whole-order test handoff')))
)
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_immutable'); END;
CREATE TRIGGER commerce_owner_fulfillment_apply AFTER INSERT ON commerce_owner_fulfillment_commands BEGIN
 INSERT INTO commerce_owner_fulfillment_lines(request_id,position,variant_id,quantity,before_on_hand,before_facebook,before_checkout,before_allocated)
 SELECT NEW.request_id,l.position,l.variant_id,l.quantity,i.on_hand,i.facebook_reserved,i.checkout_reserved,i.allocated
 FROM commerce_order_lines l JOIN commerce_inventory i ON i.variant_id=l.variant_id WHERE l.order_id=NEW.order_id AND NEW.operation!='pack';
 INSERT INTO commerce_commands(id,request_hash,created_at) VALUES(NEW.command_id,NEW.request_hash,NEW.recorded_at);
 INSERT INTO commerce_stock_movements(command_id,position,variant_id,kind,quantity,expected_variant_version,reason)
 SELECT NEW.command_id,l.position,l.variant_id,'fulfill',l.quantity,NULL,'Owner recorded whole-order test handoff'
 FROM commerce_owner_fulfillment_lines l WHERE l.request_id=NEW.request_id ORDER BY l.position;
 UPDATE commerce_orders SET fulfillment=CASE NEW.operation WHEN 'pack' THEN 'ready_to_pack' ELSE 'completed' END,version=version+1
 WHERE id=NEW.order_id AND version=NEW.expected_version;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM commerce_orders o JOIN commerce_commands c ON c.id=NEW.command_id
 WHERE o.id=NEW.order_id AND o.version=NEW.resulting_version AND o.state='confirmed' AND o.payment_state='succeeded'
 AND o.fulfillment=CASE NEW.operation WHEN 'pack' THEN 'ready_to_pack' ELSE 'completed' END
 AND c.request_hash=NEW.request_hash AND c.created_at=NEW.recorded_at
 AND (SELECT COUNT(*) FROM commerce_stock_movements m WHERE m.command_id=c.id)=CASE NEW.operation WHEN 'pack' THEN 0 ELSE (SELECT COUNT(*) FROM commerce_order_lines l WHERE l.order_id=o.id) END
 AND (SELECT COUNT(*) FROM commerce_owner_fulfillment_lines l WHERE l.request_id=NEW.request_id)=CASE NEW.operation WHEN 'pack' THEN 0 ELSE (SELECT COUNT(*) FROM commerce_order_lines l WHERE l.order_id=o.id) END
 AND NOT EXISTS(SELECT 1 FROM commerce_owner_fulfillment_lines l JOIN commerce_inventory i ON i.variant_id=l.variant_id WHERE l.request_id=NEW.request_id AND
 (i.on_hand!=l.before_on_hand-l.quantity OR i.allocated!=l.before_allocated-l.quantity OR i.facebook_reserved!=l.before_facebook OR i.checkout_reserved!=l.before_checkout))
 ) THEN RAISE(ABORT,'commerce_owner_fulfillment_incomplete') END;
END;
CREATE TRIGGER commerce_owner_fulfillment_commands_no_update BEFORE UPDATE ON commerce_owner_fulfillment_commands BEGIN SELECT RAISE(ABORT,'commerce_owner_fulfillment_immutable'); END;
CREATE TRIGGER commerce_owner_fulfillment_commands_no_delete BEFORE DELETE ON commerce_owner_fulfillment_commands BEGIN SELECT RAISE(ABORT,'commerce_owner_fulfillment_immutable'); END;
CREATE TRIGGER commerce_owner_fulfillment_lines_no_update BEFORE UPDATE ON commerce_owner_fulfillment_lines BEGIN SELECT RAISE(ABORT,'commerce_owner_fulfillment_immutable'); END;
CREATE TRIGGER commerce_owner_fulfillment_lines_no_delete BEFORE DELETE ON commerce_owner_fulfillment_lines BEGIN SELECT RAISE(ABORT,'commerce_owner_fulfillment_immutable'); END;
CREATE TRIGGER commerce_owner_fulfillment_no_replace BEFORE INSERT ON commerce_owner_fulfillment_commands WHEN EXISTS(SELECT 1 FROM commerce_owner_fulfillment_commands WHERE request_id=NEW.request_id OR command_id=NEW.command_id OR (order_id=NEW.order_id AND (operation='pack' AND NEW.operation='pack' OR operation!='pack' AND NEW.operation!='pack'))) BEGIN SELECT RAISE(ABORT,'commerce_owner_fulfillment_exists'); END;
CREATE TRIGGER commerce_owner_fulfillment_lines_no_replace BEFORE INSERT ON commerce_owner_fulfillment_lines WHEN EXISTS(SELECT 1 FROM commerce_owner_fulfillment_lines WHERE request_id=NEW.request_id AND position=NEW.position) BEGIN SELECT RAISE(ABORT,'commerce_owner_fulfillment_exists'); END;
