# 模型协议核对（实现前）

日期：2026-10-23。仅查阅公开官方文档，没有发送模型请求、读取 API key 或产生调用费用。

- OpenAI Chat Completions：`stream_options.include_usage` 产生最后的汇总 usage chunk；中途断流时该 chunk 可能缺失。因此本地已知成本不能保证等于供应商账单，断流重试必须保留 unknown usage 的事实。[官方 API 文档](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- OpenAI 流式工具调用参数通过 delta 拼接，仍需 JSON 解析和工具 schema 校验，不能执行不完整参数。[官方 streaming events](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)
- Anthropic `message_delta.usage` 是累计计数，不应逐事件累加；`message_stop` 才是完整流终点。流内 `error` 事件也需处理。[官方 streaming 文档](https://platform.claude.com/docs/en/build-with-claude/streaming)
- vLLM 提供 OpenAI-compatible HTTP serving，真实可用工具解析器、chat template 和模型 revision 仍需部署时锁定。[官方 online serving 文档](https://docs.vllm.ai/en/latest/serving/online_serving/)
- 历史 fixture 可使用有版本标识的模型；例如 gpt-4.1-mini 官方页面已标 deprecated，不能把 fixture 通过视为该模型当前可调用。真实矩阵启动前重新核对模型可用性和价格；定价表保存来源与日期，未知模型禁止静默按零收费。[官方模型页面](https://developers.openai.com/api/docs/models/gpt-4.1-mini)

实现要求：不记录提示词、参数、响应原文或凭证；中断尝试不向 runtime 提交可执行 toolCalls；一次成功逻辑调用仅提交一次结果和已知 usage。供应商可能已经消耗 token 的失败尝试应以 `unknown` 成本状态显式呈现，避免声称“供应商不重复收费”。
