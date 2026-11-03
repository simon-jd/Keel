# 外部验收前置条件

更新：2026-10-26 UTC。真实本地850项、Azure固定first10、Task9本轮agent参照校准和Task14的200题实际对比均已独立核验；真实SaaS OAuth往返仍未验证。子agent参照不是human gold，本轮不再等待真人标注。见[基准证据](benchmarks.md)、[校准边界](judge-calibration.md)和[RAG实际结果](rag-eval.md)。

更新：现有 RTX 4090 已只读核对存在，无需租 GPU；默认使用本机 vLLM，模型统一共享缓存、flock 排队、利用率 0.80、批次结束停服。商用 API 可在 10 USD 项目上限、9 USD 开通门槛及凭证/可开通条件满足时使用，只测 1 seed 子集；Azure 仅 rg-keel-lab，现有 rg-mlinfra-westus 禁止修改/删除。此前表中“调用预算上限”等前置条件现在由该文件进一步约束。

| 验收 | 精确前置条件 |
|---|---|
| 商用模型 API | 原Azure固定first10额度已用尽，后续商业judge创建失败且永久闭合；两笔保守预留6.739654400USD全额保留，不重置、退款或重放。当前默认本地模型，不因历史表项再次请求key或登录；新增商业操作仍受既定预算与单独执行范围约束。 |
| vLLM 开源模型 | 现有RTX4090和三个固定revision共享缓存可只读复用；项目按flock排队自行启动有限批次并停服。每批仍需fresh源码、revision/tokenizer、运行时与资源准入，不把GPU存在或既往运行当作本次验证。 |
| OAuth 本地 | 32 字节本地 AES-256 key file，权限 0600；生产可另接 KMS，不创建云 key |
| Slack | Mac已登录Keel Dev及空App；最小本地公共PKCE使用client id，无bot scopes，user scopes为`search:read`/`chat:write`，回调`http://localhost:19101/oauth/slack/callback`。真实回调可达性、虚构数据测试频道ID及授权/安装待验；新增敏感配置或持久凭据由协调者按具体页面一次确认，当前不修改。完整MCP另需真实AS/签名映射。 |
| GitHub | 测试 org、GitHub App id/private key、installation id、client id/secret、webhook secret、issue/checks 所需权限和 callback URI |
| Google | OAuth 测试项目、client id/secret、注册 callback URI、测试用户；只授权 Gmail search/draft 与 Calendar availability 所需范围 |
| Salesforce | Developer Edition、Connected/External Client App、client id/secret、callback URI、测试 Case 和对象白名单 |
| Langfuse | 自托管实例及 OTLP 凭证、OTel collector endpoint；仅本地 compose，启用前需配置非示例密钥 |
| 真实 benchmark | 锁定 τ²-bench / BFCL / AgentDojo / InjecAgent 版本与数据许可、相同 seeds、可用模型、执行预算；记录 git sha / prompt hash / temperature / 成本 |
| Judge 校准 | 用户授权的300主标/100盲复标子agent标签及最终705次本地调用已完成并独立核对。保持`reference_origin=subagent`、`human_evidence=false`，原始AI-AIκ与非盲仲裁分开；本轮没有真人待办。实际校准未放行可靠judge，只允许披露限制的弱诊断。 |
| RAG | 固定Kubernetes CC BY4.0语料、N896、用户授权的200条子agent QA/gold chunk及真实对比均已审。Recall@10为44/200→51/200；弱诊断168/200，faithfulness=null/reliablefalse/humanfalse，不把弱参照或judge通过率当可靠真实性，也不再要求本轮真人QA。 |
| CI 演练 | 用户后续允许推送测试分支/运行托管 CI 时验证；本任务明确不推送，本地门禁演练需独立标识 |
| 可选语音 | LiveKit 开发实例、Deepgram/ElevenLabs 开发凭证与获准预算，100 段脚本音频、LibriSpeech test-clean 子集和硬件/网络记录 |

资源操作按项目预算和已授权执行范围先记估算、做预算准入；不申请未授权费用或付费试用。本地实现、有限评估和证据审查继续推进，外部账号未就绪不阻止独立任务。

2026-10-25账号准备交接（历史，当前以如下更新为准）：Slack空App、Google专用项目、GitHub Free测试组织及私有空repo已创建并有截图/JSON；client配置、最小scopes、callback、安装及密钥/真实往返仍缺，不能由账号存在推出Task5–7通过。Salesforce仍为厂商注册错误，未反复自动注册。原商业十次已耗尽，4.223072USD预留全额保留，不自动追加/退款。共享checkpoint计数范围澄清前保守总数2的GPU准入保持，代码/审查可继续。


2026-10-26当前覆盖：协调者已明确允许三个不同共享预训练模型各一个固定revision、合计23.8GB只读复用；checkpoint最多2个用于每一训练/导出流程，不是共享缓存模型总数2，不增加40GB缓存或8GB项目份额。Slack Mac现有登录有效，远端home-ubuntu缺登录仍是本地事实，已撤回重复登录/验证码请求`call_018df2a1d1ae49cfb7759e637381e5a3`，不复制cookie/session。原始预算及失败记录保留，累计保守预留6.739654400USD。
