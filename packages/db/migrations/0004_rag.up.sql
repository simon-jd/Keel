BEGIN;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE rag_corpora (version text PRIMARY KEY, lock jsonb NOT NULL);
CREATE TABLE rag_embedding_profiles (
  id text PRIMARY KEY, dimension integer NOT NULL CHECK (dimension BETWEEN 1 AND 16000),
  profile jsonb NOT NULL, UNIQUE(id,dimension)
);
-- N is enforced per immutable profile. Actual model N is not selected by this migration.
CREATE TABLE chunks (
  id text NOT NULL, doc_id text NOT NULL, version text NOT NULL REFERENCES rag_corpora(version),
  profile_id text NOT NULL, dimension integer NOT NULL,
  text text NOT NULL CHECK (length(text)>0), content_hash text NOT NULL,
  provenance jsonb NOT NULL, embedding vector NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig,text)) STORED,
  PRIMARY KEY(version,profile_id,id),
  FOREIGN KEY(profile_id,dimension) REFERENCES rag_embedding_profiles(id,dimension),
  CHECK(vector_dims(embedding)=dimension), CHECK(vector_norm(embedding)>0)
);
CREATE FUNCTION rag_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'RAG_IMMUTABLE' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER rag_corpora_immutable BEFORE UPDATE OR DELETE ON rag_corpora FOR EACH ROW EXECUTE FUNCTION rag_reject_mutation();
CREATE TRIGGER rag_profiles_immutable BEFORE UPDATE OR DELETE ON rag_embedding_profiles FOR EACH ROW EXECUTE FUNCTION rag_reject_mutation();
CREATE TRIGGER rag_chunks_immutable BEFORE UPDATE OR DELETE ON chunks FOR EACH ROW EXECUTE FUNCTION rag_reject_mutation();
CREATE INDEX chunks_tsv_idx ON chunks USING gin(tsv);
COMMIT;
