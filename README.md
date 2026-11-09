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

## 目录

```text
app/
  src/       核心认知、状态、记忆、任务、工具接口
  tools/     运行时、QQ/OneBot、办公室 worker、插件、UI
  prompts/   决策与记忆协议模板
  package.json
data.example/  本地数据目录示例（不含任何真实数据）
```

## 运行要求

```text
Node.js >= 22.13
```

```bash
cd app
npm install
```

把 `data.example/` 复制成 `data/`，再按需配置：

```text
data/identity.txt   智能体身份模板（可空）
data/secrets/       本地凭据，不进入 Git
```

启动：

```bash
node tools/ops/launch.mjs start
```

停止：

```bash
node tools/ops/launch.mjs stop
```

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
