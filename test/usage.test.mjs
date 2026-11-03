import {test} from 'node:test';
import assert from 'node:assert/strict';
import {UsageCollector} from '../integrations/usage/collector.mjs';
import {formatUsage} from '../integrations/usage/format.mjs';

const model={providerID:'test',id:'model'};
function fixture(options={}) { let now=1000; const c=new UsageCollector({clock:()=>now,...options}); return {c, at:value=>now=value}; }
const event=(type,data)=>({type,data});
const tokens={input:100,output:20,reasoning:5,cache:{read:400,write:0}};

test('usage counts observed steps once and keeps auxiliary requests separate',()=>{
 const {c,at}=fixture(); c.ensure('parent',{agent:'build',model});
 c.modelRequest({sessionID:'parent',agent:'build',model,kind:'primary'});
 at(1100);c.event(event('session.step.started',{sessionID:'parent',assistantMessageID:'one',agent:'build',model,started:1000}));
 c.event(event('session.text.started',{sessionID:'parent',assistantMessageID:'one',ordinal:0}));
 at(1300);c.event(event('session.step.streamed',{sessionID:'parent',assistantMessageID:'one'}));
 const end=event('session.step.ended',{sessionID:'parent',assistantMessageID:'one',tokens,cost:0.002});
 c.event(end);c.event(end);
 c.modelRequest({sessionID:'parent',agent:'build',model,kind:'compaction'});
 c.event(event('session.compaction.ended',{sessionID:'parent',model,tokens:{...tokens,input:10},cost:0.001}));
 const s=c.snapshot('parent');
 assert.equal(s.totals.steps,1); assert.equal(s.totals.input,110);assert.equal(s.totals.cacheRead,800);
 assert.equal(s.totals.cost,0.003);assert.equal(s.sessions[0].requests.compaction,1);
 assert.equal(s.sessions[0].latest.kind,'primary');assert.equal(s.sessions[0].latest.tokens.input,100);
 assert.equal(s.timing.modelMs,300);assert.equal(s.sessions[0].latest.firstOutputMs,100);
});

test('concurrent tools and descendants merge wall intervals instead of summing overlaps',()=>{
 const {c,at}=fixture();c.ensure('root',{agent:'build',model});c.ensure('child',{parentID:'root',agent:'reviewer',model});
 c.toolStart({sessionID:'root',id:'a',tool:'sandbox_shell',agent:'build'});
 at(1100);c.toolStart({sessionID:'root',id:'b',tool:'grep',agent:'build'});
 c.toolStart({sessionID:'child',id:'c',tool:'read',agent:'reviewer'});
 at(1200);c.toolEnd({sessionID:'root',id:'a'});
 at(1300);c.toolEnd({sessionID:'root',id:'b'});
 at(1400);c.toolEnd({sessionID:'child',id:'c'});
 const s=c.snapshot('root');assert.equal(s.timing.toolMs,400);assert.equal(s.sessions.length,2);
 assert.equal(s.sessions[0].timing.toolMs,300);assert.equal(s.sessions[1].timing.toolMs,300);
 assert.equal(s.totals.tools,3);assert.ok(s.groups.some(g=>g.agent==='reviewer'));
});

test('retry classification and counters never retain provider error text or bodies',()=>{
 const {c,at}=fixture(); const never=()=>{throw new Error('private payload accessed');};
 const input={sessionID:'s',agent:'chat',model,kind:'primary'};
 Object.defineProperties(input,{messages:{get:never},headers:{get:never},request:{get:never}});
 c.modelRequest(input);at(1050);
 c.retry({...input,error:{type:'UpstreamError',message:'Upstream idle timeout exceeded SECRET'},attempt:2,decision:{retry:true,delay:100}});
 c.retry({...input,error:{type:'Other',message:'SECRET'},attempt:3,decision:{retry:false}});
 const tool={sessionID:'s',id:'x',agent:'chat',tool:'read'};Object.defineProperty(tool,'input',{get:never});c.toolStart(tool);
 const done={...tool};Object.defineProperty(done,'result',{get:never});c.toolEnd(done);
 const s=c.snapshot('s');assert.equal(s.totals.retries,1);assert.equal(s.sessions[0].lastRetry.reason,'Upstream idle timeout');
 assert.ok(!JSON.stringify(s).includes('SECRET'));
});

test('missing cache and billing remain unknown and zero host cost is not discarded',()=>{
 const {c}=fixture();c.ensure('s');c.modelRequest({sessionID:'s',agent:'chat',model,kind:'primary'});
 c.event(event('session.step.started',{sessionID:'s',assistantMessageID:'one',agent:'chat',model,started:1000}));
 c.event(event('session.step.ended',{sessionID:'s',assistantMessageID:'one',tokens:{input:12,output:2,reasoning:0,cache:{read:0,write:0}},cost:0}));
 const text=formatUsage(c.snapshot('s')).join('\n');
 assert.match(text,/Cache read.*unknown/i);assert.match(text,/billing.*unknown/i);assert.match(text,/\$0\.00/);
 assert.match(text,/12/);
});

test('tracking resets only selected family, never reads old content and bounds state',()=>{
 const {c,at}=fixture({maxSessions:3,maxEntries:4});
 for(let i=0;i<8;i++){at(1000+i);c.ensure('s'+i);}
 assert.equal(c.size,3);assert.equal(c.snapshot('s7').evictedSessions,5);
 c.ensure('child',{parentID:'s7'}); c.ensure('other');
 c.modelRequest({sessionID:'s7',agent:'build',model,kind:'primary'});
 c.modelRequest({sessionID:'other',agent:'chat',model,kind:'primary'});
 c.reset('s7');assert.equal(c.snapshot('s7').totals.modelCalls,0);assert.equal(c.snapshot('other').totals.modelCalls,1);
 const empty=formatUsage(c.snapshot('unseen')).join('\n');assert.match(empty,/no observed/i);
});

test('auxiliary usage is attributed to its own model without replacing the primary model',()=>{
 const {c}=fixture();c.ensure('s',{agent:'build',model});
 c.modelRequest({sessionID:'s',agent:'build',model,kind:'primary'});
 c.modelRequest({sessionID:'s',agent:'compaction',model:{providerID:'test',id:'small'},kind:'compaction'});
 c.event(event('session.compaction.ended',{sessionID:'s',model:{providerID:'test',id:'small'},tokens,cost:0}));
 const s=c.snapshot('s');assert.equal(s.sessions[0].model.id,'model');
 assert.equal(s.groups.find(g=>g.model.id==='small').input,100);
 assert.equal(s.groups.find(g=>g.model.id==='model').input,0);
});

test('selected session is first even when its descendant was observed earlier',()=>{
 const {c}=fixture();c.ensure('child',{parentID:'root'});c.ensure('root');
 assert.equal(c.snapshot('root').sessions[0].sessionID,'root');
});

test('completely missing usage is displayed as unknown, not a zero-cost request',()=>{
 const {c}=fixture();c.ensure('s');c.event(event('session.step.failed',{sessionID:'s',assistantMessageID:'failed'}));
 const text=formatUsage(c.snapshot('s')).join('\n');assert.match(text,/OpenCode cost: unknown/);assert.doesNotMatch(text,/OpenCode cost: \$0/);
});

test('step initialization alone does not establish first output; content-free markers do',()=>{
 const {c,at}=fixture();c.ensure('s');
 c.event(event('session.step.started',{sessionID:'s',assistantMessageID:'one',agent:'chat',model,started:1000}));
 at(1200);c.event(event('session.step.ended',{sessionID:'s',assistantMessageID:'one',tokens,cost:0}));
 assert.equal(c.snapshot('s').sessions[0].latest.firstOutputMs,null);
 c.event(event('session.step.started',{sessionID:'s',assistantMessageID:'two',agent:'chat',model,started:1200}));
 at(1400);const d={sessionID:'s',assistantMessageID:'two'};Object.defineProperty(d,'text',{get(){throw Error('Content accessed');}});
 c.event(event('session.tool.input.started',d));
 c.event(event('session.step.ended',{sessionID:'s',assistantMessageID:'two',tokens,cost:0}));
 assert.equal(c.snapshot('s').sessions[0].latest.firstOutputMs,200);
});

test('title usage remains explicitly unreported and retries preserve selected model',()=>{
 const {c}=fixture();c.ensure('s',{agent:'build',model});
 const small={providerID:'test',id:'small'};
 c.modelRequest({sessionID:'s',agent:'title',model:small,kind:'title'});
 c.retry({sessionID:'s',agent:'title',model:small,error:{type:'TimeoutError'},attempt:2,decision:{retry:true,delay:0}});
 const s=c.snapshot('s');assert.equal(s.sessions[0].model.id,'model');
 assert.equal(s.totals.unreportedAuxiliary,1);assert.match(formatUsage(s).join('\n'),/auxiliary.*unreported/i);
});

test('a compaction observed without its request does not consume an unrelated unreported title',()=>{
 const {c}=fixture();c.ensure('s',{agent:'build',model});
 c.modelRequest({sessionID:'s',agent:'title',model,kind:'title'});
 c.event(event('session.compaction.ended',{sessionID:'s',model,tokens,cost:0}));
 assert.equal(c.snapshot('s').totals.unreportedAuxiliary,1);
});

test('new execution counters reset while observed session totals remain cumulative',()=>{
 const {c,at}=fixture();c.event(event('session.execution.started',{sessionID:'s'}));
 c.modelRequest({sessionID:'s',agent:'build',model,kind:'primary'});
 at(1100);c.event(event('session.execution.succeeded',{sessionID:'s'}));
 c.event(event('session.execution.started',{sessionID:'s'}));
 c.modelRequest({sessionID:'s',agent:'build',model,kind:'primary'});
 const s=c.snapshot('s');assert.equal(s.totals.modelCalls,2);assert.equal(s.sessions[0].currentRun.totals.modelCalls,1);
 assert.match(formatUsage(s).join('\n'),/Latest run counters.*1 calls/);
});
