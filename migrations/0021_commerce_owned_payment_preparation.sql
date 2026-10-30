-- Rebuild the ONE canonical attempt table to admit the accepted owned checkout source.
-- D1 migrations are transactional. Defer FKs while replacing this parent in place;
-- do not rename it (which would retarget its many historical child references).
-- Existing external triggers/children remain; all dropped attempt hooks are restored.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE commerce_payment_attempts_backup_0021 AS SELECT * FROM commerce_payment_attempts;
DROP TABLE commerce_payment_attempts;
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
  rules_version TEXT NOT NULL CHECK(rules_version IN ('local-test-v1','fictional-checkout-acceptance-v1')),
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
-- Restore rows while all attempt INSERT hooks are absent: do not relock orders or recreate work.
INSERT INTO commerce_payment_attempts SELECT * FROM commerce_payment_attempts_backup_0021;
DROP TABLE commerce_payment_attempts_backup_0021;

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
   AND json_type(o.snapshot,'$.taxCents') = 'integer'
   AND ((NEW.rules_version='local-test-v1' AND json_extract(o.snapshot,'$.taxCents')=0
     AND json_type(o.snapshot,'$.contractVersion') IS NULL
     AND NOT EXISTS (SELECT 1 FROM commerce_checkout_order_origins WHERE order_id=o.id))
    OR (NEW.rules_version='fictional-checkout-acceptance-v1'
     AND json_extract(o.snapshot,'$.contractVersion')='local-checkout-v1'
     AND json_type(o.snapshot,'$.taxBasisPoints')='integer' AND json_extract(o.snapshot,'$.taxBasisPoints')=1000
     AND json_type(o.snapshot,'$.taxBaseCents')='integer'
     AND json_extract(o.snapshot,'$.taxBaseCents')=json_extract(o.snapshot,'$.subtotalCents')+json_extract(o.snapshot,'$.shippingCents')
     AND json_extract(o.snapshot,'$.taxCents')=(json_extract(o.snapshot,'$.taxBaseCents')*1000+5000)/10000))
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

CREATE TRIGGER commerce_payment_owned_source BEFORE INSERT ON commerce_payment_attempts
WHEN NEW.rules_version='fictional-checkout-acceptance-v1' AND NOT EXISTS (
 SELECT 1 FROM commerce_checkout_order_origins x
 JOIN commerce_checkout_acceptances a ON a.acceptance_id=x.acceptance_id
 JOIN commerce_checkout_quotes q ON q.quote_id=x.checkout_quote_id AND q.quote_id=a.quote_id
 JOIN commerce_quotes p ON p.id=x.promoted_quote_id
 JOIN commerce_orders o ON o.id=x.order_id
 WHERE NEW.provider='stripe' AND NEW.order_id=x.order_id AND NEW.quote_id=x.promoted_quote_id
 AND NEW.mode=x.mode AND NEW.instance_id=x.instance_id AND NEW.owner_hash=x.owner_hash
 AND a.mode=x.mode AND a.instance_id=x.instance_id AND a.owner_hash=x.owner_hash
 AND q.mode=x.mode AND q.instance_id=x.instance_id AND q.owner_hash=x.owner_hash
 AND o.owner_hash=x.owner_hash AND p.owner_hash=x.owner_hash
 AND o.quote_id=p.id AND o.reserve_command_id=x.command_id
 AND o.created_at=x.created_at AND p.created_at=x.created_at
 AND o.reserve_until=x.reserve_until AND p.expires_at=x.reserve_until AND q.expires_at=x.reserve_until
 AND q.created_at<=a.accepted_at AND a.accepted_at<=x.created_at
 AND x.created_at<=NEW.occurred_at AND NEW.occurred_at<q.expires_at
 AND q.rules_hash=x.rules_hash
 AND q.rules_json='{"testOnly":true,"version":"fictional-checkout-acceptance-v1","taxBasisPoints":1000,"rounding":"half-up-items-and-delivery","methods":{"pickup":0,"local_delivery":500,"shipping":1500}}'
 AND o.snapshot=json_remove(q.snapshot_json,'$.fixtureProfile') AND p.snapshot=o.snapshot
 AND json_extract(o.snapshot,'$.totalCents')=NEW.amount_cents
)
BEGIN SELECT RAISE(ABORT,'commerce_payment_owned_source'); END;

-- Recreate the attempt's dropped work hook, WITHOUT replaying the historical backfill.
CREATE TRIGGER commerce_payment_attempt_work AFTER INSERT ON commerce_payment_attempts BEGIN
 INSERT INTO commerce_payment_work(attempt_command_id) VALUES (NEW.command_id);
END;

-- New owned preparation is NOT authority for the older synthetic executor.
-- A future dispatcher must explicitly evolve this fence with transport/source review.
CREATE TRIGGER commerce_payment_owned_work_fence BEFORE INSERT ON commerce_payment_work_claims
WHEN EXISTS (SELECT 1 FROM commerce_payment_attempts a WHERE a.command_id=NEW.attempt_command_id
 AND (a.rules_version!='local-test-v1' OR EXISTS (SELECT 1 FROM commerce_checkout_order_origins x WHERE x.order_id=a.order_id)))
BEGIN SELECT RAISE(ABORT,'commerce_owned_payment_dispatch_closed'); END;

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
 AND NOT EXISTS (
 SELECT 1 FROM commerce_payment_attempts a JOIN commerce_checkout_order_origins x ON x.order_id=a.order_id
 JOIN commerce_commands c ON c.id=a.command_id
 WHERE a.order_id=OLD.id AND a.rules_version='fictional-checkout-acceptance-v1' AND a.provider='stripe'
 AND a.mode=x.mode AND a.instance_id=x.instance_id AND a.owner_hash=x.owner_hash
 AND OLD.owner_hash=x.owner_hash AND OLD.quote_id=x.promoted_quote_id AND OLD.reserve_command_id=x.command_id
 AND OLD.created_at=x.created_at AND OLD.reserve_until=x.reserve_until
 AND OLD.state='pending_payment' AND OLD.payment_state='not_started' AND OLD.fulfillment='none'
 AND OLD.version=a.expected_version AND a.quote_id=OLD.quote_id
 AND c.created_at=a.occurred_at AND OLD.created_at<=a.occurred_at AND a.occurred_at<OLD.reserve_until
 AND NEW.payment_state='processing' AND NEW.version=OLD.version+1
 AND NEW.id IS OLD.id AND NEW.quote_id IS OLD.quote_id AND NEW.owner_hash IS OLD.owner_hash
 AND NEW.reserve_command_id IS OLD.reserve_command_id AND NEW.snapshot IS OLD.snapshot
 AND NEW.created_at IS OLD.created_at AND NEW.reserve_until IS OLD.reserve_until
 AND NEW.state IS OLD.state AND NEW.fulfillment IS OLD.fulfillment
 )
BEGIN SELECT RAISE(ABORT,'commerce_checkout_order_immutable'); END;


PRAGMA defer_foreign_keys=OFF;
