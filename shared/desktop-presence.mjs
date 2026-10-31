import{appManifest}from'./app-desktop.mjs';
// Peer rectangles are world coordinates; presence must use this client's camera.
// App state can be shared without sharing the user's pointer (for example a
// private generator form). Cursor presence is an explicit app classification.
export function desktopCursorVisible(peer,app){
 if(!peer?.appId&&!peer?.window)return true;
 return!!peer?.appId&&app?.id===peer.appId&&app.kind==='app'&&!app.archived&&appManifest(app).desktop?.collaborative===true;
}
export function gesturePreview(rect,area){
 if(!rect||![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite))return null;
 const x=area.x||0,y=area.y||0,z=area.zoom||1;
 if(rect.x+rect.width<=x||rect.y+rect.height<=y||rect.x>=x+area.width||rect.y>=y+area.height)return null;
 return{x:(rect.x-x)*z,y:(rect.y-y)*z,width:rect.width*z,height:rect.height*z};
}
