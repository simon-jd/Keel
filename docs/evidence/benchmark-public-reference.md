# 公开基准分数与可比性预查

核查时间：2026-10-24 UTC（本地2026-10-23）。这里只记录公开一手来源，不是Keel的实测结果，也没有证明±5分sanity check通过。

## Qwen3原论文

[Qwen3 Technical Report v1](https://arxiv.org/html/2505.09388v1)（2025-05-14）§4.6和Table17/18：

| 模型 | 模式 | BFCL版本 | 公开分数 |
|---|---|---|---:|
| Qwen3-8B | Thinking | v3 | 68.1 |
| Qwen3-8B | Non-thinking | v3 | 60.2 |

论文的函数调用使用FC格式，多轮评测使用YaRN扩展到64k上下文。这两项不是AWQ量化版本的专用成绩，不能忽略模式、量化、上下文或基准版本而直接比较。

## 所选AWQ模型卡

已实际读取本机下载的固定revision `4da05a8edb55c6046cce958586c33b61da07bb79` README，并核对[Qwen官方模型卡](https://huggingface.co/Qwen/Qwen3-8B-AWQ/blob/4da05a8edb55c6046cce958586c33b61da07bb79/README.md)。其量化对比表覆盖LiveBench、GPQA、MMLU-Redux和AIME，没有τ²或BFCL的AWQ专用数值。不能用其他模型/其他任务的量化损失补造目标分数。

卡中建议non-thinking温度0.7、top_p0.8、top_k20、min_p0，量化版本建议presence_penalty1.5；实际服务/请求若采用其他设置必须在实验manifest中记录。这是公开建议，不是Keel当前已运行配置。

## BFCL官方快照

当前[Berkeley官方榜单](https://gorilla.cs.berkeley.edu/leaderboard.html)标为V4，页面Last Updated为2026-04-12，注明结果使用commit `f7cf735`，可用`bfcl-eval==2025.12.17`复现。Keel候选代码固定为 `6ea57973c7a6097fd7c5915698c54c17c5b1b6c8`，不能把“都叫BFCL”的不同版本、类别、模型精度及生成配置视为同一实验。

最终报告需要先确认同一数据/评分协议、样本全集与聚合方式、模型revision/量化、生成参数和上下文设置，才能计算有意义的公开差值。若没有足够可比的公开结果，按Task8要求记录具体原因，保留原始成绩；不能调答案、筛选有利样本或改评分规则以达到±5分。

## τ²固定版本的正式文本任务集

实际读取固定commit的[上游README](https://github.com/sierra-research/tau2-bench/blob/cc1df47baa1544a34bb8c8e5c4ca72ad223b96a2/README.md)：该版本发布`text-v1`，六种语言各有airline/retail/telecom三个域，每域50个冻结任务。English retail/telecom使用reviewed replacements，另有persona、语言prompt及语义communication judge；上游明确说明与1.x输入/分数不可直接比较。

Keel按原计划三个域/三个seed，选择正式text-v1的English绑定，共150个任务×3seed=450个τ²试验；这是六语言frame的English选择，不是全部六语言成绩。必须用上游正式planner/language binding保留冻结数据与artifact pins，而不是直接把registry所有扩增任务当正式全集。之前7747项manifest来自未指定split的registry全量加BFCL，被保留作为历史自定义计划，撤销“完整正式矩阵”称谓；它没有执行。此处是任务集决策，不是450项已经运行的证据。

## ±5 分对比（2026-10-27，修正评分后）

BFCL 官方榜单的分项数据在 `ShishirPatil/gorilla` 的 `gh-pages` 分支（commit `927b29cc`，2026-10-17），
经 GitHub API 取 blob `55325a87`（git blob SHA1 已校验），原样存为
[`benchmarks-public/bfcl-leaderboard-data_non_live.csv`](benchmarks-public/bfcl-leaderboard-data_non_live.csv)
（SHA256 `19eec286…06d0`）。它有 “Python Simple AST” 一列，就是 Keel 跑的 `simple_python` 400 题这一类。

| 模型 | 公开 Python Simple AST | Keel 本地 | 差 |
|---|---:|---:|---:|
| Qwen3-8B (FC) / Keel Qwen3-8B-AWQ（hermes 工具调用，非 thinking） | 95.50% | 381/400 = 95.25% | **−0.25 分，在 ±5 内** |
| GPT-4.1-mini-2025-04-14 (FC) / Keel Azure 前 10 题 | 91.00% | 9/10（修正评分重评，原记录 4/10） | 只有 10 题，不做对比 |

仍有的差别：Keel 用 AWQ int4 量化，公开结果是原精度；BFCL 代码 pin 是 `6ea5797`，榜单写的是 `f7cf735`；
temperature 0、32k 上下文。所以这是“同一类别、同一题数、数值吻合”，不是同一份配置的复现。
Qwen2.5-0.5B-Instruct 不在榜单上，没有可比的公开数字。τ² 的理由不变（见下）：固定版本的评测协议与公开 1.x 结果不可比，
且用户模拟器和 judge 都是被测的本地模型。

## 本地正式结果闭合后的sanity说明（2026-10-24，224/400 是评分 bug，已由上节取代）

固定本地矩阵已完成：τ² English text-v1为37/450（8.22%），BFCL v4 simple_python为224/400（56%），见[正式报告](benchmarks.md)及[来源绑定统计](benchmark-matrix-summary.json)。没有足够可比的公开结果来证明±5分sanity通过，按Task8的“做不到就记录原因”保留以下差异：BFCL当前只跑v4 simple_python，而论文60.2是v3聚合；AWQ量化revision与公开非量化模型不同；本地temperature0/32k上下文与论文及模型卡建议不同。不能因为56与60.2数值相差4.2就宣称通过同协议比较。

τ²当前固定版本的English frozen任务/persona/语义communication评估，与1.x公开设置不可直接比较；用户模拟器、judge和agent也都使用同一本地8B AWQ模型。151个模型/协议失败包含149次格式失败、2次服务失败，全部计分母且无伪造reward；后者原provider错误未留存，只有job341有离线上下文限制支持性推断，不能把它概括为所有低分的确定原因。没有调整评分、答案、模型设置或筛选任务来追近公开分数。
