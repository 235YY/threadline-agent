# Threadline Agent

A continuity-first runtime for persistent AI agents.

Threadline 将版本化记忆、主体认识、注意力、Intent、Decision、AgentTask、工具执行与真实回执接在同一个持续运行循环中。模型负责理解、判断和选择；宿主负责来源、版本、事务、权限、预算与执行事实。

这是不带原主体记忆的**空白框架**。当前统一候选沿已登记来源合入Wire、任务历史、预算接线和单请求隔离修复；QQ工具目录恢复到63项。注册不等于授权或外部环境已接通。仓库不附个人资料、真实聊天、记忆数据库、密钥、生产授权或运行账本；已有合成协议夹具仅用于测试。

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

完整回归包含情感引擎测试，需要Python >=3.10（建议3.13）。当前Worker默认寻找项目内隔离Python路径；干净克隆请用JY_AFFECT_PYTHON显式指定已安装解释器。引擎源码已按固定MIT版本附带，不需要Limbic模型服务或独立数据库。

公共默认测试使用合成数据和临时数据库，不调用真实模型或QQ，不需要私人历史档案。原始回放保留为独立本地入口npm run test:private-history，必须显式提供JY_PRIVATE_REPLAY_ROOT；它不在公共默认测试中。不能将合成测试称为原始历史复现。详见[验证说明](docs/VALIDATION.md)。

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

标准入口始终为run.mjs → launchBrain。启用真实模型需要单独授权、显式BRAIN_LIVE=1和JY_LIVE_CONFIRM=YES、RequestJournal路径及有效官方消费上报。标准live仅依据专用Key的官方已显示当日消费控制每日5元门槛；数据失效时不发新请求，UNKNOWN只隔离原来源。官方账单延迟已纳入边界，这不是瞬时精确扣费硬上限。

当前标准凭据实现仅通过Windows DPAPI helper读取专用密文，不从环境变量加载API Key。需要时由运营方使用scripts/study-key.ps1的本地密码界面配置；不要运行ReadForWorker开关来显示密钥，不要将密钥写入源码、Issue或Git。分发包没有生产密钥、账本或授权，也不自动批准付费调用。完整条件见[配置说明](docs/CONFIGURATION.md)。

tools/ops/start.ps1保留为Legacy兼容脚本，仍有旧预算审计逻辑，**不是本版本标准生产启动入口**。不要用它代替上述Node入口或据此重置历史账本。

QQ适配还需独立安装和配置OneBot/SnowLuma、QQ_UIN、QQ_OWNER、SNOWLUMA_HOME及可用的QQ_SDK_MODULE。这份代码不附QQ登录会话。Office、网页搜索、语音、Minecraft、桌面等外部运行时也不随包附带；缺依赖时必须明确不可用，不能把注册当作真实接通。参见[可选集成](docs/INTEGRATIONS.md)。

现有实验开关默认关闭，实际语义见[配置说明](docs/CONFIGURATION.md)。所有功能仍在同一个主体和同一个版本化数据库中；不会复制原主体的个人记忆。

## 阅读

- [架构与职责](docs/ARCHITECTURE.md)
- [配置与运行边界](docs/CONFIGURATION.md)
- [隐私与分发范围](docs/PRIVACY.md)
- [验证与已知限制](docs/VALIDATION.md)

## License

沿用本仓库MIT许可。固定版本Limbic及其原许可位于tools/affect-shadow/vendor/；第三方来源见[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
