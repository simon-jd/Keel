# Keel Task 12 guard evidence

The defended host path now enforces capability policy, conservative taint, a frozen tool plan, exact approvals and URL egress restrictions. CPU scripted fixtures exercise actual runtime/PostgreSQL/MCP dispatch and original AgentDojo tools/scorers. They do not measure model ASR or model utility.

## Activation and trust

A trusted runtime host installs `Deps.security = createGuard(options)` from `guard`. Task capabilities are exact tool names, including service prefixes such as `slack.post_message`. `options.plan`, when supplied, is a trusted list of permitted tools established before any model/tool execution; `allowUntainted` explicitly permits named sensitive tools only before untrusted observations. The default is an empty exception list, requiring exact human approvals for writes. Legacy `Deps.guard = async () => 'allow'` does not grant policy authorization. Unchanged legacy runs without `Deps.security` retain their earlier approval behavior; they are not defended-mode experiments.

The runtime invokes the security policy on validated arguments before UNKNOWN lookup or dispatch. Capability and plan denials take precedence over human approval. Only a trusted runtime decision creates an in-process, non-JSON policy permit bound to tenant/run/tool/action key/canonical arguments hash. The MCP bridge accepts this permit or exact human approval. It signs the source (`policy` plus policy hash, or `human`) and the server records that source in the encrypted action journal. Model arguments cannot create permits. Existing signed proofs remain compatible; old proofs required human approval when issued.

## Persistent taint and plans

Host taint envelopes propagate through concatenation, templates and explicit JSON serialization/parsing envelopes. The model cannot clear a host label by writing `tainted:false`. Retain the envelope across JSON parsing; extracting raw text or `.value` alone does not preserve an object label.

For model rewriting, the runtime uses a conservative rule: after any successful tool result is observed, every subsequent sensitive call is tainted, including paraphrases and encodings. It does not claim precise string-level information-flow tracking. This can require approvals for safe later writes. Checkpoint security contains only a version, policy hash, observed flag and frozen plan. It is saved before the next model request. Recovery from an already successful action also observes its result before continuing. Policy changes, plan expansion, missing security state and legacy checkpoints supplied to defended mode fail with `RUN_INPUT_MISMATCH`; there is no silent migration or taint reset. UNKNOWN reservations remain persistent and are reauthorized before reconciliation.

## Actual egress path

`createHttpFetchTool` from `runtime/http` installs a strict GET-only `http_fetch` tool using `guardedFetch`. Trusted host rules bind scheme, exact host, port and path boundary. Credentials, IP-literal URLs, encoded path separators, private/link-local/metadata DNS addresses and unsafe IPv6 forms are rejected. Each redirect is separately checked, and every accepted DNS result is validated before pinning a checked address in the actual socket lookup. Requests have a 10-second signal, at most three redirects and a 1 MiB response bound. Optional fixture address exceptions allow only exact `127.0.0.1`/`::1`, and cannot open metadata addresses.

This is enforcement inside that tool's network implementation, not an operating-system firewall. Other trusted custom tools and existing provider transports must enforce their own destination policies; installing an arbitrary native-fetch tool does not inherit `guardedFetch`. The CPU tests never resolve or probe real metadata addresses. DNS is scripted, and sockets connect only to isolated loopback fixtures.

## Original AgentDojo host seam

`KeelGuard` uses the actual TypeScript `createGuard`, canonical hash and action key functions through a local synchronous stdin bridge. Every preflight/dispatch/observation starts a fresh Node process. Trusted policy/configuration and security state paths are outside model input. The state is atomically renamed and file/directory-fsynced before dispatch or delivery; it records hashes/bindings, not argument text. Plans and policy identity cannot expand on resume. An interrupted pending original dispatch fails closed when a new host initializes. The bridge is a serial CPU host adapter, not a concurrent daemon or a virtual-tool idempotency implementation.

`HostRuntime.run_function` first performs a name-only TS capability/plan preflight, so denying a containing call prevents every nested handler. The unchanged original runtime then resolves its supported Pydantic `FunctionCall` arguments and validates the resulting schema. A per-host copied function descriptor gates the final real handler using those exact resolved/validated arguments (including defaults and excluding injected trusted environment dependencies), not a serialized nested expression. Nested handlers pass through the same boundary, and their results taint the outer call before its final authorization. Observations occur before results can reach the model. Shared upstream suite tools are not mutated. Host guard infrastructure faults abort the case even when upstream normally catches handler errors; interrupted pending state still fails closed on new initialization. Injection transforms and original utility/security scorers remain upstream. The original adapter's no-defense default and the controlled harness default remain unchanged. InjecAgent has no original tool handler and receives no sink-ASR claim here. Task 13 model/GPU evaluation remains outstanding.

## Verification

- Required test names: `taintPropagatesThroughTemplatesAndJSON`, `taintedArgToSensitiveToolNeedsApproval`, `untaintedArgAllowed`, `capabilityOutsideTaskDenied`, `planModeBlocksNewTools`, `approvalBindsToExactArgsHash`.
- Initial RED: six tests were written first; collection failed on the absent `src/taint.js`. This was a module-resolution failure, not six recorded assertion failures. [Original output](task12/required-tests-red.txt).
- Full affected TS run: guard 38, runtime 34, MCP common 14; 86/86 passed. [Output](task12/full-ts.txt).
- Final controlled follow-up adds one taint case: 13/13, bringing the unique TS total to 87. [Output](task12/controlled-extra.txt).
- Final egress follow-up after tightening metadata exceptions: 2/2. [Output](task12/egress-final.txt).
- Actual TypeScript/original AgentDojo CPU tests: 4/4. [Output](task12/python-guard.txt).
- Existing security adapter regressions: 25/25, including malformed-action and original source/scorer behavior. [Output](task12/python-security.txt).
- Guard/runtime/MCP common TypeScript checks passed. [Output](task12/types.txt).

Runtime integration covers actual PostgreSQL persistence, a separate process exiting at NEEDS_APPROVAL and a new host resuming, default/human gating, exact hash rejection, frozen plan changes, denied network access, UNKNOWN reauthorization and the actual signed runtime-to-MCP policy proof with distinct encrypted journal provenance. The controlled cases reach real in-memory virtual sink handlers when undefended, and are blocked before sink execution when defended. These are boundary regression controls, not experiment scores.

R1 nested-call repair adds eight actual-guard regressions: 12/12 host tests, the original nested callback plus artifact regressions 2/2, six covering TS policy tests, and the guard typecheck passed. [Meaningful pre-fix RED](task12/fix1/red-nested.txt), [host GREEN](task12/fix1/green-host.txt), [legacy/artifact GREEN](task12/fix1/green-legacy-artifacts.txt), [policy GREEN](task12/fix1/green-policy.txt), [types](task12/fix1/types.txt). Exact binding is checked against production TS `hash`/`actionKey` after the original schema strips an extra argument. Shared-suite isolation, subsequent undefended behavior, same-function recursion, unchanged original validation errors and interrupted observation failure are covered. No broad unamended suite was repeated for R1.

## Resources and reproducibility

The root admitted one existing pinned image: `pgvector/pgvector:0.8.1-pg17`, SHA256 `3e8b3adfd27b5707128f60956f62a793c3c9326ea8cfaf0eab7adccb5d700b21`. Each of three sequential fixture lifecycles used `--pull=never`, name `keel-task12-pg`, labels `project=keel,purpose=task12-guard-tests`, a 512 MiB memory hard limit, 1 CPU, 128 MiB PGDATA tmpfs, 32 MiB shm, loopback-only ephemeral port and capped 1 MiB logs. All had 20,480 bytes Docker writable-layer size and were removed with volumes in `finally`; no shared container or image was deleted. The final Keel-labelled container inventory was empty. Per-suite isolated databases reused the single fixture; tests disabled file parallelism and used one worker. The [runner](task12/run-cpu-tests.py) needs a current controller resource admission before reuse.

Container IDs, in order:

1. `fc95dafaae45b1783e1a6c799c9bfa5cc603bbe350f987f69d0fd46ea187db1c`
2. `dbb22ec14b56519edc1ecb778afb835ae4f001e8d739ea64d52b9296cf8aa8d4`
3. `358c4db844d4ba1129dd8e08dcb5ac9dbcf242e9b7de1e03dced761c9d59abc3`

Root's final read-only accounting snapshot: project 6,241,259,520 B + full images 1,616,465,391 B + volumes 0 + container RW 0 = 7,857,724,911 B, below 8 GB. This snapshot preceded the final small documentation additions. Memory evidence is the configured 512 MiB fixture limit, not a complete host RSS measurement; the service ceiling is 16 GB. No images, dependencies or models were downloaded or installed. No cloud, GPU, SaaS, real keys, real model calls, hosted CI or pushes were used. All retained tool arguments are synthetic fixture data. No new argument/token/PII logs or traces were introduced; pre-existing runtime checkpoints/step records remain trusted application state rather than public evidence.
