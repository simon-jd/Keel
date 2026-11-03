# Task 3：持久 agent loop 与崩溃恢复证据

日期：2026-10-23。基线 `37623c7`，分支 `feat/keel-implementation`。本任务只使用脚本化 ModelClient、真实隔离 Postgres；没有付费模型、GPU、Azure 或其他项目写入。累计新增费用 0 USD。

## 实现与接口

- `packages/runtime/src/loop.ts`：`runAgent(runId, task, deps)`，仅返回 DONE / FAILED / BUDGET_EXCEEDED / NEEDS_APPROVAL。注入 models 的 ModelClient；不实现供应商 HTTP 或重试。
- `tools.ts`：Zod `defineTool`；整个工具 batch 验证后才执行；JSON/schema 错误向模型反馈，初次之后最多两次纠错。assistant toolCalls 与 toolCallId 均持久化，适配已有 OpenAI/Anthropic 消息接口。
- `store.ts`：使用 Task1 的 Drizzle runs/steps/actions。专用 PostgreSQL connection 的 advisory lock 覆盖整个运行；UUID 小写归一，避免相同数据库 ID 不同文本产生不同锁。锁失败只返回 RUN_BUSY，不改写活跃 run。
- `budget.ts`：默认 8 次模型 / 16 次工具。调用前持久预占；工具 PENDING 与工具预算在同一事务提交。恢复已成功结果不增加执行次数。重启不能提高或重置原预算。
- `actions.ts`：对实际验证后的 JSON 稳定排序，拒绝 undefined、NaN、Infinity、bigint、非普通对象和循环引用；使用 JSON tuple 编码 run_id / step_seq / tool / canonical args 后 SHA-256，消除裸分隔符碰撞。
- runs.budget_json 是 version=1 checkpoint，包含 task/model/capabilities/tool schema/policyVersion/预算配置的不可变 fingerprint、messages、待执行 batch、计数、accounting delivery 和结果。完成模型响应与 DONE 同事务提交。
- 工具全部走 guard；非显式只读命名及敏感动词默认审批，即使 sideEffect=false。审批匹配 tenant/run/tool/actionKey/argsHash。guard 收到已验证 args 和 capabilities 的隔离副本，可供 Task12 接入内容/URL 等检查；不在本任务实现整套防御。
- 工具执行后异常保留 UNKNOWN；恢复遗留 PENDING 先转 UNKNOWN（即使暂缺审批）。只有 lookup 明确 done 才以对账结果完成，明确 absent 才允许重新执行；缺 lookup、lookup 抛错或不确定均保留 UNKNOWN。SUCCEEDED 重放结果；FAILED 不重做。
- 普通工具输入/结果属于运行状态，持久化在数据库；诊断只暴露安全 code，不打印原始任务、参数、结果、凭据或异常 body。accounting 经过字段/类型验证，只保留 models 定义的结构及 observerStatus；observer failed 不导致重试模型。Task4 尚未创建。

## TDD 与真实输出

遵循 test-driven-development / writing-good-tests：先写行为测试；先观察缺模块 bootstrap 失败，再用最小占位接口获得语义 RED。初始 RED：

```text
rejectsMalformedToolArgs: expected FAILED with INVALID_TOOL_ARGS, received missing errorCode
budgetStopsRun: expected BUDGET_EXCEEDED, received FAILED
Tests 17 failed | 3 passed (20)
```

初始 GREEN：20/20，约 9.74 秒。自审回归先 RED 后修复：

```text
tool mutation: expected { value: 7 }, received { value: 99 }
accounting boundary: unexpected PII-token in persisted deliveries
policy args: expected DONE, received FAILED (guard had no args)
final response acknowledgement: expected committed answer / 1 model call,
  received duplicate answer / 2 model calls
uppercase UUID competitor: expected RUN_BUSY, received DONE
recovery without approval: expected UNKNOWN, received PENDING
```

最终聚焦集合为 loop 16 + recovery 8 = 24 项。`resumeAfterCrashDoesNotRepeatSideEffects` 启动真实 Node/tsx 子进程：工具在独立 PostgreSQL counter 表提交 n=1 后发出 marker，父进程发送 SIGKILL；检查 action=PENDING；新 store 首次恢复缺审批时 action=UNKNOWN；再次带精确审批恢复，lookup 在数据库读取到 UNKNOWN 并返回 done，最终计数仍为 1、预算为 model=2/tool=1。不存在生产代码 crash hook。

其他关键验证：同 run 跨 store 互斥（含 UUID 大小写）；tenant/task 不可替换；错误审批不能执行；敏感工具错误标记为 read 不绕过；完整 batch 中有效 sibling 在无效 batch 内不会执行；副作用已发生后抛错不会盲目失败再重试；明确 absent 的恢复消耗新工具预算；最终 checkpoint 丢失 ACK 后不重新调用模型；终态 resume 不调用模型。

## 最终验证环境和结果

- Node `v20.19.5`；pnpm `10.34.8`；TypeScript `5.9.3`；Vitest `3.2.6`。
- PostgreSQL：`pgvector/pgvector:0.8.1-pg17`；runtime Testcontainers 配置每个 Postgres 512 MiB / 1 CPU、标签 project=keel/purpose=runtime-tests，测试完成自动销毁。
- 新依赖精确版本：zod `4.1.12`、tsx `4.20.6`；沿用 drizzle-orm `0.45.4`、pg `8.23.1`、Testcontainers `10.28.0`。
- `pnpm test`：资源 Python 19 + db 3 + models 37 + runtime 24 = **83 通过**。
- `pnpm typecheck`：三个包严格 TypeScript 检查通过。
- `pnpm install --frozen-lockfile`：通过。pnpm 提示忽略 `esbuild@0.25.12` build script；未额外批准脚本，真实 tsx 子进程和 Vitest 均已成功执行。
- `git diff --check`：通过。测试后 project=keel 容器列表为空。

## 自审与剩余边界

已修复自审发现的入参别名修改、诊断元数据越界、最终响应提交窗口、UUID 锁身份、缺审批的 PENDING 恢复问题，均有先失败再通过的行为证据。没有引入内存 store 替代数据库验收，没有修改费用台账/root README。

外部系统的 exactly-once 仍取决于可信 actionKey/lookup：如果外部服务错误报告 absent，允许重试可能重复副作用。数据库断连导致锁丢失时会取消 signal，但不遵守取消的外部服务仍需 Task6/7/12 的幂等适配；本任务不宣称分布式事务保证。数据库不可写时只能返回 STORE_ERROR，不能保证写入终态。审批列表/guard/policyVersion 为受信宿主注入端口，尚无人工审批 UI 或身份认证系统。policyVersion/schema 绑定不等于对工具实现源码的自动版本管理。

真实模型/GPU/商业 SaaS、OTel ingestion、完整 Task12 策略均未验收，分别留待后续任务。model 在请求期间崩溃可以消耗一次预算后重新请求；不声称模型调用 exactly-once。

## 首轮审查修复（FIX_BASE fd22c95）

Important：无效 batch 的 assistant 历史原使用 `args:null`，经真实 Anthropic adapter 会生成非法 `tool_use.input:null`。依据 [Anthropic 官方工具调用协议](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)，input 为对象，匹配的 tool_result 必须紧跟工具调用。修复仅把安全占位改为 `{}`；保留完整 batch 的 call ID/错误反馈，不执行占位参数或无效 batch。未修改 models 生产代码。

新增 `packages/runtime/test/anthropic.test.ts`，手工生成 SSE 协议数据（非真实录制），经真实 `models/router → anthropic adapter → 127.0.0.1 HTTP server`，服务端拒绝 input:null，并检查 tool_use/tool_result 的 ID 与顺序。四个场景覆盖类型错误/坏 JSON × 第二次纠错后成功/持续失败：成功只执行已验证的 value=7，不执行有效 sibling=123；持续错误在初次+两次纠错后结束。不是宽松 scripted ModelClient 的历史对象断言。

真实 RED：

```text
pnpm --filter runtime exec vitest run test/anthropic.test.ts
Tests 4 failed (4)
成功场景：expected DONE/modelCalls=4，received FAILED/modelCalls=2
耗尽场景：expected INVALID_TOOL_ARGS/modelCalls=3，received MODEL_ERROR/modelCalls=2
```

真实 GREEN 与定向验证：

```text
pnpm --filter runtime test
Test Files 3 passed (3)
Tests 28 passed (28)  # anthropic4 + loop16 + recovery8
pnpm typecheck
packages/db / models / runtime: Done
pnpm install --frozen-lockfile
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 407ms using pnpm v10.34.8
```

Minor：依据 [pnpm 10.x ignoredBuiltDependencies 官方说明](https://pnpm.io/10.x/settings#ignoredbuiltdependencies)，该字段明确禁止列出包的 lifecycle 脚本，并抑制其询问/告警。`pnpm-workspace.yaml` 只添加 esbuild 到 ignoredBuiltDependencies，没有添加任何允许脚本执行的配置。

本地已有安装状态仍保留旧 ignoredBuilds 记录；一次 `pnpm install --frozen-lockfile --force` 重新导入锁定依赖后仍显示缓存告警（也显示 cpu-features/msw/protobufjs/ssh2 的禁止脚本告警），故不能把配置读取成功当作告警已解决。随后在明确忽略 esbuild 的配置下执行 `pnpm rebuild esbuild` 刷新管理器记录；该次命令 stdout/stderr **均为空**，exit **0**。之后普通冻结安装无 ignored-script 告警。

为避免仅凭配置推断“没有执行 postinstall”，另做同配置的可观察复验（初次 rebuild 没有单独进程跟踪）：

```text
pnpm --reporter ndjson rebuild esbuild
pnpm events: scope=1, package-manifest=1, context=1, execution-time=1
pnpm:lifecycle events: 0
strace -f -e trace=execve ... pnpm rebuild esbuild
execve(pnpm, [pnpm,rebuild,esbuild]) = 0
execve(project .bin/node, ...) = ENOENT
execve(codex-path/node, ...) = ENOENT
execve(/home/postedism/.local/bin/node, [...,rebuild,esbuild]) = 0
```

execve 全记录只有上述四项，没有 shell、esbuild install.js 或其他子程序启动。这验证当前明确忽略策略下 rebuild 不执行其 postinstall；不将复验描述为首次调用的独立审计轨迹。没有批准任何依赖脚本，也没有执行其他依赖的 rebuild。刷新本地安装状态后 runtime 28/28、严格类型检查与冻结安装再次通过。

自审：变更范围只涉及 runtime 一行历史数据、回归测试、workspace 忽略配置与证据；未改 models/db/Python 生产实现，因此按审查要求不重复无关测试。原有 24 项持久恢复/预算/审批测试继续通过。测试使用本地 HTTP 和隔离 PostgreSQL，无商业调用/GPU/云费用；外部真实 Anthropic 服务仍未验收。未提交 controller 对 STATUS 的并行修改。
