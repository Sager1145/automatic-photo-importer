import type {CatalogValues, NumericBucket, NumericField} from './types';
import type {Metadata} from '../shared';
import {parseCapture} from '../capture-time';

/** Nominal full-stop boundaries for browsing; indexed metadata is never snapped to them. */
export const photographicStops:Readonly<Record<NumericField,readonly number[]>>={
  focalLengthMm:[24,35,50,85,135,200],
  fNumber:[1,1.4,2,2.8,4,5.6,8,11,16,22,32],
  iso:[50,100,200,400,800,1600,3200,6400,12800,25600,51200,102400],
  exposureSeconds:[1/8000,1/4000,1/2000,1/1000,1/500,1/250,1/125,1/60,1/30,1/15,1/8,1/4,1/2,1,2,4,8,15,30],
};

/** Photographic units; reciprocal labels allow only decoder-level relative error (1e-9). */
export function formatNumericValue(field:NumericField,value:number):string {
  if(field==='fNumber')return `f/${value}`;
  if(field==='iso')return `ISO ${value}`;
  if(field==='focalLengthMm')return `${value} mm`;
  const denominator=Math.round(1/value);
  return `${value>0&&value<1&&Number.isSafeInteger(denominator)&&Math.abs(value-1/denominator)/value<=1e-9?`1/${denominator}`:String(value)} s`;
}
export function formatNumericBucket(field:NumericField,bucket:NumericBucket):string {
  const min=bucket.min===undefined?undefined:formatNumericValue(field,bucket.min);
  const max=bucket.max===undefined?undefined:formatNumericValue(field,bucket.max);
  return min===undefined?`${bucket.maxInclusive?'≤':'<'} ${max}`:max===undefined?`≥ ${min}`:`≥ ${min} – ${bucket.maxInclusive?'≤':'<'} ${max}`;
}

/** Parse only physical units appropriate to the field, never formatted EXIF/APEX strings. */
export function parseNumericInput(field:NumericField,text:string):number {
  let value=text.trim();
  if(field==='iso')value=value.replace(/^ISO\s+/i,'');
  if(field==='fNumber')value=value.replace(/^f\s*\/\s*/i,'');
  if(field==='focalLengthMm')value=value.replace(/\s*mm$/i,'');
  if(field==='exposureSeconds')value=value.replace(/\s*s$/i,'');
  const decimal='(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?';
  const match=value.match(new RegExp(`^(${decimal})${field==='exposureSeconds'?`(?:\\s*\\/\\s*(${decimal}))?`:''}$`,'i'));
  const number=match?Number(match[1])/(match[2]===undefined?1:Number(match[2])):NaN;
  if(!Number.isFinite(number)||number<=0)throw new Error('Enter a finite positive value.');
  return number;
}

/** User-entered ranges include both endpoints. Blank endpoints are open. */
export function parseRange(field:NumericField,minText:string,maxText:string):{min?:number;max?:number} {
  const min=minText.trim()?parseNumericInput(field,minText):undefined;
  const max=maxText.trim()?parseNumericInput(field,maxText):undefined;
  if(min!==undefined&&max!==undefined&&min>max)throw new Error('The minimum must not exceed the maximum.');
  return {...(min===undefined?{}:{min}),...(max===undefined?{}:{max})};
}

/** One normalization for indexed labels and user values: no fuzzy model merging. */
export function normalizeCatalogText(value:string):{display:string;key:string} {
  const display=value.trim().replace(/\s+/g,' ').normalize('NFC');
  return {display,key:display.toLowerCase()};
}

/** Raw metadata only: effective family dates and folder fallbacks belong to placement. */
export function catalogValues(metadata:Metadata):CatalogValues {
  const errors=Object.entries(metadata.fields).filter(([key,value])=>key.split(':').at(-1)==='Error'&&value!==undefined).map(([,value])=>String(value));
  if(errors.length)return {metadataStatus:'error',metadataError:errors.join('; ')};
  const result:CatalogValues={metadataStatus:'ready'};
  for(const field of ['make','camera','lens'] as const){
    const raw=field==='lens'?metadata.exposure?.lens:metadata[field];
    if(raw){const {display,key}=normalizeCatalogText(raw);if(display){result[field]=display;result[`${field}Key`]=key;}}
  }
  const capture=parseCapture(metadata.date);
  if(capture){
    result.captureRaw=metadata.date;
    result.captureDay=capture.day;
    result.captureYear=Number(capture.day.slice(0,4));
    result.captureMonth=Number(capture.day.slice(5,7));
    if(capture.zone)result.captureZone=capture.zone;
  }
  for(const [target,source] of [['focalLengthMm','focalLength'],['fNumber','aperture'],['exposureSeconds','exposureTime'],['iso','iso']] as const){
    const value=metadata.exposure?.[source];
    if(typeof value==='number'&&Number.isFinite(value)&&value>0)result[target]=value;
  }
  return result;
}

/** Suggested photography buckets clipped to the observed extent; no rounded value grouping. */
export function numericBuckets(field:NumericField,observedMin:number,observedMax:number):NumericBucket[] {
  if(!Number.isFinite(observedMin)||!Number.isFinite(observedMax)||observedMin<=0||observedMax<observedMin)return [];
  const edges=[observedMin,...photographicStops[field].filter(value=>value>observedMin&&value<observedMax),observedMax];
  return edges.slice(0,-1).map((min,index)=>({min,max:edges[index+1]!,maxInclusive:index===edges.length-2}));
}

/** Stable natural name key shared by scan ingestion and confirmed moves. */
export function catalogNameSortKey(name:string):string {
  return name.normalize('NFC').toLowerCase().replace(/\d+/g,number=>number.padStart(24,'0'));
}
