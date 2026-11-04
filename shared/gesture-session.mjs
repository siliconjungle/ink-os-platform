import {WheelGestures} from 'wheel-gestures';

/** Browser wheel events have no reliable physical scroll-begin notification. */
export function createGestureSession(onStart) {
  const gestures=WheelGestures({preventWheelAction:false,reverseSign:false});
  const stop=gestures.on('wheel',state=>{if(state.isStart)onStart();});
  return {
    feed(event,now){
      gestures.feedWheel({deltaX:event.deltaX,deltaY:event.deltaY,deltaMode:event.deltaMode??0,timeStamp:now,
        ...(typeof event.momentum==='boolean'?{momentum:event.momentum}:{})});
    },
    dispose(){stop();gestures.disconnect();}
  };
}
