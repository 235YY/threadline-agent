# Threadline Agent

Threadline 是一个支持版本化记忆、持续状态、任务与工具回执的智能体框架。使用者以空白主体开始，可以填写自己的身份说明，按需决定是否接入模型或外部平台。

## 下载就用：本地工作台

1. 安装 [Node.js](https://nodejs.org/) 26.8+。解压后，Windows 双击 **Start-Threadline.cmd**；其他系统在目录中运行 `npm start`，打开终端显示的本机地址。核心无需安装 npm 依赖。
2. 在「模型与额度」填自己的 **DeepSeek API Key**，可先检查密钥，再勾选启用、保存。第一次聊天前不用配置生产账单采集器。打开网页本身不触发推理。密钥只在当前应用进程中保留，关闭后需要重新输入。
3. 在「人设与语言包」粘贴内容，或导入 TXT / Markdown；「记忆库」导入 TXT / Markdown 或 Threadline 笔记 JSON，也可导出。首次运行创建自己的空白主体。
4. 要启用「Limbic」，另装 Python 3.13，填写可执行文件（可填 `python` 或完整路径），选引擎、统觉联动及可选参数。已经产生的情绪记录不随参数更改而重置；首次生成状态前设置参数。
5. 要连接 QQ，先安装并登录自己的 **SnowLuma / OneBot**，准备其 SDK（JS 入口）。填写本机数据目录、SDK 路径、Bot 账号、允许私聊的账号，然后点击「保存并连接 QQ」。保存后可一键连接或断开；初次安装和 QQ 登录在外部完成。这个工作台默认仅允许指定账号的私聊文本；没有群聊或主动外发。

工作台绑定本机回环，在 `_local/desktop` 保存配置、身份、语言包、笔记和运行记录。启用模型后，对话材料会按现有认知流程发送给 DeepSeek。每日用量按本工作台使用量估算，未决请求保留预算估算；这不是服务商扣费记录，也无法统计其他客户端的开销。标准服务仍可使用独立的官方消费上报路径。关闭时请在启动窗口按 Ctrl+C。

记忆导入新增待核实的笔记，不接受整库覆盖，也不导入旧情绪状态或请求日志。JSON 例子：

```json
{"format":"threadline-notes-v1","notes":[{"body":"新项目喜欢先做一个小样。","kind":"preference"}]}
```

## 作为框架运行



```sh
node tools/brain-service/run.mjs
npm test
```

启动默认是离线模式。配置标准宿主可复制 `.env.example`，用 `node --env-file=.env tools/brain-service/run.mjs` 启动。要进行真实模型对话，需配置自己的身份文件、DeepSeek 凭据、用量上报与显式运行授权。QQ、语音、Minecraft 和桌面适配各自需要独立依赖，且默认不随包启用。设置见[配置说明](docs/CONFIGURATION.md)和[可选集成](docs/INTEGRATIONS.md)。

默认测试使用合成数据。完整回归包含可选情感引擎，需要 Python；可用 `JY_AFFECT_PYTHON` 指向已安装的 Python 3.13。详见[验证说明](docs/VALIDATION.md)。

应用数据、密钥、聊天、个人设定、私有工具实现和运行账本均不随包。提供的身份示例是通用模板。参见[架构](docs/ARCHITECTURE.md)与[隐私](docs/PRIVACY.md)。

MIT 许可；第三方来源详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

