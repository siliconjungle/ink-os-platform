import {adjacentWorkspace} from '../../shared/workspace-gestures.mjs';
import type {Compositor} from './compositor';
import type {GestureMotion} from '../../shared/gesture-drag.mjs';

export function workspaceDrag(c:Compositor):GestureMotion {
  c.workspaceTransition.finish();
  const source=c.workspace,span=Math.max(240,Math.min(600,(c.stage.parentElement?.clientWidth||innerWidth)*.45));
  let side=0,motion:ReturnType<typeof c.workspaceTransition.scrub>|undefined;
  return {
    move(distance){
      const direction=Math.sign(distance);
      if(direction!==side){
        motion?.cancel();motion=undefined;side=direction;
        const target=adjacentWorkspace(c.workspaces,source,direction);
        if(target!==undefined)motion=c.workspaceTransition.scrub(direction,
          ()=>{void c.switchWorkspace(target,{animate:false});},
          accept=>{void c.switchWorkspace(accept?target:source,{animate:false});});
      }
      motion?.move(Math.abs(distance)/span);
    },
    end(cancelled,velocity=0){motion?.end(cancelled,velocity*side);}
  };
}
