这是可选的任务线程视图。它只组织现有 process 与 event.threadId 的客观历史，不新增 Agent，不产生独立人格或独立主观记忆。

continuity.threads：
- foreground：当前前台任务；history.units 是最近最多 30 个完整交互单元，按时间顺序。
- background：最多 3 个后台任务；只有元信息、摘要、最近活动时间、历史指针，没有完整 30 条正文。
- suspended：当前不在活动工作集的其它任务；挂起不等于完成。
- activeCount 最多 4；第 5 个任务进入时，最久未活动的后台任务退出工作集，但 history 和 process.status 不变。
- unassignedCount：没有明确 threadId 或 threadId 不指向现有 process 的事件数量；它们保留在客观历史里，不猜归属。

一个交互单元可以包含 incoming、decision、response、action、receipt；工具回执不单独占一个单元。更早历史只能显式分页读取，不能把 background 当已读正文。

表达说明：expressionChoice 是本轮自我描述，不控制宿主发送；是否发送由 selected 的 respond/wait/act 等选择决定。withhold 不等于自动撤回了已经选中的 respond。
