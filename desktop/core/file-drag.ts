import type {CatalogPage,CatalogQuery,CatalogRecord} from '../catalog/types';

/** More files than this is refused rather than cut short: a drop that silently imports part of a selection is worse than none. */
export const MAX_DRAG_FILES=10000;
/** What the Files column asks to drag: the files chosen one by one, or every file its query shows except some. */
export type DragRequest={libraryId:string;fileIds:string[]}|{libraryId:string;query:CatalogQuery;except:string[]};
/** The catalog reads a drag needs; `resolve` is the main process's checked path lookup (catalog/access). */
export interface DragSource {
 query(query:CatalogQuery):Promise<CatalogPage>;
 companions(libraryId:string,fileIds:string[]):Promise<CatalogRecord[]>;
 resolve(fileId:string):Promise<string>;
}
/** `files` holds this system's own absolute paths, as file managers and Lightroom receive them in a drop. */
export interface DragPayload {files:string[];photos:number;companions:number;skipped:number;tooMany?:boolean;}
export interface DragGroup {file:string;companions:string[];}

const id=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=200;
/** Requests arrive from the renderer: only well-formed, bounded ones are read. */
export function validDragRequest(value:unknown):value is DragRequest {
 if(!value||typeof value!=='object')return false;const request=value as Record<string,unknown>;if(!id(request.libraryId))return false;
 if('fileIds' in request)return Array.isArray(request.fileIds)&&request.fileIds.length<=MAX_DRAG_FILES*2&&request.fileIds.every(id);
 const query=request.query as CatalogQuery|undefined;
 return !!query&&typeof query==='object'&&query.libraryId===request.libraryId&&Array.isArray(request.except)&&request.except.length<=MAX_DRAG_FILES*2&&request.except.every(id);
}
/** Each file followed by its companions, every path once, in the order chosen. */
export function buildDragPayload(groups:DragGroup[]):string[] {
 const seen=new Set<string>(),files:string[]=[];
 for(const group of groups)for(const file of [group.file,...group.companions])if(!seen.has(file)){seen.add(file);files.push(file);}
 return files;
}
async function mapLimited<T,R>(items:T[],limit:number,work:(item:T)=>Promise<R>):Promise<R[]> {
 const results=new Array<R>(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const index=next++;results[index]=await work(items[index]!);}}));
 return results;
}
/** Lists the catalog files to drag (with the RAW paired with a JPEG or HEIF row, and every recorded companion such as an
 * .xmp sidecar) and resolves each to a path on disk. A file that cannot be resolved now is skipped and counted. */
export async function collectDragFiles(request:DragRequest,source:DragSource,limit=MAX_DRAG_FILES):Promise<DragPayload> {
 let ids:string[];
 if('fileIds' in request)ids=[...new Set(request.fileIds)];
 else{
  const except=new Set(request.except);ids=[];let cursor:string|undefined;
  do{const {cursor:_,...rest}=request.query;const page=await source.query({...rest,limit:500,...(cursor?{cursor}:{})});
   for(const row of page.rows)if(!except.has(row.fileId)){ids.push(row.fileId);if(row.pairedRaw)ids.push(row.pairedRaw.fileId);}
   if(ids.length>limit)return {files:[],photos:ids.length,companions:0,skipped:0,tooMany:true};
   cursor=page.nextCursor;}while(cursor);
 }
 if(ids.length>limit)return {files:[],photos:ids.length,companions:0,skipped:0,tooMany:true};
 const companions=new Map<string,string[]>();
 for(let offset=0;offset<ids.length;offset+=500)for(const record of await source.companions(request.libraryId,ids.slice(offset,offset+500)))if(record.companionOf){const list=companions.get(record.companionOf)??[];list.push(record.fileId);companions.set(record.companionOf,list);}
 const resolve=(fileId:string)=>source.resolve(fileId).then(file=>file,()=>undefined);
 let skipped=0,companionCount=0;
 const groups=await mapLimited(ids,16,async fileId=>{const file=await resolve(fileId);if(!file){skipped++;return undefined;}const sidecars=(await Promise.all((companions.get(fileId)??[]).map(resolve))).filter((path):path is string=>!!path);companionCount+=sidecars.length;return {file,companions:sidecars};});
 const resolved=groups.filter((group):group is DragGroup=>!!group);
 return {files:buildDragPayload(resolved),photos:resolved.length,companions:companionCount,skipped};
}
