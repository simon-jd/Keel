BEGIN;

CREATE TYPE action_status AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN');

CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  budget_json jsonb NOT NULL
);

CREATE TABLE steps (
  run_id uuid NOT NULL REFERENCES runs(id),
  seq integer NOT NULL,
  kind text NOT NULL,
  payload_json jsonb NOT NULL,
  status text NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE actions (
  action_key text PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  tool text NOT NULL,
  args_hash text NOT NULL,
  status action_status NOT NULL DEFAULT 'PENDING',
  result_json jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
