import {WheelGestures} from 'wheel-gestures';

/** Browser wheel events have no reliable physical scroll-begin notification. */
export function createGestureSession(onStart,onEnd=()=>{}) {
  const gestures=WheelGestures({preventWheelAction:false,reverseSign:false});
  let active=false;
  const stop=gestures.on('wheel',state=>{
    if(state.isStart){active=true;onStart();}
    if(active&&(state.isMomentum||state.isEnding)){active=false;onEnd();}
  });
  return {
    feed(event,now){
      gestures.feedWheel({deltaX:event.deltaX,deltaY:event.deltaY,deltaMode:event.deltaMode??0,timeStamp:now,
        ...(typeof event.momentum==='boolean'?{momentum:event.momentum}:{})});
      return active;
    },
    dispose(){stop();gestures.disconnect();}
  };
}
