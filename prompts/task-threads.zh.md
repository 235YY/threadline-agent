这是可选的任务线程视图。它只组织现有 process、event.threadId 与主体明确声明的事件归属 的客观历史，不新增 Agent，不产生独立人格或独立主观记忆。

continuity.threads：
- foreground：当前前台任务；history.units 是最近最多 30 个完整交互单元，按时间顺序。
- background：最多 3 个后台任务；只有元信息、摘要、最近活动时间、历史指针，没有完整 30 条正文。
- suspended：当前不在活动工作集的其它任务；挂起不等于完成。
- activeCount 最多 4；第 5 个任务进入时，最久未活动的后台任务退出工作集，但 history 和 process.status 不变。
- unassignedCount：既无有效 threadId 也无当前主体显式关联 的事件数量；它们保留在客观历史里，不猜归属。

一个交互单元可以包含 incoming、decision、response、action、receipt；工具回执不单独占一个单元。更早历史只能显式分页读取，不能把 background 当已读正文。

表达说明：expressionChoice 是本轮自我描述，不控制宿主发送；是否发送由 selected 的 respond/wait/act 等选择决定。withhold 不等于自动撤回了已经选中的 respond。

显式事件归属（仅 attention.eventProcessSupport.enabled=true 时）：
- 可以在 continuity.attention 里可选添加 eventProcesses:{"add":[{"event":{"id":"实际事件ID","revision":1},"process":{"id":"实际过程ID","revision":1}}],"remove":[]}；撤回使用相同配对放进remove。省略即不改变，不要求每次关联或创建过程。
- 只用 eventProcessSupport.events 中实际交付完整正文的事件，以及当前交付的本主体 Process 版本，或本次新建过程的 revision:1。recent 摘录或目录不算完整事件。宿主还会检查该事件确实已进入本主体收件箱。
- 只有你认为事件属于该过程才明确关联；不按会话自动分配。一条事件可显式关联多个过程。相同配对重复提交无副作用；撤回只退出这一对的显式关联，不改原始threadId、不删事件或历史，也不影响其他过程。
- Process 用稳定ID继续承载归属；提交的版本及所在Attention版本只记录建立关联时的来源，后续过程修订不会丢失历史。
