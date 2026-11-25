import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrainService} from '../tools/brain-service/server.mjs';
import {intentPacket} from '../src/intent-protocol.mjs';

test('background thought is not started during quiet hours', async () => {
  // 23:30 Asia/Shanghai, even when the host OS runs in another timezone.
  const now = Date.parse('2026-11-22T15:30:00Z');
  let calls = 0;
  const service = createBrainService({
    storePath: ':memory:',
    clock: () => now,
    global: true,
    autonomy: true,
    heartbeatMs: 60_000,
    idleIntervalMs: 1,
    rhythm: {beatMs: 1, quietBeatMs: 1, quietFromHour: 23, quietToHour: 7},
    decide: () => { calls++; return {format: 'fixture'}; }
  });
  try {
    const reflection = await service.idleReflect();
    assert.equal(reflection.skipped, true);
    assert.equal(reflection.reason, 'quiet-hours');
    const autonomy = await service.autonomyTick({now});
    assert.equal(autonomy.skipped, true);
    assert.equal(autonomy.reason, 'quiet-hours');
    assert.equal(calls, 0);
  } finally {
    service.close();
  }
});

test('deferred scheduler startup respects the configured quiet timezone while a chat still runs',async()=>{
  const now=Date.parse('2026-11-23T04:30:00Z'); // 23:30 at UTC−05:00
  let calls=0;
  const service=createBrainService({clock:()=>now,global:true,autonomy:true,intentProtocol:true,timezoneMinutes:-300,
    heartbeatMs:0,idleIntervalMs:1,rhythm:{beatMs:1,quietBeatMs:1,quietFromHour:23,quietToHour:7},
    decide(packet){calls++;const wire=intentPacket(packet);return {packetId:wire.packetId,decision:{type:'reply',text:'在呀。'}};}});
  try{
    service.startScheduling(60_000);
    assert.equal((await service.idleReflect()).reason,'quiet-hours');
    assert.equal((await service.autonomyTick({now})).reason,'quiet-hours');
    assert.equal(calls,0);
    const reply=await service.reply({scene:'local/chat',text:'你好呀',source:'test',key:'local',message_id:'quiet-chat'});
    assert.equal(reply.text,'在呀。');
    assert.equal(calls,1);
  }finally{service.close();}
});

test('manual autonomy in quiet hours keeps the ZIP tool view and the authorized pinboard',async()=>{
  const now=Date.parse('2026-11-23T04:30:00Z');
  let view;
  const service=createBrainService({clock:()=>now,global:true,autonomy:true,intentProtocol:true,timezoneMinutes:-300,
    heartbeatMs:0,rhythm:{quietFromHour:23,quietToHour:7},allowedActionTools:['start_agent_task','github_search'],
    decide(packet){
      const wire=intentPacket(packet);
      view=JSON.parse(wire.messages[1].content).view;
      return {packetId:wire.packetId,decision:{type:'none'}};
    }});
  try{
    service.store.execute({requestId:'autonomy-pin',commands:[{op:'write_note',id:'note:core-pinboard',body:'想继续研究灯塔。',
      kind:'interpretation',expectedRevision:0,change:'self_report'}]});
    service.startScheduling(60_000);
    assert.equal((await service.autonomyTick({now})).reason,'quiet-hours');
    assert.equal(view,undefined);
    assert.equal((await service.autonomyTick({now,manual:true})).ok,true);
    assert.equal(view.timeFeel.utcOffsetMinutes,-300);
    assert.ok(view.tools.some(tool=>tool.name==='github_search'));
    assert.ok(view.deskCues.some(cue=>cue.includes('github_search')));
    assert.ok(view.materials.some(entry=>entry.body==='想继续研究灯塔。'));
  }finally{service.close();}
});
