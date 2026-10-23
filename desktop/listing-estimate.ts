/** How far a listing is, before its end tells the real total. Order of trust: the files (and bytes) an earlier
 * listing of the same scope found, then the used bytes of the drive or folder being listed, then top-level folders
 * finished. The share never reaches 1: 100% belongs to the end of the listing. A scope that grows past its
 * estimate is re-estimated upward smoothly (see listingShare), so the share keeps moving instead of freezing. */
export interface ListingHint {files?:number;bytes?:number;}
export const LISTING_CAP=.99;
/** Up to this share of the estimate the share is simply found/estimate; past it the estimate is stretched. */
export const LISTING_KNEE=.9;
/** Share of a listing that has found `found` of an estimated `estimate`. Linear up to the knee, then it approaches
 * LISTING_CAP without reaching it, strictly rising with every extra file or byte, so a count that passes its
 * estimate (19.7k, 22.8k of 20k) keeps moving. */
export function listingShare(found:number,estimate:number):number {
  if(!(estimate>0)||!(found>0)) return 0;
  const ratio=found/estimate;
  if(ratio<=LISTING_KNEE) return ratio;
  const x=(ratio-LISTING_KNEE)/.3;
  return LISTING_KNEE+(LISTING_CAP-LISTING_KNEE)*x/(1+x);
}
/** The total the estimate implies for what was found: the estimate itself until the knee, then stretched ahead of the count. */
function stretched(found:number,estimate:number):number {
  const share=listingShare(found,estimate);
  return found/estimate<=LISTING_KNEE||share<=0?estimate:Math.max(Math.ceil(found/share),Math.floor(found)+1);
}
/** The size of the selected folders from a finished listing of the source (files with their path relative to its root); undefined when none of it is known. */
export function scopeHint(files:readonly {relative:string;size:number}[]|undefined,folders?:readonly string[]):ListingHint|undefined {
  if(!files?.length) return undefined;
  const scopes=folders?.map(folder=>folder.replace(/\\/g,'/').replace(/^\/+|\/+$/g,'')).filter(Boolean);
  const inside=scopes?.length?files.filter(file=>{const relative=file.relative.replace(/\\/g,'/');return scopes.some(scope=>relative===scope||relative.startsWith(scope+'/'));}):files;
  return inside.length?{files:inside.length,bytes:inside.reduce((sum,file)=>sum+file.size,0)}:undefined;
}
export function listingEstimate(hint:ListingHint|undefined,found:{files:number;bytes:number},topLevel?:{done:number;total:number}):{total:number;totalBytes:number;share?:number} {
  const files=hint?.files&&hint.files>0?hint.files:0,bytes=hint?.bytes&&hint.bytes>0?hint.bytes:0;
  if(files){
    return {total:stretched(found.files,files),totalBytes:bytes?stretched(found.bytes,bytes):0,share:listingShare(found.files,files)};
  }
  if(bytes) return {total:0,totalBytes:stretched(found.bytes,bytes),share:listingShare(found.bytes,bytes)};
  if(topLevel&&topLevel.total>0)return {total:0,totalBytes:0,share:Math.min(LISTING_CAP,Math.max(0,topLevel.done)/topLevel.total)};
  return {total:0,totalBytes:0};
}
