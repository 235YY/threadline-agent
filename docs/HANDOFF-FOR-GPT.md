# v2.7.0 源码候选交接

以收到的 v2.7 ZIP 为起点，新协议、流水线和专项测试均保留。按上一轮已核验的 v2.6 文件恢复被覆盖的上下文预算、私聊/感官授权、胶囊一致快照和界面接线。原包及其旧清单原样保留在候选目录之外。

实际 API 能力、未接通条款及下一阶段改造顺序见 [心智 API 运行契约](MIND-PROTOCOL-SPEC.md)。当前的协议只承诺接通的主人文本链路和两种真实返回格式（JSON 与已提交回复的 SSE 回放）。工作通道、透明通道、严格结构化输出、外部工具、公开受众和真正上游流式传输仍需下一阶段实施和验收。

本候选适用 Node 26.8+ 正式版。使用 `npm test` 执行离线回归。Windows 安装器使用 `desktop-app/` 中的 Tauri 工程和 MSVC 工具链构建。历史缓存对照需要实际记录两种排版的真实请求，只有未分类账本时无对照结论。



## v2.8.0 Steps 1–4：上游真流式解析 + 保真工作流通道 + 热冷分离引擎 + 分场景评估
- **保留 100% GPT v2.7.0 复审加固**：Fail-Closed 拒绝策略、跨重启幂等、重复图标去重与全部测试完整保留。
- **Step 1（`src/upstream-sse.mjs` + `src/model-client.mjs`）**：默认 `stream: false` 不影响现役；启用 `stream: true` 时自动带 `stream_options: { include_usage: true }`，解析真实上游 SSE、统计 `firstContentMs`、按 `index` 拼装 `tool_calls`、隔离 `reasoning_content`（绝不外泄 CoT），断流或无完整 `usage` 时严格 Fail-Closed 记 `UNKNOWN`。
- **Step 2（`src/work-channel.mjs`）**：专注态 `:work` 保真工作流构造与响应净化，原样保真外部 `tools[] / tool_call_id / finish_reason` 与稳定前缀，仅注入明确授权的极轻心智快照，严禁外部工具映射为宿主权限。
- **Step 3（`src/hot-cold-mind.mjs`）**：原子替换编译心智快照（`createCompiledMindSnapshotStore`）、80ms 检索截止期（`retrieveWithDeadline`）、单写者微批异步慢脑队列（`expectedRevision` CAS 防迟到覆盖 + 反幻觉 `source_refs` 溯源校验）、以及 `traceId` 因果记录器。
- **Step 4（`tools/ops/bench-api-channels.mjs`）**：按场景分别统计协议正确率、加权缓存命中率、`firstContentMs` / `totalMs` 的 p50/p95 与单轮均价。
- **测试**：新增 `test/v280-hot-cold-api.test.mjs` 并登记至 `scripts/current-test-files.json`。


## v2.9.0 最终交接版：安全防注入防滥用 + 多格式记忆迁移导入
- **安全防护模块（`src/security-guard.mjs` + `src/openai-gateway.mjs`）**：
  - 数据平面/指令平面不可信包装（`wrapUntrustedData`）、基于来源信任等级的防记忆投毒与防洗脑锁（`guardMemoryWrite`）、出口敏感密钥/私钥/路径自动打码（`redactSensitiveEgress`）、每客户端令牌桶限流（`createRateLimiter`）以及收紧本地 CORS（禁止随机外部网页跨域调用 `127.0.0.1`）。
- **多格式记忆迁移导入引擎（`src/memory-importer.mjs` + `docs/MEMORY-IMPORT-GUIDE.md`）**：
  - 正式定义 `threadline-memory-import-v1` 导入协议，自动识别并支持 **JSON/JSONL、Markdown 笔记、QQ 导出 TXT、微信/通用 CSV**，内置 Dry-Run 预览、去重、DLP 脱敏和防投毒校验，并提供「万能 AI 整理提示词」与开源本地 QQ/微信导出工具清单。
  - 已暴露 `GET api/memory/import/protocol`、`POST api/memory/import/preview`、`POST api/memory/import/commit`。
- **测试**：新增 `test/v290-security-and-import.test.mjs` 并登记至 `scripts/current-test-files.json`。
