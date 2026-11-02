-- Local-test owner inventory commands. No backfill, balance table, payment/state
-- transition, publication change or customer/contact data. Existing ledger only.
CREATE TABLE commerce_owner_stock_commands (
 request_id TEXT PRIMARY KEY NOT NULL CHECK(length(request_id)=36 AND substr(request_id,9,1)='-' AND substr(request_id,14,1)='-' AND substr(request_id,19,1)='-' AND substr(request_id,24,1)='-' AND substr(request_id,15,1)='4' AND substr(request_id,20,1) IN ('8','9','a','b') AND length(replace(request_id,'-',''))=32 AND replace(request_id,'-','') NOT GLOB '*[^a-f0-9]*'),
 command_id TEXT NOT NULL UNIQUE CHECK(command_id='owner-stock-'||request_id) REFERENCES commerce_commands(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 mode TEXT NOT NULL CHECK(mode='local-test'),
 instance_id TEXT NOT NULL,
 actor_hash TEXT NOT NULL CHECK(length(actor_hash)=64 AND actor_hash NOT GLOB '*[^a-f0-9]*'),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
 variant_id TEXT NOT NULL REFERENCES commerce_inventory(variant_id) ON DELETE RESTRICT,
 operation TEXT NOT NULL CHECK(operation IN ('receive','fb_reserve','fb_release','fb_sale')),
 quantity INTEGER NOT NULL CHECK(typeof(quantity)='integer' AND ((operation='receive' AND quantity BETWEEN 1 AND 1000) OR (operation!='receive' AND quantity=1))),
 variant_version INTEGER NOT NULL CHECK(typeof(variant_version)='integer' AND variant_version BETWEEN 1 AND 9007199254740991),
 before_on_hand INTEGER NOT NULL CHECK(typeof(before_on_hand)='integer' AND before_on_hand BETWEEN 0 AND 1000000),
 before_facebook INTEGER NOT NULL CHECK(typeof(before_facebook)='integer' AND before_facebook BETWEEN 0 AND 1),
 before_checkout INTEGER NOT NULL CHECK(typeof(before_checkout)='integer' AND before_checkout BETWEEN 0 AND 1000000),
 before_allocated INTEGER NOT NULL CHECK(typeof(before_allocated)='integer' AND before_allocated BETWEEN 0 AND 1000000),
 after_on_hand INTEGER NOT NULL CHECK(typeof(after_on_hand)='integer' AND after_on_hand BETWEEN 0 AND 1000000),
 after_facebook INTEGER NOT NULL CHECK(typeof(after_facebook)='integer' AND after_facebook BETWEEN 0 AND 1),
 recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at BETWEEN 0 AND 8640000000000000),
 CHECK(before_on_hand>=before_facebook+before_checkout+before_allocated),
 CHECK(after_on_hand=before_on_hand+CASE operation WHEN 'receive' THEN quantity WHEN 'fb_sale' THEN -1 ELSE 0 END),
 CHECK(after_facebook=before_facebook+CASE operation WHEN 'fb_reserve' THEN 1 WHEN 'fb_release' THEN -1 WHEN 'fb_sale' THEN -1 ELSE 0 END),
 CHECK(after_on_hand>=after_facebook+before_checkout+before_allocated)
);
CREATE INDEX commerce_owner_stock_variant_history ON commerce_owner_stock_commands(variant_id,recorded_at,request_id);
CREATE TRIGGER commerce_owner_stock_source BEFORE INSERT ON commerce_owner_stock_commands
WHEN NOT EXISTS (
 SELECT 1 FROM commerce_payment_scope s JOIN commerce_variants v ON v.id=NEW.variant_id
 JOIN commerce_inventory i ON i.variant_id=v.id
 WHERE s.id=1 AND s.mode=NEW.mode AND s.instance_id=NEW.instance_id
 AND v.version=NEW.variant_version AND i.on_hand=NEW.before_on_hand
 AND i.facebook_reserved=NEW.before_facebook AND i.checkout_reserved=NEW.before_checkout AND i.allocated=NEW.before_allocated
) OR EXISTS (SELECT 1 FROM commerce_commands WHERE id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'commerce_owner_stock_conflict'); END;
CREATE TRIGGER commerce_owner_stock_movement_source BEFORE INSERT ON commerce_stock_movements
WHEN substr(NEW.command_id,1,12)='owner-stock-' AND NOT EXISTS (
 SELECT 1 FROM commerce_owner_stock_commands r WHERE r.command_id=NEW.command_id
 AND NEW.position=0 AND NEW.variant_id=r.variant_id AND NEW.kind=r.operation AND NEW.quantity=r.quantity
 AND NEW.expected_variant_version=r.variant_version
 AND NEW.reason=CASE r.operation WHEN 'receive' THEN 'Owner inspected stock receipt'
 WHEN 'fb_reserve' THEN 'Owner Facebook reservation' WHEN 'fb_release' THEN 'Owner Facebook release' ELSE 'Owner Facebook sale' END
)
BEGIN SELECT RAISE(ABORT,'commerce_owner_stock_movement_source'); END;
CREATE TRIGGER commerce_owner_stock_apply AFTER INSERT ON commerce_owner_stock_commands BEGIN
 INSERT INTO commerce_commands(id,request_hash,created_at) VALUES(NEW.command_id,NEW.request_hash,NEW.recorded_at);
 INSERT INTO commerce_stock_movements(command_id,position,variant_id,kind,quantity,expected_variant_version,reason)
 VALUES(NEW.command_id,0,NEW.variant_id,NEW.operation,NEW.quantity,NEW.variant_version,
 CASE NEW.operation WHEN 'receive' THEN 'Owner inspected stock receipt' WHEN 'fb_reserve' THEN 'Owner Facebook reservation'
 WHEN 'fb_release' THEN 'Owner Facebook release' ELSE 'Owner Facebook sale' END);
 -- Silent ignored commands/movements/balance updates must abort the parent too.
 SELECT CASE WHEN NOT EXISTS (
 SELECT 1 FROM commerce_commands c JOIN commerce_stock_movements m ON m.command_id=c.id
 JOIN commerce_inventory i ON i.variant_id=NEW.variant_id JOIN commerce_variants v ON v.id=i.variant_id
 WHERE c.id=NEW.command_id AND c.request_hash=NEW.request_hash AND c.created_at=NEW.recorded_at
 AND m.position=0 AND m.variant_id=NEW.variant_id AND m.kind=NEW.operation AND m.quantity=NEW.quantity
 AND m.expected_variant_version=NEW.variant_version AND v.version=NEW.variant_version
 AND m.reason=CASE NEW.operation WHEN 'receive' THEN 'Owner inspected stock receipt' WHEN 'fb_reserve' THEN 'Owner Facebook reservation'
 WHEN 'fb_release' THEN 'Owner Facebook release' ELSE 'Owner Facebook sale' END
 AND (SELECT COUNT(*) FROM commerce_stock_movements WHERE command_id=NEW.command_id)=1
 AND i.on_hand=NEW.after_on_hand AND i.facebook_reserved=NEW.after_facebook
 AND i.checkout_reserved=NEW.before_checkout AND i.allocated=NEW.before_allocated
 ) THEN RAISE(ABORT,'commerce_owner_stock_incomplete') END;
END;
CREATE TRIGGER commerce_owner_stock_no_update BEFORE UPDATE ON commerce_owner_stock_commands
BEGIN SELECT RAISE(ABORT,'commerce_owner_stock_immutable'); END;
CREATE TRIGGER commerce_owner_stock_no_delete BEFORE DELETE ON commerce_owner_stock_commands
BEGIN SELECT RAISE(ABORT,'commerce_owner_stock_immutable'); END;
CREATE TRIGGER commerce_owner_stock_no_replace BEFORE INSERT ON commerce_owner_stock_commands
WHEN EXISTS (SELECT 1 FROM commerce_owner_stock_commands WHERE request_id=NEW.request_id OR command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'commerce_owner_stock_exists'); END;
