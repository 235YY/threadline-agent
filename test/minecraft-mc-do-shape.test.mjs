import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMinecraftCall} from '../tools/native-capabilities/minecraft.mjs';

test('mc_do accepts the natural chat shape and emits one skill step',()=>{
  const out=normalizeMinecraftCall('mc_do',{macro:'chat',text:'哥哥，我进来啦'});
  assert.deepEqual(out.steps,[{skill:'chat',text:'哥哥，我进来啦'}]);
});

test('mc_do keeps an explicit steps array unchanged',()=>{
  const input={steps:[{skill:'chat',text:'你好'}]};
  assert.equal(normalizeMinecraftCall('mc_do',input),input);
});

test('mc_do accepts chat shorthand without altering other tools',()=>{
  assert.deepEqual(normalizeMinecraftCall('mc_do',{chat:'你好'}).steps,[{skill:'chat',text:'你好'}]);
  assert.deepEqual(normalizeMinecraftCall('mc_sense',{detail:true}),{detail:true});
});
