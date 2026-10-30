-- Owned unpaid release only. No HTTP/scheduler/provider or payment enablement.
-- One parent INSERT owns command, all ledger releases and the root state update.
CREATE TABLE commerce_checkout_order_releases (
 release_id TEXT PRIMARY KEY NOT NULL CHECK(typeof(release_id)='text' AND length(release_id)=36 AND substr(release_id,9,1)='-' AND substr(release_id,14,1)='-' AND substr(release_id,19,1)='-' AND substr(release_id,24,1)='-' AND substr(release_id,15,1)='4' AND substr(release_id,20,1) IN ('8','9','a','b') AND length(replace(release_id,'-',''))=32 AND replace(release_id,'-','') NOT GLOB '*[^a-f0-9]*'),
 command_id TEXT NOT NULL UNIQUE CHECK(command_id='checkout-release-'||release_id),
 mode TEXT NOT NULL CHECK(mode='local-test'),
 instance_id TEXT NOT NULL CHECK(typeof(instance_id)='text' AND length(instance_id)=36 AND substr(instance_id,9,1)='-' AND substr(instance_id,14,1)='-' AND substr(instance_id,19,1)='-' AND substr(instance_id,24,1)='-' AND substr(instance_id,15,1)='4' AND substr(instance_id,20,1) IN ('8','9','a','b') AND length(replace(instance_id,'-',''))=32 AND replace(instance_id,'-','') NOT GLOB '*[^a-f0-9]*'),
 owner_hash TEXT NOT NULL CHECK(typeof(owner_hash)='text' AND length(owner_hash)=64 AND owner_hash NOT GLOB '*[^a-f0-9]*'),
 release_key TEXT NOT NULL CHECK(typeof(release_key)='text' AND length(release_key)=36 AND substr(release_key,9,1)='-' AND substr(release_key,14,1)='-' AND substr(release_key,19,1)='-' AND substr(release_key,24,1)='-' AND substr(release_key,15,1)='4' AND substr(release_key,20,1) IN ('8','9','a','b') AND length(replace(release_key,'-',''))=32 AND replace(release_key,'-','') NOT GLOB '*[^a-f0-9]*'),
 request_hash TEXT NOT NULL CHECK(typeof(request_hash)='text' AND length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
 order_id TEXT NOT NULL UNIQUE REFERENCES commerce_checkout_order_origins(order_id) ON DELETE RESTRICT,
 kind TEXT NOT NULL CHECK(kind IN ('cancel','expire')),
 expected_version INTEGER NOT NULL CHECK(typeof(expected_version)='integer' AND expected_version BETWEEN 1 AND 9007199254740990),
 resulting_version INTEGER NOT NULL CHECK(typeof(resulting_version)='integer' AND resulting_version=expected_version+1),
 occurred_at INTEGER NOT NULL CHECK(typeof(occurred_at)='integer' AND occurred_at BETWEEN 0 AND 8640000000000000),
 UNIQUE(mode,instance_id,owner_hash,release_key),
 FOREIGN KEY(command_id) REFERENCES commerce_commands(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER commerce_checkout_release_guard BEFORE INSERT ON commerce_checkout_order_releases
WHEN NOT EXISTS (
 SELECT 1 FROM commerce_checkout_order_origins x JOIN commerce_orders o ON o.id=x.order_id
 WHERE x.order_id=NEW.order_id AND x.mode=NEW.mode AND x.instance_id=NEW.instance_id AND x.owner_hash=NEW.owner_hash
 AND o.owner_hash=x.owner_hash AND o.quote_id=x.promoted_quote_id AND o.reserve_command_id=x.command_id
 AND o.created_at=x.created_at AND o.reserve_until=x.reserve_until
 AND o.state='pending_payment' AND o.payment_state='not_started' AND o.fulfillment='none'
 AND o.version=NEW.expected_version AND o.created_at<=NEW.occurred_at
 AND (NEW.kind='cancel' OR o.reserve_until<=NEW.occurred_at)
 -- Unscoped: a durable attempt in ANY provider/context forbids blind release.
 -- All existing execution/work/financial evidence is rooted in an attempt FK.
 AND NOT EXISTS (SELECT 1 FROM commerce_payment_attempts a WHERE a.order_id=o.id)
) OR EXISTS (SELECT 1 FROM commerce_commands WHERE id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'commerce_checkout_release_conflict'); END;

-- The validated parent is visible within its atomic statement. No parent can
-- commit without full materialization; any later failure restores the old floor.
DROP TRIGGER commerce_checkout_inventory_floor;
DROP TRIGGER commerce_checkout_inventory_insert_floor;
CREATE TRIGGER commerce_checkout_inventory_floor BEFORE UPDATE ON commerce_inventory
WHEN NEW.checkout_reserved < (
 SELECT COALESCE(SUM(l.quantity),0) FROM commerce_order_lines l
 JOIN commerce_checkout_order_origins x ON x.order_id=l.order_id
 WHERE l.variant_id=OLD.variant_id AND NOT EXISTS (
  SELECT 1 FROM commerce_checkout_order_releases r WHERE r.order_id=x.order_id
  AND r.mode=x.mode AND r.instance_id=x.instance_id AND r.owner_hash=x.owner_hash
 )
)
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_hold_protected'); END;
CREATE TRIGGER commerce_checkout_inventory_insert_floor BEFORE INSERT ON commerce_inventory
WHEN NEW.checkout_reserved < (
 SELECT COALESCE(SUM(l.quantity),0) FROM commerce_order_lines l
 JOIN commerce_checkout_order_origins x ON x.order_id=l.order_id
 WHERE l.variant_id=NEW.variant_id AND NOT EXISTS (
  SELECT 1 FROM commerce_checkout_order_releases r WHERE r.order_id=x.order_id
  AND r.mode=x.mode AND r.instance_id=x.instance_id AND r.owner_hash=x.owner_hash
 )
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
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_immutable'); END;

CREATE TRIGGER commerce_checkout_release_movement_source BEFORE INSERT ON commerce_stock_movements
WHEN EXISTS (SELECT 1 FROM commerce_checkout_order_releases WHERE command_id=NEW.command_id)
 AND NOT EXISTS (
 SELECT 1 FROM commerce_checkout_order_releases r JOIN commerce_order_lines l ON l.order_id=r.order_id
 WHERE r.command_id=NEW.command_id AND l.position=NEW.position AND l.variant_id=NEW.variant_id AND l.quantity=NEW.quantity
 AND NEW.kind='release' AND NEW.expected_variant_version IS NULL AND NEW.reason='Owned unpaid checkout release'
)
BEGIN SELECT RAISE(ABORT,'commerce_checkout_release_movement_source'); END;
CREATE TRIGGER commerce_checkout_release_materialize AFTER INSERT ON commerce_checkout_order_releases BEGIN
 INSERT INTO commerce_commands(id,request_hash,created_at) VALUES (NEW.command_id,NEW.request_hash,NEW.occurred_at);
 INSERT INTO commerce_stock_movements(command_id,position,variant_id,kind,quantity,expected_variant_version,reason)
 SELECT NEW.command_id,position,variant_id,'release',quantity,NULL,'Owned unpaid checkout release'
 FROM commerce_order_lines WHERE order_id=NEW.order_id ORDER BY position;
 UPDATE commerce_orders SET state='cancelled',version=NEW.resulting_version WHERE id=NEW.order_id;
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM commerce_orders o JOIN commerce_checkout_order_origins x ON x.order_id=o.id
  JOIN commerce_commands c ON c.id=NEW.command_id
  WHERE o.id=NEW.order_id AND o.state='cancelled' AND o.version=NEW.resulting_version
   AND o.payment_state='not_started' AND o.fulfillment='none' AND o.owner_hash=NEW.owner_hash
   AND o.quote_id=x.promoted_quote_id AND o.reserve_command_id=x.command_id
   AND o.created_at=x.created_at AND o.reserve_until=x.reserve_until
   AND c.request_hash=NEW.request_hash AND c.created_at=NEW.occurred_at
   AND (SELECT COUNT(*) FROM commerce_order_lines WHERE order_id=o.id) BETWEEN 1 AND 20
   AND (SELECT COUNT(*) FROM commerce_stock_movements WHERE command_id=NEW.command_id)
       =(SELECT COUNT(*) FROM commerce_order_lines WHERE order_id=o.id)
   AND NOT EXISTS (SELECT 1 FROM commerce_order_lines l WHERE l.order_id=o.id AND NOT EXISTS (
    SELECT 1 FROM commerce_stock_movements m WHERE m.command_id=NEW.command_id AND m.position=l.position
     AND m.variant_id=l.variant_id AND m.quantity=l.quantity AND m.kind='release' AND m.expected_variant_version IS NULL
     AND m.reason='Owned unpaid checkout release'
   ))
 ) THEN RAISE(ABORT,'commerce_checkout_release_incomplete') END;
END;
CREATE TRIGGER commerce_checkout_releases_no_update BEFORE UPDATE ON commerce_checkout_order_releases
BEGIN SELECT RAISE(ABORT,'commerce_checkout_release_immutable'); END;
CREATE TRIGGER commerce_checkout_releases_no_delete BEFORE DELETE ON commerce_checkout_order_releases
BEGIN SELECT RAISE(ABORT,'commerce_checkout_release_immutable'); END;
CREATE TRIGGER commerce_checkout_releases_no_replace BEFORE INSERT ON commerce_checkout_order_releases
WHEN EXISTS (SELECT 1 FROM commerce_checkout_order_releases WHERE release_id=NEW.release_id OR command_id=NEW.command_id
 OR order_id=NEW.order_id OR (mode=NEW.mode AND instance_id=NEW.instance_id AND owner_hash=NEW.owner_hash AND release_key=NEW.release_key))
BEGIN SELECT RAISE(ABORT,'commerce_checkout_release_exists'); END;
