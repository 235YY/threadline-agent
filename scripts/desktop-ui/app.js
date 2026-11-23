
const $=id=>document.getElementById(id);
let profile, hasKey=false, busy=false;
const rangeLabels={reactivity:'情绪反应强度',social_need:'社交需要',novelty_need:'新鲜感需要',competence_need:'能力需要',recognition_need:'认可需要',fatigue_recovery_h:'疲劳恢复（小时）',mood_tau_h:'心境衰减（小时）',baseline_tau_d:'基线适应（天）',resilience_tau_d:'复原力适应（天）',circadian_strength:'昼夜节律影响'};
const statusText={off:'未连接',connecting:'正在连接并核对账号…',connected:'已连接：仅指定账号私聊',stopping:'正在断开…',reconnecting:'连接已中断，请断开后重新连接',failed:'连接失败：检查 SnowLuma 登录和路径'};
const errors={API_KEY_REQUIRED:'请填入你自己的 API Key。',API_KEY_FORMAT:'请输入有效的 DeepSeek API Key。',API_KEY_REJECTED:'服务商拒绝该密钥。',API_CHECK_UNAVAILABLE:'凭据检查暂时不可用。',DESKTOP_BUDGET_LIMIT:'本工作台已达到每日额度估算上限。',SERVICE_BUSY:'仍有操作正在处理，等结束后再试。',QQ_SETUP_REQUIRED:'请填写完整账号、目录和 SDK 路径。',QQ_ONEBOT_CONFIG:'找不到此账号的本机 OneBot 配置。',QQ_NOT_READY:'请先启用真实模型，并断开现有连接。',PYTHON_REQUIRED:'请填写 Python 解释器。',LIMBIC_PROFILE_LOCKED:'已保存的情绪状态使用另一套参数，请保留原参数。',AFFECT_PROFILE:'已保存的情绪状态使用另一套参数。',MEMORY_COUNT:'每次可以导入 1 到 128 条笔记。',MEMORY_FORMAT:'笔记文件格式有误。',MEMORY_SIZE:'每条笔记最多 4,000 字符。',UNCERTAIN_REQUEST:'这次请求结果未知，系统不会自动重发。'};
function notice(msg,bad=false){$('notice').textContent=msg;$('notice').classList.toggle('error',bad);}
async function api(route,data){const r=await fetch('./api/'+route,data===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});const j=await r.json();if(!r.ok)throw Error(errors[j.error]??('操作未完成：'+j.error));return j;}
function tab(id){const item=document.querySelector('[data-tab="'+id+'"]');if(!item)return;document.querySelectorAll('main section').forEach(s=>s.hidden=s.id!==id);document.querySelectorAll('[data-tab]').forEach(b=>{b.classList.toggle('on',b===item);b.setAttribute('aria-current',b===item?'page':'false');});$('heading').textContent=item.textContent;}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>tab(b.dataset.tab));
function render(state,fill=false){
 profile=state.profile;hasKey=state.hasKey;
 $('mode').textContent=profile.live?'模型已启用':'离线模式';$('spend').textContent=state.limit?.estimate==null?'':' 今日估算 ¥'+state.limit.estimate.toFixed(3)+'。';
 $('qqStatus').textContent=statusText[state.qqStatus];$('affectStatus').textContent=state.affect?.enabled?'引擎正在运行'+(state.affect.fusion?'，已开启统觉联动。':'。'):profile.affect?'引擎未就绪：'+(state.affect?.code??state.affect?.reason??'请检查 Python。'):'未启用。';
 if(!fill)return;
 $('persona').value=profile.identity;$('style').value=profile.style;$('live').checked=profile.live;$('daily').value=profile.daily;
 $('affectEnabled').checked=profile.affect;$('fusion').checked=profile.fusion;$('python').value=profile.python;$('timezone').value=profile.timezoneMinutes;
 for(const id of ['bot','owner','home','sdk'])$(id).value=profile.qq[id];
 for(const x of $('parameters').querySelectorAll('input'))x.value=profile.parameters[x.name]??'';
}
function getProfile(){const parameters={};for(const x of $('parameters').querySelectorAll('input'))if(x.value!=='')parameters[x.name]=Number(x.value);
 return {identity:$('persona').value,style:$('style').value,live:$('live').checked,daily:Number($('daily').value),affect:$('affectEnabled').checked,fusion:$('fusion').checked,python:$('python').value,timezoneMinutes:Number($('timezone').value),parameters,qq:Object.fromEntries(['bot','owner','home','sdk'].map(k=>[k,$(k).value]))};
}
function run(fn){if(busy||!profile)return;busy=true;const buttons=[...document.querySelectorAll('button:not([data-tab])')];buttons.forEach(b=>b.disabled=true);notice('正在处理…');
 Promise.resolve().then(fn).catch(e=>notice(e.message,true)).finally(()=>{busy=false;buttons.forEach(b=>b.disabled=false);});
}
async function save(){await api('apply',{profile:getProfile(),key:$('key').value});$('key').value='';render(await api('state'),true);notice('配置已保存并应用。');}
document.querySelectorAll('[data-save]').forEach(b=>b.onclick=()=>run(save));
$('checkKey').onclick=()=>run(async()=>{await api('check-key',{key:$('key').value});notice('DeepSeek 接受了该凭据。没有发送生成请求。');});
$('connect').onclick=()=>run(async()=>{const next=getProfile();if(JSON.stringify(next)!==JSON.stringify(profile)||$('key').value)await save();await api('connect-qq',{});render(await api('state'));notice('连接器已启动，等待账号核对。');});
$('disconnect').onclick=()=>run(async()=>{await api('disconnect-qq',{});render(await api('state'));notice('QQ 已断开。');});
function bubble(text,me){const p=document.createElement('div');p.className='bubble'+(me?' me':'');p.textContent=text;$('messages').append(p);$('messages').scrollTop=$('messages').scrollHeight;}
$('chatForm').onsubmit=e=>{e.preventDefault();run(async()=>{const v=$('message').value.trim();if(!v){notice('请输入消息。');return;}bubble(v,true);$('message').value='';const r=await api('chat',{text:v});if(r.text)bubble(r.text,false);notice(r.live?(r.text?'回复已收到。':'已处理，这轮没有回复。'):'已在离线模式保存；未调用模型。');});};
$('import').onclick=()=>run(async()=>{const f=$('memoryFile').files[0];if(f&&f.size>1024*1024)throw Error('笔记文件最多 1 MB。');const s=f?await f.text():$('memoryText').value;const data=f?.name.toLowerCase().endsWith('.json')?JSON.parse(s):s.trim().split(/\r?\n\s*\r?\n/).filter(Boolean);const r=await api('import',{notes:data});notice('已导入 '+r.imported+' 条，跳过重复 '+r.duplicates+' 条。');});
$('export').onclick=()=>run(async()=>{const s=await api('notes');const u=URL.createObjectURL(new Blob([JSON.stringify(s,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download='threadline-notes.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),5000);notice('笔记导出已生成。');});
document.querySelectorAll('[data-file]').forEach(x=>x.onchange=async()=>{const file=x.files[0];if(!file)return;const target=$(x.dataset.file);if(file.size>64000){notice('文件过大。',true);return;}const s=await file.text();if(s.length>target.maxLength){notice('文件超过该字段长度。',true);return;}target.value=s;notice('已载入文件，点击保存后生效。');});
$('affectEnabled').onchange=()=>{if(!$('affectEnabled').checked)$('fusion').checked=false;};
$('fusion').onchange=()=>{if($('fusion').checked)$('affectEnabled').checked=true;};
(async()=>{try{const s=await api('state');for(const [k,[min,max]]of Object.entries(s.ranges)){const l=document.createElement('label');l.textContent=rangeLabels[k]??k;const i=document.createElement('input');i.name=k;i.type='number';i.min=min;i.max=max;i.step='any';i.placeholder=min+' – '+max;l.append(i);$('parameters').append(l);}render(s,true);
 setInterval(()=>{if(!busy)api('state').then(s=>render(s)).catch(()=>{});},1600);}catch(e){notice(e.message,true);}})();

