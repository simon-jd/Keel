# Task8 证据分段与资源核验

2026-10-24，正式批次016结束后执行。生产代码、850项manifest、原结果行和评分规则均未改动。

活动目录原压缩逻辑总长51,635,089B，接近既有64,000,000B写入上限。为保留所有历史证据，已将关闭的airline/retail共311份artifact移至固定私有目录 `.tools/benchmark-artifact-archive/formal-airline-retail-0dbe966`。其中256 completed、44 failed、11历史incomplete，共300个终态job；文件压缩总长41,071,806B，活动目录剩余10,563,283B。仅使用同文件系统禁止覆盖的rename，没有复制、重压缩或删除artifact。

方案及实际operator脚本均经独立复核；首次发现的pending持久化顺序，以及脚本恢复分支遗漏的目录/已有索引fsync，均修复后复审关闭才执行。先完整持久化pending索引，每次移动持久化两端目录，最终索引和完成标记均持久化后才解除pending。崩溃恢复逐项要求恰好一个有效位置，核对inode/hash/metadata，冲突停止；存在pending时禁止启动下一GPU批次。操作进度日志和索引保留，权限0600，两个artifact目录0700。

实际create进程exit0，随后独立verify命令exit0：311份均保持原inode、compressed/raw SHA和长度、完整metadata、空人工标签；未选文件不变，原路径已移除，结果JSONL字节和执行identity不变，pending不存在。一次在create进程尚未结束时发起的提前verify被pending保护拒绝，未修改材料；等待同一进程正常结束后重新验证通过。

可信索引为 `.tools/benchmark-artifact-archive/formal-airline-retail-0dbe966.index.json`，只含路径、来源ID/hash/长度和inode等定位元数据，不含prompt、输出或凭证。完成标记绑定索引SHA；原行仍保存原basename，不重写历史。

| 核验项 | 实际值 |
|---|---|
| 索引 SHA256 | `851e8b6b36a1033b7bfe5bfc82ca39104702f4f79ebaa78c7bd959537858296f` |
| 原JSONL快照前缀长度 | 8,476,149B |
| 原JSONL快照前缀 SHA256 | `d1ddfaeba73f4b2962617522dc20fe3d2e46fcedfca1cf014b1368fa63353c6c` |
| 冻结implementation SHA256 | `864bcdb6dbaeb31487173c3a0f6697af401ca9c19d5fd08612f3db24516c44f1` |
| 最终全项目占用（含相关镜像） | 7,749,275,119B |
| 可重建pyc/pyo清理 | 6,565份，70,389,760B分配块 |

缓存清理仅限本项目bench-venv/bench-upstream两树内`__pycache__`中的自有regular pyc/pyo，逐文件lstat核对后删除；源码identity与结果字节均不变。共享模型、真实artifact、未带项目标签的Docker镜像均未删除。

活动段维持64,000,000B写入上限，关闭段固定不再写入且≤64,000,000B，两段压缩逻辑总长≤128,000,000B。目录实际块、索引、诊断和临时文件始终计入原8,000,000,000B全项目限额与7.85GB运行停止线，不豁免归档占用；不保证剩余504项一定容纳。后续每批准入先验证无pending、完成标记/索引/归档hash和JSONL原快照前缀，再做实时磁盘/内存检查。

当前冻结runner续跑只校验原结果行，不读取旧artifact路径。未来Task9/10的材料loader仍须单独实现和审查：只允许上述两个固定可信root和唯一索引映射，校验完整stream来源及原row/basename/hash/长度，拒绝重复定位、任意路径、symlink和无界解压。后续正常append只核对原快照前缀，不能用旧全文件SHA误拒合法追加。分段不补造缺失原输出、不改变失败分母或unknown成本状态。

历史材料读取以原manifest中保存的implementation文件清单/hash、原row的执行来源及artifact绑定为准。后续Task9等正常新增生产代码后，读取旧样本仍须验证这些历史绑定；当前HEAD无需等于旧执行HEAD。原正式manifest若要继续执行，仍必须通过原`verify_execution`的当前源码严格匹配检查；新实现/模型的实验应建立新manifest。当前operator归档脚本的`verify`用于冻结矩阵运行阶段，未来loader须单独实现历史读取验证，不能直接复用其“当前执行代码必须等于旧manifest”的准入前提。
