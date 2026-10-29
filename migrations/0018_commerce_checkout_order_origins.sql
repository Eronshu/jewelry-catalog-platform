-- CREATE-ONLY internal fixture bridge to the single existing order/stock root.
-- No consumers may activate it until owned unpaid release/expiry is separately audited.
-- No provider authorization: the legacy payment table/rules remain unchanged.
CREATE TABLE commerce_checkout_order_origins (
  order_id TEXT PRIMARY KEY NOT NULL CHECK(order_id='order-'||promoted_quote_id),
  mode TEXT NOT NULL CHECK(mode='local-test'),
  instance_id TEXT NOT NULL CHECK(typeof(instance_id)='text' AND length(instance_id)=36 AND substr(instance_id,9,1)='-' AND substr(instance_id,14,1)='-' AND substr(instance_id,19,1)='-' AND substr(instance_id,24,1)='-' AND substr(instance_id,15,1)='4' AND substr(instance_id,20,1) IN ('8','9','a','b') AND length(replace(instance_id,'-',''))=32 AND replace(instance_id,'-','') NOT GLOB '*[^a-f0-9]*'),
  owner_hash TEXT NOT NULL CHECK(typeof(owner_hash)='text' AND length(owner_hash)=64 AND owner_hash NOT GLOB '*[^a-f0-9]*'),
  create_key TEXT NOT NULL CHECK(typeof(create_key)='text' AND length(create_key)=36 AND substr(create_key,9,1)='-' AND substr(create_key,14,1)='-' AND substr(create_key,19,1)='-' AND substr(create_key,24,1)='-' AND substr(create_key,15,1)='4' AND substr(create_key,20,1) IN ('8','9','a','b') AND length(replace(create_key,'-',''))=32 AND replace(create_key,'-','') NOT GLOB '*[^a-f0-9]*'),
  request_hash TEXT NOT NULL CHECK(typeof(request_hash)='text' AND length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  acceptance_id TEXT NOT NULL UNIQUE REFERENCES commerce_checkout_acceptances(acceptance_id) ON DELETE RESTRICT,
  checkout_quote_id TEXT NOT NULL UNIQUE,
  promoted_quote_id TEXT NOT NULL UNIQUE CHECK(typeof(promoted_quote_id)='text' AND length(promoted_quote_id)=36 AND substr(promoted_quote_id,9,1)='-' AND substr(promoted_quote_id,14,1)='-' AND substr(promoted_quote_id,19,1)='-' AND substr(promoted_quote_id,24,1)='-' AND substr(promoted_quote_id,15,1)='4' AND substr(promoted_quote_id,20,1) IN ('8','9','a','b') AND length(replace(promoted_quote_id,'-',''))=32 AND replace(promoted_quote_id,'-','') NOT GLOB '*[^a-f0-9]*'),
  command_id TEXT NOT NULL UNIQUE CHECK(command_id='reserve-'||promoted_quote_id),
  rules_hash TEXT NOT NULL CHECK(typeof(rules_hash)='text' AND length(rules_hash)=64 AND rules_hash NOT GLOB '*[^a-f0-9]*'),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 8640000000000000),
  reserve_until INTEGER NOT NULL CHECK(typeof(reserve_until)='integer' AND reserve_until>created_at AND reserve_until<=8640000000000000),
  UNIQUE(mode,instance_id,owner_hash,create_key),
  FOREIGN KEY(checkout_quote_id,mode,instance_id,owner_hash) REFERENCES commerce_checkout_quotes(quote_id,mode,instance_id,owner_hash) ON DELETE RESTRICT,
  -- The one parent INSERT materializes all three targets before its statement ends.
  FOREIGN KEY(promoted_quote_id) REFERENCES commerce_quotes(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(order_id) REFERENCES commerce_orders(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(command_id) REFERENCES commerce_commands(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER commerce_checkout_order_origin_guard BEFORE INSERT ON commerce_checkout_order_origins
WHEN NOT EXISTS (
  SELECT 1 FROM commerce_checkout_acceptances a JOIN commerce_checkout_quotes q ON q.quote_id=a.quote_id
  WHERE a.acceptance_id=NEW.acceptance_id AND q.quote_id=NEW.checkout_quote_id
    AND a.mode=NEW.mode AND a.instance_id=NEW.instance_id AND a.owner_hash=NEW.owner_hash
    AND q.mode=NEW.mode AND q.instance_id=NEW.instance_id AND q.owner_hash=NEW.owner_hash
    AND q.created_at<=a.accepted_at AND a.accepted_at<=NEW.created_at AND NEW.created_at<q.expires_at
    AND NEW.reserve_until=q.expires_at AND q.rules_hash=NEW.rules_hash
) OR EXISTS (SELECT 1 FROM commerce_quotes WHERE id=NEW.promoted_quote_id)
  OR EXISTS (SELECT 1 FROM commerce_orders WHERE id=NEW.order_id OR quote_id=NEW.promoted_quote_id OR reserve_command_id=NEW.command_id)
  OR EXISTS (SELECT 1 FROM commerce_commands WHERE id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_invalid_origin'); END;
-- Full current displayed identity + inspected website stock, not just a version/hash.
CREATE TRIGGER commerce_checkout_order_current BEFORE INSERT ON commerce_checkout_order_origins
WHEN EXISTS (
  SELECT 1 FROM commerce_checkout_quotes q,json_each(q.snapshot_json,'$.lines') j
  LEFT JOIN commerce_variants v ON v.id=json_extract(j.value,'$.variantId')
  LEFT JOIN products p ON p.id=v.product_id
  LEFT JOIN commerce_inventory i ON i.variant_id=v.id
  WHERE q.quote_id=NEW.checkout_quote_id AND (
    v.id IS NULL OR i.variant_id IS NULL OR v.active IS NOT 1 OR p.status IS NOT 'available'
    OR v.version IS NOT json_extract(j.value,'$.version') OR v.price_cents IS NOT json_extract(j.value,'$.unitPriceCents')
    OR v.sku COLLATE BINARY IS NOT json_extract(j.value,'$.sku') OR p.name IS NOT json_extract(j.value,'$.name')
    OR v.colour IS NOT json_extract(j.value,'$.colour') OR v.size_description IS NOT json_extract(j.value,'$.sizeDescription')
    OR i.on_hand-i.facebook_reserved-i.checkout_reserved-i.allocated<json_extract(j.value,'$.quantity'))
)
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_stale'); END;

-- Rich checkout snapshots cannot be inserted as untyped legacy lab records.
-- The origin row is visible before the parent AFTER trigger creates its targets.
CREATE TRIGGER commerce_checkout_quote_source BEFORE INSERT ON commerce_quotes
WHEN (NOT (json_type(NEW.snapshot) IS 'object' AND json_type(NEW.snapshot,'$.testOnly') IS 'true' AND json_extract(NEW.snapshot,'$.currency') IS 'CAD' AND json_extract(NEW.snapshot,'$.rulesVersion') IS 'local-test-v1' AND json_type(NEW.snapshot,'$.taxCents') IS 'integer' AND json_extract(NEW.snapshot,'$.taxCents') IS 0 AND json_type(NEW.snapshot,'$.contractVersion') IS NULL AND json_type(NEW.snapshot,'$.fixtureProfile') IS NULL) OR EXISTS (SELECT 1 FROM commerce_checkout_order_origins WHERE promoted_quote_id=NEW.id))
 AND NOT EXISTS (
  SELECT 1 FROM commerce_checkout_order_origins x JOIN commerce_checkout_quotes q ON q.quote_id=x.checkout_quote_id
  WHERE x.promoted_quote_id=NEW.id AND NEW.owner_hash=x.owner_hash AND NEW.created_at=x.created_at
    AND NEW.expires_at=x.reserve_until AND NEW.snapshot=json_remove(q.snapshot_json,'$.fixtureProfile')
 )
BEGIN SELECT RAISE(ABORT,'commerce_checkout_quote_requires_origin'); END;
CREATE TRIGGER commerce_checkout_order_source BEFORE INSERT ON commerce_orders
WHEN (NOT (json_type(NEW.snapshot) IS 'object' AND json_type(NEW.snapshot,'$.testOnly') IS 'true' AND json_extract(NEW.snapshot,'$.currency') IS 'CAD' AND json_extract(NEW.snapshot,'$.rulesVersion') IS 'local-test-v1' AND json_type(NEW.snapshot,'$.taxCents') IS 'integer' AND json_extract(NEW.snapshot,'$.taxCents') IS 0 AND json_type(NEW.snapshot,'$.contractVersion') IS NULL AND json_type(NEW.snapshot,'$.fixtureProfile') IS NULL) OR EXISTS (SELECT 1 FROM commerce_checkout_order_origins WHERE order_id=NEW.id OR promoted_quote_id=NEW.quote_id OR command_id=NEW.reserve_command_id))
 AND NOT EXISTS (
  SELECT 1 FROM commerce_checkout_order_origins x JOIN commerce_checkout_quotes q ON q.quote_id=x.checkout_quote_id
  WHERE x.order_id=NEW.id AND x.promoted_quote_id=NEW.quote_id AND x.command_id=NEW.reserve_command_id
    AND x.owner_hash=NEW.owner_hash AND NEW.created_at=x.created_at AND NEW.reserve_until=x.reserve_until
    AND NEW.snapshot=json_remove(q.snapshot_json,'$.fixtureProfile')
    AND NEW.state='pending_payment' AND NEW.payment_state='not_started' AND NEW.fulfillment='none' AND NEW.version=1
 )
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_requires_origin'); END;
CREATE TRIGGER commerce_checkout_order_line_source BEFORE INSERT ON commerce_order_lines
WHEN EXISTS (SELECT 1 FROM commerce_checkout_order_origins WHERE order_id=NEW.order_id)
 AND NOT EXISTS (
  SELECT 1 FROM commerce_checkout_order_origins x JOIN commerce_checkout_quotes q ON q.quote_id=x.checkout_quote_id,
    json_each(q.snapshot_json,'$.lines') j
  WHERE x.order_id=NEW.order_id AND j.key=NEW.position
    AND json_extract(j.value,'$.variantId')=NEW.variant_id AND json_extract(j.value,'$.quantity')=NEW.quantity
    AND json_extract(j.value,'$.unitPriceCents')=NEW.unit_price_cents AND json_extract(j.value,'$.version')=NEW.variant_version
 )
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_line_source'); END;
CREATE TRIGGER commerce_checkout_order_movement_source BEFORE INSERT ON commerce_stock_movements
WHEN EXISTS (SELECT 1 FROM commerce_checkout_order_origins WHERE command_id=NEW.command_id)
 AND NOT EXISTS (
  SELECT 1 FROM commerce_checkout_order_origins x JOIN commerce_order_lines l ON l.order_id=x.order_id
  WHERE x.command_id=NEW.command_id AND l.position=NEW.position AND l.variant_id=NEW.variant_id
    AND l.quantity=NEW.quantity AND l.variant_version=NEW.expected_variant_version
    AND NEW.kind='reserve' AND NEW.reason='Order reservation'
 )
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_movement_source'); END;
-- Generic internal movement commands cannot steal the mapped pending order holds.
-- The future owned-release migration must explicitly evolve this create-only floor.
CREATE TRIGGER commerce_checkout_inventory_floor BEFORE UPDATE ON commerce_inventory
WHEN NEW.checkout_reserved < (
  SELECT COALESCE(SUM(l.quantity),0) FROM commerce_order_lines l
  JOIN commerce_checkout_order_origins x ON x.order_id=l.order_id WHERE l.variant_id=OLD.variant_id
)
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_hold_protected'); END;
CREATE TRIGGER commerce_checkout_inventory_insert_floor BEFORE INSERT ON commerce_inventory
WHEN NEW.checkout_reserved < (
  SELECT COALESCE(SUM(l.quantity),0) FROM commerce_order_lines l
  JOIN commerce_checkout_order_origins x ON x.order_id=l.order_id WHERE l.variant_id=NEW.variant_id
)
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_hold_protected'); END;

CREATE TRIGGER commerce_checkout_order_materialize AFTER INSERT ON commerce_checkout_order_origins BEGIN
 INSERT INTO commerce_quotes(id,owner_hash,snapshot,created_at,expires_at)
 SELECT NEW.promoted_quote_id,NEW.owner_hash,json_remove(q.snapshot_json,'$.fixtureProfile'),NEW.created_at,NEW.reserve_until
 FROM commerce_checkout_quotes q WHERE q.quote_id=NEW.checkout_quote_id;
 INSERT INTO commerce_commands(id,request_hash,created_at) VALUES (NEW.command_id,NEW.request_hash,NEW.created_at);
 INSERT INTO commerce_orders(id,quote_id,owner_hash,reserve_command_id,snapshot,created_at,reserve_until)
 SELECT NEW.order_id,NEW.promoted_quote_id,NEW.owner_hash,NEW.command_id,json_remove(q.snapshot_json,'$.fixtureProfile'),NEW.created_at,NEW.reserve_until
 FROM commerce_checkout_quotes q WHERE q.quote_id=NEW.checkout_quote_id;
 -- Existing commerce_line_reserve performs the ONE movement/hold per order line.
 INSERT INTO commerce_order_lines(order_id,position,variant_id,quantity,unit_price_cents,variant_version)
 SELECT NEW.order_id,j.key,json_extract(j.value,'$.variantId'),json_extract(j.value,'$.quantity'),
   json_extract(j.value,'$.unitPriceCents'),json_extract(j.value,'$.version')
 FROM commerce_checkout_quotes q,json_each(q.snapshot_json,'$.lines') j WHERE q.quote_id=NEW.checkout_quote_id ORDER BY j.key;
 -- Make zero-row/partial materialization a SQL failure, never a post-commit check.
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM commerce_checkout_quotes q JOIN commerce_quotes p ON p.id=NEW.promoted_quote_id
   JOIN commerce_orders o ON o.id=NEW.order_id JOIN commerce_commands c ON c.id=NEW.command_id
  WHERE q.quote_id=NEW.checkout_quote_id
   AND p.snapshot=json_remove(q.snapshot_json,'$.fixtureProfile') AND o.snapshot=p.snapshot
   AND p.owner_hash=NEW.owner_hash AND o.owner_hash=NEW.owner_hash
   AND o.quote_id=p.id AND o.reserve_command_id=c.id AND c.request_hash=NEW.request_hash
   AND o.state='pending_payment' AND o.payment_state='not_started' AND o.fulfillment='none' AND o.version=1
   AND p.created_at=NEW.created_at AND o.created_at=NEW.created_at AND c.created_at=NEW.created_at
   AND p.expires_at=NEW.reserve_until AND o.reserve_until=NEW.reserve_until
   AND (SELECT COUNT(*) FROM commerce_order_lines WHERE order_id=NEW.order_id)=json_array_length(q.snapshot_json,'$.lines')
   AND (SELECT COUNT(*) FROM commerce_stock_movements WHERE command_id=NEW.command_id)=json_array_length(q.snapshot_json,'$.lines')
   AND (SELECT COUNT(*) FROM json_each(q.snapshot_json,'$.lines') j
      JOIN commerce_order_lines l ON l.order_id=NEW.order_id AND l.position=j.key
      JOIN commerce_stock_movements m ON m.command_id=NEW.command_id AND m.position=j.key
      WHERE l.variant_id=json_extract(j.value,'$.variantId') AND l.quantity=json_extract(j.value,'$.quantity')
        AND l.unit_price_cents=json_extract(j.value,'$.unitPriceCents') AND l.variant_version=json_extract(j.value,'$.version')
        AND m.kind='reserve' AND m.variant_id=l.variant_id AND m.quantity=l.quantity AND m.expected_variant_version=l.variant_version
   )=json_array_length(q.snapshot_json,'$.lines')
 ) THEN RAISE(ABORT,'commerce_checkout_order_incomplete') END;
END;

CREATE TRIGGER commerce_checkout_order_origins_no_update BEFORE UPDATE ON commerce_checkout_order_origins
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_origin_immutable'); END;
CREATE TRIGGER commerce_checkout_order_origins_no_delete BEFORE DELETE ON commerce_checkout_order_origins
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_origin_immutable'); END;
CREATE TRIGGER commerce_checkout_order_origins_no_replace BEFORE INSERT ON commerce_checkout_order_origins
WHEN EXISTS (SELECT 1 FROM commerce_checkout_order_origins WHERE order_id=NEW.order_id OR acceptance_id=NEW.acceptance_id
 OR checkout_quote_id=NEW.checkout_quote_id OR promoted_quote_id=NEW.promoted_quote_id OR command_id=NEW.command_id
 OR (mode=NEW.mode AND instance_id=NEW.instance_id AND owner_hash=NEW.owner_hash AND create_key=NEW.create_key))
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_origin_exists'); END;
CREATE TRIGGER commerce_checkout_order_no_update BEFORE UPDATE ON commerce_orders
WHEN EXISTS (SELECT 1 FROM commerce_checkout_order_origins WHERE order_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_immutable'); END;
CREATE TRIGGER commerce_checkout_order_no_delete BEFORE DELETE ON commerce_orders
WHEN EXISTS (SELECT 1 FROM commerce_checkout_order_origins WHERE order_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_immutable'); END;
CREATE TRIGGER commerce_checkout_order_no_replace BEFORE INSERT ON commerce_orders
WHEN EXISTS (SELECT 1 FROM commerce_orders o JOIN commerce_checkout_order_origins x ON x.order_id=o.id
 WHERE o.id=NEW.id OR o.quote_id=NEW.quote_id OR o.reserve_command_id=NEW.reserve_command_id)
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_immutable'); END;
CREATE TRIGGER commerce_checkout_order_no_transition BEFORE INSERT ON commerce_order_transitions
WHEN EXISTS (SELECT 1 FROM commerce_checkout_order_origins WHERE order_id=NEW.order_id)
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_release_not_enabled'); END;
CREATE TRIGGER commerce_checkout_order_no_recovery BEFORE INSERT ON commerce_reservation_recoveries
WHEN EXISTS (SELECT 1 FROM commerce_checkout_order_origins WHERE order_id=NEW.order_id)
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_release_not_enabled'); END;
