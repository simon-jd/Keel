.PHONY: test check typecheck test-ts test-resources test-bench test-pii measure-pii-overhead tools-check azure-down azure-down-preview resource-check bfcl-prepare bfcl-run matrix-prepare matrix-run gate security-prepare security-run security-full-prepare security-full-run rag-beir rag-beir-gpu judge-run judge-summary faithfulness-prepare faithfulness-prepare-runs faithfulness-samples faithfulness-answer faithfulness-judge faithfulness-summary

# Offline test entry point. Uses only project toolchains under .tools/ (pnpm, bench-venv)
# and the workspace node_modules. Docker is needed for testcontainers (Postgres, OTel
# collector); those containers are started and removed by the tests themselves.
# Opt-in suites, off by default:
#   KEEL_TEST_ARTIFACTS=1        tests that read gitignored .tools/ run artifacts
#   KEEL_MEASURE_PII_OVERHEAD=1  (use `make measure-pii-overhead`) rewrites evidence
#   KEEL_TEST_POSTGRES_URL=...   use an existing Postgres instead of testcontainers
# No test calls cloud APIs, paid models or the GPU.

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
TOOLS := $(ROOT)/.tools
PNPM := $(TOOLS)/pnpm/node_modules/.bin/pnpm
BENCH_PY := $(TOOLS)/bench-venv/bin/python
# Same pinned BFCL checkout that local_batch.py puts on PYTHONPATH for real runs.
BFCL_ROOT := $(TOOLS)/bench-upstream/gorilla-6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/berkeley-function-call-leaderboard
WITH_PII := $(BENCH_PY) $(ROOT)/scripts/with_pii_sidecar.py --

export PATH := $(TOOLS)/pnpm/node_modules/.bin:$(ROOT)/node_modules/.bin:$(PATH)
# Tests must never write bytecode into the tree or reuse a stale cache.
export PYTHONDONTWRITEBYTECODE := 1
# A stray host value would silently redirect the tracing PII stage.
unexport KEEL_PII_ENDPOINT

test: tools-check test-resources test-bench test-pii test-ts
	@echo "make test: all offline suites passed"

tools-check:
	@test -x $(PNPM) || { echo "missing $(PNPM); see README (install pnpm into .tools/pnpm)"; exit 1; }
	@test -x $(BENCH_PY) || { echo "missing $(BENCH_PY); create it from services/bench-adapters/requirements.lock"; exit 1; }
	@test -d $(BFCL_ROOT) || { echo "missing pinned BFCL checkout $(BFCL_ROOT)"; exit 1; }
	@test -d $(ROOT)/node_modules/.bin || { echo "run: $(PNPM) install --frozen-lockfile --offline"; exit 1; }

# `make test-ts PKG=tracing` runs a single workspace package.
test-ts:
	cd $(ROOT) && $(WITH_PII) $(PNPM) $(if $(PKG),--filter $(PKG),-r --workspace-concurrency=1) test

test-resources:
	cd $(ROOT) && $(BENCH_PY) -m unittest discover -s tests/resources

test-bench:
	cd $(ROOT)/services/bench-adapters && PYTHONPATH=$(BFCL_ROOT) $(BENCH_PY) -m unittest discover -s tests

test-pii:
	cd $(ROOT) && $(WITH_PII) $(BENCH_PY) -m unittest services.pii.tests.test_app

measure-pii-overhead:
	cd $(ROOT) && KEEL_MEASURE_PII_OVERHEAD=1 $(WITH_PII) $(PNPM) --filter tracing exec vitest run test/pii-overhead.test.ts

typecheck:
	cd $(ROOT) && $(PNPM) -r typecheck

check: typecheck

azure-down-preview:
	python3 scripts/azure_control.py down

# Target and subscription are pinned in the helper. No arbitrary RG override.
azure-down:
	python3 scripts/azure_control.py down --execute

# Task 10 routing frontier: BFCL simple_python 400 on one local model per GPU run.
#   make bfcl-prepare MANIFEST=.tools/x/m.json ROUTE_MODEL=qwen2.5-0.5b-instruct [VARIANT=no-tool-descriptions]
#   make bfcl-run MANIFEST=.tools/x/m.json RESULTS=.tools/x/r.jsonl   (GPU, under the shared flock)
#   [BFCL_CATEGORIES=multiple,parallel,parallel_multiple MAX_JOBS=600]  other non-live single-turn AST categories
VARIANT ?= original
BFCL_CATEGORIES ?= simple_python
MAX_JOBS ?= 400
bfcl-prepare:
	cd $(ROOT) && PYTHONPATH=$(BFCL_ROOT) $(BENCH_PY) services/bench-adapters/run_matrix.py prepare $(MANIFEST) \
	  --per-domain 0 --bfcl-count 400 --model $(ROUTE_MODEL) --prompt-variant $(VARIANT) --bfcl-categories $(BFCL_CATEGORIES)

bfcl-run:
	cd $(ROOT) && python3 scripts/gpu_run.py --local-only --timeout-seconds 3600 -- \
	  $(BENCH_PY) services/bench-adapters/local_batch.py $(MANIFEST) $(RESULTS) --max-jobs $(MAX_JOBS) --seconds 3500

# Task 8 matrix for one local model: tau2 3 domains x 3 seeds, plus BFCL unless BFCL_COUNT=0.
#   make matrix-prepare MANIFEST=.tools/t8-x/m.json ROUTE_MODEL=qwen2.5-0.5b-instruct BFCL_COUNT=0
#   make matrix-run MANIFEST=.tools/t8-x/m.json RESULTS=.tools/t8-x/r.jsonl   (GPU; one batch, rerun to resume)
# Each run keeps its artifacts next to its results, not in the shared .tools/benchmark-artifacts.
# When a run's store reaches its 64 MB cap (ARTIFACT_CAPACITY), continue with ARTIFACTS=<new dir>.
BFCL_COUNT ?= 400
matrix-prepare:
	cd $(ROOT) && PYTHONPATH=$(BFCL_ROOT) $(BENCH_PY) services/bench-adapters/run_matrix.py prepare $(MANIFEST) \
	  --bfcl-count $(BFCL_COUNT) --model $(ROUTE_MODEL)

matrix-run:
	cd $(ROOT) && python3 scripts/gpu_run.py --local-only --timeout-seconds 3600 -- \
	  $(BENCH_PY) services/bench-adapters/local_batch.py $(MANIFEST) $(RESULTS) --max-jobs 1000 --seconds 3500 \
	  --artifacts $(if $(ARTIFACTS),$(ARTIFACTS),$(dir $(RESULTS))artifacts)

# Task 11/13 defense matrix (5 policies) on one local model per GPU run.
#   make security-prepare BENCH=agentdojo|controlled|tau2 ROUTE_MODEL=qwen3-8b-awq OUT=.tools/sec/x
#   make security-run ROUTE_MODEL=qwen3-8b-awq OUT=.tools/sec/x          (GPU, under the shared flock)
security-prepare:
	cd $(ROOT) && $(BENCH_PY) services/bench-adapters/security_plan.py $(BENCH) $(ROUTE_MODEL) $(OUT)/spec.json
	cd $(ROOT) && $(BENCH_PY) services/bench-adapters/security_matrix.py prepare --input $(OUT)/spec.json --output $(OUT)/manifest

security-run:
	cd $(ROOT) && python3 scripts/gpu_run.py --local-only --timeout-seconds 3600 -- \
	  $(BENCH_PY) services/bench-adapters/local_batch.py $(OUT)/manifest/manifest.json.gz $(OUT)/result --seconds 3500 --security $(ROUTE_MODEL)

# Phase 6 full AgentDojo (v1.2.2, 4 suites, important_instructions), one resumable output directory.
#   make security-full-prepare ROUTE_MODEL=qwen3-8b-awq OUT=.tools/sec/full [SAMPLE=0.3] [POLICIES=provenance,all-prov]
#   make security-full-run ROUTE_MODEL=qwen3-8b-awq OUT=.tools/sec/full [WORKERS=12]   (GPU; rerun to resume)
WORKERS ?= 12
security-full-prepare:
	cd $(ROOT) && $(BENCH_PY) services/bench-adapters/security_plan.py agentdojo-full $(ROUTE_MODEL) $(OUT)/spec.json $(if $(SAMPLE),--sample-fraction $(SAMPLE),) $(if $(POLICIES),--policies $(POLICIES),)
	cd $(ROOT) && $(BENCH_PY) services/bench-adapters/security_matrix.py prepare-full --input $(OUT)/spec.json --output $(OUT)/manifest.json.gz

security-full-run:
	cd $(ROOT) && python3 scripts/gpu_run.py --local-only --timeout-seconds 14400 -- \
	  $(BENCH_PY) services/bench-adapters/local_batch.py $(OUT)/manifest.json.gz $(OUT)/result --seconds 13800 --security-full $(ROUTE_MODEL) --workers $(WORKERS)

# Task 9 judge: prompt versions v1 and v2 (or VERSIONS=v1,v2,v3) over SAMPLES (.jsonl) on one local model (GPU).
#   JUDGE_WORKERS=8 verdicts in flight; JUDGE_SECONDS up to 13800 (the 4-hour GPU job limit).
JUDGE_WORKERS ?= 1
JUDGE_SECONDS ?= 3500
judge-run:
	cd $(ROOT) && python3 scripts/gpu_run.py --local-only --timeout-seconds $$(( $(JUDGE_SECONDS) + 100 )) -- \
	  $(BENCH_PY) services/bench-adapters/local_batch.py $(SAMPLES) $(OUT) --seconds $(JUDGE_SECONDS) --judge $(ROUTE_MODEL) \
	  --workers $(JUDGE_WORKERS) $(if $(VERSIONS),--judge-versions $(VERSIONS),) $(if $(RUBRIC),--judge-rubric $(RUBRIC),)

judge-summary:
	cd $(ROOT) && tsx packages/evals/src/judgeRun.ts summarize $(REFERENCE) $(OUT)

# Task 14 faithfulness. OUT is a fresh directory; RECORDS the stored 200-answer run's records.jsonl.gz.
#   make faithfulness-prepare OUT=.tools/faith RECORDS=.tools/task14-answer-20261026b/records.jsonl.gz
#   make faithfulness-answer OUT=.tools/faith      (GPU: Qwen3-8B-AWQ, the stored run's answer model)
#   make faithfulness-judge OUT=.tools/faith       (GPU: selected Task 9 judge, prompt v1)
#   make faithfulness-summary OUT=.tools/faith
ANSWER_MODEL ?= qwen3-8b-awq
JUDGE_MODEL ?= qwen2.5-14b-instruct-awq
faithfulness-prepare:
	cd $(ROOT) && tsx packages/rag/src/faithfulnessRun.ts prepare $(RECORDS) $(OUT)/prepared.jsonl

# Phase 7: rows from the stored phase 6 retrieval run (before = hybrid top-10, after = top-20 LLM rerank top-10).
#   make faithfulness-prepare-runs OUT=.tools/faith-20261031 RUNS=.tools/rag-beir/runs/kubernetes.json.gz
faithfulness-prepare-runs:
	mkdir -p $(OUT) && cd $(ROOT) && tsx packages/rag/src/faithfulnessRun.ts prepare-runs $(RUNS) $(OUT)/prepared.jsonl

faithfulness-answer:
	cd $(ROOT) && python3 scripts/gpu_run.py --local-only --timeout-seconds 3600 -- \
	  $(BENCH_PY) services/bench-adapters/local_batch.py $(OUT)/prepared.jsonl $(OUT)/answer --seconds 3500 --rag-answer $(ANSWER_MODEL)

faithfulness-samples:
	cd $(ROOT) && tsx packages/rag/src/faithfulnessRun.ts samples $(OUT)/prepared.jsonl $(OUT)/answer/answers.jsonl $(OUT)/samples.jsonl

faithfulness-judge:
	cd $(ROOT) && tsx packages/rag/src/faithfulnessRun.ts samples $(OUT)/prepared.jsonl $(OUT)/answer/answers.jsonl $(OUT)/samples.jsonl
	cd $(ROOT) && python3 scripts/gpu_run.py --local-only --timeout-seconds 3600 -- \
	  $(BENCH_PY) services/bench-adapters/local_batch.py $(OUT)/samples.jsonl $(OUT)/judge --seconds 3500 \
	  --judge $(JUDGE_MODEL) --judge-rubric kubernetes-grounding-binary-v1 --judge-versions v1

faithfulness-summary:
	cd $(ROOT) && tsx packages/rag/src/faithfulnessRun.ts summarize $(OUT)/prepared.jsonl $(OUT)/answer/answers.jsonl $(OUT)/judge/v1.jsonl

# Phase 6 retrieval (packages/rag/src/beirRun.ts) over data/rag/beir/spec.json.
#   make rag-beir STAGE=bm25|retrieve|summarize OUT=.tools/rag-beir          (CPU)
#   make rag-beir-gpu STAGE=embed|rerank-ce|rerank-llm OUT=.tools/rag-beir  (GPU, under the shared flock)
BEIR_SPEC ?= data/rag/beir/spec.json
rag-beir:
	cd $(ROOT) && tsx packages/rag/src/beirRun.ts $(STAGE) $(BEIR_SPEC) $(OUT)

rag-beir-gpu:
	cd $(ROOT) && python3 scripts/gpu_run.py --local-only --timeout-seconds 3600 -- \
	  $(BENCH_PY) services/bench-adapters/local_batch.py $(BEIR_SPEC) $(OUT) --seconds 3500 --rag-beir $(STAGE)

# Same comparison as .github/workflows/eval-gate.yml. Exit 0 pass, 1 fail.
BASELINE ?= data/regression/baseline-qwen3-8b-awq.json
CANDIDATE ?= data/regression/candidate-report.json
gate:
	cd $(ROOT) && tsx packages/evals/src/gateCli.ts $(BASELINE) $(CANDIDATE)

resource-check:
	python3 scripts/resource_check.py compose
	python3 scripts/resource_check.py disk
