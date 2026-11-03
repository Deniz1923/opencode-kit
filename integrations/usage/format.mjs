const n=v=>typeof v==='number'&&Number.isFinite(v)?v.toLocaleString('en-US',{maximumFractionDigits:2}):'unknown';
const money=v=>typeof v==='number'&&Number.isFinite(v)?'$'+v.toFixed(v>0&&v<0.01?6:2):'unknown';
export const time=v=>typeof v==='number'&&Number.isFinite(v)?v<1000?Math.round(v)+'ms':v<60000?(v/1000).toFixed(1)+'s':Math.floor(v/60000)+'m '+Math.floor(v%60000/1000)+'s':'unknown';
export const modelName=m=>m?m.providerID+'/'+m.id+(m.variant?' · '+m.variant:''):'unknown';
// A normalized cache zero may be a missing provider field. Never call it a cache miss.
const cache=v=>v>0?n(v):'unknown (host reports '+n(v)+')';
export function formatUsage(snapshot) {
 if(!snapshot.available)return ['No observed requests for this session yet.','Tracking starts with new activity; old chats are never scanned.'];
 const selected=snapshot.sessions[0],latest=selected?.latest,t=snapshot.totals;
 const partial=t.missingUsage||t.unreportedAuxiliary;
 const known=v=>t.usageReports>t.missingUsage?n(v)+(partial?' (known subtotal)':''):'unknown';
 const lines=[`Tracking since ${new Date(Math.min(...snapshot.sessions.map(s=>s.since))).toLocaleTimeString()} · live metadata only`,
  `Agent: ${selected.agent} · Model: ${modelName(selected.model)}`,
  `Status: ${selected.status} · Latest run: ${selected.currentRun?time(selected.currentRun.elapsedMs):'not observed'}`,
  '', 'Latest completed primary request'];
 if(selected.currentRun){const r=selected.currentRun.totals;lines.splice(3,0,`Latest run counters (selected session): ${n(r.modelCalls)} calls · ${n(r.httpAttempts)} HTTP attempts · ${n(r.retries)} retries · ${n(r.tools)} tools`);}
 if(latest){const u=latest.tokens;
  lines.push(`Model: ${modelName(latest.model)} · ${latest.status}`,`Input (OpenCode): ${n(u.input===null?null:u.input+(u.cacheRead??0)+(u.cacheWrite??0))}`,
   `  Uncached: ${n(u.input)}`,`  Cache read: ${cache(u.cacheRead)} · write: ${cache(u.cacheWrite)}`,
   `Output: ${n(u.output)} · Reasoning: ${n(u.reasoning)}`,`First output stream boundary: ${time(latest.firstOutputMs)}`,
   `OpenCode cost: ${money(latest.cost)} (may be estimated)`);
 }else lines.push('No completed primary request observed.');
 lines.push('',`Observed session family (${snapshot.sessions.length} session${snapshot.sessions.length===1?'':'s'})`,
  `Model calls: ${n(t.modelCalls)} · HTTP attempts: ${n(t.httpAttempts)} · Retries: ${n(t.retries)}`,
  `Completed/failed steps: ${n(t.steps)} · Tools started: ${n(t.tools)}`,
  `Input: ${known(t.input+t.cacheRead+t.cacheWrite)} · uncached: ${known(t.input)}`,
  `Cache read: ${cache(t.cacheRead)} · write: ${cache(t.cacheWrite)}`,
  `Output: ${known(t.output)} · Reasoning: ${known(t.reasoning)}`,
  `OpenCode cost: ${t.usageReports>t.missingUsage?money(t.cost)+(partial?' (known subtotal)':''):'unknown'} · Provider billing: unknown`,
  `Primary model wait/stream wall time: ${time(snapshot.timing.modelMs)} · Tool wall time: ${time(snapshot.timing.toolMs)}`,
  'Parallel intervals are merged; model/tool time can overlap.');
 const retries=snapshot.sessions.filter(s=>s.lastRetry);
 for(const s of retries)lines.push(`Last retry (${s.agent}): attempt ${n(s.lastRetry.attempt)} · ${s.lastRetry.reason}`);
 if(snapshot.groups.length){lines.push('','By agent / model');for(const g of snapshot.groups)lines.push(`${g.agent} · ${modelName(g.model)}: ${n(g.modelCalls)} calls, ${g.usageReports>g.missingUsage?n(g.input+g.cacheRead+g.cacheWrite):'unknown'} input, ${g.usageReports>g.missingUsage?n(g.output+g.reasoning):'unknown'} output, ${n(g.retries)} retries, ${n(g.tools)} tools`);}
 const auxiliary=Object.entries(selected.requests).filter(([kind])=>kind!=='primary');
 if(auxiliary.length)lines.push('','Auxiliary calls: '+auxiliary.map(([kind,count])=>`${kind} ${count}`).join(', '));
 if(t.unreportedAuxiliary)lines.push(`Auxiliary usage unreported for ${n(t.unreportedAuxiliary)} call(s); token/cost totals are known subtotals.`);
 lines.push('','Counts cover activity observed by this plugin, not historical or invoice totals.','Failed retries may consume tokens the provider never reports. Zero cache counts do not establish a cache miss.');
 if(t.missingUsage || snapshot.sessions.some(s=>s.partial||s.groupsTruncated)||snapshot.evictedSessions)lines.push('Some metadata is missing or was evicted by memory limits; totals may be incomplete.');
 if(!snapshot.connected)lines.push('Metadata stream disconnected; reopen after reconnecting.');
 return lines;
}
