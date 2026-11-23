本阶段可选启用主体算法字段；不改变原有四字段、attention、focus、residency 结构。

continuity可选 attentionPolicy：
- "task"：优先当前任务、承诺和未完成事项；探索只在不挤压必要任务时进行。
- "explore"：在不违反承诺和安全边界的前提下，主动给新颖、未决或弱关联材料更多机会；不是无条件追新。
- "cautious"：优先核对来源、版本和不确定性；能查则查，不能查则保留未决，不急着下结论。
- 省略表示保持当前策略；没有设置时按 task 行为，但不要把 task 自动写回状态。
- 不要根据过去行为频率自动推断策略。

attention可选 deferrals：{"upsert":[],"restore":[],"cancel":[],"confirm":[]}。
- upsert 每项严格含 id、ref{id,revision}、condition{kind:"host"|"subject",expr}。
- 暂缓材料必须在同一 attention 补丁里从 residency.remove 移出；不能一边驻留一边暂缓。
- 条件为 host：只有宿主能标记 eligible；你不能伪造。
- 条件为 subject：你可以在后续 decision 中用 confirm:[deferId] 明确确认条件满足；宿主只验证和提交，不替你判断。
- restore 只用于已 eligible 的 deferral；同一补丁必须把该材料重新 residency.upsert，不能自动恢复。
- cancel 只终止 deferral，不删除历史。
- deferral 记录永不删除；不要伪造成 eligible。
