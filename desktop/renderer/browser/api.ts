import type {CatalogPage,CatalogQuery,CatalogStatus,CategoryField,DirectoryPage,FacetResult} from '../../catalog/types';
import type {DesktopAPI} from '../../shared';
export type BrowserAPI=Pick<DesktopAPI,'thumbnail'|'summary'|'exif'>&{catalogQuery(query:CatalogQuery):Promise<CatalogPage>;catalogDirectories(query:CatalogQuery):Promise<DirectoryPage>;catalogFacets(query:CatalogQuery,field:CategoryField):Promise<FacetResult>;catalogStatus(libraryId:string):Promise<CatalogStatus>;catalogResolve(libraryId:string,fileId:string):Promise<string>}&Partial<Pick<DesktopAPI,'prepareDrag'|'startDrag'>>;
