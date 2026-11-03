# 完整 Langfuse 后台磁盘预查

2026-10-25 的真实公开 registry 读取，尚未安装镜像、启动后台或验证 ingestion。四个 linux/amd64 manifest 原始字节 SHA256 与已保存 digest 一致；随后对42个不同压缩层实际流式读取、解压和计数，逐层校验压缩 SHA256、完整长度及官方配置中的未压缩 `rootfs.diff_ids`。未提取或保存层文件。

| 镜像 | 固定 amd64 manifest | 压缩层字节（各镜像内求和） | 展开 tar 流字节 |
|---|---|---:|---:|
| minio | `a893442cd57d795411ace0b9a78f26a65e3f6e546d3f25c24e19f8446b0d9718` | 63,992,795 | 170,064,384 |
| clickhouse | `8ecb92fa564142a2bad5fef7b39f89af7265ddbfd782693b15f002ca0f70be14` | 246,670,791 | 871,671,296 |
| langfuse web | `394c425afbd0d4305cc1fb167ff4a2984cb80c7e80fd2f5adb777e29c1d097a8` | 301,565,655 | 1,137,262,080 |
| langfuse worker | `c33c904e254633a0b5e3cc6214b6c9ed9d6eeae6fcfb6d45b003e1d78e27f48e` | 368,250,851 | 1,360,714,752 |

去重压缩层971,330,631B；去重展开流3,511,929,856B。实际网络读取971,396,179B（含配置及匿名公开registry鉴权元数据），55.847秒，进程峰值RSS27,557,888B；有限controller以512MiB地址空间、120秒CPU、300秒墙钟限制运行并退出0。真实journal/result及原始manifest保存在本计划私有证据目录，脚本SHA256为`865dca86d038ab5bee9679ddb0934fe134c8e05e5c30fbc73ab6c7a6db18eb60`。没有使用本机registry凭证。

第二次有限读取仅解析tar元数据，没有提取文件：44.994秒、实际网络971,348,956B、RSS92,897,280B、退出0，所有42层压缩与展开哈希再次一致。将每个普通文件/符号链接及每层目录按4KiB取整，另预留每个entry512B，得到去重层估算3,824,621,568B；各镜像不去重分别为minio172,610,560B、clickhouse890,950,656B、web1,225,213,952B、worker1,569,213,952B。这是由真实tar元数据计算的估算，仍不等于Docker实测分配。第二次读取是为了补齐文件块/目录开销，未重复性能测量。

宿主只读检查显示`overlayfs`及`io.containerd.snapshotter.v1`。此存储保留压缩层和展开层，后续预算必须同时考虑；见[Docker官方存储说明](https://docs.docker.com/engine/storage/containerd/#disk-space-usage)。展开tar长度仍不等于文件系统实际分配，尚需计入文件块、目录、导入峰值、运行临时数据及本项目全部既有占用。

当前约7.922GB已接近8GB上限，**没有准入直接pull/build/load**。本项目可重建vLLM环境与共享HF模型均保留；已有未带项目标签镜像不删除，不运行全局prune。后续如分阶段置换自有环境，须先保存重建锁及归属、核对真实分配与完整峰值，并保证新镜像从创建时带本项目标签以便仅清理自有镜像。现有流式结果仅解决体积的一部分，不能据此宣称Task4/15或完整后台验收完成。
