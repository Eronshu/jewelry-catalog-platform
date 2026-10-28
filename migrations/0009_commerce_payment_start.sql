-- Internal fictional-local payment-start intent only. No provider dispatch,
-- payment outcome, transaction, inbox/outbox, universal seed or enablement.
-- Fixture setup must deliberately insert the matching singleton in its temporary DB.
CREATE TABLE commerce_payment_scope (
  id INTEGER PRIMARY KEY NOT NULL CHECK(id = 1),
  mode TEXT NOT NULL CHECK(mode = 'local-test'),
  instance_id TEXT NOT NULL CHECK(length(instance_id) = 36
    AND substr(instance_id,9,1) = '-' AND substr(instance_id,14,1) = '-'
    AND substr(instance_id,19,1) = '-' AND substr(instance_id,24,1) = '-'
    AND substr(instance_id,15,1) = '4' AND substr(instance_id,20,1) IN ('8','9','a','b')
    AND length(replace(instance_id,'-','')) = 32
    AND replace(instance_id,'-','') NOT GLOB '*[^a-f0-9]*'),
  stripe_account_ref TEXT NOT NULL CHECK(length(stripe_account_ref) BETWEEN 9 AND 100
    AND substr(stripe_account_ref,1,8) = 'fixture-' AND stripe_account_ref NOT GLOB '*[^a-zA-Z0-9_-]*'),
  paypal_account_ref TEXT NOT NULL CHECK(length(paypal_account_ref) BETWEEN 9 AND 100
    AND substr(paypal_account_ref,1,8) = 'fixture-' AND paypal_account_ref NOT GLOB '*[^a-zA-Z0-9_-]*')
);
CREATE TRIGGER commerce_payment_scope_no_update BEFORE UPDATE ON commerce_payment_scope
BEGIN SELECT RAISE(ABORT, 'commerce_payment_scope_immutable'); END;
CREATE TRIGGER commerce_payment_scope_no_delete BEFORE DELETE ON commerce_payment_scope
BEGIN SELECT RAISE(ABORT, 'commerce_payment_scope_immutable'); END;
CREATE TRIGGER commerce_payment_scope_no_replace BEFORE INSERT ON commerce_payment_scope
WHEN EXISTS (SELECT 1 FROM commerce_payment_scope WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'commerce_payment_scope_exists'); END;

CREATE TABLE commerce_payment_attempts (
  command_id TEXT PRIMARY KEY NOT NULL REFERENCES commerce_commands(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL UNIQUE CHECK(command_id = 'payment-start-' || request_id
    AND length(request_id) = 36 AND substr(request_id,9,1) = '-'
    AND substr(request_id,14,1) = '-' AND substr(request_id,19,1) = '-'
    AND substr(request_id,24,1) = '-' AND substr(request_id,15,1) = '4'
    AND substr(request_id,20,1) IN ('8','9','a','b')
    AND length(replace(request_id,'-','')) = 32
    AND replace(request_id,'-','') NOT GLOB '*[^a-f0-9]*'),
  order_id TEXT NOT NULL REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  quote_id TEXT NOT NULL REFERENCES commerce_quotes(id) ON DELETE RESTRICT,
  owner_hash TEXT NOT NULL CHECK(length(owner_hash) = 64 AND owner_hash NOT GLOB '*[^a-f0-9]*'),
  mode TEXT NOT NULL CHECK(mode = 'local-test'),
  instance_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('stripe','paypal')),
  account_ref TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents) = 'integer' AND amount_cents BETWEEN 1 AND 9007199254740991),
  currency TEXT NOT NULL CHECK(currency = 'CAD'),
  rules_version TEXT NOT NULL CHECK(rules_version = 'local-test-v1'),
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash) = 64 AND snapshot_hash NOT GLOB '*[^a-f0-9]*'),
  expected_version INTEGER NOT NULL CHECK(typeof(expected_version) = 'integer' AND expected_version BETWEEN 1 AND 9007199254740990),
  occurred_at INTEGER NOT NULL CHECK(typeof(occurred_at) = 'integer' AND occurred_at BETWEEN 0 AND 8640000000000000),
  -- This key identifies only a future create operation, never capture or refund.
  create_operation_key TEXT NOT NULL UNIQUE CHECK(length(create_operation_key) = 36
    AND substr(create_operation_key,9,1) = '-' AND substr(create_operation_key,14,1) = '-'
    AND substr(create_operation_key,19,1) = '-' AND substr(create_operation_key,24,1) = '-'
    AND substr(create_operation_key,15,1) = '4' AND substr(create_operation_key,20,1) IN ('8','9','a','b')
    AND length(replace(create_operation_key,'-','')) = 32
    AND replace(create_operation_key,'-','') NOT GLOB '*[^a-f0-9]*')
);
-- Conservative one-intent rule for this slice with no outcome/retry model.
-- A future reviewed migration may replace this index while retaining history.
CREATE UNIQUE INDEX commerce_payment_attempts_one_per_order ON commerce_payment_attempts(order_id);
CREATE TRIGGER commerce_payment_attempts_no_update BEFORE UPDATE ON commerce_payment_attempts
BEGIN SELECT RAISE(ABORT, 'commerce_payment_attempt_immutable'); END;
CREATE TRIGGER commerce_payment_attempts_no_delete BEFORE DELETE ON commerce_payment_attempts
BEGIN SELECT RAISE(ABORT, 'commerce_payment_attempt_immutable'); END;
CREATE TRIGGER commerce_payment_attempts_no_replace BEFORE INSERT ON commerce_payment_attempts
WHEN EXISTS (SELECT 1 FROM commerce_payment_attempts WHERE command_id = NEW.command_id
 OR request_id = NEW.request_id OR order_id = NEW.order_id OR create_operation_key = NEW.create_operation_key)
BEGIN SELECT RAISE(ABORT, 'commerce_payment_attempt_exists'); END;

-- json_type checks reject missing/null/coerced values. Eligibility and exact
-- quote/line/original-reservation correspondence are rechecked in the D1 batch.
CREATE TRIGGER commerce_payment_start_guard BEFORE INSERT ON commerce_payment_attempts
WHEN NOT EXISTS (
 SELECT 1 FROM commerce_orders o
 JOIN commerce_quotes q ON q.id = o.quote_id
 JOIN commerce_commands c ON c.id = NEW.command_id
 JOIN commerce_payment_scope s ON s.id = 1
 WHERE o.id = NEW.order_id AND o.quote_id = NEW.quote_id AND o.owner_hash = NEW.owner_hash
   AND q.owner_hash = o.owner_hash AND q.snapshot = o.snapshot
   AND s.mode = NEW.mode AND s.instance_id = NEW.instance_id
   AND NEW.account_ref = CASE NEW.provider WHEN 'stripe' THEN s.stripe_account_ref ELSE s.paypal_account_ref END
   AND c.created_at = NEW.occurred_at
   AND length(c.request_hash) = 64 AND c.request_hash NOT GLOB '*[^a-f0-9]*'
   AND o.version = NEW.expected_version AND o.state = 'pending_payment'
   AND o.payment_state = 'not_started' AND o.fulfillment = 'none'
   AND o.created_at <= NEW.occurred_at AND q.created_at <= NEW.occurred_at
   AND o.reserve_until > NEW.occurred_at AND q.expires_at > NEW.occurred_at
   AND q.expires_at <= 8640000000000000 AND o.reserve_until <= 8640000000000000
)
BEGIN SELECT RAISE(ABORT, 'commerce_payment_start_conflict'); END;

-- Separate guards keep each expression within D1's expression-depth limit.
CREATE TRIGGER commerce_payment_start_quote_guard BEFORE INSERT ON commerce_payment_attempts
WHEN NOT EXISTS (
 SELECT 1 FROM commerce_orders o JOIN commerce_quotes q ON q.id = o.quote_id
 WHERE o.id = NEW.order_id
   AND json_type(o.snapshot) = 'object'
   AND json_type(o.snapshot,'$.testOnly') = 'true'
   AND json_type(o.snapshot,'$.currency') = 'text' AND json_extract(o.snapshot,'$.currency') = NEW.currency
   AND json_type(o.snapshot,'$.rulesVersion') = 'text' AND json_extract(o.snapshot,'$.rulesVersion') = NEW.rules_version
   AND json_type(o.snapshot,'$.expiresAt') = 'integer' AND json_extract(o.snapshot,'$.expiresAt') = q.expires_at
   AND json_type(o.snapshot,'$.lines') = 'array' AND json_array_length(o.snapshot,'$.lines') BETWEEN 1 AND 20
   AND json_type(o.snapshot,'$.subtotalCents') = 'integer' AND json_extract(o.snapshot,'$.subtotalCents') BETWEEN 0 AND 9007199254740991
   AND json_type(o.snapshot,'$.shippingCents') = 'integer'
   AND json_type(o.snapshot,'$.taxCents') = 'integer' AND json_extract(o.snapshot,'$.taxCents') = 0
   AND json_type(o.snapshot,'$.totalCents') = 'integer' AND json_extract(o.snapshot,'$.totalCents') = NEW.amount_cents
   AND json_type(o.snapshot,'$.delivery') = 'text'
   AND json_extract(o.snapshot,'$.shippingCents') = CASE json_extract(o.snapshot,'$.delivery') WHEN 'pickup' THEN 0 WHEN 'local_delivery' THEN 500 WHEN 'shipping' THEN 1500 ELSE -1 END
   AND NEW.amount_cents = json_extract(o.snapshot,'$.subtotalCents') + json_extract(o.snapshot,'$.shippingCents') + json_extract(o.snapshot,'$.taxCents')
)
BEGIN SELECT RAISE(ABORT, 'commerce_payment_start_quote_conflict'); END;
CREATE TRIGGER commerce_payment_start_lines_guard BEFORE INSERT ON commerce_payment_attempts
WHEN NOT EXISTS (
 SELECT 1 FROM commerce_orders o WHERE o.id = NEW.order_id
   AND (SELECT count(*) FROM commerce_order_lines WHERE order_id = o.id) = json_array_length(o.snapshot,'$.lines')
   AND (SELECT count(*) FROM commerce_stock_movements WHERE command_id = o.reserve_command_id) = json_array_length(o.snapshot,'$.lines')
   AND (SELECT count(*) FROM json_each(o.snapshot,'$.lines') j
     JOIN commerce_order_lines l ON l.order_id = o.id AND l.position = j.key
     JOIN commerce_stock_movements m ON m.command_id = o.reserve_command_id AND m.position = l.position
     WHERE j.type = 'object'
       AND json_type(j.value,'$.variantId') = 'text' AND json_extract(j.value,'$.variantId') = l.variant_id
       AND json_type(j.value,'$.quantity') = 'integer' AND json_extract(j.value,'$.quantity') = l.quantity
       AND json_type(j.value,'$.unitPriceCents') = 'integer' AND json_extract(j.value,'$.unitPriceCents') = l.unit_price_cents AND l.unit_price_cents BETWEEN 0 AND 9007199254740991
       AND json_type(j.value,'$.version') = 'integer' AND json_extract(j.value,'$.version') = l.variant_version AND l.variant_version <= 9007199254740991
       AND json_type(j.value,'$.lineTotalCents') = 'integer' AND json_extract(j.value,'$.lineTotalCents') BETWEEN 0 AND 9007199254740991
       AND json_extract(j.value,'$.lineTotalCents') = l.quantity * l.unit_price_cents
       AND json_type(j.value,'$.sku') = 'text' AND length(trim(json_extract(j.value,'$.sku'))) > 0
       AND json_type(j.value,'$.name') = 'text' AND length(trim(json_extract(j.value,'$.name'))) > 0
       AND json_type(j.value,'$.colour') = 'text' AND length(trim(json_extract(j.value,'$.colour'))) > 0
       AND json_type(j.value,'$.sizeDescription') = 'text' AND length(trim(json_extract(j.value,'$.sizeDescription'))) > 0
       AND m.variant_id = l.variant_id AND m.kind = 'reserve' AND m.quantity = l.quantity AND m.expected_variant_version = l.variant_version
   ) = json_array_length(o.snapshot,'$.lines')
   AND (SELECT sum(l.quantity * l.unit_price_cents) FROM commerce_order_lines l WHERE l.order_id = o.id) = json_extract(o.snapshot,'$.subtotalCents')
)
BEGIN SELECT RAISE(ABORT, 'commerce_payment_start_lines_conflict'); END;
CREATE TRIGGER commerce_payment_start_lock AFTER INSERT ON commerce_payment_attempts BEGIN
 UPDATE commerce_orders SET payment_state = 'processing', version = version + 1 WHERE id = NEW.order_id;
END;

-- Preserve existing mutable fixture orders, then freeze their commercial identity
-- once an intent exists. State may evolve, but blind release can never be reset.
CREATE TRIGGER commerce_payment_order_commercial_guard BEFORE UPDATE ON commerce_orders
WHEN EXISTS (SELECT 1 FROM commerce_payment_attempts WHERE order_id = OLD.id)
 AND (NEW.id IS NOT OLD.id OR NEW.quote_id IS NOT OLD.quote_id OR NEW.owner_hash IS NOT OLD.owner_hash
 OR NEW.reserve_command_id IS NOT OLD.reserve_command_id OR NEW.snapshot IS NOT OLD.snapshot
 OR NEW.created_at IS NOT OLD.created_at OR NEW.reserve_until IS NOT OLD.reserve_until
 OR NEW.payment_state = 'not_started')
BEGIN SELECT RAISE(ABORT, 'commerce_payment_order_immutable'); END;
CREATE TRIGGER commerce_payment_order_no_delete BEFORE DELETE ON commerce_orders
WHEN EXISTS (SELECT 1 FROM commerce_payment_attempts WHERE order_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'commerce_payment_order_immutable'); END;
CREATE TRIGGER commerce_payment_order_no_replace BEFORE INSERT ON commerce_orders
WHEN EXISTS (SELECT 1 FROM commerce_payment_attempts WHERE order_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'commerce_payment_order_immutable'); END;

-- Explicit durable-intent exclusion supplements payment_state, including for
-- legacy cancellation/expiry and the recovery trigger that invokes this path.
DROP TRIGGER commerce_transition_guard;
CREATE TRIGGER commerce_transition_guard BEFORE INSERT ON commerce_order_transitions
WHEN NOT EXISTS (SELECT 1 FROM commerce_orders o WHERE o.id = NEW.order_id
 AND o.version = NEW.expected_version AND o.state = 'pending_payment' AND o.payment_state = 'not_started'
 AND NOT EXISTS (SELECT 1 FROM commerce_payment_attempts a WHERE a.order_id = o.id)
 AND (NEW.kind = 'cancel' OR (o.reserve_until <= NEW.occurred_at AND o.fulfillment = 'none')))
BEGIN SELECT RAISE(ABORT, 'commerce_order_transition_conflict'); END;
