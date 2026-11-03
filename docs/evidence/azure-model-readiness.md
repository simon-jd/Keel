# Azure 商业模型只读预查

日期：2026-10-23（America/Los_Angeles；UTC为2026-10-24）。这是开通前的能力预查，不是资源创建、部署或真实模型验收。

在已登录的Azure for Students订阅显式指定subscription执行以下只读命令，只输出配额/状态白名单字段，未打印凭据：

```text
az cognitiveservices usage list --location westus2 ...
response_type=list, items=0, matching_count=0

az cognitiveservices usage list --location eastus ...
items=0, sample=[]

az provider show --namespace Microsoft.CognitiveServices ...
provider=Microsoft.CognitiveServices, state=NotRegistered
```

两个区域当前没有返回可用的模型配额记录。由于provider尚未注册，这个结果**不能证明整个订阅无法开通模型**，也不能证明存在可用配额。没有注册provider、请求配额、创建资源组/模型服务、读取key或发出推理请求。未访问或改动 `rg-mlinfra-westus`。

后续Task8在收费路径绑定请求/token/重试上限后，仍需核对可部署模型、区域/套餐及订阅资格，再按Azure Retail Prices API的真实对应meter记录单价和最坏估算，满足累计≤9USD才可在 `rg-keel-lab` 内开通。本次没有费用预留，累计估算保持0USD。

## Retail Prices API真实查询

同日通过[Azure Retail Prices API](https://prices.azure.com/api/retail/prices)执行公开未认证查询，filter为 `productName eq 'Azure OpenAI' and armRegionName eq 'westus2' and priceType eq 'Consumption' and contains(skuName, 'gpt 4o mini')`，currencyCode为USD。实际返回7个meter且没有NextPageLink。其中两个非缓存、非Batch的Data Zone meter：

| SKU | meterId | retailPrice / unitOfMeasure | 换算每百万token |
|---|---|---|---|
| gpt 4o mini 0718 Inp Data Zone | 4fd10f9f-f69a-5e2b-ab38-af035a0238ed | 0.000165 USD / 1K | 0.165 USD |
| gpt 4o mini 0718 Outp Data Zone | e453a52c-e720-5bdc-b88f-86130561dd11 | 0.00066 USD / 1K | 0.66 USD |

两项effectiveStartDate均为2025-12-01。其余返回项为cached/Batch meter，不能混入本次标准未缓存报价。此处仅证明价格查询可用，**没有选定部署或做费用预留**；价格存在不证明模型在该订阅/区域/SKU可部署。真正准入须匹配最终套餐、再次取价并先写费用台账。

## 后续资格与目录复核（2026-10-24 05:58–05:59 UTC）

当前登录订阅只输出ID/名称/状态白名单字段，确认与本项目固定订阅一致，名称为Azure for Students，状态Enabled。官方[配额文档](https://learn.microsoft.com/en-us/azure/foundry/openai/quotas-limits)公开了新的订阅层级GET接口；实际只读请求结果如下：

```text
GET /subscriptions/<pinned-subscription>/providers/Microsoft.CognitiveServices/quotaTiers
    ?api-version=2025-10-01-preview
CLI exit=1, error.code=NotFound
message: Specified resource '<pinned-subscription>' cannot be found.
```

这不是订阅不存在的证据：随后`az account show`仍确认相同订阅Enabled。也没有由该错误推断已注册服务、配额为零或一定不能部署。

实际`az cognitiveservices model list --location westus2 --subscription <pinned-subscription>`成功返回130项。格式计数为Mistral AI 18、Cohere 24、DeepSeek 14、Meta 16、Microsoft 26、Black Forest Labs 8、OpenAI-OSS 4、MoonshotAI 6、xAI 14。精确查找`gpt-4o-mini`、`gpt-4.1-mini`、`gpt-5-mini`为空；检查所有`gpt`/`claude`前缀仅发现以下开源模型元数据：

| 名称 | 版本 | kind | 目录列出的SKU |
|---|---|---|---|
| gpt-oss-120b | 1 | AIServices | GlobalStandard、DeveloperTier |
| gpt-oss-20b | 11 | AIServices | 空 |
| gpt-oss-120b | 1 | MaaS | GlobalStandard、DeveloperTier |
| gpt-oss-20b | 11 | MaaS | 空 |

这些是目录元数据，不是实际可用配额、部署或推理结果；开源gpt-oss也不能当作已验收商用OpenAI模型行。查询没有涉及现有`rg-mlinfra-westus`。

同一时间读取Microsoft官方[合作方模型资格说明](https://learn.microsoft.com/azure/ai-foundry/foundry-models/concepts/models-from-partners)：Marketplace SaaS购买不支持Student订阅；Claude部分另外明确排除student/free-trial/startup-credit以及仅赞助额度的订阅。因此当前学生订阅不满足文档所列Claude购买资格，不能靠升级订阅或增加信用卡绕过用户授权范围。OpenAI配额文档列出了Tier0标准部署模型，但文中的Students为N/A表格属于Batch，**不能扩大解释为所有Standard模型均不可用**。商用模型是否能在其他区域/具体套餐开通仍需进一步实际核查。

本次仅做公开文档读取和控制平面GET；未注册Provider、升级订阅、请求配额、订阅Marketplace、创建资源、读key或调用推理。累计估算0USD、0预留。CLI普通沙箱因其日志目录只读而失败的帮助命令不计为Azure服务响应；提升权限后读取帮助及以上查询成功执行。

## Eastus SKU与目录补查（2026-10-24 06:18 UTC）

本机CLI公开帮助确认`account list-skus`可在不指定account/resource-group时按kind和location读取订阅SKU。实际分别执行`az cognitiveservices account list-skus --kind OpenAI --location <region> --subscription <pinned-subscription>`，结果：

| 区域 | 只读返回 |
|---|---|
| westus2 | 空列表 |
| eastus | kind=OpenAI、name=S0、locations=[EASTUS]、restrictions=[] |

随后eastus模型目录成功返回282项，其中OpenAI格式92项、Anthropic格式38项。以下候选都列出OpenAI与AIServices两种kind：

| 模型 | 版本 | 目录中的部分部署SKU |
|---|---|---|
| gpt-4o-mini | 2024-07-18 | Standard、GlobalStandard、DataZoneStandard（还含Batch/Provisioned类型） |
| gpt-4.1-mini | 2025-04-14 | Standard、GlobalStandard、DataZoneStandard、DeveloperTier（还含其他类型） |
| gpt-5-mini | 2025-08-07 | GlobalStandard、DataZoneStandard（还含Provisioned类型） |

这比westus2目录提供了更具体的候选，但仍不是已经获配额、通过政策检查或成功开通/推理的证明。Anthropic出现在通用目录也不覆盖前述学生订阅购买资格限制。没有选定任何SKU，更没有采用按容量收费的Provisioned部署。后续最小商用子集须先完成实际调用边界的固定模型/请求/token/retry限制、fresh Retail Prices报价及≤9USD台账/claim，再协调实际可开通性验证；不能仅因当前收费分发未实现就把条件行视为永久不适用。本次无资源或费用变化。
