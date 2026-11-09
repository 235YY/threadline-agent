# Threadline

**A continuity-first runtime for persistent AI agents.**

**一个自我，多条注意力线程。**

Threadline 是一个可复用的持续认知智能体框架。它把“客观发生过什么”“她现在怎么想”“她手头在处理什么”“她选择记住什么”分开，而不是把所有消息塞进一个不断被刷掉的聊天窗口。

这个仓库只包含框架代码，不包含任何具体智能体的记忆、人设卡、聊天记录、账号信息、API key、运行日志或本地隐私数据。

## 核心模型

```text
客观事件流     所有真实发生的事，追加保存
主认知         她过滤后的连续认知状态
注意力线程     当前关注通道的材料视图
长期记忆       她选择写下的内容
```

## 设计目标

- 客观事件流与主观认知分离
- 最近上下文、注意力线程、长期记忆分层
- 记忆必须由智能体自己写入
- 所有外部工具调用都经过显式边界
- 默认身份为空模板，谁都可以配置成自己的智能体

## 设计文档

- [设计理念](docs/00-philosophy.md)
- [数学性质与证明草稿](docs/01-mathematical-properties.md)
- [设计演进过程](docs/02-evolution.md)
- [实现状态与边界](docs/03-implementation-status.md)
- [统觉层数学研究 v0.1.2](docs/04-apperception-math.md)

## 目录

```text
app/
  src/       核心认知、状态、记忆、任务、工具接口
  tools/     运行时、QQ/OneBot、办公室 worker、插件、UI
  prompts/   决策与记忆协议模板
  package.json
data.example/  本地数据目录示例（不含任何真实数据）
```

## 快速开始

要求：

```text
Node.js >= 22.13
```

从仓库根目录执行：

```bash
cd app
npm install
node tools/ops/init.mjs
```

`init` 会创建：

```text
data/memory.sqlite   空记忆库
data/identity.txt    通用身份模板
data/secrets/        本地凭据目录
data/style/          风格目录
data/logs/           日志目录
workspace/agent-office/  办公室工作区
```

然后启动：

```bash
node tools/ops/launch.mjs start --no-open
```

默认是 **dry-run**，不需要模型 key，用来检查服务能否启动。

控制台：

```text
http://127.0.0.1:8790
```

停止：

```bash
node tools/ops/launch.mjs stop
```

## 接入真实模型

默认 `BRAIN_LIVE=0`。接真实模型时：

```bash
BRAIN_LIVE=1 node tools/ops/launch.mjs start --no-open
```

模型 key 支持两种方式：

```text
DEEPSEEK_API_KEY 环境变量
或
data/secrets/deepseek.key
```

PowerShell 示例：

```powershell
$env:BRAIN_LIVE = "1"
$env:DEEPSEEK_API_KEY = "你的 key"
node tools/ops/launch.mjs start --no-open
```

不要把 key 写进仓库、README 或日志。

## 接入 QQ / OneBot

把示例：

```text
data.example/qq.json.example
```

复制为：

```text
data/qq.json
```

按你的 OneBot 实现修改：

```json
{
  "ws": "ws://127.0.0.1:3001/",
  "http": "http://127.0.0.1:3000",
  "token": ""
}
```

支持标准 OneBot v11；SnowLuma / NapCat / LLOneBot 等都可以，不做绑定。

QQ 没启动时，连接器会等待，不会影响 brain/office 启动。

## 办公室和插件

办公室工作区默认在：

```text
workspace/agent-office/
```

插件放在：

```text
workspace/agent-office/plugins/
```

相关工具：

```text
office_*       文件、命令、npm
office_plugin_* 插件安装与运行
github_*       一个配置仓库的最小权限操作
```

具体能力可以从 UI 或工具层查看。

## 隐私边界

`.gitignore` 默认排除：

```text
data/
*.sqlite
*.db
*.log
secrets
node_modules/
workspace/
release/
node/
```

这个仓库不应提交：

- 真实记忆数据库
- 人设卡
- API key / token
- QQ 号、账号、聊天记录
- 本地绝对路径
- 运行日志和测试产物

## 说明

这是一个 sanitized skeleton。  
具体模型提供方、身份、记忆内容、通道配置和凭据需要使用者自己配置。
