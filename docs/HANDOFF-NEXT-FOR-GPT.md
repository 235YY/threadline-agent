# Handoff to GPT · v2.9.0 UI 重构与发布门面完成 → 后端收口交接单

基线来源：`Threadline-Agent-v2.9.0-API-Gemini-Handoff.zip`（1,302 / 1,302 全绿）。

## 本轮 Gemini 已完成并合入本包的内容（零改动 `src/` 与 `test/`）

1. **桌面本体 UI 深度重构（`scripts/desktop-ui/index.html`、`style.css`、`app.js`）**：
   - 保留原有全部 377 个 DOM `id`（新增 14 个，共 391 个，0 丢失），`app.js` 已通过 `node --check`，HTML/CSS/JS 全量 **0 个彩色 Emoji**（全套统一单色线性 SVG 图标）。
   - 落地 ChatGPT 桌面端双层导航：`54px` 单色 Icon Rail + `238px` 父子可折叠情境目录树 + 纯白圆角主画布。
   - 设置页与生态页全面升级为渐进披露手风琴卡片（`.tl-acc-card`），告别平铺长墙。
   - 升级 `#thinkingBar` 为 Shimmer 流光呼吸思考条 + 可点击展开的 3 步进度指示。
   - 新增右侧办公工作区与交付物分屏侧栏（`#workspaceDrawer`，快捷键 `Ctrl+Shift+W`），自动为 Agent 回复的长文档/代码与书桌文件生成可点击的交付芯片，支持多标签预览、文件树、一键复制与导出。
2. **开源发布门面与宣传资源（全部归位至仓库标准路径）**：
   - `README.md`（升级为图文版，含真实 6 天生产账本基准、`v2.9.0` 开关速查与仓库导览）
   - `docs/assets/hero-banner.jpg`、`docs/assets/telemetry-baseline.png`
   - `docs/index.html`（零外部依赖交互式 GitHub Pages 展示页）
   - `docs/RELEASE-LAUNCH-KIT.md`（GitHub Release Notes / 小红书 / B 站分镜 / 知乎 / X 发布文案）

---

## 请 GPT 接力完成的 5 项后端与工程收口（按优先级排序）

### 优先级 1：用户一次性授权 DSH 权限 → 居民遇重型任务幕后静默委派 DSH（核心产品体验）
- **产品原则**：用户面对的永远只有“她”，**不要**要求用户手动点“派单给 DSH”按钮。用户只需一次性授权 DSH 执行权限，之后在正常对话中遇到重型工程/文件/长链路任务时，由居民主认知在幕后静默委派给 DSH 执行，拿回结果后自然回复用户，并把产出文件直接递进当前工作区/书桌（右侧 `#workspaceDrawer` 会自动承接展示）。
- **必须守住的不变量**：
  - **显式授权、默认关闭（Fail-Closed）**：未获得主人明确授权（及目标工作区路径白名单）前，绝不发起任何 DSH 委派，绝不静默越权。
  - **最小上下文与隐私隔离**：委派给 DSH 的任务简报只包含当前任务必需的项目背景与约束，**绝不外泄**居民私有日常记忆、感官信息或 API Key。
  - **事务与成果回流**：委派任务的状态、耗时与最终交付物路径记入当前居民账本；完成后仅将精炼结论与文件 `source_refs` 写入记忆（不把大体积代码/日志塞进 SQLite），断连或超时标记 `UNKNOWN` 且不重复盲目重发。
- **验收**：补齐单元测试与模拟 DSH 桥接集成测试（覆盖未授权拒绝、隐私剥离、成功回流交付物、超时/断连 `UNKNOWN`）。

### 优先级 2：端到端接线 `src/work-channel.mjs`（受控开放 `:work`）
- 在默认关闭的显式开关（如 `BRAIN_WORK_CHANNEL=1`）下接入 `src/openai-gateway.mjs`。
- 严格保真外部调用方的 `tools`、`tool_choice`、`tool_call_id`、`finish_reason`，禁止外部 `:work` 请求触发宿主本地 MCP/Shell 工具越权，复用同一居民 Journal、预算与幂等键。

### 优先级 3：评估并收口 `src/hot-cold-mind.mjs`
- 目前 `src/hot-cold-mind.mjs` 未被主链路引用。请评估将其在默认关闭的实验开关下接入热通道快照与单写者异步队列（严守 `expectedRevision` CAS 与 `source_refs` 校验），或明确裁剪/整合策略，避免仓库长期保留零引用死代码。

### 优先级 4：统一 Node 版本兼容声明
- 核实 `package.json` 的 `"engines": { "node": ">=26.8.0" }` 与 `src/sqlite-compat.mjs` 在 Node 22/24/26 下的实际全量测试边界，并在 `README.md` 与 `doctor.mjs` 中保持一致说明。

### 优先级 5：账本对照脚本一键输出 Markdown 表
- 为 `tools/ops/compare-wire-layout.mjs` / `bench-api-channels.mjs` 增加 `--markdown` 汇总输出，便于用户跑完多日真实账本后，直接把 `legacy` vs `staged-v1`、全量 vs `BRAIN_COMPACT_REFLECTION=1`、完整心智 vs `:fast-chat` 的实测数据贴进 `README.md`。

## 回归要求
- 请在 Windows / 隔离测试环境下运行全套 `npm test`，确认既有 1,302 项测试与新增 UI / 委派测试全部通过，并核验 `scripts/desktop-ui/` 在实际启动 `Start-Threadline.cmd` 时的加载、切换皮肤、思考条与工作区侧栏无任何控制台报错。