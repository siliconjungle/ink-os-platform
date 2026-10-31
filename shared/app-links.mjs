const id=/^[a-f0-9]{32}$/;
/** Stable computer URLs contain identifiers only, never launch grants or keys. */
export function appPath(appId,objectId){
 if(!id.test(appId))throw Error('Invalid app identifier');
 if(objectId!==undefined&&!id.test(objectId))throw Error('Invalid object identifier');
 return '/app/'+appId+(objectId?'?object='+objectId:'');
}
export function parseAppLink(value){
 try{const url=new URL(value,'https://ink.invalid'),match=/^\/app\/([a-f0-9]{32})\/?$/.exec(url.pathname);if(!match)return null;const objectId=url.searchParams.get('object');if(objectId!==null&&!id.test(objectId))return null;return{appId:match[1],...(objectId?{objectId}:{})};}catch{return null;}
}
/** Allow only our own app routes as post-login destinations. */
export function loginDestination(value='/'){
 if(typeof value!=='string'||!value.startsWith('/app/')||/[\\\r\n]/.test(value))return '/';
 const link=parseAppLink(value);return link?appPath(link.appId,link.objectId):'/';
}
