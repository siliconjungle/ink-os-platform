import type{Adapter}from '../../shared/adapters.mjs';
import{fileType}from '../../shared/file-apps.mjs';
import{appManifest}from '../../shared/app-desktop.mjs';
import { desktopFile } from '../../shared/desktop-placements.mjs';
import { el, icon } from './dom';
import { modal } from './dialogs';
import type { Environment } from './contracts';
import type { WorldObject } from '../types';
import './files.css';

export function filesDialog(env: Environment, place: (object: WorldObject) => void, importFiles: () => void, remove?: (object:WorldObject)=>Promise<void>) {
  const search = el('input', { type: 'search', placeholder: 'Search files', 'aria-label': 'Search files' });
  const list = el('div', { class: 'native-file-library', role: 'list', 'aria-label': 'Files' });
  const body = el('div', { class: 'create-dialog' }, el('div', { class: 'native-file-library-tools' }, search, el('button', { class: 'button', onclick: importFiles }, 'Import files…')), list);
  const dialog = modal('Files', body);
  const paint = () => {
    const query = search.value.trim().toLowerCase();
    const files = env.world.list().filter(desktopFile).filter(file => !query || (file.title + '\n' + file.body).toLowerCase().includes(query));
    list.replaceChildren();
    if (!files.length) list.append(el('p', { class: 'collection-empty' }, query ? 'No matching files' : 'No files yet. Import files to keep them here.'));
    for (const object of files.slice(0, 500)) {
      const open = el('button', { class: 'native-file-library-name', onclick: () => { env.open(object); dialog.close(); }, draggable: true, 'data-object-id': object.id }, object.title || 'Untitled file');
      open.addEventListener('dragstart', event => { event.dataTransfer?.setData('application/x-ink-object', object.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'link'; dialog.node.style.pointerEvents = 'none'; dialog.node.style.opacity = '.45'; });
      open.addEventListener('dragend', () => { dialog.node.style.pointerEvents = ''; dialog.node.style.opacity = ''; });
      const add = el('button', { class: 'text-button', 'aria-label': 'Place ' + (object.title || 'Untitled file') + ' on this desktop', onclick: () => { place(object); dialog.close(); } }, 'Place on desktop');
      list.append(el('div', { class: 'native-file-library-row', role: 'listitem' }, open, el('small', {}, object.kind), el('a',{class:'text-button',href:'/api/v1/files/'+object.id+'/content?download=1',download:object.source||object.title},'Download'), add, remove?el('button',{class:'text-button',onclick:()=>void remove(object).catch(error=>env.toast(error.message))},'Delete'):undefined));
    }
  };
  search.addEventListener('input', paint);
  const stop = env.world.subscribe(event => { if (event.type === 'objects' || event.type === 'ready') paint(); });
  dialog.node.addEventListener('closed', stop); paint();
  return dialog;
}

export function fileTypeLabel(type:string){return type.startsWith('.')?type.slice(1).toUpperCase()+' files':type.endsWith('/*')?type.split('/')[0][0].toUpperCase()+type.split('/')[0].slice(1)+' files':type==='text/plain'?'Plain text':type==='application/json'?'JSON files':type==='application/octet-stream'?'Files':type;}
export function openWithDialog(file: WorldObject, apps: WorldObject[], open: (app: WorldObject, remember: boolean) => void|Promise<void>, selectDefault=false,currentAppId?:string, adapted?:{choices:{app:WorldObject;adapter:Adapter}[];open:(app:WorldObject,adapter:Adapter)=>Promise<void>;manage:()=>void}) {
 const type=fileTypeLabel(fileType(file)),remember=el('input',{type:'checkbox'}),error=el('p',{class:'inline-error',role:'alert',hidden:true}),list=el('div',{class:'open-with-apps','aria-label':'Compatible apps'}),body=el('div',{class:'open-with-body'}),dialog=modal(selectDefault?'Default app':'Open with',body);
 dialog.node.querySelector('.modal')!.classList.add('open-with-modal');
 body.append(el('div',{class:'open-with-file'},el('span',{class:'open-with-file-glyph'},icon('note',24)),el('div',{},el('strong',{title:file.title||'Untitled file'},file.title||'Untitled file'),el('small',{},type))),list);
 if(!apps.length&&!adapted?.choices.length)list.append(el('p',{class:'collection-empty'},'No compatible apps installed.'));
 for(const app of apps){const current=app.id===currentAppId;list.append(el('button',{class:'file-app-choice','aria-label':(selectDefault?'Use ':'Open with ')+app.title,onclick:async()=>{const buttons=[...body.querySelectorAll('button')];buttons.forEach(button=>button.disabled=true);try{await open(app,selectDefault||remember.checked);dialog.close();}catch(reason){error.hidden=false;error.textContent=(reason as Error).message;buttons.forEach(button=>button.disabled=false);}}},el('span',{class:'file-app-choice-icon'},icon(appManifest(app).desktop?.icon||'grid',28)),el('span',{class:'file-app-choice-name'},app.title),current?el('small',{class:'file-app-current'},'Default'):icon('chevron-right',14)));}
 if(adapted&&!selectDefault){for(const {app,adapter}of adapted.choices){const label=app.title+' · '+adapter.output.label+' via '+adapter.operation;list.append(el('button',{class:'file-app-choice file-adapter-choice','aria-label':label,onclick:async()=>{const buttons=[...body.querySelectorAll('button')];buttons.forEach(button=>button.disabled=true);error.hidden=true;const status=el('p',{class:'adapter-progress',role:'status'},'Creating '+adapter.output.label.toLowerCase()+'…');body.append(status);try{await adapted.open(app,adapter);dialog.close();}catch(reason){error.hidden=false;error.textContent=(reason as Error).message;buttons.forEach(button=>button.disabled=false);}finally{status.remove();}}},el('span',{class:'file-app-choice-icon'},icon(appManifest(app).desktop?.icon||'grid',28)),el('span',{class:'file-app-choice-name'},el('span',{},app.title),el('small',{},adapter.output.label+' via '+adapter.operation),el('small',{class:'adapter-method'},adapter.name)),icon('chevron-right',14)));}body.append(el('button',{class:'text-button adapter-manage',onclick:adapted.manage},'Manage adapters…'));}
 if(apps.length&&!selectDefault)body.append(el('label',{class:'open-with-remember'},remember,el('span',{},'Remember direct app choice for '+(fileType(file).startsWith('.')?type:type.toLowerCase()))));
 body.append(error);queueMicrotask(()=>list.querySelector<HTMLButtonElement>('button')?.focus());return dialog;
}
