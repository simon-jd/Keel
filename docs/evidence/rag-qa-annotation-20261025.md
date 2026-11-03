# Kubernetes QA：子agent弱参照冻结

2026-10-25T17:43:34.851584Z冻结，实际RAG模型/检索评测尚未运行。依据用户“子agent代替真人标注”的授权，两位gpt-6.1-sol/high子agent各制作100条，共200题、200答案、200 distinct gold chunks及200条逐行来源审计。`origin=agent`、`reference_origin=subagent`、`human_evidence=false`；不是human gold。逐调用温度/成本未知。

固定Kubernetes源commit `47132eb5367cfdcba0a3b33a0b3ffc81185bd7e8`，语料版本`685b6988b39330405ff97cc69fcf7d600f963a55615e4653be04722cb95be356`，491 chunks原始文件SHA256 `2de87b1f8644516bf8ca4844202a4a2fe70035cee01b63cf203216d4abed0c21`。原始分配为按文档分层、固定哈希排序及轮转选取200个不同片段，再交替分给作者；四个仅含导航链接的目标在任何指标之前以追加修订替换。原输入、被弃目标和全部修订保留；Namespace −1、Deployment +1，仍覆盖22文档。

独立reviewer gpt-6.1-sol/xhigh逐条读完全部200题答、完整绑定chunk及fact/excerpt/explanation。首次审查C0/I1/Minor6：0174缺headless Service上下文；0119补充SCTP需要CNI支持。原作者只修这两行及对应audit，其他198题和198审计逐字节相同。新的定向复核确认C0/I0/Minor5。root另外完成完整schema/ID/来源/摘录/行SHA/版本/200 distinct目标核验；所有问题均在模型结果出现前修正，不凭评测改标签。

保留五项非阻塞质量限制：0024/0187、0027/0112、0133/0190三对概念重叠（资源、运算符、字段不同）；0047与0124为正确但信息量低的片段题。三对/200条会影响概念权重，不声称没有概念重叠；exact及归一化问题重复均0。

作者分区制作，属于单条一次标注，不是互相重复标注，不计算或声称其间κ。所有作者/reviewer同模型家族，不声称统计独立。A在98条完成后意外看到B的完成摘要（含0124低信息提示），没有读取B题答/audit文件；最后两题取自不同主题，原报告披露了时间顺序。该接触及同家族盲点都保留为限制。两位作者只依据固定片段事实，示例/版本条件不推广为实时Kubernetes行为。

冻结文件保存在私有计划证据区，按原始行字节合并排序并设只读；生产`data/rag/qa.jsonl`当前仍空，待任务实现者导入精确冻结字节及出处承诺：

| 产物 | 字节/行 | SHA256 |
|---|---:|---|
| rag-qa-frozen-20261025.jsonl | 104470 / 200 | `0d7c9ff7be567cab8181b3f2d471c25eed5c909262639a484c43af183f1ee01f` |
| rag-qa-audit-frozen-20261025.jsonl | 304699 / 200 | `72c5b528c4c2c6ae1f35df60665f6afcb5411489e1175958f9a305a604c97ded` |
| rag-qa-freeze-20261025.json | 来源、政策及限制 | `6a38ca444e8259803c6a0e862bd8d803ee68e14abf663bc91224a49403aa75f4` |

原始作者输出及R1前版本完整保存，审计包含真实UTC写入时间、源contentHash/URL、逐字支持摘录、解释与题目行SHA。冻结元数据绑定两个最终作者文件、四份目标修订和完整报告哈希。数据制作与审查没有模型API、GPU、服务、云或真实SaaS调用；工具使用子agent本身不计作已验证的vLLM评测。真实Recall、rerank、faithfulness、回答及延迟/成本继续pending，不由本次数据验收推导Task14或整个项目完成。
