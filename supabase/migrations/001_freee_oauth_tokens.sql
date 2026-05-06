CREATE TABLE freee_oauth_tokens (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE freee_oauth_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON freee_oauth_tokens FROM anon, authenticated;

CREATE OR REPLACE FUNCTION freee_oauth_tokens_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_freee_oauth_tokens_updated_at
BEFORE UPDATE ON freee_oauth_tokens
FOR EACH ROW EXECUTE FUNCTION freee_oauth_tokens_set_updated_at();

COMMENT ON TABLE freee_oauth_tokens IS 'freee OAuth トークン永続化（singleton, Service Role only）';
