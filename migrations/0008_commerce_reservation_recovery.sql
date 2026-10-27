-- Additive operator-expiry audit. No backfill or change to ordinary cancellation.
CREATE TABLE commerce_reservation_recoveries (
  command_id TEXT PRIMARY KEY NOT NULL REFERENCES commerce_commands(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  actor_hash TEXT NOT NULL CHECK(length(actor_hash) = 64 AND actor_hash NOT GLOB '*[^a-f0-9]*'),
  expected_version INTEGER NOT NULL CHECK(typeof(expected_version) = 'integer' AND expected_version >= 1),
  reason TEXT NOT NULL CHECK(reason = 'overdue_unpaid'),
  occurred_at INTEGER NOT NULL CHECK(typeof(occurred_at) = 'integer' AND occurred_at >= 0)
);
CREATE INDEX commerce_recoveries_order ON commerce_reservation_recoveries(order_id, occurred_at);

-- Recheck the reviewed version and eligibility inside the write transaction.
-- A confirmation from an old screen must not release a held/started-payment order.
CREATE TRIGGER commerce_recovery_guard BEFORE INSERT ON commerce_reservation_recoveries
WHEN NOT EXISTS (SELECT 1 FROM commerce_orders o JOIN commerce_commands c ON c.id = NEW.command_id
  WHERE o.id = NEW.order_id AND o.version = NEW.expected_version
    AND o.state = 'pending_payment' AND o.payment_state = 'not_started'
    AND o.fulfillment = 'none' AND o.reserve_until <= NEW.occurred_at
    AND c.created_at = NEW.occurred_at)
  OR (SELECT count(*) FROM commerce_order_lines WHERE order_id = NEW.order_id) NOT BETWEEN 1 AND 20
BEGIN SELECT RAISE(ABORT, 'commerce_recovery_conflict'); END;

-- The existing expiry transition and stock triggers perform the actual release.
-- Any transition/line failure rolls back this audit and the entire D1 batch.
CREATE TRIGGER commerce_recovery_expire AFTER INSERT ON commerce_reservation_recoveries BEGIN
  INSERT INTO commerce_order_transitions(command_id, order_id, kind, expected_version, occurred_at)
  VALUES (NEW.command_id, NEW.order_id, 'expire', NEW.expected_version, NEW.occurred_at);
END;
CREATE TRIGGER commerce_recoveries_no_update BEFORE UPDATE ON commerce_reservation_recoveries
BEGIN SELECT RAISE(ABORT, 'commerce_recovery_immutable'); END;
CREATE TRIGGER commerce_recoveries_no_delete BEFORE DELETE ON commerce_reservation_recoveries
BEGIN SELECT RAISE(ABORT, 'commerce_recovery_immutable'); END;
CREATE TRIGGER commerce_recoveries_no_replace BEFORE INSERT ON commerce_reservation_recoveries
WHEN EXISTS (SELECT 1 FROM commerce_reservation_recoveries WHERE command_id = NEW.command_id)
BEGIN SELECT RAISE(ABORT, 'commerce_recovery_exists'); END;
