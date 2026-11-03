# R1 资源预算与执行控制证据

日期：2026-10-23 UTC。基线 `ea7f3ef`，分支 `feat/keel-implementation`。范围仅 Keel。Node v20.19.5、Python 3.14.4、Azure CLI 2.91.0、Docker 29.9.1、pnpm 10.34.8；没有新增第三方依赖。

## 实际 Azure 检查与开销

- 使用提升权限的 `az account show --query '{name:name,id:id,state:state}' --output json --only-show-errors` 核对：`Azure for Students`、`Enabled`。订阅精确绑定在 helper；此证据不包含凭证/token。
- 普通沙箱的 Azure CLI 因无法在 `~/.azure/commands/` 写命令日志失败，未更改全局配置、未复制 token。
- 首次请求运行 `bash scripts/azure_reaper.sh` 被自动审批拒绝：清单有异常/不归属项时，旧实现仅跳过该项，未整体阻止删除。拒绝后未执行真实删除；新增“合法过期资源＋异常后续项”回归，观察 RED 12 个异常子案例，然后修正为整个清单先通过校验再进入删除。
- 会话开始（helper 落地后）与结束均实际执行提升权限的 `bash scripts/azure_reaper.sh --dry-run`，两次均证明 **rg-keel-lab 不存在**。结束输出：`{"scope":"rg-keel-lab","exists":false,"dry_run":true,"scanned":0,"eligible":0,"deleted":0,"skipped":0}`。没有可清理对象，因此不重试无必要的真实删除入口。
- 没有查询/修改 `rg-mlinfra-westus`，没有创建 Azure 资源，没有调用收费模型；真实台账预留 0 条，`budget.py status` 返回累计 0，实际累计估算 **0.00 USD**。没有真实执行 `make azure-down`。无资源报价需求，未捏造 Azure SKU/价格。

## 本地验证命令和结果

```bash
python3 -m unittest discover -s tests/resources -v
PATH="$PWD/.tools/pnpm/node_modules/.bin:$PATH" pnpm test
PATH="$PWD/.tools/pnpm/node_modules/.bin:$PATH" pnpm typecheck
python3 scripts/resource_check.py compose
python3 scripts/resource_check.py disk
python3 scripts/budget.py status
git diff --check
```

- Python 资源控制：16 项通过。使用隔离临时 fake az、fixture quote/ledger、CPU 子进程执行真实 helper；没有向真实账本写 fixture 预留。外部 Azure/Docker 命令边界可替换，预算锁/文件原子写/GPU 排队与进程清理均是真逻辑。
- 全工作区：上述 16 项＋db 3 项＋models 37 项通过；两个 TypeScript 包严格类型检查通过，Node v20.19.5。未修改 db/models 源码。
- RED 先于实现：首轮缺少四个 helper 时观察资源正向路径断言失败；新增磁盘占用/真实 Compose 检查也先因缺少 helper 失败。清单整体拒绝回归先出现 12 个预期失败；金额精度回归先出现 `9 USD + 极小正额` 被错误允许，再向上取整修复。最终全部 GREEN；重复栈不贴入证据。
- Azure fixture：过期自有项可删；未来不删；错标签、缺失/异常/非 UTC TTL、跨 RG、错误订阅、路径穿越/编码/选项样式 ID 均整体零删除；dry-run 零删除；整组目标固定且有 preview。
- 预算 fixture：并发两个各 6 USD 预留仅一个成功；累计达到 9 USD 后任何正额拒绝；NaN、负价、未知价格/单位/币种、非官方来源、过期报价、Azure 基础设施均拒绝。执行失败保留潜在支出且不能重放。
- GPU 包装器只用轻量 CPU 子进程模拟：验证互斥排队、异常释放、timeout 的 TERM/KILL、正常退出和信号后后台子进程清理。没有启动真实 GPU workload，没有安装 vLLM/torch，没有下载模型或创建共享缓存/锁。

## 当前本地资源快照

`resource_check.py compose` 实际经 Docker Compose 归一化配置：8 服务，单副本硬内存总额 **11,811,160,064 字节（11 GiB）**，小于 16 GB。所有服务含 Keel 标签；未启动全栈。

磁盘一次实际只读结果：项目 361,492,480 字节，配置引用的本地镜像 1,616,465,391 字节，Keel 卷与容器可写层均 0，合计 **1,977,957,871 字节**，小于 8,000,000,000 字节。文档写入/验证会使项目字节略变，该数是当次快照。镜像按完整大小保守计入，未给共享上游镜像补标签，也未删除镜像：

| 已存在且被项目配置使用的镜像 | 字节 |
|---|---:|
| pgvector/pgvector:0.8.1-pg17 | 626,537,764 |
| otel/opentelemetry-collector-contrib:0.160.0 | 509,470,672 |
| postgres:17.11-alpine | 423,156,714 |
| redis:7.4-alpine | 57,300,241 |

MinIO、ClickHouse、Langfuse 与 worker 四个镜像当前未拉取，未来占用未知；不能据当前空缺宣称全栈部署后仍满足磁盘额度，pull 前须用实际镜像大小重新预估。检查只枚举本项目标签的卷/容器及项目引用/标签的镜像，没有全局扫描、prune 或其他项目删除。

## 未验项与后续前置条件

真实 GPU、vLLM 启动/健康检查、HF 缓存40GB配额、模型大小和 checkpoint 数、完整 Langfuse 运行内存未做实测。需要后续基准任务在已安装软件/共享模型缓存下，用 wrapper 启动有限批次并复核磁盘。不可把 CPU 测试称为真实 GPU 验收。SIGKILL/宿主崩溃无法由用户态信号处理器保证清理。

本轮交付收费预算可靠接口；**Task8 必须把所有真实收费评测/用户模拟器 provider 路径接到单次 claim，并落实请求/模型/token 上限，未接入前不得执行真实收费批次**。包装任意命令不等于网络隔离；账本和报价文件也不是防恶意本机用户的安全边界。付费运行前须有官方真实报价、有效 key 或 Azure 可开通模型，并满足用户已经授权的用途与预算准入；授权范围内不重复要求批准。Azure 整组删除与真实过期删除只在 fake az 中验证；生产检查因 RG 不存在，无删除动作。

## 首轮审查修复（FIX_BASE 0687076）

独立审查指出：配置 tag 更新后，项目容器仍可能使用没有项目标签的旧镜像，原统计漏算；另外预算中间运算固定80位精度按最近值舍入，会在 `9 + 1e-100` 时丢失输出费用。本轮仅修这两项，不涉及业务包。

覆盖文件仍为 `tests/resources/test_controls.py`，新增三项真实入口回归：

- `test_disk_counts_untagged_old_container_image_once_after_tag_update`：fake Docker 中两个配置 tag 指向新镜像，两个项目容器指向无标签旧镜像，第三个容器使用新镜像；新镜像100字节、旧镜像8,000,000,000字节，只各计一次，加可写层60字节，总计8,000,000,160字节，必须拒绝。
- `test_disk_rejects_unknown_old_container_image_instead_of_counting_zero`：旧镜像 inspect 缺记录时必须拒绝，不能按0计算。
- `test_budget_mixed_price_cannot_round_down_a_cost_above_nine`：输入单价9、输出单价1e-100，各1个token，预留必须拒绝，临时账本保持空。

实际 RED 命令：`python3 -m unittest discover -s tests/resources -k old_container_image -v` 返回2失败，均为旧实现错误返回0；`python3 -m unittest discover -s tests/resources -k mixed_price -v` 返回1失败，同样为错误允许预留。修复后原命令分别2通过、1通过。原始日志保留本机 `/tmp/keel-r1-fix-red-disk.txt`、`/tmp/keel-r1-fix-red-budget.txt`，本证据只摘录结果。

修复把已校验项目归属的每个容器 `Image` ID 加入配置/标签镜像的统一集合，最后一次 inspect、去重计量并核对完整返回集合；保留 unknown 拒绝规则。预算不依靠增加精度位数，改为所有非负乘加的上下文舍入均 `ROUND_CEILING`，最终仍向上取nanoUSD，因此任何被精度压缩的正额都保守上取。

GREEN及静态检查实际命令：

```bash
python3 -m unittest discover -s tests/resources -v
python3 -m py_compile scripts/azure_control.py scripts/budget.py scripts/gpu_run.py scripts/resource_check.py tests/resources/test_controls.py
git diff --check
```

结果：19测试通过（4.891秒），py_compile和差异检查均exit0。未重跑未改动的Node包。没有Azure调用、GPU启动、下载、收费请求或真实台账写入。本轮不改变前述真实环境快照与0USD估算。提交名称 `fix: count retained container images and round budget costs upward`，提交哈希由交付回复和Git历史记录。

## 后续只读复核（2026-10-24 04:40 UTC／2026-10-23 21:40 PDT）

`python3 scripts/budget.py status` 返回 `{"project":"keel","total_usd":"0","reservations":0}`。普通沙箱的Azure CLI仍受既有登录缓存/命令日志权限限制；提升权限后仅执行 `bash scripts/azure_reaper.sh --dry-run`，返回 `{"scope":"rg-keel-lab","exists":false,"dry_run":true,"scanned":0,"eligible":0,"deleted":0,"skipped":0}`，没有资源修改或删除。

共享HF缓存 `du -s -B1` 为999,661,568字节；`df -B1`可用379,610,386,432字节。均为瞬时快照，不代表预留或份额扩大。Python3.12.13对torch/vllm/transformers的公开模块查询均未发现；系统公开CUDA13.2路径及部分动态库存在，尚未验证Torch/vLLM兼容性。本次没有模型下载、GPU workload、云开通或收费请求。

Task6安装MCP依赖后再次实际执行 `python3 scripts/resource_check.py disk`：project_bytes=986,259,456、image_bytes=1,616,465,391、volume_bytes=0、container_writable_bytes=0，total_bytes=2,602,724,847，admitted=true。原四个完整后台镜像仍列为missing_images_not_pulled，未假定其未来体积。
