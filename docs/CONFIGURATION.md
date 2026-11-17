# 配置与标准启动

唯一标准入口是tools/brain-service/run.mjs → launchBrain；由runtime-config.mjs解析配置。
要求Node >=26.8.0（26.12.1与26.13.1上验证过）。Node不自动加载.env：

~~~sh
node tools/brain-service/run.mjs
node --env-file=.env tools/brain-service/run.mjs
~~~

默认dry-run不构造付费模型或QQ发送器，心跳为0，数据落在自己的_local/dry-run。
默认端口8787；在已有实例的主机上先显式选择空闲测试端口，禁止借样例接管生产。
相对路径以项目root解析。config/identity.example.txt只是中性示例。

## 启动前诊断（只读）

~~~sh
node tools/brain-service/doctor.mjs
node --env-file=.env tools/brain-service/doctor.mjs --qq --json
~~~

按与标准入口相同的配置解析，逐项列出Node、身份、数据库、实例锁、RequestJournal、
官方消费令牌、模型凭据（非Windows明确报告不可用）、情感Python、端口及QQ桥依赖。
它不创建、不删除、不解锁、不读取密钥内容；缺失的数据库会被明确标为"将新建空主体"，
不会被当作已有主体。诊断的阻断规则与启动检查一致；有阻断项时退出码为1。

## 已授权live的必要条件

以下是代码契约，不构成运行或费用授权：

| 项目 | 实际要求 |
|---|---|
| BRAIN_LIVE / JY_LIVE_CONFIRM | 1 / YES，都必须明确设置 |
| JY_NEW_SUBJECT | BRAIN_STORE 不存在时必须为 1，否则拒绝启动（NEW_SUBJECT_UNCONFIRMED）；防止路径写错时静默新建空主体 |
| JY_NEW_REQUEST_JOURNAL | BRAIN_LEDGER 不存在时必须为 1（NEW_JOURNAL_UNCONFIRMED）；仅首次空白部署使用 |
| QQ_TEST_ONLY_OWNER 或 JY_QQ_SCOPE=all | 二选一，否则拒绝启动（QQ_SCOPE_UNCONFIRMED）；不再默认开放全部好友与群 |
| BRAIN_STORE、BRAIN_STATE | 自己的数据库和状态目录；禁止样例指向生产 |
| BRAIN_IDENTITY_FILE | 存在、非空且不超过4000字符的获准身份文件 |
| BRAIN_LEDGER | RequestJournal路径，已有文件须为jingyang-request-journal-v1 |
| JY_OFFICIAL_USAGE_TOKEN | 默认官方上报接收器所需的至少32字符私密令牌；不是API Key |
| 模型凭据 | 下述Windows DPAPI helper，没有API Key环境变量回退 |

bootstrap允许宿主明确注入现有officialSpend监控器；run.mjs使用默认实现。
默认消费快照位于BRAIN_STATE/official-usage.json。仓库不附已登录账单页或生产采集身份；
运营方必须另行核验现有只读采集器与POST /v1/official-usage的上报链，
通过x-usage-token认证，不导出浏览器Cookie或API Key。
令牌缺失/过短会拒绝live启动；没有有效报告时可保持服务启动但暂停新增模型调用。

## 官方消费、5元与请求事实

报告必须是今天、Asia/Shanghai、CNY、专用Key标签“新版鲸漾系统”，包含完整消费与请求数。
报告自capturedAt起最多有效90秒。官方已显示当日消费低于5元允许新请求，
达到5元或数据失效则停止新调用。官方页面可能延迟5分钟；
这不是瞬时精确硬上限，实际已发生扣费可能在页面延迟期间继续体现。

标准live只有这一套消费准入。BRAIN_MAX_CALLS/BRAIN_MAX_MICROS仍可解析供兼容调用，
但不构成标准live的第二次数/金额门。单任务资源边界和一次格式恢复限制仍保留。
结算、回执、原请求可靠核验与审计不因消费暂停而抹除，不自动触发新请求。

RequestJournal保存身份、来源、调用结果、输出和结算事实，不建设第二套费用系统。
UNKNOWN不形成新全局财务halt，不清除费用或历史预留；
同一来源不得靠换ID、now或重启重发。确定未发送也须明确重新准入原请求。
已经收到但不合法的输出不采用、不执行其中工具。

DailyBudgetLedger保留给明确的历史兼容入口；旧格式不能直接作为RequestJournal打开。
首次空白框架可使用自己的新Journal；已有运行资料必须先核验原路径、格式与来源链，
不得换空路径绕过历史UNKNOWN。不会自动转换、覆盖、删除或迁移旧账本。
异常退出遗留实例/Journal锁需要按既有规则受控核验，禁止自动删锁或仅凭PID接管。

## 实际凭据实现

src/model-credential.mjs只调用scripts/study-key.ps1，
读取_local/study-secrets/deepseek-study.dpapi，不使用DEEPSEEK_API_KEY。
需要配置时由运营方在Windows当前用户下运行helper密码界面；
密文受该用户DPAPI与文件ACL保护，不能复制给另一个用户后假定仍可解密。
ReadForWorker只供Node子进程捕获，禁止在可见终端执行并显示密钥。
其他操作系统的凭据接线尚未由此默认helper提供，不虚构环境变量支持。

## 工具、依赖和功能开关

注册63项不等于授予63项权限。普通认知、反思和任务仍使用各自显式白名单，
执行时保留权限、版本、来源、目标及未知结果保护。禁止Object.keys自动授权。
新增12项已有工具需要JY_OPEN_LIFE=1及宿主configureLifeTools提供已审策略和适配器；
只改环境变量不等于依赖已配置。未就绪返回LIFE_NOT_READY，不能报告假成功。
B站/GitHub公开阅读受真实平台可达性限制；HTTP失败或截断明确反馈，
不使用私人仓库凭据，不执行仓库代码。基本CLI不会替运营方创建Open Life生产策略。

JY_INTENT_PROTOCOL=1：普通事件决策改用 intent-v1（模型表达意图、宿主编译事务），见 docs/INTENT-PROTOCOL.md。

认知实验开关未设置时为false：JY_ALGORITHM_V011、JY_APPERCEPTION_V1、
JY_SUBJECTIVE_DOMAINS、JY_SUBJECTIVE_MEMORY_V2、JY_TASK_THREADS、
JY_ANCHOR_DIRECTORY、JY_MEMORY_SCOPE_V1、JY_INVESTIGATION_CONTINUITY_V1、
JY_EXPERIENCE_LEARNING_V1。两代主观记忆不可同时开启。
JY_AFFECT_FUSION=1需要JY_AFFECT=1，并启用相应统觉接线。
用JY_AFFECT_PYTHON指定已安装的Python解释器；干净克隆不附可执行文件。
Worker按固定源码散列验证上游，不调用模型或数据库。

## Legacy启动器

tools/ops/start.ps1保留为LEGACY，不作为新版本标准生产启动入口。
其旧budget-audit、UNKNOWN全局拒绝及旧费用参数要求没有在本轮改写。
必须使用上面的标准Node入口；旧脚本接线调整需要独立核验。
