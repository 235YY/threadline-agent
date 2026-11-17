# JY-OPTIMIZE-007：减轻模型操作负担、解冻Prompt、启动前诊断

基线：`release/jy-recovery-005` @ 987045e（交接包指定的精确提交）。
不部署、不接QQ、不调用模型、不迁移数据。离线回归结果见文末“审查后修正”。

## 1. 模型不再需要抄写版本号（交接01/02“模型操作负担重”）

真实记录中，模型正确理解了港口/厨房两项工作，却把两个Process ID填进personal_state更新，
整轮因STATE_CONFLICT未被采用，连同合法回复一起丢失。根因是让模型手工维护本可由宿主
可靠产生的技术字段：每条修改都要正确抄写`expectedRevision`。

改动（`src/revision-derivation.mjs`，接在已有的proposal-normalization层）：

- `continuity.changes`、`attention.processes/relations/questions`省略`expectedRevision`时，
  宿主按**本轮交付**的版本补上：已交付个人状态取其交付版本；本轮frame中的Process等取frame版本；
  不存在的对象为0。每次补值都记入proposal-normalization诊断，原始输出原样保留。
- 不放松任何检查：补的是交付版本，交付后对象若已变化，仍由Store报STALE/CONFLICT；
  模型显式填写的版本照旧严格校验；frame不是交付的那一版时不补。
- 已存在但本轮未交付的个人状态，不再报含糊的版本冲突，而是报`UNREAD_STATE`。

## 2. Process ID误填为个人状态：明确报错，不再可能静默成立

Process存在于attention frame中而不是顶层记录。旧代码对“Process ID写进continuity.changes”：
填Process版本→STATE_CONFLICT（原因难懂）；**填0→静默新建一个与Process同名的个人状态**。
现在统一报`WRONG_OBJECT_KIND`，details给出`updatePath: continuity.attention.processes`，
并写入下一次机会可见的operation-feedback（`ID_COLLISION`、`UNREAD_STATE`、`INTENT_OPTION`同样回流）。
不做部分提交：Decision仍原子提交，这一点与交接03 §9一致。

## 3. Prompt可以改了（新发现，交接文档未提及）

封存包的验证方式是用**当前**Prompt文件重新生成指令再逐字比对。结果是：改Prompt任何一个字，
所有历史付费证据、待恢复的崩溃轮次、维护输入都会变成`PACKET_CHANGED`。这正是代码里
大量`.replace(旧句子,新句子)`叠加补丁、以及“不断增补文字”的结构性原因。

现在Prompt按“代”管理（`src/prompt-generations.mjs`，`prompts/archive/r006/`为987045e的完整快照）：
新封包只用当前代；验证时任意已知代逐字重建成功即通过。篡改保护不变——没有任何宿主代能产生的指令仍被拒绝。
认知、紧凑wire协议、两条维护路径均已接入。改Prompt的流程见`prompts/archive/README.md`。

随之做的Prompt修改很小：告知`expectedRevision`可省略；原先内联在cognition.mjs里的
“操作填写边界”长句移入`prompts/operation-boundary.zh.md`并精简。

## 4. 启动前诊断（交接02“开箱即用程度有限”）

`node tools/brain-service/doctor.mjs`（`npm run doctor`），见docs/CONFIGURATION.md。
只读；把需要运营方补齐的东西一次列清，并给出下一步。几项会在启动时才暴露的问题现在提前可见：

- 非Windows平台：默认模型凭据只有DPAPI实现，live无法取得密钥；
- `JY_OPEN_LIFE=1`走标准run.mjs必然`LIFE_POLICY_REQUIRED`（run.mjs不注入lifePolicy）；
- QQ桥`QQ_SDK_MODULE`的默认值是原机相对目录；`JY_AFFECT_PYTHON`默认是原机Windows路径；
- 数据库不存在时会新建空主体——诊断明确提示，避免把空库误当原主体接续。

## 没有改的，以及原因

- 不改主体语义、记忆层次、Event/Process/Intent/Task边界和自主性规则；不新增强制检索/总结/行动。
- 不对语义校验失败做自动二次调用：会改变费用与UNKNOWN规则，需另行确认。
- 不新增跨平台凭据实现：涉及密钥保管方式，属于运营方决策（诊断会明确报告）。
- 回执“来自哪个动作”的交接（01中把inspect回执当写入）尚未处理：需要真实调用对照才能判断是否有效，
  建议作为下一步，在同任务/同Token条件下对比。

## 审查后修正（第二个提交）

外部审查提出三点，处理如下：

1. **live启动不得静默新建主体/账本或全开QQ。** 原先只是诊断里的WARN，而且诊断不拦启动。
   现在`launchBrain`本身在live下拒绝：BRAIN_STORE不存在（除非`JY_NEW_SUBJECT=1`）、
   BRAIN_LEDGER不存在（除非`JY_NEW_REQUEST_JOURNAL=1`）、既无`QQ_TEST_ONLY_OWNER`也无`JY_QQ_SCOPE=all`。
   检查发生在获取任何资源之前，不创建文件。doctor使用同一规则，显式确认后降为WARN。
2. **Prompt版本覆盖维护流程。** 维护基础Prompt、焦点Prompt与mind扩展整体按代加载；
   新增`test/prompt-generations.test.mjs`，对认知、紧凑wire、维护三条路径分别验证：
   旧代合法封包通过、只篡改指令的封包被拒、新旧混拼被拒；并检查每个归档代都是完整快照。
   仍在代码里内联的指令（如维护focused-adapter的说明句）没有改动，因此当前无影响；
   以后若要修改，按prompts/archive/README.md先移入文件再归档。
3. **Build身份跨平台稳定。** 仓库里本来就有CRLF/混合换行文件，Windows autocrlf还会改写其他文件，
   按原始字节计算无法跨平台一致。现在按`source-text-lf-v2`规则（CRLF视同LF）计算，规则名进入指纹；
   另加`.gitattributes`（`* -text`）让git在任何平台都按原样检出，使清单里的逐文件SHA也一致。
   规则改变后，旧Build编号（如5d81afb8…）不能与新编号直接比较，清单中保留旧值供追溯。

离线回归原始日志：`docs/optimize-007-test.log`（`node scripts/test-current.mjs`，spec reporter）。
