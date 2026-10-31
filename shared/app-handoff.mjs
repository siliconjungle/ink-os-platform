export function appHandoff(source,data,id=crypto.randomUUID()){
 if(data===undefined)return undefined;let json;try{json=JSON.stringify(data);}catch{throw Error('App handoff data must be JSON');}if(json===undefined||new TextEncoder().encode(json).length>65536)throw Error('App handoff data must be at most 64 KiB of JSON');return{id,source:{appId:source.id,title:source.title},data:JSON.parse(json)};
}
