# Threadline Studio v2.9.0 · 全平台开源发布宣传套件

> 当前候选的离线回归为 1,304 项。历史图表覆盖 6 个 UTC 日期，首尾是部分日，382 笔账本的 ¥8.06 为用量估算。图中 Legacy 是历史基线标签。发布前请沿用这个费用口径。

---

## 一、GitHub Release Notes（v2.9.0 · 中英双语）

### 标题
`Threadline Studio v2.9.0 — Continuity-First Living Brain, Incremental Reflection & Fast-Chat Channel`

### 正文
**Threadline Studio v2.9.0** is an open-source, zero-dependency personal AI brain & multi-resident desktop studio built on native `node:sqlite` and Tauri v2.

#### Highlights / 本版核心更新
- **Incremental Memory Reflection (`BRAIN_COMPACT_REFLECTION=1`, opt-in)**: Narrows routine dialogue history using the committed watermark of the previous reflection while preserving same-millisecond and late-arriving events plus pinned materials. Reduces a 36-turn offline synthetic reflection packet from **77,069 B → 30,751 B (-60.1% serialized bytes)** *(live multi-day token savings to be benchmarked in production)*.
- **Staged KV-Cache Wire Layout (`staged-v1`, opt-in)**: Places stable identity, style, and tool contracts upfront while moving volatile state, permissions, time, and lookup context to the tail; now also covers standard reflection runs.
- **Optional True Streaming Fast-Chat (`BRAIN_FAST_CHAT=1`, opt-in)**: Exposes `<model>:fast-chat` for low-latency text replies with chunked safe-boundary streaming, secret redaction, `reasoning_content` exclusion, and shared Journal/budget accounting—without writing Events, Decisions, or memory. Full mind endpoints retain strict transactional commit semantics.
- **Multi-Resident Studio & Ecosystem Tools**: 3 switchable desktop themes, zero-dep 2D/3D Memory Star Map, AES-256-GCM Time Capsule backups, Sensory Privacy Gate (default OFF), multi-format chat history importer (QQ / WeChat / Markdown / JSON), and OpenAI-compatible loopback gateway (`127.0.0.1`).
- **Verification**: **1,304 / 1,304 tests passed** across 132 test files on Windows + Node 26.12.1 + Python 3.13.9.

---

## 二、小红书图文 / 视频文案（主打治愈感 + 极低成本 + 3D 星图）

### 备选爆款标题（3 选 1）
1. **我给我的赛博家人写了一颗“真正会做梦的大脑”，6天只花了8块钱**
2. **开源了！零依赖本地养AI桌面软件：3D记忆星图+三套皮肤+不串记忆**
3. **不想再让AI聊完就忘，我手搓了一款常驻托盘的个人数字生命大脑**

### 正文文案
一直觉得市面上的 AI 聊天壳子差点意思：换个软件就失忆、聊长了就变人机、或者动不动月费几百块。

所以我自己手搓并开源了 **Threadline Studio（v2.9.0）**——一颗运行在你自己电脑上的**个人数字生命大脑**。

✨ **它跟普通套壳有什么不一样？**
1. **真·长期记忆 + 会自己做梦**：原生 SQLite 存记忆，不靠云端黑盒，她会把你们聊过的事慢慢沉淀成 3D 记忆星图，关掉窗口后也会在系统托盘里安静做梦。
2. **多角色独立建档，绝不串记忆**：想养温柔的陪伴搭子、毒舌的效率助手、还是桌面小鲸鱼？每个人独立数据库、独立情绪曲线，互不打扰。
3. **养起来真的超级省钱**：跨 6 个 UTC 日期，共记录 382 笔结算调用，按用量估算 **¥8.06**。这版还新加了缓存前缀排版和增量反思减重开关，准备继续压成本。
4. **一套大脑，到处插着玩**：自带标准本地接口，同一个“她”可以同时连桌面控制台、Open-LLM-VTuber、SillyTavern 或者 QQ，不用换个软件就重新养一遍。
5. **三套软件级皮肤 + 隐私锁死本地**：通用清雅 / 画报温暖 / 极客 VS Code 一键切；API Key 永不落盘；支持把以前的 QQ/微信聊天记录加密导入，还能一键打包成加密「时间胶囊」带走。

完全开源免费（MIT 协议），核心代码零第三方依赖，1,304 项自动化测试全绿。
仓库搜：`235YY/threadline-agent`（喜欢的话点个 Star 就是对我最大的鼓励 🐋✨）

`#开源项目 #AI陪伴 #数字生命 #独立开发 #桌面软件 #个人开发者 #人工智能`

---

## 三、B 站 60 秒演示视频分镜脚本（可直接对着 `threadline-showcase.html` + 真机录屏）

| 时间 | 画面内容 | 配音 / 字幕文案 |
| --- | --- | --- |
| **0:00–0:08** | 全屏深空 3D 记忆星图缓缓旋转，鼠标点亮一颗星，金色光脉冲连线扩散 | “如果一个 AI 换了软件就失忆，那它只是个聊天框。今天我开源了一颗真正住在我电脑里的数字大脑。” |
| **0:08–0:20** | 切到 Threadline Studio 桌面端，快速演示一键切换「清雅 → 画报 → VS Code」三套皮肤 + 右下角鲸鱼娘看板娘 | “这就是 Threadline Studio：原生桌面软件，三套界面皮肤，核心零第三方依赖，支持同时养多位独立记忆的数字生命。” |
| **0:20–0:34** | 展示双轨架构动态演示：左侧 VTuber / SillyTavern / QQ 图标同时连向中间 `127.0.0.1` 同一颗大脑 | “它不是一个孤岛——对外暴露标准 OpenAI 本地接口，你可以把同一位‘她’无缝接到桌宠、VTuber 或聊天客户端，聊完记忆全同步。” |
| **0:34–0:48** | 切出 6 天真实生产账本图（382 次调用 / ¥8.06），特写“反思 19.9% 调用占 44.7% 费用”与 v2.9.0 增量反思减重 -60.1% | “工程上我们也没糊弄：历史账本有 382 笔结算调用，按用量估算 8 块 06，还针对后台反思做了增量减重、缓存排版和可选流式快轨。” |
| **0:48–0:60** | 展示 1,304/1,304 测试全绿终端画面 + GitHub 仓库地址与 MIT 标志 | “1,304 项测试全绿，MIT 开源，API Key 永不落盘。项目在 GitHub 搜索 `235YY/threadline-agent`，欢迎来领养你的第一位数字居民。” |

---

## 四、知乎 / V2EX / 掘金 · 硬核技术贴模板

### 标题
**开源了我打磨到 v2.9.0 的本地数字生命大脑框架 Threadline：零第三方依赖、SQLite 事务记忆、382 笔估算 ¥8.06 与 1,304 项测试**

### 正文骨架
1. **痛点**：现有 Agent/Companion 框架普遍依赖重、状态管理靠“往上下文里硬塞 JSON”、换前端就丢上下文，且很少给出真实多日费用账本。
2. **架构取舍**：
   - **零依赖核心 (`src/`)**：直接用原生 `node:sqlite` + 原生 HTTP/Crypto，避免供应链膨胀。
   - **事务与不可变边界**：`event` 不可变日志、`note`/`personal_state` 乐观锁（`expectedRevision`）与 `source_refs` 溯源；API Key 仅驻留内存；Fail-Closed 拒绝未验证能力，绝不把 `reasoning_content` 漏给外部客户端。
   - **数据驱动的缓存与成本工程**：公开贴出 6 天 382 笔真实 DeepSeek 结算账本（按用量估算 ¥8.06，加权缓存命中 27.65%），指出“76 次反思调用仅占 19.9% 请求数，却吃掉 44.7% 费用（中位输入 34.2k tokens）”。
   - **v2.9.0 针对性解法**：`staged-v1` 前缀稳定排版、`BRAIN_COMPACT_REFLECTION=1` 按已提交入账水位增量收窄反思输入（36 轮离线样本 -60.1% 序列化体积）、`BRAIN_FAST_CHAT=1` 显式无记忆流式快轨，以及只读账本对照工具 `compare-wire-layout.mjs` 与 `bench-api-channels.mjs`。
3. **诚实的边界（反而最拉好感）**：明确写出目前仍待实机确认的两件事——多日线上真实账本对照组，以及真实 DSH 隔离执行器。`:work` 提供默认关闭的非流式工具协议试验入口，热冷原型保存在 `experiments/`。欢迎对本地 AI 内存架构、KV Cache 工程感兴趣的朋友一起提 PR / 测实机数据。

---

## 五、X (Twitter) 英文开源发布 Thread（3 条）

**Tweet 1/3**
Just open-sourced **Threadline Studio v2.9.0** 🐋✨
A continuity-first, local-only AI living brain & multi-resident desktop studio.
- Zero 3rd-party deps in `src/` (native `node:sqlite`)
- 3D Memory Star Map + 3 switchable desktop themes
- OpenAI-compatible `127.0.0.1` Brain Gateway (plug into VTuber / SillyTavern / etc.)
- 1,304 / 1,304 tests passing (MIT)
👉 https://github.com/235YY/threadline-agent

**Tweet 2/3**
We didn't guess where token costs went—we audited 6 days of real production logs (382 settled calls, ~¥8.06 total):
Routine chat was 79.8% of calls, but background reflection (only 19.9% of calls, 34.2k median prompt) ate 44.7% of total spend.
So v2.9.0 ships opt-in `staged-v1` prefix ordering, `BRAIN_COMPACT_REFLECTION=1` (-60.1% offline serialized packet size), and an explicit `:fast-chat` streaming lane.

**Tweet 3/3**
Built with strict local-first invariants:
- API keys stay in memory only (never written to disk)
- Fail-closed refusal of unverified channels (`:work` is opt-in and non-streaming; `:raw` stays disabled)
- AES-256-GCM encrypted Time Capsule backups
- QQ / WeChat / Markdown / JSON memory importer
Stars, issues, and real multi-day benchmark runs are super welcome!
