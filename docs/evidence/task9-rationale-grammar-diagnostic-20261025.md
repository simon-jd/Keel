# 单字符理由的有限 CPU 诊断与修订决定

2026-10-25。独立审查发现旧native profile的605条完整理由均为单字符。进一步CPU诊断复现了安装的xgrammar0.1.29语法限制机制：JSON-schema rationale pattern被转换成仅一个字符的完整字符串语法；A可接受，AS和Supports requested tool and arguments.均拒绝。这足以解释使用该backend/schema时普通理由为何被限制，但不证明历史每次请求的backend、不解释标签选择或负κ的全部原因。历史启动配置是auto，未保留逐次backend telemetry。

只读诊断报告9146B，SHA256 422fabcf3750e45c0f98fb2a30916632805d73e659504452314596b15b1d21a6，私有路径 .superpowers/sdd/3-keel-agent-plan/task9-xgrammar-rationale-diagnostic-20261025.md；只读原始命令/输出/错误388行67211B，SHA256 42739fc3b548e6533fda68ef2101f0259cb68bfd8e1e57c8520889c2b1e5758b，同目录task9-xgrammar-rationale-diagnostic-20261025-probes.txt。root全文读取；初次父工具显示截断的中段已完整补读，无遗漏。

使用现有Python3.12.13直接加载已审派生native core，避开会导入Torch的普通包入口，分别比较from_json_schema→compile_grammar→matcher及compile_json_schema→matcher两条真实路径。104条主case/variant加18条控制字符记录，两路径全部一致。每次1GiB虚拟地址/35秒CPU/40秒alarm/42秒outer，单线程，禁止网络/进程派生/写入；主probe0.9038秒、RSS190068KiB，补充0.0078秒、RSS22648KiB；Torch未导入且无CUDA/Torch映射。没有模型、GPU或服务调用。初始查询native未导出的VocabType及结束后存undefined session错误原样保留，不当通过结果、不重复主probe。

|候选|已实测行为|决定|
|---|---|---|
|旧单个非空白字符pattern|仅一个普通字符；部分非法raw控制符也可被native接受|保持旧版本/结果，停止继续以它作可靠性依据|
|去pattern，保留min1/max32768|普通多字符文本、Unicode及32768字符可接受；部分合法JSON转义被过度拒绝；纯空白、部分非法raw控制符可接受|允许作为独立v2实施和评估，最终严格parser必须原样保留|
|在pattern前后补任意字符重复（含锚点版本）|可吞入JSON语法、duplicate rationale、raw newline、转义空白及超长字符串；converter警告忽略min/max|不采用|

去pattern并不使native grammar成为安全解析器。原parseVerdict的严格JSON/duplicate-key/形状/label/trim/max规则继续fail closed，失败保留usage/成本/intent/hash，不放宽解析来接受语法缺陷。它仍可能约束合法转义的生成，不能预先声称所有格式或裁判质量通过。

root决定单独新增trusted task9-local-json-schema-v2，v1 identity/schema/wire哈希和旧artifact保持可验证；新wire/hash/输出命名明确分开，原guard/prompts/rubric/模型/sampling不改。新的控制器会显式选择xgrammar且禁fallback；安装版本、实际启动配置与源指纹另行绑定。生产修订和全新5+300+300仍须独立代码审查、资源准入和实测，当前没有运行。100条领域弱参照仍冻结且未评测，不凭已知有问题的协议先消费它，也不以新结果回改原题/标签。
