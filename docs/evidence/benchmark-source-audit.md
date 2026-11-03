# 基准上游接口预查

日期：2026-10-23。只读官方公开仓库/文档；未运行 benchmark、未下载私有数据、未调用模型。下列 SHA 是本次 GitHub API `GET /repos/{repo}/commits/HEAD` 查询结果，属于候选版本记录；最终适配版本需在实现和安装测试后锁定，不能仅凭此表声称已兼容。

| 基准 | 官方仓库 | 本次 HEAD SHA | commit 日期（UTC） |
|---|---|---|---|
| τ²-bench | sierra-research/tau2-bench | cc1df47baa1544a34bb8c8e5c4ca72ad223b96a2 | 2026-10-22T22:21:28Z |
| BFCL | ShishirPatil/gorilla | 6ea57973c7a6097fd7c5915698c54c17c5b1b6c8 | 2026-03-23T11:40:47Z |
| AgentDojo | ethz-spylab/agentdojo | 089ed468cf3ed0322acc66b0211f26d9d90dbf60 | 2026-06-02T09:59:58Z |
| InjecAgent | uiuc-kang-lab/InjecAgent | f19c9f2c79a41046eb13c03c51a24c567a8ffa07 | 2024-07-02T05:38:20Z |

- τ² 当前文本 agent 以 `HalfDuplexAgent` 的 `generate_next_message(message, state)` 为适配边界；需保留 policy、tool schema、消息历史和调用 ID。原计划三域 airline/retail/telecom 及三个 seeds 保持不变。[官方 agent 开发说明](https://github.com/sierra-research/tau2-bench/blob/cc1df47baa1544a34bb8c8e5c4ca72ad223b96a2/src/tau2/agent/README.md)
- BFCL 扩展 model handler，以仓库中的 `BaseHandler` 与 model config 为边界；仅 HTTP JSON 往返 fixture 不证明 BFCL evaluator 已接通。[官方 README](https://github.com/ShishirPatil/gorilla/tree/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/berkeley-function-call-leaderboard)
- AgentDojo 自定义 pipeline 元素继承 `BasePipelineElement`，接受 benchmark 的 runtime 并保留工具执行/注入语义；其 LLM 步骤应转发到 Keel models/runtime API。[官方 pipeline 说明](https://agentdojo.spylab.ai/concepts/agent_pipeline/)
- InjecAgent 上游包含 prompted ReAct / tool-using 评测路径与缓存；适配时需保留其 attack success 判定，不拿“模型复述攻击文本”作为攻击成功。[官方仓库](https://github.com/uiuc-kang-lab/InjecAgent/tree/f19c9f2c79a41046eb13c03c51a24c567a8ffa07)

实现时还需核对 Python 支持版本。当前机器系统 Python 为 3.14.4；不应因上游旧依赖不兼容就关闭检查，可在 Keel 内用锁版本容器/虚拟环境（不改系统 Python）。
