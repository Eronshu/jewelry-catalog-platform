-- Additive local commerce foundation. No backfill or public purchase enablement.
CREATE TABLE commerce_variants (
  id TEXT PRIMARY KEY NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  sku TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(trim(sku)) BETWEEN 1 AND 80),
  colour TEXT NOT NULL CHECK(length(trim(colour)) BETWEEN 1 AND 80),
  size_description TEXT NOT NULL CHECK(length(trim(size_description)) BETWEEN 1 AND 200),
  price_cents INTEGER NOT NULL CHECK(typeof(price_cents) = 'integer' AND price_cents BETWEEN 0 AND 10000000),
  currency TEXT NOT NULL DEFAULT 'CAD' CHECK(currency = 'CAD'),
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version) = 'integer' AND version >= 1),
  UNIQUE(product_id, colour, size_description)
);

CREATE TABLE commerce_inventory (
  variant_id TEXT PRIMARY KEY NOT NULL REFERENCES commerce_variants(id) ON DELETE RESTRICT,
  on_hand INTEGER NOT NULL DEFAULT 0 CHECK(typeof(on_hand) = 'integer' AND on_hand BETWEEN 0 AND 1000000),
  facebook_reserved INTEGER NOT NULL DEFAULT 0 CHECK(typeof(facebook_reserved) = 'integer' AND facebook_reserved >= 0),
  checkout_reserved INTEGER NOT NULL DEFAULT 0 CHECK(typeof(checkout_reserved) = 'integer' AND checkout_reserved >= 0),
  allocated INTEGER NOT NULL DEFAULT 0 CHECK(typeof(allocated) = 'integer' AND allocated >= 0),
  CHECK(on_hand >= facebook_reserved + checkout_reserved + allocated)
);

CREATE TRIGGER commerce_variant_inventory AFTER INSERT ON commerce_variants BEGIN
  INSERT INTO commerce_inventory(variant_id) VALUES (NEW.id);
END;
CREATE TRIGGER commerce_variant_version BEFORE UPDATE ON commerce_variants
WHEN NEW.version != OLD.version + 1 OR NEW.id != OLD.id OR NEW.product_id != OLD.product_id
BEGIN SELECT RAISE(ABORT, 'commerce_variant_version_conflict'); END;
CREATE TRIGGER commerce_legacy_stock_guard BEFORE UPDATE OF price_cents, quantity ON products
WHEN (NEW.price_cents != OLD.price_cents OR NEW.quantity IS NOT OLD.quantity)
 AND EXISTS (SELECT 1 FROM commerce_variants WHERE product_id = OLD.id AND active = 1)
BEGIN SELECT RAISE(ABORT, 'commerce_variant_is_authoritative'); END;

CREATE TABLE commerce_commands (
  id TEXT PRIMARY KEY NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
  created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0)
);
CREATE TABLE commerce_stock_movements (
  command_id TEXT NOT NULL REFERENCES commerce_commands(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK(typeof(position) = 'integer' AND position >= 0),
  variant_id TEXT NOT NULL REFERENCES commerce_inventory(variant_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('receive','fb_reserve','fb_release','fb_sale','reserve','release','allocate','fulfill','return')),
  quantity INTEGER NOT NULL CHECK(typeof(quantity) = 'integer' AND quantity BETWEEN 1 AND 1000000),
  expected_variant_version INTEGER,
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 200),
  PRIMARY KEY(command_id, position),
  CHECK(kind != 'reserve' OR (expected_variant_version IS NOT NULL AND typeof(expected_variant_version) = 'integer' AND expected_variant_version >= 1))
);
CREATE INDEX commerce_stock_variant ON commerce_stock_movements(variant_id, command_id);

-- Reserve validates publication/version inside the same transaction, not before it.
CREATE TRIGGER commerce_reserve_guard BEFORE INSERT ON commerce_stock_movements
WHEN NEW.kind = 'reserve' AND NOT EXISTS (
  SELECT 1 FROM commerce_variants v JOIN products p ON p.id = v.product_id
  WHERE v.id = NEW.variant_id AND v.active = 1 AND p.status = 'available'
    AND v.version = NEW.expected_variant_version
)
BEGIN SELECT RAISE(ABORT, 'commerce_variant_unavailable'); END;

-- This is the only application balance-writing path. CHECK failures abort batch.
CREATE TRIGGER commerce_apply_stock AFTER INSERT ON commerce_stock_movements BEGIN
  UPDATE commerce_inventory SET
    on_hand = on_hand + CASE NEW.kind WHEN 'receive' THEN NEW.quantity WHEN 'return' THEN NEW.quantity WHEN 'fb_sale' THEN -NEW.quantity WHEN 'fulfill' THEN -NEW.quantity ELSE 0 END,
    facebook_reserved = facebook_reserved + CASE NEW.kind WHEN 'fb_reserve' THEN NEW.quantity WHEN 'fb_release' THEN -NEW.quantity WHEN 'fb_sale' THEN -NEW.quantity ELSE 0 END,
    checkout_reserved = checkout_reserved + CASE NEW.kind WHEN 'reserve' THEN NEW.quantity WHEN 'release' THEN -NEW.quantity WHEN 'allocate' THEN -NEW.quantity ELSE 0 END,
    allocated = allocated + CASE NEW.kind WHEN 'allocate' THEN NEW.quantity WHEN 'fulfill' THEN -NEW.quantity ELSE 0 END
  WHERE variant_id = NEW.variant_id;
END;
CREATE TRIGGER commerce_movements_no_update BEFORE UPDATE ON commerce_stock_movements
BEGIN SELECT RAISE(ABORT, 'commerce_audit_is_immutable'); END;
CREATE TRIGGER commerce_movements_no_delete BEFORE DELETE ON commerce_stock_movements
BEGIN SELECT RAISE(ABORT, 'commerce_audit_is_immutable'); END;
CREATE TRIGGER commerce_commands_no_update BEFORE UPDATE ON commerce_commands
BEGIN SELECT RAISE(ABORT, 'commerce_command_is_immutable'); END;
CREATE TRIGGER commerce_commands_no_delete BEFORE DELETE ON commerce_commands
BEGIN SELECT RAISE(ABORT, 'commerce_command_is_immutable'); END;
-- REPLACE must not silently delete/reinsert an existing audit identity.
CREATE TRIGGER commerce_commands_no_replace BEFORE INSERT ON commerce_commands
WHEN EXISTS (SELECT 1 FROM commerce_commands WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'commerce_command_exists'); END;
CREATE TRIGGER commerce_movements_no_replace BEFORE INSERT ON commerce_stock_movements
WHEN EXISTS (SELECT 1 FROM commerce_stock_movements WHERE command_id = NEW.command_id AND position = NEW.position)
BEGIN SELECT RAISE(ABORT, 'commerce_movement_exists'); END;
