# 鲸漾 × Limbic：离线动力学候选 v1

这是独立、可删除的影子验证台，不是在线情绪系统。没有修改核心 schema，没有接入 continuity、LLM、QQ、注意力或真实记忆。禁止把测试通过解释成主体具备真实情感或行为收益。

## 运行

支持环境：Node 26.8+、Python 3.10+。本机专用便携解释器位于 `_local/affect-runtime/python-3.13.9/python.exe`；不安装到系统、不改PATH。其它机器可显式设置 `JY_AFFECT_PYTHON` 为兼容解释器绝对路径。

```powershell
& 'C:\Program Files\nodejs\node.exe' tools/affect-shadow/run.mjs evaluation/affect-shadow_2026-11-11/my-new-run
```

输出目录必须不存在。脚本不覆盖旧报告，失败也保留原件。打开输出目录的 `index.html` 看轨迹，`SUMMARY.md` 看结论，`report.json` 看机器可读结果。最新已验版本是 `evaluation/affect-shadow_2026-11-11/v1.1`；`v1` 保留了首轮结果及后来发现的接触适配遗漏，不能与修复后结果混算。

无需安装 pip 包。直接检查 Worker：通过 stdin 传 JSONL；每行一个请求，每行返回一个 JSON。Worker不保存进程状态；完整状态由调用方传入、返回。Node示例归档展示的是可恢复影子存储，不是正式 ContinuityStore 接线。

## 来源与基准

- 上游：<https://github.com/fistu4088/limbic/tree/2132fa81b20134f469fd7adeb8e38fa20dd32071>
- 固定提交：`2132fa81b20134f469fd7adeb8e38fa20dd32071`，pyproject版本0.10.1，MIT。
- `vendor/limbic` 与选取的原始测试逐字保留，`vendor/MANIFEST.json`记录文件SHA256，Worker在导入上游前核对。没有运行安装器、HTTP服务、上游appraiser或自动更新。
- 原始测试仅选择明确的37项离线测试，不宣称上游全套通过，不删改原断言；未纳入HTTP/安装器等测试属于本验证台范围外，不是将失败改为跳过。
- Python来源：<https://www.python.org/ftp/python/3.13.9/python-3.13.9-embed-amd64.zip>。下载后核对python.exe签名为Python Software Foundation且有效；本地下载SHA记录见运行时PROVENANCE.json。未声称做过完整发行供应链证明。

## 明确的适配行为

1. **经历与评价分账**。`facts.contacts`是宿主明确提供的实际联系人；`appraisals[].target`是情绪对象。对方未在当前接触中出现，不能仅因被评价就刷新最后联系时间。
2. **多评价预算**。0至8份评价，非空时显式正权重之和为1。这些是本经历内的强度分配权重，不是事实正确概率，也不是通用行动效用。每份评价从相同初始状态运行固定上游`Engine.apply`，再合并数值增量；情绪分量可并存，审计保留每份完整评价与效果。相同评价拆分不会把社会满足计算多次；关系影响按权重归并。此合并规则是我们的试验规则，不属于原版，也尚无心理学效度证明。
3. **接触只记一次**。社交缺口回落一次，联系人计数/时间更新一次；复用上游needs.on_event处理实际重逢时的思念缓解，同时刷新持续需求感受。参数未被调低来掩盖首轮遗漏。
4. **疲劳按明确活动时长**。关闭评价内部的每次调用疲劳扣费；使用`facts.activity`的种类、秒数、努力程度，按上游基础疲劳系数换算小时成本。此规则显式改变原版按事件计费的行为；时长和来源应由将来的宿主适配提供，不能让模型伪造工具执行事实。主观effort的来源与校准仍是接入前的问题。
5. **没有评价不调用默认Appraisal**。没有主观评价时只推进时间和处理明确事实，不自动制造新奇或能力满足。
6. **冻结上游自动行为**。关闭autonomy、leisure、romance、adult，不使用prompt_block/snapshot的行为引导，不输出性相关字段，拒绝模型式输入的权限/工具/情绪数值补丁。
7. **显式时间**。外层nowMs为毫秒，上游为秒；拒绝倒退。使用固定时区偏移，默认UTC+8，v1不支持DST。沿绝对五分钟网格推进，单次最多100天；非网格切分只验证误差界，不宣称严格半群一致。
8. **离线策略是试验选项**。`mode=offline`冻结所有已体验时间，墙钟继续；恢复后继续。虚拟生理不是真实身体，因此这是一个保守影子假设，不是已决定的鲸漾正式语义。在线但无人互动仍演化。两者禁止混同。

## 调用结构

```json
{"action":"initialize","nowMs":1794400000000,"config":{"timezoneMinutes":480,"parameters":{}}}
```

后续请求：

```json
{
  "action":"transition",
  "state":"上一次返回的完整state对象，此处仅示意",
  "operation":{
    "id":"synthetic-operation-1",
    "kind":"experience",
    "expectedRevision":0,
    "nowMs":1794400000000,
    "source":{"id":"synthetic-event-1","revision":1},
    "facts":{"contacts":["person:ann"]},
    "appraisals":[{"weight":1,"value":{"event":"greeting","summary":"合成交流","valence":0.5,"intensity":0.4,"relevance":0.7,"agency":"other","target":"person:ann"}}]
  }
}
```

其它操作：`advance`只推进时间；`mode`切换在线/离线。首次经历同一source版本不能换ID重放；同一操作同内容返回当前头状态，不倒退；同ID异内容拒绝。回忆与重新评价本版没有开放，不能偷换成新经历。影子请求去重历史上限8192，正式接入时应复用核心操作/来源账目，不能无限塞进一个状态对象。

## 原子性与故障

Worker只计算候选，不打开数据库、联网、开子进程或写文件；有Python审计钩子阻断这些能力，但不把它称为操作系统安全隔离。上游原文件摘要核对在导入前执行。

Node在事务/归档提交前调用Worker，返回后核对版本；并发候选只有一个可发布。影子目录只追加序号JSON提交，保存状态、来源、配置、评价和效果。`.pending`或锁残留时拒绝自动恢复；真实磁盘/断电/fsync交错没有普遍证明。模拟的中断不冒充真实断电验收。

Worker退出/超时/输出格式错误不发布；提交后调用方丢失结果，重开按已有提交识别，不重复施加影响。影子记录不写B/C/R/Z、Impression、Note、entity/binding。

## 验收范围

当前37项原始基准、16项适配契约、8项Node故障/接续检查通过；24条30/90天轨迹覆盖无人互动、工作休息、负面后恢复、持续关系交流及3档社交增长参数。保留完整轨迹，数值有界不是心理合理的证明。关系轨迹只有固定每日交流，尚未覆盖所有冲突、分离、重逢组合。

未做：真实模型评价、真实历史重放、行为干预收益、核心事务接线、真实QQ重启、随机配置全域稳定性证明。下一阶段先审阅适配策略和影子结果，再设计临时核心副本接线；不从本脚本自动升级。

## 回滚

停止运行即可，线上服务未接入本工具。删除本工具、专用离线结果及本地便携解释器前先保留报告即可；无schema回迁、无账本恢复、无旧记忆覆盖。不要删除鲸漾原本的其他运行目录。
