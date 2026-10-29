import type {DesktopAPI,Metadata,Thumbnail} from '../../shared';
export type PreviewAPI=Pick<DesktopAPI,'thumbnail'|'summary'>&{catalogResolve(libraryId:string,fileId:string):Promise<string>};
export interface CatalogPreview {path:string;thumbnail?:Thumbnail;metadata?:Metadata;partialFailure:boolean;}
/** Resolve each identity in main, then discard obsolete selections before and after media reads. */
export async function readCatalogPreview(api:PreviewAPI,libraryId:string,fileId:string,isCurrent:()=>boolean):Promise<CatalogPreview|undefined>{
 const path=await api.catalogResolve(libraryId,fileId);if(!isCurrent())return;
 const [thumbnail,metadata]=await Promise.allSettled([api.thumbnail(path),api.summary(path)]);if(!isCurrent())return;
 return {path,...(thumbnail.status==='fulfilled'?{thumbnail:thumbnail.value}:{}),...(metadata.status==='fulfilled'?{metadata:metadata.value}:{}),partialFailure:thumbnail.status==='rejected'||metadata.status==='rejected'};
}
