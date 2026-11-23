import test from 'node:test';
import assert from 'node:assert/strict';
import {executeTool} from '../tools/qq-connect/tools.mjs';

test('QQ tools reject calls outside the explicit host grant before transport', async()=>{
  await assert.rejects(
    executeTool('qq_send_message',{target:'private',id:'1',text:'should not send'},{allowedTools:[],entry:'decision'}),
    error=>error.code==='TOOL_NOT_GRANTED'&&error.transportInvoked===false);
  await assert.rejects(
    executeTool('qq_send_sticker',{target:'private',id:'1',url:'https://example.invalid/x.png'},{allowedTools:['qq_send_message'],entry:'task'}),
    error=>error.code==='TOOL_NOT_GRANTED'&&error.transportInvoked===false);
});
