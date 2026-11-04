import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {World} from '../server/world.mjs';
import {desktopManifest} from '../shared/app-desktop.mjs';
import {fileApps,preferredFileApp,fileLaunch,previewableObject} from '../shared/file-apps.mjs';
import {desktopCommand} from '../shared/desktop-keys.mjs';
import {setFileDefault,fileDefaults,reconcileFileDefaults,resolveFileDefault,clearAppDefaults} from '../server/file-defaults.mjs';
import {previewKind} from '../sdk/src/file-preview.js';

const app=(digit,title,fileTypes,previewTypes)=>({id:digit.repeat(32),namespace:'os',kind:'app',title,created:Number(digit),tags:[],body:JSON.stringify({releaseId:'a'.repeat(64),desktop:{entry:'app',fileTypes,...(previewTypes?{preview:{fileTypes:previewTypes}}:{})}})});
const file={id:'f'.repeat(32),namespace:'os',kind:'file',title:'notes.txt',source:'notes.txt',tags:[],body:JSON.stringify({mime:'text/plain'})};

test('preview is an explicit app capability with a separate provider and default',()=>{
 const editor=app('1','Editor',['text/*']),viewer=app('2','Viewer',['*'],['*']),other=app('3','Other',['text/*'],['text/*']);
 assert.deepEqual(fileApps([editor,viewer],file,'preview').map(app=>app.id),[viewer.id]);
 assert.equal(preferredFileApp([editor,viewer],file,{},'open').id,editor.id);
 assert.equal(preferredFileApp([editor,viewer],file,{'.txt':editor.id},'preview').id,viewer.id);
 assert.equal(preferredFileApp([viewer,other],file,{'.txt':viewer.id},'preview').id,viewer.id);
 assert.deepEqual(fileLaunch(viewer,file,'preview').route,{app:'app',id:file.id,mode:'preview'});
 assert.deepEqual(desktopManifest({preview:{fileTypes:['text/*','text/*']}}).preview,{fileTypes:['text/*']});
 for(const preview of [true,{}, {fileTypes:[]},{fileTypes:['not a MIME']}])assert.throws(()=>desktopManifest({preview}));
 assert.equal(previewableObject({...file,kind:'palette-analysis',namespace:other.id}),true);
 assert.equal(previewableObject(editor),false);
 const table=app('4','Tables',[],['ink-table']),record={...file,kind:'ink-table',source:'',namespace:table.id,body:'{}'};assert.equal(preferredFileApp([viewer,table],record,{'application/octet-stream':viewer.id},'preview').id,table.id);
});

test('Space previews a selection without consuming typing, controls, empty scopes or repeats of Open',()=>{
 const key=(name,options={})=>({key:name,...options});
 assert.equal(desktopCommand(key(' '),false,{hasObjects:true}),'selection.preview');
 assert.equal(desktopCommand(key(' '),true,{hasObjects:true}),undefined);
 assert.equal(desktopCommand(key(' '),false,{hasObjects:false}),undefined);
 const button={closest:()=>({matches:()=>false})};
 assert.equal(desktopCommand(key(' ',{target:button}),false,{hasObjects:true}),undefined);
 const item={closest:()=>({matches:selector=>selector==='[data-object-id]'})};
 assert.equal(desktopCommand(key(' ',{target:item}),false,{hasObjects:true}),'selection.preview');
 assert.equal(desktopCommand(key(' ',{metaKey:true}),false,{hasObjects:true}),undefined);
 assert.equal(desktopCommand(key(' ',{shiftKey:true}),false,{hasObjects:true}),undefined);
 assert.equal(desktopCommand(key('Enter'),false,{hasObjects:true}),'open');
});

test('open and preview choices survive restart independently and stale providers recover',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'ink-quick-look-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let world=await new World(directory).open(),platform={world};
 const editor=app('1','Editor',['text/*']),viewer=app('2','Viewer',['*'],['*']),other=app('3','Other',['text/*'],['text/*']);
 for(const object of [editor,viewer,other,file])await world.put(object,{writer:'os'});
 await setFileDefault(platform,{fileId:file.id,appId:editor.id});
 await setFileDefault(platform,{fileId:file.id,appId:viewer.id},'preview');
 await assert.rejects(setFileDefault(platform,{fileId:file.id,appId:editor.id},'preview'),/support|cannot open/);
 assert.equal((await resolveFileDefault(platform,file.id)).appId,editor.id);
 assert.equal((await resolveFileDefault(platform,file.id,'preview')).appId,viewer.id);
 await world.persist();world=await new World(directory).open();platform={world};
 assert.equal(fileDefaults(world)['.txt'],editor.id);
 assert.equal(fileDefaults(world,undefined,'preview')['.txt'],viewer.id);
 await clearAppDefaults(platform,viewer.id);
 await world.update(viewer.id,{archived:true},{writer:'os'});
 assert.equal((await resolveFileDefault(platform,file.id,'preview')).appId,other.id);
 assert.equal((await resolveFileDefault(platform,file.id)).appId,editor.id);
 const report={...file,id:'b'.repeat(32),namespace:other.id,kind:'palette-analysis',source:'',title:'Palette',body:'{}'};
 const recordViewer=app('4','Reports',[],['palette-analysis']);await world.put(recordViewer,{writer:'os'});await world.put(report,{writer:other.id});
 await setFileDefault(platform,{fileId:report.id,appId:recordViewer.id},'preview');
 assert.equal((await resolveFileDefault(platform,report.id,'preview')).appId,recordViewer.id);
 assert.ok((await reconcileFileDefaults(platform,'preview')).defaults['palette-analysis']);
});

test('preview renderers classify content without executing it',()=>{
 assert.equal(previewKind({...file,source:'drawing.svg',body:'{"mime":"image/svg+xml"}'}),'image');
 assert.equal(previewKind({...file,source:'program.ink',kind:'code',body:'fn main() {}'}),'text');
 assert.equal(previewKind({...file,source:'document.pdf',body:'{}'}),'pdf');
 assert.equal(previewKind({...file,source:'unknown.bin',body:'{}'}),'metadata');
});
