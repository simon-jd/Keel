# OAuth 协议核对（实现前）

日期：2026-10-23。未访问账号、未创建 App、未使用用户数据。

- Slack 已支持 PKCE，需要在 App 中启用相关设置；授权请求携带 challenge，token 交换提供 verifier，不能根据旧知识降级成无 PKCE。[Slack 官方文档](https://docs.slack.dev/authentication/using-pkce/)
- GitHub 从 2025-07-14 起对 OAuth App 和 GitHub App 用户授权支持 PKCE；App installation 身份仍需单独建模，不能把用户 token 当 installation token。[GitHub 官方公告](https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/)
- Google installed-app OAuth 文档包含 S256 verifier/challenge 步骤，callback/客户端类型需匹配实际注册配置。[Google 官方文档](https://developers.google.com/identity/protocols/oauth2/native-app)
- Salesforce web-server OAuth flow 包含 code_challenge / code_verifier；使用 Developer Edition 测试域并启用 PKCE。[Salesforce 官方文档](https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm&language=en_US&type=5)
- Slack未启用rotation时token可能不失效；启用后access/refresh需轮换，bot/user身份不可混用。[Slack rotation](https://docs.slack.dev/authentication/using-token-rotation/)
- GitHub当前OAuth支持可选过期token，响应不一定含refresh token；实现应按实际字段处理，不能给所有供应商统一捏造期限。[GitHub OAuth](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)

状态有效期、单次使用、租户与 provider 绑定、token 加密、轮换竞争、撤销与 scope enforcement 都需本地可重复测试；供应商真实往返仍未验证。
