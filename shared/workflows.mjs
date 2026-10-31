import {validateCommands,commandInput} from './app-commands.mjs';
const fail=message=>{throw Object.assign(Error(message),{status:400});};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
export const safePath=value=>typeof value==='string'&&value.length<200&&/^[a-zA-Z0-9_$-]+(?:\.[a-zA-Z0-9_$-]+)*$/.test(value)&&!value.split('.').some(key=>['__proto__','prototype','constructor'].includes(key));
export function valueAt(value,path){if(!path)return value;return path.split('.').reduce((value,key)=>value!=null&&Object.hasOwn(Object(value),key)?value[key]:undefined,value);}
export function workflowDefinition(input){
 if(!plain(input)||typeof input.title!=='string'||!input.title.trim()||input.title.length>120)fail('Give the workflow a name (up to 120 characters)');
 if(input.description!==undefined&&(typeof input.description!=='string'||input.description.length>500))fail('Keep the description under 500 characters');
 const schema=validateCommands([{id:'inputs',title:'Inputs',inputs:input.inputs||[],handler:{type:'open'}}])[0].inputs;
 if(!Array.isArray(input.steps)||input.steps.length>20)fail('A workflow supports up to 20 steps');
 const ids=new Set(),steps=input.steps.map(step=>{
  if(!plain(step)||!/^[a-z][a-z0-9-]{0,39}$/.test(step.id||'')||ids.has(step.id)||!/^[a-f0-9]{32}$/.test(step.appId||'')||!/^[a-z][a-z0-9.-]{0,63}$/.test(step.commandId||''))fail('Each step needs a unique identity and an app command');
  if(!plain(step.bindings||{}))fail('Step inputs must be an object');const bindings={};
  for(const[name,binding]of Object.entries(step.bindings||{})){
   if(!/^[a-z][a-z0-9.-]{0,63}$/.test(name)||!plain(binding))fail('Invalid input binding');
   if(binding.source==='literal'){if(binding.value===undefined||BufferlessBytes(binding.value)>65536)fail('Literal input is too large');bindings[name]={source:'literal',value:structuredClone(binding.value)};}
   else if(binding.source==='input'){if(!schema.some(field=>field.name===binding.name))fail('Choose an existing workflow input');bindings[name]={source:'input',name:binding.name};}
   else if(binding.source==='step'){if(!ids.has(binding.stepId)||binding.path!==''&&!safePath(binding.path))fail('Results must come from an earlier step using a simple field path');bindings[name]={source:'step',stepId:binding.stepId,path:binding.path||''};}
   else fail('Choose a literal, workflow input or earlier result');
  }
  ids.add(step.id);return{id:step.id,appId:step.appId,commandId:step.commandId,bindings};
 });
 const result={version:1,title:input.title.trim(),description:input.description||'',inputs:schema,steps};if(BufferlessBytes(result)>200000)fail('Workflow definition exceeds 200 KiB');return result;
}
const BufferlessBytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
export const workflowInputs=(definition,input)=>commandInput({inputs:definition.inputs},input);
export function bindStep(step,inputs,outputs){const values={};for(const[name,binding]of Object.entries(step.bindings)){let value;if(binding.source==='literal')value=binding.value;else if(binding.source==='input')value=inputs[binding.name];else value=valueAt(outputs[binding.stepId],binding.path);if(value!==undefined)values[name]=structuredClone(value);else if(binding.source==='step')fail('Step '+step.id+' needs an unavailable result: '+binding.stepId+(binding.path?'.'+binding.path:''));}return values;}
export const commandEffect=command=>command.handler.type==='query'?'read':command.effect||'write';
