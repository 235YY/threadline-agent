// Operational metadata and preflight only. This registry never grants a tool.
import {ensure} from './contracts.mjs';
import {ANCHOR_KINDS,normalizeAnchor} from './anchor.mjs';
const s={type:'string'},i={type:'integer',minimum:0},count={type:'integer',minimum:1,maximum:20};
const def=(purpose,properties={},required=[],extra={})=>({version:1,purpose,inputSchema:{type:'object',properties,required,additionalProperties:true},dependency:'not-confirmed',sideEffect:'read',result:'原始结果随真实回执返回；提案不等于执行，空页不证明整个范围不存在。',...extra});
const recipient={target:{type:'string',enum:['private','group']},id:{type:['string','integer'],pattern:'^[0-9]+$',minimum:1},url:s};
const anchor={type:['object','null'],properties:{kind:{type:'string',enum:ANCHOR_KINDS},id:{type:'string',maxLength:200}},required:['kind','id'],additionalProperties:false};
export const TOOL_CONTRACTS=Object.freeze({
 qq_list_stickers:def('按关键词查当前本地表情库，或分页浏览',{query:{type:'string',maxLength:100},offset:i,limit:{type:'integer',minimum:1,maximum:32}},[],{result:'items含表情id/描述/url；total是本次匹配总量，nextOffset非null表示还有页。文件缺失是不可用，不是无匹配。',next:'可用nextOffset继续查，或自主选择item.url发送；无需强制发送。'}),
 qq_send_sticker:def('发送查询取得的真实表情图片',recipient,['target','id','url'],{sideEffect:'external-send',result:'只有实际message_id及关联回执才确认成功；未知不得补发。',example:{target:'private',id:'接收方QQ号',url:'查询结果item.url'},warning:'id是接收方QQ/群号，不是表情item.id；实际目标必须满足本轮授权约束。'}),
 qq_send_message:def('给获准目标发送文字',{...recipient,text:s},['target','id','text'],{sideEffect:'external-send'}),
 qq_list_friends:def('列出真实好友'),qq_list_groups:def('列出真实群'),
 qq_get_group_history:def('读取指定群最近消息',{group_id:{type:['integer','string']},count},['group_id']),
 qq_get_friend_history:def('读取指定好友最近消息',{user_id:{type:['integer','string']},count},['user_id']),
 qq_get_group_members:def('读取群成员',{group_id:{type:['integer','string']}},['group_id']),
 qq_get_forward_msg:def('读取实际转发消息',{id:s},['id']),
 anchor_recall:def('按已知对象查主观记忆',{anchor,role:s,limit:count},['anchor']),
 attention_status:def('查看注意力屏蔽及积压状态'),style_status:def('查看当前语言风格'),
 web_search:def('搜索公开网页',{query:s,maxResults:{type:'integer',minimum:1,maximum:10}},['query']),
 web_fetch:def('读取公开网页正文',{url:s},['url']),
 office_status:def('查看办公室配置与限制'),office_list:def('列出办公室路径',{path:s}),
 office_read:def('读取办公室文件',{path:s},['path']),office_search:def('检索办公室文本',{query:s,path:s,max:count},['query']),office_audit:def('查看办公室实际操作记录',{limit:count}),
 github_status:def('查看GitHub配置状态'),github_repo:def('读取已配置仓库'),github_issues:def('列出issue',{state:s,limit:count}),github_issue:def('读取issue',{number:{type:'integer',minimum:1}},['number']),github_pulls:def('读取pull request列表',{state:s,limit:count}),github_branches:def('读取分支',{limit:count}),
 remember_note:def('自主保存值得保留的记忆；anchor可省略，填写时kind只能为self/entity/scene/process，人物用entity，id引用实际人物对象ID，不能猜对象',{body:s,kind:{type:'string',enum:['fact_claim','interpretation','value','preference','dream','tension','feeling','skill']},anchor,scene:s},['body'],{sideEffect:'local-write'}),
 start_agent_task:def('为自己选择的持续目标创建任务',{goal:s,plan:{type:['string','array']},allowedTools:{type:'array',items:s},intentId:s,target:s},['goal'],{sideEffect:'local-task',warning:'allowedTools只能取已授权工具；绑定已有Intent需显式intentId，不猜归属。任务结束不等于目标完成。'}),
 pause_agent_task:def('暂停已有任务',{taskId:s,reason:s},['taskId'],{sideEffect:'local-task'}),stop_agent_task:def('停止已有任务',{taskId:s,reason:s},['taskId'],{sideEffect:'local-task'}),redirect_agent_task:def('调整已有任务',{taskId:s,goal:s,plan:{type:['string','array']},target:s},['taskId'],{sideEffect:'local-task'}),
 task_finish:def('结束当前任务并交回实际结果',{result:{type:['string','object','array']},summary:s},[],{sideEffect:'task-control'}),task_blocked:def('说明当前任务受阻',{reason:s},['reason'],{sideEffect:'task-control'}),task_help:def('请求协助',{reason:s},['reason'],{sideEffect:'task-control'}),task_pause:def('暂停当前任务',{reason:s},[],{sideEffect:'task-control'}),task_wait:def('等待任务条件',{reason:s,wakeAt:i},[],{sideEffect:'task-control'}),task_replan:def('自主调整计划',{plan:{type:['string','array']}},['plan'],{sideEffect:'task-control'}),task_redirect:def('自主调整任务方向',{goal:s,plan:{type:['string','array']}},[],{sideEffect:'task-control'})
});
export function toolContract(name){return TOOL_CONTRACTS[name]??null;}
function valueType(v){return v===null?'null':Array.isArray(v)?'array':typeof v==='number'&&Number.isInteger(v)?'integer':typeof v;}
export function validateToolArguments(name,args){
 const c=toolContract(name);if(!c)return;const schema=c.inputSchema;
 // Retain existing explicit aliases without guessing any target or identity.
 if(args&&typeof args==='object'&&!Array.isArray(args))args={...args,...(args.group_id===undefined&&args.id!==undefined&&['qq_get_group_history','qq_get_group_members'].includes(name)?{group_id:args.id}:{}),...(args.user_id===undefined&&args.id!==undefined&&name==='qq_get_friend_history'?{user_id:args.id}:{}),...(name==='qq_send_sticker'?{target:args.target??(args.group_id?'group':args.user_id?'private':undefined),id:args.id??args.group_id??args.user_id,url:args.url??args.sticker}:{})};
 const bad=(path,message)=>{const e=Object.assign(new Error(`${name}.${path}: ${message}; 此次工具尚未执行`),{code:'TOOL_ARGUMENTS',transportInvoked:false,details:{tool:name,path}});throw e;};
 if(!args||typeof args!=='object'||Array.isArray(args))bad('args','需要对象');
 for(const key of schema.required)if(args[key]===undefined||args[key]===null||args[key]==='')bad(key,'缺少必需参数');
 if(['remember_note','anchor_recall'].includes(name)&&args.anchor!==undefined){try{normalizeAnchor(args.anchor);}catch(error){bad('anchor',`${error.message}; kind只能为self/entity/scene/process，格式是{kind,id}，不能猜对象`);}}
 for(const [key,v]of Object.entries(args)){const p=schema.properties[key];if(!p||v===undefined)continue;const types=Array.isArray(p.type)?p.type:[p.type];if(!types.includes(valueType(v)))bad(key,'类型应为'+types.join('/'));if(p.enum&&!p.enum.includes(v))bad(key,'不在允许值中');if(typeof v==='string'&&(p.maxLength&&v.length>p.maxLength||p.pattern&&!new RegExp(p.pattern).test(v)))bad(key,'文本长度或格式不符合要求');if(typeof v==='number'&&(p.minimum!==undefined&&v<p.minimum||p.maximum!==undefined&&v>p.maximum))bad(key,'超出允许范围');}
}
export function contractProjection(allowed,{task=false}={}){
 ensure(Array.isArray(allowed),'CAPABILITY_CONTRACT','explicit allowed tools required');
 return [...new Set(allowed)].map(id=>{const contract=toolContract(id);return contract?{id,authorized:true,entry:task?'task-step':'do',...contract}:{id,authorized:true,contractStatus:'unconfirmed',warning:'本工具未提供完整契约，不能凭名称猜参数。'};});
}
