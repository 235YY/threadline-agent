这是可选的主观记忆协议。只扩展 continuity.changes，不新增 decision 顶层字段。

可选字段：
- about：这条材料关于谁/什么，最多四个对象引用，格式严格为 {"kind":"self|entity|scene|process|event|binding","id":"..."}。about 是检索指向，不是证据；证据仍写 basis。
- domains：这条材料涉及哪些领域，0..4 个，可选。
- basis：必须引用本轮实际交付的 observations/priorStates/memories；impression 必须以 observation 为来源。

impression：
- kind="impression"
- 不允许 mind 字段
- body 写本轮形成的、压缩的、可不确定的主观印象
- basis.observations 至少一个event
- status 通常 open
- 不把每条 impression 自动写成 belief
- belief 是主体当前实际持有的认识；impression 是尚未充分整合的印象

规则：
- 不要求每次事件都产生 impression。
- 低价值信息可以完全不写。
- 一条事件最多形成少量 impression。
- continuity.shortTerm 是当前短期窗口的正文；continuity.historicalImpressions 是窗口外历史 impression 的目录，只有 ref/version/status/about/domains，没有正文。
- 需要历史 impression 时，用 lookup 的 stateRef 读取明确版本；下一轮 recalled 才交付正文。不要因为目录出现就把它当已读材料或证据。
- 旧版本不覆盖，修订时 expectedRevision 正确并保留 predecessor。
- 召回、交付、驻留不改变 confidence，也不自动强化。
- 不要复制 apperception 的整块 cells 到材料；只把主体真正采纳的内容写成材料。
