# MCP 与供应商实现前协议核对

日期：2026-10-23。仅查阅官方公开资料；未访问开发账号、注册App或调用SaaS API。

- [MCP授权规范2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)：MCP HTTP服务是OAuth resource server，须提供protected resource metadata并验证token的目标resource。供应商token不能直接当作MCP bearer；授权服务器可外置。
- [官方TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)：当日main为稳定v2，拆分为server/client包，v1另有维护分支。最终实现需核对实际版本、Node支持及锁文件，不能从文档查询推断已兼容。
- npm官方registry只读查询server/client的latest均2.4.0，engines Node>=20；兼容/sdk为1.32.2、Node>=18。尚未安装或验收。当前[HTTP指南](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html)以createMcpHandler每请求factory为入口；[授权指南](https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.html)提供带audience/expiry检查的resource-server middleware及外置verifier接口，不负责签发AS token。
- [Slack签名验证](https://docs.slack.dev/authentication/verifying-requests-from-slack/)要求对原始请求body计算v0 HMAC-SHA256并检查五分钟时间窗口；JSON重新序列化不等于原始body。
- [Slack search.messages](https://docs.slack.dev/reference/methods/search.messages/)要求user token的`search:read`。不能用bot token fixture掩盖真实权限差异。
- [GitHub App installation token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)由App JWT兑换，响应包含期限、permissions及可能的repository限制。它与用户PKCE token是不同身份。
- [GitHub webhook校验](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)使用`X-Hub-Signature-256`对payload完整性进行校验。
- [GitHub checks接口](https://docs.github.com/en/rest/checks/runs?apiVersion=2026-03-10)需按ref查询并按真实权限限制。实现未开始，尚无SDK、HTTP或真实开发沙箱验收。

## Google能力权限补查（2026-10-23 PDT）

以上MCP/Slack/GitHub条目记录实现前的查询状态；Task6实际安装与验证结果另见`integrations.md`，不能把预查当作验收。

- Gmail回复草稿若先读原线程头，需要单独的读取能力：`threads.get`接受`gmail.metadata`、`gmail.readonly`等授权，列表中没有`gmail.compose`；仅有compose不能假定可读取线程。只读头时可用metadata格式，按已实际授予权限决定是否还需增量授权。[官方threads.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get)
- `drafts.list`接受compose或readonly等权限，返回的嵌套message只有id/threadId；对账若需正文/头，必须再通过受许可的详情接口读取，不能把列表条目当作完整邮件。[官方drafts.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/list)
- Calendar freeBusy支持专用`calendar.events.freebusy`/`calendar.freebusy`或更宽的Calendar权限；响应按日历返回错误与busy区间。实现须按实际能力选择并强制检查权限，不能把错误项视为空闲。[官方freeBusy.query](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)
