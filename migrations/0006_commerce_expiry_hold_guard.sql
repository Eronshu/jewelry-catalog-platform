-- Automatic expiry must not resolve a fulfillment hold, including a hold set
-- between the job's read and its atomic transition. Manual cancellation rules
-- stay unchanged; this does not enable payments or public inventory commands.
DROP TRIGGER commerce_transition_guard;
CREATE TRIGGER commerce_transition_guard BEFORE INSERT ON commerce_order_transitions
WHEN NOT EXISTS (SELECT 1 FROM commerce_orders WHERE id = NEW.order_id
 AND version = NEW.expected_version AND state = 'pending_payment' AND payment_state = 'not_started'
 AND (NEW.kind = 'cancel' OR (reserve_until <= NEW.occurred_at AND fulfillment = 'none')))
BEGIN SELECT RAISE(ABORT, 'commerce_order_transition_conflict'); END;

-- Restrict the ordered scan to releasable reservations, including the ID tie
-- breaker used by the continuation cursor.
CREATE INDEX commerce_orders_due_unpaid ON commerce_orders(reserve_until, id)
WHERE state = 'pending_payment' AND payment_state = 'not_started' AND fulfillment = 'none';
