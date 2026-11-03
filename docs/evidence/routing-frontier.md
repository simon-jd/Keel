# Task 10: routing frontier and regression-gate drill (2026-10-27)

Population: BFCL v4 `simple_python`, all 400 tasks (BFCL pin `6ea5797`), seed 0, temperature 0,
original BFCL AST scorer with `underscore_to_dot` (see "Scorer fix"). Local vLLM on the shared
RTX 4090 under `/var/tmp/rtx4090.lock`, `--gpu-memory-utilization 0.80`, one request at a time.
Every call goes through `services/api` → `packages/models`.

- cheap: `Qwen/Qwen2.5-0.5B-Instruct` @ `7ae5576`, bf16
- strong: `Qwen/Qwen3-8B-AWQ` @ `4da05a8`, AWQ int4, thinking off

Cost axis: model GPU time = sum of call latencies (GPU-seconds). API price is $0 for local
models; no GPU dollar rate is assumed.

## Frontier

| Policy | Successes | Success rate | Escalated | GPU-s | Tokens | On frontier |
|---|---:|---:|---:|---:|---:|---|
| cheap-only | 304 | 76.00% | 0 | 72.9 | 123,924 | yes |
| cheap-first (schema verifier) | 315 | 78.75% | 12 | 77.3 | 127,467 | yes |
| strong-only | 381 | 95.25% | 0 | 143.2 | 119,850 | yes |
| cheap-first (oracle, not deployable) | 387 | 96.75% | 96 | 107.9 | 153,311 | — |

cheap-first is replayed from the two runs: at temperature 0 the strong answer does not depend on
whether the cheap model ran first, so an escalated task costs its recorded cheap call plus its
recorded strong call. The schema verifier sees only what the model saw (tool schemas and the
cheap output): call present, known function, JSON arguments, required/unknown parameters, types,
enums. It never uses the answer key.

Verifier on the cheap model's 400 answers: 304 correct, all accepted; 96 wrong, **12 rejected
and 84 accepted**. Most cheap errors are wrong values inside schema-valid calls
(`value_error:string` 31, `missing_optional` 31). The verifier buys +2.75 pp for +6% GPU time.
The oracle row is the ceiling for a better verifier: 96.75% at 75% of strong-only GPU time, above
strong-only because the 0.5B model is right on some tasks the 8B model gets wrong.

## Gate drill: delete tool descriptions

Candidate prompt change: every function and parameter description sent to the model is blanked
(`no-tool-descriptions` variant; scoring still uses the original entry). Same model, same 400 tasks.

| Run | Successes | GPU-s | Gate vs baseline |
|---|---:|---:|---|
| baseline (`data/regression/baseline-qwen3-8b-awq.json`) | 381 / 400 | 143.2 | `{"pass":true,"reasons":[]}` (self) |
| no tool descriptions (`data/regression/candidate-report.json`) | 323 / 400 | 144.9 | `{"pass":false,"reasons":["SUCCESS_DROP_EXCEEDS_2PP"]}` |

`make gate` runs the same `gateCli.ts` command as `.github/workflows/eval-gate.yml` and exits 1
on the candidate. The workflow has never run on hosted CI: the repository has no remote.

## Scorer fix

The Keel BFCL adapter sends tools through BFCL's OpenAI-style compilation, which renames
`math.factorial` to `math_factorial`. The adapter registered its model config without
`underscore_to_dot=True`, as upstream sets for such FC models, so correct calls to dotted
functions were scored `wrong_func_name`. Rescoring the stored historical Qwen3-8B-AWQ outputs
(Task 8 matrix `0dbe966`) with the fixed scorer: **224/400 recorded → 381/400**; 157 verdicts
change. A fresh run under the fixed scorer gives 381/400 again. The old 176-item "real failure"
regression index (`data/regression/bfcl-failures.jsonl`) is therefore mostly scorer artifacts. It is kept
byte-for-byte as history. The gate now uses the corrected baseline above.

Regression population: the gate compares all 400 tasks. Across the three runs, 146 tasks failed in
at least one (strong 19, cheap 96, no-descriptions 77), listed in `routing-frontier/cases.jsonl`
and the candidate report.

## Raw outputs (`docs/evidence/routing-frontier/`)

- `frontier.json`: models, verifier confusion counts, the four policy rows
- `cases.jsonl`: per task: cheap/strong success, verifier verdict and reason, GPU ms
- `rescore-qwen3-8b-awq-0dbe966.json`: historical rescore, changed task ids
- `gate-no-tool-descriptions.txt`, `gate-unchanged-control.txt`: `make gate` output
- `run-*.log`: batch stdout (vLLM ready, per-job status/latency, cleanup with peak RSS and disk)

Reproduce: `make bfcl-prepare MANIFEST=… ROUTE_MODEL=qwen2.5-0.5b-instruct|qwen3-8b-awq [VARIANT=no-tool-descriptions]`,
`make bfcl-run MANIFEST=… RESULTS=…`, then `services/bench-adapters/routing_frontier.py frontier|report|rescore`.
Peak batch RSS 3.66–3.78 GB; each run about 2–3 minutes of GPU lock time.
