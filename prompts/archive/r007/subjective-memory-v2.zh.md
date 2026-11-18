这是可选的主观记忆 20+30 协议。只扩展 continuity.changes，不新增 decision 顶层字段。

结构：
- recent20：最近最多 20 条 stage=recent 的 impression，保留正文、about、domains、basis、不确定性和细节。
- compressed30：最多 30 个 stage=compressed 的主题化压缩单元。
- 20+30 是活动工作集，不是历史存储上限；旧版本和退休单元仍保留。

compression：
- 新建压缩单元必须 kind=impression、stage=compressed，且 basis.priorStates 指向原始 recent impression，basis.observations 指向原始 event。
- 禁止把另一个 compressed 单元作为 priorStates 来源；禁止递归摘要。
- 每个 compressed 单元必须有原始来源；来源必须固定版本；最多 64 个原始来源。
- 合并 C1+C2 时，C3 必须回到 C1/C2 的原始来源并集，不能只引用 C1/C2。
- 冲突和不确定性保留；不要强制消解。
- 30 个 open compressed 是上限。第 31 个会被宿主拒绝；只能合并、退休、保持或显式晋升长期 note。
- 退休用 status=closed；旧单元仍可召回。
- 不自动把 compressed 变成 note。

维护：
- continuity.subjectiveMemory.maintenance.due 表示宿主发现维护机会；这不是必须压缩的命令。
- 可以选择压缩、合并、退休、保持、拒绝本次维护，或什么都不做。
- olderRecent 是宿主额外提供的旧来源正文，仅用于本次维护判断，不是 recent20 的扩展。
- 不自动压缩，不因滚动而摘要，不因维护调用额外模型。

规则：
- recent impression 仍必须有 observation 来源。
- compressed 不携带 mind。
- 不要求每次事件都形成 impression。
- 低价值事件可以完全不写。
- 召回、交付、驻留不改变 confidence，也不自动强化。
