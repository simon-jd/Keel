# Task 2：模型路由与计费证据

日期：2026-10-23。基线 `a3e19ed`，分支 `feat/keel-implementation`。执行环境 Node `v20.19.5`、pnpm `10.34.8`、TypeScript `5.9.3`、Vitest `3.2.6`、msw `2.14.6`。

## 实现与接口

`packages/models` 提供 OpenAI Chat Completions、Anthropic Messages、OpenAI-compatible/vLLM 路由。所有模型 HTTP 请求统一由包内 `src/protocol.ts` 的 fetch 发出。无原始 prompt、tool args、text 或凭证 logger。

公开入口：

- `models/types`：brief 中的 `ChatRequest`、`ToolCall`、`ChatChunk`、`ModelClient`，以及消息、工具定义、路由和 accounting 类型。
- `models/router`：`createRouter(routes, { observer? })`、`cost(usage, model, pricing?)`、安全的 `ModelError`。
- 路由键是逻辑 alias；每个 route 显式配置 `provider`、`endpoint`、实际 `model` 版本和可选 `apiKey`。请求中的 alias 不作为供应商 model 发送，计价使用同一实际版本。
- `stream(req, { signal, run_id?, call_id? })` 仅在完整 attempt 通过协议终点后 yield 一次。`observer` 每个已发起的 logical call 汇总一次 accounting，不接收原始内容；observer 失败不重试模型请求。配置 observer 后，成功 ChatChunk 或终止失败的 ModelError 带 `observerStatus: delivered | failed` 和独立的 `accounting` 元数据快照；没有配置 observer 或尚未发起请求时不带这两个字段。

`Message` 支持 `system/user/assistant/tool`，assistant 的 `toolCalls` 和 tool 的 `toolCallId`。`ToolDef` 使用 `{ name, description?, parameters }`。模型包负责 JSON 解析，完整参数 Zod schema 校验由后续 runtime 负责。

完整流中的 malformed args 保留为 `invalidToolCalls: [{ id, name, error: 'malformed_json' }]`，不会用 `{}` 掩盖解析失败。已解析但名称未声明的调用为 `{ id, name, args, error: 'unknown_tool' }`。这些调用不进入可执行 `toolCalls`。已解析但不匹配业务 schema 的 args 原样交 runtime 校验，以便反馈模型。

## 重试、提交与成本边界

“最多 4 次”按 controller 明确的解释实现为初次尝试加最多 4 次退避重试，总共最多 5 attempts；退避依次为 **500 / 1000 / 2000 / 4000 ms**。429、5xx、网络读失败、错误/损坏 SSE 和缺失终点会重试。401 等非临时 HTTP 状态立即失败。错误仅暴露安全的类型和可选 HTTP 状态；不附带供应商 body、headers、URL 或异常 cause。

OpenAI 必须收到 finish reason 和 `[DONE]`；Anthropic 必须有 message start、结束 stop reason、所有 block stop 和 `message_stop`。有工具时，OpenAI 必须以 `tool_calls` 结束，Anthropic 必须以 `tool_use` 结束；token 上限截断不能提交可执行工具。整个 attempt 的文本和工具均缓冲，因此首 token 延迟变为完整生成延迟，换取断流重试时不执行废弃尝试的工具。

OpenAI 最终 usage 替换本 attempt 的 usage；Anthropic `message_delta` 的 output token 为累计值，覆盖而非相加。上层一次成功逻辑请求仅收到一次成功 usage。若失败 attempt 已收到可识别的最终 usage，observer 对该 attempt 的已知成本只计一次；成功 attempt 的成本另计一次。这是不同供应商尝试的已知花费，不能把第二次真实消耗误当重复本地计费而抹掉。

失败 attempt 没有最终 usage 时，attempt 与 logical accounting 的 `costStatus` 显式为 `unknown`；`costUsd` 仅代表已知小计，不能单独解读为总账单。429 等失败在没有 usage 时也保守标 unknown。本实现**不保证供应商不重复收费**：供应商可能已经处理废弃 attempt，断流重试也可能额外收费。

AbortSignal 在 fetch、body read 和真实 backoff 中均生效，取消后不提交缓冲内容。reader 取消被发起但不等待 cancellation promise：Web Streams tee 的取消可能等待另一支读取方，await 会在 msw response tee 中死锁；取消结果捕获，reader lock 被释放。

## 定价与真实可用性

`prices.json` 保存 2026-10-23 核对的历史 fixture 参考价（USD / 百万 token）：

| 历史模型版本 | input | output | 官方来源 |
| --- | ---: | ---: | --- |
| `gpt-4.1-mini-2025-04-14` | 0.4 | 1.6 | [OpenAI 模型页](https://developers.openai.com/api/docs/models/gpt-4.1-mini) |
| `claude-sonnet-4-5-20250929` | 3 | 15 | [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) |

两项均标注 `fixtureOnly: true`、真实可用性未验；OpenAI family 页面已标 deprecated。没有真实账户验证，不把 fixture 通过当成现在可调用的证据。生产前必须重新核对可用模型与报价并显式配置版本和价格。

当前成本公式仅支持标准未缓存 input/output token 基础价，不含 cache、batch、区域、长上下文等特殊计价；它是本地已知 token 参考成本，不是供应商发票核对器。未知模型没有静默零价格；未知部署必须显式给出 pricing。vLLM 没有供应商默认价格，要求配置部署自己的 `inputPerMillion/outputPerMillion`。显式零价格可以配置，但不会由默认值产生。

## 验证

没有 API key、真实账号录制、付费调用或真实 vLLM 部署。fixtures 为依据[官方协议核对](model-protocol-sources.md)手工构造的 SSE，经 msw 拦截实际 fetch 重放；测试启用 unhandled-request error，域名为 `fixture.invalid`。

第一轮 RED（2026-10-23 19:26，本地 America/Los_Angeles 时间）：`pnpm --filter models test`，26/26 failed；当时 router 只有抛 `Not implemented` 的 API scaffold，且无 unhandled errors。初始 abort 测试自身等待问题已先修复再获得这轮有效 RED。第一轮 GREEN：26/26 passed，13.64 s。

边界自审补测：先运行新增 5 项，3 failed / 2 passed / 26 skipped。真实失败分别为 OpenAI 与 Anthropic 截断工具仍被提交，以及 Anthropic 工具历史生成空 text block。修复后 5/5 passed；另外两项验证真实 reader.error 与未闭合 block，未为它们添加新生产行为。

最终验证命令均先设置 `PATH="$PWD/.tools/pnpm/node_modules/.bin:$PATH"`：

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS；lockfile up to date，357 ms |
| `pnpm test` | PASS；db 3/3，models 31/31，共 34 项；models 15.65 s |
| `pnpm typecheck` | PASS；db 与 models strict TypeScript |

31 项模型测试包括 brief 的四项原名测试、真实异步 500/1000/4000ms 退避与总尝试上限、backoff 中取消、流读中取消、429/500/503/401、实际 reader 传输失败、缺少完整终点、错误/坏 JSON SSE、UTF-8 跨字节与多行 CRLF SSE、累计 usage、失败 attempt 已知与未知成本、非法 tool JSON、未知工具、runtime schema 参数保真、配置和输入 fail closed，以及 observer 失败不重试和 metadata 不含内容。

自审：确认唯一模型 fetch 在包内；无默认内容 logger；错误不携带 provider 原文；未知价格不默认为零；失败 attempt 不 yield；只在完整逻辑结果后提交一次。完整执行记录位于本地 `.superpowers/sdd/3-keel-agent-plan/task-2-report.md`（按仓库规则忽略，不纳入提交）。


## 独立审查修复轮 1

FIX_BASE：`6e5bd55`。仅修复首轮独立审查的两个 Important，不改预算文件、ledger；遵守新增资源预算约束，本轮无真实 API、云资源或 GPU 使用。

1. OpenAI 工具流中，`function.name` / `function.arguments` 字段只要存在就必须为字符串。测试先拼完整合法 JSON，再插入对象型 arguments 或数字型 name，随后正常 finish+[DONE]；旧实现忽略坏 delta 并提交工具，新实现安全 protocol error 并丢弃整个 attempt，重试成功后只提交一次完整工具。vLLM 复用同一校验。
2. observer 投递不再静默失败。已配置 observer 时，ChatChunk / 终止 ModelError 的 `observerStatus` 明确为 `delivered` 或 `failed`；同时携带只含原有安全 metadata 的 `accounting` 快照。失败 attempt 的 known usage 或 unknown 成本状态均保留，不把 observer 原始异常作为 cause，不打印原文。

observer 接收独立 structuredClone，调用方快照和内部 accounting 状态与该对象隔离；即使 observer 修改 usage、cost、attempts 后抛错，也不会污染模型结果或恢复快照。投递失败不会触发模型请求重试或本地重复记账。Task4 应将 `observerStatus: failed` 作为待补投状态，只补投快照，按 `call_id` 去重；不要将它当成模型未执行并重做供应商调用。状态 `delivered` 仅表示 observer 已正常返回，不是远端持久化或恰好一次投递证明。

新增 6 项回归先 RED：6 failed / 31 skipped。失败结果还暴露了旧 observer 可以把成功 usage.input 污染为 999。最小修复后同一聚焦命令 GREEN：6 passed / 31 skipped。完整 models 文件回归 **37/37 passed**，16.73 s；models strict typecheck 通过。依照审查限定范围，未修改 db 或依赖，因此本轮不重复数据库测试或 frozen install。

```bash
PATH="$PWD/.tools/pnpm/node_modules/.bin:$PATH" pnpm --filter models exec vitest run -t 'NonStringToolFunction|IsolatedAccounting|SuccessfulObserverDelivery|ObserverFails|ObserverDeliveryFails'
PATH="$PWD/.tools/pnpm/node_modules/.bin:$PATH" pnpm --filter models test
PATH="$PWD/.tools/pnpm/node_modules/.bin:$PATH" pnpm --filter models typecheck
```

本轮测试文件为 `packages/models/test/models.test.ts`；完整真实 RED/GREEN/回归输出追加到原 task-2-report.md。现有成本参考范围、供应商失败费用未知、完整缓冲延迟和真实部署未验等限制继续适用。
