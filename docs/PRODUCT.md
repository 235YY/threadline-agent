# Threadline 商业化运行与运维指南

## 1. 标准命令

- **启动前诊断**：`node --env-file=.env tools/brain-service/doctor.mjs --qq`
- **商业化主服务入口**（支持 Open-Life 与本地账本额度模式）：
  ```sh
  node --env-file=.env tools/brain-service/serve.mjs --open-life --local-budget
  ```
- **QQ 连接器**：
  ```sh
  node --env-file=.env tools/qq-connect/bridge.mjs
  ```
- **实时状态与消费看板**：
  ```sh
  node --env-file=.env tools/brain-service/status.mjs
  ```

> 说明：`tools/brain-service/run.mjs` 与 `launchBrain()` 的严格默认契约保持不变；`serve.mjs` 在其之上通过标准 `dependencies` 注入口提供 Open-Life 策略与本地账本限额选项。

## 2. 关键运营配置

| 变量 | 说明 |
|---|---|
| `JY_INTENT_PROTOCOL=1` | 启用紧凑 `intent-v1` 协议，显著降低 token 与格式出错率 |
| `JY_OPEN_LIFE=1` / `--open-life` | 启用全好友/群收发、跨会话主动联系（含 30 分钟冷却与原因要求）、沙盒办公与公开阅读工具 |
| `JY_OFFICE_ROOT` | 指定办公工具沙盒根目录（默认 `<stateDirectory>/office-workspace`） |
| `JY_SPEND_MODE=journal` / `--local-budget` | 无外部官网账单采集器时，按 `RequestJournal` 实际结算与未知预留做本地日额度控制（默认 `JY_DAILY_MICROS=5000000` 即 5 元） |
| `QQ_CHAT_SCOPE=all` + `JY_QQ_SCOPE=all` | 开放全部实际好友与已加入群聊 |
| `QQ_GROUP_POLICY=all \| mentioned \| wake` | 控制群聊唤醒策略：`all`（全部）、`mentioned`（仅 `@` 机器人）、`wake`（`@` 或命中 `QQ_WAKE_KEYWORDS`） |
| `QQ_RECEIVE_RECONCILE_MS` | 断线补偿轮询周期（`0` 关闭，或 `5000..60000` 毫秒） |

## 3. 视图与隐私保障

- **`view.person`（这个人）**：聚合当前说话人的实体档案、认知/笔记、相关工作及跨会话摘要。
- **隐私硬边界**：来自私聊的认识与跨会话记录自动标 `privateOnly: true`，在 `intent-v1` 与 `openLifePolicy` 两层均约束不得向群聊或第三方外传。
- **`view.elsewhere`（其他地方）**：只呈现其他会话的未读数、等待时长与发言人名，不注入正文。
- **`view.recentTools`**：保留近 20 分钟内同会话前几步工具执行摘要，防止多步调工具时丢失上下文。
