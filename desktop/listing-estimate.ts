/** How far a listing is, before its end tells the real total. Order of trust: the files (and bytes) an earlier
 * listing of the same scope found, then the used bytes of the drive being listed, then top-level folders
 * finished. The share never reaches 1: 100% belongs to the end of the listing, and a scope that grew
 * past its estimate keeps the estimate ahead of what was found. */
export interface ListingHint {files?:number;bytes?:number;}
export const LISTING_CAP=.99;
const ahead=(found:number,estimate:number)=>Math.max(estimate,Math.ceil(found/LISTING_CAP)+1);
export function listingEstimate(hint:ListingHint|undefined,found:{files:number;bytes:number},topLevel?:{done:number;total:number}):{total:number;totalBytes:number;share?:number} {
  const files=hint?.files&&hint.files>0?hint.files:0,bytes=hint?.bytes&&hint.bytes>0?hint.bytes:0;
  if(files){
    const total=ahead(found.files,files);
    return {total,totalBytes:bytes?ahead(found.bytes,bytes):0,share:Math.min(LISTING_CAP,found.files/total)};
  }
  if(bytes){const totalBytes=ahead(found.bytes,bytes);return {total:0,totalBytes,share:Math.min(LISTING_CAP,found.bytes/totalBytes)};}
  if(topLevel&&topLevel.total>0)return {total:0,totalBytes:0,share:Math.min(LISTING_CAP,Math.max(0,topLevel.done)/topLevel.total)};
  return {total:0,totalBytes:0};
}
