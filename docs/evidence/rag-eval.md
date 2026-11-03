# RAG pipeline and staged actual evaluation

## Phase 7 plan: grounding-judge validation and faithfulness on the current retrieval (written 2026-10-31, before any run below)

1. **Validation set**: RAGTruth QA test split, human hallucination spans, 320 items (160 fail / 160 pass),
   frozen in `data/labels/ragtruth-qa-20261031/` (source, commit, license and protocol in its README).
   Judges: the item-1 (Task 9 phase 7) judge and the current one (Qwen2.5-14B-Instruct-AWQ, v1), both on the
   unchanged rubric `kubernetes-grounding-binary-v1`. Metrics as in Task 9 phase 7 (`scripts/judge_compare.py`):
   κ with bootstrap interval, agreement, fail precision / recall with Wilson intervals, invalid scored as wrong.
2. **Which judge scores Kubernetes**: the item-1 judge, unless the current judge's RAGTruth κ is higher by
   0.05 or more, in which case the current one. No threshold makes the judge "valid"; its RAGTruth numbers are
   reported next to every faithfulness number.
3. **Answers**: 200 Kubernetes questions (written by a sub-agent, not by a person), Qwen3-8B-AWQ, the same
   answer prompt `keel-rag-answer-v1`, temperature 0, max 512 tokens. Contexts from the stored phase 6 retrieval
   run of the current pipeline (`.tools/rag-beir/runs/kubernetes.json.gz`; not recomputed): *before* = hybrid
   (BM25 + bge-base-en-v1.5, RRF k = 60) top-10, *after* = top-20 LLM rerank (`rag-relevance-v1`, Qwen3-8B-AWQ) top-10.
4. **Faithfulness** = judged pass / 200; failed answers and invalid verdicts stay in the denominator (as before).
   The same judge also re-scores the stored 2026-10-27 answers (old retrieval), so old and new retrieval are
   compared under one judge, next to the old 57.5% / 65.0% (Qwen2.5-14B v1). Paired before/after counts and a
   two-sided sign test on the discordant pairs, as before.

## Phase 7 results (2026-10-31)

**Grounding-judge validation on RAGTruth** (320 items, human labels; invalid verdicts counted as wrong;
κ with bootstrap 95%, others Wilson 95%). Rubric `kubernetes-grounding-binary-v1`, unchanged.

| Judge | Invalid | κ | Agreement | Fail precision | Fail recall |
|---|---:|---|---|---|---|
| Qwen3-14B-AWQ thinking, v3 (Task 9 phase 7 judge) | 0 | **0.406** (0.310–0.502) | 225/320 (65.1–75.1%) | 84/103 (73.0–87.9%) | 84/160 (44.8–60.1%) |
| Qwen2.5-14B-Instruct-AWQ v1 (earlier judge) | 2 | 0.163 (0.064–0.264) | 186/320 (52.7–63.4%) | 63/100 (53.2–71.8%) | 63/160 (32.1–47.1%) |

So the new judge scores Kubernetes (the plan's rule). It is clearly better than the earlier one, but still
**lenient**: it passes 76 of the 160 answers that RAGTruth's annotators marked as containing unsupported
content, and it fails 19 of 160 clean ones. Faithfulness numbers below are therefore upper-leaning.

**Kubernetes faithfulness** (200 questions **written by a sub-agent, not by a person**; Qwen3-8B-AWQ answers;
failed answers and invalid verdicts stay in the denominator). Wilson 95%.

| Retrieval → answers | Judge | before rerank | after rerank |
|---|---|---|---|
| Old pipeline (`plainto_tsquery` lexical + old dense, 2026-10-27 answers) | Qwen2.5-14B v1 (old numbers) | 115/200 (57.5%) | 130/200 (65.0%) |
| Old pipeline, same stored answers | **new judge** | 156/200 (78.0%, 71.8–83.2) | 158/200 (79.0%, 72.8–84.1) |
| **Current pipeline** (BM25 + bge-base RRF → top-20 LLM rerank), new answers | **new judge** | **198/200 (99.0%, 96.4–99.7)** | **199/200 (99.5%, 97.2–99.9)** |

- Gold chunk in the top-10: current 196/200 (hybrid) and 198/200 (after rerank) vs old 44 and 51.
- Paired before→after, current: 199 pairs, 0 improved / 0 degraded / 199 tied (one invalid verdict); the
  rerank makes no measurable difference on this saturated set. Old answers under the new judge: 19 improved /
  17 degraded / 163 tied, two-sided sign test p = 0.87 (under the old judge it was 23 / 10, p = 0.035, so that
  "rerank helps" result does not survive a better judge).
- Old answers by gold: when the gold chunk was retrieved, 50/51 faithful (after); when it was missed, 108/149.
  The jump from ~79% to ~99% follows the retrieval fix: with the gold chunk almost always in context the model
  answers from it.
- Invalid verdicts: 1 of 400 (current), 3 of 600 (old). Answers: 400/400 produced, 0 failures.
- Caveats: the set is sub-agent written and now saturated (Recall@10 98–99%), the judge misses about half of
  RAGTruth's human-marked hallucinations, and the contexts come from the stored phase 6 retrieval run (not
  recomputed). The 99% is not a claim about real user questions.

GPU: answers 740 s (Qwen3-8B-AWQ, serial), judge 1,753 s (1,320 verdicts: RAGTruth 320 + current 400 + old 600,
8 in flight), earlier judge on RAGTruth 116 s; load average 4.5–9.8 on 32 CPUs with other projects running. $0.
Raw outputs: [rag-faithfulness-20261031/](rag-faithfulness-20261031/) (`answers.jsonl`, `contexts.jsonl` chunk
IDs, `judge-*.jsonl` verdicts with rationale, `ragtruth-*.jsonl`, `ragtruth-score.json`, `summary-*.json`,
`load-and-timing.txt`). Reproduce: `make faithfulness-prepare-runs`, `make faithfulness-answer`,
`make faithfulness-samples`, `make judge-run ROUTE_MODEL=qwen3-14b-awq-thinking VERSIONS=v3
RUBRIC=kubernetes-grounding-binary-v1 JUDGE_WORKERS=8 …`, `make faithfulness-summary`, `scripts/judge_compare.py score`.

## Retrieval on public benchmarks with human relevance judgments (2026-10-30)

**Components** (`packages/rag/src/{bm25,dense,hybrid,beir,beirRun}.ts`, `packages/models/src/rag.ts`):

- Lexical: **Okapi BM25, k1 = 0.9, b = 0.4**, Lucene's idf `ln(1 + (N − df + 0.5)/(df + 0.5))`, over an
  analysis chain modelled on Lucene's EnglishAnalyzer (word tokens, possessive removal, lowercase,
  Lucene's 33-word English stop set, Porter stemmer checked against Porter's reference vocabulary).
  Documents are `title + " " + text` (the BEIR/Pyserini "flat" setting).
- Dense: **BAAI/bge-base-en-v1.5 @ `a5beb1e3e68b9ab74eb54cfd186867f64f240e1a`** (768-dim, CLS pooling,
  normalized), served by the existing vLLM 0.17.1 env in pooling mode (`--runner pooling`,
  `--max-model-len 512`, right truncation), called through `packages/models` `/v1/embeddings`. Queries get
  the model's retrieval instruction `Represent this sentence for searching relevant passages: `.
  Exact cosine search, no ANN index.
- Hybrid: RRF (k = 60) of dense and BM25 top-100.
- Rerank: (a) cross-encoder **BAAI/bge-reranker-base @ `2cfc18c9415c912f9d8155881c133215df768a70`** through
  vLLM `/v1/rerank` (query + document pair, 512 tokens) over the hybrid top-100; (b) the existing LLM
  relevance prompt (`rag-relevance-v1`, Qwen3-8B-AWQ, temperature 0) over the hybrid top-20, the depth the
  Kubernetes pipeline used. 0 of 29,420 LLM scores failed to parse.
- No new packages. Model files and datasets: downloaded from huggingface.co with curl, every file
  checked against the publisher's sha256 (LFS) or git blob id: `data/rag/beir/sources.lock.json`.
  Disk: 1.57 GB of models plus 22 MB of data in the project's `.cache/` (project share 8.7 / 16 GB after).

**Data.** BEIR test splits: SciFact (5,183 docs, 300 queries), NFCorpus (3,633 / 323), FiQA-2018
(57,638 / 648): `BeIR/{scifact,nfcorpus,fiqa}` at the last revisions before the 2026 Parquet conversion
(`984eed8…`, `e28763e…`, `e318552…`; the project environments have no parquet reader) and
`BeIR/*-qrels` `test.tsv`. Metrics as BEIR/pytrec_eval: nDCG@10 with graded gains, Recall@100 over
qrels with score > 0, mean over the qrels' queries, a document equal to the query id dropped.

| Dataset | Method | nDCG@10 | Recall@100 |
|---|---|---:|---:|
| SciFact | BM25 (ours) | 0.6780 | 0.9253 |
| | BM25, Pyserini BM25-flat (published) | 0.6789 | 0.9253 |
| | BM25, BEIR paper (Elasticsearch) | 0.665 | 0.908 |
| | dense bge-base (ours) | 0.7429 | 0.9633 |
| | dense bge-base, Pyserini (published) | 0.7408 | 0.9667 |
| | hybrid RRF | 0.7350 | 0.9693 |
| | hybrid + cross-encoder (top-100) | 0.7171 | 0.9693 |
| | hybrid top-20 + cross-encoder | 0.7352 | — |
| | hybrid top-20 + LLM rerank | **0.7477** | — |
| NFCorpus | BM25 (ours) | 0.3204 | 0.2456 |
| | BM25, Pyserini BM25-flat (published) | 0.3218 | 0.2457 |
| | BM25, BEIR paper | 0.325 | 0.250 |
| | dense bge-base (ours) | 0.3732 | 0.3368 |
| | dense bge-base, Pyserini (published) | 0.3735 | 0.3368 |
| | hybrid RRF | 0.3707 | 0.3348 |
| | hybrid + cross-encoder (top-100) | 0.3169 | 0.3348 |
| | hybrid top-20 + cross-encoder | 0.3439 | — |
| | hybrid top-20 + LLM rerank | **0.3770** | — |
| FiQA-2018 | BM25 (ours) | 0.2343 | 0.5395 |
| | BM25, Pyserini BM25-flat (published) | 0.2361 | 0.5395 |
| | BM25, BEIR paper | 0.236 | 0.539 |
| | dense bge-base (ours) | **0.4067** | 0.7415 |
| | dense bge-base, Pyserini (published) | 0.4065 | 0.7415 |
| | hybrid RRF | 0.3661 | 0.7144 |
| | hybrid + cross-encoder (top-100) | 0.3283 | 0.7144 |
| | hybrid top-20 + cross-encoder | 0.3721 | — |
| | hybrid top-20 + LLM rerank | 0.3947 | — |

Published references: Pyserini's reproduction file `pyserini/2cr/beir.yaml` (castorini/pyserini, blob
`77cd62f`, conditions `bm25-flat` and `bge-base-en-v1.5.faiss`; copy in
[rag-beir/pyserini-2cr-beir.yaml](rag-beir/pyserini-2cr-beir.yaml)); BEIR paper: Thakur et al.,
"BEIR: A Heterogeneous Benchmark for Zero-shot Evaluation of Information Retrieval Models", NeurIPS 2021
Datasets and Benchmarks, BM25 rows. Rerank rows keep Recall@100 of the candidate list (reranking the
top-100 cannot change it; top-20 rows have no Recall@100).

**Gap check.** Our BM25 is within 0.002 nDCG@10 and 0.0002 Recall@100 of Pyserini BM25-flat on all three
datasets, and within 0.013 nDCG@10 of the BEIR paper (which used Elasticsearch multifield BM25, a
different analyzer and parameters). Our dense rows match Pyserini's published bge-base-en-v1.5 to within
0.0021 nDCG@10. No gap exceeds 0.02, so the other rows rest on correct components.

**Reading.**
- The trained embedding model is the strongest single retriever on all three datasets. RRF with BM25
  slightly *lowers* nDCG@10 (−0.008 SciFact, −0.003 NFCorpus, −0.041 FiQA), because BM25 is much weaker here,
  but it raises Recall@100 on SciFact (0.963 → 0.969).
- **bge-reranker-base lowers nDCG@10 on all three** (top-100: −0.018, −0.054, −0.038 vs hybrid). Its input
  was checked: vLLM's pooling runner truncates on the right and tokenizes the standard (query, document)
  pair. We report it as measured and do not use it as the default.
- The **LLM relevance rerank** of the hybrid top-20 is the best reranker here: +0.013 (SciFact), +0.006
  (NFCorpus), +0.029 (FiQA) over hybrid, still below dense alone on FiQA (0.395 vs 0.407). It costs 20 chat
  calls per query (29,420 calls, 11.66 M input tokens, p50 ~0.5–0.6 s per call at 16-way batching).

**Cost and load** (local, $0): bge-base embedded all 66,945 BEIR + Kubernetes documents and 1,471 queries in
~30 s of request time (74 s holding the GPU lock incl. vLLM start); cross-encoder 147,100 pairs in 102 s;
LLM rerank 1,014 s. BM25 index build 2.0 s / 1.7 s / 12.9 s; per-query p50 BM25 0.75 / 0.07 / 10.7 ms, exact
dense 4.3 / 3.9 / 66.5 ms (SciFact / NFCorpus / FiQA, single Node thread). Load average 2.9–6.1 on 32 CPUs
during the GPU stages; other projects' work was running.

### Kubernetes 200 questions (sub-agent written, continuity)

Same 491 chunks and 200 questions as before. **The questions and gold chunk IDs were written by a
sub-agent, not by humans** (`origin: agent`).

| Method | Recall@10 | Questions with a gold chunk in top 10 |
|---|---:|---:|
| 2026-10-26 pipeline: Qwen2.5-0.5B last-token vectors + Postgres `ts_rank_cd`, RRF | 22.0% | 44 |
| 2026-10-26 pipeline + LLM rerank of top 20 | 25.5% | 51 |
| BM25 | 97.0% | 194 |
| dense bge-base | 93.5% | 187 |
| hybrid RRF | 98.0% | 196 |
| hybrid + cross-encoder (top-100) | 100.0% | 200 |
| hybrid top-20 + cross-encoder | 99.5% | 199 |
| hybrid top-20 + LLM rerank | 99.0% | 198 |

Why the jump: the old lexical side used `plainto_tsquery`, which ANDs every query term; only **5 of the
200 questions** have any chunk that contains all of their (stemmed, non-stop) terms, so the lexical list
was almost always empty and the 0.5B last-token vectors carried the result. With real components the set
is saturated (the sub-agent wrote questions from the gold chunks, with high lexical overlap), so it no
longer separates methods; the BEIR rows above are the meaningful comparison. The 2026-10-27 faithfulness
numbers below were measured on the old retrieval and were not rerun.

Raw outputs ([rag-beir/](rag-beir/)): `summary.json` (every row above), `per-query.json.gz` (per query and
method: nDCG@10 / Recall@100 or Recall@10 and top-10 doc ids), `bm25-only.json` (incl. the all-terms
diagnostic), `emb-stats.json` (counts, tokens, latency and sha256 of every vector file),
`runs-*.{ce,llm}-stats.json`, `runs-timing.json`, `*-events.jsonl` (stage logs), `load.txt`.
Reproduce: `make rag-beir STAGE=bm25|retrieve|summarize OUT=…` (CPU) and
`make rag-beir-gpu STAGE=embed|rerank-ce|rerank-llm OUT=…` (GPU; the LLM stage was run with `--workers 16`).

## Faithfulness, before vs after rerank (2026-10-27)

Judge: the Task 9 selected judge, Qwen2.5-14B-Instruct-AWQ @ `5395358`, prompt v1, rubric
`kubernetes-grounding-binary-v1` (the rubric text the stored run used). **Limit:** that judge's κ = 0.242
was measured against sub-agent labels on the BFCL action rubric, not on this grounding rubric and not
against humans. These are judge pass rates, not human-verified faithfulness.

Answers: Qwen3-8B-AWQ @ `4da05a8`, the stored run's answer prompt `keel-rag-answer-v1` (hash `a4340dfd…`),
temperature 0, seed 0, max 512 tokens, contexts `JSON.stringify({question,contexts})`. "before" = RRF top 10
of the stored 20 candidates; "after" = the stored rerank top 10. The rebuilt after-input matched the stored
`answerInputSha256` for all 200 questions. 176/200 regenerated after-answers are byte-identical to the stored ones.

| Condition (200 questions) | Faithful | Rate | Judge schema failures | Rate on judged |
|---|---:|---:|---:|---:|
| before rerank (new answers) | 115 | **57.5%** | 23 | 115/177 = 65.0% |
| after rerank (new answers) | 130 | **65.0%** | 27 | 130/173 = 75.1% |
| after rerank (stored 2026-10-26 answers) | 132 | 66.0% | 24 | 132/176 = 75.0% |

- Paired before→after (163 questions with both verdicts): 23 improve, 10 degrade, 130 tie; two-sided sign test p = 0.035.
- With the gold chunk in the top 10, after-rerank rate is 44/51 (86.3%); without it 86/149 (57.7%).
- Judge failures: 74/600 verdicts (12.3%) failed the strict `parseVerdict` schema (0/300 in the BFCL calibration).
  The parser was not relaxed; failures count as "not shown faithful" in the rate column.
- The earlier weak 8B judge gave the stored answers 168/200 (84%); the 14B judge gives 132/200 (66%).
- Cost $0 (local). Answer latency p50/p95: before 1,424/3,408 ms, after 1,599/4,302 ms; tokens 1,288,541.
  Judge p50/p95 1,308/2,049 ms over 600 calls, 2,025,678 tokens, 844 s holding the GPU lock, peak RSS 6.0 GB.
- Load: 32 CPUs, load average 3.7–9.0 during the runs; other projects were running on the same machine.
- The first answer batch stopped after 189/400 answers (`BATCH_TOTAL_SERVICE_MEMORY_LIMIT`, because a `make test`
  ran alongside); the run was resumed and the 189 answers were not resent.

Raw outputs (`docs/evidence/rag-faithfulness/`): `contexts.jsonl` (per question: before/after chunk IDs, gold flags,
stored answer), `answers.jsonl`, `judge-v1.jsonl`, `summary.json`, `run-*.log`, `load-*.txt`.
Reproduce: `make faithfulness-prepare|faithfulness-answer|faithfulness-judge|faithfulness-summary OUT=…`
(`packages/rag/src/faithfulnessRun.ts`).

## Earlier record (2026-10-26)

The production pipeline and frozen 200-question study have now run and passed independent actual-data review. The pipeline uses pinned-source preparation, transactional pgvector ingestion, Postgres hybrid retrieval, RRF (constant 60), mandatory model-API relevance reranking, QA import validation, and paired evaluation. The dataset is explicitly **subagent-authored weak reference**, never human gold; same-family/overlap/sparse-item limits remain. See [annotation evidence](rag-qa-annotation-20261025.md) and [sealed actual results](rag-answer-actual-20261026.json).

| Frozen 200-question result | Observed value |
| --- | ---: |
| Recall@10 before rerank | 44/200 = 22.0% |
| Recall@10 after rerank | 51/200 = 25.5% |
| Paired change | 7 improve, 0 degrade, 193 tie; +3.5 percentage points |
| Weak diagnostic judge pass rate | 168/200 = 84.0% |
| Reliable faithfulness | null; not admitted |

The completed b batch made 4,400 actual local physical calls: 4,000 relevance scores, 200 answers, and 200 weak judges, with 2,653,877 input/86,394 output tokens, no retries/unknown/unaccounted attempts, configured local API USD0, and 4,200 runner plus 200 API native spans. Evaluation contains 4,600 calls including each historical query once. Including the separate dimension208, production retrieval216, and retained failed-a9, cumulative Task14 physical calls are4,833. Independent DataSpec PASS / Quality APPROVED WITH ONE MINOR OUTPUT LIMITATION (C0/I0/M1); report12,104B SHA256 `7e698a2fdcd1aa78992b4614511f991efba1a07a933c94cce8d048c53dfaa93b` was FULL-read by root. All4,000 scores,200 answers/judge pairs/evaluation rows,request hashes,accounting,spans and historical700-file identity were independently checked.

The measured output limitation is inconsistent citations:115/200 answers contain a bracketed full ID from their supplied after-ten contexts;85 do not, including some abstentions, and8 use numeric brackets. This post-hoc description is not a semantic grounding score or predeclared primary metric. No label/prompt/model retuning or replay followed it. Weak judge84% cannot be used as correctness or citation compliance.

The unit ran32min19.764s and stopped at2026-10-26T01:26:00.763365Z. Serial prediction timing sums1,563,375.500ms, including reused historical retrieval; weak judge runs separately. It is not online end-to-end latency. Post01:26:17Z proved unitGC/MainPID0, seven knownPIDs absent, two ports bindable, GPUlock available, two keys absent and21cachefiles unchanged. Postinclusive disk7,838,850,543B; all original resource limits remain. The [failed a run](rag-answer-attempt-a-20261026.json) and b's zero-call permission preflight are retained separately; neither is erased by b success. No paid call was added; the closed6.7396544USD reserve remains.

The dimension study208 and separate production ingestion/retrieval phase216 also passed independent retained-data audits. The latter inserted491 chunks and completed200 PostgreSQL queries, with691 observed896-dimensional F32 vectors,216 physical calls/133689 input/0 output/known configured API0 and416 actual spans. All RRF60 candidate orders and call/vector/span identities were independently checked. These are separate experiments, not split/replayed accounting; all services are stopped. See [actual retrieval evidence](rag-live-retrieval-preparation-20261025.md) and [aggregate bindings](rag-live-retrieval-actual-20261025.json).

The source is exactly 22 English Kubernetes v1.34 concepts pages, plus LICENSE and README, from `kubernetes/website` commit `47132eb5367cfdcba0a3b33a0b3ffc81185bd7e8`, root tree `b37acd5130f980da9593d8c667d407b2fadd10da`. The checked-in source manifest records each raw URL, Git blob, byte count and SHA256. Every raw source file is reproduced without changes under `data/rag/source/` (622,859 bytes total). Attribution: **The Kubernetes Authors**, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the upstream LICENSE is included. This is a fixed subset, not the full site or latest documentation.

Keel modifies the Markdown for retrieval: removes frontmatter and HTML comments; removes shortcode wrappers while retaining enclosed Markdown; retains explicitly supplied glossary text; omits unresolved includes, feature-state metadata and other unknown shortcodes without fetching their contents. Every omission is recorded with source document and line. Multiline shortcodes retain source line numbering; literal Go templates in examples remain literal. No generated HTML, remote include, or invented snippet is added.

`markdown-lines-v2` yields **491 chunks and 203 omission records**. Corpus version is `685b6988b39330405ff97cc69fcf7d600f963a55615e4653be04722cb95be356`; chunks hash is `b98c327d1e680c670f4bb5071196fe41dbd5aed6ddc73bed689f0184e34d196a`. Chunk boundaries use at most 1200 JavaScript UTF-16 code units, no overlap, preferring a newline in the latter half of the window. Each chunk records raw source line range, normalized offsets, source URL and content hash; ID hashes corpus version, document path, boundaries and content hash. All retrieved chunks remain tainted. Ingestion additionally checks the independently approved, code-pinned canonical lock commitment `f85cb5bf4a421768f5c5b8977d812462f5d810b0213bcf6d1b22a8ae9d2336df` and official version. Rehashing caller-modified chunks and lock cannot retain this identity. Explicit fixture admission cannot use the official version, and actual evaluation requires the official version. Inputs are copied before asynchronous ingestion so later caller edits cannot replace verified content. The final source/chunk freeze precedes any QA annotation. An earlier pre-QA draft (492 chunks / 205 omissions) was superseded after a regression exposed multiline shortcode attribute leakage; no QA or gold IDs existed during that correction.

Reproduce and verify offline with existing workspace dependencies:

```sh
node_modules/.bin/tsx packages/rag/src/prepare.ts --check
node_modules/.bin/vitest run --config packages/rag/vitest.config.ts packages/rag/test/core.test.ts packages/rag/test/pipeline.test.ts packages/models/test/rag.test.ts --maxWorkers=1
```

SQL tests require a separately admitted, already-running PostgreSQL fixture through `KEEL_TEST_POSTGRES_URL`. They never launch Testcontainers, pull images, or fall back to another database. A finite root-owned pgvector 0.8.1/Postgres 17 fixture verified actual transactions, migration rollback, generated tsvector, `ts_rank_cd`, cosine distance, immutable rows, dimension/profile foreign keys, idempotence and mixed 2/3-dimensional profile isolation. Its scripted vectors and model responses are **test fixtures**, not embeddings, model evidence or actual evaluation. `goldChunkInTop10OnFixtures` demonstrates fixture retrieval plumbing only.

Migration 0004 stores vectors with a profile-specific dimension CHECK and a composite profile/dimension FK. This enforces the plan's vector(N) semantics without choosing an unproved actual N or interpolating dynamic identifiers. Exact vector scans occur behind a MATERIALIZED corpus/profile/dimension scope; unrelated profile vectors cannot participate in cosine evaluation. Text ranking uses Postgres `ts_rank_cd`, which is **not mathematical BM25**. Each ranked list is deduplicated, and RRF adds `1/(60+rank)` with deterministic ID ties. No ANN index or actual throughput claim is made.

Every embedding, rerank and grounding scorer request passes through `packages/models`. Embeddings use a local-only OpenAI-compatible `/v1/embeddings` endpoint, explicit immutable alias/model/revision/dimension/runtime-evidence profile, bounded input/response bytes, one physical attempt, strict response indices/model/usage, and finite nonzero vectors. A trusted optional private Bearer key is passed only to the existing loopback models route and excluded from profile/body/results. Redirects are rejected. Missing usage or failed physical calls retain unknown cost status. Model-API reranking uses the existing chat router, temperature 0, seed 0, 128-token bound, versioned prompt hash, strict relevance JSON, one logical call for every candidate and the existing maximum-five physical attempt/accounting policy. It is an API relevance scorer, not a cross-encoder. The existing cached Qwen2.5-0.5B-Instruct revision ran as a converted generative last-token embedding adapter; retained response vectors validate dimension896. This is not a trained embedding checkpoint. The frozen AWQ reranker/answer/weak-judge batch above supplies actual observed comparison data. Configured revision/evidence labels are never described as observed provider revision proof.

For actual QA, freeze the committed corpus first and provide JSONL rows containing exactly `id`, `question`, `answer`, `goldChunkIds`, `corpusVersion`, `origin`, `annotator`, and `auditRef`. Import with current corpus/version and chunk-ID set. A trusted operator import policy must allow the origin and attest the exact input byte hash plus annotator/audit reference for human or agent data. Unknown gold IDs, wrong corpus, duplicate questions/IDs/golds, unauthorized origin, mismatched attestation, extra fields or over-200 rows are rejected. Partial imports explicitly report their count and `complete=false`; fixture data is kept in tests. Origin is never upgraded from agent to human.

Evaluation binds the same questions, corpus, embedding profile, reranker revision/prompt, candidate count, RRF constant and git SHA for before/after ranking. Each report records separate effective protocols: API relevance rerank temperature0/seed0/max128 and its existing retry ceiling; actual weak grounding uses the reviewed Task9 v1 base plus different fixed Kubernetes rubric, native schema-v2, temperature0/seed0/max1024/one physical attempt, exact hashes and mandatory durable dispatch/completion checkpoints. Missing applicable receipts remain gated. These settings come from the same immutable models-layer constants used to construct requests. It retains failed-question denominators, IDs, context/answer/question hashes, call accounting and coverage. Failed or invalid scorer outputs do not disappear from the population or become zero-cost successes. Prompt/query/document contents are excluded from telemetry. Actual evaluation cannot use fixture-origin rows; a partial run cannot be reported as a completed 200-question study.

Actual faithfulness remains null. The separately named **weakDiagnosticJudgePassRate** can use only a module-private immutable receipt from the verifier of the exact reviewed fifteen-role raw bundle. Its code-owned commitments bind both complete BFCL versions and original subagent references, mechanical selection, and ONE selected domain validation with its own rubric/system/protocol. Caller hashes, copied receipts and fixture receipts cannot authorize actual evaluation. The factory reuses shared createJudge and packages/models; async host persistence must complete before POST, and caller cancellation/failure accounting remain effective.

The reviewed evidence is poor: both BFCL kappas are −0.03174603174603223 and the selected v1 is a lexical tie; domain matrix[[12,38],[0,50]], kappa.24, with38/50 reference fails passed. Receipt/output retain these values, paired controlled construction, same-family nonblind limits and reliableJudgeAdmitted=false. This is a diagnostic local judge pass-rate, not reliable faithfulness or gold correctness. No positive threshold was invented after observing outcomes, no frozen labels were edited and no fake second domain version was created. Historical source fingerprints stay attached to their actual executions;16 current relevant source pins bind new scoring. Original HTTP bodies remain absent, so recorded hashes are not wire-rehash proof.

Actual model-API reranking/generated answers, durable checkpoints, paired metrics and accounting have now been independently audited as described above. Reliable faithfulness remains unavailable because the calibration is poor; the separate weak metric preserves that negative result. A reference QA answer was never substituted for a prediction. GPU/cache/budget admission and cleanup remained root-owned. Original CPU/SQL fixtures and the separately reviewed208/216/failed-a9/successful-b4400 lifecycles keep their distinct identities and limits. Full-stack online latency and human-gold correctness were not measured.

Ingestion errors retain every incurred call, known subtotal and unknown attempt status even if rollback also fails. The error includes separate sanitized primary-operation and rollback-failure metadata, excluding database/provider messages and document text.
