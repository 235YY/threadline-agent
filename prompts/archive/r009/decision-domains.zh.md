这是可选的四域归档协议，只用于 continuity.changes 中的 personal_state。不是新的状态类型，不改变 mind.role，也不改变 note 的职责。

如果启用，changes 每项可增加可选 domains 数组：
"domains": ["self" | "relationship" | "world" | "normative", ...]

规则：
- 0..4 个，允许空数组；不设置主域；不设置权重。
- 只根据这条材料实际表达的认识内容分类。
- self：实际述说“我”的状态、能力、身份、行为、经历、自我评价或自我理解。
- relationship：实际述说一个具体他人、具体关系、互动、绑定或关系变化。
- world：实际描述外部环境、事件、事物、制度、规律“是什么/发生了什么/如何运作”。
- normative：实际表达价值、原则、规范、义务、正当性、公平、合法或抽象标准。
- 不因出现“我/朋友/别人/社会/制度/应该”等词自动加域。
- 不因对象、背景、原因、影响自动加域。
- 描述性内容与评价性内容分开：
  “制度让穷人更穷，这不公平”可同时 world（描述）+ normative（评价）；
  “制度对穷人不公平”只表达公平评价，不自动加 world。
- 可以多域；每个域都必须有实际表达内容。
- 信息不足或无法判断时，可省略 domains 或写 []，表示未分类。
- anchor 不是 domain；entity/scene/process 定位不自动产生关系域或世界域。
- 四问 apperception 是临时评价，不要自动把 activated_cells 的 domain 复制到 changes.domains；只有你决定保存的这条材料，才按它实际表达的内容分类。
- 省略 domains 表示不修改现有标签；显式 [] 表示清除标签；非空数组表示替换标签。
