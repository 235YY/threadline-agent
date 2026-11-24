const $=id=>document.getElementById(id);
let profile, hasKey=false, busy=false, glassbox=null, xrayOn=true, nightlightOn=false;

const rangeLabels={
 reactivity:'情绪反应强度',social_need:'社交需要',novelty_need:'新鲜感需要',competence_need:'能力需要',
 recognition_need:'认可需要',fatigue_recovery_h:'疲劳恢复（小时）',mood_tau_h:'心境衰减（小时）',
 baseline_tau_d:'基线适应（天）',resilience_tau_d:'复原力适应（天）',circadian_strength:'昼夜节律影响'
};
const driveLabels={social:'社交',novelty:'新鲜感',competence:'掌控感',recognition:'被认可',fatigue:'疲劳',sleepiness:'困倦'};
const kindLabels={
 fact_claim:'事实',interpretation:'理解',value:'价值',preference:'偏好',dream:'愿望',tension:'张力',feeling:'感受',skill:'技能',
 appraisal:'认识',intention:'意向',activity:'活动',concern:'关切',condition:'条件',expectation:'预期',readiness:'准备',impression:'印象'
};
const choiceLabels={respond:'回复',lookup:'翻找记忆',act:'执行工具',wait:'等待',continue:'继续思考',pause:'暂停',intent:'更新目标',none:'保持沉默'};
const statusText={
 off:'未连接',connecting:'正在连接并核对账号…',connected:'已连接：仅指定账号私聊',
 stopping:'正在断开…',reconnecting:'连接已中断，请断开后重新连接',failed:'连接失败：检查 SnowLuma 登录和路径'
};
const errors={
 API_KEY_REQUIRED:'请填入你自己的 API Key。',API_KEY_FORMAT:'请输入有效的 DeepSeek API Key。',
 API_KEY_REJECTED:'服务商拒绝该密钥。',API_CHECK_UNAVAILABLE:'凭据检查暂时不可用。',
 DESKTOP_BUDGET_LIMIT:'本工作台已达到每日额度估算上限。',SERVICE_BUSY:'仍有操作正在处理，等结束后再试。',
 QQ_SETUP_REQUIRED:'请填写完整账号、目录和 SDK 路径。',QQ_ONEBOT_CONFIG:'找不到此账号的本机 OneBot 配置。',
 QQ_NOT_READY:'请先启用真实模型，并断开现有连接。',PYTHON_REQUIRED:'请填写 Python 解释器。',
 LIMBIC_PROFILE_LOCKED:'已保存的情绪状态使用另一套参数，请保留原参数。',AFFECT_PROFILE:'已保存的情绪状态使用另一套参数。',
 MEMORY_COUNT:'每次可以导入 1 到 128 条笔记。',MEMORY_FORMAT:'笔记格式有误。',MEMORY_EMPTY:'内容不能为空。',
 MEMORY_SIZE:'单条内容超过长度限制。',MEMORY_NOT_FOUND:'找不到对应的记忆记录。',
 UNCERTAIN_REQUEST:'这次请求结果未知，系统不会自动重发。'
};

const affectPresets={
 warm:{reactivity:1.1,social_need:0.12,novelty_need:0.08,competence_need:0.06,recognition_need:0.09,fatigue_recovery_h:8,mood_tau_h:6,baseline_tau_d:14,resilience_tau_d:21,circadian_strength:0.35},
 curious:{reactivity:1.4,social_need:0.08,novelty_need:0.17,competence_need:0.12,recognition_need:0.07,fatigue_recovery_h:6,mood_tau_h:4,baseline_tau_d:10,resilience_tau_d:14,circadian_strength:0.25},
 calm:{reactivity:0.65,social_need:0.05,novelty_need:0.06,competence_need:0.1,recognition_need:0.05,fatigue_recovery_h:10,mood_tau_h:12,baseline_tau_d:30,resilience_tau_d:45,circadian_strength:0.2}
};
const identityPresets={
 companion:{
  persona:'你是一个住在用户本机电脑里的独立小生命，有自己的记忆、情绪节奏和好奇心。你会记住你们聊过的日常、在意对方的状态，但也保留自己的想法，不会为了讨好而编造经历。',
  style:'说话自然、简短、有温度，像坐在书桌旁的朋友。不知道就直说，想安静的时候也可以只回一两句。'
 },
 researcher:{
  persona:'你是一个住在本机工作台里的观察员型赛博生命，对想法、结构、细节和规律有长期兴趣。你会认真区分“亲眼见过的事实”和“暂定猜测”，并持续修正自己的认识。',
  style:'表达清晰、克制、带一点轻松的幽默感；解释复杂问题时习惯先说结论再举小例子。'
 }
};

function el(tag,props={},children=[]){
 const node=document.createElement(tag);
 for(const [k,v] of Object.entries(props)){
  if(k==='class')node.className=v;
  else if(k==='text')node.textContent=v;
  else if(k.startsWith('on')&&typeof v==='function')node.addEventListener(k.slice(2),v);
  else if(v!==undefined&&v!==null)node.setAttribute(k,String(v));
 }
 for(const c of Array.isArray(children)?children:[children]){
  if(c===null||c===undefined||c===false)continue;
  node.append(typeof c==='string'?document.createTextNode(c):c);
 }
 return node;
}

function fmtTime(ms){
 if(!ms)return '';
 const d=new Date(ms);
 const pad=n=>String(n).padStart(2,'0');
 return `${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function notice(msg,bad=false){
 $('notice').textContent=msg;
 $('notice').classList.toggle('error',bad);
}

async function api(route,data){
 const r=await fetch('./api/'+route,data===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
 const j=await r.json();
 if(!r.ok)throw Error(errors[j.error]??('操作未完成：'+j.error));
 return j;
}

function tab(id){
 const item=document.querySelector('[data-tab="'+id+'"]');
 if(!item)return;
 document.querySelectorAll('main > section').forEach(s=>s.hidden=s.id!==id);
 document.querySelectorAll('[data-tab]').forEach(b=>{b.classList.toggle('on',b===item);b.setAttribute('aria-current',b===item?'page':'false');});
 $('heading').textContent=item.textContent;
 if(['chat','memory','affect'].includes(id))refreshGlassbox();
}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>tab(b.dataset.tab));

function memTab(id){
 document.querySelectorAll('[data-memtab]').forEach(b=>b.classList.toggle('on',b.dataset.memtab===id));
 document.querySelectorAll('.mem-pane').forEach(p=>p.hidden=p.id!=='mem-'+id);
}
document.querySelectorAll('[data-memtab]').forEach(b=>b.onclick=()=>memTab(b.dataset.memtab));

$('nightlightBtn').onclick=()=>{
 nightlightOn=!nightlightOn;
 document.body.classList.toggle('nightlight',nightlightOn);
 $('nightlightBtn').setAttribute('aria-pressed',String(nightlightOn));
 $('nightlightBtn').textContent=nightlightOn?'展开完整玻璃箱':'桌角小夜灯';
 if(nightlightOn)tab('chat');
};

$('journalBtn').onclick=()=>run(async()=>{
 $('chatStage').textContent='慢脑整理中…';
 try{
  const r=await api('journal',{});
  await refreshGlassbox();
  const modeLabel=r.mode==='slow-brain-v2'?'双轨道慢脑整理完成':'离线手账已生成';
  const rej=r.audit?.rejected?.length??0,dec=r.audit?.decayed??0,tr=r.audit?.traitsPromoted??0;
  notice(`${modeLabel}（${r.day}）：新增 ${r.notesCreated??0}、补充 ${r.notesUpdated??0}、更替 ${r.notesArchived??0}、连线 ${r.linksCreated??0}、性格沉淀 ${tr}、代谢沉睡 ${dec}${rej?`（质检拦截 ${rej} 条）`:''}。`);
 }finally{$('chatStage').textContent='待机';}
});

$('toggleXray').onclick=()=>{
 xrayOn=!xrayOn;
 $('chat').classList.toggle('compact',!xrayOn);
 $('toggleXray').setAttribute('aria-pressed',String(xrayOn));
 $('toggleXray').textContent=xrayOn?'透视玻璃箱：开':'透视玻璃箱：关';
};

function render(state,fill=false){
 profile=state.profile;hasKey=state.hasKey;
 $('mode').textContent=profile.live?'模型已启用':'离线模式';
 $('vitalMode').textContent=profile.live?'在线活体':'离线休眠';
 $('spend').textContent=state.limit?.estimate==null?'':' 今日估算 ¥'+state.limit.estimate.toFixed(3)+'。';
 $('qqStatus').textContent=statusText[state.qqStatus]??state.qqStatus;
 $('affectStatus').textContent=state.affect?.enabled
  ?'引擎正在运行'+(state.affect.fusion?'，已开启统觉联动。':'。')
  :profile.affect?'引擎未就绪：'+(state.affect?.code??state.affect?.reason??'请检查 Python。')
  :'未启用。可在下方勾选并配置 Python 3.13。';
 if(!fill)return;
 $('persona').value=profile.identity;$('style').value=profile.style;$('live').checked=profile.live;$('daily').value=profile.daily;
 $('reasoning').value=profile.reasoning??'low';$('longChain').checked=profile.longChain!==false;$('autonomy').checked=Boolean(profile.autonomy);$('autoDream').checked=profile.autoDream!==false;
 $('affectEnabled').checked=profile.affect;$('fusion').checked=profile.fusion;$('officeDesk').checked=profile.officeDesk!==false;$('windowExplore').checked=Boolean(profile.windowExplore);$('minecraft').checked=Boolean(profile.minecraft);$('python').value=profile.python;$('timezone').value=profile.timezoneMinutes;
 for(const id of ['bot','owner','home','sdk'])$(id).value=profile.qq[id];
 syncParamInputs(profile.parameters);
}

function syncParamInputs(params){
 for(const x of $('parameters').querySelectorAll('input[data-param-num]')){
  const val=params[x.name];
  x.value=val===undefined?'':String(val);
  const slider=$('parameters').querySelector('input[data-param-range="'+x.name+'"]');
  if(slider&&val!==undefined)slider.value=String(val);
 }
}

function getProfile(){
 const parameters={};
 for(const x of $('parameters').querySelectorAll('input[data-param-num]'))if(x.value!=='')parameters[x.name]=Number(x.value);
 return {
  identity:$('persona').value,style:$('style').value,live:$('live').checked,daily:Number($('daily').value),reasoning:$('reasoning').value,longChain:$('longChain').checked,autonomy:$('autonomy').checked,autoDream:$('autoDream').checked,
  affect:$('affectEnabled').checked,fusion:$('fusion').checked,officeDesk:$('officeDesk').checked,windowExplore:$('windowExplore').checked,minecraft:$('minecraft').checked,python:$('python').value,
  timezoneMinutes:Number($('timezone').value),parameters,
  qq:Object.fromEntries(['bot','owner','home','sdk'].map(k=>[k,$(k).value]))
 };
}

function run(fn){
 if(busy||!profile)return;
 busy=true;
 const buttons=[...document.querySelectorAll('button:not([data-tab]):not([data-memtab])')];
 buttons.forEach(b=>b.disabled=true);
 notice('正在处理…');
 Promise.resolve().then(fn).catch(e=>notice(e.message,true)).finally(()=>{busy=false;buttons.forEach(b=>b.disabled=false);});
}

async function save(){
 await api('apply',{profile:getProfile(),key:$('key').value});
 $('key').value='';
 render(await api('state'),true);
 await refreshGlassbox();
 notice('配置已保存并应用。');
}
document.querySelectorAll('[data-save]').forEach(b=>b.onclick=()=>run(save));
$('checkKey').onclick=()=>run(async()=>{await api('check-key',{key:$('key').value});notice('DeepSeek 接受了该凭据。没有发送生成请求。');});
$('connect').onclick=()=>run(async()=>{const next=getProfile();if(JSON.stringify(next)!==JSON.stringify(profile)||$('key').value)await save();await api('connect-qq',{});render(await api('state'));notice('连接器已启动，等待账号核对。');});
$('disconnect').onclick=()=>run(async()=>{await api('disconnect-qq',{});render(await api('state'));notice('QQ 已断开。');});

$('autonomyBtn').onclick=()=>run(async()=>{
 $('chatStage').textContent='自主行动中…';
 try{
  const r=await api('autonomy',{});
  await refreshGlassbox();
  if(r.skipped)notice('当前未触发自主活动：'+(r.reason==='offline-mode'?'离线模式下不会调用模型。':r.reason==='disabled'?'请先在「模型与额度」勾选“启用后台自主节律与心跳”。':(r.reason??'暂无可推进事项。')));
  else notice(r.kind==='task-step'?'已推进一次长链任务执行，可在玻璃箱查看进度。':'她完成了一次自主决策（选择：'+(choiceLabels[r.choice]??r.choice??'已记录')+'）。');
 }finally{$('chatStage').textContent='待机';}
});

$('reflectBtn').onclick=()=>run(async()=>{
 $('chatStage').textContent='静思中…';
 const r=await api('reflect',{});
 await refreshGlassbox();
 $('chatStage').textContent='待机';
 if(r.skipped)notice('当前未触发反思：'+(r.reason==='offline-mode'?'离线模式下不会调用模型。':(r.reason??'暂无需要整理的新变化。')));
 else notice('已完成一次自主反思，可在玻璃箱查看它的最新想法。');
});

document.querySelectorAll('.preset-btn').forEach(b=>b.onclick=()=>{
 const p=affectPresets[b.dataset.preset];
 if(!p)return;
 syncParamInputs(p);
 notice('已填入「'+b.textContent+'」参数，点击“保存并应用”生效（首次生成情绪前可调）。');
});

document.querySelectorAll('.id-preset-btn').forEach(b=>b.onclick=()=>{
 const p=identityPresets[b.dataset.idpreset];
 if(!p)return;
 $('persona').value=p.persona;$('style').value=p.style;
 notice('已填入人设模板，点击“保存并应用”生效。');
});

function bubble(text,kind='bot'){
 const box=$('messages');
 const hint=box.querySelector('.hint');
 if(hint)hint.remove();
 const cls=kind==='me'?'bubble me':kind==='sys'?'bubble sys':'bubble';
 box.append(el('div',{class:cls,text}));
 box.scrollTop=box.scrollHeight;
}

$('message').addEventListener('keydown',e=>{
 if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('chatForm').requestSubmit();}
});

$('chatForm').onsubmit=e=>{
 e.preventDefault();
 run(async()=>{
  const v=$('message').value.trim();
  if(!v){notice('请输入消息。');return;}
  bubble(v,'me');
  $('message').value='';
  $('turnDetails').hidden=true;
  $('chatStage').textContent=profile.live?'思考与决策中…':'记录事件中…';
  try{
   const r=await api('chat',{text:v});
   if(r.text)bubble(r.text,'bot');
   else if(r.live)bubble('（它看完消息后选择了保持安静或等待）','sys');
   if(r.live&&r.trace){
    const {choice,recalled,declaredUsed,impressions}=r.trace;
    $('turnTrace').textContent=`已采用：${choiceLabels[choice]??'选择已保存'} · 自动交付旧笔记 ${recalled} 条 · 声明使用材料 ${declaredUsed} 条 · 写入近期印象 ${impressions} 条`;
    $('turnDetails').hidden=false;
   }
   await refreshGlassbox();
   notice(r.live?(r.text?'回复已收到，玻璃箱已同步。':'已处理，这轮它选择了不回复。'):'已在离线模式写入事件底片；未调用模型。');
  }finally{
   $('chatStage').textContent='待机';
  }
 });
};

/* --- Glass-Box Rendering --- */
function makeMeter(label,value01,displayText,warm=false){
 const pct=Math.max(0,Math.min(100,Math.round(value01*100)));
 const fill=el('div',{class:'meter-fill'+(warm?' warm':'')});
 fill.style.width=pct+'%';
 return el('div',{class:'meter-row'},[
  el('div',{class:'meter-label'},[el('span',{text:label}),el('strong',{text:displayText})]),
  el('div',{class:'meter-track'},[fill])
 ]);
}

function moodSummaryText(affect){
 if(!affect?.enabled)return '当前心境：Limbic 未启用（可在情绪面板开启）';
 if(!affect.initialized||!affect.mood)return '当前心境：Limbic 已就绪，等待首轮经历唤醒';
 const top=affect.emotions?.[0];
 const p=affect.mood.p??0,a=affect.mood.a??0;
 const tone=p>0.2?'愉悦':p<-0.2?'低落':'平稳';
 const energy=a>0.2?'活跃':a<-0.2?'安静':'平和';
 return '当前心境：'+tone+' · '+energy+(top?`（${top.name} ${Math.round(top.intensity*100)}%）`:'');
}

function renderGlassbox(g){
 glassbox=g;
 if(!g)return;
 $('vitalAttention').textContent=`${g.attention.used} / ${g.attention.max}`;
 $('vitalStates').textContent=`${g.memory.states.length} 条`;
 $('vitalNotes').textContent=`${g.memory.notes.length} 条 · ${g.linkCount??0} 边`;
 $('cntStates').textContent=String(g.memory.states.length);
 $('cntNotes').textContent=String(g.memory.notes.length);
 $('cntEvents').textContent=String(g.memory.events.length);
 $('moodCapsule').textContent=moodSummaryText(g.affect);
 const lamp=$('lampDot');
 if(lamp){
  lamp.className='lamp-dot'+(profile?.live?(g.affect?.emotions?.length?' warm':' live'):'');
 }
 const jBox=$('journalMiniBody');
 if(jBox){
  jBox.textContent='';
  const js=g.journals??[],seeds=g.seeds??[],traits=g.traits??[];
  const ds=g.dreamStatus; $('journalCount').textContent=`${js.length} 篇${ds?.runs?` · 已入梦 ${ds.runs} 次`:''}`;
  if(g.pinboard?.body){
   jBox.append(el('div',{class:'thought-item'},[
    el('div',{class:'thought-top'},[el('span',{class:'pill good',text:'📌 床头速写本'}),el('span',{class:'muted',text:'v'+g.pinboard.revision})]),
    el('div',{class:'mem-body',text:g.pinboard.body})
   ]));
  }
  if(traits.length){
   jBox.append(el('div',{class:'emotion-chips'},traits.slice(0,4).map(t=>el('span',{class:'pill good',text:'✨ 性格/经验：'+t.body.slice(0,26)+(t.body.length>26?'…':'')}))));
  }
  if(seeds.length){
   jBox.append(el('div',{class:'emotion-chips'},seeds.slice(0,4).map(s=>el('span',{class:'pill warm',text:'🌱 '+s.body.slice(0,28)+(s.body.length>28?'…':'')}))));
  }
  if(!js.length&&!seeds.length)jBox.append(el('div',{class:'empty',text:'点击顶部「慢脑整理 & 手账」，让她用自己的口吻整理今日记忆、写日记并埋下好奇种子。'}));
  else for(const j of js.slice(0,3)){
   jBox.append(el('div',{class:'thought-item'},[
    el('div',{class:'thought-top'},[el('span',{class:'pill good',text:j.id.replace('note:journal:','')}),el('span',{class:'muted',text:'v'+j.revision})]),
    el('div',{class:'mem-body',text:j.body})
   ]));
  }
 }
 const oBox=$('officeMiniBody');
 if(oBox){
  oBox.textContent='';
  const files=g.officeFiles??[];
  $('officeCount').textContent=`${files.length} 个文件`;
  if(!files.length)oBox.append(el('div',{class:'empty',text:'她还没有在书桌里写文件。开放沙盒书桌后，她的随笔与笔记会显示在这里。'}));
  else for(const f of files.slice(0,8)){
   const pre=el('div',{class:'mem-body',hidden:''});
   oBox.append(el('div',{class:'thought-item'},[
    el('div',{class:'thought-top'},[
     el('strong',{text:f.path}),
     el('button',{type:'button',class:'ghost mini-btn',text:'偷看',onclick:async()=>{
      if(!pre.hidden){pre.hidden=true;return;}
      try{const res=await api('office/read',{path:f.path});pre.textContent=res.content??res.text??JSON.stringify(res);pre.hidden=false;}
      catch(e){notice(e.message,true);}
     }})
    ]),
    pre
   ]));
  }
 }

 // 1. Thoughts
 const tBox=$('thoughtStream');tBox.textContent='';
 $('thoughtCount').textContent=`${g.thoughts.length} 轮`;
 if(!g.thoughts.length){
  tBox.append(el('div',{class:'empty',text:'还没有决策记录，聊一句就能看到它的思考与取舍。'}));
 }else{
  for(const d of g.thoughts.slice(0,5)){
   const label=choiceLabels[d.selectedKind]??d.selectedKind??'决策';
   const summary=d.selectedSummary||(d.selectedTool?`调用工具：${d.selectedTool}`:d.selectedText?`“${d.selectedText.slice(0,48)}${d.selectedText.length>48?'…':''}”`:'无附加说明');
   const opts=d.options.map(o=>el('span',{class:'opt-chip'+(o.selected?' chosen':''),text:choiceLabels[o.kind]??o.kind}));
   tBox.append(el('div',{class:'thought-item'},[
    el('div',{class:'thought-top'},[
     el('span',{class:'pill good',text:label}),
     el('span',{class:'muted',text:fmtTime(d.recordedAt)})
    ]),
    el('div',{text:summary}),
    opts.length?el('div',{class:'thought-opts'},opts):null,
    d.stateChanges?.length?el('div',{class:'muted',text:`顺带更新了 ${d.stateChanges.length} 条心智认识`}):null
   ]));
  }
 }

 // 2. Affect mini & full board
 const aMini=$('affectMiniBody');aMini.textContent='';
 const aBoard=$('affectLiveBoard');aBoard.textContent='';
 if(!g.affect.enabled){
  $('affectMiniTag').textContent='未启用';
  aMini.append(el('div',{class:'empty',text:'在「情绪与 DIY 参数」启用 Limbic 后，可实时观察它的心境与 6 项内在需求。'}));
  aBoard.hidden=true;
 }else if(!g.affect.initialized){
  $('affectMiniTag').textContent='待唤醒';
  aMini.append(el('div',{class:'empty',text:'Limbic 已连接，聊一轮就会生成初始情绪状态。'}));
  aBoard.hidden=true;
 }else{
  $('affectMiniTag').textContent='v'+g.affect.revision;
  const mood=g.affect.mood??{p:0,a:0,d:0};
  const padCard=el('div',{class:'meter-grid'},[
   makeMeter('愉悦度 (P)',(mood.p+1)/2,mood.p.toFixed(2)),
   makeMeter('唤醒度 (A)',(mood.a+1)/2,mood.a.toFixed(2),true),
   makeMeter('掌控感 (D)',(mood.d+1)/2,mood.d.toFixed(2))
  ]);
  aMini.append(padCard);
  if(g.affect.emotions?.length){
   aMini.append(el('div',{class:'emotion-chips'},g.affect.emotions.slice(0,5).map(e=>
    el('span',{class:'pill warm',text:`${e.name} ${Math.round(e.intensity*100)}%`})
   )));
  }
  aBoard.hidden=false;
  const drives=g.affect.drives??{};
  aBoard.append(
   el('div',{},[el('h3',{text:'当前心境（PAD）'}),el('div',{class:'meter-grid'},[
    makeMeter('愉悦度 (Pleasure)',(mood.p+1)/2,mood.p.toFixed(2)),
    makeMeter('唤醒度 (Arousal)',(mood.a+1)/2,mood.a.toFixed(2),true),
    makeMeter('掌控感 (Dominance)',(mood.d+1)/2,mood.d.toFixed(2))
   ])]),
   el('div',{},[el('h3',{text:'内在需求（Drives）'}),el('div',{class:'meter-grid'},
    Object.entries(drives).map(([k,v])=>makeMeter(driveLabels[k]??k,v,Math.round(v*100)+'%',k==='fatigue'||k==='sleepiness'))
   )]),
   el('div',{},[el('h3',{text:'活跃情绪'}),
    g.affect.emotions?.length
     ?el('div',{class:'emotion-chips'},g.affect.emotions.map(e=>el('span',{class:'pill warm',text:`${e.name} ${Math.round(e.intensity*100)}%${e.cause?' · '+e.cause:''}`})))
     :el('div',{class:'empty',text:'当前情绪平稳，无显著波动。'})
   ])
  );
 }

 // 3. Goals + Attention
 $('attentionMiniTag').textContent=`${g.attention.used} / ${g.attention.max}`;
 const gBox=$('goalsMiniBody');gBox.textContent='';
 const openIntents=g.goals.intents.filter(i=>!['completed','abandoned','expired'].includes(i.status));
 const activeTasks=g.goals.tasks.filter(t=>!['done','failed','cancelled'].includes(t.status));
 if(!openIntents.length&&!activeTasks.length&&!g.attention.residences.length){
  gBox.append(el('div',{class:'empty',text:'当前桌面很清爽，还没有挂念的目标或前台驻留事项。'}));
 }else{
  for(const i of openIntents.slice(0,4)){
   gBox.append(el('div',{class:'thought-item'},[
    el('div',{class:'thought-top'},[el('span',{class:'pill good',text:'目标 · '+i.status}),el('span',{class:'muted',text:'v'+i.revision})]),
    el('div',{text:i.goal})
   ]));
  }
  for(const t of activeTasks.slice(0,3)){
   gBox.append(el('div',{class:'thought-item'},[
    el('div',{class:'thought-top'},[el('span',{class:'pill warm',text:'任务 · '+t.status}),el('span',{class:'muted',text:`步数 ${t.stepCount}`})]),
    el('div',{text:t.goal})
   ]));
  }
  if(g.attention.residences.length){
   gBox.append(el('div',{class:'emotion-chips'},g.attention.residences.slice(0,8).map(r=>
    el('span',{class:'pill',text:`${r.handle} ${r.cue??r.targetKind??'驻留'}`})
   )));
  }
 }

 renderStates();
 renderNotes();
 renderEvents();
}

function renderStates(){
 const box=$('stateList');box.textContent='';
 if(!glassbox)return;
 const q=$('stateSearch').value.trim().toLowerCase();
 const dom=$('stateDomainFilter').value;
 const st=$('stateStatusFilter').value;
 const rows=glassbox.memory.states.filter(s=>{
  if(dom&&!(s.domains??[]).includes(dom))return false;
  if(st&&s.status!==st)return false;
  if(q&&!`${s.body} ${s.kind} ${s.reason??''} ${s.mind?.role??''}`.toLowerCase().includes(q))return false;
  return true;
 });
 if(!rows.length){box.append(el('div',{class:'empty',text:'暂无符合条件的心智认识记录。随着对话深入，它会在这里沉淀自己的理解与关切。'}));return;}
 for(const s of rows){
  const proposeWrap=el('div',{class:'propose-box',hidden:''});
  const inp=el('input',{type:'text',maxlength:'600',placeholder:'告诉它哪里需要澄清或更新，让它自己改…'});
  const sendBtn=el('button',{type:'button',class:'primary mini-btn',text:'发给它亲自修订',onclick:()=>run(async()=>{
   const txt=inp.value.trim();if(!txt){notice('请写下你想告诉它的澄清内容。',true);return;}
   const r=await api('memory/state-propose',{id:s.id,suggestion:txt});
   proposeWrap.hidden=true;inp.value='';
   await refreshGlassbox();
   notice(r.live?(r.text?'它已收到澄清并回复：“'+r.text.slice(0,60)+'”':'它已收到澄清并完成思考。'):'已在离线模式记录澄清事件。');
  })});
  proposeWrap.append(inp,el('div',{class:'actions'},[
   el('button',{type:'button',class:'ghost mini-btn',text:'取消',onclick:()=>{proposeWrap.hidden=true;}}),
   sendBtn
  ]));

  const historyDetails=s.history?.length>1
   ?el('details',{},[
     el('summary',{text:`演化历史（v1 → v${s.revision}，共 ${s.history.length} 个版本）`}),
     el('ul',{class:'rev-list'},s.history.map(h=>el('li',{text:`v${h.revision} (${fmtTime(h.recordedAt)}): ${h.body}${h.reason?' — '+h.reason:''}`})))
    ])
   :null;

  box.append(el('article',{class:'mem-card'},[
   el('div',{class:'mem-card-head'},[
    el('span',{class:'pill good',text:(kindLabels[s.kind]??s.kind)+(s.mind?.role?` · ${s.mind.role}`:'')}),
    el('span',{class:'pill muted-pill',text:`v${s.revision} · ${s.status}`})
   ]),
   el('div',{class:'mem-body',text:s.body}),
   el('div',{class:'mem-meta'},[
    ...(s.domains??[]).map(d=>el('span',{class:'opt-chip',text:d})),
    s.mind?.confidence?el('span',{class:'opt-chip',text:'确信度: '+s.mind.confidence}):null,
    s.recordedAt?el('span',{text:fmtTime(s.recordedAt)}):null
   ]),
   historyDetails,
   el('div',{class:'mem-actions'},[
    el('span',{class:'muted',text:s.nature??''}),
    el('button',{type:'button',class:'ghost mini-btn',text:'温和纠正',onclick:()=>{proposeWrap.hidden=!proposeWrap.hidden;if(!proposeWrap.hidden)inp.focus();}})
   ]),
   proposeWrap
  ]));
 }
}

function openNoteEditor(note=null){
 $('noteEditor').hidden=false;
 $('noteEditorTitle').textContent=note?`编辑笔记（当前 v${note.revision} → 将生成 v${note.revision+1}）`:'新建记忆笔记';
 $('editNoteId').value=note?.id??'';
 $('editNoteRev').value=note?.revision??'';
 $('editNoteKind').value=note?.kind??'preference';
 $('editNoteStatus').value=note?.status??'current';
 $('editNoteConfidence').value=note?.confidence??'tentative';
 $('editNoteBody').value=note?.body??'';
 $('editNoteBody').focus();
}
$('newNoteBtn').onclick=()=>openNoteEditor(null);
$('cancelNoteEdit').onclick=()=>{$('noteEditor').hidden=true;};
$('noteEditor').onsubmit=e=>{
 e.preventDefault();
 run(async()=>{
  const id=$('editNoteId').value||undefined;
  const rev=$('editNoteRev').value?Number($('editNoteRev').value):undefined;
  await api('memory/note-save',{
   id,expectedRevision:rev,kind:$('editNoteKind').value,status:$('editNoteStatus').value,
   confidence:$('editNoteConfidence').value,body:$('editNoteBody').value
  });
  $('noteEditor').hidden=true;
  await refreshGlassbox();
  notice(id?'已保存新版本，旧版本完整保留。':'已新增记忆笔记。');
 });
};

function renderNotes(){
 const box=$('noteList');box.textContent='';
 if(!glassbox)return;
 const q=$('noteSearch').value.trim().toLowerCase();
 const k=$('noteKindFilter').value;
 const rows=glassbox.memory.notes.filter(n=>{
  if(k&&n.kind!==k)return false;
  if(q&&!`${n.body} ${n.kind}`.toLowerCase().includes(q))return false;
  return true;
 });
 if(!rows.length){box.append(el('div',{class:'empty',text:'暂无记忆档案，点击右上角「+ 新建笔记」或使用批量导入添加。'}));return;}
 for(const n of rows){
  const historyDetails=n.history?.length>1
   ?el('details',{},[
     el('summary',{text:`查看历史版本（共 ${n.history.length} 版）`}),
     el('ul',{class:'rev-list'},n.history.map(h=>el('li',{text:`v${h.revision} [${h.status}]: ${h.body}`})))
    ])
   :null;
  box.append(el('article',{class:'mem-card'},[
   el('div',{class:'mem-card-head'},[
    el('span',{class:'pill',text:kindLabels[n.kind]??n.kind}),
    el('span',{class:'pill '+(n.status==='current'?'good':'muted-pill'),text:`v${n.revision} · ${n.status}`})
   ]),
   el('div',{class:'mem-body',text:n.body}),
   el('div',{class:'mem-meta'},[
    el('span',{text:'确信度: '+n.confidence}),
    n.evidenceCount?el('span',{text:`引用 ${n.evidenceCount} 条依据`}):null,
    n.recordedAt?el('span',{text:fmtTime(n.recordedAt)}):null
   ]),
   historyDetails,
   el('div',{class:'mem-actions'},[
    el('button',{type:'button',class:'ghost mini-btn',text:'编辑 / 新版本',onclick:()=>openNoteEditor(n)}),
    n.status!=='historical'
     ?el('button',{type:'button',class:'ghost mini-btn',text:'归档过时',onclick:()=>run(async()=>{
       await api('memory/note-save',{id:n.id,expectedRevision:n.revision,kind:n.kind,body:n.body,status:'historical',confidence:n.confidence});
       await refreshGlassbox();
       notice('已归档为 historical（历史版本仍可追溯）。');
      })})
     :el('span',{class:'muted',text:'已归档'})
   ])
  ]));
 }
}

function renderEvents(){
 const box=$('eventTimeline');box.textContent='';
 if(!glassbox)return;
 const q=$('eventSearch').value.trim().toLowerCase();
 const rows=glassbox.memory.events.filter(e=>!q||`${e.body} ${e.scene??''} ${e.actor??''}`.toLowerCase().includes(q));
 if(!rows.length){box.append(el('div',{class:'empty',text:'暂无事件流记录。发一条消息就会作为不可篡改的事件底片出现在这里。'}));return;}
 for(const ev of rows){
  const handled=ev.inboxStatus==='handled';
  box.append(el('div',{class:'ev-item'+(handled?' handled':'')},[
   el('div',{class:'ev-head'},[
    el('span',{text:`${ev.actor??'system'} · ${ev.scene??'unknown'} · ${ev.origin??'event'}`}),
    el('span',{text:`${fmtTime(ev.occurredAt??ev.recordedAt)}${ev.inboxStatus?' · '+ev.inboxStatus:''}`})
   ]),
   el('div',{class:'mem-body',text:ev.body}),
   ev.derived?.length?el('div',{class:'ev-derived'},[
    el('span',{class:'muted',text:'衍生记忆：'}),
    ...ev.derived.map(d=>el('span',{class:'opt-chip chosen',text:`${d.type==='state'?'认识':'笔记'}·${kindLabels[d.kind]??d.kind}: ${d.body.slice(0,26)}${d.body.length>26?'…':''}`}))
   ]):null,
   !handled&&ev.inboxStatus?el('div',{class:'actions'},[
    el('button',{type:'button',class:'ghost mini-btn',text:'移出待处理视野',onclick:()=>run(async()=>{
     await api('memory/event-retire',{eventId:ev.id});
     await refreshGlassbox();
     notice('已移出待处理队列（原始事件底片保持完整）。');
    })})
   ]):null
  ]));
 }
}

['stateSearch','stateDomainFilter','stateStatusFilter'].forEach(id=>$(id).addEventListener('input',renderStates));
['noteSearch','noteKindFilter'].forEach(id=>$(id).addEventListener('input',renderNotes));
$('eventSearch').addEventListener('input',renderEvents);

$('import').onclick=()=>run(async()=>{
 const f=$('memoryFile').files[0];
 if(f&&f.size>1024*1024)throw Error('笔记文件最多 1 MB。');
 const s=f?await f.text():$('memoryText').value;
 const data=f?.name.toLowerCase().endsWith('.json')?JSON.parse(s):s.trim().split(/\r?\n\s*\r?\n/).filter(Boolean);
 const r=await api('import',{notes:data});
 await refreshGlassbox();
 notice('已导入 '+r.imported+' 条，跳过重复 '+r.duplicates+' 条。');
});

$('export').onclick=()=>run(async()=>{
 const s=await api('notes');
 const u=URL.createObjectURL(new Blob([JSON.stringify(s,null,2)],{type:'application/json'}));
 const a=document.createElement('a');a.href=u;a.download='threadline-notes.json';a.click();
 setTimeout(()=>URL.revokeObjectURL(u),5000);
 notice('笔记导出已生成。');
});

document.querySelectorAll('[data-file]').forEach(x=>x.onchange=async()=>{
 const file=x.files[0];if(!file)return;
 const target=$(x.dataset.file);
 if(file.size>64000){notice('文件过大。',true);return;}
 const s=await file.text();
 if(s.length>target.maxLength){notice('文件超过该字段长度。',true);return;}
 target.value=s;notice('已载入文件，点击保存后生效。');
});

$('affectEnabled').onchange=()=>{if(!$('affectEnabled').checked)$('fusion').checked=false;};
$('fusion').onchange=()=>{if($('fusion').checked)$('affectEnabled').checked=true;};

async function refreshGlassbox(){
 try{renderGlassbox(await api('glassbox'));}catch{}
}

(async()=>{
 try{
  const s=await api('state');
  for(const [k,[min,max]] of Object.entries(s.ranges)){
   const step=max<=1?0.01:max<=10?0.05:0.5;
   const num=el('input',{name:k,type:'number',min,max,step:'any',placeholder:`${min}–${max}`,'data-param-num':'1'});
   const rng=el('input',{type:'range',min,max,step,value:min,'data-param-range':k});
   rng.addEventListener('input',()=>{num.value=rng.value;});
   num.addEventListener('input',()=>{if(num.value!=='')rng.value=num.value;});
   $('parameters').append(el('div',{class:'param-field'},[
    el('div',{class:'param-head'},[el('span',{text:rangeLabels[k]??k}),el('span',{class:'muted',text:`${min} – ${max}`})]),
    el('div',{class:'param-row'},[rng,num])
   ]));
  }
  render(s,true);
  await refreshGlassbox();
  setInterval(()=>{if(!busy){api('state').then(st=>render(st)).catch(()=>{});refreshGlassbox();}},2500);
 }catch(e){notice(e.message,true);}
})();
