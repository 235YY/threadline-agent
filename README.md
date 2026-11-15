# Threadline Agent

A continuity-first runtime for persistent AI agents.

Threadline 将版本化记忆、主体认识、注意力、Intent、Decision、AgentTask、工具执行与真实回执接在同一个持续运行循环中。模型负责理解、判断和选择；宿主负责来源、版本、事务、权限、预算与执行事实。

这是从已运行 V14 基线整理出的**空白框架**，不是原主体的克隆。仓库不包含个人资料、角色经历、聊天记录、记忆数据库、密钥、模型响应、生产授权或运行账本。V15 全环境开放尚未实现于本次导出。

## 快速启动：默认离线

要求 Node.js >=26.8.0；本次验证使用26.12.1。默认核心不需要安装第三方npm包。

```sh
node tools/brain-service/run.mjs
```

默认是dry-run，不调用付费模型，不连接QQ，不执行外部工具。首次运行只在当前目录的_local/dry-run创建新的空SQLite和状态；Ctrl+C正常关闭。默认端口8787；如果已经被占用，复制.env.example为.env，设置其他BRAIN_PORT，然后运行：

```sh
node --env-file=.env tools/brain-service/run.mjs
```

Node不自动加载.env。环境文件与运行数据均被.gitignore排除。不要在生产主体的数据目录里运行样例或测试。

## 回归与样例

```sh
npm test
npm run demo
```

完整回归包含情感引擎测试，需要Python >=3.10（建议3.13）。默认Windows使用python，其他平台使用python3；也可通过JY_AFFECT_PYTHON指定解释器绝对路径。引擎源代码已按固定MIT版本附带，不需要Limbic模型服务或独立数据库。

测试使用合成数据和临时数据库，不调用真实模型或QQ。原始私有真实实验的数据库/请求不公开；对应历史回放被替换为不含真实资料的合成反例，不能将公开测试称为原始真实实验复现。详见[验证说明](docs/VALIDATION.md)。

## 主要目录

|目录|内容|
|---|---|
|src/|记忆、认识、来源版本、注意力、认知、Intent、任务、检索、预算与反馈|
|prompts/|通用认知协议；不含原主体人格和聊天材料|
|tools/brain-service/|标准launchBrain入口、串行宿主、状态交接与服务接口|
|tools/qq-connect/|OneBot接收、会话寻址、工具与真实回执适配|
|tools/affect-integrated/|情感与统觉接线|
|tools/affect-shadow/|无数据库、无网络的Python确定性Worker和固定上游核心|
|tools/native-capabilities/|可选环境适配入口；依赖需另行配置|
|test/、experiments/|合成回归及其参考实现依赖；不含私有实验结果|
|config/|中性身份与空表情目录示例|

## 接入真实模型和环境

这不是自动接管本机QQ或电脑的安装包。启用真实模型需要显式BRAIN_LIVE=1、JY_LIVE_CONFIRM=YES、模型密钥、预算上限和通过的预算审计；空目录不冒充已批准的真实费用授权。

可使用DEEPSEEK_API_KEY环境变量，或自行创建Windows本地DPAPI密钥存储。不要把密钥写入源码、Issue或Git。分发包没有可复用的生产密钥/账本/授权，也不自动批准任何付费请求。默认费率是基线中的冻结配置，使用真实API前须核验所选模型及最新价格。

QQ适配还需独立安装和配置OneBot/SnowLuma、QQ_UIN、QQ_OWNER、SNOWLUMA_HOME及可用的QQ_SDK_MODULE。这份代码不附QQ登录会话。Office、网页搜索、语音、Minecraft、桌面等外部运行时也不随包附带；缺依赖时必须明确不可用，不能把注册当作真实接通。参见[可选集成](docs/INTEGRATIONS.md)。

现有实验开关默认关闭，实际语义见[配置说明](docs/CONFIGURATION.md)。所有功能仍在同一个主体和同一个版本化数据库中；不会复制原主体的个人记忆。

## 阅读

- [架构与职责](docs/ARCHITECTURE.md)
- [配置与运行边界](docs/CONFIGURATION.md)
- [隐私与分发范围](docs/PRIVACY.md)
- [验证与已知限制](docs/VALIDATION.md)

## License

沿用本仓库MIT许可。固定版本Limbic及其原许可位于tools/affect-shadow/vendor/；第三方来源见[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
