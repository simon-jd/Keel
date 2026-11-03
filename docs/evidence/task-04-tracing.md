# Task 4 — OTel GenAI spans 与可恢复运行成本

日期：2026-10-23。基线：`ae6b348`。费用：**$0**。仅本机 fixtures；无收费模型、Azure 创建、GPU、其他项目写入。未修改费用台账。

## 交付接口与依赖方向

- 新增 `packages/tracing/src/span.ts`：`withSpan(kind: 'llm' | 'tool' | 'retrieval', attrs: Record<string, unknown>, fn)`；callback 仅接收 `SafeSpan.setAttributes`，支持同步/异步返回，finally 总是结束 span。没有任意 `recordException` / `addEvent` / raw Span 端口。
- 新增 `packages/tracing/src/exporter.ts`：`configureTracing({ exporter?, endpoint?, batch? })` 返回 `forceFlush()` / `shutdown()`；`createPrivacyExporter` 投影整个 SDK export envelope。默认无显式配置时不导出，也不回落到别的库的全局 provider。使用模块本地 TracerProvider 与 AsyncLocalStorage 传递嵌套父子上下文，不修改全局 OTel 注册表。
- 依赖为 models → tracing，runtime → models / tracing；tracing 生产源码不依赖 models/runtime。集成测试通过相对路径使用真实 router/runtime 和现有隔离 Postgres helper，没有添加生产循环依赖。
- `models.createRouter` 逻辑重试循环整体包一个 llm span，在 yield 前结束；consumer 提前 return 不会遗留 span。所有正常完成、provider 错误和流中取消都独立返回/抛出既有 `accounting`，不再以 observer 存在作为生成 accounting 的前提。`observerStatus` 仍只表示显式 observer 回调结果；observer/exporter 失败不会重放模型。
- `RunResult.cost?: RunCost`：`{ status: 'known' | 'unknown', knownUsd: number, totalUsd: number | null }`。创建 checkpoint 后的终态/审批结果具有 cost；输入/存储层提前拒绝不声称费用完整。聚合按既有 checkpoint `deliveries.callId` 去重，使用 accounting 已知小计；未知 attempt、缺 accounting 或已预留但没有 delivery 的调用使 totalUsd=null。终态 resume 从 checkpoint 重建，不重新执行或累计模型。
- `Tool.traceKind?: 'tool' | 'retrieval'` / defineTool 同名可选字段：只分类实际执行；未实现 Task 14 检索。工具返回序列化验证包含在 span 内，非 JSON 返回也产生错误 span。
- 精确保留 brief 的 `gen_ai.system`、`gen_ai.request.model`、`gen_ai.usage.input_tokens`、`gen_ai.usage.output_tokens`、`keel.cost_usd`、`keel.run_id`；另写当前 `gen_ai.provider.name`、operation、call_id、attempt_count、unknown_attempt_count、cost_status。token 为各个已知 attempt 的归一化 usage 之和；Anthropic 累计 delta 不重复累计。unknown 时 `keel.cost_usd` 为已知小计，必须伴随读取 cost_status，绝非零总费用。

## TDD：真实 RED → GREEN

使用已安装 superpowers test-driven-development、writing-good-tests（TDD 目录中的同名参考文件）、verification-before-completion；执行 brief，不读取长计划正文，仅 Global Constraints/Review Focus。没有派子 agent/reviewer。

所有命令使用项目工具链：`PATH="$PWD/.tools/pnpm/node_modules/.bin:$PATH"`。日志位于 `/tmp/keel-task4-*.log`。RED 命令原始 Vitest/pnpm 退出为 1，以下是实际输出节选。

1. 首次 bootstrap：`pnpm --filter tracing test` 缺 exporter 模块（`red-bootstrap.log`），仅作为脚手架失败，**不算行为 RED**。建立真实 provider 的最小壳与 passthrough withSpan 后再次执行（`red.log`）：

```text
Test Files  1 failed (1)
Tests  10 failed (10)
llmSpanHasGenAIAttributes → expected [] to have a length of 1 but got +0
runCostEqualsSumOfCalls → expected NEEDS_APPROVAL to match ... cost ...
logical retry ... → missing cost
runtime records safe tool/retrieval spans ... → expected undefined to be defined
```

接入后 `green2.log`：`10 passed (10)`。首轮曾直接 JSON.stringify SDK Span 导致循环引用；修正测试为导出的公开字段投影，而没有削弱隐私断言。

2. 出口与协议测试初次缺方法/错误 shutdown 只记 bootstrap（`red-exporter-bootstrap.log`）；最小透传 exporter/无发送壳后运行 `pnpm --filter tracing exec vitest run test/exporter.test.ts`（`red-exporter.log`）：

```text
Tests  2 failed (2)
export boundary ... → expected 'alice@example.com' to be 'operation'
OTLP exporter ... → expected [] to have a length of 1 but got +0
```

实现完整投影和真实 protobuf exporter 后，`green-exporter.log`：14 passed（含扩展集成测试）。

3. `pnpm --filter tracing exec vitest run test/collector.test.ts`：使用真实 collector、初始 nop pipeline，`red-collector.log`：`expected +0 to be 1`，无任何转发。实现 opt-in 白名单配置后真实双跳成功；一次测试误以为 collector 不创建空 status，实测是 `{ code:0, message:'' }`，修正 fixture 断言。`green-collector2.log`：1 passed，包含绕过应用直接送入不可信 OTLP 的实际过滤验证。

4. 已知失败 attempt 仍有账单时的 usage 测试：`... vitest run test/tracing.test.ts -t 'known billed retry'`（`red-usage.log`）：期望20/8，实际10/4。改为每 attempt 归一 usage 各计一次；`green5.log` 对应通过，cost 为手算0.000072，仍一个 span。

5. 非 JSON 工具结果：`... -t 'non-JSON tool'`（`red-tool-result.log`）：期望错误状态2，实际0。将返回值验证纳入工具 span；`green5.log` 对应通过。

6. 全局 provider 绕过自审回归：`... vitest run test/exporter.test.ts -t 'unconfigured tracing'`（`red-global.log`）：未显式配置却向外部 global SDK exporter 送了1个 span（带外部资源），期望0。移除全局 fallback；`green-global.log`：1 passed，实际0个导出。

## 最终验证

```text
pnpm install --frozen-lockfile
Scope: all 5 workspace projects
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 402ms using pnpm v10.34.8

pnpm --filter tracing --filter models --filter runtime test
tracing: Test Files 3 passed; Tests 27 passed
models:  Test Files 1 passed; Tests 37 passed
runtime: Test Files 3 passed; Tests 28 passed
# 相关完整测试共92项，通过。日志 related-final.log。

pnpm typecheck
packages/db typecheck: Done
packages/tracing typecheck: Done
packages/models typecheck: Done
packages/runtime typecheck: Done
# strict/noUncheckedIndexedAccess/exactOptionalPropertyTypes 等，exit0。

git diff --check
# exit0
```

曾运行一次 `pnpm test`：资源 Python19 + db3 + tracing27 全通过；随后 models 的两条新 accounting 断言误将未知失败 attempt 期望为 known，实际返回 unknown，故该次全工作区命令失败并未继续 runtime（`workspace-test.log`）。按协议事实修正测试为 unknown、已知小计0.0000104和两次 attempt，再执行上述完整相关92项；未无故重复无关 DB/Python。冻结安装没有扩大任何 lifecycle 执行权限。Node v20.19.5 / pnpm10.34.8 / TypeScript5.9.3 / Vitest3.2.6。

覆盖实际 router+runtime+Postgres 路径：六个 brief 属性、无 observer 成本持久化、审批中断恢复、终态 resume 不重算、失败/取消 accounting、known/unknown/缺 usage、已预留缺 accounting、logical retry 单 span、已知重试费用/usage、Anthropic 累计 usage、工具/检索成功或错误、非 JSON 工具结果、observer/exporter 故障、consumer early return、嵌套父子上下文、初始/后加属性白名单、SDK name/events/status/links/resource/scope 的隐私出口与全局 provider 旁路。

## 官方来源与精确 Node20 依赖

查阅日期2026-10-23；版本 metadata 由真实 `pnpm view ... version engines dependencies peerDependencies --json` 核对，npm cache 留在项目 .tools 内。

- `@opentelemetry/api` **1.9.0**；sdk-trace/resources **2.12.0**；exporter-trace-otlp-proto **0.223.0**。SDK/exporter engines 是 `^18.19.0 || >=20.6.0`，SDK API peer `<1.10.0`，所以使用1.9.0。当前 exporter0.300.0 / context-async-hooks3.0.0 要求Node>=22.15.0，不能使用。所有新增直接依赖与 pnpm lock 精确固定。
- 曾先选择兼容的2.8.0/0.219.0，再核到更新的Node20维护组合并迁移。初次直接替换包名导致 BasicTracerProvider 不存在的失败已保留在 `green3.log`（该日志名不表示成功）；依据新 API 修正为 TracerProvider、processor `{ exporter, ... }` options，后续绿色日志证明新组合工作。未使用 deprecated sdk-trace-base 或 addSpanProcessor。
- [官方 JS instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/)；[v2.12.0 SDK README 与迁移说明](https://github.com/open-telemetry/opentelemetry-js/blob/v2.12.0/packages/sdk-trace/README.md)；[SDK package engines](https://github.com/open-telemetry/opentelemetry-js/blob/v2.12.0/packages/sdk-trace/package.json)。本包使用 constructor spanProcessors，并自行限定环境配置面。
- [当前 GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)：逻辑操作覆盖重试，provider.name 为当前字段；保留 brief 旧 system 字段双写。该规范仍为 Development，未来版本需显式复核。
- [Langfuse 官方 OTLP](https://langfuse.com/integrations/native/opentelemetry)：base `/api/public/otel`，signal `/v1/traces`，Basic auth，v4 ingestion header。按原始接口采用原生 OTel，不引入 Langfuse SDK。
- [collector0.160 transform](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.160.0/processor/transformprocessor/README.md)、[filter](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.160.0/processor/filterprocessor/README.md)、[OTTL Span paths](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.160.0/pkg/ottl/contexts/ottlspan/README.md)；真实固定镜像验证配置，而非 grep YAML。
- 测试直接依赖锁为 protobufjs7.6.6（Node>=12）、yaml2.9.1、msw2.14.6、zod4.1.12、testcontainers10.28.0；后四项与现有仓库版本一致。protobuf测试解码投影的字段号来自 [官方 OTLP proto v1.9.0](https://github.com/open-telemetry/opentelemetry-proto/blob/v1.9.0/opentelemetry/proto/trace/v1/trace.proto)，未将自制 HTTP 回应冒充真实 SaaS。

## 真实与未真实边界、资源

真实运行：官方 SDK / in-memory exporter；真实 adapters/router/runtime；隔离 Postgres checkpoint；现有 collector0.160.0 镜像；真实 OTLP/HTTP protobuf 应用→collector→本地 HTTP fixture。后者检查 `/api/public/otel/v1/traces`、`application/x-protobuf`、Basic **fixture** credential、`x-langfuse-ingestion-version:4`，解码必需属性。额外直入带 prompt、status message、scope/resource/schema、traceState、events、links、非法 model 值的不可信 OTLP，证明清理/拒绝在真实 collector 生效。

未运行：真实供应商 API、真实 Langfuse web/worker/ClickHouse/Redis/MinIO ingestion、真实 UI/API 查询。HTTP fixture 的200只是协议接收成功；SDK forceFlush、observer delivered 都不能证明 Langfuse 后台已入库。测试没有将 collector端的返回当作后台持久化证明。

最终只读资源检查：project951,607,296B + images1,616,465,391B = **2,568,072,687B <8GB**；project volume/container writable为0；所有 com.keel.project 测试容器已停止。Compose硬内存总计11,811,160,064B <16,000,000,000B。两个Langfuse镜像、ClickHouse和MinIO均缺失，大小未知，因此没有拉取/启动完整栈，未将unknown按0计算准入。测试collector硬限256MiB、Postgres512MiB。没有GPU/付费调用/云资源，费用0。

默认 `infra/otel-collector.yaml` 保持nop；新增 `otel-collector.langfuse.yaml` 只通过显式 `OTEL_COLLECTOR_CONFIG` opt-in。真实collector测试用该配置，仅替换本地receiver/fixture endpoint、压缩与fixture凭证。认证值不写入仓库，未打印真实环境密钥。

## 自审与风险

- 核对每条 brief 原名及字段；保留旧属性、新语义字段双写；accounting仍为模型层统一来源，未绕过models，未重做provider协议适配。
- 持久恢复只用已有delivery accounting；unknown total明确null；无 exporter/observer仍记账；终态没有重放。调用尚未持久化accounting时仍存在不可避免的崩溃窗口，已预留调用在恢复中保守标为unknown，不声称精确账单。
- 出口先收缩SDK完整结构，再经collector受限白名单；没有prompt、工具参数/结果、异常message/stack、token、用户输入。error.type只有operation_failed。配置中的model标识符依赖可信操作员，不是任意文本PII识别；UUID以外run_id与不安全模型标识符会省略。Task15的异步Presidio fail-closed处理尚未实现，默认nop因此保持。
- 仅一个应用级configureTracing owner管理生命周期；未安装全局provider/propagator。run_id关联跨恢复调用，不声称已经持久化跨进程OTel parent上下文。
- 无durable遥测重投队列；后端故障可能丢span，但不会丢checkpoint accounting或触发供应商重试。未来补投须保留span/call identity，本任务没有添加会重复导出的自动补投。
- 真实Langfuse后台验收留待资源大小可明确准入且本地项目凭证齐备；本次只交付可配置路径和真实本地协议证据。USD预算gate仍属Task8；当前RunCost的unknown不可作为零成本输入。
- 自审没有发现剩余阻碍；未派审查agent。与root并行补充的oauth/mcp/Azure来源文件无关，明确排除本任务提交。

## 首轮审查修复 Fix 1 — exporter 失败诊断隐私

修复基线 `23572f4`（此前 `9f2500a` 生产实现；root后续仅增加来源文档）。审查结论 Needs fixes / Important 1：privacy exporter 透传的原始异常经真实SDK diag与forceFlush泄漏。原交付章节是历史记录，不代表该审查发现已被首版覆盖。本轮只修改 `packages/tracing/src/exporter.ts`，新增 `test/exporter-errors.test.ts` 和本证据；不修改models/runtime、公开接口、collector配置或任何依赖。root的STATUS和Azure来源文档明确排除。

### 行为与最小修复

`createPrivacyExporter` 只传递成功/失败枚举。失败callback（同步/异步）与同步export throw统一变成新的 `Error('TRACE_EXPORT_FAILED')`；其stack删除，不复制原始error的message/name/cause或自定义字段。不会把failure改成SUCCESS。投影/导出catch也使用该固定失败，单次settlement保护防止重复callback。可选forceFlush与shutdown同时捕获同步throw/Promise rejection，继续以安全错误拒绝；不会吞掉失败或重试模型。未关闭diag logger或修改全局error handler来隐藏问题。

### 真正 RED → GREEN

命令均前置项目工具链 `PATH="$PWD/.tools/pnpm/node_modules/.bin:$PATH"`。测试真实安装的 OTel TracerProvider、SimpleSpanProcessor、BatchSpanProcessor，启用真实 `diag.setLogger(..., DiagLogLevel.ERROR)`，仅使用example.com与fixture token合成sentinel。日志测试捕获SDK真实diagnostic参数，不mock SDK/processor或把独立helper当作集成。

```text
pnpm --filter tracing exec vitest run test/exporter-errors.test.ts
# 修复前 red-final.log，pnpm exit1：
Test Files  1 failed (1)
Tests  10 failed (10)
# Simple SDK diag.error包含原始stack/message/name/detail；flush拒绝还携带cause。
# Batch SDK forceFlush、生命周期forceFlush/shutdown也保留原始异常。
# 首版8条RED后增加两条真实异步callback边界，再次10/10 RED，之后才修改生产。

# 修复后 green-final.log，exit0：
Test Files  1 passed (1)
Tests  10 passed (10)

pnpm --filter tracing test
# tracing-final.log，exit0：
Test Files  4 passed (4)
Tests  37 passed (37)
# tracing.test.ts16 + collector.test.ts1 + exporter.test.ts10 + exporter-errors.test.ts10

pnpm typecheck
# typecheck-final.log，exit0：
packages/db typecheck: Done
packages/tracing typecheck: Done
packages/models typecheck: Done
packages/runtime typecheck: Done

git diff --check
# exit0
```

实际日志：`/tmp/keel-task4-fix1-red.log`（8项），`red-final.log`（10项），`green.log`，`green-final.log`，`tracing-final.log`，`typecheck-final.log`。一次加强断言误用toMatchObject要求stack/cause/detail键存在且undefined，而安全对象实际完全没有这些键；该次27项通过、10项测试断言失败记录为 `test-assertion.log`。随后修正为分别读取并断言undefined，无生产改动，再执行上述focused/full/strict GREEN；不将这次测试自身错误当作功能RED。

10项新增边界：Simple/Batch × callback/异步callback/同步throw（6项），真实Simple SDK forceFlush/shutdown × reject/同步throw（4项）。每项都确认真实SDK操作仍失败，安全错误标识存在；日志和拒绝值分别不包含合成email/token/原stack，error.stack/cause/detail均undefined。Simple导出失败还确认真实diag.error确实发生，避免以“没有日志”冒充脱敏成功。生命周期错误在此SDK中走拒绝值，测试仍启用diag以捕获额外泄漏。

原有27项全通过，包括实际模型/运行时路径的exporter故障不重试供应商、checkpoint成本独立恢复、HTTP receiver成功导出、真实collector双跳协议与白名单等。没有重跑db/models/runtime独立测试包、Python或frozen install；未变依赖，不重复安装。full tracing内既有Postgres/collector fixtures随套件执行并停止，没有启动完整Langfuse、GPU或云资源，费用0。

### 自审、保证范围与剩余边界

对比fix base只改变exporter错误向SDK传播的边界，成功导出字段/OTLP路径/headers/费用会计均保留；原始异常对象从未被字符串化、记录或作为cause保留。拒绝信号保留，未改全局日志设置，SDK的真实诊断只接收固定错误。公开API与lockfile不变，无provider重试/账目重复的改动。既有真实collector协议测试仍只是本地HTTP fixture，不是Langfuse后台ingestion。

这项修复保证本wrapper交给SDK的callback/throw/lifecycle失败诊断安全，不声称能拦截任意下游exporter主动执行的日志/I/O。自审另读到上游OTLP delegate会对“HTTP成功但响应无法解码”自行diag.warn(response.data)，发生在callback之前，已向controller披露；默认collector返回规范protobuf，本轮要求的ERROR级SDK失败边界已覆盖，不用全局日志过滤掩盖此差异。若未来支持非规范/非信任receiver响应并启用WARN诊断，该独立响应日志边界需另行收缩。完整Langfuse后台边界与初版报告一致。

已按controller要求用本地临时HTTP probe真实复核上游独立风险，未扩展本轮生产补丁：

- 精确位置：`node_modules/.pnpm/@opentelemetry+otlp-exporter-base@0.223.0_@opentelemetry+api@1.9.0/node_modules/@opentelemetry/otlp-exporter-base/build/src/otlp-export-delegate.js:58`；发布包sourcemap对应 `src/otlp-export-delegate.ts:100` 的 `_diagLogger.warn(...)`（101行固定说明，102/103行原异常与response.data）。这是callback之前的下游exporter自身日志，不经过本轮错误归一。
- 触发前提：显式启用OTLP exporter；HTTP receiver返回2xx且有非规范protobuf body；diag级别允许WARN。默认collector nop保持，完整后台仍未启动。
- 可复现方式：启动127.0.0.1上的Node `createServer`，消费请求后以HTTP200 / `Content-Type: application/x-protobuf` 返回UTF8字符串 `fixture-alice@example.com fixture-private-token`；使用真实 `diag.setLogger` 捕获warn参数，设置 `DiagLogLevel.WARN`；`configureTracing({ endpoint: 'http://127.0.0.1:<port>/v1/traces', batch:false })` 后执行 `await withSpan('tool', {}, async () => undefined)` 和 `await tracing.forceFlush()`。将warn参数中的Uint8Array/Buffer解码UTF8，即可看到原body；flush仍成功。probe完成后shutdown tracing、disable diag、关闭本地server。
- 临时probe运行命令：`pnpm --filter tracing exec vitest run test/upstream-response-probe.test.ts`；临时测试执行后删除，未放进正式测试集来固化有缺陷行为。真实日志 `/tmp/keel-task4-fix1-upstream-response-probe.log`：

```json
{"warningCount":1,"leakedMalformedResponse":true,"flushRejected":false}
```

这是真实已知风险，不是“理论可能”；本次37项通过只说明原审查所指callback/throw/lifecycle错误回传边界已关闭，**没有宣称全部日志隐私验收通过**。controller已将该问题纳入Task15/context/ledger及真实后台导出前门槛。本补丁不修改全局diag logger来压制警告，不吞掉原边界的失败，不打开默认nop。后续必须在真实后台导出前修复该receiver响应日志路径。

## 本地 Langfuse 真实入库（2026-10-29，phase 5）

`python3 scripts/langfuse_ingest.py run docs/evidence/task4-langfuse --runs 30`：一个进程内用一次性随机密钥（只在内存里，不写 .env）起
`infra/docker-compose.yml`（8 个服务，mem_limit 合计 8 GiB），经 `scripts/gpu_run.py` → `with_pii_sidecar.py` → `local_batch.py --langfuse qwen3-8b-awq --memory-limit 6400000000`
跑 30 次真实 `runAgent`（本地 vLLM，`packages/runtime/src/langfuseRun.ts`），span 走生产导出链（白名单投影 → Presidio → OTLP）到 collector → Langfuse 4.69.0，
读回 ClickHouse 和公开 API，扫描全部存储，最后 `compose down --volumes`（`stack_removed: true`）。机器负载：nproc 32，前后 load average 2.39 / 4.18，同时有其他项目在跑。

| 指标 | 结果 |
|---|---|
| 运行 | 30/30 DONE，60 次模型调用、90 次工具调用（每次运行 customer.lookup / order.get / policy.search） |
| span 发送 / collector 确认 / 入库 / API 返回 | **180 / 180 / 180 / 180**，0 丢失、0 多余（`events_full` 180 行，`/api/public/v2/observations` 180 条） |
| 入库延迟（ClickHouse `created_at` − collector 确认） | p50 **119 ms**，p95 **193 ms**，max 212 ms（n=180） |
| 入库延迟（− span 结束，含 SDK 1 s 批量间隔） | p50 579 ms，p95 1,178 ms，max 1,216 ms |
| 每次运行成本 | 30/30 一致：runtime `cost.knownUsd` = 发送的 `keel.cost_usd` 之和 = Langfuse 存储的 `keel.cost_usd` 之和，合计 $0.0065361（本地路由的记账测试价 0.15/0.60 USD per M token，真实花费 $0） |
| 原始 PII | 150 个合成 canary（任务文本和工具结果里的邮箱、电话、姓名、地址，外加故意塞进白名单字段 `gen_ai.request.model` 的电话）在 72 个 Langfuse 存储对象（所有 ClickHouse 表、Langfuse Postgres dump、MinIO 事件、Redis AOF、collector/web/worker 日志、API 响应，1.88 MB）里 **0 命中**；对照组 Keel 自己的运行库命中 120 次，证明扫描有效 |
| 内存 | 容器实测 web 700 MiB、worker 398 MiB、ClickHouse 509 MiB；batch 峰值 RSS 3.44 GB；容器 limit 8.59 GB + batch 峰值 + sidecar/检查进程约 0.5 GB ≈ 12.5 GB < 16 GB |

说明与限制：
- Langfuse 4.69 在 `x-langfuse-ingestion-version: 4` 下把 OTel span 写入 `events_full`/`events_core`，属性以 `attributes.` 前缀存在 `metadata_names/values`；v1 `/api/public/traces|observations` 返回 404，读取用 v2。
- runtime 没有 run 根 span，每个 llm/tool/retrieval span 在 Langfuse 里是独立 trace，按 `keel.run_id` 属性归组。
- Langfuse 不认识 `keel-local` 的价格，自带 `total_cost` 全为 0；每次运行成本只在 `keel.cost_usd` 属性里。
- 注入电话被 Presidio 识别后整个属性删除（导出端 0 个 `415-555-*`）；非白名单键（prompt、user.email）在投影阶段丢弃。
- 原始输出：`docs/evidence/task4-langfuse/`（`summary.json` 汇总；`batch/sent.jsonl` 发出的每个 span；`batch/runs.jsonl` 每次运行状态和成本；`batch/done.json` canary 列表（合成数据）；`langfuse-events.jsonl` Langfuse 存储的全部行，去掉了已失效的项目公钥）。
- 为让整栈加 GPU batch 放进 16 GB，compose 的 mem_limit 从合计 11 GiB 降到 8 GiB；`resource_check.py` 在 Docker 数据不在项目盘时不再遍历 root 拥有的卷目录（不计入份额，原来会 PermissionError 拒绝 batch）。
