# Keel

用 TypeScript 写的 agent 运行时，接真实模型和真实 SaaS（MCP 工具服务器，OAuth 2.0 + PKCE），配套真实模型评测、OTel/Langfuse 可观测性、PII 护栏和可量化的 prompt injection 防御。

真实环境验证未完成的部分明确标为未验证。

评测与执行证据：[docs/evidence/](docs/evidence/)。威胁模型：[docs/threat-model.md](docs/threat-model.md)。资源、外部账号与评估参照边界：[docs/evidence/prerequisites.md](docs/evidence/prerequisites.md)。

本地开发使用 Node 20.19+、pnpm 10.34.8 和 Docker。如果环境没有 pnpm，可只在本项目目录安装工具：

```bash
npm --cache .tools/npm-cache install --prefix .tools/pnpm pnpm@10.34.8 --no-audit --no-fund
export PATH="$PWD/.tools/pnpm/node_modules/.bin:$PATH"
pnpm install --frozen-lockfile
make check   # 全部工作区 tsc 类型检查
make test    # 全部离线测试：tests/resources、bench-adapters、PII（真实 Presidio sidecar）、所有 TS 包
```

Python 测试使用 `.tools/bench-venv`（含 Presidio 和基准依赖）。可选开关见 `Makefile` 顶部注释。

数据库测试使用 Testcontainers 启动隔离的 pgvector/Postgres 容器，不依赖已存在的数据库。测试不调用收费模型 API。部署组件说明见 [infra/README.md](infra/README.md)；完整运行时仍在按任务实现，不能将基础测试通过解读为整个项目验收完成。
