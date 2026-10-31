export type Kind = (string & {}) | 'note' | 'image' | 'task' | 'code' | 'space' | 'app' | 'view' | 'link' | 'audio' | 'video' | 'file';
export interface WorldObject {
  id: string; localVersion?:number; syncPending?:boolean; namespace?: string; kind: Kind; title: string; body: string; summary: string; tags: string[]; spaces: string[];
  status: string; cover: string; source: string; location: string; revision: number; created: number;
  updated: number; starred: boolean; archived: boolean; score?: number;
}
export interface Activity { id: string; objectId: string; title: string; kind: Kind; action: string; actor: string; at: number; before?: WorldObject; after?: WorldObject; }
export interface Peer { accountId?:string; appId?:string;objectId?:string;id: string; name: string; color: string; view: string; window?:string; gesture?:{key:string;kind:'move'|'resize';rect:{x:number;y:number;width:number;height:number};at:number}; cursor?: { x: number; y: number; space?:'desktop' } }
export interface Stats { count: number; version: number; indexed: number; engine: string; core: string; source: string }
export interface ModelState { status: string; model: string; dimensions: number; error: string }
export interface StorageState { r2?:{managed:boolean;bucket:string};local: boolean; s3: null | { bucket: string; endpoint: string; region: string } }
export interface Operation { type: string; target: string; title: string; body: string; tags: string[]; objectIds: string[]; layout: string }
export interface AssistantResponse { message: string; operations: Operation[]; suggestedSearch: string }
export interface Job { id: string; status: string; message: string; result?: AssistantResponse; error?: string }
export type Route = { app: string; id?: string };
export type Layout = 'gallery' | 'table' | 'board';
