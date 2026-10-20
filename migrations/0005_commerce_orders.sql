-- Persistent test quotes and order-owned reservations, no payment enablement.
CREATE TABLE commerce_quotes (
  id TEXT PRIMARY KEY NOT NULL,
  owner_hash TEXT NOT NULL CHECK(length(owner_hash) = 64),
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer'),
  expires_at INTEGER NOT NULL CHECK(typeof(expires_at) = 'integer' AND expires_at > created_at)
);
CREATE TABLE commerce_orders (
  id TEXT PRIMARY KEY NOT NULL,
  quote_id TEXT NOT NULL UNIQUE REFERENCES commerce_quotes(id) ON DELETE RESTRICT,
  owner_hash TEXT NOT NULL CHECK(length(owner_hash) = 64),
  reserve_command_id TEXT NOT NULL UNIQUE REFERENCES commerce_commands(id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'pending_payment' CHECK(state IN ('pending_payment','confirmed','cancelled','closed')),
  fulfillment TEXT NOT NULL DEFAULT 'none' CHECK(fulfillment IN ('none','ready_to_pack','held','completed')),
  payment_state TEXT NOT NULL DEFAULT 'not_started' CHECK(payment_state IN ('not_started','processing','succeeded','unknown','failed')),
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
  reserve_until INTEGER NOT NULL CHECK(typeof(reserve_until) = 'integer' AND reserve_until > created_at),
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version) = 'integer' AND version >= 1)
);
CREATE TABLE commerce_order_lines (
  order_id TEXT NOT NULL REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK(typeof(position) = 'integer' AND position >= 0),
  variant_id TEXT NOT NULL REFERENCES commerce_variants(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK(typeof(quantity) = 'integer' AND quantity BETWEEN 1 AND 20),
  unit_price_cents INTEGER NOT NULL CHECK(typeof(unit_price_cents) = 'integer' AND unit_price_cents >= 0),
  variant_version INTEGER NOT NULL CHECK(typeof(variant_version) = 'integer' AND variant_version >= 1),
  PRIMARY KEY(order_id, position),
  UNIQUE(order_id, variant_id)
);
CREATE TRIGGER commerce_quote_no_update BEFORE UPDATE ON commerce_quotes
BEGIN SELECT RAISE(ABORT, 'commerce_quote_immutable'); END;
CREATE TRIGGER commerce_quote_no_replace BEFORE INSERT ON commerce_quotes
WHEN EXISTS (SELECT 1 FROM commerce_quotes WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'commerce_quote_exists'); END;
CREATE TRIGGER commerce_order_quote_guard BEFORE INSERT ON commerce_orders
WHEN NOT EXISTS (SELECT 1 FROM commerce_quotes q WHERE q.id = NEW.quote_id
 AND q.owner_hash = NEW.owner_hash AND q.expires_at > NEW.created_at AND q.snapshot = NEW.snapshot)
 OR NEW.state != 'pending_payment' OR NEW.payment_state != 'not_started' OR NEW.fulfillment != 'none'
BEGIN SELECT RAISE(ABORT, 'commerce_quote_invalid'); END;
CREATE TRIGGER commerce_line_guard BEFORE INSERT ON commerce_order_lines
WHEN NOT EXISTS (SELECT 1 FROM commerce_variants v JOIN products p ON p.id = v.product_id
 JOIN commerce_orders o ON o.id = NEW.order_id
 WHERE v.id = NEW.variant_id AND v.version = NEW.variant_version AND v.price_cents = NEW.unit_price_cents
 AND v.active = 1 AND p.status = 'available' AND o.state = 'pending_payment' AND o.payment_state = 'not_started')
BEGIN SELECT RAISE(ABORT, 'commerce_quote_changed'); END;
CREATE TRIGGER commerce_line_reserve AFTER INSERT ON commerce_order_lines BEGIN
 INSERT INTO commerce_stock_movements(command_id, position, variant_id, kind, quantity, expected_variant_version, reason)
 VALUES ((SELECT reserve_command_id FROM commerce_orders WHERE id = NEW.order_id), NEW.position,
 NEW.variant_id, 'reserve', NEW.quantity, NEW.variant_version, 'Order reservation');
END;
CREATE TRIGGER commerce_lines_no_update BEFORE UPDATE ON commerce_order_lines
BEGIN SELECT RAISE(ABORT, 'commerce_order_lines_immutable'); END;
CREATE TRIGGER commerce_lines_no_delete BEFORE DELETE ON commerce_order_lines
BEGIN SELECT RAISE(ABORT, 'commerce_order_lines_immutable'); END;
CREATE TRIGGER commerce_lines_no_replace BEFORE INSERT ON commerce_order_lines
WHEN EXISTS (SELECT 1 FROM commerce_order_lines WHERE order_id = NEW.order_id AND (position = NEW.position OR variant_id = NEW.variant_id))
BEGIN SELECT RAISE(ABORT, 'commerce_order_line_exists'); END;

CREATE TABLE commerce_order_transitions (
 command_id TEXT PRIMARY KEY NOT NULL REFERENCES commerce_commands(id) ON DELETE RESTRICT,
 order_id TEXT NOT NULL REFERENCES commerce_orders(id) ON DELETE RESTRICT,
 kind TEXT NOT NULL CHECK(kind IN ('cancel','expire')),
 expected_version INTEGER NOT NULL,
 occurred_at INTEGER NOT NULL CHECK(typeof(occurred_at) = 'integer' AND occurred_at >= 0)
);
CREATE TRIGGER commerce_transition_guard BEFORE INSERT ON commerce_order_transitions
WHEN NOT EXISTS (SELECT 1 FROM commerce_orders WHERE id = NEW.order_id
 AND version = NEW.expected_version AND state = 'pending_payment' AND payment_state = 'not_started'
 AND (NEW.kind = 'cancel' OR reserve_until <= NEW.occurred_at))
BEGIN SELECT RAISE(ABORT, 'commerce_order_transition_conflict'); END;
CREATE TRIGGER commerce_order_release AFTER INSERT ON commerce_order_transitions BEGIN
 INSERT INTO commerce_stock_movements(command_id, position, variant_id, kind, quantity, reason)
 SELECT NEW.command_id, position, variant_id, 'release', quantity, 'Unpaid order release'
 FROM commerce_order_lines WHERE order_id = NEW.order_id;
 UPDATE commerce_orders SET state = 'cancelled', version = version + 1 WHERE id = NEW.order_id;
END;
CREATE TRIGGER commerce_transitions_no_update BEFORE UPDATE ON commerce_order_transitions
BEGIN SELECT RAISE(ABORT, 'commerce_order_transition_immutable'); END;
CREATE TRIGGER commerce_transitions_no_delete BEFORE DELETE ON commerce_order_transitions
BEGIN SELECT RAISE(ABORT, 'commerce_order_transition_immutable'); END;
CREATE TRIGGER commerce_transitions_no_replace BEFORE INSERT ON commerce_order_transitions
WHEN EXISTS (SELECT 1 FROM commerce_order_transitions WHERE command_id = NEW.command_id)
BEGIN SELECT RAISE(ABORT, 'commerce_order_transition_exists'); END;
CREATE INDEX commerce_orders_expiry ON commerce_orders(state, payment_state, reserve_until);
