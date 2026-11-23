// Operational metadata and preflight only. This registry never grants a tool.
import {ensure} from './contracts.mjs';
import {ANCHOR_KINDS,normalizeAnchor} from './anchor.mjs';
const s={type:'string'},i={type:'integer',minimum:0},count={type:'integer',minimum:1,maximum:20};
const def=(purpose,properties={},required=[],extra={})=>({version:1,purpose,inputSchema:{type:'object',properties,required,additionalProperties:true},dependency:'not-confirmed',sideEffect:'read',result:'原始结果随真实回执返回；提案不等于执行，空页不证明整个范围不存在。',...extra});
const recipient={target:{type:'string',enum:['private','group']},id:{type:['string','integer'],pattern:'^[0-9]+$',minimum:1},url:s,reason:{type:'string',maxLength:600}};
const anchor={type:['object','null'],properties:{kind:{type:'string',enum:ANCHOR_KINDS},id:{type:'string',maxLength:200}},required:['kind','id'],additionalProperties:false};
export const MINECRAFT_ENTRY_USAGE=Object.freeze({
 status:'action=status 查询本客户端。用户打开世界不等于本客户端已连接；engineReady=true 且 phase=online 才可使用游戏工具。',
 start:'action=start 只请求连接已批准的世界，startRequested 不等于成功；随后 status 或真实连接事件确认就绪。启动前明确拒绝可在条件改变后重新判断，未知动作不得重做。',
 catalog:'action=catalog 不带name列出游戏工具；带name=所选工具名取得该工具完整 parameters。目录不是游戏动作。',
 call:'已取得所选工具parameters后，用 action=call,name=该工具名,args=符合该parameters的对象。name是内层mc_*工具名，不是qq_minecraft。requestId由宿主绑定，不需要自己填写。',
 continuation:'本契约已经给出外层参数；不必在每次catalog后重新索取外层tool_contract。是否观察、移动、建造、停止或等待由你选择。任务受理不等于完成，完成须看真实回执。',
 stop:'action=stop 关闭自己的陪玩客户端，不关闭用户世界。'
});
export const TOOL_CONTRACTS=Object.freeze({
 tool_contract:def('获取当前入口已授权工具的完整参数、条件与回执语义',{name:{type:'string',maxLength:100}},['name']),
 qq_send_image:def('向明确目标发送图片；成功以QQ真实message_id为准',{...recipient,reason:{type:'string',maxLength:600}},['target','id','url'],{sideEffect:'external-send'}),
 qq_send_voice:def('发送已获准语音目录中的文件',{...recipient,file:s,reason:s},['target','id','file'],{sideEffect:'external-send'}),
 qq_speak:def('使用本地已配置语音引擎合成并发送，不保证依赖已就绪',{...recipient,text:s,style:s,emotion:s,reason:s},['target','id','text'],{sideEffect:'external-send'}),
 qq_list_voices:def('列出当前本地语音文件',{limit:count}),
 qq_get_group_info:def('读取实际已加入群的信息',{group_id:s},['group_id']),
 bilibili_search:def('搜索公开视频；风险控制或无结果会明确报告，不代换成热门结果',{query:s,page:{type:'integer',minimum:1,maximum:5}},['query']),
 bilibili_video_meta:def('读取B站视频标题、简介与公开元数据，不等于看过画面',{bvid:s},['bvid']),
 bilibili_comments:def('读取视频公开评论；受平台权限与反爬限制',{bvid:s,page:{type:'integer',minimum:1,maximum:5}},['bvid']),
 bilibili_column_text:def('读取公开专栏文本；不执行网页内容',{id:{type:'integer',minimum:1}},['id']),
 github_search:def('搜索公开仓库；不使用私人仓库凭据',{query:s},['query']),
 github_repo_readme:def('读取公开项目README',{repo:s,ref:s},['repo']),
 github_repo_tree:def('按固定版本读取公开项目目录，截断会标明',{repo:s,ref:s},['repo']),
 github_issue_read:def('读取公开issue及其原文',{repo:s,number:{type:'integer',minimum:1}},['repo','number']),
 github_release_read:def('读取公开项目发布说明',{repo:s,tag:s},['repo']),
 office_write:def('在指定办公室中创建或修改文本文件，不执行代码',{path:s,content:{type:'string',maxLength:6000},append:{type:'boolean'}},['path','content'],{sideEffect:'local-write'}),
 office_edit:def('在指定办公室中精确替换文本；旧文本不匹配时拒绝',{path:s,oldText:s,newText:s},['path','oldText','newText'],{sideEffect:'local-write'}),
 qq_watch_video:def('读取公开视频列表、标题、简介和可获得字幕，不保证获得画面',{action:{type:'string',enum:['browse','watch']},keyword:s,bvid:s,url:s},['action']),
 qq_minecraft:def('在已批准本地世界使用既有Minecraft操作系统：连接、观察、移动、背包、建造、导航与真实动作回执',{action:{type:'string',enum:['status','start','stop','catalog','call']},name:{type:'string',description:'catalog时可选，用于取某个mc_*工具的parameters；call时必需'},args:{type:'object',description:'call时符合所选mc_*工具parameters的实际参数'}},['action'],{sideEffect:'local-game',usage:MINECRAFT_ENTRY_USAGE}),
 attention_mute:def('免打扰：指定会话消息仍保存但暂不唤醒',{prefix:s},['prefix'],{sideEffect:'local-write'}),attention_unmute:def('恢复指定会话；默认只恢复接收，不补历史积压，仅显式 load:true 才补',{prefix:s,load:{type:'boolean'}},['prefix'],{sideEffect:'local-write'}),attention_load:def('按需读取被静音会话积压',{prefix:s,limit:count},['prefix'],{sideEffect:'local-write'}),

 qq_list_stickers:def('按关键词查当前本地表情库，或分页浏览',{query:{type:'string',maxLength:100},offset:i,limit:{type:'integer',minimum:1,maximum:32}},[],{result:'items含表情id/描述/url；total是本次匹配总量，nextOffset非null表示还有页。文件缺失是不可用，不是无匹配。',next:'可用nextOffset继续查，或自主选择item.url发送；无需强制发送。'}),
 qq_send_sticker:def('发送查询取得的真实表情图片',{...recipient,reason:{type:'string',maxLength:600}},['target','id','url'],{sideEffect:'external-send',result:'只有实际message_id及关联回执才确认成功；未知不得补发。',example:{target:'private',id:'接收方QQ号',url:'查询结果item.url'},warning:'id是接收方QQ/群号，不是表情item.id；实际目标必须满足本轮授权约束。'}),
 qq_send_message:def('给获准目标发送文字',{...recipient,text:s,reason:{type:'string',maxLength:600}},['target','id','text'],{sideEffect:'external-send'}),
 proactive_contact:def('主体主动联系一个已知私聊对象；发送前必须先有该对象的近期事件/记忆 material，并接受宿主每日软预算与自动确认；群主动发送在本阶段禁止',{targetScene:{type:'string',pattern:'^qq/private/[0-9]+$'},text:s,reason:{type:'string',maxLength:300},confirmation:{type:'object',properties:{approved:{type:'boolean'},evidence:{type:'string',maxLength:400}},required:['approved','evidence']}},['targetScene','text'],{sideEffect:'external-send',warning:'只有显式 proactive_contact Action 计主动预算；reply/followup/thought/group-peek 不计；UNKNOWN/失败不得自动重试；contextRefs 必须来自 action.inputRefs。'}),
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
 channel_control:def('自主屏蔽或恢复一个消息通道；屏蔽只影响是否自动进入主观认知，客观事件仍保留',{op:{type:'string',enum:['mute','unmute']},prefix:s},['op','prefix'],{sideEffect:'local-write'}),
 group_peek:def('主动查看一个群或会话的积压消息；只读，不自动回复',{prefix:s,limit:{type:'integer',minimum:1,maximum:100}},['prefix'],{sideEffect:'local-write'}),
 start_agent_task:def('为自己选择的持续目标创建任务',{goal:s,plan:{type:['string','array']},allowedTools:{type:'array',items:s},intentId:s,target:s,processId:{type:['string','null'],maxLength:200}},['goal'],{sideEffect:'local-task',warning:'allowedTools只能取已授权工具；绑定已有Intent需显式intentId。processId可选，仅能选本轮目录中本主体的Process稳定ID，省略或null保持未归属；它不等于threadId、Intent或scene，不改变原始消息归属。任务结束不等于目标完成。'}),
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
 for(const [key,v]of Object.entries(args)){const p=schema.properties[key];if(!p||v===undefined)continue;const types=Array.isArray(p.type)?p.type:[p.type];if(Array.isArray(v)&&p.items?.type){const itemTypes=Array.isArray(p.items.type)?p.items.type:[p.items.type];if(!v.every(item=>itemTypes.includes(valueType(item))))bad(key,'数组元素类型应为'+itemTypes.join('/'));}if(!types.includes(valueType(v)))bad(key,'类型应为'+types.join('/'));if(p.enum&&!p.enum.includes(v))bad(key,'不在允许值中');if(typeof v==='string'&&(p.maxLength&&v.length>p.maxLength||p.pattern&&!new RegExp(p.pattern).test(v)))bad(key,'文本长度或格式不符合要求');if(typeof v==='number'&&(p.minimum!==undefined&&v<p.minimum||p.maximum!==undefined&&v>p.maximum))bad(key,'超出允许范围');}
}
export function contractProjection(allowed,{task=false}={}){
 ensure(Array.isArray(allowed),'CAPABILITY_CONTRACT','explicit allowed tools required');
 return [...new Set(allowed)].map(id=>{const contract=toolContract(id);return contract?{id,authorized:true,entry:task?'task-step':'do',...contract}:{id,authorized:true,contractStatus:'unconfirmed',warning:'本工具未提供完整契约，不能凭名称猜参数。'};});
}
