export const APP_CAPABILITIES=Object.freeze(['world.read','world.write','desktop.open','code.execute','env.manage','media.playback','media.call','schedules.manage','apps.invoke','effects.http','effects.files','effects.clock','effects.random','effects.process','effects.subscribe']);
export const framePermissions=capabilities=>'clipboard-write; autoplay'+(capabilities.includes('media.call')?'; camera; microphone':'');

// User-activated external links open separately; the app stays in its sandbox.
export const frameSandbox=capabilities=>'allow-scripts allow-same-origin allow-downloads allow-forms allow-pointer-lock'+(capabilities.includes('desktop.open')?' allow-popups allow-popups-to-escape-sandbox':'');
