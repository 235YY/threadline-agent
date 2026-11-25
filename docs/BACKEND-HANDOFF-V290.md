# Threadline Studio v2.9.0 后端交接

本候选在 Gemini 的 UI 发布包上收口。收到的 ZIP 与已有全绿基线相比，仅更改了 README 与桌面三份资产，并新增 5 项发布资料。运行源码随后在独立候选中修改。文件身份和 SHA-256 见 `SOURCE-MANIFEST.json`。

## 已接通与已验证

- **DSH 委派宿主路径**。`createDesktop({dshRunner})` 接受操作者已核验的执行器，要求 `workspaceRoot` 与当前居民书桌物理路径相同，并设置 `BRAIN_DSH_ALLOW_DESK=1`、保持书桌写权限。只有当前主人桌面输入的已采用动作才可委派。执行器只接收本条用户简报、目标目录、动作编号和取消信号。回执包含结论、耗时、真实文件相对路径及内容指纹。文件预览重新核对指纹，结果笔记只保留短结论和固定回执证据。失败和断开保留实际记录，UNKNOWN 不自动重投。模拟执行器测试覆盖授权、来源、回执、文件变更、断开与超时。
- **真实 DSH 上线仍缺隔离执行器**。原版 DSH 的 `workspace-write` 范围限制写入，读取和网络权限仍放开。Studio 自带启动器当前不提供 runner，不会自动调用本机 DSH。交接时需要提供一个经过验证的执行环境，可读取并修改自己的授权工作区，不能读取居民数据或宿主凭据。接口为 `run({requestId,workspaceRoot,brief,signal}) → {outcome:'succeeded',summary,files}`。安装、启动或付费调用真实 DSH 均未进行。[DSH 官方运行边界](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)
- **`:work` 非流式工具协议**。设置 `BRAIN_WORK_CHANNEL=1` 后，已联网的 Studio 使用 `<model>:work`，客户端提供主人凭据和 `Idempotency-Key`。保真调用方声明的 `tools`、`tool_choice`、历史 `tool_call_id` 与提供商 `finish_reason`，工具只能由调用方执行。工作通道与现有模型共用居民 RequestJournal、准入和串行保护。模拟上游端到端覆盖工具链、禁止外泄推理字段、结算后重放与 UNKNOWN 跨重启保持。当前产品范围是纯文本和客户端函数工具，非流式 JSON，固定关闭上游思考。请求拒绝服务端工具、严格 schema 等未实现能力。
- **热冷原型**。移到 `experiments/hot-cold-mind.mjs`，原型测试仍在默认回归内。临时队列的内存版本号不具备持久因果保证，暂不采用。后续异步写入优先复用现有 SQLite 写入，使用事务内固定版本及来源验证，同时保留现有记忆机会和回执。
- **报表**。两个只读脚本都支持 `--markdown`。预算费用按账本用量估算，可信官方数据单列。旧账本没有排版或反思模式标签时显示未分组。新反思分为实际完整交付和实际增量交付。`bench-api-channels` 的 API 时延与上游账本时延分开展示。

## 验证

- Windows、Node 26.12.1、已核验 Python 3.13.9。默认回归 132 个测试文件、1,304 / 1,304 通过。Python 运行材料是隔离测试依赖，不随源码附送。
- Node 22.22.0 和 24.13.0 的官方便携运行时通过 SHA-256 核验，均加载 `node:sqlite`，默认测试入口以 `NODE_VERSION` 退出。README 与 doctor 维持 Node 26.8.0 的最低稳定版本要求。
- 真 Windows `Start-Threadline.cmd` 启动，独立无窗口 Edge 会话验证首屏、三套皮肤、思考条显隐与展开、工作区侧栏开合，浏览器错误为 0。离线 DSH 模拟验证了交付预览的后端指纹检查。
- 真 DSH、真模型对照与 Windows 安装器产物仍待单独验证。未部署、未发布。

