import{isAppRegistration}from './app-desktop.mjs';
const objectId = /^[a-f0-9]{32}$/;
const finite = value => Number.isFinite(value) && Math.abs(value) < 1e8;
export function validPlacement(point) { return !!point && finite(point.x) && finite(point.y); }
export function placementMaps(input, workspaces) {
  const result = {}, allowed = new Set(workspaces.map(space => String(space.id)));
  for (const [space, entries] of Object.entries(input || {})) {
    if (!allowed.has(space) || !entries || typeof entries !== 'object') continue;
    const positions = {};
    for (const [id, point] of Object.entries(entries)) if (objectId.test(id) && validPlacement(point)) positions[id] = { x: point.x, y: point.y };
    result[space] = positions;
  }
  return result;
}
export function migratePlacements(input, icons, workspaces) {
  if (input !== undefined) return placementMaps(input, workspaces);
  return placementMaps(workspaces.length ? { [workspaces[0].id]: icons || {} } : {}, workspaces);
}
export function desktopFile(object) {
  return !!object && !object.archived && ['file', 'note', 'image', 'audio', 'video', 'code', 'link'].includes(object.kind) && !object.tags?.includes('app-source');
}
export function placedObjects(objects, positions) {
  return objects.filter(object => !object.archived && Object.hasOwn(positions, object.id) && (isAppRegistration(object) || desktopFile(object)));
}

// A clipboard move is one command, including its source removal. Record only
// affected entries so undo does not replace a collaborator's whole arrangement.
export function placementTransfer(placements, workspaces, ids, {from, to, cut=false, point}) {
  if (!workspaces.some(space=>space.id===to) || from===to) return {before:[],after:[]};
  const before=[],after=[],source=placements[from]||{},target=placements[to]||{};
  const keys=[...new Set(ids)].filter(id=>objectId.test(id)),anchor=source[keys[0]]||point;
  for (const id of keys) {
    if (!target[id]) {
      const position=source[id]||anchor;
      before.push({space:to,id});
      after.push({space:to,id,point:{x:point.x+position.x-anchor.x,y:point.y+position.y-anchor.y}});
    }
    if (cut && source[id]) {
      before.push({space:from,id,point:{...source[id]}});
      after.push({space:from,id});
    }
  }
  return {before,after};
}
export function applyPlacementChanges(placements, workspaces, changes) {
  const allowed=new Set(workspaces.map(space=>space.id));
  for (const {space,id,point} of changes) {
    if (!allowed.has(space)) continue;
    if (point) (placements[space]||={})[id]={...point};
    else delete placements[space]?.[id];
  }
}

// A drag uses its actual release coordinates, including for an existing target
// placement. Only the selected entries participate in the reversible transaction.
export function placementMove(placements, workspaces, ids, {from,to,positions}) {
  const before=[],after=[];
  if(from===to||![from,to].every(id=>workspaces.some(space=>space.id===id)))return{before,after};
  for(const id of new Set(ids)){
    const source=placements[from]?.[id],target=placements[to]?.[id],point=positions[id];
    if(!objectId.test(id)||!source||!validPlacement(point))continue;
    before.push({space:from,id,point:{...source}},{space:to,id,...(target?{point:{...target}}:{})});
    after.push({space:from,id},{space:to,id,point:{...point}});
  }
  return{before,after};
}
