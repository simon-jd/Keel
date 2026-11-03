BEGIN;
CREATE TABLE token_store (
  tenant_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('slack','github','google','salesforce')),
  identity text NOT NULL,
  binding text NOT NULL,
  enc_access bytea,
  enc_refresh bytea,
  expires_at timestamptz,
  scopes text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('active','reconsent','revoked')),
  PRIMARY KEY (tenant_id, provider),
  CHECK (status <> 'active' OR enc_access IS NOT NULL)
);
CREATE TABLE oauth_states (
  state_hash text PRIMARY KEY,
  tenant_id text NOT NULL,
  provider text NOT NULL,
  enc_payload bytea NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);
CREATE INDEX oauth_states_owner ON oauth_states(tenant_id,provider);
COMMIT;
