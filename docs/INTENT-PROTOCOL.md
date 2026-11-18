# intent-v1：模型表达意图，宿主编写事务

## 为什么

完整决策协议要求模型在约 3 万字节的说明下，亲手写出嵌套事务：options/selected、
continuity.changes（含版本、basis、nature）、residency、attention.processes/relations/residency/questions/focus/eventProcesses。
交接文档里的失败（ID 混用、记账错误整轮作废、合法回复丢失）大多来自这层记账，而不是理解错误。

## 怎么做

1. 宿主照常封存基础包（prepareDecision，所有来源/版本/预算规则不变）。
2. `intentPacket(base)` 把它投影成一个简单视图：current（E0）、最近对话、上次行动及其结果状态、
   自己的状态（S1…）、正在做的事（P1…，含近期往来）、材料（M1…）、自动浮现的旧记录线索（R1…）、
   可用工具（T1…，带参数说明）、剩余查询次数。说明文字约 2 千字（prompts/intent-v1.zh.md）。
3. 模型只回答：decision（reply/act/lookup/wait/pause/continue/none）、states、work、used，全部用编号。
4. 提交时 `expandIntent` 把它编译成普通完整输出，再走原有 normalize → commitDecision → Store 校验。
   `intent-compilation` 记录原始回答和诊断；编译结果已经保存在决定提案，不再重复写一份。

宿主只填写由交付包或模型明确选择唯一确定的记账：新对象 ID、版本、basis（当前观察）、
被保留状态的驻留、模型标了 thisMessage 时的事件归属、Process 未改字段（从交付的那一版 frame 读取）。
不替模型产生任何状态、工作、归属、工具调用或回复。

## 与原语义的关系（需要你们确认的点）

- 保留的状态默认留在下一轮视野里（active-task 驻留，完整交付），可用 keep:false 关闭。
  这与非注意力模式下“开放状态进入前台”的原行为一致；关闭的状态退出。
- 新状态 nature=encounter、basis=当前观察；修改为 reappraisal。
- used 只计 M 材料；E0/T/未打开的 R 被记诊断后忽略（used 本来就不是因果证明）。
- 当前项不能归属工作（如工具回执）时，thisMessage 记诊断后忽略，而不是整轮作废。
- v1 不覆盖：反思、AgentTask 步骤、带宿主附加说明（任务结果/重新准入）的包、Intent 对象生命周期、
  复杂条件树与预测、问题跟踪、焦点选择、经验学习写入。反思、任务步骤与上述特殊决定仍走各自现有完整入口。
- 新封存普通包使用 `intent-base-v2` 投影：可选的统觉判断、状态领域、认识/关切/条件、用已读 S 编号连接的行动准备；
  交付已有判断及情绪对象和原因。T 工具用现有授权；`start_agent_task` 可用 P/G 编号显式选择 Process 或 Intent。
  Process 历史中的任务证据显示来源、结果状态与截断标志；摘录不是正式引用。旧封存包保持原投影。

## 启用

`JY_INTENT_PROTOCOL=1`（默认关闭）。请求身份、RequestJournal、UNKNOWN 规则、一次格式修复都不变；
修复时用 intent 的格式检查与原 intent 消息。

## 证据

evaluation/intent-study_2026-11-17/README.md：同条件 DeepSeek 对照，各 30 次：
采用 30/30 vs 25/30，输入 token 1.2k vs 9.0k，耗时 2.0s vs 4.2s。

## 自然度（2026-11-18）

- 群消息附 `chat`、`mentionsYou`（她的名字或 @ 出现在消息里；名字取自身份文本“你是/你叫/叫你…”），
  以及消息开头 @ 了别人时的 `to`。这只是提示：没叫她时说明里建议多数时候看着就好，想插话仍可以。
- 说话方式的提示写进 intent-v1 说明本身（不再只在配置了风格时出现）：一两句口语，不主动揽活、不总结。
- 引用原话用中文引号“”，不再要求「」。
- 私聊内容不做硬性屏蔽，提示是像平常人一样拿捏分寸：托付保密的不说，私聊原话不在群里转述。
- used 永不导致整轮作废：非材料或不存在的编号只记诊断。
- 改动前的整套 Prompt 已归档为 r009。
