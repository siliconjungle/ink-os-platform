import type { WorldObject } from '../src/types';
export interface Adapter { id:string; title:string; releaseId:string; installedAt:number; configurationVersion?:string; operation:string; name:string; description:string; input:{fileTypes?:string[];kind?:string;shape?:Record<string,string>}; output:{label:string;mime:string;extension:string;shape?:Record<string,string>} }
export function adapterManifest(input:unknown):Omit<Adapter,'id'|'title'|'releaseId'|'installedAt'>;
export function acceptsAdapter(adapter:Adapter,object:WorldObject):boolean;
export function adapterOutput(adapter:Adapter):WorldObject;
export function adapterGroup(adapter:Adapter):string;
export function publishedAdapters(objects:WorldObject[]):Adapter[];
export function defaultAdapters(adapters:Adapter[],defaults?:Record<string,string>):Adapter[];
