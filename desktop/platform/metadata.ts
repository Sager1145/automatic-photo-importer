import { ExifTool } from 'exiftool-vendored';
import { ReadRawTask } from 'exiftool-vendored/dist/ReadRawTask';
import { stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import type { DuplicateExif, Exposure, Metadata, ShutterNote } from '../shared';
import { djiProduct } from './dji-models';
import { streams, STREAMS, ROUTING_BATCH } from '../core/devices';
import { exactStatKey } from '../core/paths';
import { cpuWorkers, governor, scaledByBudget } from '../resource-limits';
import { log } from '../logger';

let reader:ExifTool|undefined;
/** Today's formula (2 to 6, half the cores), capped by the CPU thread limit. */
export const exiftoolProcs=()=>cpuWorkers(Math.max(2,Math.min(6,Math.floor(availableParallelism()/2))));
function exiftool():ExifTool {
  return reader ??= new ExifTool({maxProcs:exiftoolProcs(),taskTimeoutMillis:12000,spawnTimeoutMillis:12000});
}
export async function closeMetadata():Promise<void> {const active=reader;reader=undefined;if(active)await active.end();}
type TagEntries = [string, unknown][];
const tagName=(key:string)=>key.split(':').at(-1)!;
function find(entries:TagEntries, names:string[]):unknown {
  for(const name of names)for(const [key,value] of entries)if(tagName(key)===name && value!==undefined && value!==null)return value;
}
function timezone(value:unknown):string|undefined {
  if(typeof value!=='string')return undefined;
  const zone=value.trim();if(zone==='Z')return zone;
  const match=zone.match(/^([+-])(\d{2}):?(\d{2})$/);
  return match&&+match[2]<=23&&+match[3]<=59?`${match[1]}${match[2]}:${match[3]}`:undefined;
}
function captureDate(value:unknown):string|undefined {
  if(typeof value!=='string')return undefined;
  const date=value.trim().match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?([+-]\d{2}:?\d{2}|Z)?$/);
  if(!date)return undefined;
  const [,year,month,day,hour,minute,second,fraction='',zone='']=date;
  if(+month<1||+month>12||+day<1||+day>31||+hour>23||+minute>59||+second>59)return undefined;
  const calendar=`${year}-${month}-${day}`,parsed=new Date(`${calendar}T00:00:00Z`);
  if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==calendar||(zone&&!timezone(zone)))return undefined;
  // Preserve the capture wall clock: folder grouping must not shift dates through UTC conversion.
  return `${calendar}T${hour}:${minute}:${second}${fraction}${timezone(zone)??''}`;
}
function dateParts(date:string){const match=date.match(/^(.{19})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/)!;return {clock:match[1],fraction:match[2]??'',zone:match[3]??''};}
function dates(entries:TagEntries,name:string){return entries.filter(([key])=>tagName(key)===name).flatMap(([key,value])=>{const date=captureDate(value);return date?[{key,date}]:[];});}
function tagGroup(key:string){return key.split(':').slice(0,-1).filter(part=>!/^Copy\d+$/.test(part)).join(':');}
function dateFamily(entries:TagEntries,plainName:string,compositeName:string,subsecondName:string,offsetName:string):{key:string;date:string}|undefined {
  const originals=dates(entries,plainName),composites=dates(entries,compositeName);
  // EXIF composites are derived from the EXIF fields, not a separate QuickTime clock.
  const plain=originals.find(item=>/^(?:ExifIFD|EXIF):/.test(item.key))??originals.find(item=>/^(?:IFD0|Nikon)$/.test(tagGroup(item.key)))??originals[0];
  if(!plain)return composites[0];
  const base=dateParts(plain.date);
  const group=tagGroup(plain.key);
  const composite=/^(?:ExifIFD|EXIF|IFD0)$/.test(group)?composites.map(item=>dateParts(item.date)).find(item=>item.clock===base.clock&&(!base.zone||!item.zone||(base.zone==='Z'?'+00:00':base.zone)===(item.zone==='Z'?'+00:00':item.zone))&&(!base.fraction||!item.fraction||base.fraction.replace(/0+$/,'')===item.fraction.replace(/0+$/,''))):undefined;
  const sibling=(name:string)=>entries.filter(([key])=>tagGroup(key)===group&&tagName(key)===name).map(([,value])=>value);
  const subseconds=[...new Set(sibling(subsecondName).filter(value=>(typeof value==='string'||typeof value==='number')&&/^\d+$/.test(String(value).trim())).map(value=>String(value).trim()))];
  const subsecond=subseconds.length===1?subseconds[0]:undefined;
  const offsets=[...new Set(sibling(offsetName).map(timezone).filter(value=>value!==undefined))];
  const offset=offsets.length===1?offsets[0]:undefined;
  // Nikon MOV's NCTG TimeZone is a recorded string. Numeric WorldTime fields
  // have different semantics and must never be converted or adjusted for DST.
  const nikonOffsets=group==='Nikon'?[...new Set(sibling('TimeZone').map(timezone).filter(value=>value!==undefined))]:[];
  const nikonOffset=nikonOffsets.length===1?nikonOffsets[0]:undefined;
  const fraction=base.fraction||(subseconds.length>1?'':subsecond!==undefined?'.'+subsecond:composite?.fraction||'');
  const zone=base.zone||(offsets.length>1?'':offset||composite?.zone||nikonOffset||'');
  return {key:plain.key,date:base.clock+fraction+zone};
}
function recordedCamera(entries:TagEntries):string|undefined {
  for(const name of ['Model','CameraModelName','CameraModel','DeviceModelName','AndroidModel']){
    const candidates=entries.filter(([key])=>tagName(key)===name);
    if(name==='Model'){
      const priority=(key:string)=>/^(?:IFD0|EXIF|ExifIFD)$/.test(tagGroup(key))?0:tagGroup(key)==='Keys'?1:2;
      candidates.sort(([left],[right])=>priority(left)-priority(right));
    }
    for(const [,value] of candidates){
      if(typeof value!=='string')continue;
      const model=value.trim().replace(/\s+/g,' ');
      if(/[\p{L}]/u.test(model)&&!/^(?:unknown(?: camera)?|not (?:available|recorded)|n\/a)$/i.test(model))return model;
    }
  }
  // Samsung phone videos: the trailer's model code, or the phone's marketing name when UserData:Author
  // carries it (matching IFD0:Model of its photos). Author is never a camera without that trailer.
  const clean=(value:unknown)=>typeof value==='string'?value.trim().replace(/\s+/g,' '):'';
  const samsung=entries.filter(([key])=>tagName(key)==='SamsungModel').map(([,value])=>clean(value)).find(Boolean);
  if(samsung)return entries.filter(([key])=>tagName(key)==='Author').map(([,value])=>clean(value)).find(value=>/^Galaxy\b/i.test(value))??samsung;
  // Newer DJI video names its product only in the item list ("DJI OsmoPocket3", "DJI Mini4 Pro").
  // Older drones write a codec name there ("Dji AVC Encoder"), and other software (Lavf) is never a camera.
  for(const [key,value] of entries)if(['ItemList','UserData'].includes(tagGroup(key))&&tagName(key)==='Encoder'&&typeof value==='string'&&/^DJI\b/i.test(value.trim())&&!/encoder|\b(?:avc|hevc|h\.?26[45])\b/i.test(value))return value.trim().replace(/\s+/g,' ');
  // CinemaDNG frames carry only this DNG tag; a real Model above always wins.
  return entries.filter(([key])=>tagGroup(key)==='IFD0'&&tagName(key)==='UniqueCameraModel').map(([,value])=>clean(value)).find(value=>/[\p{L}]/u.test(value));
}
/** Where a cameraless file came from, when its tags or name say so. */
function sourceFolder(entries:TagEntries,file?:string):string|undefined {
  const name=file?path.basename(file):'';
  const text=(names:string[])=>entries.filter(([key])=>names.includes(tagName(key))).map(([,value])=>typeof value==='string'?value.trim():'');
  const notes=text(['UserComment','ImageDescription','Comment','Description']);
  if(notes.some(value=>/^screenshot$/i.test(value))||/^(?:Screenshot[_ ]|截屏|屏幕截图)/i.test(name))return 'Screenshots';
  if(text(['Author']).includes('ReplayKitRecording')||/^(?:RPReplay_|ScreenRecording_)/i.test(name))return 'Screen Recordings';
  if(text(['Copyright']).some(value=>/^wxmm/i.test(value))||notes.some(value=>value.includes('"WXVer"'))||name.includes('_WC-EditVideo_')||/^mmexport/i.test(name))return 'WeChat';
}
/** A DJI photo's camera code and its videos' encoder name become the product's one folder name.
 * Insta360 keeps its model in a trailer that routing does not read, so its files fall back to the brand. */
function cameraModel(entries:TagEntries,file?:string):string|undefined {
  const model=recordedCamera(entries),make=find(entries,['Make']);
  if(model)return djiProduct(model,/^DJI\b/i.test(model)||/^DJI\b/i.test(String(make??'').trim()))??model;
  if(file&&/\.ins[vp]$/i.test(file))return 'Insta360';
}
/** DJI names files DJI_<camera-local yyyyMMddhhmmss>_…, while its QuickTime CreateDate has no
 * offset and is usually UTC (some firmware records the clip's end instead). Such a name is the
 * local capture time. When the two differ by a whole timezone offset, that offset is kept with it. */
function djiLocalDate(file:string|undefined,entries:TagEntries,date:string|undefined):string|undefined {
  const match=file&&path.basename(file).match(/^DJI_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:[_.]|$)/i);
  const named=match?captureDate(`${match[1]}:${match[2]}:${match[3]} ${match[4]}:${match[5]}:${match[6]}`):undefined;
  if(!named)return date;
  if(!date)return named;
  const created=dates(entries,'CreateDate').find(item=>tagGroup(item.key)==='QuickTime')?.date;
  if(!created||created!==date||dateParts(created).zone)return date;
  const utc=Date.parse(created+'Z'),gap=Date.parse(named+'Z')-utc,minutes=Math.round(gap/900000)*15;
  // No gap means this camera recorded local time; any other gap names no offset. Either way the
  // name's wall clock stands, never labelled UTC.
  if(!Number.isFinite(gap)||!minutes||Math.abs(gap-minutes*60000)>2000||Math.abs(minutes)>14*60)return named;
  const local=new Date(utc+minutes*60000).toISOString().slice(0,19)+dateParts(created).fraction,sign=minutes<0?'-':'+',size=Math.abs(minutes);
  return `${local}${sign}${String(Math.floor(size/60)).padStart(2,'0')}:${String(size%60).padStart(2,'0')}`;
}
function recordedDate(entries:TagEntries):string|undefined {
  const original=dateFamily(entries,'DateTimeOriginal','SubSecDateTimeOriginal','SubSecTimeOriginal','OffsetTimeOriginal');
  // Standard photo originals and Nikon's documented camera clock retain priority.
  // Other groups' Original labels remain useful, but do not hide explicit video
  // content dates merely because their tag has the same unqualified name.
  if(original&&/^(?:ExifIFD|EXIF|IFD0|Composite|Nikon)$/.test(tagGroup(original.key)))return original.date;
  const sony=dates(entries,'CreationDateValue')[0]?.date;
  const apple=dates(entries,'CreationDate').find(item=>item.key.startsWith('Keys:')&&dateParts(item.date).zone)?.date;
  return sony??apple??original?.date??dateFamily(entries,'CreateDate','SubSecCreateDate','SubSecTimeDigitized','OffsetTimeDigitized')?.date??dates(entries,'CreationDate')[0]?.date;
}
function standardValues(entries:TagEntries,name:string):unknown[] {
  const candidates=entries.filter(([key])=>tagName(key)===name);
  const standard=(key:string)=>/^(?:ExifIFD|EXIF|IFD0)$/.test(tagGroup(key))?0:1;
  return candidates.sort(([left],[right])=>standard(left)-standard(right)).map(([,value])=>value);
}
function lensModel(entries:TagEntries):string|undefined {
  for(const value of standardValues(entries,'LensModel')){
    if(typeof value!=='string')continue;
    const lens=value.trim().replace(/\s+/g,' ');
    if(/[\p{L}]/u.test(lens)&&!/^(?:unknown(?: lens)?|not (?:available|recorded)|n\/a)$/i.test(lens))return lens;
  }
}
/** EXIF 0x8827 is only 16 bits. Its saturated value cannot identify a real ISO.
 * ExifTool Exif.pm documents 0x8830 as the selector for the 32-bit sensitivity
 * tags (0x8831-0x8833). Preserve an unsaturated ISO first, then prefer ISOSpeed,
 * REI and SOS only where the declared SensitivityType includes that quantity. */
function captureISO(entries:TagEntries):number|undefined {
  const positive=(name:string):number|undefined=>{
    for(const value of standardValues(entries,name)){
      if(typeof value!=='number'&&(typeof value!=='string'||!value.trim()))continue;
      const number=Number(value);
      if(Number.isFinite(number)&&number>0&&!(name==='ISO'&&number===65535))return number;
    }
  };
  const iso=positive('ISO');if(iso!==undefined)return iso;
  const sensitivity=Number(standardValues(entries,'SensitivityType')[0]);
  const fields:Record<number,string[]>={
    1:['StandardOutputSensitivity'],2:['RecommendedExposureIndex'],3:['ISOSpeed'],
    4:['RecommendedExposureIndex','StandardOutputSensitivity'],5:['ISOSpeed','StandardOutputSensitivity'],
    6:['ISOSpeed','RecommendedExposureIndex'],7:['ISOSpeed','RecommendedExposureIndex','StandardOutputSensitivity'],
  };
  for(const name of fields[sensitivity]??['ISOSpeed']){const value=positive(name);if(value!==undefined)return value;}
}
function exposureSummary(entries:TagEntries):Exposure|undefined {
  const result:Exposure={};
  const values=(name:string)=>standardValues(entries,name);
  const lens=lensModel(entries);if(lens)result.lens=lens;
  const iso=captureISO(entries);if(iso!==undefined)result.iso=iso;
  // With -n, these decoded tags already use physical capture units. APEX
  // ShutterSpeedValue/ApertureValue and numeric LensID are different data.
  for(const [field,name] of [['aperture','FNumber'],['exposureTime','ExposureTime'],['focalLength','FocalLength'],['exposureCompensation','ExposureCompensation']] as const){
    for(const value of values(name)){
      if(typeof value!=='number'&&(typeof value!=='string'||!value.trim()))continue;
      const number=typeof value==='number'?value:Number(value);
      if(!Number.isFinite(number)||(field!=='exposureCompensation'&&number<=0))continue;
      result[field]=number;break;
    }
  }
  return Object.keys(result).length?result:undefined;
}
function counter(key:string,value:unknown):number|undefined {
  if(typeof value!=='number' && (typeof value!=='string' || !/^\d+$/.test(value)))return undefined;
  const count=Number(value);
  if(!Number.isSafeInteger(count)||count<0||count===4294967295)return undefined;
  if(key.split(':')[0]==='Nikon' && tagName(key)==='ShutterCount' && count===4294965247)return undefined;
  return count;
}
function editorProvenance(entries:TagEntries):boolean {
  const photoEditor=/^(?:(?:Adobe\s+)?(?:Photoshop|Lightroom)|Capture\s*One|darktable|RawTherapee|Affinity\s+Photo|DxO\s+(?:PhotoLab|PureRAW|OpticsPro)|GIMP)\b/i;
  const known=(value:unknown):boolean=>typeof value==='string'&&photoEditor.test(value.trim());
  const software=(value:unknown)=>Array.isArray(value)?value.some(known):known(value);
  for(const [key,value] of entries){
    const name=tagName(key);
    // ExifTool exposes XMP ResourceEvent softwareAgent as either the flattened
    // HistorySoftwareAgent list or SoftwareAgent inside structured History.
    // Adjustment settings and metadata-only software do not establish a render.
    if(['Software','ProcessingSoftware','CreatorTool','ImageEditingSoftware','RAWDevelopingSoftware','HistorySoftwareAgent'].includes(name)&&software(value))return true;
    if(name==='History'&&Array.isArray(value)&&value.some(event=>{
      if(!event||typeof event!=='object'||Array.isArray(event))return false;
      const record=event as Record<string,unknown>;
      return known(record.SoftwareAgent)||known(record.softwareAgent);
    }))return true;
  }
  return false;
}
function identifier(entries:TagEntries,names:string[]):string|undefined {
  for(const name of names)for(const [key,value] of entries){
    if(tagName(key)!==name||(typeof value!=='string'&&typeof value!=='number'))continue;
    const text=String(value).trim();
    if(text&&!/^0+$/.test(text)&&!/^(?:n\/a|unknown|none)$/i.test(text))return text;
  }
}
function dimension(entries:TagEntries,names:string[]):number|undefined {
  for(const name of names)for(const [key,value] of entries){
    if(tagName(key)!==name)continue;
    const number=typeof value==='number'?value:Number(value);
    if(Number.isFinite(number)&&number>0)return number;
  }
}
/** What tells two captures apart without reading their bytes: camera body serial, shutter count or image
 * number, dimensions and lens, next to the capture time and camera model. */
export function duplicateFingerprint(entries:TagEntries,camera:string|undefined,date:string|undefined,exposure:Exposure|undefined):DuplicateExif {
  const fingerprint:DuplicateExif={};
  if(date)fingerprint.date=date;
  if(camera)fingerprint.camera=camera;
  const serial=identifier(entries,['SerialNumber','BodySerialNumber','InternalSerialNumber','CameraSerialNumber']);if(serial)fingerprint.serial=serial;
  for(const name of ['ShutterCount','MechanicalShutterCount','ShutterCount2','ShutterCount3'])for(const [key,value] of entries){const count=tagName(key)===name?counter(key,value):undefined;if(count&&fingerprint.shutterCount===undefined)fingerprint.shutterCount=String(count);}
  const number=identifier(entries,['ImageNumber','FileNumber']);if(number&&!fingerprint.shutterCount)fingerprint.imageNumber=number;
  const width=dimension(entries,['ExifImageWidth','ImageWidth','SourceImageWidth']),height=dimension(entries,['ExifImageHeight','ImageHeight','SourceImageHeight']);
  if(width&&height){fingerprint.width=width;fingerprint.height=height;}
  if(exposure?.lens)fingerprint.lens=exposure.lens;
  for(const field of ['exposureTime','aperture','iso','exposureCompensation'] as const)if(exposure?.[field]!==undefined)fingerprint[field]=String(exposure[field]);
  return fingerprint;
}
/** The shutter count to show, and what it means (or why there is none). */
function shutter(entries:TagEntries,camera:string|undefined):{shutterCount?:number;shutterNote:ShutterNote} {
  const mechanical=new Set(entries.filter(([key])=>tagName(key)==='MechanicalShutterCount').map(([key,value])=>counter(key,value)).filter((v):v is number=>v!==undefined));
  // Sony bodies that keep their count only in ShutterCount2 or ShutterCount3 (ExifTool Sony Tag9050a-c) fall back to it.
  const total=['ShutterCount','ShutterCount2','ShutterCount3'].map(name=>entries.filter(([key,value])=>tagName(key)===name&&counter(key,value)!==undefined)).find(found=>found.length)??[];
  const totals=new Set(total.map(([key,value])=>counter(key,value)!));
  if(mechanical.size>1)return {shutterNote:'mechanical-conflict'};
  if(mechanical.size===1)return {shutterCount:[...mechanical][0]!,shutterNote:totals.size>1?'mechanical-total-conflict':'mechanical'};
  if(totals.size>1)return {shutterNote:'total-conflict'};
  if(totals.size===1){
    const sonyA7V=/ILCE[ -]?7M5/i.test(camera??''),version=Number(find(entries,['ExifToolVersion']));
    if(sonyA7V&&(!Number.isFinite(version)||version<13.44||total.some(([key])=>key.split(':')[0]!=='Sony')))return {shutterNote:'sony-unverified'};
    return {shutterCount:[...totals][0]!,shutterNote:sonyA7V?'sony-total':'total'};
  }
  return {shutterNote:entries.some(([key])=>tagName(key)==='ImageCount')?'image-count':'none'};
}
/** The one interpreter of both reads: routing's short tag list and the inspector's every tag.
 * Pure, so maker-note counter rules are testable without camera hardware. `details:false` keeps only the
 * read errors in `fields`; `file` (its name only) lets DJI clips take their local capture time from the name. */
export function metadataFromTags(tags:Record<string,unknown>, options:{details?:boolean;file?:string}={}):Metadata {
  const entries=Object.entries(tags);
  const camera=cameraModel(entries,options.file),date=djiLocalDate(options.file,entries,recordedDate(entries)),exposure=exposureSummary(entries);
  const fields:Record<string,unknown>={};
  const result:Metadata={camera,date,fields,fingerprint:duplicateFingerprint(entries,camera,date,exposure),...shutter(entries,camera)};
  if(exposure)result.exposure=exposure;
  if(!camera){const origin=sourceFolder(entries,options.file);if(origin)result.origin=origin;}
  const contentId=find(entries,['ContentIdentifier']),make=find(entries,['Make']);
  if(typeof contentId==='string'&&contentId.trim())result.contentId=contentId.trim();
  if(typeof make==='string'&&make.trim())result.make=make.trim();
  if(editorProvenance(entries))result.edited=true;
  if(options.details===false){for(const [key,value] of entries)if(tagName(key)==='Error'&&value!==undefined)fields[key]=String(value);return result;}
  function flatten(key:string,value:unknown) {
    if(value===undefined)return;
    if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'){fields[key]=value;return;}
    if(Array.isArray(value)){fields[key]=JSON.stringify(value);return;}
    if(typeof value==='object')for(const [child,item] of Object.entries(value))flatten(`${key}.${child}`,item);
  }
  for(const [key,value] of entries)flatten(key,value);
  return result;
}
const previewLimit=20*1024*1024;
/** The JPEG a camera embeds in a RAW (or HEIF) file, for when the system cannot decode the file itself. */
export async function embeddedPreview(filename:string):Promise<Buffer|undefined> {
  for(const tag of ['JpgFromRaw','PreviewImage','OtherImage','ThumbnailImage'] as const) {
    try {
      const buffer=await exiftool().extractBinaryTagToBuffer(tag,filename);
      if(buffer.length>0&&buffer.length<=previewLimit&&buffer[0]===0xff&&buffer[1]===0xd8)return buffer;
    }catch{/* Missing embedded previews are normal. */}
  }
}
// Routing reads only what camera, capture date, editor provenance, the summary card
// (exposure, shutter count) and read errors need. Composite SubSec* tags pull in their own source tags.
const routingTags=[
  'Make','Model','CameraModelName','CameraModel','DeviceModelName','AndroidModel','SamsungModel','Author','UniqueCameraModel','UserComment','ImageDescription','Copyright','Comment','Description',
  'DateTimeOriginal','SubSecDateTimeOriginal','SubSecTimeOriginal','OffsetTimeOriginal',
  'CreateDate','SubSecCreateDate','SubSecTimeDigitized','OffsetTimeDigitized','CreationDate','CreationDateValue','TimeZone',
  'Software','ProcessingSoftware','CreatorTool','ImageEditingSoftware','RAWDevelopingSoftware','HistorySoftwareAgent','History',
  'Encoder','LensModel','ContentIdentifier','Error','Warning',
  'SerialNumber','BodySerialNumber','InternalSerialNumber','CameraSerialNumber','ShutterCount','MechanicalShutterCount','ShutterCount2','ShutterCount3','ImageNumber','FileNumber',
  'ExifImageWidth','ExifImageHeight','ImageWidth','ImageHeight','SourceImageWidth','SourceImageHeight',
  'ExposureTime','FNumber','ISO','SensitivityType','ISOSpeed','RecommendedExposureIndex','StandardOutputSensitivity','ExposureCompensation','FocalLength','ImageCount','ExifToolVersion',
].map(tag=>'-'+tag);
/** Routing results for this session, keyed by the file's exact stat identity. */
const routingCache=new Map<string,Metadata>();
/** Most results kept. A library of hundreds of thousands of files fits, so a later check does not read it all again. */
let routingLimit=500000;
/** Least recently used results go first (a Map iterates in insertion order; a hit moves its entry to the end). */
function remember(key:string,value:Metadata):void {
  routingCache.delete(key);routingCache.set(key,value);
  while(routingCache.size>routingCacheLimit()){const oldest=routingCache.keys().next();if(oldest.done)break;routingCache.delete(oldest.value);}
}
function recall(key:string):Metadata|undefined {
  const value=routingCache.get(key);
  if(value){routingCache.delete(key);routingCache.set(key,value);}
  return value;
}
/** The routing cache holds 500k results at the 2 GB budget design point, in proportion to the budget (and never more than the test limit). */
export const routingCacheLimit=():number=>Math.min(routingLimit,scaledByBudget(500000,20000));
/** Smaller limit for tests. */
export function setRoutingLimit(limit:number):void {routingLimit=Math.max(1,Math.floor(limit)||1);}
export function routingCacheSize():number {return routingCache.size;}
/** A file moved from `from` (reviewed as `reviewed`) to `to` (now `now`) keeps its bytes, so its routing result
 * carries over to the new path and stat. Only under the same name: the result depends on the name (DJI, Insta360). */
export function carryRouting(from:string,reviewed:{dev:string;ino:string;size:string;mtime:string;ctime:string},to:string,now:import('node:fs').BigIntStats):void {
  if(path.basename(from)!==path.basename(to))return;
  const cached=routingCache.get(`${path.resolve(from)}\0${reviewed.dev}:${reviewed.ino}:${reviewed.size}:${reviewed.mtime}:${reviewed.ctime}`);
  if(cached)remember(statKey(path.resolve(to),now),structuredClone(cached));
}
const statKey=(file:string,info:import('node:fs').BigIntStats)=>`${file}\0${exactStatKey(info)}`;
/** Read-only reuse of the exact source stat used by a completed import. Never reads the file. */
export function cachedRouting(file:string,identity:string):Metadata|undefined {
 const value=routingCache.get(`${path.resolve(file)}\0${identity}`);return value?structuredClone(value):undefined;
}
/** Routing results for files under `root`, keyed by path and exact stat, so a scan's
 * reads can be handed to the import that follows it (and remembered for the card). */
export function routingEntriesUnder(root:string):[string,Metadata][] {
  const resolved=path.resolve(root),prefix=resolved.endsWith(path.sep)?resolved:resolved+path.sep,found:[string,Metadata][]=[];
  for(const entry of routingCache) if(entry[0].startsWith(prefix)) found.push(entry);
  return found;
}
/** Accept routing results from another process or from disk; a key only matches an unchanged file.
 * The cache takes the entries over: every caller passes values just deserialized (IPC or JSON) and keeps none. */
export function primeRouting(entries:[string,Metadata][]):void {
  for(const entry of Array.isArray(entries)?entries:[]) {
    const [key,value]=Array.isArray(entry)?entry:[];
    if(typeof key!=='string'||!key.includes('\0')||!value||typeof value!=='object'||typeof value.fields!=='object')continue;
    remember(key,value);
  }
}
/** Results read in this process while a capture is open, by key: a scan sends them to the parent as it goes. */
let captured:Map<string,Metadata>|undefined;
/** Start collecting the routing results this process reads from now on (not primed seeds, cache hits or carried results).
 * take() returns those since the last take and forgets them; close() ends the capture and drops what was not taken. One at a time. */
export function beginRoutingCapture():{take():[string,Metadata][];close():void} {
  if(captured) throw new Error('A routing capture is already open.');
  const pending=new Map<string,Metadata>();captured=pending;
  return {
    take(){const entries=[...pending];pending.clear();return entries;},
    close(){pending.clear();if(captured===pending)captured=undefined;},
  };
}
/** Files read by one ExifTool request. ExifTool re-parses its arguments and filters for every request,
 * so a request for 16 files is much cheaper than 16 requests (measured about 1.7x faster). 1 reads each file alone. */
let routingBatch=ROUTING_BATCH;
/** Files per ExifTool request for routing reads (1 turns batching off); mainly for tests. */
export function setRoutingBatch(size:number):void {routingBatch=Math.max(1,Math.floor(size)||1);}
const routingArgs=['-G1:4','-a','-n','-fast',...routingTags];
type RawTags=Record<string,unknown>;
// ReadRawTask's constructor is private in its typings; a batch task reuses its argument handling
// (UTF-8 repair, JSON) and parses one result per file instead of one.
const RawBase=ReadRawTask as unknown as new(sourceFile:string,args:string[],options:object)=>{parse(data:string,error?:Error):RawTags};
class RawBatchTask extends RawBase {
  parse(data:string,error?:Error):RawTags {
    const list=JSON.parse(data) as RawTags[];
    return list.map(item=>super.parse(JSON.stringify([item]),error)) as unknown as RawTags;
  }
}
async function readBatch(files:string[]):Promise<Map<string,RawTags>> {
  const proto=ReadRawTask.for(files[0]!,{readArgs:routingArgs}) as unknown as {args:string[]};
  const args=[...proto.args.slice(0,-1),...files];
  const list=await exiftool().enqueueTask(()=>new RawBatchTask(files[0]!,args,{readArgs:routingArgs}) as never) as unknown as RawTags[];
  return new Map(list.flatMap(item=>typeof item?.SourceFile==='string'?[[item.SourceFile,item] as [string,RawTags]]:[]));
}
interface Waiting {at:number;background:boolean;file:string;dev:bigint;resolve:(tags:RawTags)=>void;reject:(error:unknown)=>void;}
const waiting:Waiting[]=[],busy=new Map<bigint,number>(),limits=new Map<bigint,Promise<number>>(),limitOf=new Map<bigint,number>(),inFlight=new Map<string,Promise<RawTags>>();
let maxRequests=1;
const readSingle=(file:string)=>exiftool().readRaw(file,{readArgs:routingArgs}) as Promise<RawTags>;
/** Requests running at once on a device: its stream limit (a spinning disk gets one, a card two), never more than ExifTool's processes. */
function requestLimit(file:string,dev:bigint):Promise<number> {
  let limit=limits.get(dev);
  if(!limit){limit=streams.kind(file,dev).then(kind=>Math.max(1,Math.min(maxRequests,STREAMS[kind])),()=>2).then(value=>{limitOf.set(dev,value);return value;});limits.set(dev,limit);}
  return limit;
}
async function run(group:Waiting[]):Promise<void> {
  let found:Map<string,RawTags>|undefined,fellBack=false,failed=0;const began=performance.now();
  if(group.length>1)try{found=await readBatch(group.map(item=>item.file));}catch(error){fellBack=true;log('detailed','metadata','batch-failed',{files:group.length,error});/* Each file is read alone below. */}
  await Promise.all(group.map(async item=>{
    try{
      const tags=found?.get(item.file);
      item.resolve(tags??await readSingle(item.file));
    }catch(error){failed++;item.reject(error);}
  }));
  log('detailed','metadata','batch',{files:group.length,batched:group.length>1,fellBackToSingle:fellBack,failed,ms:Math.round(performance.now()-began),exiftoolProcs:exiftoolProcs(),first:group[0]?.file});
}
/** A group smaller than a full request waits this long for more files when another request is already running on its device. */
const LINGER_MS=10;
let lingering=false;
function pump():void {
  // Foreground reads (review, import, a user's click) are dispatched first; background reads (catalog indexing) only fill capacity they leave idle.
  for(;;){
    let index=-1,wait=0;
    for(const lane of [false,true]){
      const now=performance.now(),counts=new Map<bigint,number>(),firstAt=new Map<bigint,number>();
      for(const item of waiting)if(item.background===lane){counts.set(item.dev,(counts.get(item.dev)??0)+1);if(!firstAt.has(item.dev))firstAt.set(item.dev,item.at);}
      for(let position=0;position<waiting.length;position++){
        const item=waiting[position]!;if(item.background!==lane)continue;
        const running=busy.get(item.dev)??0;
        if(running>=(limitOf.get(item.dev)??1))continue;
        // A short group starts at once only on an idle device; otherwise it gathers files until it is full or has waited long enough.
        const age=now-firstAt.get(item.dev)!;
        if(running===0||counts.get(item.dev)!>=routingBatch||age>=LINGER_MS){index=position;break;}
        wait=Math.max(wait,LINGER_MS-age);
      }
      if(index>=0)break;
    }
    if(index<0){
      if(wait>0&&!lingering){lingering=true;setTimeout(()=>{lingering=false;pump();},Math.ceil(wait));}
      return;
    }
    const dev=waiting[index]!.dev,lane=waiting[index]!.background,group:Waiting[]=[];
    for(let position=index;position<waiting.length&&group.length<routingBatch;)
      if(waiting[position]!.dev===dev&&waiting[position]!.background===lane){group.push(waiting[position]!);waiting.splice(position,1);}else position++;
    busy.set(dev,(busy.get(dev)??0)+1);
    void run(group).finally(()=>{busy.set(dev,busy.get(dev)!-1);pump();});
  }
}
let scheduled=false;
async function readRouting(file:string,dev:bigint,key:string,background=false,signal?:AbortSignal):Promise<RawTags> {
  const shared=inFlight.get(key);if(shared)return shared;
  // A background read has its own in-flight key so a foreground caller never inherits its low priority or its abort.
  const slot=background?`background:${key}`:key,sharedBackground=background?inFlight.get(slot):undefined;if(sharedBackground)return sharedBackground;
  maxRequests=exiftoolProcs();
  const read=(async()=>{
    signal?.throwIfAborted();
    if(routingBatch<=1)return readSingle(file);
    await requestLimit(file,dev);
    signal?.throwIfAborted();
    return new Promise<RawTags>((resolve,reject)=>{
      const item:Waiting={at:performance.now(),background,file,dev,resolve,reject};
      waiting.push(item);
      // An undispatched background read is dropped when its caller aborts; a dispatched one finishes.
      if(background&&signal)signal.addEventListener('abort',()=>{const at=waiting.indexOf(item);if(at>=0){waiting.splice(at,1);reject(signal.reason??new DOMException('Aborted','AbortError'));}},{once:true});
      // Callers arriving together share a request; a free slot never waits for a full one.
      if(!scheduled){scheduled=true;setTimeout(()=>{scheduled=false;pump();},2);}
    });
  })();
  inFlight.set(slot,read);
  return read.finally(()=>inFlight.delete(slot));
}
/** details:false reads only the routing fields (camera, date, edited) and caches them by stat; otherwise every tag. */
export async function metadata(filename:string, options:{details?:boolean;background?:boolean;signal?:AbortSignal}={}):Promise<Metadata> {
  options.signal?.throwIfAborted();
  const absolute=path.resolve(filename),before=await stat(absolute,{bigint:true});if(!before.isFile())throw new Error('Choose a media file to inspect.');
  const routing=options.details===false,key=statKey(absolute,before);
  if(routing){const cached=recall(key);if(cached)return structuredClone(cached);}
  // Routing skips RequestAll's per-file macOS stat/mdls/xattr subprocesses and
  // trailer scans (-fast keeps maker notes). Full inspection keeps everything.
  // Grouped raw values preserve duplicate tags and the camera's recorded clock.
  // Admitted through the memory governor: above 90% of the limit a new read waits for the running ones.
  const tags=await governor.govern(async()=>options.details===false?await readRouting(absolute,before.dev,key,options.background===true,options.signal):await exiftool().readRaw(absolute,{readArgs:['-G1:4','-a','-n','-api','RequestAll=3']}));
  const result=metadataFromTags(tags as Record<string,unknown>,{...options,file:absolute});
  if(routing&&statKey(absolute,await stat(absolute,{bigint:true}))===key){const kept=structuredClone(result);remember(key,kept);captured?.set(key,kept);}
  return result;
}
