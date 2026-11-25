// Read-only preflight. Explains, before launch, what the standard entry will need
// and what is missing on this machine. It never creates, deletes, unlocks, migrates
// or reads secret values; a missing resource is reported, never assumed to be empty.
//
//   node tools/brain-service/doctor.mjs                 # current env, human-readable
//   node --env-file=.env tools/brain-service/doctor.mjs --json
//
// Exit code: 0 when nothing is blocking for the resolved mode, 1 otherwise. The blocking
// rules for a missing live store/journal and unbounded QQ reach match launchBrain.
import {existsSync,readFileSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {resolveBrainConfig,assertSupportedNode} from './runtime-config.mjs';
import {affectRuntimeStatus} from './bootstrap.mjs';

const OK='ok',WARN='warn',BLOCK='blocked',INFO='info';
const item=(area,status,summary,fix=null)=>({area,status,summary,...(fix?{fix}:{})});
const file=p=>{try{return statSync(p).isFile();}catch{return false;}};
const dir=p=>{try{return statSync(p).isDirectory();}catch{return false;}};

function pythonVersion(executable,spawn){
  const r=spawn(executable,['-c','import sys;print("%d.%d.%d"%sys.version_info[:3])'],{encoding:'utf8',timeout:10000,windowsHide:true});
  return r.status===0&&/^\d+\.\d+\.\d+$/.test(String(r.stdout).trim())?String(r.stdout).trim():null;
}
export async function portFree(port,host='127.0.0.1'){
  if(port===0)return true;
  return await new Promise(done=>{const s=createServer();s.once('error',()=>done(false));s.listen(port,host,()=>s.close(()=>done(true)));});
}

// Pure except for filesystem stats, an optional Python version probe and an optional port probe.
export async function diagnose({root=process.cwd(),env=process.env,platform=process.platform,nodeVersion=process.versions.node,
  spawn=spawnSync,probePort=portFree,qq=env.QQ_UIN!==undefined||env.QQ_SDK_MODULE!==undefined}={}){
  root=resolve(root);const out=[];
  try{assertSupportedNode(nodeVersion);out.push(item('node',OK,`Node ${nodeVersion}`));}
  catch{out.push(item('node',BLOCK,`Node ${nodeVersion}; 需要 >=26.8.0`,'安装 Node 26.8 或更新的稳定版'));}
  if(!file(join(root,'src/store.mjs'))||!file(join(root,'package.json')))
    out.push(item('project',BLOCK,`${root} 不是项目根目录`,'在仓库根目录运行'));

  let config;
  try{config=resolveBrainConfig({root,env});}
  catch(error){out.push(item('config',BLOCK,`${error.code??'CONFIG'}: ${error.message}`,'按 docs/CONFIGURATION.md 修正环境变量'));return finish(out,null);}
  out.push(item('mode',INFO,config.live?'live：会调用付费模型并可对外发送':'dry-run：不构造模型或 QQ 发送器，数据落在 _local/dry-run'));

  // Identity: live requires an explicit, non-empty, bounded file; dry-run falls back to a neutral line.
  const explicitIdentity=env.BRAIN_IDENTITY_FILE!==undefined;
  if(!file(config.identityFile))
    out.push(item('identity',config.live||explicitIdentity?BLOCK:WARN,`身份文件不存在：${config.identityFile}`+(config.live||explicitIdentity?'':'（dry-run 将使用中性占位身份）'),
      '设置 BRAIN_IDENTITY_FILE 指向已审定的身份文本，可参照 config/identity.example.txt'));
  else{
    const text=readFileSync(config.identityFile,'utf8').trim(),n=[...text].length;
    out.push(n===0?item('identity',BLOCK,'身份文件为空',null):n>4000?item('identity',BLOCK,`身份文件 ${n} 字，超过 4000 字上限`,'提供经审阅的精简版本'):item('identity',OK,`${config.identityFile}（${n} 字）`));
  }

  // Store: a missing store becomes a brand-new subject. Say so instead of silently starting from nothing.
  if(config.storePath===':memory:')out.push(item('store',INFO,'内存数据库：退出即丢失'));
  else if(file(config.storePath))out.push(item('store',OK,config.storePath));
  else if(!config.live)out.push(item('store',INFO,`数据库不存在，启动会新建一个空主体：${config.storePath}`));
  else if(env.JY_NEW_SUBJECT==='1')out.push(item('store',WARN,`已确认新建空主体（JY_NEW_SUBJECT=1）：${config.storePath}`));
  else out.push(item('store',BLOCK,`live 数据库不存在：${config.storePath}`,'若应接续已有主体，修正 BRAIN_STORE；只有确实要新建主体时才设置 JY_NEW_SUBJECT=1'));

  const instance=join(config.stateDirectory,'brain.launch.lock');
  if(file(instance))out.push(item('instance',BLOCK,`已有启动锁：${instance}`,'先确认原实例是否仍在运行；不要凭 PID 猜测或直接删锁'));
  else out.push(item('instance',OK,`状态目录 ${config.stateDirectory}${dir(config.stateDirectory)?'':'（将新建）'}`));

  if(config.live){
    if(!file(config.ledgerPath))out.push(env.JY_NEW_REQUEST_JOURNAL==='1'?item('request-journal',WARN,`已确认新建 RequestJournal（JY_NEW_REQUEST_JOURNAL=1）：${config.ledgerPath}`)
      :item('request-journal',BLOCK,`RequestJournal 不存在：${config.ledgerPath}`,'已有运行资料时必须指向原 Journal（换空路径会绕过历史 UNKNOWN）；仅首次空白部署设置 JY_NEW_REQUEST_JOURNAL=1'));
    else if(file(config.ledgerPath+'.lock'))out.push(item('request-journal',BLOCK,`Journal 被锁定：${config.ledgerPath}.lock`,'确认持有者后按既有规则处理，不自动删锁'));
    else{
      let format=null;try{format=JSON.parse(readFileSync(config.ledgerPath,'utf8')).format;}catch{}
      out.push(format==='jingyang-request-journal-v1'?item('request-journal',OK,config.ledgerPath)
        :item('request-journal',BLOCK,`不是 jingyang-request-journal-v1：${config.ledgerPath}`,'旧 DailyBudgetLedger 不能直接当作 RequestJournal 打开'));
    }
    const token=env.JY_OFFICIAL_USAGE_TOKEN??'';
    out.push(token.length>=32?item('official-usage',OK,'上报令牌已设置（未显示）')
      :item('official-usage',BLOCK,'JY_OFFICIAL_USAGE_TOKEN 缺失或不足 32 字符','设置私密上报令牌；它不是模型 API Key'));
    const usage=join(config.stateDirectory,'official-usage.json');
    out.push(file(usage)?item('official-usage-report',INFO,`已有消费快照 ${usage}；有效期 90 秒，过期时暂停新调用`)
      :item('official-usage-report',WARN,'尚无官方消费报告：服务可启动，但在收到有效报告前不会发起模型调用','接通只读采集器到 POST /v1/official-usage'));
    const keyFile=join(root,'_local/study-secrets/deepseek-study.dpapi');
    if(platform!=='win32')out.push(item('model-credential',BLOCK,`当前平台 ${platform}：默认凭据只实现了 Windows DPAPI helper`,'需在 Windows 运行，或由运营方评审并接入跨平台凭据实现（勿用明文环境变量代替）'));
    else out.push(file(keyFile)?item('model-credential',OK,'DPAPI 密文存在（未解密）'):item('model-credential',BLOCK,`缺少 ${keyFile}`,'在当前 Windows 用户下运行 scripts/study-key.ps1 填写'));
    if(config.openLife)out.push(item('open-life',BLOCK,'JY_OPEN_LIFE=1 需要宿主注入 lifePolicy；标准 run.mjs 不提供，启动会报 LIFE_POLICY_REQUIRED','保持 JY_OPEN_LIFE=0，或用自有宿主调用 launchBrain({dependencies:{lifePolicy}})'));
    out.push(env.QQ_TEST_ONLY_OWNER?item('qq-scope',OK,`只允许私聊 ${env.QQ_TEST_ONLY_OWNER}`)
      :env.JY_QQ_SCOPE==='all'?item('qq-scope',WARN,'已确认开放全部好友与已加入的群（JY_QQ_SCOPE=all）')
      :item('qq-scope',BLOCK,'未限定 QQ 发送范围：默认会开放全部好友与群','设置 QQ_TEST_ONLY_OWNER=<主人QQ>；确需全部开放时显式设置 JY_QQ_SCOPE=all'));
    if(!env.BRAIN_TOKEN)out.push(item('http-auth',WARN,'未设置 BRAIN_TOKEN：本地 HTTP 接口无认证','设置 BRAIN_TOKEN，并让 QQ 桥使用相同令牌'));
  }

  if(config.affect.enabled){
    // The packaged runtime is the default; JY_AFFECT_PYTHON is an explicit override.
    // A missing/tampered runtime makes startup degrade (core keeps running), so it is
    // a WARN unless the operator explicitly requires affect via JY_AFFECT_REQUIRED=1.
    const required=env.JY_AFFECT_REQUIRED==='1';
    const status=affectRuntimeStatus({root,env});
    const fixRuntime='部署已验证的 _local/affect-runtime 包（含 PROVENANCE.json），或设置 JY_AFFECT_PYTHON';
    if(!status.ok){
      out.push(required
        ? item('affect',BLOCK,`affect runtime 不可用（${status.code}），且 JY_AFFECT_REQUIRED=1：启动会拒绝`,fixRuntime+'; 或移除 JY_AFFECT_REQUIRED 允许降级')
        : item('affect',WARN,`affect runtime 不可用（${status.code}）：启动将降级为无 affect/fusion，核心对话继续`,fixRuntime+'; 确需硬性要求时设置 JY_AFFECT_REQUIRED=1'));
    }else if(status.source==='operator'){
      const v=pythonVersion(status.pythonPath,spawn),[maj,min]=(v??'0.0').split('.').map(Number);
      const usable=!!v&&(maj>3||maj===3&&min>=10);
      if(!v)out.push(required?item('affect',BLOCK,`无法运行 operator 提供的解释器：${status.pythonPath}`,'检查解释器路径或改用打包 runtime')
        :item('affect',WARN,`无法运行 operator 提供的解释器：${status.pythonPath}；启动将降级`,'修正 JY_AFFECT_PYTHON 或改用已验证打包 runtime'));
      else if(!usable)out.push(required?item('affect',BLOCK,`Python ${v} 过旧，需要 >=3.10`,'升级 Python 或改用打包 runtime')
        :item('affect',WARN,`Python ${v} 过旧（需要 >=3.10）；启动将降级`,'升级 Python 或改用打包 runtime'));
      else out.push(item('affect',OK,`operator-provided Python ${v}（provenance 未验证）`));
    }else{
      out.push(item('affect',OK,`打包 runtime ${status.provenance?.version??'unknown'}（exe/archive sha 与签名验证通过）`));
    }
    if(required)out.push(item('affect-required',INFO,'JY_AFFECT_REQUIRED=1：runtime 不可用或解释器无效将阻断启动'));
  }

  if(probePort){
    const free=await probePort(config.port);
    out.push(free?item('port',OK,`端口 ${config.port} 可用`):item('port',BLOCK,`端口 ${config.port} 已被占用`,'先确认是否已有实例；测试时用 BRAIN_PORT 选择空闲端口，不要接管生产'));
  }

  // The QQ bridge is a separate process; only checked when it is being configured.
  if(qq){
    if(!/^\d+$/.test(env.QQ_UIN??''))out.push(item('qq',BLOCK,'QQ_UIN 未设置','显式设置机器人 QQ 号；不会自动选第一个账号'));
    const home=resolve(root,env.SNOWLUMA_HOME??'../SnowLuma/dist');
    if(/^\d+$/.test(env.QQ_UIN??'')){const cfg=join(home,'config',`onebot_${env.QQ_UIN}.json`);
      out.push(file(cfg)?item('qq-onebot',OK,cfg):item('qq-onebot',BLOCK,`缺少 OneBot 配置 ${cfg}`,'设置 SNOWLUMA_HOME 指向已登录的 SnowLuma'));}
    const sdk=env.QQ_SDK_MODULE;
    let sdkPath=null;try{sdkPath=sdk?(sdk.startsWith('file:')?fileURLToPath(sdk):resolve(root,sdk)):null;}catch{}
    out.push(sdkPath&&file(sdkPath)?item('qq-sdk',OK,sdkPath):item('qq-sdk',BLOCK,sdk?`找不到 SDK：${sdk}`:'QQ_SDK_MODULE 未设置；默认值是原机目录',
      '设置 QQ_SDK_MODULE 为 @snowluma/sdk 的 dist/index.js'));
  }
  return finish(out,config);
}
function finish(checks,config){
  return {format:'jingyang-doctor-v1',mode:config?.mode??null,ready:!checks.some(c=>c.status===BLOCK),checks};
}
export function formatReport(report){
  const mark={ok:'✓',warn:'!',blocked:'✗',info:'·'};
  const lines=[`Threadline 启动前诊断  mode=${report.mode??'unknown'}  ${report.ready?'可以启动':'有阻断项'}`,''];
  for(const c of report.checks){lines.push(`${mark[c.status]} ${c.area.padEnd(22)} ${c.summary}`);if(c.fix&&c.status!==OK)lines.push(`  ${''.padEnd(22)} → ${c.fix}`);}
  return lines.join('\n');
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const report=await diagnose({qq:process.argv.includes('--qq')||undefined});
  console.log(process.argv.includes('--json')?JSON.stringify(report,null,1):formatReport(report));
  process.exitCode=report.ready?0:1;
}
