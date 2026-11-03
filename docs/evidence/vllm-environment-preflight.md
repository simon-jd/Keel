# vLLM默认依赖体积预查

时间：2026-10-24 UTC／2026-10-23 PDT。仅解析公开包元数据和读取wheel目录；**没有安装环境、启动GPU、下载模型或调用模型API**。本次预查用于落实项目8GB份额，不代表目标版本已经兼容或真实推理验收通过。

实际命令：

```bash
/home/postedism/.local/bin/uv pip install --dry-run --only-binary=:all: --no-cache \
  --python /home/postedism/.local/bin/python3.12 \
  --target .tools/vllm-preflight vllm==0.32.0
```

uv解析198个包，打印“Would download/install”，目标目录只有一个0字节`.lock`，没有安装包。实际解释器Python3.12.13。随后通过PyPI每个确切版本的JSON与官方`files.pythonhosted.org`读取wheel尾部/ZIP中央目录；只接受有界HTTP Range，不读取大包中的程序/库文件内容。唯一23,635字节的小wheel因`py37-none-any`兼容标签补查而完整读取。包含下述平台更正的旧目录在内，合计读取约6.26MB的wheel目录/小包字节，另有PyPI JSON元数据；没有把完整大包下载到磁盘。

结果为198个候选wheel，默认解算包含vLLM0.32.0、Torch2.13.0、Triton3.7.1及CUDA13系列包。按Linux x86_64/Python3.12兼容标签选择每个包压缩体积较小的候选；这不是最终安装锁文件。版本与原始依赖要求见[PyPI vLLM元数据](https://pypi.org/pypi/vllm/0.32.0/json)、[Torch元数据](https://pypi.org/pypi/torch/2.13.0/json)。逐包URL、预期SHA256、文件名与目录统计保存于[预查数据](vllm-environment-preflight.json)。SHA256取自PyPI元数据，未对未下载的大包执行完整内容哈希验证。

| 目录统计 | 字节 |
|---|---:|
| 压缩wheel合计 | 3,932,659,996 |
| 归档成员解包内容合计 | 8,229,963,474 |
| 各归档文件按4KiB上取整合计 | 8,359,944,192 |

预查更正：第一版仅按x86_64筛选，误纳入24个macOS wheel；该版8.10GB求和已撤销。现已替换成Linux候选，并检查全部198项为兼容Linux或通用标签。旧数据留在本机忽略工作区并标为invalidated，不用于准入或安装；正式JSON仅含更正后的候选及更正说明。

以上是归档求和，尚未对跨包同名路径去重，也没有计入pyc、JIT缓存、临时压缩件、安装元数据改写或运行数据；**不是实测安装占用**。此前Keel与相关本地镜像快照约2.60GB，因此保守预算不能直接批准默认全量安装。机器空闲增加不改变本项目8GB份额，不能把Python环境移到共享HF缓存或`/tmp`规避计量。

Task8应继续选择并验证可用的精简/分阶段方案，或核对与系统CUDA的兼容复用，再按实际峰值准入；不能只因默认方案估算过大就把整个本地模型验收记为blocked。原有系统CUDA13.2路径存在不等于Torch/vLLM ABI已验证。最终需要锁定实际版本、安装路径和依赖，检查运行占用，通过共享GPU锁启动真实vLLM，并在批次结束停服。共享HF例外仅用于模型缓存，软件依赖仍计本项目份额。
