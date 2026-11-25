// A-owned focused proactive_contact transport tests. Synthetic OneBot stub only:
// no real QQ, no production database, no model, no server.mjs integration here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('proactive_contact maps to the existing private-send receipt and rejects group/pin escapes',async t=>{
 const home=mkdtempSync(join(tmpdir(),'jy-proactive-send-'));
 mkdirSync(join(home,'config'));
 writeFileSync(join(home,'config','onebot_123.json'),JSON.stringify({networks:{
  httpServers:[{host:'127.0.0.1',port:3999}],wsServers:[{host:'127.0.0.1',port:3998}]}}));
 const previous={home:process.env.SNOWLUMA_HOME,uin:process.env.QQ_UIN,disabled:process.env.QQ_SEND_DISABLED,openLife:process.env.JY_OPEN_LIFE,requirePin:process.env.JY_REQUIRE_DELIVERY_PIN};
 const realFetch=globalThis.fetch,seen=[];
 process.env.SNOWLUMA_HOME=home;process.env.QQ_UIN='123';process.env.QQ_SEND_DISABLED='0';process.env.JY_OPEN_LIFE='0';delete process.env.JY_REQUIRE_DELIVERY_PIN;
 globalThis.fetch=async(url,init)=>{
  seen.push({url:String(url),body:JSON.parse(init.body)});
  return new Response(JSON.stringify({status:'ok',retcode:0,data:{message_id:4242}}),{status:200,headers:{'content-type':'application/json'}});
 };
 t.after(()=>{
  globalThis.fetch=realFetch;
  for(const [key,value] of [['SNOWLUMA_HOME',previous.home],['QQ_UIN',previous.uin],['QQ_SEND_DISABLED',previous.disabled],['JY_OPEN_LIFE',previous.openLife],['JY_REQUIRE_DELIVERY_PIN',previous.requirePin]]){
   if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  rmSync(home,{recursive:true,force:true});
 });
 const {executeTool}=await import('../tools/qq-connect/tools.mjs?proactive-send-a=1');
 const allowed=[{allowedTools:['proactive_contact']}];
 // Group initiation is disabled before pin/transport.
 await assert.rejects(executeTool('proactive_contact',{targetScene:'qq/group/9',text:'synthetic group'},{allowedTools:['proactive_contact'],pinRequired:true,pinTargets:['qq/group/9']}),{code:'PROACTIVE_GROUP_DISABLED',transportInvoked:false});
 assert.equal(seen.length,0,'group initiation must not invoke the transport');
 // Invalid or missing explicit target is rejected before pin/transport.
 await assert.rejects(executeTool('proactive_contact',{targetScene:'qq/private/7:1',text:'x'},...allowed),{code:'PROACTIVE_TARGET',transportInvoked:false});
 await assert.rejects(executeTool('proactive_contact',{targetScene:'private:7',text:'x'},...allowed),{code:'PROACTIVE_TARGET',transportInvoked:false});
 assert.equal(seen.length,0);
 // Pin mismatch is rejected before transport.
 await assert.rejects(executeTool('proactive_contact',{targetScene:'qq/private/8',text:'x'},{allowedTools:['proactive_contact'],pinRequired:true,pinTargets:['qq/private/7']}),{code:'UNDELIVERED_TARGET',transportInvoked:false});
 assert.equal(seen.length,0);
 // Valid explicit private target uses the existing send_private_msg path and its message_id receipt.
 const result=await executeTool('proactive_contact',{targetScene:'qq/private/7',text:'synthetic hello',reason:'synthetic reason',confirmation:{approved:true,evidence:'synthetic evidence'}},{allowedTools:['proactive_contact'],pinRequired:true,pinTargets:['qq/private/7']});
 assert.equal(result.message_id,4242);
 assert.equal(seen.length,1);
 assert.match(seen[0].url,/\/send_private_msg$/);
 assert.deepEqual(seen[0].body,{user_id:7,message:[{type:'text',data:{text:'synthetic hello'}}]});
 assert.equal(seen[0].body.group_id,undefined);
});
