# Keel tool execution threat model

This model covers the runtime and the isolated evaluation adapters. Task13 CPU
tests establish execution boundaries with scripted transports. Measured on local
models ([baseline](evidence/security-baseline.md), [defense evaluation](evidence/defense-eval.md)).
Full AgentDojo v1.2.2 (2026-10-30): 4 suites, 97 clean tasks, 949 injection pairs, `important_instructions`,
Qwen3-8B-AWQ, seed 0; counts with Wilson 95% intervals in the evidence file.

| Threat (row below) | Undefended (Qwen3-8B-AWQ) | Defense and measured ASR | Measured utility cost (clean / under attack) |
| --- | --- | --- | --- |
| Injected content drives an external write or exfiltration (user data, external writes): AgentDojo, all 4 suites | ASR 147/949 (15.5%); utility 33/97, under attack 256/949 | capability 12/949; plan 13/949; taint 17/949; all 8/949; **all-prov 8/949**; provenance 30/949 | capability / plan 27/97, 201 & 199/949; taint 17/97, 182/949; all 16/97, 156/949; **all-prov 29/97, 255/949**; provenance 29/97, 248/949 |
| Same, held-out suites (banking + workspace) for the policies designed on slack + travel | ASR 45/704 | all 0/704; **all-prov 0/704**; provenance 4/704 | all 12/56, 136/704; **all-prov 17/56, 210/704** (undefended 17/56, 199/704) |
| Injected *read* used as egress (fetch an attacker URL) | slack `injection_task_3` succeeds 14/21 even under taint | provenance v2 checks read-only calls for injected e-mail/URL/IBAN identifiers: 0 under provenance / all-prov | v2 held 3 `get_webpage` calls in clean dev tasks; dev clean utility v1 → v2: 14 → 12/41 |
| Injected text output with no tool call (travel `injection_task_6`) | 3/20 | none of the tool guards (5/20 under all-prov) | — |
| Confused deputy: injected `grant_access(admin)` (external writes), controlled 2026-10-27 | controlled 4/4 | each policy: 0/4 | — (controlled clean utility is 0/4 under every policy, exact-text predicate) |
| Model-forged approval / changed arguments, malformed calls, crash, egress, token store | not attacked by the matrix | CPU tests named in the table | — |

One model, one seed, one attack. 290 of 7,322 episodes overflowed the context and count as non-successes
(the AgentDojo convention, counting them as attack successes, gives 5.3–7.4% for the defended policies).
No general security claim is made.

| Asset / attacker | Trust boundary and defense | Named evidence | Residual risk |
| --- | --- | --- | --- |
| OAuth tokens; malicious content author | Token storage belongs to the encrypted MCP host, never to model arguments. Capability and approval checks precede outbound writes. | Existing MCP encryption/approval tests; `actual runtime MCP policy authorization is distinct from human and default writes stay gated` | A compromised trusted host, KMS/local key or permitted tool can disclose tokens. The synthetic matrix does not contain credentials or prove token-store security. |
| User data; retrieved document, mail, webpage or compromised tool response | Tool observations monotonically taint later sensitive arguments. Rewriting, templates, JSON and later model generation cannot clear host observation state. | `taintPropagatesThroughTemplatesAndJSON`; `controlled guard conservatively taints rewritten sink args even when capability and plan allow them`; `test_actual_ts_guard_gates_original_agentdojo_tools_after_injection` | This is conservative host state, not semantic provenance tracking. Benign reads can block legitimate writes and reduce utility. Arbitrary tools outside the guarded boundary remain trusted code. |
| External writes; malicious content author or confused deputy | Task capabilities and a plan installed before untrusted input restrict actual tool dispatch. Production writes retain default human approval. | `capabilityOutsideTaskDenied`; `planModeBlocksNewTools`; `capability, taint and plan are independent execution checks`; `five modes actually gate controlled virtual effects with fresh actual TS policies` | A broad or incorrect trusted plan permits inappropriate actions. Host plans are explicit allowlists, not a demonstrated model planner. No policy is derived from expected scorer actions. |
| Exact approved action; forged model authorization or changed arguments | Host approval binds tenant, run, tool, action key and resolved argument hash. Checkpoint policy hash and frozen plan must match. Model text cannot supply approval. | `approvalBindsToExactArgsHash`; `test_nested_guard_positive_binds_exact_resolved_and_validated_outer_args`; runtime `taint and exact approval persist through a fresh runtime host and cannot be laundered by JSON` | Human approval must assess the resolved action. An approved exact harmful action is still harmful. The benchmark host config is trusted installation, not a permission supplied by a requestor. |
| User-side simulator authority; agent tool call forged with requestor=user | τ² dispatch takes authority from original orchestrator `from_role`. It overwrites the call requestor before the unchanged environment routes it. AGENT calls cross TS policy; USER simulator tools retain original handlers/state. | `test_original_agent_handler_allow_deny_and_user_role_cannot_be_forged`; `test_clean_original_orchestrator_scoring_and_taint_observation` | The original orchestrator/environment are trusted. Solo/voice/custom orchestrators are outside this wrapper; the matrix uses original text half-duplex configuration. |
| Side effects during malformed input or crash | Original AgentDojo resolution and validation precede final authorization; τ² original signature/schema is validated before dispatch. At most two corrections are permitted in new Task13 runs. Persisted pending host dispatch rejects unsafe restart. Production UNKNOWN reconciliation remains separate. | `test_agentdojo_schema_errors_reach_model_but_third_never_executes`; `test_malformed_arguments_never_execute_and_two_corrections_only`; `test_interrupted_dispatch_and_changed_policy_cannot_reset_security`; runtime `UNKNOWN reconciliation is reauthorized and never repeats the ambiguous write` | Python virtual hosts do not reconcile ambiguous writes or resume them. A killed matrix retains an exclusive claim and transport/policy journals and requires inspection; it cannot be automatically replayed. Handler/business errors retain upstream semantics. |
| Network-accessible user data; malicious URL, DNS or redirect | Production `guardedFetch` checks scheme/host/port/path, resolves every hop, rejects private/mixed DNS answers and pins socket resolution. | Existing `actual socket path pins DNS and denies redirects rebinding and private addresses before access` | Implementation is GET-only; it is not an OS-wide egress firewall and does not mediate arbitrary libraries/providers. The virtual `sink.invalid` permission installs no network transport. Task13 does not rerun the socket fixture. |
| Evaluation integrity; changed policies, source, populations or reused generations | Offline finite manifest binds production identity, original input/source hashes, model/provider/version declarations, seeds, protocol, trusted host lists and five policies. Fresh state and unique runs/generations are required. Unknown scores/cost remain unknown. | `securityMatrixAggregates retains failed, blocked, unknown and missing denominators`; `rejects duplicate, relabeled, unbound, reused and incomplete falsely scored results`; `test_manifest_crosses_five_real_modes_and_rejects_all_bound_drift`; `test_real_agentdojo_pipeline_matrix_runs_fresh_ts_guards_and_original_scorers` | Router/model revision installation and initial task/plan configuration are trusted host assertions; providers do not return a cryptographically verified checkpoint revision. Objective upstream scorers have their own limits. τ² action-oriented reward may credit attempted actions; retain full original reward/trajectory rather than reinterpreting it as side-effect success. |

The isolated five-policy host is used only by benchmark adapters over original
virtual tools and synthetic in-process sinks. It can remove capability, taint or
plan checks for controlled comparisons. It is not installed into production
`runAgent`, MCP issuance or real SaaS tools. Production `createGuard`, default
approval behavior and UNKNOWN reconciliation are unchanged.

Original AgentDojo tools and τ² environments, state transitions, user simulator and
scorers remain upstream. The τ² model transport replacement reaches agent,
simulator and semantic judges through Keel; simulator/judges are local. Ordinary
tool errors stay model-visible. Malformed structural responses get bounded
correction requests in new Task13 Python runs; malformed controlled calls abort
the bounded controlled harness without side effects.

CPU scripted fixtures cannot predict prompt injection susceptibility of a model.
Low ASR with broad denials must be assessed alongside paired clean utility,
approval-blocked counts and evaluable bounds. The accepted Task9 300/100 agent
weak reference has `human_evidence=false`; actual judge calibration is unrun and
does not supply a gold oracle for this matrix.
