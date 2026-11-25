# Threadline 记忆迁移与导入指南（`threadline-memory-import-v1`）

无论你过去的回忆保存在 **QQ、微信、旧日记、Markdown 笔记、SillyTavern、星野还是 ChatGPT 导出** 里，都可以按本指南整理并安全导入到指定居民的心智档案中。

## 在 Studio 导入

在记忆页选择文件，核对预览，再确认写入当前居民的记忆库。单批最多 1 MB、128 条。导入的历史聊天和旧印象保存为待核实笔记。只有新发生的事件和主体主动提交的印象走正常事实与状态写入。已存在的相同笔记会跳过。脱敏和可疑内容检查覆盖常见模式，请在预览中确认内容。

## 一、推荐的开源本地聊天记录导出工具

### 1. QQ / NTQQ 聊天记录导出
- **[shuakami/qq-chat-exporter](https://github.com/shuakami/qq-chat-exporter)**：支持 NTQQ，扫码本地导出 `JSON` / `TXT` / `HTML` / `Excel`，数据不上传云端。
- **[qingzhi-star/QL-qq-chat-history-exporter（绮录）](https://github.com/qingzhi-star/QL-qq-chat-history-exporter)**：MIT 开源 Windows 桌面端，只读本机 NTQQ 数据库，支持导出 `TXT` / `HTML` / `PDF`。
- **[zywstudy123/qq-bak-chat-history-export](https://github.com/zywstudy123/qq-bak-chat-history-export)**：直接将 QQ / NTQQ `.bak` 文件转换为 Agent 可读的 `TXT` / `JSON` / `CSV`。

### 2. 微信聊天记录导出
- **[hicccc77/WeFlow](https://github.com/hicccc77/WeFlow)** / **[jiankujidu/WeLine](https://github.com/jiankujidu/WeLine)**：本地微信 4.0+ 聊天记录查看与导出工具，支持 `JSON` / `CSV` / `TXT`。
- **[BlueMatthew/WechatExporter](https://github.com/BlueMatthew/WechatExporter)**：从 iOS / iTunes 本地备份导出 `TXT` / `HTML` / `PDF`。
- **[alanhzw/PyWxDump](https://github.com/alanhzw/PyWxDump)**：Windows PC 微信本地数据库导出 `CSV` / `HTML`。

> 隐私提醒：导出文件包含明文聊天记录，请只在自己电脑上本地处理，不要上传到不可信网站。Threadline 导入器会自动打码 `sk-...` 密钥、私钥和敏感本机路径，并拦截可疑记忆投毒。

## 二、Threadline 支持的 4 种直接导入格式

1. **标准协议 JSON / JSONL（推荐，最精准）**：
   ```json
   {
     "format": "threadline-memory-import-v1",
     "items": [
       {
         "type": "note",
         "kind": "preference",
         "text": "主人喜欢喝冰美式，不太喜欢太甜的奶茶。",
         "at": "2026-05-01T12:00:00+08:00",
         "tags": ["饮食", "习惯"],
         "confidence": "confident"
       },
       {
         "type": "personal_state",
         "kind": "impression",
         "text": "我们一起熬夜调通了实验四，默契感很强。",
         "confidence": "confident"
       },
       {
         "type": "event",
         "kind": "chat",
         "at": "2026-05-02T22:15:00+08:00",
         "scene": "import/qq",
         "sender": "主人",
         "text": "今天终于把机械臂调通了！"
       }
     ]
   }
   ```
2. **极简 Markdown（`.md`，最适合人手或 AI 整理）**：
   ```markdown
   ## 偏好
   - 喜欢在写代码时听轻音乐
   - 偏爱零第三方依赖的干净代码架构

   ## 印象与关系
   - 平时嘴上说摆烂，其实做起项目特别认真
   ```
3. **QQ 导出 `TXT`**：直接支持 `YYYY-MM-DD HH:MM:SS 昵称(QQ号)` 格式。
4. **微信 / 通用 `CSV`**：表头包含 `time/StrTime`、`sender/NickName`、`content/StrContent` 即可自动识别。

## 三、千奇百怪的旧记忆怎么办？直接抄这份「万能 AI 整理提示词」

如果你手头是杂乱的备忘录、截屏文字、旧 AI 对话记录，把下面这段提示词连同原始文字发给任意 AI，它就会吐出一份 100% 合规、可直接导入 Threadline 的 JSON：

> 请把我下面提供的零散记录、旧日记或聊天记录，整理成 Threadline 标准记忆导入协议（`threadline-memory-import-v1`）的 JSON 格式。顶层为 `{"format":"threadline-memory-import-v1","items":[...]}`；每条包含 `type`（`note` / `personal_state` / `event`）、`kind`、`text`（<=300字，不含密码/API Key）、可选 `at`、`tags`、`confidence`；丢弃客套、刷屏和隐私密码，只保留真正值得长期记住的内容。
