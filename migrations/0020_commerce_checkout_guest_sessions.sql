-- Internal trusted-machine synthetic fixture sessions only. No HTTP activation.
-- Hash-only bearer storage; instance/origin scope is not DB-binding attestation.
CREATE TABLE commerce_checkout_guest_sessions (
 token_hash TEXT PRIMARY KEY NOT NULL CHECK(typeof(token_hash)='text' AND length(token_hash)=64 AND token_hash NOT GLOB '*[^a-f0-9]*'),
 mode TEXT NOT NULL CHECK(mode='local-test'),
 instance_id TEXT NOT NULL CHECK(typeof(instance_id)='text' AND length(instance_id)=36 AND substr(instance_id,9,1)='-' AND substr(instance_id,14,1)='-' AND substr(instance_id,19,1)='-' AND substr(instance_id,24,1)='-' AND substr(instance_id,15,1)='4' AND substr(instance_id,20,1) IN ('8','9','a','b') AND length(replace(instance_id,'-',''))=32 AND replace(instance_id,'-','') NOT GLOB '*[^a-f0-9]*'),
 canonical_origin TEXT NOT NULL CHECK(typeof(canonical_origin)='text' AND (
  canonical_origin IN ('http://localhost','http://127.0.0.1') OR
  (canonical_origin='http://localhost:'||CAST(CAST(substr(canonical_origin,18) AS INTEGER) AS TEXT)
   AND CAST(substr(canonical_origin,18) AS INTEGER) BETWEEN 1 AND 65535 AND CAST(substr(canonical_origin,18) AS INTEGER)<>80)
  OR (canonical_origin='http://127.0.0.1:'||CAST(CAST(substr(canonical_origin,18) AS INTEGER) AS TEXT)
   AND CAST(substr(canonical_origin,18) AS INTEGER) BETWEEN 1 AND 65535 AND CAST(substr(canonical_origin,18) AS INTEGER)<>80)
 )),
 owner_hash TEXT NOT NULL UNIQUE CHECK(typeof(owner_hash)='text' AND length(owner_hash)=64 AND owner_hash NOT GLOB '*[^a-f0-9]*'),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 8639999913600000),
 expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at=created_at+86400000),
 revoked_at INTEGER CHECK(revoked_at IS NULL OR (typeof(revoked_at)='integer' AND revoked_at>=created_at AND revoked_at<expires_at))
);
CREATE TRIGGER commerce_checkout_session_new BEFORE INSERT ON commerce_checkout_guest_sessions
WHEN NEW.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'commerce_checkout_session_invalid_initial_state'); END;
CREATE TRIGGER commerce_checkout_session_no_replace BEFORE INSERT ON commerce_checkout_guest_sessions
WHEN EXISTS (SELECT 1 FROM commerce_checkout_guest_sessions WHERE token_hash=NEW.token_hash OR owner_hash=NEW.owner_hash)
BEGIN SELECT RAISE(ABORT,'commerce_checkout_session_exists'); END;
CREATE TRIGGER commerce_checkout_session_update BEFORE UPDATE ON commerce_checkout_guest_sessions
WHEN OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
 OR NEW.token_hash IS NOT OLD.token_hash OR NEW.mode IS NOT OLD.mode OR NEW.instance_id IS NOT OLD.instance_id
 OR NEW.canonical_origin IS NOT OLD.canonical_origin OR NEW.owner_hash IS NOT OLD.owner_hash
 OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT,'commerce_checkout_session_identity_immutable'); END;
CREATE TRIGGER commerce_checkout_session_no_delete BEFORE DELETE ON commerce_checkout_guest_sessions
BEGIN SELECT RAISE(ABORT,'commerce_checkout_session_immutable'); END;
