# 配置

配置入口是tools/brain-service/runtime-config.mjs；Node >=26.8.0。所有路径均可在新目录配置，不依赖原开发者用户目录。config/identity.example.txt是中性示例，不是原主体角色卡。

默认BRAIN_LIVE=0、JY_AFFECT=0、JY_AFFECT_FUSION=0，认知实验开关未设置时为false。BRAIN_GLOBAL只决定同一主体的队列协作，不授予跨会话信息分享或外发权限。

可选开关：JY_ALGORITHM_V011、JY_APPERCEPTION_V1、JY_SUBJECTIVE_DOMAINS、JY_SUBJECTIVE_MEMORY_V2、JY_TASK_THREADS、JY_ANCHOR_DIRECTORY、JY_MEMORY_SCOPE_V1、JY_INVESTIGATION_CONTINUITY_V1、JY_EXPERIENCE_LEARNING_V1。只能填0或1；两代主观记忆不可同时开启。JY_AFFECT_FUSION=1需要JY_AFFECT=1，且会启用统觉接线。

JY_AFFECT_PYTHON用于指定Python；没有必要复制Python安装目录进仓库。Worker校验固定上游源文件清单，拒绝无效输入、超时和超限输出。

真实模型还要求显式BRAIN_LEDGER、BRAIN_MAX_CALLS、BRAIN_MAX_MICROS，及JY_LIVE_CONFIRM=YES。费用不明与外部结果不明必须保留预留/事实，不自动重发。公开包不携带任何生产授权。

QQ、Office、GitHub、语音和游戏服务依赖分别配置。工具注册、当前入口可见、实际授权和依赖可用性分开；不要从工具对象的全部键自动授予权限。使用自己的最小白名单。
