import{applicationWindow}from'./file-apps.mjs';
import{materializeDesktopIntents}from'./desktop-startup.mjs';
import{StateReplica}from'./state-replica.mjs';
import{desktopWrites,projectDesktop,emptyLayout,sameWindow}from'./desktop-layout.mjs';

// Business logic has no DOM or transport singleton. Tests exercise the same
// command/projection boundary used by the compositor with controlled delivery.
export class DesktopSync{
 constructor(compositor,dock,host,{personalWindows=true}={}){
  Object.assign(this,{compositor,dock,host,personalWindows});this.applying=false;this.initialized=false;this.projected=false;this.known=emptyLayout();this.pendingKnown=this.snapshot();this.pendingSaved=Promise.resolve();this.onError=()=>{};this.workspaceMoves=new Set();
  compositor.onWorkspaceMove=id=>this.noteWorkspaceMove(id);
  this.replica=new StateReplica({host,key:'desktop',onChange:()=>this.reconcile(),onError:error=>this.onError(error)});
 }
 snapshot(){const c=this.compositor;return structuredClone({windows:this.personalWindows?[]:c.windows,workspaces:c.workspaces,icons:{},placements:c.placements,pins:c.pins||{},...(!this.personalWindows&&this.dock?{dockOrder:this.dock.get()}:{})});}
 noteWorkspaceMove(id){this.workspaceMoves.add(id);}
 async start(){await this.replica.open();let saved;do{saved=this.pendingSaved;await saved;await this.replica.rebaseIntents(materializeDesktopIntents);}while(saved!==this.pendingSaved);this.initialized=true;return this.replica.state.get('/schema')>=2;}
 capture(){
  if(this.applying)return;
  const options={workspaceMoves:[...this.workspaceMoves],personalWindows:this.personalWindows};this.workspaceMoves.clear();
  if(!this.initialized){
   const next=this.withoutGesture(this.snapshot(),this.pendingKnown);if(JSON.stringify(next)===JSON.stringify(this.pendingKnown))return;
   const actor=String(crypto.getRandomValues(new BigUint64Array(1))[0]||1n),intent={id:crypto.randomUUID(),actor,before:this.pendingKnown,after:next,options};this.pendingKnown=next;
   this.pendingSaved=this.pendingSaved.then(()=>this.host.stageIntent('os','desktop',intent));this.pendingSaved.catch(this.onError);return;
  }
  const next=this.withoutGesture(this.snapshot()),writes=desktopWrites(this.known,next,this.replica.state,options);this.known=next;this.projected=true;if(writes.length)void this.replica.commit(writes);
 }
 withoutGesture(layout,baseline=this.known){
  const gesture=this.compositor.gesture;if(!gesture)return layout;
  const value=structuredClone(layout),window=value.windows.find(w=>w.key===gesture.key),before=baseline.windows.find(w=>w.key===gesture.key);
  if(window&&before){window.workspace=before.workspace;if(gesture.edge==='move'){window.x=before.x;window.y=before.y;window.maximized=before.maximized;window.restore=before.restore;}else{window.width=before.width;window.height=before.height;if(gesture.edge.includes('w'))window.x=before.x;if(gesture.edge.includes('n'))window.y=before.y;}}
  return value;
 }
 reconcile(){
  if(!this.initialized||this.applying)return;
  // Capture authored changes before projecting incoming state. Never do this for
  // the first projection: a restored browser cache is not a fresh user command.
  if(this.projected)this.capture();
  if(this.personalWindows){this.applying=true;try{const c=this.compositor,layout=projectDesktop(this.replica.state);if(!layout.workspaces.length)return;c.workspaces=layout.workspaces;const valid=new Set(c.workspaces.map(space=>space.id));if(!valid.has(c.workspace))c.workspace=c.workspaces[0].id;for(const window of c.windows)if(!valid.has(window.workspace))window.workspace=c.workspace;c.placements=layout.placements||{};c.pins=layout.pins||{};c.visibility();c.persist();this.known=this.snapshot();this.projected=true;}finally{this.applying=false;}return;}
  this.applying=true;let migrated=false;
  try{
   const c=this.compositor,layout=projectDesktop(this.replica.state),previous=structuredClone(layout);
   if(c.env.world.loaded){layout.windows=layout.windows.flatMap(window=>{const next=applicationWindow(c.env.world.list(),window);if(next!==window)migrated=true;return next?[next]:[];});layout.windows=layout.windows.filter(window=>!window.appId||!!c.env.world.get(window.appId));}
   if(!layout.workspaces.length)return;
   c.workspaces=layout.workspaces;if(!layout.workspaces.some(space=>space.id===c.workspace))c.workspace=layout.workspaces[0].id;
   const wanted=new Set(layout.windows.map(window=>window.key));for(const window of [...c.windows])if(!wanted.has(window.key))c.close(window.key,false);
   for(const remote of layout.windows){
    const scene=c.scenes.get(remote.key);
    if(!scene)c.mount({...remote});
    else if(!sameWindow(scene.model,remote)){
     const changed=JSON.stringify(scene.model.route)!==JSON.stringify(remote.route)||scene.model.appId!==remote.appId,gesture=c.gesture?.key===remote.key?c.gesture:undefined,local={...scene.model};
     Object.assign(scene.model,remote,{z:local.z});
     if(gesture){scene.model.workspace=local.workspace;if(gesture.edge==='move'){scene.model.x=local.x;scene.model.y=local.y;scene.model.maximized=local.maximized;scene.model.restore=local.restore;}else{scene.model.width=local.width;scene.model.height=local.height;if(gesture.edge.includes('w'))scene.model.x=local.x;if(gesture.edge.includes('n'))scene.model.y=local.y;}}
     if(changed)c.changeRoute(remote.key,remote.route,false);c.paint(scene);c.updateTitle(scene);
    }
    c.z=Math.max(c.z,remote.z,c.scenes.get(remote.key)?.model.z||0);
   }
   c.placements=layout.placements||{};this.dock?.set(layout.dockOrder||{});c.visibility();c.persist();this.known=structuredClone(migrated?previous:layout);this.projected=true;
  }finally{this.applying=false;}
  if(migrated)this.capture();
 }
 destroy(){void this.replica.close();}
}
