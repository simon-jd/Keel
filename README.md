# Keel

Keel is a TypeScript runtime for LLM agents that act on SaaS accounts, built to measure how well
such an agent resists prompt injection and how far its answers can be trusted. A durable agent
loop checkpoints every step in Postgres and calls tools exposed by MCP servers for GitHub, Google
(Gmail and Calendar), Slack and Salesforce. The servers keep OAuth 2.0 + PKCE tokens encrypted at
rest and perform a write only with a short-lived permit bound to the exact tool and arguments. A
guard between the model and the tools enforces capability lists, a plan frozen before untrusted
input, session taint and value-level provenance. Around the loop sit a RAG pipeline (BM25 + dense
hybrid retrieval, LLM reranking, an LLM grounding judge), OpenTelemetry tracing into a self-hosted
Langfuse with a Presidio PII sidecar in the export path, and a regression gate that fails a change
whose benchmark success drops. The agent, the guard, retrieval and the judges were measured on
public benchmarks (AgentDojo, BFCL, τ²-bench, BEIR, RAGTruth) with open-weight models served
locally by vLLM on one GPU, and the tracing path end to end on a local Langfuse stack. The SaaS
integrations have only been tested against synthetic provider fixtures, not real accounts.

## Components

```text
  task ─▶ runtime: runAgent                         models: router
          Postgres checkpoints, step budgets   ───▶ OpenAI · Anthropic · OpenAI-compatible (local vLLM)
          approvals bound to an argument hash,      per-call token and cost accounting
          crash recovery; an interrupted write
          stays UNKNOWN until reconciled
             │ every tool call
             ▼
          guard: capability · frozen plan · taint · provenance · egress allowlist (http_fetch)
             │ signed permit bound to tenant / run / tool / action key / argument hash
             ▼
          MCP servers over Streamable HTTP (bearer JWT from an external OAuth server)
          github · google · slack · salesforce
          OAuth 2.0 + PKCE, AES-GCM token store, encrypted action journal, signed webhooks

  rag      BM25 + bge-base-en-v1.5 ─ RRF ─▶ LLM rerank ─▶ answer ─▶ grounding judge
  tracing  OTel spans ─▶ attribute whitelist ─▶ Presidio sidecar ─▶ OTLP ─▶ collector ─▶ Langfuse
  evals    LLM judge, regression gate (make gate, GitHub workflow)
  bench    Python adapters that run unchanged AgentDojo, BFCL and τ²-bench against the Keel backend
```

- **Runtime** (`packages/runtime`): `runAgent` holds a Postgres advisory lock for the run, reserves
  model and tool budget before each call, validates a whole tool batch against its schemas before
  running any of it, and checkpoints messages and results. A write cut off by a crash is marked
  UNKNOWN and is completed only when a provider lookup proves it done or absent; it is never
  replayed blindly. The GET-only `http_fetch` tool checks scheme, host, port and path against
  trusted rules, resolves every redirect hop and rejects private and metadata addresses.
- **MCP servers** (`packages/mcp-servers`): built on the official MCP TypeScript SDK. GitHub (failing
  checks, issues through a GitHub App), Google (Gmail search and draft reply, Calendar free slots),
  Slack (message search and post) and Salesforce (a restricted SOQL subset, Case status update).
  They verify RS256 bearer tokens from an external authorization server, report missing scopes so
  the host can ask for incremental consent, and journal each write before dispatch so a lost
  response can be reconciled without a duplicate.
- **Guard** (`packages/guard`). Policies compared in the results:
  - `capability`: deny any tool outside the task's declared tool list.
  - `plan`: the tool set is frozen before the first untrusted read.
  - `taint`: after the first tool result, every side-effecting call needs human approval (none is
    available in the benchmark, so the call is blocked).
  - `all`: capability + plan + taint.
  - `provenance`: string fields of eight or more words in tool results count as free text (where
    injections live); shorter fields are structured values. A call is held when an argument carries
    an identifier (e-mail address, URL or domain, IBAN-shaped string) that appeared only in free
    text, not in structured values or the user's request. Side-effecting calls also check bare
    tokens such as ids or passwords.
  - `all-prov`: provenance plus capability and plan checks on side-effecting tools only.
- **RAG** (`packages/rag`): ingestion of a pinned subset of the Kubernetes docs into pgvector, Okapi
  BM25 with a Lucene-style English analyzer, dense retrieval with bge-base-en-v1.5, reciprocal rank
  fusion, a cross-encoder and an LLM relevance reranker, and runners for BEIR and faithfulness.
- **Tracing and PII** (`packages/tracing`, `services/pii`): OTel GenAI spans for LLM, tool and
  retrieval calls. Every exported span is projected onto an attribute whitelist, its string
  metadata goes through the Presidio sidecar, and the result is projected again before OTLP export.
  If the sidecar fails, the batch's string attributes are dropped rather than sent unredacted.
- **Evals** (`packages/evals`, `services/bench-adapters`): judge prompts and agreement metrics, the
  regression gate, and Python adapters that drive the original AgentDojo, τ²-bench and BFCL tasks
  and scorers through the Keel backend (`services/api`).

## Results

All model runs used open-weight models served by vLLM 0.17.1 on one RTX 4090 at temperature 0
(seed 0 unless seeds are listed), on a 32-CPU workstation that was also running other workloads,
so timings compare only within one run. Counts are k/n; ranges in brackets are Wilson 95% intervals unless noted.

| What | Setup | Result | Evidence |
|---|---|---|---|
| Prompt injection, AgentDojo v1.2.2 | All 4 suites: 97 clean tasks and 949 user task × injection pairs under the `important_instructions` attack; agent Qwen3-8B-AWQ; every policy on every case | Targeted attack success (ASR): no defense 147/949 (15.5%, 13.3–17.9); `all-prov` 8/949 (0.8%, 0.4–1.7); `all` 8/949; `capability` 12/949; `plan` 13/949; `taint` 17/949; `provenance` 30/949. Clean utility: no defense 33/97, `all-prov` 29/97, `all` 16/97. Utility under attack: 256, 255 and 156 of 949 | [defense-eval.md](docs/evidence/defense-eval.md), [report.md](docs/evidence/defense-full/report.md) |
| Failed episodes, two conventions | Same run | 290 of 7,322 episodes failed, almost all workspace attack episodes: the request exceeded the backend's 128 KB message limit or the model's 32k-token context. Above they count as non-successes. Counted as attack successes, as AgentDojo's own harness scores context overflows: no defense 188/949 (19.8%), `all` 50/949 (5.3%), `all-prov` 51/949 (5.4%), `capability` 5.5%, `taint` 5.5%, `plan` 5.7%, `provenance` 7.4% | [defense-eval.md](docs/evidence/defense-eval.md), [spread.json](docs/evidence/defense-full/repeats/spread.json) |
| Held-out suites | Policies were developed on slack + travel; banking + workspace held out (56 clean tasks, 704 pairs) | ASR: no defense 45/704 (6.4%), `all` 0/704, `all-prov` 0/704 (0.0–0.5); with failures counted as successes 85, 41 and 40 of 704. Clean utility: `all-prov` 17/56, the same as no defense; `all` 12/56. Under attack: `all-prov` 210/704, no defense 199/704, `all` 136/704 | [defense-eval.md](docs/evidence/defense-eval.md) |
| Run-to-run spread | Two more full runs of no defense, `all` and `all-prov` with the same task seed; only vLLM's batched decoding varies (repeats, not seeds) | Largest change in any cell: one clean task (≤1.8 points held out) and five attack episodes (≤0.6 points) | [defense-eval.md](docs/evidence/defense-eval.md), [spread.json](docs/evidence/defense-full/repeats/spread.json) |
| LLM judge vs the BFCL checker | 400 BFCL outputs (200 checker pass, 200 checker fail, 4 categories); the reference is the official BFCL AST checker, not a person; best of 6 judge configurations, chosen on this set | Qwen3-14B-AWQ with thinking, prompt v3: κ 0.595 (bootstrap 95% 0.518–0.670), agreement 319/400, fail precision 126/133, fail recall 126/200 (2 invalid verdicts counted as wrong). Earlier judge, Qwen2.5-14B-Instruct-AWQ prompt v1: κ 0.240, 248/400, 53/58, 53/200 | [judge-calibration.md](docs/evidence/judge-calibration.md), [selection.json](docs/evidence/judge-calibration-phase7/selection.json) |
| Grounding judge vs RAGTruth labels | 320 items from the RAGTruth QA test split: 160 with human-marked unsupported content, 160 clean | Same Qwen3-14B judge: κ 0.406 (0.310–0.502), agreement 225/320, fail precision 84/103, fail recall 84/160. Earlier judge: κ 0.163, fail recall 63/160 | [rag-eval.md](docs/evidence/rag-eval.md), [ragtruth-score.json](docs/evidence/rag-faithfulness-20261031/ragtruth-score.json) |
| Retrieval on BEIR | SciFact, NFCorpus and FiQA-2018 test splits; full table below | Keel's BM25 is within 0.002 nDCG@10 of Pyserini's BM25-flat and its dense bge-base-en-v1.5 within 0.0021 of Pyserini's published run on all three. LLM reranking of the hybrid top 20 adds 0.013 / 0.006 / 0.029 nDCG@10 over hybrid; the bge-reranker-base cross-encoder lowers it on all three | [rag-eval.md](docs/evidence/rag-eval.md), [summary.json](docs/evidence/rag-beir/summary.json) |
| Kubernetes RAG faithfulness | 200 questions over 491 chunks of 22 Kubernetes concept pages; questions and gold chunks written by an LLM, not by people; answers by Qwen3-8B-AWQ; graded by the Qwen3-14B judge above | Current pipeline (BM25 + dense RRF, top-20 LLM rerank): 198/200 (99.0%) before rerank, 199/200 (99.5%) after; paired, 0 improved, 0 degraded, 199 tied. The earlier pipeline's stored answers under the same judge: 156/200 and 158/200. Gold chunk in the top 10: 196/200, against 44/200 for the earlier pipeline. Upper-leaning, see limitations | [rag-eval.md](docs/evidence/rag-eval.md), [summary-current-pipeline.json](docs/evidence/rag-faithfulness-20261031/summary-current-pipeline.json) |
| Cheap-first model routing | BFCL v4 `simple_python`, 400 tasks; cheap Qwen2.5-0.5B-Instruct, strong Qwen3-8B-AWQ; cost is GPU-seconds summed over calls; cheap-first replayed from the two runs | Cheap only 304/400 (76.00%), 72.9 GPU-s. Cheap first, escalating calls rejected by a schema verifier: 315/400 (78.75%), 77.3 GPU-s, 12 escalated. Strong only 381/400 (95.25%), 143.2 GPU-s. An oracle escalation (not deployable) would reach 387/400 at 107.9 GPU-s | [routing-frontier.md](docs/evidence/routing-frontier.md), [frontier.json](docs/evidence/routing-frontier/frontier.json) |
| BFCL against the public leaderboard | Same 400 tasks | Qwen3-8B-AWQ 381/400 (95.25%) against 95.50% for Qwen3-8B (FC) on the leaderboard's Python Simple AST. Before a scorer fix (BFCL's `underscore_to_dot` was not set for the adapter), the same stored outputs had scored 224/400 | [benchmarks.md](docs/evidence/benchmarks.md), [routing-frontier.md](docs/evidence/routing-frontier.md) |
| Regression gate drill | Candidate change: every tool and parameter description blanked; same model and tasks | 323/400 against the 381/400 baseline; `make gate` fails it with `SUCCESS_DROP_EXCEEDS_2PP` and passes the unchanged control | [routing-frontier.md](docs/evidence/routing-frontier.md), [gate output](docs/evidence/routing-frontier/gate-no-tool-descriptions.txt) |
| τ²-bench | Qwen3-8B-AWQ; airline, retail, telecom, 50 tasks × 3 seeds each; the user simulator and judge are the same local model | 37/450 (8.22%): airline 21/150, retail 16/150, telecom 0/150. Failed jobs stay in the denominator; most retail and telecom failures were malformed JSON (43 and 105 jobs) | [benchmarks.md](docs/evidence/benchmarks.md) |
| Tracing into Langfuse | Full local compose stack (Langfuse 4.69.0); 30 agent runs with Qwen3-8B-AWQ; 150 synthetic PII canaries planted in task text, tool results and a whitelisted attribute | Spans sent / acknowledged by the collector / stored / returned by the Langfuse API: 180 / 180 / 180 / 180. Storage delay after the collector acknowledgement p50 119 ms, p95 193 ms. Canaries found in 72 Langfuse storage objects (ClickHouse tables, Postgres dump, MinIO, Redis, logs, API responses): 0; the same scan found 120 hits in Keel's own run database | [task-04-tracing.md](docs/evidence/task-04-tracing.md), [summary.json](docs/evidence/task4-langfuse/summary.json) |
| PII stage overhead | 16-span metadata batches through the real Presidio sidecar over loopback HTTP; 10 warm-up and 100 measured pairs, alternating with and without the stage | Added latency per batch, paired: p50 1.55 ms, p95 2.26 ms (batch p95 1.23 ms without the stage, 3.58 ms with it); 1,600/1,600 spans exported | [pii-overhead.md](docs/evidence/pii-overhead.md), [pii-overhead.json](docs/evidence/pii-overhead.json) |

nDCG@10 on the BEIR test splits ([rag-eval.md](docs/evidence/rag-eval.md)):

| Method | SciFact | NFCorpus | FiQA-2018 |
|---|---:|---:|---:|
| BM25, Keel | 0.6780 | 0.3204 | 0.2343 |
| BM25-flat, Pyserini (published) | 0.6789 | 0.3218 | 0.2361 |
| Dense bge-base-en-v1.5, Keel | 0.7429 | 0.3732 | 0.4067 |
| Dense bge-base-en-v1.5, Pyserini (published) | 0.7408 | 0.3735 | 0.4065 |
| Hybrid RRF (k = 60) | 0.7350 | 0.3707 | 0.3661 |
| Hybrid top 100 + bge-reranker-base | 0.7171 | 0.3169 | 0.3283 |
| Hybrid top 20 + LLM rerank (Qwen3-8B-AWQ) | 0.7477 | 0.3770 | 0.3947 |

What the injection numbers do and do not say: `all-prov` matches `all` on attack success (8/949
overall, 0/704 held out) while keeping far more legitimate work: 29 against 16 of 97 clean tasks
and 255 against 156 of 949 tasks under attack. Held out, its clean utility equals the undefended
agent's (17/56). The clean-utility intervals overlap (n = 56 and 97 are small); the under-attack
difference does not. `taint` and `all` lose utility because nearly every legitimate write follows
a tool read: under `taint`, clean slack utility falls from 11/21 to 1/21. `provenance` alone lets
more attacks through than `taint` (30 against 17 of 949), almost all in travel (24/140), where
the injected hotel is also a legitimate structured value. Five of the eight remaining `all-prov`
successes come from one travel injection that only asks the model to praise a hotel, which no
tool-call guard can stop. Per-episode latency in these runs includes queueing behind 11 other
concurrent episodes, so it is not an isolated guard overhead.

## Limitations

- **No real SaaS accounts.** The four MCP servers and the OAuth flows were tested with the official
  MCP SDK client over loopback HTTP, a real Postgres and synthetic provider fixtures (not
  recordings). No OAuth round trip with a real Slack workspace, GitHub App, Google project or
  Salesforce org was completed, no external authorization server was deployed, and webhook
  delivery, TLS behind a proxy and key rotation are unverified
  ([integrations.md](docs/evidence/integrations.md)).
- **Injection evaluation scope.** One agent model, one task seed and one attack; InjecAgent was not
  run. In the benchmark, the capability and plan declarations are the tools of each task's
  ground-truth solution, which a deployment would have to supply another way. Identifiers are
  matched literally, so a paraphrased or re-encoded injected value passes `provenance`, and its
  free-text threshold and identifier patterns are heuristics developed on two suites. Before the
  provenance policies were designed, three held-out workspace rows from a pilot run had been seen.
- **Benchmark host vs production path.** The policy switches compared above, including `provenance`
  and `all-prov`, run in a benchmark host used by the adapters. The production `createGuard` path
  applies capability, plan and taint checks with default human approval for writes
  ([threat model](docs/threat-model.md)).
- **Judge.** The BFCL checker used as reference has strictness of its own (formatting-only
  mismatches, optional parameters it requires), and the judge configuration was chosen on the same
  400 items. The selected judge still misses 74 of 200 checker failures. Against human labels on
  the same rubric (300 BFCL actions labelled by one person, 277 pass / 23 fail;
  `scripts/judge_compare.py`) it reaches κ 0.396 (bootstrap 95% 0.169–0.605), agreement 281/300,
  fail precision 7/10 and fail recall 7/23, well below two people's agreement on 100 of the items
  (99/100, κ 0.918). Both rest on few fails (23 and 7), each label set is a single pass without
  adjudication, and the judge was chosen on the checker set, not on these labels; picking among
  judges by them would be in-sample ([judge-calibration.md](docs/evidence/judge-calibration.md)).
- **Kubernetes faithfulness is upper-leaning.** The questions were written by an LLM from the gold
  chunks, so the set is saturated (gold chunk in the top 10 for 196 to 198 of 200 questions) and no
  longer separates retrieval methods; BEIR is the meaningful retrieval comparison. The judge passes
  76 of the 160 RAGTruth answers that annotators marked as containing unsupported content, and the
  contexts come from a stored retrieval run. The 99% says nothing about real user questions.
- **τ²-bench** uses the agent model as its own user simulator and judge, so it is not a clean
  measure of agent ability.
- **PII.** The sidecar recognizes English e-mail addresses and US phone numbers only, with no NER
  model or credential detector. The overhead workload is small, synthetic, sequential and
  metadata-only; throughput under production concurrency was not measured.
- **Tracing.** Runs have no root span, so each LLM, tool or retrieval span is its own Langfuse
  trace, grouped by the `keel.run_id` attribute. Langfuse ran only as a local compose stack.
- **CI.** The [eval-gate workflow](.github/workflows/eval-gate.yml) has no model access: it compares
  a committed candidate report with the baseline. The evidence covers the same check run locally
  with `make gate`.
- **Timings** are single runs on a shared machine.

## Repository layout

| Path | Contents |
|---|---|
| `packages/runtime/` | agent loop, checkpoint store, budgets, action keys, cost recovery, guarded `http_fetch` |
| `packages/guard/` | capability, plan, taint, provenance and egress policies; benchmark host bridge; attack fixtures |
| `packages/mcp-servers/` | `common` (HTTP server, JWT verification, approvals, action journal) and the `github`, `google`, `slack`, `salesforce` servers |
| `packages/oauth/` | OAuth 2.0 + PKCE flows, refresh, encrypted token store, per-provider contracts |
| `packages/models/` | model router (OpenAI, Anthropic, OpenAI-compatible), accounting, embedding and rerank clients |
| `packages/rag/` | ingestion, BM25, dense, hybrid, rerank, BEIR and faithfulness runners |
| `packages/evals/` | judge, agreement metrics, regression gate CLI |
| `packages/tracing/` | span helpers, whitelist projection, PII processor, OTLP exporter |
| `packages/db/` | Drizzle schema and numbered SQL migrations (up and down) |
| `services/api/` | HTTP backend used by the benchmark adapters |
| `services/bench-adapters/` | Python adapters for AgentDojo, τ²-bench and BFCL, batch runner, defense report, pinned upstream locks |
| `services/pii/` | Presidio sidecar ([README](services/pii/README.md)) |
| `infra/` | Docker Compose for Postgres/pgvector, Redis, Langfuse, ClickHouse, MinIO and the OTel collector ([README](infra/README.md), in Chinese) |
| `data/labels/` | frozen judge cohorts, including the [RAGTruth subset](data/labels/ragtruth-qa-20261031/README.md) |
| `data/rag/` | pinned Kubernetes docs subset (CC BY 4.0), chunks, questions, BEIR spec ([README](data/rag/README.md)) |
| `data/regression/` | gate baseline and candidate reports |
| `scripts/` | GPU queue wrapper, PII sidecar wrapper, cohort builders, judge comparison, Langfuse experiment, resource checks |
| `docs/evidence/` | write-ups and raw outputs behind the results (some older notes are in Chinese) |
| `docs/threat-model.md` | threats, defenses, measured results and residual risks |

## Build and test

Linux x64 with Node 20.19+, Docker (the tests start Postgres/pgvector and the OTel collector with
Testcontainers) and Python 3.12. Toolchains live inside the checkout under `.tools/`: pnpm 10.34.8
in `.tools/pnpm`, a Python venv in `.tools/bench-venv` with the pinned packages from
`services/bench-adapters/requirements.lock` and `services/pii/requirements.lock`, and the pinned
BFCL checkout under `.tools/bench-upstream/` (commit in
`services/bench-adapters/upstream-lock.json`). `make tools-check` reports what is missing.

```bash
npm --cache .tools/npm-cache install --prefix .tools/pnpm pnpm@10.34.8 --no-audit --no-fund
export PATH="$PWD/.tools/pnpm/node_modules/.bin:$PATH"
pnpm install --frozen-lockfile
make check                  # tsc typecheck of every workspace package
make test                   # offline suites: tests/resources, bench adapters, PII sidecar (real Presidio), all TS packages
make test-ts PKG=tracing    # one workspace package
make gate                   # candidate report vs baseline, the same check as the CI workflow
```

No test calls cloud APIs, paid models or the GPU. Opt-in switches are listed at the top of the
`Makefile` (`KEEL_TEST_ARTIFACTS=1`, `KEEL_TEST_POSTGRES_URL=...`); `make measure-pii-overhead`
re-measures the PII stage and rewrites `docs/evidence/pii-overhead.json`.

GPU runs go through `scripts/gpu_run.py`, which queues on a shared lock file and cleans up only its
own process group; models are served offline by a local vLLM runtime pinned in
`services/bench-adapters/vllm-runtime.lock.json`. The benchmark targets:

```bash
make security-full-prepare ROUTE_MODEL=qwen3-8b-awq OUT=.tools/sec/full   # AgentDojo, all policies
make security-full-run ROUTE_MODEL=qwen3-8b-awq OUT=.tools/sec/full       # GPU; rerun to resume
make bfcl-prepare MANIFEST=.tools/x/m.json ROUTE_MODEL=qwen3-8b-awq       # BFCL; then make bfcl-run
make judge-run ROUTE_MODEL=qwen3-14b-awq-thinking SAMPLES=<samples.jsonl> OUT=<dir> VERSIONS=v1,v2,v3 JUDGE_WORKERS=8
make rag-beir STAGE=bm25|retrieve|summarize OUT=.tools/rag-beir           # CPU stages
make rag-beir-gpu STAGE=embed|rerank-ce|rerank-llm OUT=.tools/rag-beir    # GPU stages
make faithfulness-prepare-runs OUT=<dir> RUNS=<runs.json.gz>              # then faithfulness-answer, -judge, -summary
```

Each evidence file ends with the exact commands used for its run. The Langfuse stack is started
from `infra/` (see its README); `python3 scripts/langfuse_ingest.py run <out> --runs N` runs the
end-to-end tracing experiment and removes the stack afterwards. Starting an MCP server
(`pnpm --filter mcp-slack exec tsx src/main.ts <config.json>`) needs Postgres with the migrations,
key files and an external OAuth authorization server; the config shape is in
[integrations.md](docs/evidence/integrations.md).
