import {Plugin} from '@opencode/plugin/tui';
import {createSignal,createResource,For,Show,onCleanup} from 'solid-js';
import {Usage} from './rpc.js';
import {formatUsage} from './format.mjs';

function Dashboard(props:{context:any;sessionID:string;close:()=>void;focused?:()=>boolean}){
 const ctx=props.context;
 const location=()=>ctx.data.session.get(props.sessionID)?.location??ctx.location??ctx.data.location.default();
 const api=()=>ctx.client.rpc(Usage);
 const [snapshot,{refetch}]=createResource(()=>props.sessionID,sessionID=>api().snapshot({sessionID},{location:location()}));
 const timer=setInterval(()=>{if(!snapshot.loading)void refetch();},1000);
 onCleanup(()=>clearInterval(timer));
 const reset=async()=>{
  const yes=await ctx.ui.dialog.confirm({title:'Reset observed usage?',message:'Clear only this session family’s usage counters. Your conversation is unchanged.',label:{confirm:'Reset',cancel:'Cancel'}});
  if(!yes)return;
  try{const result=await api().reset({sessionID:props.sessionID},{location:location()});
   if(!result.reset)ctx.ui.toast.show({message:'Wait until the session and its tools finish before resetting counters.',variant:'warning'});
   await refetch();
  }catch{ctx.ui.toast.show({message:'Could not reset counters; try again after reconnecting.',variant:'error'});}
 };
 ctx.keymap.layer(()=>({commands:[
  {bind:'escape',title:'close usage',enabled:()=>props.focused?.()??true,run:props.close},
  {bind:'r',title:'refresh usage',enabled:()=>props.focused?.()??true,run:()=>{void refetch();}},
  {bind:'ctrl+r',title:'reset observed usage',enabled:()=>props.focused?.()??true,run:()=>{void reset();}},
 ]}));
 return <box flexDirection="column" width="100%" height="100%" padding={1} gap={1}>
  <text fg={ctx.theme.text.base}>Usage · Esc close · r refresh · Ctrl+R reset</text>
  <scrollbox flexGrow={1}>
   <Show when={!snapshot.error} fallback={<text fg={ctx.theme.text.feedback.error.base}>Usage unavailable. Press r after reconnecting; no old chats will be loaded.</text>}>
    <Show when={snapshot()} fallback={<text fg={ctx.theme.text.muted}>Connecting to live usage counters…</text>}>
     {value=><For each={formatUsage(value())}>{line=><text fg={ctx.theme.text.base} wrapMode="word">{line||' '}</text>}</For>}
    </Show>
   </Show>
  </scrollbox>
 </box>;
}

export default Plugin.define({id:'opencode-kit.usage.tui',setup(ctx){
 const [previous,setPrevious]=createSignal<any>({type:'home'});
 ctx.ui.router.register({name:'kit-usage',render:({data})=><Dashboard context={ctx} sessionID={String(data?.sessionID??'')} close={()=>ctx.ui.router.navigate(previous())}/>});
 ctx.ui.slot({append:'session.panel',render:input=><Show when={input.name==='kit-usage'}><Dashboard context={ctx} sessionID={input.sessionID} close={input.close} focused={()=>input.focused}/></Show>});
 ctx.keymap.layer(()=>({mode:'global',commands:[{
  id:'opencode-kit.usage.open',title:'Live request usage and retries',group:'OpenCode kit',palette:true,slash:{name:'usage-live',aliases:['kit-usage']},
  run(){const current=ctx.ui.router.current();
   if(current.type!=='session'){ctx.ui.toast.show({message:'Open a session first, then run /usage-live.',variant:'info'});return;}
   if(ctx.ui.panel?.open('kit-usage'))return;
   setPrevious({...current});ctx.ui.dialog.clear();ctx.ui.router.navigate({type:'plugin',name:'kit-usage',data:{sessionID:current.sessionID}});
  },
 }]}));
}});
