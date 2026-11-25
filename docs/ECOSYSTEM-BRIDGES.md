# Threadline Studio 生态接入指南（数字人 / Cortico / DSH / AstrBot / MCP）

Threadline 只专注做一颗**长期连贯、会做梦、有情绪、不产生垃圾的大脑**；聊天渠道、语音听写、桌面宠物、实时虚拟形象和第三方工具都可以零改造接进来。

## 1. 先开启本地大脑网关

打开 Threadline Studio → 左侧 **🔌 连接** → 勾选 **启用本地大脑网关（支持兼容 SSE）** → 点击 **保存并应用网关**。

默认暴露三个本地地址（仅监听 `127.0.0.1`）：
- OpenAI 兼容 Base URL：`http://127.0.0.1:18792/v1`
- 对话接口（`stream: true` 将已完成回复按段发送）：`http://127.0.0.1:18792/v1/chat/completions`
- 实时情绪与状态流（SSE）：`http://127.0.0.1:18792/v1/events`

## 2. 接入实时数字人 / VTuber（Open-LLM-VTuber、Fay、VTube Studio 等）

1. 在 Threadline 网关设置里勾选 **回复附带 Limbic 情绪标签**（例如 `[happy]`、`[sleepy]`）。
2. 在数字人软件的大模型配置中，选择 **OpenAI 兼容接口**：
   - `Base URL`: `http://127.0.0.1:18792/v1`
   - `Model`: `threadline-brain`
   - `API Key`: 从 Studio 的连接配置复制网关凭证
   - `Stream`: 可开启 SSE 兼容模式
3. 如需实时驱动嘴型以外的“正在思考 / 正在做梦 / 心情变化”动作，可订阅 `http://127.0.0.1:18792/v1/events`（参考 `tools/bridges/dsh-cortico-bridge.mjs`）。

## 3. 兼容 Cortico / Coopanion 桌宠项目

- **作为大脑后端**：在 Cortico / Coopanion 的模型提供方中填写 `http://127.0.0.1:18792/v1` 与模型名 `threadline-brain`，桌宠本体继续负责透明悬浮窗、摸头互动、语音听写（whisper.cpp）与动作演出。
- **状态气泡联动**：`/v1/events` 推送 `{ t: "status", status: { kind, text }, emotion, mood }` 结构，可直接映射到 Cortico 的状态气泡与表情帧。

## 4. 寄生 DeepSeek Harness（DSH）生态

- **导入 DSH 桌宠包**：在「🎨 设置 → 外观工坊」直接导入 `pet.json` 或透明 PNG/GIF 即可挂在聊天房间右下角。
- **把 Threadline 当成 DSH 外部大脑**：将 DSH 外部模型端点指向 `http://127.0.0.1:18792/v1`，并通过 `tools/bridges/dsh-cortico-bridge.mjs` 转发状态流，即可直接享用 DSH 的皮肤、桌宠与 IM 渠道插件。

## 5. 接入 AstrBot / SillyTavern

- 在 AstrBot 或 SillyTavern 中新增一个 **OpenAI 兼容服务商**，填写 `http://127.0.0.1:18792/v1` 和模型名 `threadline-brain` 以及网关凭证。消息进入当前居民认知，是否写入长期记忆取决于主体选择。

## 6. 挂载 MCP 插件

在 **🔌 连接 → MCP 插件中心** 直接粘贴标准 `mcpServers` JSON（与 Claude Desktop / Cursor / AstrBot 格式通用），支持本地 `stdio` 与远程 `Streamable HTTP`。写入类高危工具默认受保护，需在对应服务器配置中显式设置 `"allowWrite": true` 才会放行。


## 感官摘要与换脑速查（v2.6）

- 网关只监听本机 `127.0.0.1`。实际端口以 Studio 的「连接」面板为准，默认 18792。
- 在 Open-LLM-VTuber、AIRI 等支持 OpenAI 兼容协议的客户端中填入 Base URL、模型名和网关凭证。主脑当前使用 DeepSeek Flash。具体第三方客户端、游戏和语音接线需各自验收。
- 打开 Studio 的「感官隐私闸门」，选择 L1 或所需摘要等级，再点「授权信号客户端」。凭证只显示一次，绑定授权时的居民；可用编号撤销。
- `POST /v1/context/signal` 需要 `sensory:push`。发送简短文本摘要，使用 `Authorization: Bearer <客户端凭证>`。服务端从凭证确定来源和居民。示例正文：`{"kind":"activity","app":"Code.exe","summary":"写代码约 45 分钟"}`。
- 拉窗帘会清空暂存信号并拒绝新推送。通过 Studio 操作；如使用 `POST /v1/sensory/curtain`，需网关管理凭证并明确传入 `{"curtain":true}` 或 `{"curtain":false}`。
- L2/L3 是摘要类别，当前接口只存有时限的本机文本。屏幕采集、麦克风、感官入模、电脑控制和 QQ 主动提醒尚未接线。
- SSE 提供状态和情绪。每条回复只发回发起该请求的客户端；它不是上游模型首字流。个人模型凭证不用于此本地网关。
