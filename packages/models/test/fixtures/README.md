# 手工协议 fixtures

这些 SSE 是依据 2026-10-23 核对的官方协议手工构造，通过 msw 拦截 fetch 重放；没有 API key，也没有真实账号请求录制或付费调用。

OpenAI fixture 使用历史 `gpt-4.1-mini-2025-04-14`，Anthropic 使用历史 `claude-sonnet-4-5-20250929`。通过 fixture 不能证明这些模型当前可调用。vLLM 测试复用 OpenAI-compatible 协议，使用显式部署 revision 与部署价格，不代表真实部署已验收。

来源与协议限制见 `docs/evidence/model-protocol-sources.md`。片段内容为测试合成数据。
