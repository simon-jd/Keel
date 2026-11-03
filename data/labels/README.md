# Human annotation files

`primary.jsonl` and `secondary.jsonl` are deliberately empty real-label templates; real human
labels stay private in `.tools/annotation-task9/`. On 2026-10-29 the user's two returned workbooks
were imported there: primary 300 (rater Junrui), secondary 100 (rater Kenny); see
`docs/evidence/judge-calibration.md`. The user has explicitly accepted the existing attributed
subagent labels for this round through the separate agent-reference commands below.
The human route stays strict. Never copy AST verdicts, model judges, agent answers or
the disposable test fixtures into them as human evidence. A human rater must read
the original blind input/tool definitions/action and decide each pass/fail label.
The `origin: human` field is an attestation, not independent proof of who labeled it.

Prepare once, CPU only, from the fixed original local BFCL material:

```sh
PYTHONDONTWRITEBYTECODE=1 .tools/bench-venv/bin/python scripts/annotation_material.py prepare
PYTHONDONTWRITEBYTECODE=1 .tools/bench-venv/bin/python scripts/annotation_material.py verify
node_modules/.bin/tsx services/api/src/routes/label.ts coverage
node_modules/.bin/tsx services/api/src/routes/label.ts annotate primary human-one
node_modules/.bin/tsx services/api/src/routes/label.ts annotate secondary human-two
```

Preparation fails on an existing directory to preserve frozen selection. Already
prepared material is at `.tools/annotation-task9`. Full inputs/actions and every
label/run/import artifact stay there: directories 0700, files 0600, Git ignored.
Do not redirect or record the interactive annotation display into public logs.
Give the independent second human **only** `secondary.blind.jsonl`, the fixed
rubric below and a blank label template/schema; do not share primary labels,
source audit, AST ground truth/verdicts or judge predictions. A separate operator
imports their returned private file. The local CLI displays neither rater's prior
labels nor predictions; separate human identities and physical access remain an
operator responsibility. The second human must attest a distinct rater ID.

Each nonempty imported line must exactly match `human-label.schema.json` and the
frozen cohort's IDs, rubric version and cohort hash (`cohort.json`). The timestamp
is the human annotation time in UTC ISO 8601 (ending in `Z`). A returned partial file can be placed at
`.tools/annotation-task9/returned-secondary.jsonl` with mode 0600, then imported:

```sh
node_modules/.bin/tsx services/api/src/routes/label.ts import secondary .tools/annotation-task9/returned-secondary.jsonl
```

The importer rejects duplicate/unknown IDs, mixed raters, primary/secondary rater
identity collisions, non-human origin, label changes, stale rubric/cohort hashes
and malformed timestamps. Partial imports explicitly report missing IDs; they do
not imply complete coverage. Reimporting the identical record is safe and audited.
Imports retain the exact submitted records, a full post-import snapshot, hash
chain and completion marker. If a crash leaves a final pending import with intact
journal files, `label.ts recover` checks the recorded before/after hashes and
finishes it. Missing/corrupt journals or a stale `.label-lock` stop for operator
inspection; never delete evidence to force progress.

Frozen rubric `bfcl-action-v1`:

> Assess the assistant action against the user request and the supplied tool
> definitions. Pass only if tool selection, required arguments, values and any
> answer are supported and satisfy the request. Fail incorrect, missing,
> unsupported or extraneous actions. Evaluate observable correctness only; do not
> assume tool execution succeeded. Explain the decisive evidence.

This is a 300-unit cohort of complete, distinct single-turn BFCL input/actions,
selected from 400 verified original local BFCL units. The secondary 100 are a
fixed subset. It does not calibrate tau2, RAG or real SaaS behavior. The versioned
canonicalization maps only output transport tool-call IDs to positional IDs and
preserves all business IDs inside arguments and complete input/tool definitions.
Primary order is ascending SHA256 of
`bfcl-single-turn-v1:primary:CONTENT_HASH`; secondary order uses
`bfcl-single-turn-v1:secondary:BLIND_ID`. Content/blind hashes and protocol text
are frozen before labels; private audit maps each blind ID to original provenance.

Model commands require a clean committed production tree and an **already
admitted local model/API lifecycle**; they never start it. The token argument is
an owned regular 0600 file path, never a credential value. Reproduction is exactly
five requests for the same first fixed cohort unit, rubric and selected prompt:

```sh
node_modules/.bin/tsx services/api/src/routes/label.ts reproduce v1 .secrets/benchmark-token local5-001
```

Reports are private `reproduce-local5-001.json` and its checkpointed `.pending.json`.
Keep the pending file even after completion: it preserves dispatched/completed
counts and partial/failure evidence. Never retry a used run name or hide a failed
request. Router retries may cause more physical attempts than logical requests;
per-call accounting preserves this. The controller must bound requests, enforce
existing GPU/disk/budget/cache limits and stop the model/API after the batch.
No reproduction or model calls were made by the implementation worker.

After 300 genuine primary labels, the operator can explicitly run each prompt
version against the same cohort (at most 300 logical requests per command):

```sh
node_modules/.bin/tsx services/api/src/routes/label.ts judge v1 .secrets/benchmark-token prompt-v1-001
node_modules/.bin/tsx services/api/src/routes/label.ts judge v2 .secrets/benchmark-token prompt-v2-001
node_modules/.bin/tsx services/api/src/routes/label.ts calibrate comparison-001 .tools/annotation-task9/judge-prompt-v1-001.json .tools/annotation-task9/judge-prompt-v2-001.json
```

Do not launch unlabeled bulk work. Run artifacts bind sample, rubric, prompt,
cohort, implementation, model alias/accounting, seed, temperature, run/call IDs,
usage/cost status, full judge action/verdict and raw-response/semantic hashes.
Unknown accounting remains unknown. No backend traces/export are requested.
Version comparison needs every declared version's predictions and genuine human
labels for the same exact IDs. Highest defined ordinary Cohen kappa wins; lexical
version order breaks ties. Missing or undefined agreement in any version blocks
selection. At least two versions are required. This is in-sample selection,
without a held-out performance claim. Human-human agreement uses exactly the
secondary 100 paired IDs, not a positional zip or a silent intersection.

## Returned workbooks → import JSONL (imported 2026-10-29)

The coordinator's blind workbooks (`Keel-BFCL-标注-主标注员.xlsx`, 300 units;
`Keel-BFCL-标注-第二标注员.xlsx`, 100 units) convert with `scripts/label_workbook.py`:

```sh
python3 scripts/label_workbook.py primary   RETURNED-主标注员.xlsx   .tools/annotation-task9/returned-primary.jsonl
python3 scripts/label_workbook.py secondary RETURNED-第二标注员.xlsx .tools/annotation-task9/returned-secondary.jsonl \
  --primary .tools/annotation-task9/returned-primary.jsonl
node_modules/.bin/tsx services/api/src/routes/label.ts import primary   .tools/annotation-task9/returned-primary.jsonl
node_modules/.bin/tsx services/api/src/routes/label.ts import secondary .tools/annotation-task9/returned-secondary.jsonl
```

It reads sheet `samples` (sample_id, label, rationale), the rater next to `标注人` on sheet `说明`
and the hidden sheet `meta` (rubricVersion, cohortHash, which must equal the frozen cohort).
Records get `origin: human`, `rubricVersion: bfcl-action-v1`, the frozen cohort hash, the sheet's
rater and `annotatedAt` = the workbook's last save time (`docProps/core.xml` `dcterms:modified`,
the latest moment the labels can be from) when it records one, else the conversion time in UTC;
the report's `annotatedAtSource` says which. Headers like `label\n(pass/fail)` are read by their
leading name, and an empty inline-string cell (as openpyxl saves it) reads as empty. The rationale is not exported: the schema allows no extra keys.
Blank labels are skipped and reported as missing; unknown/duplicate IDs, labels other than
pass/fail, a meta mismatch or a missing rater stop the conversion. A secondary file whose rater
matches the primary rater (case, width and spacing ignored) is rejected; the primary rater comes
from `--primary` (JSONL or workbook) or the already imported primary labels. The output is a new
0600 file; the script never imports. A `samples` sheet saved as UTF-8 CSV also works, with
`--rater NAME` (a CSV carries no rater or meta). The `.xlsx` is read with the Python standard
library (zipfile + XML) because openpyxl is not in any project environment.
Tests (`tests/resources/test_label_workbook.py`) use synthetic workbooks only.

## Accepted agent-reference round (2026-10-25)

The user explicitly substituted existing subagent labels for this round's human
reference. Use the explicit commands below; no new annotation or relabeling is
needed. The default `annotate`/`import`/`judge`/`calibrate` route remains human-only.
Agent records have `origin: subagent`, qualitative confidence and a rationale;
`inputSha256` must match the exact original blind JSONL line without its newline.
`agent-label.schema.json` documents their separate schema. UTC microseconds in
these original source records are preserved. They cannot pass the human validator.

`agent-import` verifies the frozen cohort/history/counts and the two fixed,
owned private original files under `.tools/annotation-subagent-20261025`, then
creates an exclusive `.tools/annotation-task9/agent-reference.json` audit. It does
not copy/rewrite source labels, human files or the three nonblind adjudications.
This import has already been performed once; use `agent-coverage` to verify it.
A repeated import fails without overwriting the audit.

```sh
node_modules/.bin/tsx services/api/src/routes/label.ts agent-import
node_modules/.bin/tsx services/api/src/routes/label.ts agent-coverage
node_modules/.bin/tsx services/api/src/routes/label.ts agent-calibrate pending-reference-only
```

The final command can report pending coverage with zero judge files; the existing
`pending-reference-only` report is already present. Use a new report name to
preserve it. Reports always retain `reference_origin=subagent`,
`human_evidence=false`, `human_reference_gate_fulfilled=false` and the distinct
`accepted_user_substitution` gate. Actual source coverage is 300/300 and 100/100.
This user-approved substitution satisfies this round's reference prerequisite;
it does not turn AI labels into human/gold correctness evidence.

Original primary labels: 280 pass /20 fail; secondary: 95 pass /5 fail. Exact-pair
AI-AI agreement is 97/100, matrix in fail/pass order `[[5,3],[0,92]]`,
Pe .878 and kappa 46/61 = .7540983606557374. Both sessions were reported as
`gpt-6.1-sol/high`, with temperature and per-call cost unknown. Session isolation
does not establish statistical independence. Three later nonblind adjudications
stay separate and never improve this original agreement or replace references.

Only the controller runs model commands after independent review and existing
GPU/resource/lifecycle admission. The weak reference is not included in prompts:
judges receive only original blind input/tools/action and the fixed rubric.

```sh
node_modules/.bin/tsx services/api/src/routes/label.ts agent-reproduce v1 TOKEN_FILE local5-001
node_modules/.bin/tsx services/api/src/routes/label.ts agent-judge v1 TOKEN_FILE prompt-v1-001
node_modules/.bin/tsx services/api/src/routes/label.ts agent-judge v2 TOKEN_FILE prompt-v2-001
node_modules/.bin/tsx services/api/src/routes/label.ts agent-calibrate comparison-001 .tools/annotation-task9/agent-judge-prompt-v1-001.json .tools/annotation-task9/agent-judge-prompt-v2-001.json
```

Outputs use the `agent-` prefix, keeping human and weak-reference runs separate.
The same cohort, rubric, prompt versions, actual judge model and implementation
must match for comparison. Missing either version or undefined kappa prevents a
winner; supplied files bind the imported reference audit and original file hashes.
The actual five-run reproduction and v1/v2 model calibration remain unexecuted by
the implementation worker. Fixed-seed requests alone prove no determinism.

The three reviewed admission/provenance fixes also apply to default commands:
production consumption pins the committed original cohort hash, history/protocol,
400/300/100 counts and exact exported data/audit bytes. A self-hashed replacement
cohort is rejected before token/network/write. Disposable small cohorts require
an explicit Vitest-only fixture registration; the production CLI offers no such
option. Every dispatch durably checkpoints exact sample/hash/run/call intent
before HTTP. Failed/unfinished requests remain joinable to API/spool IDs. A
malformed verdict still fails, while independently validated accounting/usage and
the complete raw-response hash remain in `JudgeFailure`/private failure evidence;
provider error bodies, keys and unvalidated fields are not retained.
