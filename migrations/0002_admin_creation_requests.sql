ALTER TABLE products ADD COLUMN creation_request_key TEXT;
ALTER TABLE products ADD COLUMN creation_request_hash TEXT;

CREATE UNIQUE INDEX idx_products_creation_request_key
  ON products (creation_request_key)
  WHERE creation_request_key IS NOT NULL;

CREATE TRIGGER products_creation_request_pair_insert
BEFORE INSERT ON products
WHEN (NEW.creation_request_key IS NULL) <> (NEW.creation_request_hash IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'creation request pair required');
END;

CREATE TRIGGER products_creation_request_pair_update
BEFORE UPDATE OF creation_request_key, creation_request_hash ON products
WHEN (NEW.creation_request_key IS NULL) <> (NEW.creation_request_hash IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'creation request pair required');
END;
