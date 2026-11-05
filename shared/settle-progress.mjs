/** Ease from the exact held position; callers can finish before handling a click. */
export function settleProgress(from,to,paint,complete,clock={
  now:()=>performance.now(),request:callback=>requestAnimationFrame(callback),cancel:id=>cancelAnimationFrame(id)
}) {
  const duration=120+160*Math.abs(to-from),start=clock.now();let frame,finished=false;
  const finish=()=>{if(finished)return;finished=true;clock.cancel(frame);paint(to);complete();};
  const tick=now=>{if(finished)return;const t=Math.min(1,Math.max(0,(now-start)/duration));paint(from+(to-from)*(1-(1-t)**3));if(t===1)finish();else frame=clock.request(tick);};
  frame=clock.request(tick);
  return finish;
}
