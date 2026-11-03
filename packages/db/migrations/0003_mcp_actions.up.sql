BEGIN;
-- Independent resource-server journal: runtime actions and MCP dispatch cannot commit atomically.
CREATE TABLE mcp_actions (
  tenant_id text NOT NULL,
  action_key text NOT NULL,
  run_id uuid NOT NULL,
  tool text NOT NULL,
  args_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('UNKNOWN', 'SUCCEEDED')),
  payload bytea NOT NULL,
  result bytea,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, action_key)
);
COMMIT;
