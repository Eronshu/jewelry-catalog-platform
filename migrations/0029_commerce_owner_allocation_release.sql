-- Fictional whole-order release of retained goods after verified full refund.
-- Rebuild ONLY movement CHECK; preserve original rowids and all source guards.
-- No rename: existing order/payment/refund/return views keep the original name.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE commerce_movements_backup_0029 AS SELECT rowid AS original_rowid,* FROM commerce_stock_movements;
DROP TABLE commerce_stock_movements;
CREATE TABLE commerce_stock_movements (
  command_id TEXT NOT NULL REFERENCES commerce_commands(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK(typeof(position) = 'integer' AND position >= 0),
  variant_id TEXT NOT NULL REFERENCES commerce_inventory(variant_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('receive','fb_reserve','fb_release','fb_sale','reserve','release','allocate','fulfill','return','deallocate')),
  quantity INTEGER NOT NULL CHECK(typeof(quantity) = 'integer' AND quantity BETWEEN 1 AND 1000000),
  expected_variant_version INTEGER,
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 200),
  PRIMARY KEY(command_id, position),
  CHECK(kind != 'reserve' OR (expected_variant_version IS NOT NULL AND typeof(expected_variant_version) = 'integer' AND expected_variant_version >= 1))
);
INSERT INTO commerce_stock_movements(rowid,command_id,position,variant_id,kind,quantity,expected_variant_version,reason)
 SELECT original_rowid,command_id,position,variant_id,kind,quantity,expected_variant_version,reason FROM commerce_movements_backup_0029 ORDER BY original_rowid;
DROP TABLE commerce_movements_backup_0029;
-- Restore application only AFTER copying: historical movements cannot replay.
CREATE INDEX commerce_stock_variant ON commerce_stock_movements(variant_id, command_id);
CREATE TRIGGER commerce_apply_stock AFTER INSERT ON commerce_stock_movements BEGIN
  UPDATE commerce_inventory SET
    on_hand = on_hand + CASE NEW.kind WHEN 'receive' THEN NEW.quantity WHEN 'return' THEN NEW.quantity WHEN 'fb_sale' THEN -NEW.quantity WHEN 'fulfill' THEN -NEW.quantity ELSE 0 END,
    facebook_reserved = facebook_reserved + CASE NEW.kind WHEN 'fb_reserve' THEN NEW.quantity WHEN 'fb_release' THEN -NEW.quantity WHEN 'fb_sale' THEN -NEW.quantity ELSE 0 END,
    checkout_reserved = checkout_reserved + CASE NEW.kind WHEN 'reserve' THEN NEW.quantity WHEN 'release' THEN -NEW.quantity WHEN 'allocate' THEN -NEW.quantity ELSE 0 END,
    allocated = allocated + CASE NEW.kind WHEN 'allocate' THEN NEW.quantity WHEN 'fulfill' THEN -NEW.quantity WHEN 'deallocate' THEN -NEW.quantity ELSE 0 END
  WHERE variant_id = NEW.variant_id;
END;
CREATE TRIGGER commerce_checkout_order_movement_source BEFORE INSERT ON commerce_stock_movements
WHEN EXISTS (SELECT 1 FROM commerce_checkout_order_origins WHERE command_id=NEW.command_id)
 AND NOT EXISTS (
  SELECT 1 FROM commerce_checkout_order_origins x JOIN commerce_order_lines l ON l.order_id=x.order_id
  WHERE x.command_id=NEW.command_id AND l.position=NEW.position AND l.variant_id=NEW.variant_id
    AND l.quantity=NEW.quantity AND l.variant_version=NEW.expected_variant_version
    AND NEW.kind='reserve' AND NEW.reason='Order reservation'
 )
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_movement_source'); END;
CREATE TRIGGER commerce_checkout_release_movement_source BEFORE INSERT ON commerce_stock_movements
WHEN EXISTS (SELECT 1 FROM commerce_checkout_order_releases WHERE command_id=NEW.command_id)
 AND NOT EXISTS (
 SELECT 1 FROM commerce_checkout_order_releases r JOIN commerce_order_lines l ON l.order_id=r.order_id
 WHERE r.command_id=NEW.command_id AND l.position=NEW.position AND l.variant_id=NEW.variant_id AND l.quantity=NEW.quantity
 AND NEW.kind='release' AND NEW.expected_variant_version IS NULL AND NEW.reason='Owned unpaid checkout release'
)
BEGIN SELECT RAISE(ABORT,'commerce_checkout_release_movement_source'); END;
CREATE TRIGGER commerce_movements_no_delete BEFORE DELETE ON commerce_stock_movements
BEGIN SELECT RAISE(ABORT, 'commerce_audit_is_immutable'); END;
CREATE TRIGGER commerce_movements_no_replace BEFORE INSERT ON commerce_stock_movements
WHEN EXISTS (SELECT 1 FROM commerce_stock_movements WHERE command_id = NEW.command_id AND position = NEW.position)
BEGIN SELECT RAISE(ABORT, 'commerce_movement_exists'); END;
CREATE TRIGGER commerce_movements_no_update BEFORE UPDATE ON commerce_stock_movements
BEGIN SELECT RAISE(ABORT, 'commerce_audit_is_immutable'); END;
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
CREATE TRIGGER commerce_owned_stripe_allocate_source BEFORE INSERT ON commerce_stock_movements
WHEN substr(NEW.command_id,1,16)='stripe-allocate-' AND NOT EXISTS (
 SELECT 1 FROM commerce_payment_capture_facts f JOIN commerce_payment_attempts a ON a.command_id=f.attempt_command_id
 JOIN commerce_owned_stripe_associations b ON b.attempt_command_id=a.command_id
 JOIN commerce_order_lines l ON l.order_id=a.order_id
 WHERE NEW.command_id='stripe-allocate-'||f.id AND f.account_ref=b.actual_account_id
 AND NEW.position=l.position AND NEW.variant_id=l.variant_id AND NEW.quantity=l.quantity
 AND NEW.kind='allocate' AND NEW.expected_variant_version IS NULL AND NEW.reason='Verified Stripe Sandbox capture'
)
BEGIN SELECT RAISE(ABORT,'commerce_owned_stripe_allocation_source'); END;
CREATE TRIGGER commerce_owner_fulfillment_movement_source BEFORE INSERT ON commerce_stock_movements
WHEN substr(NEW.command_id,1,18)='owner-fulfillment-' AND NOT EXISTS(
 SELECT 1 FROM commerce_owner_fulfillment_commands r JOIN commerce_owner_fulfillment_lines l ON l.request_id=r.request_id
 JOIN commerce_orders o ON o.id=r.order_id WHERE r.command_id=NEW.command_id AND r.operation!='pack'
 AND o.version=r.expected_version AND o.fulfillment='ready_to_pack'
 AND NEW.position=l.position AND NEW.variant_id=l.variant_id AND NEW.quantity=l.quantity
 AND NEW.kind='fulfill' AND NEW.expected_variant_version IS NULL AND NEW.reason='Owner recorded whole-order test handoff')
BEGIN SELECT RAISE(ABORT,'commerce_owner_fulfillment_movement_source'); END;
CREATE TRIGGER commerce_owner_return_movement_source BEFORE INSERT ON commerce_stock_movements
WHEN substr(NEW.command_id,1,13)='owner-return-' AND NOT EXISTS(
 SELECT 1 FROM commerce_owner_return_commands r JOIN commerce_owner_return_lines l ON l.request_id=r.request_id
 WHERE r.command_id=NEW.command_id AND r.operation='restock' AND NEW.position=l.position AND NEW.variant_id=l.variant_id AND NEW.quantity=l.quantity
 AND NEW.kind='return' AND NEW.expected_variant_version IS NULL AND NEW.reason='Owner restocked inspected whole-order test return')
BEGIN SELECT RAISE(ABORT,'commerce_owner_return_movement_source'); END;
CREATE TRIGGER commerce_owner_stock_movement_source BEFORE INSERT ON commerce_stock_movements
WHEN substr(NEW.command_id,1,12)='owner-stock-' AND NOT EXISTS (
 SELECT 1 FROM commerce_owner_stock_commands r WHERE r.command_id=NEW.command_id
 AND NEW.position=0 AND NEW.variant_id=r.variant_id AND NEW.kind=r.operation AND NEW.quantity=r.quantity
 AND NEW.expected_variant_version=r.variant_version
 AND NEW.reason=CASE r.operation WHEN 'receive' THEN 'Owner inspected stock receipt'
 WHEN 'fb_reserve' THEN 'Owner Facebook reservation' WHEN 'fb_release' THEN 'Owner Facebook release' ELSE 'Owner Facebook sale' END
)
BEGIN SELECT RAISE(ABORT,'commerce_owner_stock_movement_source'); END;
CREATE TRIGGER commerce_reserve_guard BEFORE INSERT ON commerce_stock_movements
WHEN NEW.kind = 'reserve' AND NOT EXISTS (
  SELECT 1 FROM commerce_variants v JOIN products p ON p.id = v.product_id
  WHERE v.id = NEW.variant_id AND v.active = 1 AND p.status = 'available'
    AND v.version = NEW.expected_variant_version
)
BEGIN SELECT RAISE(ABORT, 'commerce_variant_unavailable'); END;
CREATE VIEW commerce_owner_allocation_release_sources AS
 SELECT p.*,r.request_id AS refund_request_id,v.observation_id,v.recorded_at AS refunded_at
 FROM commerce_owner_return_orders p JOIN commerce_owner_refund_intents r ON r.order_id=p.order_id AND r.capture_id=p.capture_id
 AND r.mode=p.mode AND r.instance_id=p.instance_id AND r.provider=p.provider AND r.account_ref=p.account_ref
 AND r.transaction_ref=p.transaction_ref AND r.payment_intent_ref IS p.payment_intent_ref AND r.provider_object_ref=p.provider_object_ref
 AND r.payment_request_id=p.payment_request_id AND r.create_operation_key=p.create_operation_key AND r.canonical_origin=p.canonical_origin
 AND r.amount_cents=p.amount_cents AND r.expected_version=p.version
 JOIN commerce_owner_refund_dispatches d ON d.request_id=r.request_id
 JOIN commerce_owner_refund_observations v ON v.request_id=r.request_id AND v.status='succeeded' AND v.amount_cents=r.amount_cents AND v.refunded_cents=r.amount_cents
 WHERE p.fulfillment='ready_to_pack'
 AND NOT EXISTS(SELECT 1 FROM commerce_owner_fulfillment_commands h WHERE h.order_id=p.order_id AND h.operation!='pack')
 AND NOT EXISTS(SELECT 1 FROM commerce_owner_return_commands t WHERE t.order_id=p.order_id);
CREATE TABLE commerce_owner_allocation_release_commands (
 request_id TEXT PRIMARY KEY NOT NULL CHECK(length(request_id)=36 AND substr(request_id,9,1)='-' AND substr(request_id,14,1)='-' AND substr(request_id,19,1)='-' AND substr(request_id,24,1)='-' AND substr(request_id,15,1)='4' AND substr(request_id,20,1) IN ('8','9','a','b') AND length(replace(request_id,'-',''))=32 AND replace(request_id,'-','') NOT GLOB '*[^a-f0-9]*'),
 command_id TEXT NOT NULL UNIQUE CHECK(command_id='owner-allocation-release-'||request_id) REFERENCES commerce_commands(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 mode TEXT NOT NULL CHECK(mode='local-test'),instance_id TEXT NOT NULL,
 actor_hash TEXT NOT NULL CHECK(length(actor_hash)=64 AND actor_hash NOT GLOB '*[^a-f0-9]*'),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
 order_id TEXT NOT NULL UNIQUE REFERENCES commerce_orders(id) ON DELETE RESTRICT,
 capture_id TEXT NOT NULL UNIQUE REFERENCES commerce_payment_capture_facts(id) ON DELETE RESTRICT,
 refund_observation_id TEXT NOT NULL REFERENCES commerce_owner_refund_observations(observation_id) ON DELETE RESTRICT,
 expected_version INTEGER NOT NULL CHECK(typeof(expected_version)='integer' AND expected_version BETWEEN 1 AND 9007199254740991),
 expected_stock_hash TEXT NOT NULL CHECK(length(expected_stock_hash)=64 AND expected_stock_hash NOT GLOB '*[^a-f0-9]*'),
 expected_lines_json TEXT NOT NULL CHECK(json_valid(expected_lines_json) AND json_type(expected_lines_json)='array' AND json_array_length(expected_lines_json) BETWEEN 1 AND 20),
 recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at BETWEEN 0 AND 8640000000000000)
);
CREATE TABLE commerce_owner_allocation_release_lines (
 request_id TEXT NOT NULL REFERENCES commerce_owner_allocation_release_commands(request_id) ON DELETE RESTRICT,
 position INTEGER NOT NULL,variant_id TEXT NOT NULL REFERENCES commerce_inventory(variant_id) ON DELETE RESTRICT,
 quantity INTEGER NOT NULL,before_on_hand INTEGER NOT NULL,before_facebook INTEGER NOT NULL,before_checkout INTEGER NOT NULL,before_allocated INTEGER NOT NULL,
 PRIMARY KEY(request_id,position),UNIQUE(request_id,variant_id)
);
CREATE TRIGGER commerce_owner_allocation_release_source BEFORE INSERT ON commerce_owner_allocation_release_commands
WHEN NOT EXISTS(SELECT 1 FROM commerce_owner_allocation_release_sources s WHERE s.order_id=NEW.order_id AND s.mode=NEW.mode AND s.instance_id=NEW.instance_id
 AND s.version=NEW.expected_version AND s.capture_id=NEW.capture_id AND s.observation_id=NEW.refund_observation_id AND NEW.recorded_at>=s.refunded_at
 AND NOT EXISTS(SELECT 1 FROM commerce_owner_allocation_release_commands r WHERE r.order_id=s.order_id)
 AND json_array_length(NEW.expected_lines_json)=(SELECT COUNT(*) FROM commerce_order_lines l WHERE l.order_id=s.order_id)
 AND NOT EXISTS(SELECT 1 FROM commerce_order_lines l JOIN commerce_inventory i ON i.variant_id=l.variant_id WHERE l.order_id=s.order_id AND NOT EXISTS(
 SELECT 1 FROM json_each(NEW.expected_lines_json) j WHERE j.key=l.position AND json_extract(j.value,'$.position') IS l.position
 AND json_extract(j.value,'$.variantId') IS l.variant_id AND json_extract(j.value,'$.quantity') IS l.quantity
 AND json_extract(j.value,'$.onHand') IS i.on_hand AND json_extract(j.value,'$.facebookReserved') IS i.facebook_reserved
 AND json_extract(j.value,'$.checkoutReserved') IS i.checkout_reserved AND json_extract(j.value,'$.allocated') IS i.allocated AND i.allocated>=l.quantity)))
 OR EXISTS(SELECT 1 FROM commerce_commands c WHERE c.id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'commerce_owner_allocation_release_conflict'); END;
CREATE TRIGGER commerce_owner_allocation_release_line_source BEFORE INSERT ON commerce_owner_allocation_release_lines
WHEN NOT EXISTS(SELECT 1 FROM commerce_owner_allocation_release_commands r JOIN commerce_order_lines l ON l.order_id=r.order_id JOIN commerce_inventory i ON i.variant_id=l.variant_id
 WHERE r.request_id=NEW.request_id AND NEW.position=l.position AND NEW.variant_id=l.variant_id AND NEW.quantity=l.quantity
 AND NEW.before_on_hand=i.on_hand AND NEW.before_facebook=i.facebook_reserved AND NEW.before_checkout=i.checkout_reserved AND NEW.before_allocated=i.allocated
 AND NOT EXISTS(SELECT 1 FROM commerce_commands c WHERE c.id=r.command_id))
BEGIN SELECT RAISE(ABORT,'commerce_owner_allocation_release_line_source'); END;
-- Global fence: no generic command or other receipt can emit deallocate.
CREATE TRIGGER commerce_owner_allocation_release_movement_source BEFORE INSERT ON commerce_stock_movements
WHEN (NEW.kind='deallocate' OR substr(NEW.command_id,1,25)='owner-allocation-release-') AND NOT EXISTS(
 SELECT 1 FROM commerce_owner_allocation_release_commands r JOIN commerce_owner_allocation_release_lines l ON l.request_id=r.request_id
 WHERE r.command_id=NEW.command_id AND NEW.position=l.position AND NEW.variant_id=l.variant_id AND NEW.quantity=l.quantity
 AND NEW.kind='deallocate' AND NEW.expected_variant_version IS NULL AND NEW.reason='Owner released retained refunded whole-order allocation')
BEGIN SELECT RAISE(ABORT,'commerce_owner_allocation_release_movement_source'); END;
-- A line can lower ONLY its original order's floor after its own canonical
-- movement exists. The enclosing trigger proves every line/effect or rolls back.
CREATE VIEW commerce_owner_allocation_released_lines AS
 SELECT r.order_id,l.position,l.variant_id,l.quantity FROM commerce_owner_allocation_release_commands r
 JOIN commerce_commands c ON c.id=r.command_id AND c.request_hash=r.request_hash AND c.created_at=r.recorded_at
 JOIN commerce_owner_allocation_release_sources s ON s.order_id=r.order_id AND s.capture_id=r.capture_id AND s.observation_id=r.refund_observation_id AND s.mode=r.mode AND s.instance_id=r.instance_id AND s.version=r.expected_version
 JOIN commerce_owner_allocation_release_lines l ON l.request_id=r.request_id
 JOIN commerce_order_lines o ON o.order_id=r.order_id AND o.position=l.position AND o.variant_id=l.variant_id AND o.quantity=l.quantity
 JOIN commerce_stock_movements m ON m.command_id=r.command_id AND m.position=l.position AND m.variant_id=l.variant_id AND m.quantity=l.quantity AND m.kind='deallocate' AND m.expected_variant_version IS NULL AND m.reason='Owner released retained refunded whole-order allocation'
 WHERE (SELECT COUNT(*) FROM commerce_owner_allocation_release_lines q WHERE q.request_id=r.request_id)=(SELECT COUNT(*) FROM commerce_order_lines q WHERE q.order_id=r.order_id);
DROP TRIGGER commerce_checkout_inventory_floor;
CREATE TRIGGER commerce_checkout_inventory_floor BEFORE UPDATE ON commerce_inventory
WHEN NEW.checkout_reserved < (
 SELECT COALESCE(SUM(l.quantity),0) FROM commerce_order_lines l JOIN commerce_checkout_order_origins x ON x.order_id=l.order_id
 WHERE l.variant_id=OLD.variant_id
 AND NOT EXISTS (SELECT 1 FROM commerce_checkout_order_releases r WHERE r.order_id=x.order_id AND r.mode=x.mode AND r.instance_id=x.instance_id AND r.owner_hash=x.owner_hash)
 AND NOT EXISTS (SELECT 1 FROM commerce_payment_capture_facts f JOIN commerce_payment_attempts a ON a.command_id=f.attempt_command_id
 JOIN commerce_owned_payment_bindings b ON b.attempt_command_id=a.command_id WHERE a.order_id=x.order_id AND f.account_ref=b.account_ref AND f.provider=b.provider)
) OR NEW.allocated < (
 SELECT COALESCE(SUM(l.quantity-COALESCE((SELECT q.quantity FROM commerce_owner_allocation_released_lines q WHERE q.order_id=x.order_id AND q.position=l.position AND q.variant_id=l.variant_id),0)),0) FROM commerce_order_lines l JOIN commerce_checkout_order_origins x ON x.order_id=l.order_id
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
 SELECT COALESCE(SUM(l.quantity-COALESCE((SELECT q.quantity FROM commerce_owner_allocation_released_lines q WHERE q.order_id=x.order_id AND q.position=l.position AND q.variant_id=l.variant_id),0)),0) FROM commerce_order_lines l JOIN commerce_checkout_order_origins x ON x.order_id=l.order_id
 WHERE l.variant_id=NEW.variant_id AND NOT EXISTS(SELECT 1 FROM commerce_owner_fulfillment_commands r WHERE r.order_id=x.order_id AND r.operation!='pack') AND EXISTS (SELECT 1 FROM commerce_payment_capture_facts f JOIN commerce_payment_attempts a ON a.command_id=f.attempt_command_id
 JOIN commerce_owned_payment_bindings b ON b.attempt_command_id=a.command_id WHERE a.order_id=x.order_id AND f.account_ref=b.account_ref AND f.provider=b.provider)
)
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_hold_protected'); END;
CREATE TRIGGER commerce_owner_allocation_release_apply AFTER INSERT ON commerce_owner_allocation_release_commands BEGIN
 INSERT INTO commerce_owner_allocation_release_lines(request_id,position,variant_id,quantity,before_on_hand,before_facebook,before_checkout,before_allocated)
 SELECT NEW.request_id,l.position,l.variant_id,l.quantity,i.on_hand,i.facebook_reserved,i.checkout_reserved,i.allocated FROM commerce_order_lines l JOIN commerce_inventory i ON i.variant_id=l.variant_id WHERE l.order_id=NEW.order_id;
 INSERT INTO commerce_commands(id,request_hash,created_at) VALUES(NEW.command_id,NEW.request_hash,NEW.recorded_at);
 INSERT INTO commerce_stock_movements(command_id,position,variant_id,kind,quantity,expected_variant_version,reason)
 SELECT NEW.command_id,l.position,l.variant_id,'deallocate',l.quantity,NULL,'Owner released retained refunded whole-order allocation' FROM commerce_owner_allocation_release_lines l WHERE l.request_id=NEW.request_id ORDER BY l.position;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM commerce_commands c JOIN commerce_owner_allocation_release_sources s ON s.order_id=NEW.order_id
 WHERE c.id=NEW.command_id AND c.request_hash=NEW.request_hash AND c.created_at=NEW.recorded_at
 AND s.mode=NEW.mode AND s.instance_id=NEW.instance_id AND s.version=NEW.expected_version AND s.capture_id=NEW.capture_id AND s.observation_id=NEW.refund_observation_id
 AND (SELECT COUNT(*) FROM commerce_owner_allocation_release_lines l WHERE l.request_id=NEW.request_id)=(SELECT COUNT(*) FROM commerce_order_lines l WHERE l.order_id=NEW.order_id)
 AND (SELECT COUNT(*) FROM commerce_stock_movements m WHERE m.command_id=NEW.command_id)=(SELECT COUNT(*) FROM commerce_order_lines l WHERE l.order_id=NEW.order_id)
 AND NOT EXISTS(SELECT 1 FROM commerce_owner_allocation_release_lines l JOIN commerce_inventory i ON i.variant_id=l.variant_id WHERE l.request_id=NEW.request_id AND
 (i.on_hand!=l.before_on_hand OR i.facebook_reserved!=l.before_facebook OR i.checkout_reserved!=l.before_checkout OR i.allocated!=l.before_allocated-l.quantity))
 AND NOT EXISTS(SELECT 1 FROM commerce_order_lines l WHERE l.order_id=NEW.order_id AND NOT EXISTS(SELECT 1 FROM commerce_owner_allocation_released_lines q WHERE q.order_id=l.order_id AND q.position=l.position AND q.variant_id=l.variant_id AND q.quantity=l.quantity))
 ) THEN RAISE(ABORT,'commerce_owner_allocation_release_incomplete') END;
END;
CREATE TRIGGER commerce_owner_allocation_release_commands_no_update BEFORE UPDATE ON commerce_owner_allocation_release_commands BEGIN SELECT RAISE(ABORT,'commerce_owner_allocation_release_immutable'); END;
CREATE TRIGGER commerce_owner_allocation_release_commands_no_delete BEFORE DELETE ON commerce_owner_allocation_release_commands BEGIN SELECT RAISE(ABORT,'commerce_owner_allocation_release_immutable'); END;
CREATE TRIGGER commerce_owner_allocation_release_commands_no_replace BEFORE INSERT ON commerce_owner_allocation_release_commands WHEN EXISTS(SELECT 1 FROM commerce_owner_allocation_release_commands WHERE request_id=NEW.request_id OR command_id=NEW.command_id OR order_id=NEW.order_id OR capture_id=NEW.capture_id) BEGIN SELECT RAISE(ABORT,'commerce_owner_allocation_release_exists'); END;
CREATE TRIGGER commerce_owner_allocation_release_lines_no_update BEFORE UPDATE ON commerce_owner_allocation_release_lines BEGIN SELECT RAISE(ABORT,'commerce_owner_allocation_release_immutable'); END;
CREATE TRIGGER commerce_owner_allocation_release_lines_no_delete BEFORE DELETE ON commerce_owner_allocation_release_lines BEGIN SELECT RAISE(ABORT,'commerce_owner_allocation_release_immutable'); END;
CREATE TRIGGER commerce_owner_allocation_release_lines_no_replace BEFORE INSERT ON commerce_owner_allocation_release_lines WHEN EXISTS(SELECT 1 FROM commerce_owner_allocation_release_lines WHERE request_id=NEW.request_id AND (position=NEW.position OR variant_id=NEW.variant_id)) BEGIN SELECT RAISE(ABORT,'commerce_owner_allocation_release_exists'); END;
PRAGMA defer_foreign_keys=OFF;
