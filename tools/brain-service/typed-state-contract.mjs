// Host interface clarification, carried by the existing sealed instructionSuffix.
// Historical prompts and packets retain their original bytes and verification.
export const TYPE_BOUNDARY='对象类型边界：attention.processes 中的任务进程与 continuity.changes 中的 personal_state 是不同对象，即使 ID 相同也不能互换。只更新进程时仅写 attention.processes，不要把进程再复制一份到 changes。completed/abandoned 是进程状态；主体认识状态只能用 open/suspended/closed。看到进程正文不等于读过同名主体认识；修订后者仍须先取得 foreground/recalled 或 stateRef 的当前版本。可以不修改状态而正常表达，不必为回复或任务结束附带状态修改。';
export function withTypedStateContract(factory){
 return args=>{const session=factory(args);for(const name of ['prepare','prepareReflection'])if(typeof session[name]==='function'){
  const original=session[name].bind(session);session[name]=input=>original({...input,instructionSuffix:[input.instructionSuffix,TYPE_BOUNDARY,'依据引用边界：聊天时间线是交流线索；只有本轮 current、materials 中交付完整正文的事件，才可写入 basis.observations。时间线的 bodySource 指向实际正文位置；没有 bodySource 的旧条目需要先查阅正文，或暂不把它作为新认识的依据。可以正常回复而不提交新认识。'].filter(Boolean).join('\n\n')});
 }return session;};
}
