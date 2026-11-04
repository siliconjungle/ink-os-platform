/** Capture outgoing app pixels before inactive frames are parked/destroyed. */
export class WorkspaceTransition {
  constructor(document, reducedMotion = () => document.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    this.document = document;
    this.reducedMotion = reducedMotion;
    this.active = undefined;
  }
  finish() {
    const active = this.active;
    if (!active) return;
    active.commit();
    active.view.skipTransition();
    active.cleanup();
    this.active = undefined;
    delete this.document.documentElement.dataset.workspaceSlide;
  }
  run(direction, update, cleanup = () => {}) {
    this.finish();
    let committed = false;
    const commit = () => {if (!committed) {committed = true; update();}};
    const document = this.document;
    if (!document.startViewTransition || this.reducedMotion() || document.visibilityState === 'hidden') {
      commit();
      cleanup();
      return Promise.resolve();
    }
    document.documentElement.dataset.workspaceSlide = typeof direction === 'string' ? direction : direction > 0 ? 'next' : 'previous';
    let view;
    try {view = document.startViewTransition(commit);}
    catch {delete document.documentElement.dataset.workspaceSlide; commit(); cleanup(); return Promise.resolve();}
    const active = {view, commit, cleanup};
    this.active = active;
    // Skip an interrupted animation without losing its update or clearing a newer one's styles.
    view.ready.catch(() => {});
    view.finished.catch(() => {}).then(() => {
      if (this.active !== active) return;
      this.active = undefined;
      cleanup();
      delete document.documentElement.dataset.workspaceSlide;
    });
    return view.updateCallbackDone;
  }
}
