# Task 01：monorepo 与数据层执行证据

日期：2026-10-23。本任务只读 Task 1 brief、计划预审与前置条件，不读取整份计划；遵守 test-driven-development / writing-good-tests。

## 环境与版本选择

- `node --version` → `v20.19.5`；`.tools/pnpm/node_modules/.bin/pnpm --version` → `10.34.8`；`docker version --format '{{.Server.Version}}'` → `29.9.1`。
- 通过 `npm view <package> ... --json --cache .tools/npm-cache` 查询 npm 官方包元数据：Drizzle `0.45.4`、pg / @types/pg `8.23.1`、TypeScript `5.9.3`、Vitest `3.2.6`、@types/node `20.19.43`。
- 首次 `.tools/pnpm/node_modules/.bin/pnpm install` 严格检查失败：Testcontainers `12.2.1` 需要 Node `>=22.22`，当前 Node 不满足。没有关闭 engine-strict；改为兼容的 `@testcontainers/postgresql@10.28.0`（其 testcontainers 依赖 undici 5，避免新版 Node 要求）。Vitest 最新 5 同样不支持当前 Node，故锁定支持 Node 20 的 3.2.6。
- 第二次安装成功：222 packages。上游间接依赖 `glob@10.5.0`、`uuid@10.0.0` 有弃用提示；pnpm 默认不运行依赖构建脚本（cpu-features、esbuild、protobufjs、ssh2），未扩大脚本授权。是否影响运行以真实测试为准。
- 所有依赖锁定精确版本，提交 pnpm-lock.yaml；缓存与 store 仅位于 Keel/.tools 和 Keel/.pnpm-store。

## 官方依据（当日查验）

- [Testcontainers PostgreSQL API](https://node.testcontainers.org/modules/postgresql/)：`PostgreSqlContainer(image).start()` / `getConnectionUri()`，隔离真实容器。
- [Drizzle PostgreSQL columns](https://orm.drizzle.team/docs/column-types/pg)、[constraints](https://orm.drizzle.team/docs/indexes-constraints)：uuid、jsonb、timestamp、enum、外键与复合主键 API。
- [pgvector 官方 Docker 文档](https://github.com/pgvector/pgvector#docker)：使用 pgvector Postgres 镜像；本任务测试镜像 `pgvector/pgvector:0.8.1-pg17`。
- [Langfuse 官方 compose](https://github.com/langfuse/langfuse/blob/main/docker-compose.yml)、[部署说明](https://langfuse.com/self-hosting/deployment/docker-compose)：当前 v4 需 web、worker、Postgres、Redis、ClickHouse、S3 兼容对象存储。
- [OpenTelemetry Collector configuration](https://opentelemetry.io/docs/collector/configuration/)：OTLP receiver、环境注入与 pipeline 配置。

## TDD 证据

1. 先创建 monorepo/test 工具配置与真实 Testcontainers 测试，migrations 目录为空，未创建 schema 或生产迁移。
2. 测试命名 `migrations apply and roll back cleanly`。能捕获的错误：缺失业务表、down 迁移遗漏、回滚后遗留 enum / relation / function。期望表名为独立字面量 `['actions', 'runs', 'steps']`，最终检查 public 中 relation/type/function 均为空，不使用 mock。
3. RED 命令：`.tools/pnpm/node_modules/.bin/pnpm -F db test`。真实运行 2026-10-23 19:12:34，本机容器启动成功，测试以断言失败结束（exit 1）：`expected [] to deeply equal [ 'actions', 'runs', 'steps' ]`，不是 Docker/导入/语法失败。首次耗时 18.92s（含镜像首次拉取）。
4. 在实现前补充真实写读与约束测试，再运行同命令：3 tests 失败，因 runs/steps 尚不存在。调整测试以每个 migrated-database case 独立 up/down，避免前后用例的数据依赖；未添加 mock。
5. 创建 Drizzle schema 与 `0001_initial.up.sql` / `.down.sql`，再次运行 `pnpm -F db test`：3 tests 通过，7.52s。迁移实际创建业务表和四值 enum；down 逆依赖顺序删除，public 中 relation/type/function 最终均为零。
6. 完善 Drizzle 实际 insert/select 与独立原生 SQL 读取验证：UUID 默认生成、JSON 往返、timestamp、跨两个 tenant 的相同 seq 可用；四种 action 状态有效，无效 RETRY 被 PostgreSQL enum 拒绝；重复 run/action/同 run 的 seq、两个孤儿外键、缺少必填字段、删除带审计子记录的 run 均被真实数据库约束拒绝。该正向验证也检查 Drizzle camelCase 与 SQL snake_case 映射一致。


## 配置与最终验证

- Langfuse 官方 GitHub releases API 当日返回 `v4.69.0`；`docker manifest inspect docker.langfuse.com/langfuse/langfuse:4.69.0` 与 worker 同版本均 exit 0。MinIO 官方上游当前推荐 Chainguard 镜像，`docker manifest inspect --verbose cgr.dev/chainguard/minio:latest` 解析 linux/amd64 digest `sha256:a893442cd57d795411ace0b9a78f26a65e3f6e546d3f25c24e19f8446b0d9718` 并锁定，未启动它。
- 测试镜像实际报告 `postgres (PostgreSQL) 17.8 (Debian 17.8-1.pgdg12+1)`；拉取的 repo digest 为 `pgvector/pgvector@sha256:3e8b3adfd27b5707128f60956f62a793c3c9326ea8cfaf0eab7adccb5d700b21`。镜像标签固定 pgvector 0.8.1 / PG17，Postgres patch 以实测为准。
- `docker compose version --short` → `5.3.1`。使用 Python subprocess、`--env-file /dev/null` 运行 `docker compose -f infra/docker-compose.yml config --quiet`：清除所有必填密钥 env 时 exit 1，明确拒绝缺失 `LANGFUSE_POSTGRES_PASSWORD`；使用 `secrets.token_hex(32)` 只向子进程环境注入独立随机值后 exit 0。未打印或落盘这些临时值，未启动 compose stack。
- `docker run --rm -e LANGFUSE_OTLP_AUTH_BASE64= -v "$PWD/infra/otel-collector.yaml:/etc/otelcol/config.yaml:ro" otel/opentelemetry-collector-contrib:0.160.0 validate --config=/etc/otelcol/config.yaml` → exit 0。只运行 collector 配置校验命令，没有运行整套服务。
- Collector 的 HTTP exporter 使用 `/api/public/otel`、Basic env auth 与 `x-langfuse-ingestion-version: "4"`，依据 [Langfuse OTLP 文档](https://langfuse.com/integrations/native/opentelemetry)。经 controller 确认，默认 traces pipeline 使用 nop，Task 4 白名单接入前不导出任意文本；Task 15 再实现完整 PII fail-closed。
- 根脚本首次直接用项目内绝对路径启动时发现递归脚本找不到系统 `pnpm`（`sh: pnpm: not found`）。未修改全局环境；后续命令统一前置 `PATH="$PWD/.tools/pnpm/node_modules/.bin:$PATH"`，标准 monorepo 脚本保持可移植。
- 最终工作区命令：`PATH="$PWD/.tools/pnpm/node_modules/.bin:$PATH" .tools/pnpm/node_modules/.bin/pnpm test` → 1 file / 3 tests passed，3.58s；相同前缀 `pnpm typecheck` → exit 0；`git diff --check` → exit 0。

## 自审与边界

- brief 的全部三表/字段和 action 四值保留，run/step status 未擅自定义枚举；steps 复合主键、两个 run 外键、NOT NULL、nullable result 及默认时间与 schema/SQL 一致。
- SQL 迁移事务性、显式双向；目前通过 psql/test helper 执行，没有自动 migration journal，README 写明仅执行一次以及后续新增编号迁移。tenant_id 是数据字段，RLS/业务授权由后续 runtime 实现，未宣称隔离已经完成。
- Langfuse 使用独立 Postgres，避免 Prisma 修改 Keel public；完整 ClickHouse / MinIO / Redis / web / worker 依赖已配置，密钥均来自环境。端口仅绑定 localhost，卷和网络属于本项目。
- 没有运行完整 Langfuse、真实 OTLP ingestion、模型或 SaaS 服务；未推送，未改其他项目或 home 配置。测试仅创建并清理自身隔离 Postgres 容器。
- 自审发现的测试用例顺序耦合已消除；Drizzle 和 SQL 通过真实往返读写核对。回滚遗漏 enum、删除外键、删除复合主键、错误列名、放宽必填字段等现实变异均有对应可失败断言。

最终可复现安装复核：`pnpm install --frozen-lockfile` → exit 0、lockfile up to date；格式整理后最后一次 `pnpm -F db test` → 3/3 passed（2026-10-23 19:19:11，3.61s），`pnpm typecheck` 与 `git diff --check` 均 exit 0。pnpm 的依赖脚本禁用提示保持原样，测试和类型检查实际成功，没有为消除提示授予不必要权限。
