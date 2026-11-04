/** Resolve by displayed order, including renamed, reordered and non-contiguous desktops. */
export function adjacentWorkspace(workspaces, current, step) {
  if (step !== -1 && step !== 1) return undefined;
  const index = workspaces.findIndex(space => space.id === current);
  if (index < 0) return undefined;
  return workspaces[index + step]?.id;
}

/** One switch per horizontal wheel burst, including its momentum tail. */
export class WorkspaceSwipe {
  constructor({threshold = 80, idleMs = 280} = {}) {
    this.threshold = threshold;
    this.idleMs = idleMs;
    this.reset();
  }
  reset() {this.last = -Infinity; this.x = 0; this.y = 0; this.fired = false; this.axis = undefined;}
  wheel({deltaX, deltaY, deltaMode = 0, ctrlKey, metaKey, altKey, shiftKey}, now) {
    if (![deltaX, deltaY, now].every(Number.isFinite) || ctrlKey || metaKey || altKey || shiftKey) {this.reset(); return {consume:false, step:0};}
    if (now - this.last > this.idleMs || now < this.last) this.reset();
    this.last = now;
    const scale = deltaMode === 1 ? 16 : deltaMode === 2 ? 800 : 1;
    this.x += deltaX * scale;
    this.y += deltaY * scale;
    if (!this.axis && Math.max(Math.abs(this.x), Math.abs(this.y)) >= 8) {
      this.axis = Math.abs(this.x) > Math.abs(this.y) * 1.5 ? 'horizontal' : 'vertical';
    }
    if (!this.axis) return {consume:Math.abs(deltaX) > Math.abs(deltaY) * 1.5, step:0};
    if (this.axis !== 'horizontal') return {consume:false, step:0};
    if (this.fired || Math.abs(this.x) < this.threshold) return {consume:true, step:0};
    this.fired = true;
    return {consume:true, step:this.x > 0 ? 1 : -1};
  }
}

/** Reserve a vertical stroke only when it starts on desktop chrome. */
export class OverviewSwipe {
  constructor({threshold=100,idleMs=280}={}) {
    this.idleMs=idleMs;
    this.tracker=new WorkspaceSwipe({threshold,idleMs});
    this.reset();
  }
  reset() {this.tracker.reset();this.last=-Infinity;this.eligible=undefined;}
  wheel(event,now,eligible) {
    if(now-this.last>this.idleMs||now<this.last)this.reset();
    this.last=now;
    if(this.eligible===undefined&&(event.deltaX||event.deltaY))this.eligible=eligible;
    const result=this.tracker.wheel({deltaX:event.deltaY,deltaY:event.deltaX,deltaMode:event.deltaMode,
      ctrlKey:event.ctrlKey,metaKey:event.metaKey,altKey:event.altKey,shiftKey:event.shiftKey},now);
    return this.eligible?result:{consume:false,step:0};
  }
}
