import{DocumentHost}from '../../shared/document-host.mjs';import{ReplicaCache}from '../../shared/replica-cache.mjs';import{syncHub}from './sync';
let host:DocumentHost|undefined;export const documents=()=>host||=new DocumentHost({hub:syncHub(),cache:new ReplicaCache()});
