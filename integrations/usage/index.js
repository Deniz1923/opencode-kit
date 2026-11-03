import {UsageCollector,EVENT_TYPES} from './collector.mjs';
import {Usage} from './rpc.js';

export function createUsagePlugin(){return {
 id:'opencode-kit.usage',
 async setup(ctx){
  const collector=new UsageCollector();let closed=false;
  const known=new Set();
  async function metadata(id){
   if(known.has(id)&&collector.records.has(id))return;
   const info=await ctx.session.get({sessionID:id});
   collector.ensure(id,{parentID:info.parentID,agent:typeof info.agent==='string'?info.agent:info.agent?.id,model:info.model});
   known.add(id);if(known.size>1000)known.delete(known.values().next().value);
  }
  // Metrics must not change inference decisions, results, retry policy or permissions.
  const observe=fn=>async e=>{try{await metadata(e.sessionID);fn(e);}catch{collector.connected=false;}};
  await ctx.session.hook('model.request',observe(e=>collector.modelRequest(e)));
  await ctx.session.hook('http.request',observe(e=>collector.httpRequest(e)));
  await ctx.session.hook('retry',observe(e=>collector.retry(e)));
  await ctx.tool.hook('execute.before',observe(e=>collector.toolStart(e)));
  await ctx.tool.hook('execute.after',observe(e=>collector.toolEnd(e)));
  await ctx.rpc.register(Usage,{
   snapshot:async({sessionID})=>collector.snapshot(sessionID),
   reset:async({sessionID})=>{
    if(collector.family(sessionID).some(r=>r.activeModels.size||r.activeTools.size||r.status==='running'))return {reset:false};
    collector.reset(sessionID);return {reset:true};
   },
  });
  const iterator=ctx.event.subscribe({types:EVENT_TYPES})[Symbol.asyncIterator]();
  const run=async()=>{
   while(!closed){const item=await iterator.next();if(item.done)break;if(!closed)collector.event(item.value);}
   if(!closed)collector.connected=false;
  };
  void run().catch(()=>{collector.connected=false;});
  return async()=>{closed=true;await iterator.return?.();};
 },
};}
export default createUsagePlugin();
