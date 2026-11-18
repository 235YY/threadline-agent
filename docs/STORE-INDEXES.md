# 存储查询索引（2026-11-18）

## 为什么
每轮准备输入时，最近对话、社交视图、任务线程和联想检索都用 `store.all(type)` 把整类记录读出并解析一遍；
任务线程还会为每个线程把所有 decision（每条带完整输入包，约 40KB）解析一遍。耗时随消息数线性增长。

## 做了什么
- schema.mjs 增加 7 个表达式部分索引（`versions_by_*`），按 会话+时间、发言人+时间、线程、
  decision 的当前事件、动作的回执、扩展记录类型+拥有者、事件归属的 Process 建索引。
  只是查询加速：不改表、不改记录、不改 schema 版本；已有数据库首次打开时自动建（10 万条消息约 0.75 秒），旧代码读写不受影响。
- store.mjs 增加只读查询：`newestInScene`、`newestFromSender`、`eventsInThread`、`decisionsForEvent`、
  `actionForReceipt`、`extensionRecords`、`linksForProcess`、`countAdmittedEvents`。
- recent-context、social-projection、task-threads（taskThreads / threadUnits / eventProcessLinks）改走这些查询；
  没有这些方法的 store 仍走原来的全量扫描。
- `store.search` 的子串匹配先在 SQLite 里过滤，只解析命中的记录；含非 ASCII 大小写字母的词或按行动来源追溯时仍走全量。

## 结果（合成群聊库，单轮 prepare）
| 消息数 | 之前 | 之后 |
|---|---|---|
| 2 万 | 933ms | 107ms |
| 10 万 | 4401ms | 425ms |

test/store-indexes.test.mjs 用同一个库分别走索引和走全量扫描，要求社交视图、最近对话、任务线程、
线程历史、事件归属和搜索结果逐字相同，并检查查询计划确实用到索引。
剩余的线性部分主要是联想检索的子串匹配（已在 C 层完成）；更大规模时可再加全文索引（FTS5）。
