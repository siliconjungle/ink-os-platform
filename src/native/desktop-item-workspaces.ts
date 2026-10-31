import{relativePlacement}from'../../shared/desktop-coordinates.mjs';
import{WorkspaceDrop}from './workspace-drop';
import{placementMove,applyPlacementChanges,type PlacementChange}from '../../shared/desktop-placements.mjs';
import type{Desktop}from './desktop';
type Host=Pick<Desktop,'compositor'|'world'|'paintIcons'|'commands'|'shell'>;
export function moveDesktopItems(desktop:Host,ids:string[],from:number,to:number,positions=desktop.compositor.placements[from]||{}){
 const c=desktop.compositor,change=placementMove(c.placements,c.workspaces,ids,{from,to,positions:Object.fromEntries(Object.entries(positions).map(([id,point])=>[id,relativePlacement(point,{width:desktop.shell.clientWidth,height:desktop.shell.clientHeight})]))}),apply=(changes:PlacementChange[])=>{applyPlacementChanges(c.placements,c.workspaces,changes);desktop.paintIcons();c.persist();};
 if(!change.after.length)return;apply(change.after);desktop.commands.record({undo:()=>apply(change.before),redo:()=>apply(change.after)});
}
/** Preview locally; commit source removal and destination placement as one command. */
export function desktopItemDrag(desktop:Host,ids:string[]){
 const c=desktop.compositor,source=c.workspace,original=Object.fromEntries(ids.filter(id=>c.icons[id]).map(id=>[id,{...c.icons[id]}]));
 const chooser=new WorkspaceDrop(c.windows,source,'',c.area,c.workspaces,workspace=>{c.workspace=workspace;c.visibility();},undefined,workspace=>({positions:c.placements[workspace]||{},get:id=>desktop.world.get(id),title:window=>c.title(window),glyph:window=>c.glyph(window)}),true);
 return{
  over(x:number,y:number){chooser.update(x,y);return!!chooser.node;},
  end(cancelled:boolean,positions:Record<string,{x:number;y:number}>){const onChooser=!!chooser.node;chooser.close();if(cancelled){if(c.workspaces.some(space=>space.id===source))c.workspace=source;c.visibility();return true;}
   if(c.workspace===source)return false;
   if(onChooser)positions=original;
   moveDesktopItems(desktop,ids,source,c.workspace,positions);return true;
  }
 };
}
