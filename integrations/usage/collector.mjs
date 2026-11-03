const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const label = v => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0,160) : 'unknown';
const modelRef = v => v ? {providerID:label(v.providerID),id:label(v.id),...(v.variant ? {variant:label(v.variant)} : {})} : null;
const empty = () => ({modelCalls:0,httpAttempts:0,retries:0,steps:0,tools:0,input:0,output:0,reasoning:0,cacheRead:0,cacheWrite:0,cost:0,usageReports:0,missingUsage:0,unreportedAuxiliary:0});
function usage(v) {
 return {input:number(v?.input),output:number(v?.output),reasoning:number(v?.reasoning),cacheRead:number(v?.cache?.read),cacheWrite:number(v?.cache?.write)};
}
function addUsage(target, values, cost) {
 target.usageReports++;
 for(const key of ['input','output','reasoning','cacheRead','cacheWrite']) target[key] += values[key] ?? 0;
 target.cost += number(cost) ?? 0;
 if(Object.values(values).some(v=>v===null) || number(cost)===null) target.missingUsage++;
}
function sum(rows) { const out=empty();for(const row of rows)for(const key of Object.keys(out))out[key]+=row[key];return out; }
function merged(intervals) {
 const out=[];
 for(const [start,end] of intervals.filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>=a).sort((a,b)=>a[0]-b[0])) {
  const last=out.at(-1);if(last && start<=last[1])last[1]=Math.max(end,last[1]);else out.push([start,end]);
 }
 return out;
}
const duration = intervals => merged(intervals).reduce((total,[a,b])=>total+b-a,0);
export const EVENT_TYPES = ['session.created','session.deleted','session.execution.started','session.execution.succeeded',
 'session.execution.failed','session.execution.interrupted','session.step.started','session.step.streamed','session.step.ended',
 'session.step.failed','session.compaction.ended','session.compaction.failed',
 'session.text.started','session.reasoning.started','session.tool.input.started'];

export function retryReason(error) {
 const kind=String(error?.type??'')+' '+String(error?.message??'');
 if(/idle.*timeout|idle time/i.test(kind))return 'Upstream idle timeout';
 if(/timeout|timed out/i.test(kind))return 'Upstream timeout';
 if(error?.status===429 || /rate.?limit|quota/i.test(kind))return 'Rate limit';
 if(/network|connect|dns|fetch/i.test(kind))return 'Network failure';
 if(number(error?.status)>=500)return 'Provider server error';
 return 'Other provider error';
}

// Metadata only. Nothing in this module accepts transcript or response bodies.
export class UsageCollector {
 constructor({clock=Date.now,maxSessions=100,maxEntries=512}={}) {
  this.clock=clock;this.startedAt=clock();this.maxSessions=Math.max(1,Math.min(maxSessions,1000));
  this.maxEntries=Math.max(1,Math.min(maxEntries,4096));this.records=new Map();this.evictedSessions=0;this.connected=true;
 }
 get size(){return this.records.size;}
 ensure(id, meta={}) {
  if(typeof id!=='string' || !id || id.length>200)return;
  let r=this.records.get(id);
  if(!r){
   if(this.size>=this.maxSessions){this.records.delete(this.records.keys().next().value);this.evictedSessions++;}
   r={sessionID:id,parentID:null,agent:'unknown',model:null,since:this.clock(),status:'observing',totals:empty(),requests:{},groups:new Map(),
    steps:new Map(),settled:new Set(),requestMeta:new Map(),unreportedCompactions:0,activeModels:new Map(),activeTools:new Map(),intervals:{model:[],tool:[]},timingComplete:true,latest:null,lastRetry:null,run:null};
   this.records.set(id,r);
  }
  if(typeof meta.parentID==='string' && meta.parentID!==id)r.parentID=meta.parentID;
  if(meta.agent)r.agent=label(meta.agent);if(meta.model)r.model=modelRef(meta.model);
  return r;
 }
 bounded(map,key,value,r) {
  map.set(key,value);
  if(map.size>this.maxEntries){map.delete(map.keys().next().value);r.partial=true;}
 }
 group(r,agent=r.agent,model=r.model) {
  const key=JSON.stringify([agent,model]);
  if(!r.groups.has(key)) {
   if(r.groups.size>=32){r.groupsTruncated=true;return null;}
   r.groups.set(key,{agent,model,...empty()});
  }
  return r.groups.get(key);
 }
 count(r,key,agent,model){r.totals[key]++;const g=this.group(r,agent,model);if(g)g[key]++;}
 interval(r,kind,start,end=this.clock()) {
  r.intervals[kind]=merged([...r.intervals[kind],[start,Math.max(start,end)]]);
  if(r.intervals[kind].length>this.maxEntries){r.intervals[kind].shift();r.timingComplete=false;}
 }
 closeModel(r,kind){const start=r.activeModels.get(kind);if(start!==undefined){if(kind==='primary')this.interval(r,'model',start);r.activeModels.delete(kind);}}
 modelRequest(e) {
  const r=this.ensure(e.sessionID);if(!r)return;
  const kind=['primary','title','compaction','generate'].includes(e.kind)?e.kind:'other';
  const meta={agent:label(e.agent??r.agent),model:modelRef(e.model??r.model)};r.requestMeta.set(kind,meta);
  if(kind==='primary'){r.agent=meta.agent;r.model=meta.model;}
  this.closeModel(r,kind);
  // Title/generate have no public completion boundary. Do not invent their
  // duration or leave them permanently blocking a counter reset.
  if(kind==='primary'||kind==='compaction')r.activeModels.set(kind,this.clock());
  r.requests[kind]=(r.requests[kind]??0)+1;this.count(r,'modelCalls',meta.agent,meta.model);
  if(kind!=='primary')this.count(r,'unreportedAuxiliary',meta.agent,meta.model);
  if(kind==='compaction')r.unreportedCompactions++;
 }
 httpRequest(e){const r=this.ensure(e.sessionID);if(r)this.count(r,'httpAttempts',label(e.agent??r.agent),modelRef(e.model??r.model));}
 retry(e){
  if(!e.decision?.retry)return;
  const r=this.ensure(e.sessionID);if(!r)return;
  this.count(r,'retries',label(e.agent??r.agent),modelRef(e.model??r.model));r.lastRetry={attempt:number(e.attempt),reason:retryReason(e.error),at:this.clock()};
 }
 toolStart(e){
  const r=this.ensure(e.sessionID,{agent:e.agent});if(!r)return;
  const key=String(e.messageID??'')+':'+e.id;
  if(!r.activeTools.has(key)){this.bounded(r.activeTools,key,this.clock(),r);this.count(r,'tools',label(e.agent??r.agent));}
 }
 toolEnd(e){
  const r=this.records.get(e.sessionID);if(!r)return;
  const key=String(e.messageID??'')+':'+e.id,start=r.activeTools.get(key);
  if(start!==undefined){this.interval(r,'tool',start);r.activeTools.delete(key);}
 }
 event(e) {
  if(!EVENT_TYPES.includes(e.type))return;
  const d=e.data??{};
  if(e.type==='session.deleted'){this.records.delete(d.sessionID);return;}
  const r=this.ensure(d.sessionID,e.type==='session.created'?{parentID:d.parentID,agent:d.agent,model:d.model}:{});if(!r)return;
  const now=this.clock();
  if(e.type==='session.execution.started'){r.status='running';r.run={startedAt:now,endedAt:null,baseline:{...r.totals}};return;}
  if(['session.execution.succeeded','session.execution.failed','session.execution.interrupted'].includes(e.type)){
   r.status=e.type.split('.').at(-1);if(r.run)r.run.endedAt=now;
   for(const kind of [...r.activeModels.keys()])this.closeModel(r,kind);
   for(const start of r.activeTools.values())this.interval(r,'tool',start);r.activeTools.clear();return;
  }
  if(e.type==='session.step.started'){
   const agent=label(d.agent??r.agent),model=modelRef(d.model??r.model);
   r.agent=agent;r.model=model;
   this.bounded(r.steps,d.assistantMessageID,{agent,model,started:number(d.started),firstOutputMs:null},r);return;
  }
  if(['session.text.started','session.reasoning.started','session.tool.input.started'].includes(e.type)){
   const step=r.steps.get(d.assistantMessageID);
   if(step && step.firstOutputMs===null && step.started!==null)step.firstOutputMs=Math.max(0,now-step.started);
   return;
  }
  if(e.type==='session.step.streamed'){this.closeModel(r,'primary');return;}
  if(e.type==='session.compaction.ended' || e.type==='session.compaction.failed'){
   // Public compaction boundaries repeat its usage delta. Never touch summary,
   // native metadata or error payloads. Internal usage.recorded is not public.
   this.closeModel(r,'compaction');const u=usage(d.tokens);addUsage(r.totals,u,d.cost);
   const meta=r.requestMeta.get('compaction')??{agent:r.agent,model:modelRef(d.model??r.model)};
   const g=this.group(r,meta.agent,meta.model);if(g)addUsage(g,u,d.cost);
   if(r.unreportedCompactions>0 && number(d.cost)!==null && Object.values(u).every(v=>v!==null)){
    r.unreportedCompactions--;
    if(r.totals.unreportedAuxiliary>0)r.totals.unreportedAuxiliary--;
    if(g?.unreportedAuxiliary>0)g.unreportedAuxiliary--;
   }
   return;
  }
  if(e.type==='session.step.ended' || e.type==='session.step.failed'){
   if(r.settled.has(d.assistantMessageID))return;
   r.settled.add(d.assistantMessageID);if(r.settled.size>this.maxEntries){r.settled.delete(r.settled.values().next().value);r.partial=true;}
   this.closeModel(r,'primary');const step=r.steps.get(d.assistantMessageID)??{agent:r.agent,model:r.model,firstOutputMs:null};
   this.count(r,'steps',step.agent,step.model);const u=usage(d.tokens);addUsage(r.totals,u,d.cost);
   const g=this.group(r,step.agent,step.model);if(g)addUsage(g,u,d.cost);
   r.latest={kind:'primary',at:now,agent:step.agent,model:step.model,tokens:u,cost:number(d.cost),firstOutputMs:step.firstOutputMs,
    status:e.type.endsWith('failed')?'failed':label(d.finish??'completed')};
  }
 }
 family(id){
  const ids=new Set([id]);let added=true;
  while(added){added=false;for(const r of this.records.values())if(ids.has(r.parentID)&&!ids.has(r.sessionID)){ids.add(r.sessionID);added=true;}}
  return [...this.records.values()].filter(r=>ids.has(r.sessionID)).sort((a,b)=>a.sessionID===id?-1:b.sessionID===id?1:0);
 }
 reset(id){
  for(const r of this.family(id)){
   const meta={parentID:r.parentID,agent:r.agent,model:r.model};this.records.delete(r.sessionID);this.ensure(r.sessionID,meta);
  }
 }
 snapshot(id){
  const now=this.clock(),family=this.family(id),all={model:[],tool:[]};
  const sessions=family.map(r=>{
   const intervals={model:[...r.intervals.model,...[...r.activeModels.values()].map(start=>[start,now])],
    tool:[...r.intervals.tool,...[...r.activeTools.values()].map(start=>[start,now])]};
   all.model.push(...intervals.model);all.tool.push(...intervals.tool);
   const currentRun=r.run?{startedAt:r.run.startedAt,elapsedMs:Math.max(0,(r.run.endedAt??now)-r.run.startedAt),
    totals:Object.fromEntries(Object.keys(r.totals).map(k=>[k,r.totals[k]-r.run.baseline[k]]))}:null;
   return {sessionID:r.sessionID,parentID:r.parentID,agent:r.agent,model:r.model,since:r.since,status:r.status,
    totals:{...r.totals},requests:{...r.requests},latest:r.latest,lastRetry:r.lastRetry,currentRun,partial:!!r.partial,
    groupsTruncated:!!r.groupsTruncated,timing:{modelMs:r.timingComplete?duration(intervals.model):null,toolMs:r.timingComplete?duration(intervals.tool):null},
    groups:[...r.groups.values()].map(g=>({...g}))};
  });
  const groups=new Map();for(const r of sessions)for(const g of r.groups){const key=JSON.stringify([g.agent,g.model]);const previous=groups.get(key);groups.set(key,previous?{...g,...sum([previous,g])}:g);}
  const complete=family.every(r=>r.timingComplete);
  return {schemaVersion:1,trackingStarted:this.startedAt,now,available:family.length>0,connected:this.connected,evictedSessions:this.evictedSessions,
   totals:sum(sessions.map(r=>r.totals)),timing:{modelMs:complete?duration(all.model):null,toolMs:complete?duration(all.tool):null},
   sessions,groups:[...groups.values()]};
 }
}
