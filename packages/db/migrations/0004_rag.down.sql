BEGIN;
DROP TABLE chunks;
DROP TABLE rag_embedding_profiles;
DROP TABLE rag_corpora;
DROP FUNCTION rag_reject_mutation();
-- Keel migration 0004 owns the extension in a fresh migrated database.
DROP EXTENSION vector;
COMMIT;
