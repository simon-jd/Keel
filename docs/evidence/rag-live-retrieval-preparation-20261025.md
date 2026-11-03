# 生产导入/检索阶段：实际数据已审

最新结论：本阶段216次新调用、491chunks导入和200次真实PG检索已完成；root与独立实际数据审计通过，尚无重排/生成/最终RAG质量指标。以下首轮准备与修订记录按当时状态保留，不覆盖本段和末节实际结论。


2026-10-25。已完成的208次embedding维度批次保持原样；新阶段拟真实执行production ingest的16批（32×15+11）及200次question-only查询，共216次新调用、691向量，实际PostgreSQL/pgvector余弦与ts_rank_cd经RRF60取20候选，供后续rerank到10。不复用或拆分旧批次账目，不回改200条agent来源的冻结题答。

专职私有驱动实现者完成AST/strict及合成4项有效、56项拒绝控制；完整报告33866B/SHAfc07b056df36bcb9fcf339fbf0c722734e7e8309f14281b92b609fd8fb4ad68b和7504B验证日志已全文核对，保留两次TypeScript错误及修正。它们不是实际模型、SQL或span验收。R0控制器34197B/SHAb43d4d66df2f3144ff96a88bfecc428a6da5004a1fafdca3829a9912a9f16b56，runner26119B/SHA8e338cef614fa9c0e87f3b813dc978e1d90527e0485cb06b9c6031bcf586da2f。当前没有新阶段plan、key、输出或服务。

独立完整静态审查26982B/SHA3730a2a54d9ddfb6830565cdf8563793d37886e3f5b3486018650f2b40348307已全文读完，Spec/Quality均Changes requested，C0/I1/Minor2。Important：Docker run创建被中断、无CID时，连续空清单不能证明daemon请求已结束；旧分支可能仍错误标记清理已核验。Minor分别为最后清理日志写入在25秒alarm之外、既有tracer把embedding标成chat。旧实际208次/历史PG清理有已返回CID和独立后验核验，不把新静态反例冒充历史真实泄漏。

root已按Spec清理边界修订本阶段配方，R1交回原实现者：先create不启动、持久记录并核验CID与归属后才start；中断创建在现有20秒PG/25秒总清理预算内对账，不能证实settled时保留unknown与失败状态，不能凭空清单宣称资源不存在。官方说明create只创建而不启动；它不证明中断RPC已取消。[Docker create](https://docs.docker.com/reference/cli/docker/container/create/)、[Docker run](https://docs.docker.com/reference/cli/docker/container/run/)。R1须保留原审字节及报告前缀、补相关合成控制，再做独立定向复审；root不自行改这些实现文件。

资源边界不变：8GB项目/7.85GB动态停止线，新增6MB仅为估算；主批次名义12GB/kernel11999997952B/zeroSwap，PG512MiB单独预留，总Keel不超过16GB。共享flock/0.80、现有固定缓存只读、禁止新模型/镜像下载。工作870秒+清理25秒，包装器900秒/grace30，外层930秒/stop35；宽限由原5秒改为30秒是给中断后自有PG清理留足窗口，不扩大4小时GPU上限。须修复、复审、干净提交身份和fresh资源准入后才建实际计划。

无新RAG Recall、rerank、生成答案或judge结果；后续实际评估仍只允许weakDiagnosticJudgePassRate，faithfulness=null/reliabilityfalse，保留负κ、领域false-pass和agent弱参照局限。Slack沿用Mac协调接入方案，当前不改权限/安装、不保存真实凭据、不重复要求登录。

R1独立定向复审已批准：完整报告43238B/SHA `8c3acf8c76cb90776c0aa15a2d9d9b1d89b17846fff17598d4304c93dcf572e7`，原26982B前缀保持；root已全文核对追加内容、命令及错误。Spec/Quality均Approved with nonblocking Minors，I1与最后清理写入的M1均ADDRESSED，C0/I0/Minor2。当前控制器40621B/SHA `8e2df7832cad9c8efa222e6cefb0127a6a0e8c5c580db7068e373cf2aba4f1a2`；runner及协议未变。完整实现报告53473B/SHA `1a59ddc883c0f288e3ce0f467d03359de1cb4e52b8390788a14ff68625e1191e`。旧误报反例先RED、新14项合成控制GREEN；一项probe AST选择错误保留后修正。它们不证明真实daemon或模型行为。

当前实现先持久create意图、create不启动、核验已停止且归属完整的CID、持久CID，再预留PG内存并start；未取得CID的持续空清单仍记unknown/verified=false，要求root按本次归属对账。最后清理写入包含在原绝对25秒预算内。保留Minor：既有chat标签，以及恢复轮询的4秒为名义窗口加最后一次至多2秒查询，并非硬4秒；20秒PG/25秒总硬界限不变。两项交最终全分支审查，未新增阻断问题。静态批准仅允许随后按干净身份和fresh资源门禁尝试有限实际批次，尚无216次结果或实际清理结论。

实际执行与放行：干净`64f0023f9a3e33151bd7bb6cdc25d5fb2f9951be`、producer`39efb875…`/700文件，216物理/648 journal/691 F32向量N896、133689 input/0 output、retry0/unknown0/本地配置API0。16真实导入批次32×15+11，200个question-only查询，1301 SQL成功/0失败、491 inserts、200 vector/200 lexical，保留4037个来源ID；独立重算所有RRF60排序及416个实际span/父子时间窗通过。模型为generative last-token适配，非训练embedding checkpoint；不把配置revision称provider证明。

独立完整实际审计49489B/SHA `3e6788d0e5e37fe79ed599ad78e6fe24553ee52bfca471845311cb6aaca80389`，Spec PASS/Quality APPROVED，C0/I0/Minor2沿用静态限制，无新数据发现。root已全文核对所有命令/输出/错误；全部700当前文件与182份历史blob/完整population、全部216/691/200/416数据一致。原始HTTP/SQL wire正文未保留，SQL余弦/全文函数未在已停DB重跑，不能据此声称wire级独立重放。

22:16:09Z清理1.427秒完成，单元76.975秒退出0；已知CID创建/停止checkpoint先于start，精确归属CID移除及ID/name缺席。22:17:07Z后验unitGC/dead/MainPID0、18000/18080/32842无监听、GPU锁可用、key/state删除、9份缓存及执行身份未变。运行active硬限与持锁证据另存，后验默认属性不替代运行限制。startup仅10215B有界prefix，尾部半行保留，不是全生命周期wire日志。见[安全聚合元数据](rag-live-retrieval-actual-20261025.json)。下一阶段真实重排/答案/弱judge驱动正在私有实现和CPU验证，未启动；历史208维度批次账目单列。
