# Frozen Kubernetes concepts subset

Sources: The Kubernetes Authors, CC BY 4.0. See `source/LICENSE`, `source/README.md`, and the exact upstream URLs/blob hashes in `source-manifest.json`.

Keel normalization modifies Markdown; the notice, omissions, settings and final 491 stable chunk IDs are bound by `corpus.lock` / `chunks.jsonl`. No external includes were resolved. Verify offline with `node_modules/.bin/tsx packages/rag/src/prepare.ts --check` from the repository root.

`qa.jsonl` contains the exact frozen 200 subagent-authored weak-reference questions, answers and gold chunk IDs (104,470 bytes; SHA256 `0d7c9ff7be567cab8181b3f2d471c25eed5c909262639a484c43af183f1ee01f`). `qa.audit.jsonl` and `qa.freeze.json` preserve the exact source audit, both authors, combined-input provenance and limitations. These are agent references, never human gold; no outcome-conditioned edits are allowed. Real embedding/retrieval/rerank metrics remain unrun. See `docs/evidence/rag-eval.md`.
