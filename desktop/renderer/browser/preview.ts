import {PREVIEW_SIZES,type DesktopAPI,type Metadata,type Thumbnail} from '../../shared';
export type PreviewAPI=Pick<DesktopAPI,'thumbnail'|'summary'>&{catalogResolve(libraryId:string,fileId:string):Promise<string>};
export interface CatalogPreview {path:string;thumbnail?:Thumbnail;metadata?:Metadata;partialFailure:boolean;}
/** Resolve each identity in main, then discard obsolete selections before and after media reads. */
/** `size`: the picture's longest side (PREVIEW_SIZES); absent asks for the normal one. `wait`: the picture is asked for once it
 * resolves and only if the file is still current (the summary is read meanwhile). */
export async function readCatalogPreview(api:PreviewAPI,libraryId:string,fileId:string,isCurrent:()=>boolean,size?:number,wait?:()=>Promise<unknown>):Promise<CatalogPreview|undefined>{
 const path=await api.catalogResolve(libraryId,fileId);if(!isCurrent())return;
 const [thumbnail,metadata]=await Promise.allSettled([wait?wait().then(()=>isCurrent()?api.thumbnail(path,size):undefined):size===undefined?api.thumbnail(path):api.thumbnail(path,size),api.summary(path)]);if(!isCurrent())return;
 return {path,...(thumbnail.status==='fulfilled'&&thumbnail.value?{thumbnail:thumbnail.value}:{}),...(metadata.status==='fulfilled'?{metadata:metadata.value}:{}),partialFailure:thumbnail.status==='rejected'||metadata.status==='rejected'};
}
/** How long a file stays selected before its large picture is asked for. Arrow keys pass files faster than this, and main
 * decodes a few pictures at a time in order, so a large request for each file passed would hold up the one being looked at. */
export const LARGE_PREVIEW_DWELL_MS=250;
/** Resolves once a file selected at `since` has stayed selected for LARGE_PREVIEW_DWELL_MS. */
export const dwell=(since:number,now=Date.now())=>new Promise<void>(resolve=>setTimeout(resolve,Math.max(0,since+LARGE_PREVIEW_DWELL_MS-now)));
/** Whether a shown picture is worth asking for again at the large size: a decoded one smaller than that. An embedded camera
 * preview is the same picture at every size, and a missing one would only fail again. */
export const upgradesToLarge=(thumbnail:Thumbnail|undefined,loadedSize:number)=>!!thumbnail?.src&&thumbnail.via==='system'&&loadedSize<PREVIEW_SIZES.large;
