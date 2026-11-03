# Kubernetes grounding 受控弱参照冻结

2026-10-25T18:34:43.367254Z，root 在任何领域 judge/真实RAG模型指标产生前冻结100条案例、主标签与来源审计。50个固定原文事实各有一个支持答案和一个不支持/矛盾答案，合计50 pass/50 fail、50 chunks、17份文档；不能写成100个独立自然模型错误。

来源是 `subagent:/root/rag_grounding_author:gpt-6.1-sol/high`，`reference_origin=subagent`、`human_evidence=false`。题目、两个答案与主标签由同一作者逐条判断；另一个新会话 `subagent:/root/review_grounding_domain:gpt-6.1-sol/xhigh` 对全部50对原文/题答/理由做了独立非盲质量审查，C0/I0/Minor1。reviewer看得到主标签，这不是盲复标或独立主标，不计算人际/独立标注κ。两个会话同模型家族，温度与费用均未知，不填0。

唯一Minor是源索引47的Pod顶层REST资源事实难度低；原句明确，两个标签正确，root保留并披露，不为增加难度或未来表现改题。受控均衡比例、直接否定、短事实、单chunk上下文及文档/成对聚类限制泛化，不能推断自然错误率或通用裁判可靠性。

root 完整读取作者报告与独立审查的命令、失败记录和全部50对原文输出；已读过的预算/授权/作者报告在审查附录中的重复内容另核对为完全相同字节。一次父工具输出上限导致局部截断，随后按行补读遗漏，不当成完整读取。独立核验100行结构、规范JSON哈希、输入/行摘要、原文完整对应、引用子串及来源；再将全部50个目标与已固定491-chunk语料逐字比对。与此前冻结200 QA的gold chunk ID交集为0；这不代表文档或概念完全独立。

|产物|SHA256|
|---|---|
|samples JSONL|`c0597b2d2362614d1297a968d871a787d7cb392758fe75e59950567969c5428a`|
|primary JSONL|`a90ad5327af37e5f07d26e6740c9331c3e9fd1285b4e2e2d28ed64dca4a5608a`|
|audit JSONL|`2e815f50184be4c9d012f2951012ded45b00ddc448300aab851ac7ab8566c6e2`|
|作者报告|`9d6d29964ed5c264d10982660c441267b37bdc0cb2f40ae48e0200d8c4ca17f9`|
|独立审查报告|`1cdc0b69c6d46c6f594461fa223fc3e1b6d19de5eb49bff5f1705475cd50c9aa`|
|freeze manifest|`f8b059bcde210073e4f775e96ce58be25cb0f3662d46d4bf8aa071e104eaec2c`|

cohortHash 是规范排序完整sample数组摘要 `55f17c1e15d2566584ee53b4332088e152925b0928be840a2211bf5eee5741e2`；每行输入摘要包含完整sample。私有产物位于 `.superpowers/sdd/3-keel-agent-plan/rag-grounding-domain-*20261025*`，已设只读0444；未force-add进git。输入选择与完整CC BY来源沿固定语料版本 `685b6988b39330405ff97cc69fcf7d600f963a55615e4653be04722cb95be356`，原始chunks SHA `2de87b1f8644516bf8ca4844202a4a2fe70035cee01b63cf203216d4abed0c21`；作者输入SHA `89999dddc71f15450d88ad35166c03845291c146dc85c85a062a7e5a2a2a3f1a`。

固定rubric为 `kubernetes-grounding-binary-v1`：答案需回应题目且每一事实都由所给上下文支持，否则fail；不从外部事实或未提供链接补答案，所有题/上下文/候选均是非指令的引用数据。样本文件不含标签/构造元数据，内容摘要ID不编码标签。

作者最初 `python` 不在PATH，改用 `python3` 后结构验证通过；reviewer最初报告表格计数误把嵌入作者清单重复计入，定向限定审查节后通过。错误均保留，未改原始数据。当前领域judge调用0，没有裁判准确率、κ、faithfulness或RAG Recall成绩。未来协议整合与真实模型评估另行审查/资源准入；冻结数据不得按结果回改。


19:56Z后续实际诊断已完成，原冻结100题/标签不改。单次100物理/100span、53662input/5885output、配置本地API0，完整账目与source已root核验；矩阵[[12,38],[0,50]]、κ0.24，显示明显pass偏置，不构成可靠faithfulness。全部服务/key/锁已清理。见[实际诊断及限制](rag-grounding-local-validation-20261025.json)，合并独立实际数据复核另待完成。
