import { api } from '../api';
import type { WorldObject } from '../types';
import { adapterGroup, type Adapter } from '../../shared/adapters.mjs';
import { el } from './dom';
import { modal } from './dialogs';

interface Settings { adapters:(Adapter & {configured:boolean})[]; defaults:Record<string,string> }
interface Run { id:string; status:string; error:string; object?:WorldObject }
export function adaptersDialog(toast:(message:string)=>void) {
  const body=el('div',{class:'adapters-panel'}), dialog=modal('Adapters',body);
  const paint=async()=>{
    const state=await api<Settings>('/v1/adapters');
    if(!dialog.node.isConnected)return;
    body.replaceChildren(el('p',{class:'adapters-intro'},'Adapters create linked representations for your apps. Publish adapters from your workspace, then enable the methods you want to use.'));
    if(!state.adapters.length)body.append(el('p',{class:'collection-empty'},'No adapters installed.'));
    for(const adapter of state.adapters) {
      const group=adapterGroup(adapter), selected=state.defaults[group]||state.adapters.find(a=>a.configured&&adapterGroup(a)===group)?.id;
      const mutate=async(path:string,value:unknown)=>{try{await api(path,{method:'PUT',body:JSON.stringify(value)});await paint();}catch(error){toast((error as Error).message);}};
      body.append(el('section',{class:'adapter-setting'},el('strong',{},adapter.title),el('p',{},adapter.description||adapter.name),el('small',{},(adapter.input.fileTypes?.join(', ')||adapter.input.kind||'Structured data')+' → '+adapter.output.label),el('div',{class:'modal-actions'},el('span',{class:'adapter-status'},adapter.configured?(selected===adapter.id?'Default · '+adapter.name:adapter.name):'Setup required or disabled'),...(adapter.configured&&selected!==adapter.id?[el('button',{class:'text-button',onclick:()=>void mutate('/v1/adapters/default',{adapterId:adapter.id})},'Use by default')]:[]),el('button',{class:'button',onclick:()=>void mutate('/v1/adapters/'+adapter.id+'/activation',{enabled:!adapter.configured})},adapter.configured?'Disable':'Enable'))));
    }
  };
  void paint().catch(error=>toast(error.message));
  return dialog;
}
export async function adaptObject(source:WorldObject,adapter:Adapter,progress:(message:string)=>void):Promise<WorldObject> {
  progress('Creating '+adapter.output.label.toLowerCase()+'…');
  let run=await api<Run>('/v1/adapters/run',{method:'POST',body:JSON.stringify({sourceId:source.id,group:adapterGroup(adapter)})});
  while(run.status==='pending'||run.status==='starting') {
    await new Promise(resolve=>setTimeout(resolve,1500));
    run=await api<Run>('/v1/adapter-runs/'+run.id+'/poll',{method:'POST',body:'{}'});
  }
  if(run.status!=='completed'||!run.object)throw Error(run.error||'This adapter did not produce a representation');
  return run.object;
}
