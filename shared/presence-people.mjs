// Accounts identify people; connection IDs still identify independent cursors.
// Do not merge unrelated accounts merely because they have the same display name.
export function presencePeople(peers,self){const people=new Map();for(const peer of peers||[]){const key=peer.accountId?'account:'+peer.accountId:'client:'+peer.id,current=people.get(key);if(current&&current.id===self)continue;people.set(key,peer);}return[...people.values()];}
