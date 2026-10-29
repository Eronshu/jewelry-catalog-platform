-- INERT local checkout receipts. No order, reservation, payment or policy activation.
-- Scope is a trusted row partition, NOT DB attestation or payment-account identity.
-- Request/rules hashes are application witnesses, not SQL-recomputed provenance.
CREATE TABLE commerce_checkout_quotes (
  quote_id TEXT PRIMARY KEY NOT NULL CHECK(typeof(quote_id)='text' AND length(quote_id)=36 AND substr(quote_id,9,1)='-' AND substr(quote_id,14,1)='-' AND substr(quote_id,19,1)='-' AND substr(quote_id,24,1)='-' AND substr(quote_id,15,1)='4' AND substr(quote_id,20,1) IN ('8','9','a','b') AND length(replace(quote_id,'-',''))=32 AND replace(quote_id,'-','') NOT GLOB '*[^a-f0-9]*'),
  mode TEXT NOT NULL CHECK(typeof(mode)='text' AND mode='local-test'),
  instance_id TEXT NOT NULL CHECK(typeof(instance_id)='text' AND length(instance_id)=36 AND substr(instance_id,9,1)='-' AND substr(instance_id,14,1)='-' AND substr(instance_id,19,1)='-' AND substr(instance_id,24,1)='-' AND substr(instance_id,15,1)='4' AND substr(instance_id,20,1) IN ('8','9','a','b') AND length(replace(instance_id,'-',''))=32 AND replace(instance_id,'-','') NOT GLOB '*[^a-f0-9]*'),
  owner_hash TEXT NOT NULL CHECK(typeof(owner_hash)='text' AND length(owner_hash)=64 AND owner_hash NOT GLOB '*[^a-f0-9]*'),
  issue_key TEXT NOT NULL CHECK(typeof(issue_key)='text' AND length(issue_key)=36 AND substr(issue_key,9,1)='-' AND substr(issue_key,14,1)='-' AND substr(issue_key,19,1)='-' AND substr(issue_key,24,1)='-' AND substr(issue_key,15,1)='4' AND substr(issue_key,20,1) IN ('8','9','a','b') AND length(replace(issue_key,'-',''))=32 AND replace(issue_key,'-','') NOT GLOB '*[^a-f0-9]*'),
  request_hash TEXT NOT NULL CHECK(typeof(request_hash)='text' AND length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  selection_json TEXT NOT NULL CHECK(typeof(selection_json)='text' AND json_valid(selection_json)),
  snapshot_json TEXT NOT NULL CHECK(typeof(snapshot_json)='text' AND json_valid(snapshot_json)),
  rules_json TEXT NOT NULL CHECK(typeof(rules_json)='text' AND json_valid(rules_json)),
  rules_hash TEXT NOT NULL CHECK(typeof(rules_hash)='text' AND length(rules_hash)=64 AND rules_hash NOT GLOB '*[^a-f0-9]*'),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 8639999999400000),
  expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at=created_at+600000),
  UNIQUE(mode,instance_id,owner_hash,issue_key),
  UNIQUE(quote_id,mode,instance_id,owner_hash),
  CHECK(json_type(selection_json) IS 'object'
    AND json_extract(selection_json,'$.contractVersion') IS 'local-checkout-v1'
    AND json_type(selection_json,'$.lines') IS 'array' AND json_array_length(selection_json,'$.lines') BETWEEN 1 AND 20
    AND json_type(selection_json,'$.fixtureProfileId') IS 'text' AND json_extract(selection_json,'$.fixtureProfileId') IN ('fixture-ontario','fixture-bc')
    AND json_type(selection_json,'$.deliveryMethod') IS 'text' AND json_extract(selection_json,'$.deliveryMethod') IN ('pickup','local_delivery','shipping')
    AND (json_extract(selection_json,'$.deliveryMethod')!='local_delivery' OR json_extract(selection_json,'$.fixtureProfileId')='fixture-ontario')),
  CHECK(json_type(snapshot_json) IS 'object' AND json_type(snapshot_json,'$.testOnly') IS 'true'
    AND json_extract(snapshot_json,'$.contractVersion') IS 'local-checkout-v1' AND json_extract(snapshot_json,'$.currency') IS 'CAD'
    AND json_type(snapshot_json,'$.expiresAt') IS 'integer' AND json_extract(snapshot_json,'$.expiresAt')=expires_at
    AND json_type(snapshot_json,'$.lines') IS 'array'
    AND json_array_length(snapshot_json,'$.lines')=json_array_length(selection_json,'$.lines')
    AND json_extract(snapshot_json,'$.delivery') IS json_extract(selection_json,'$.deliveryMethod')
    AND json_extract(snapshot_json,'$.fixtureProfile.id') IS json_extract(selection_json,'$.fixtureProfileId')
    AND json_type(snapshot_json,'$.fixtureProfile.name') IS 'text'
    AND json_type(snapshot_json,'$.fixtureProfile.email') IS 'text'
    AND ((json_extract(snapshot_json,'$.delivery')='pickup' AND json_type(snapshot_json,'$.fixtureProfile.address') IS 'null')
      OR (json_extract(snapshot_json,'$.delivery')!='pickup' AND json_type(snapshot_json,'$.fixtureProfile.address') IS 'object'))),
  CHECK(json_type(rules_json) IS 'object' AND json_type(rules_json,'$.testOnly') IS 'true'
    AND json_type(rules_json,'$.version') IS 'text' AND length(json_extract(rules_json,'$.version')) BETWEEN 1 AND 100
    AND json_extract(snapshot_json,'$.rulesVersion') IS json_extract(rules_json,'$.version')
    AND json_type(rules_json,'$.taxBasisPoints') IS 'integer' AND json_extract(rules_json,'$.taxBasisPoints') BETWEEN 0 AND 10000
    AND json_extract(snapshot_json,'$.taxBasisPoints') IS json_extract(rules_json,'$.taxBasisPoints')
    AND json_type(rules_json,'$.methods.pickup') IS 'integer' AND json_extract(rules_json,'$.methods.pickup') BETWEEN 0 AND 1000000
    AND json_type(rules_json,'$.methods.local_delivery') IS 'integer' AND json_extract(rules_json,'$.methods.local_delivery') BETWEEN 0 AND 1000000
    AND json_type(rules_json,'$.methods.shipping') IS 'integer' AND json_extract(rules_json,'$.methods.shipping') BETWEEN 0 AND 1000000
    AND json_extract(snapshot_json,'$.shippingCents') IS json_extract(rules_json,'$.methods.'||json_extract(snapshot_json,'$.delivery'))),
  -- These bounds keep the half-up multiplication in SQLite's integer domain.
  CHECK(json_type(snapshot_json,'$.subtotalCents') IS 'integer' AND json_extract(snapshot_json,'$.subtotalCents') BETWEEN 0 AND 4000000000
    AND json_type(snapshot_json,'$.shippingCents') IS 'integer' AND json_extract(snapshot_json,'$.shippingCents') BETWEEN 0 AND 1000000
    AND json_type(snapshot_json,'$.taxBasisPoints') IS 'integer' AND json_extract(snapshot_json,'$.taxBasisPoints') BETWEEN 0 AND 10000
    AND json_type(snapshot_json,'$.taxBaseCents') IS 'integer' AND json_extract(snapshot_json,'$.taxBaseCents')=json_extract(snapshot_json,'$.subtotalCents')+json_extract(snapshot_json,'$.shippingCents')
    AND json_type(snapshot_json,'$.taxCents') IS 'integer' AND json_extract(snapshot_json,'$.taxCents')=(json_extract(snapshot_json,'$.taxBaseCents')*json_extract(snapshot_json,'$.taxBasisPoints')+5000)/10000
    AND json_type(snapshot_json,'$.totalCents') IS 'integer' AND json_extract(snapshot_json,'$.totalCents')=json_extract(snapshot_json,'$.taxBaseCents')+json_extract(snapshot_json,'$.taxCents'))
);
CREATE TRIGGER commerce_checkout_quote_lines BEFORE INSERT ON commerce_checkout_quotes
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.snapshot_json,'$.lines') l
  WHERE json_type(l.value) IS NOT 'object'
    OR json_type(l.value,'$.variantId') IS NOT 'text'
    OR json_type(l.value,'$.quantity') IS NOT 'integer' OR json_extract(l.value,'$.quantity') NOT BETWEEN 1 AND 20
    OR json_type(l.value,'$.version') IS NOT 'integer' OR json_extract(l.value,'$.version') NOT BETWEEN 1 AND 9007199254740991
    OR json_type(l.value,'$.unitPriceCents') IS NOT 'integer' OR json_extract(l.value,'$.unitPriceCents') NOT BETWEEN 0 AND 10000000
    OR json_type(l.value,'$.lineTotalCents') IS NOT 'integer'
    OR json_extract(l.value,'$.lineTotalCents') IS NOT json_extract(l.value,'$.quantity')*json_extract(l.value,'$.unitPriceCents')
    OR json_type(NEW.selection_json,'$.lines['||l.key||'].quantity') IS NOT 'integer'
    OR json_extract(l.value,'$.quantity') IS NOT json_extract(NEW.selection_json,'$.lines['||l.key||'].quantity')
    OR json_extract(l.value,'$.variantId') IS NOT json_extract(NEW.selection_json,'$.lines['||l.key||'].variantId')
) OR (SELECT COUNT(DISTINCT json_extract(value,'$.variantId')) FROM json_each(NEW.snapshot_json,'$.lines')) != json_array_length(NEW.snapshot_json,'$.lines')
 OR (SELECT SUM(json_extract(value,'$.lineTotalCents')) FROM json_each(NEW.snapshot_json,'$.lines')) IS NOT json_extract(NEW.snapshot_json,'$.subtotalCents')
BEGIN SELECT RAISE(ABORT,'commerce_checkout_quote_invalid_lines'); END;

CREATE TRIGGER commerce_checkout_quote_current BEFORE INSERT ON commerce_checkout_quotes
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.snapshot_json,'$.lines') l
  LEFT JOIN commerce_variants v ON v.id=json_extract(l.value,'$.variantId')
  LEFT JOIN products p ON p.id=v.product_id
  LEFT JOIN commerce_inventory i ON i.variant_id=v.id
  WHERE v.id IS NULL OR i.variant_id IS NULL OR p.status IS NOT 'available' OR v.active IS NOT 1
    OR v.version IS NOT json_extract(l.value,'$.version') OR v.price_cents IS NOT json_extract(l.value,'$.unitPriceCents')
    OR v.sku COLLATE BINARY IS NOT json_extract(l.value,'$.sku') OR p.name IS NOT json_extract(l.value,'$.name')
    OR v.colour IS NOT json_extract(l.value,'$.colour') OR v.size_description IS NOT json_extract(l.value,'$.sizeDescription')
    OR i.on_hand-i.facebook_reserved-i.checkout_reserved-i.allocated < json_extract(l.value,'$.quantity')
)
BEGIN SELECT RAISE(ABORT,'commerce_checkout_quote_stale'); END;
CREATE TABLE commerce_checkout_acceptances (
  acceptance_id TEXT PRIMARY KEY NOT NULL CHECK(typeof(acceptance_id)='text' AND length(acceptance_id)=36 AND substr(acceptance_id,9,1)='-' AND substr(acceptance_id,14,1)='-' AND substr(acceptance_id,19,1)='-' AND substr(acceptance_id,24,1)='-' AND substr(acceptance_id,15,1)='4' AND substr(acceptance_id,20,1) IN ('8','9','a','b') AND length(replace(acceptance_id,'-',''))=32 AND replace(acceptance_id,'-','') NOT GLOB '*[^a-f0-9]*'),
  mode TEXT NOT NULL CHECK(typeof(mode)='text' AND mode='local-test'),
  instance_id TEXT NOT NULL CHECK(typeof(instance_id)='text' AND length(instance_id)=36 AND substr(instance_id,9,1)='-' AND substr(instance_id,14,1)='-' AND substr(instance_id,19,1)='-' AND substr(instance_id,24,1)='-' AND substr(instance_id,15,1)='4' AND substr(instance_id,20,1) IN ('8','9','a','b') AND length(replace(instance_id,'-',''))=32 AND replace(instance_id,'-','') NOT GLOB '*[^a-f0-9]*'),
  owner_hash TEXT NOT NULL CHECK(typeof(owner_hash)='text' AND length(owner_hash)=64 AND owner_hash NOT GLOB '*[^a-f0-9]*'),
  acceptance_key TEXT NOT NULL CHECK(typeof(acceptance_key)='text' AND length(acceptance_key)=36 AND substr(acceptance_key,9,1)='-' AND substr(acceptance_key,14,1)='-' AND substr(acceptance_key,19,1)='-' AND substr(acceptance_key,24,1)='-' AND substr(acceptance_key,15,1)='4' AND substr(acceptance_key,20,1) IN ('8','9','a','b') AND length(replace(acceptance_key,'-',''))=32 AND replace(acceptance_key,'-','') NOT GLOB '*[^a-f0-9]*'),
  quote_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(typeof(request_hash)='text' AND length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  accepted_at INTEGER NOT NULL CHECK(typeof(accepted_at)='integer' AND accepted_at BETWEEN 0 AND 8640000000000000),
  UNIQUE(mode,instance_id,owner_hash,acceptance_key),
  UNIQUE(quote_id),
  FOREIGN KEY(quote_id,mode,instance_id,owner_hash) REFERENCES commerce_checkout_quotes(quote_id,mode,instance_id,owner_hash) ON DELETE RESTRICT
);
-- Recheck at the INSERT boundary, not just an earlier JS SELECT. This is not a reservation.
CREATE TRIGGER commerce_checkout_acceptance_current BEFORE INSERT ON commerce_checkout_acceptances
WHEN NOT EXISTS (SELECT 1 FROM commerce_checkout_quotes q WHERE q.quote_id=NEW.quote_id
  AND q.mode=NEW.mode AND q.instance_id=NEW.instance_id AND q.owner_hash=NEW.owner_hash
  AND q.created_at<=NEW.accepted_at AND NEW.accepted_at<q.expires_at)
 OR EXISTS (SELECT 1 FROM commerce_checkout_quotes q WHERE q.quote_id=NEW.quote_id AND EXISTS (
  SELECT 1 FROM json_each(q.snapshot_json,'$.lines') l
  LEFT JOIN commerce_variants v ON v.id=json_extract(l.value,'$.variantId')
  LEFT JOIN products p ON p.id=v.product_id
  LEFT JOIN commerce_inventory i ON i.variant_id=v.id
  WHERE v.id IS NULL OR i.variant_id IS NULL OR p.status IS NOT 'available' OR v.active IS NOT 1
    OR v.version IS NOT json_extract(l.value,'$.version') OR v.price_cents IS NOT json_extract(l.value,'$.unitPriceCents')
    OR v.sku COLLATE BINARY IS NOT json_extract(l.value,'$.sku') OR p.name IS NOT json_extract(l.value,'$.name')
    OR v.colour IS NOT json_extract(l.value,'$.colour') OR v.size_description IS NOT json_extract(l.value,'$.sizeDescription')
    OR i.on_hand-i.facebook_reserved-i.checkout_reserved-i.allocated < json_extract(l.value,'$.quantity')
))
BEGIN SELECT RAISE(ABORT,'commerce_checkout_acceptance_stale'); END;

CREATE TRIGGER commerce_checkout_quotes_no_update BEFORE UPDATE ON commerce_checkout_quotes
BEGIN SELECT RAISE(ABORT,'commerce_checkout_immutable'); END;
CREATE TRIGGER commerce_checkout_quotes_no_delete BEFORE DELETE ON commerce_checkout_quotes
BEGIN SELECT RAISE(ABORT,'commerce_checkout_immutable'); END;
CREATE TRIGGER commerce_checkout_quotes_no_replace BEFORE INSERT ON commerce_checkout_quotes
WHEN EXISTS (SELECT 1 FROM commerce_checkout_quotes WHERE quote_id=NEW.quote_id
  OR (mode=NEW.mode AND instance_id=NEW.instance_id AND owner_hash=NEW.owner_hash AND issue_key=NEW.issue_key))
BEGIN SELECT RAISE(ABORT,'commerce_checkout_exists'); END;

CREATE TRIGGER commerce_checkout_acceptances_no_update BEFORE UPDATE ON commerce_checkout_acceptances
BEGIN SELECT RAISE(ABORT,'commerce_checkout_immutable'); END;
CREATE TRIGGER commerce_checkout_acceptances_no_delete BEFORE DELETE ON commerce_checkout_acceptances
BEGIN SELECT RAISE(ABORT,'commerce_checkout_immutable'); END;
CREATE TRIGGER commerce_checkout_acceptances_no_replace BEFORE INSERT ON commerce_checkout_acceptances
WHEN EXISTS (SELECT 1 FROM commerce_checkout_acceptances WHERE acceptance_id=NEW.acceptance_id
  OR (mode=NEW.mode AND instance_id=NEW.instance_id AND owner_hash=NEW.owner_hash AND acceptance_key=NEW.acceptance_key) OR quote_id=NEW.quote_id)
BEGIN SELECT RAISE(ABORT,'commerce_checkout_exists'); END;
