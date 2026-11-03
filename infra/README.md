# 本地基础设施

该 compose 项目名为 `keel`，使用自身网络、命名卷与 localhost 端口，不复用其他项目服务。Task 1 只验证配置与隔离的迁移容器；2026-10-29 Task 4 起过完整 stack 并验证了真实 Langfuse 入库（见下）。

1. 从仓库根目录执行 `cp infra/.env.example infra/.env`，设为 `chmod 600 infra/.env`。为每个必填变量生成独立随机值（例如 `openssl rand -hex 32`），写入该本地文件。`LANGFUSE_ENCRYPTION_KEY` 必须为 64 位十六进制；数据库密码必须 URL-safe；MinIO root password 至少 8 字符。没有默认密码，未注入时 compose 直接报错。
2. 校验：`docker compose --env-file infra/.env -f infra/docker-compose.yml config --quiet`。不要把解析后的完整配置输出到日志，因为它包含注入的密钥。
3. 需要本地环境时再运行 `docker compose --env-file infra/.env -f infra/docker-compose.yml up -d`。默认端口为 Postgres 15432、Redis 16379、Langfuse 13000、MinIO 19000、collector gRPC 14317 / HTTP 14318，均绑定 127.0.0.1，可通过相应 `*_PORT` 环境变量覆盖。
4. 在 Langfuse UI 创建本地项目与 API keys，将 `public-key:secret-key` 的单行 base64 写入 `LANGFUSE_OTLP_AUTH_BASE64`，不要提交或打印密钥。Collector 已配置 HTTP exporter 与 v4 ingestion header，但默认 pipeline 使用 `nop`，不导出 traces。Task 4 建立属性白名单后才能选用 `otlphttp/langfuse`；Task 15 接入完整 PII fail-closed processor 后再验收真实导出。
5. 停止只操作本项目：`docker compose --env-file infra/.env -f infra/docker-compose.yml down`。不要对其他项目执行清理；命名卷默认保留。

Langfuse 使用独立 Postgres 数据库容器，避免它的 Prisma 迁移修改 Keel 的 `public` schema。ClickHouse、Redis（noeviction）及持久化 MinIO bucket 是当前 Langfuse v4 所需依赖。MinIO 镜像按本机 linux/amd64 manifest digest 固定；其他架构需另取官方 digest。Keel 的 pgvector 镜像提供 extension 二进制，Task 1 不创建 vector 类型或索引，后续 RAG 迁移显式启用扩展。

## 数据库迁移

`packages/db/schema.ts` 是 Drizzle 数据层定义；SQL 显式 up/down，文件按编号顺序执行 up，逆序执行 down，均用事务包裹。当前没有自动 migration journal/重复执行保护；只对未应用该迁移的数据库执行一次。已应用迁移保持不变，后续任务新增编号迁移。

例如在已经准备好的 Keel 数据库执行（在本地交互环境设置 `PGPASSWORD`，不要写入命令历史）：

```bash
psql -h 127.0.0.1 -p 15432 -U keel -d keel -v ON_ERROR_STOP=1 -f packages/db/migrations/0001_initial.up.sql
# 仅在明确要撤销业务表及数据时执行对应 down 文件。
```

SQL 保持 brief 的 snake_case 字段，Drizzle 使用 camelCase 属性并显式映射。`tenant_id` 为 text，run / step 状态为必填 text，brief 只限定 action 的四值枚举；pending action 的 result 允许 NULL。steps 的 `(run_id, seq)` 唯一，两种子记录必须引用已存在 run；删除 run 不会隐式级联删除审计数据。时间使用 timestamptz；`updated_at` 只默认插入时刻，状态变更时由调用方在同一事务显式更新。tenant_id 为后续 runtime 查询的租户边界，本任务未宣称已实现 RLS 或授权隔离。

真实隔离测试（需 Docker）：从根目录运行 `pnpm -F db test`；全工作区严格类型检查 `pnpm typecheck`。若系统未安装 pnpm，先将 `$PWD/.tools/pnpm/node_modules/.bin` 加入 PATH。

## Task 4 本地 Langfuse 入库实验

`python3 scripts/langfuse_ingest.py run OUT --runs N` 在一个进程里完成：随机生成一次性密钥（只在内存，不写 `.env`）、用 `LANGFUSE_INIT_*` 无界面建项目和 API key、
选 `otel-collector.langfuse.yaml`、经 GPU 锁跑真实 agent 运行、读回 Langfuse、扫描原始 PII、最后 `down --volumes`。中途被杀时用 `python3 scripts/langfuse_ingest.py down` 清理。
结果见 `docs/evidence/task-04-tracing.md` 末节。

## Task 4 度量导出

默认 collector 仍为 `nop`。显式设置 `OTEL_COLLECTOR_CONFIG=./otel-collector.langfuse.yaml` 可选择度量白名单路径：OTLP → collector → `http://langfuse:3000/api/public/otel/v1/traces`。只在完成资源准入、有本地 Langfuse 项目凭证后重建本项目 collector；`LANGFUSE_OTLP_AUTH_BASE64` 由本地环境注入，v4 header 已固定。不得将真实 prompt、工具参数/结果或异常文本送入该路径。它不是 Task 15 的 Presidio 内容脱敏实现。

应用启动时显式配置一次，进程退出时等待 shutdown（未配置时本包不导出，也不接管其他库的全局 OTel provider）：

```ts
import { configureTracing } from 'tracing/exporter';
const tracing = configureTracing({ endpoint: 'http://127.0.0.1:14318/v1/traces' });
// 正常使用 models.createRouter / runtime.runAgent。
await tracing.shutdown();
```

也可省略 endpoint，通过 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 设置完整信号 URL，或通过 `OTEL_EXPORTER_OTLP_ENDPOINT` 设置 base URL（自动追加 `/v1/traces`）。真实 OTLP 默认使用有界 BatchSpanProcessor；`forceFlush()` 只说明 SDK 已尝试 flush，不能证明 Langfuse ingestion。`observerStatus: delivered` 仍只代表 observer 回调成功。

`withSpan('llm' | 'tool' | 'retrieval', attrs, fn)` 的 callback 仅得到安全 `setAttributes`，初始和后加属性都经过键/值白名单；SDK exporter 再投影整个导出对象，剔除 events、links、status message、traceState，固定 service/scope，并阻断全局 provider 绕过。模型名只允许 128 字符内的配置标识符，run_id/call_id 仅允许 UUID / UUID:序号；不符合的标识符会被省略。collector 另拒绝外部 scope、events、links、非法白名单值，清除 resource/scope/schema/status/traceState 的额外内容。此受限路径仅支持可信配置中的模型标识符，不能替代任意文本的 PII 检测。

每个模型逻辑调用（包含供应商重试）产生一个 llm span。已知 attempts 的 token 与成本各计一次，Anthropic 累计 usage 在适配器归一后计入。`keel.cost_usd` 是已知小计，必须同时读取 `keel.cost_status` 与未知 attempt 数；未知不得当成零总成本。runtime 返回 `cost: { status, knownUsd, totalUsd }`，unknown 时 `totalUsd` 为 null，从 checkpoint deliveries 重建并将没有 accounting 的已预留调用保守计为 unknown；成本恢复不依赖 exporter 或 observer。新增 `Tool.traceKind?: 'tool' | 'retrieval'` 仅分类实际执行，不提供检索实现。

真实协议测试：`pnpm --filter tracing test`。它运行隔离 Postgres、已有 collector 镜像、真实 SDK/in-memory exporter 和本地 HTTP 接收 fixture，解码双跳 protobuf 并检查信号路径、Basic fixture credential、v4 header、白名单与错误面。该测试没有启动真实 Langfuse 后台、没有验证 ClickHouse/worker ingestion，也不调用付费供应商。
