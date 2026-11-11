import type {DesktopAPI,Metadata,Thumbnail} from '../../shared';
export type PreviewAPI=Pick<DesktopAPI,'thumbnail'|'summary'>&{catalogResolve(libraryId:string,fileId:string):Promise<string>};
export interface CatalogPreview {path:string;thumbnail?:Thumbnail;metadata?:Metadata;partialFailure:boolean;}
/** Resolve each identity in main, then discard obsolete selections before and after media reads. */
/** `size`: the picture's longest side (PREVIEW_SIZES); absent asks for the normal one. */
export async function readCatalogPreview(api:PreviewAPI,libraryId:string,fileId:string,isCurrent:()=>boolean,size?:number):Promise<CatalogPreview|undefined>{
 const path=await api.catalogResolve(libraryId,fileId);if(!isCurrent())return;
 const [thumbnail,metadata]=await Promise.allSettled([(size===undefined?api.thumbnail(path):api.thumbnail(path,size)),api.summary(path)]);if(!isCurrent())return;
 return {path,...(thumbnail.status==='fulfilled'?{thumbnail:thumbnail.value}:{}),...(metadata.status==='fulfilled'?{metadata:metadata.value}:{}),partialFailure:thumbnail.status==='rejected'||metadata.status==='rejected'};
}
