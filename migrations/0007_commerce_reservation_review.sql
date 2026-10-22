-- Read-only operator diagnostics: preserve all order and inventory history.
CREATE INDEX commerce_orders_operator_review ON commerce_orders(reserve_until, id)
WHERE state = 'pending_payment' OR fulfillment = 'held';
CREATE INDEX commerce_transitions_order_review
ON commerce_order_transitions(order_id, occurred_at DESC, command_id DESC);
