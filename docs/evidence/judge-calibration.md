# Task 9: judge calibration

## 2026-11-05: against relabelled human labels (supersedes the 2026-10-29 labels)

The 2026-10-29 human labels (last section) were judged not good enough, so both blind workbooks of
the same frozen cohort (cohortHash `c48c6dff…`, rubric `bfcl-action-v1`) were labelled again by other
people: primary 300 by **Tate** (277 pass / 23 fail), secondary 100 by **junrui** (94 pass / 6 fail).
junrui is the 2026-10-29 primary rater, so the 100 secondary items were not new to that rater.

**Conversion.** The returned workbooks have the `samples` and hidden `meta` sheets but no `说明` sheet,
so they record neither a rater nor a save time. `meta` was checked first (rubricVersion and cohortHash
equal the frozen cohort). Each `samples` sheet was then saved as UTF-8 CSV and converted through the
script's CSV route, with the rater names given by the user: `scripts/label_workbook.py primary …
--rater Tate` and `… secondary … --rater junrui --primary <converted primary>`. Result: 300/300 and
100/100 IDs in cohort order, no blanks, only pass/fail, two different raters, and both files pass the
import validator (`validateHumanLabels`). `annotatedAt` is therefore the conversion time
(2026-11-06T04:42Z), not the labelling time. The 2026-10-29 import (both label files, the `imports/`
journal and the converted files) was moved unchanged to `.tools/annotation-task9/superseded-import-20261029/`
(private); nothing was deleted. On 2026-11-06 both files were imported with `label.ts import`
(transactions 000001/000002 of the new journal); `label.ts coverage` reports 300/300 and 100/100,
κ 0.9178. All scores below are computed from the converted files.

**Human–human**, on the 100 paired IDs (`pairLabels` + `agreement`, the code behind `label.ts coverage`):
99/100 agree, **κ = 0.918** (po .99, pe .8784; bootstrap 95% 0.662–1.000 with `judge_compare.py`),
matrix in fail/pass order (rows Tate) `[[6,1],[0,93]]`. The one disagreement is a strict bound:
"under $100" sent as `price: 100`, a maximum that admits exactly 100 (Tate fail, junrui pass).

**Judges, not rerun.** Every stored judge configuration with verdicts on all 300 items, scored against
Tate's 300 with `judge_compare.py score` (an invalid verdict counts as wrong; there are none);
`judgeRun.ts summarize` gives the same κ and matrices. κ with bootstrap 95%, proportions with Wilson 95%.

| Judge (stored run) | κ | Agreement | Fail precision | Fail recall |
|---|---|---|---|---|
| **Qwen3-14B-AWQ thinking v3 (selected; 2026-10-31)** | **0.396 (0.169–0.605)** | 281/300 (90.3–95.9%) | 7/10 (39.7–89.2%) | 7/23 (15.6–50.9%) |
| Qwen3-14B thinking v2 | 0.323 (0.094–0.543) | 281/300 | 5/6 | 5/23 |
| Qwen3-14B thinking v1 | 0.139 (−0.012–0.336) | 278/300 | 2/3 | 2/23 |
| Qwen3-14B non-thinking v1 / v2 / v3 | 0.037 / 0.033 / 0.018 | 255 / 245 / 250 of 300 | 3/28, 4/40, 3/33 | 3, 4, 3 of 23 |
| Qwen2.5-14B-Instruct-AWQ v1 (2026-10-27) | 0.272 (0.065–0.469) | 274/300 | 6/15 | 6/23 |
| Qwen2.5-14B-Instruct-AWQ v2 | 0.192 (0.024–0.371) | 265/300 | 6/24 | 6/23 |
| Qwen3-8B-AWQ v1 and v2 (2026-10-25; identical labels) | −0.033 (−0.053 to −0.012) | 271/300 | 0/6 | 0/23 |

Not included: the 2026-10-25 run that stopped after 77 of 300 verdicts (`INVALID_JUDGE_SCHEMA`); the
commercial-API attempt produced no verdicts.

**Selection unchanged.** The phase 7 rule selects on the balanced set and uses this set only for the
invalid-verdict cap (0 invalid here); `judge_compare.py select` with the new labels again picks thinking
v3 ([selection-recheck.json](judge-calibration-human-20261105/selection-recheck.json)). The older
Task 9 rule (highest κ on these human labels, `compareLabels`) would now pick Qwen2.5-14B v1 over v2
(v2 on the 2026-10-29 labels); that is an in-sample choice.

**Reading.** With 23 human fails instead of 5, the selected judge's κ (0.396) is close to its value on
the old labels (0.386) and far below human–human agreement (0.918). When it says fail it is right
7 times in 10, but it catches only 7 of 23 human fails (30%, against 126/200 checker fails on the
balanced set). Grouped by Tate's rationales, it misses most actions that fill in a value the request
never gave (a year, season, platform, database or table: 6 of 7 missed) and strict bounds sent as
inclusive ones (3 of 4). Thinking still matters (κ 0.14–0.40, against ≤ 0.04 without it), and the
Qwen3-8B judge catches none. The judge must not gate anything on its own.

**Limits.**
- Class balance: 23/300 fails (7.7%), 7/100 on the paired subset. One more fail caught moves fail
  recall by 4 points; one more human–human disagreement would put κ at about 0.82–0.85.
- Selection: thinking v3 was chosen on the balanced checker set, not on these labels, but prompt v3
  ("be strict") was written after the judge had been seen to be lenient on these 300 items. Choosing
  among the rows above by these numbers would be in-sample.
- Single pass: each label set is one person's single pass with no adjudication; each judge row is
  one stored run (temperature 0, seed 0; vLLM batching is not bit-reproducible).
- junrui labelled the same 100 items on 2026-10-29. The rater names come from the user, not the
  workbook. Scope: 300 single-turn BFCL actions, nothing about τ², RAG or SaaS.

**Against the superseded labels** (context only): Tate vs Junrui (2026-10-29) on the 300: 282/300,
κ 0.339, all 18 differences Tate fail / Junrui pass; junrui now vs then on the 100: 96/100, κ 0.485
(4 new fails); Tate vs Kenny on the 100: 95/100, κ 0.640.

Evidence ([judge-calibration-human-20261105/](judge-calibration-human-20261105/)): `human-agreement.json`
(coverage, counts, the human–human matrix and the comparisons with the superseded labels; per-item
human labels stay private), `human-human-score.json` (bootstrap), `scores.json` (`judge_compare.py
score`, all ten rows), `summary.json` (`judgeRun.ts summarize` per model), `selection-recheck.json`,
`qwen3-8b-awq-20261025/v{1,2}.jsonl` (the 8B predictions, extracted from the private run files).
Reproduce (CPU only):

```sh
python3 scripts/judge_compare.py score .tools/annotation-task9/returned-primary-20261105.jsonl NAME=<verdicts.jsonl> …
tsx packages/evals/src/judgeRun.ts summarize .tools/annotation-task9/returned-primary-20261105.jsonl <dir of v1/v2/v3.jsonl>
python3 scripts/judge_compare.py select <phase 7 spec.json, human_reference = the converted primary>
```

## Phase 7 candidates and selection rule (written 2026-10-31, before any candidate run)

Written and committed before the Qwen3 model was served for the first time; no candidate verdict
existed when this section was written. Results go in the next section, without changing this one.

**Current judge** (the baseline to beat): Qwen2.5-14B-Instruct-AWQ @ `5395358`, prompt v1, non-thinking,
max 1,024 tokens. Balanced cohort κ 0.240, agreement 248/400, fail precision 53/58, fail recall 53/200;
human primary κ 0.077 (v1) / 0.113 (v2). Its stored verdicts are rescored with the same script; it is not rerun.

**Candidates** (6): `Qwen/Qwen3-14B-AWQ` @ `31c69efc29464b6bb0aee1398b5a7b50a99340c3` (official Qwen AWQ,
Apache-2.0, 9.99 GB, LFS sha256 of both shards checked after download) ×
- mode: **non-thinking** (`enable_thinking=false`, max 1,024 tokens, as the current judge) and **thinking**
  (`enable_thinking=true`, vLLM `--reasoning-parser qwen3`; only the final content after the reasoning is
  parsed; max 4,096 tokens in total, the API's existing cap; a run that hits the cap without a verdict is invalid);
- prompt: **v1**, **v2** (unchanged) and one new **v3**, whose full text is fixed here:
  > Be strict. Check each requirement of the rubric separately before deciding: for a tool action, every
  > requested operation has exactly one matching call, each call uses the right tool, and every argument
  > value is the one the request states or clearly implies (same entity, number, unit and format); for an
  > answer, every claim is supported by the supplied data. Label fail if any check fails or cannot be
  > confirmed from the supplied data; label pass only if every check holds. Name the decisive check in rationale.

  (appended to the same guard text as v1/v2, rubric `bfcl-action-v1` unchanged). Temperature 0, seed 0 for
  all six, including thinking mode (Qwen recommends sampling for thinking; greedy is kept for determinism and
  noted as a possible handicap). Up to 8 verdicts in flight (vLLM batching; not bit-reproducible).

**Sets**: (1) the frozen balanced BFCL cohort, cohortHash `374fb784…`, 400 items, reference = BFCL checker
(objective, not human); (2) the 300 human primary labels (Junrui, cohortHash `c48c6dff…`, 295 pass / 5 fail).

**Metrics**, positive class = fail: κ (with a 2,000-resample bootstrap 95% interval, seed 0), raw agreement,
fail precision and fail recall with Wilson 95% intervals, and invalid-verdict count. **An invalid or missing
verdict is scored as wrong** (the label opposite to the reference) in every metric, so no candidate gains by
not answering.

**Selection rule**, applied only to set (1):
1. Eligible: at most 8/400 invalid verdicts on set (1) and at most 6/300 on set (2).
2. Among eligible candidates take the highest κ on set (1). If two are within 0.01 κ, take the higher fail
   recall, then non-thinking over thinking (cheaper), then the lexically smaller prompt version.
3. The winner **replaces the current judge only if** its κ ≥ 0.290 (current 0.240 + 0.05, about one standard
   error at n = 400) **and** its fail precision ≥ 0.80. Otherwise the current judge stays and that is reported.
4. Set (2) is reported for every candidate but is not used to select: with 5 human fails, one fail more or less
   moves recall by 20 points (Wilson interval for 1/5 is 4–62%).

The selected judge (or the kept current one) is the "item-1 judge" used for the grounding validation and the
Kubernetes faithfulness rerun (Task 14).

## Phase 7 results (2026-10-31): Qwen3-14B-AWQ, thinking, prompt v3 replaces the current judge

Two GPU jobs (rule and v3 committed first in `08d7525`): non-thinking 416 s, thinking 1,110 s holding the lock,
700 samples × 3 prompts each, 8 in flight, peak batch RSS 4.9 / 3.4 GB. Load average 4.4–10.4 on 32 CPUs with
other projects' work running; latencies include queueing behind 7 other verdicts. $0. The current judge was
not rerun: its stored verdicts were rescored with the same script and reproduce κ 0.240 / 0.077 / 0.113.

**Set 1: balanced BFCL cohort** (400, reference = BFCL checker, not human). κ with bootstrap 95%; others k/n with
Wilson 95%; invalid verdicts counted as wrong.

| Judge | Invalid | κ | Agreement | Fail precision | Fail recall |
|---|---:|---|---|---|---|
| Qwen2.5-14B v1 (current) | 0 | 0.240 (0.175–0.308) | 248/400 (57.2–66.6%) | 53/58 (81.4–96.3%) | 53/200 (20.9–33.0%) |
| Qwen2.5-14B v2 | 0 | 0.240 (0.171–0.313) | 248/400 | 57/66 | 57/200 |
| Qwen3-14B non-thinking v1 | 0 | 0.355 (0.267–0.437) | 271/400 | 96/121 (0.793) | 96/200 |
| Qwen3-14B non-thinking v2 | 0 | 0.390 (0.298–0.483) | 278/400 | 120/162 (0.741) | 120/200 |
| Qwen3-14B non-thinking v3 | 0 | 0.345 (0.251–0.438) | 269/400 | 109/149 (0.732) | 109/200 |
| Qwen3-14B thinking v1 | 0 | 0.550 (0.475–0.625) | 310/400 | 112/114 (0.982) | 112/200 |
| Qwen3-14B thinking v2 | 0 | 0.575 (0.499–0.646) | 315/400 | 117/119 (0.983) | 117/200 |
| **Qwen3-14B thinking v3 (selected)** | 2 | **0.595 (0.518–0.670)** | 319/400 (75.5–83.4%) | 126/133 (89.5–97.4%) | 126/200 (56.1–69.4%) |

**Set 2: human primary labels** (300, Junrui; 295 pass / 5 fail). Not used for selection. These are
the 2026-10-29 labels, superseded on 2026-11-05; for the relabelled set see the first section.

| Judge | Invalid | κ | Agreement | Fail precision | Fail recall |
|---|---:|---:|---|---|---|
| Qwen2.5-14B v1 (current) | 0 | 0.077 | 282/300 | 1/15 | 1/5 (3.6–62.4%) |
| Qwen2.5-14B v2 | 0 | 0.113 | 275/300 | 2/24 | 2/5 |
| Qwen3-14B non-thinking v1 / v2 / v3 | 0 | −0.029 / −0.031 / −0.030 | 267 / 255 / 262 of 300 | 0/28, 0/40, 0/33 | 0/5 each |
| Qwen3-14B thinking v1 / v2 | 0 | 0.241 / 0.352 | 294 / 293 of 300 | 1/3, 2/6 | 1/5, 2/5 |
| **Qwen3-14B thinking v3** | 0 | **0.386** | 291/300 (94.4–98.4%) | 3/10 (10.8–60.3%) | 3/5 (23.1–88.2%) |

**Selection** (`judge_compare.py select`, [selection.json](judge-calibration-phase7/selection.json)): all six
eligible (most invalid: thinking v3, 2/400 `INVALID_JUDGE_SCHEMA`); highest κ is thinking v3 (0.595, no other
within 0.01); κ ≥ 0.290 and fail precision 0.947 ≥ 0.80, so it **replaces** the current judge. Its human κ (0.386)
is about the human–human κ (0.380), but rests on 5 fails.

**Reading.** Thinking is what helps: the same checkpoint without thinking raises recall but loses precision
(0.73–0.79, under the 0.80 bar) and catches none of the 5 human fails; with thinking, κ more than doubles and
precision stays ≥ 0.95. The stricter v3 adds recall in thinking mode (126 vs 112–117 of 200). The judge still
misses 74 of 200 checker fails, and thinking costs ~3.5× the output tokens (215k vs 59k per 700 verdicts;
p50 3.6 s vs 1.3 s per verdict at 8 in flight). Greedy decoding was used in thinking mode (Qwen recommends
sampling); no repetition loop hit the 4,096-token cap. The selection is in-sample on set 1.

Raw outputs ([judge-calibration-phase7/](judge-calibration-phase7/)): `qwen3-14b{,-thinking}-v{1,2,3}.jsonl.gz`
(700 rows each: 400 cohort + 300 human ids; label, rationale, latency, usage), `spec.json`, `selection.json`,
`qwen3-14b-awq-files.json` (model files vs publisher ids). Reproduce: `make judge-run ROUTE_MODEL=qwen3-14b-awq[-thinking]
SAMPLES=<cohort + human samples> OUT=… VERSIONS=v1,v2,v3 JUDGE_WORKERS=8`, then `scripts/judge_compare.py select spec.json`.

## Balanced cohort against the BFCL checker (2026-10-30)

**The reference here is the official BFCL AST checker verdict on each output: objective, not human.**
It measures whether the judge can tell checker-passing from checker-failing function calls; it is not
a human calibration, and the checker itself has strictness of its own (see below).

**Cohort** (`data/labels/balanced-bfcl-20261030/`, frozen and committed in `cb5778a` before any judge
run): 400 single-turn BFCL v4 outputs, 4 categories × (50 checker pass + 50 checker fail), selected by
sha256 order under protocol `keel-bfcl-balanced-cohort-20261030` (`scripts/balanced_cohort.py`),
cohortHash `374fb784a16931a85633eaa671bee00e24b83f93179b248e0982859db632f7f0`, `freeze.json` lists all ids
and file hashes. Population: the existing `simple_python` runs (Qwen2.5-0.5B 304/400, Qwen3-8B-AWQ 381/400)
plus new runs of the other non-live single-turn AST categories with the same two models and the same
pinned BFCL (`multiple`, `parallel`, `parallel_multiple`, 200 each; Qwen2.5-0.5B 146 / 96 / 84 pass,
Qwen3-8B-AWQ 187 / 185 / 179). The existing outputs alone held only 115 checker fails, all in one
category, which is too few for 200 fails stratified by category; no other model was added. Outputs
were blinded exactly as the human cohort; 14 checker-fail outputs with invalid tool calls cannot be
shown as one action and were excluded (counted in `freeze.json`). Mix: 0.5B 174 fail / 110 pass,
8B 26 fail / 90 pass.

**Judge**: Qwen2.5-14B-Instruct-AWQ @ `5395358`, prompts v1 and v2 (`packages/evals/src/judge.ts`,
unchanged), rubric `bfcl-action-v1`, temperature 0, seed 0, strict `parseVerdict`; one GPU job, 810 s
holding the lock, peak batch RSS 3.4 GB; latency p50/p95 870/1,598 ms (v1), 887/1,558 ms (v2); tokens
223,300 (v1), 231,635 (v2); load average 2.8–5.9 on 32 CPUs with other projects running; $0.

| Prompt | Valid | κ vs checker | Raw agreement | Fail precision | Fail recall | Matrix (rows checker fail / pass; cols judge fail / pass) |
|---|---:|---:|---:|---:|---:|---|
| **v1 (selected)** | 400/400 | **0.240** | 248/400 (62.0%) | 53/58 (91.4%) | 53/200 (26.5%) | [[53, 147], [5, 195]] |
| v2 | 400/400 | 0.240 | 248/400 (62.0%) | 57/66 (86.4%) | 57/200 (28.5%) | [[57, 143], [9, 191]] |

Selection rule (unchanged, `compareLabels`): complete coverage, highest κ, ties broken lexically. Both
versions are complete with κ = 0.24 (with a 200/200 reference, chance agreement is exactly 0.5), so the
tie goes to **v1**. `judgeRun.ts summarize` gives the same matrices and selection
([summary.json](judge-calibration-balanced-20261030/summary.json)).

Per category (v1; v2 in brackets), checker fails caught of 50, κ:
simple_python 9 [11], 0.14 [0.08]; multiple 14 [14], 0.26 [0.28]; parallel 19 [21], 0.34 [0.38];
parallel_multiple 11 [11], 0.22 [0.22].

**Disagreements** (152 for each version, 143 shared; full list with id, category, model, task, checker
error type and judge label in [report.json](judge-calibration-balanced-20261030/report.json)):
- Checker fail, judge pass (v1 147, v2 143). By category (v1): simple_python 41, parallel_multiple 39,
  multiple 36, parallel 31. By checker error (v1): `parallel_function_checker_no_order:cannot_find_match`
  53, `value_error:string` 24, `simple_function_checker:missing_optional` 22, `wrong_count` 17,
  `value_error:others` 12, `value_error:list/tuple` 8, `type_error:nested` 5, other 6. 124 of the 147 are
  Qwen2.5-0.5B outputs.
- Checker pass, judge fail: v1 5 (parallel 2, multiple 1, simple_python 2), v2 9 (simple_python 7, parallel 2).
- **Formatting-only checker failures (noted, not relabelled):** 7 of the v1 disagreements are checker
  fails whose call matches a possible answer after normalizing case/punctuation/whitespace, numeric type
  and dotted names (`report.json` → `formattingOnly`; e.g. `simple_python_13`, `simple_python_87`,
  `simple_python_103`: `type_error:nested`, an int where the answer lists floats). The 22
  `missing_optional` cases (the checker requires a parameter the function schema marks optional) are
  also strictness of the checker rather than an obviously wrong call. They keep the checker label.

**Reading.** On a balanced set, κ is stable at 0.24 for both prompts, but the judge is lenient: when it
says *fail* it is usually right (86–91%), yet it catches only about a quarter of checker failures,
mostly missing wrong argument values and wrong/missing calls in parallel outputs. Next to the human
results below (v1 0.077 / v2 0.113 on a 5-fail cohort), this confirms that the low human κ came mainly
from the tiny fail count, and that the judge's real weakness is fail recall. It should not gate anything.

Raw outputs ([judge-calibration-balanced-20261030/](judge-calibration-balanced-20261030/)):
`qwen2.5-14b-v{1,2}.jsonl` (per sample: id, label, rationale, latency, usage), `report.json`
(`scripts/judge_balanced_report.py`), `summary.json`, `bfcl-*-categories.jsonl` + `bfcl-categories-summary.json`
(the new BFCL runs, one row per job), `run-events.jsonl`, `load.txt`. Reproduce:
`make bfcl-prepare … BFCL_CATEGORIES=multiple,parallel,parallel_multiple`, `make bfcl-run … MAX_JOBS=600`,
`scripts/balanced_cohort.py …`, `make judge-run ROUTE_MODEL=qwen2.5-14b-instruct-awq SAMPLES=…/samples.jsonl OUT=…`,
`scripts/judge_balanced_report.py <cohort> <judge-out>`.

## Earlier: against sub-agent reference labels (2026-10-27) and human labels (2026-10-29), unchanged

**The reference is not human.** The 300 reference labels were written by a sub-agent
(`origin: subagent`, rubric `bfcl-action-v1`; a second sub-agent relabelled 100 of them, AI–AI
κ = 0.754). Human labels: 0. Every κ below is judge-vs-sub-agent agreement, not judge-vs-human
calibration.

Samples: the 300 frozen Task 9 BFCL action samples (`.tools/annotation-task9/primary.blind.jsonl`,
private); reference 280 pass / 20 fail. Judge: `Qwen/Qwen2.5-14B-Instruct-AWQ` @ `5395358`, local
vLLM on the shared RTX 4090 (flock, 0.80), through `services/api` → `packages/models`, temperature 0,
seed 0, max 1024 tokens, no response-format constraint, strict `parseVerdict`. Prompt versions
`v1` / `v2` from `packages/evals/src/judge.ts`, unchanged.

| Judge | Prompt | Valid verdicts | κ | Raw agreement | Ref pass → judge fail | Ref fail → judge pass | Ref fail caught |
|---|---|---:|---:|---:|---:|---:|---:|
| Qwen2.5-14B-Instruct-AWQ | **v1 (selected)** | 300/300 | **0.242** | 275/300 (91.7%) | 10 | 15 | 5/20 |
| Qwen2.5-14B-Instruct-AWQ | v2 | 300/300 | 0.167 | 266/300 (88.7%) | 19 | 15 | 5/20 |
| Qwen3-8B-AWQ (2026-10-25, earlier run) | v1 / v2 | — | −0.032 / −0.032 | — | — | — | — |

Selection rule (predeclared in `compareLabels`): every version must have complete coverage and a
defined κ; pick the highest κ, ties broken lexically. Both versions were complete; **v1 is selected**.
This is an in-sample choice on the same 300 items, not a held-out estimate.

Reading: the 14B judge is far better than the 8B one (κ −0.03 → 0.24), but κ 0.24 is only "fair"
agreement. With 20 reference fails, the judge catches 5. It should not gate anything on its own,
and its pass rates are optimistic. Faithfulness scoring (Task 14) can use v1 if it states this limit.

Cost: API $0 (local). Latency per verdict p50 831 ms / p95 1,234 ms (v1), 850 / 1,208 ms (v2);
tokens 121,573 (v1), 127,683 (v2). The whole run (vLLM start + 600 calls) held the GPU lock for 559 s,
peak batch RSS 4.0 GB.

## 2026-10-29: against human labels (superseded on 2026-11-05)

**Superseded** by the 2026-11-05 relabel (first section). Kept unchanged for the record; these labels
were moved aside, not deleted.

The user's returned workbooks were converted (`scripts/label_workbook.py`, `annotatedAt` = each
workbook's last save time) and imported with `label.ts import` (transactions 000001/000002):
primary 300 by Junrui (295 pass / 5 fail), secondary 100 by Kenny (92 / 8). Coverage 300/300 and
100/100 ([coverage.json](judge-calibration-human-20261029/coverage.json)).

Human–human, on the 100 paired IDs: 94/100 agree, **κ = 0.380** (po .94, pe .9032), matrix in
fail/pass order (rows Junrui) `[[2,0],[6,92]]`: all six disagreements are Junrui pass, Kenny fail
(unit conversion, rates written as decimals, an unrequested optional value, exclusive year bounds).

The judge was **not rerun**: the same 2026-10-27 Qwen2.5-14B-Instruct-AWQ outputs
(`judge-calibration/qwen2.5-14b-v{1,2}.jsonl`) were scored against the primary human labels with
`judgeRun.ts summarize` ([summary.json](judge-calibration-human-20261029/summary.json)):

| Prompt | κ vs human | Raw agreement | Human pass → judge fail | Human fail → judge pass | Human fail caught |
|---|---:|---:|---:|---:|---:|
| v1 | 0.077 | 282/300 (94.0%) | 14 | 4 | 1/5 |
| v2 | 0.113 | 275/300 (91.7%) | 22 | 3 | 2/5 |

The predeclared rule (complete coverage, highest κ) now selects **v2**; against the sub-agent
reference it selected v1. Both are in-sample. With only 5 human fails out of 300 (1.7%), κ moves
a lot with one item, so neither version is calibrated: the judge must not gate anything. For
comparison, the sub-agent reference agrees with Junrui on 283/300 (κ 0.30) and with Kenny on 94/100
(κ 0.59); judge v1 vs Kenny is κ 0.26.

Raw outputs (`docs/evidence/judge-calibration/`): `qwen2.5-14b-v{1,2}.jsonl` (per sample: id, label,
rationale, latency, usage), `summary.json` (`judgeRun.ts summarize`: confusion, κ, selection),
`run.log`. Reproduce: `make judge-run ROUTE_MODEL=qwen2.5-14b-instruct-awq SAMPLES=… OUT=…` then
`make judge-summary REFERENCE=.tools/annotation-subagent-20261025/primary.agent-labels.jsonl OUT=…`.
