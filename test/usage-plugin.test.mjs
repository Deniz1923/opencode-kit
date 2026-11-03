import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createUsagePlugin} from '../integrations/usage/index.js';
import {Usage} from '../integrations/usage/rpc.js';

test('usage plugin uses only whitelisted live metadata, exposes RPC and cleans up',async()=>{
 const hooks=new Map();let handlers,requested,closed=false;
 const ctx={app:{version:'2.2.4'},session:{
  hook:async(name,fn)=>hooks.set(name,fn),get:async()=>({parentID:'parent'}),
  context:async()=>{throw new Error('No transcript access');}},
  tool:{hook:async(name,fn)=>hooks.set(name,fn)},
  event:{subscribe:options=>{
   requested=options.types;
   return {[Symbol.asyncIterator](){
    return {next:()=>new Promise(()=>{}),return:async()=>{closed=true;return {done:true};}};
   }};
  }},
  rpc:{register:async(def,impl)=>{assert.equal(def,Usage);handlers=impl;}}};
 const cleanup=await createUsagePlugin().setup(ctx);
 assert.ok(!requested.some(t=>/message|inbox|\.delta$/.test(t)));
 assert.ok(!requested.includes('session.usage.recorded'));
 assert.ok(!requested.includes('session.text.ended'));
 assert.ok(!requested.includes('session.reasoning.ended'));
 assert.ok(!hooks.has('context'));assert.ok(!hooks.has('http.response'));
 const e={sessionID:'s',agent:'chat',model:{providerID:'test',id:'model'},kind:'primary'};
 Object.defineProperty(e,'messages',{get(){throw new Error('Private content accessed');}});
 await hooks.get('model.request')(e);await hooks.get('http.request')(e);
 await hooks.get('retry')({...e,error:{type:'TimeoutError',message:'do not store this'},attempt:2,decision:{retry:true,delay:0}});
 const s=await handlers.snapshot({sessionID:'s'});
 assert.equal(s.totals.modelCalls,1);assert.equal(s.totals.httpAttempts,1);assert.equal(s.totals.retries,1);
 assert.equal(s.sessions[0].parentID,'parent');assert.ok(!JSON.stringify(s).includes('do not store this'));
 assert.deepEqual(await handlers.reset({sessionID:'s'}),{reset:false});
 await hooks.get('model.request')({...e,sessionID:'title-only',kind:'title'});
 assert.deepEqual(await handlers.reset({sessionID:'title-only'}),{reset:true});
 await cleanup();assert.equal(closed,true);
});

test('telemetry observation failures do not reject model or tool hooks',async()=>{
 const hooks=new Map();const ctx={app:{version:'2.2.4'},session:{hook:async(n,f)=>hooks.set(n,f),get:async()=>{throw new Error('metadata unavailable');}},
  tool:{hook:async(n,f)=>hooks.set(n,f)},event:{subscribe:()=>({async *[Symbol.asyncIterator](){}})},rpc:{register:async()=>{}}};
 const stop=await createUsagePlugin().setup(ctx);
 await assert.doesNotReject(hooks.get('model.request')({sessionID:'s',agent:'build',kind:'primary'}));
 await stop();
});
