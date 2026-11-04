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
    this.active = undefined;
    delete this.document.documentElement.dataset.workspaceSlide;
  }
  run(direction, update) {
    this.finish();
    let committed = false;
    const commit = () => {if (!committed) {committed = true; update();}};
    const document = this.document;
    if (!document.startViewTransition || this.reducedMotion() || document.visibilityState === 'hidden') {
      commit();
      return Promise.resolve();
    }
    document.documentElement.dataset.workspaceSlide = direction > 0 ? 'next' : 'previous';
    let view;
    try {view = document.startViewTransition(commit);}
    catch {delete document.documentElement.dataset.workspaceSlide; commit(); return Promise.resolve();}
    const active = {view, commit};
    this.active = active;
    // Skip an interrupted animation without losing its update or clearing a newer one's styles.
    view.ready.catch(() => {});
    view.finished.catch(() => {}).then(() => {
      if (this.active !== active) return;
      this.active = undefined;
      delete document.documentElement.dataset.workspaceSlide;
    });
    return view.updateCallbackDone;
  }
}
