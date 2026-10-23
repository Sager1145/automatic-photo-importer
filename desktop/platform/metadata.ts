import { ExifTool } from 'exiftool-vendored';
import { ReadRawTask } from 'exiftool-vendored/dist/ReadRawTask';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import type { DuplicateExif, Exposure, Metadata } from '../shared';
import { djiProduct } from './dji-models';
import { streams, STREAMS } from '../core/devices';

let reader:ExifTool|undefined;
const exiftoolProcs=()=>Math.max(2,Math.min(6,Math.floor(availableParallelism()/2)));
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
  // Newer DJI video names its product only in the item list ("DJI OsmoPocket3", "DJI Mini4 Pro").
  // Older drones write a codec name there ("Dji AVC Encoder"), and other software (Lavf) is never a camera.
  for(const [key,value] of entries)if(['ItemList','UserData'].includes(tagGroup(key))&&tagName(key)==='Encoder'&&typeof value==='string'&&/^DJI\b/i.test(value.trim())&&!/encoder|\b(?:avc|hevc|h\.?26[45])\b/i.test(value))return value.trim().replace(/\s+/g,' ');
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
function exposureSummary(entries:TagEntries):Exposure|undefined {
  const result:Exposure={};
  const values=(name:string)=>standardValues(entries,name);
  const lens=lensModel(entries);if(lens)result.lens=lens;
  // With -n, these decoded tags already use physical capture units. APEX
  // ShutterSpeedValue/ApertureValue and numeric LensID are different data.
  for(const [field,name] of [['aperture','FNumber'],['iso','ISO'],['exposureTime','ExposureTime'],['focalLength','FocalLength'],['exposureCompensation','ExposureCompensation']] as const){
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
export function duplicateFingerprint(entries:TagEntries,camera:string|undefined,date:string|undefined):DuplicateExif {
  const fingerprint:DuplicateExif={};
  if(date)fingerprint.date=date;
  if(camera)fingerprint.camera=camera;
  const serial=identifier(entries,['SerialNumber','BodySerialNumber','InternalSerialNumber','CameraSerialNumber']);if(serial)fingerprint.serial=serial;
  for(const name of ['ShutterCount','MechanicalShutterCount','ShutterCount2','ShutterCount3'])for(const [key,value] of entries){const count=tagName(key)===name?counter(key,value):undefined;if(count&&fingerprint.shutterCount===undefined)fingerprint.shutterCount=String(count);}
  const number=identifier(entries,['ImageNumber','FileNumber']);if(number&&!fingerprint.shutterCount)fingerprint.imageNumber=number;
  const width=dimension(entries,['ExifImageWidth','ImageWidth','SourceImageWidth']),height=dimension(entries,['ExifImageHeight','ImageHeight','SourceImageHeight']);
  if(width&&height){fingerprint.width=width;fingerprint.height=height;}
  const lens=lensModel(entries);if(lens)fingerprint.lens=lens;
  for(const [field,name] of [['exposureTime','ExposureTime'],['aperture','FNumber'],['iso','ISO'],['exposureCompensation','ExposureCompensation']] as const)
    for(const [key,value] of entries){
      if(tagName(key)!==name)continue;
      const number=typeof value==='number'?value:typeof value==='string'&&value.trim()!==''?Number(value):NaN;
      if(Number.isFinite(number)){fingerprint[field]=String(number);break;}
    }
  return fingerprint;
}
/** Pure interpretation keeps maker-note counter rules testable without camera hardware. */
/** `file` (its name only) lets DJI clips take their local capture time from the name. */
export function metadataFromTags(tags:Record<string,unknown>, options:{details?:boolean;file?:string}={}):Metadata {
  const entries=Object.entries(tags);
  const camera=cameraModel(entries,options.file),date=djiLocalDate(options.file,entries,recordedDate(entries));
  const fields:Record<string,unknown>={};
  const result:Metadata={camera,date,fields,fingerprint:duplicateFingerprint(entries,camera,date)};
  if(editorProvenance(entries))result.edited=true;
  if(options.details===false){for(const [key,value] of entries)if(tagName(key)==='Error'&&value!==undefined)fields[key]=String(value);const lens=lensModel(entries);if(lens)result.exposure={lens};return result;}
  function flatten(key:string,value:unknown) {
    if(value===undefined)return;
    if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'){fields[key]=value;return;}
    if(Array.isArray(value)){fields[key]=JSON.stringify(value);return;}
    if(typeof value==='object')for(const [child,item] of Object.entries(value))flatten(`${key}.${child}`,item);
  }
  for(const [key,value] of entries)flatten(key,value);
  const exposure=exposureSummary(entries);if(exposure)result.exposure=exposure;
  const mechanical=entries.filter(([key])=>tagName(key)==='MechanicalShutterCount').map(([key,value])=>counter(key,value)).filter((v):v is number=>v!==undefined);
  // Sony bodies that keep their count only in ShutterCount2 or ShutterCount3 (ExifTool Sony Tag9050a-c) fall back to it.
  const total=['ShutterCount','ShutterCount2','ShutterCount3'].map(name=>entries.filter(([key])=>tagName(key)===name)).find(found=>found.some(([key,value])=>counter(key,value)!==undefined))??[];
  const mechanicalValues=new Set(mechanical);
  const totalValues=new Set(total.map(([key,value])=>counter(key,value)).filter((v):v is number=>v!==undefined));
  if(mechanicalValues.size>1)result.shutterNote='Conflicting mechanical shutter counters were found. Review the individual metadata values.';
  else if(mechanicalValues.size===1) {
    result.shutterCount=[...mechanicalValues][0].toLocaleString('en-US');
    result.shutterNote='Reported mechanical shutter actuations at capture time. Total exposures can be higher.'+(totalValues.size>1?' The separate total ShutterCount values disagree.':'');
  } else if(totalValues.size>1)result.shutterNote='Conflicting ShutterCount values were found across metadata sources.';
  else if(totalValues.size===1) {
    const validEntries=total.filter(([key,value])=>counter(key,value)!==undefined);
    const sonyA7V=/ILCE[ -]?7M5/i.test(camera??'');
    const version=Number(find(entries,['ExifToolVersion']));
    if(sonyA7V && (!Number.isFinite(version)||version<13.44||validEntries.some(([key])=>key.split(':')[0]!=='Sony'))) {
      result.shutterNote='Shutter count unavailable for this ILCE-7M5 photo: validating its Sony counter requires ExifTool 13.44 or newer and an identified Sony tag.';
    } else {
      result.shutterCount=[...totalValues][0].toLocaleString('en-US');
      result.shutterNote=sonyA7V?'Reported ShutterCount at capture time, read with the corrected Sony decoder; not necessarily mechanical actuations.':'Reported ShutterCount at capture time. Its meaning varies by camera and may include electronic exposures; it is not necessarily mechanical actuations.';
    }
  } else result.shutterNote=entries.some(([key])=>tagName(key)==='ImageCount')?'Shutter count unavailable. Image count is shown separately and does not establish mechanical shutter actuations.':'Shutter count unavailable: no supported counter was exposed in this file’s metadata.';
  return result;
}
const previewLimit=20*1024*1024;
const previewFolders=new Set<string>();
/** Preview folders being read now, which the leftover cleanup must not remove. */
export function previewFoldersInUse():string[] {return [...previewFolders];}
async function preview(filename:string):Promise<string|undefined> {
  const extension=path.extname(filename).toLowerCase();
  if(['.mov','.mp4','.m4v','.avi','.mts','.m2ts','.mxf','.3gp','.webm'].includes(extension))return undefined;
  const info=await stat(filename);
  if(['.jpg','.jpeg','.png','.webp'].includes(extension)&&info.size<=previewLimit) {
    const mime=extension==='.png'?'image/png':extension==='.webp'?'image/webp':'image/jpeg';
    return `data:${mime};base64,${(await readFile(filename)).toString('base64')}`;
  }
  // HEIF and camera RAW files can expose JPEG previews. Only our private temporary directory is written.
  const scratch=await mkdtemp(path.join(tmpdir(),'photo-importer-preview-'));previewFolders.add(scratch);
  try {
    for(const tag of ['PreviewImage','JpgFromRaw','ThumbnailImage'] as const) {
      const output=path.join(scratch,`${tag}.jpg`);
      try {
        await exiftool().extractBinaryTag(tag,filename,output);
        const size=(await stat(output)).size;if(size===0||size>previewLimit)continue;
        const buffer=await readFile(output);
        if(buffer[0]===0xff && buffer[1]===0xd8)return `data:image/jpeg;base64,${buffer.toString('base64')}`;
      }catch{/* Missing embedded previews are normal for some formats. */}
    }
  }finally{await rm(scratch,{recursive:true,force:true});previewFolders.delete(scratch);}
  return undefined;
}
/** The JPEG a camera embeds in a RAW (or HEIF) file, for when the system cannot decode the file itself. */
export async function embeddedPreview(filename:string):Promise<Buffer|undefined> {
  const scratch=await mkdtemp(path.join(tmpdir(),'photo-importer-preview-'));previewFolders.add(scratch);
  try {
    for(const tag of ['JpgFromRaw','PreviewImage','OtherImage','ThumbnailImage'] as const) {
      const output=path.join(scratch,`${tag}.jpg`);
      try {
        await exiftool().extractBinaryTag(tag,filename,output);
        const info=await stat(output);if(info.size===0||info.size>previewLimit)continue;
        const buffer=await readFile(output);
        if(buffer[0]===0xff&&buffer[1]===0xd8)return buffer;
      }catch{/* Missing embedded previews are normal. */}
    }
  }finally{await rm(scratch,{recursive:true,force:true});previewFolders.delete(scratch);}
}
// Routing reads only what camera, capture date, editor provenance, lens and
// read errors need. Composite SubSec* tags pull in their own source tags.
const routingTags=[
  'Make','Model','CameraModelName','CameraModel','DeviceModelName','AndroidModel',
  'DateTimeOriginal','SubSecDateTimeOriginal','SubSecTimeOriginal','OffsetTimeOriginal',
  'CreateDate','SubSecCreateDate','SubSecTimeDigitized','OffsetTimeDigitized','CreationDate','CreationDateValue','TimeZone',
  'Software','ProcessingSoftware','CreatorTool','ImageEditingSoftware','RAWDevelopingSoftware','HistorySoftwareAgent','History',
  'Encoder','LensModel','Error','Warning',
  'SerialNumber','BodySerialNumber','InternalSerialNumber','CameraSerialNumber','ShutterCount','MechanicalShutterCount','ShutterCount2','ShutterCount3','ImageNumber','FileNumber',
  'ExifImageWidth','ExifImageHeight','ImageWidth','ImageHeight','SourceImageWidth','SourceImageHeight',
  'ExposureTime','FNumber','ISO','ExposureCompensation',
].map(tag=>'-'+tag);
/** Routing results for this session, keyed by the file's exact stat identity. */
const routingCache=new Map<string,Metadata>();
const statKey=(file:string,info:import('node:fs').BigIntStats)=>`${file}\0${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
/** Routing results from this process, keyed by path and exact stat, so a scan's
 * reads can be handed to the import that follows it. */
export function routingEntries():[string,Metadata][] {return [...routingCache];}
/** Accept another process's routing results; a key only matches an unchanged file. */
export function primeRouting(entries:[string,Metadata][]):void {
  for(const entry of Array.isArray(entries)?entries:[]) {
    const [key,value]=Array.isArray(entry)?entry:[];
    if(typeof key!=='string'||!key.includes('\0')||!value||typeof value!=='object'||typeof value.fields!=='object')continue;
    if(routingCache.size>=50000)routingCache.clear();
    routingCache.set(key,structuredClone(value));
  }
}
/** Files read by one ExifTool request. ExifTool re-parses its arguments and filters for every request,
 * so a request for 16 files is much cheaper than 16 requests (measured about 1.7x faster). 1 reads each file alone. */
const ROUTING_BATCH=16;
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
interface Waiting {file:string;dev:bigint;resolve:(tags:RawTags)=>void;reject:(error:unknown)=>void;}
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
  let found:Map<string,RawTags>|undefined;
  if(group.length>1)try{found=await readBatch(group.map(item=>item.file));}catch{/* Each file is read alone below. */}
  await Promise.all(group.map(async item=>{
    try{
      const tags=found?.get(item.file);
      item.resolve(tags??await readSingle(item.file));
    }catch(error){item.reject(error);}
  }));
}
function pump():void {
  for(;;){
    let index=-1;
    for(let position=0;position<waiting.length;position++){
      const item=waiting[position]!;
      if((busy.get(item.dev)??0)<(limitOf.get(item.dev)??1)){index=position;break;}
    }
    if(index<0)return;
    const dev=waiting[index]!.dev,group:Waiting[]=[];
    for(let position=index;position<waiting.length&&group.length<routingBatch;)
      if(waiting[position]!.dev===dev){group.push(waiting[position]!);waiting.splice(position,1);}else position++;
    busy.set(dev,(busy.get(dev)??0)+1);
    void run(group).finally(()=>{busy.set(dev,busy.get(dev)!-1);pump();});
  }
}
let scheduled=false;
async function readRouting(file:string,dev:bigint,key:string):Promise<RawTags> {
  const shared=inFlight.get(key);if(shared)return shared;
  maxRequests=exiftoolProcs();
  const read=(async()=>{
    if(routingBatch<=1)return readSingle(file);
    await requestLimit(file,dev);
    return new Promise<RawTags>((resolve,reject)=>{
      waiting.push({file,dev,resolve,reject});
      // Callers arriving together share a request; a free slot never waits for a full one.
      if(!scheduled){scheduled=true;setTimeout(()=>{scheduled=false;pump();},2);}
    });
  })();
  inFlight.set(key,read);
  return read.finally(()=>inFlight.delete(key));
}
export async function metadata(filename:string, options:{preview?:boolean;details?:boolean}={}):Promise<Metadata> {
  const absolute=path.resolve(filename),before=await stat(absolute,{bigint:true});if(!before.isFile())throw new Error('Choose a media file to inspect.');
  const routing=options.details===false&&options.preview===false,key=statKey(absolute,before);
  if(routing){const cached=routingCache.get(key);if(cached)return structuredClone(cached);}
  // Routing skips RequestAll's per-file macOS stat/mdls/xattr subprocesses and
  // trailer scans (-fast keeps maker notes). Full inspection keeps everything.
  // Grouped raw values preserve duplicate tags and the camera's recorded clock.
  const tags=options.details===false?await readRouting(absolute,before.dev,key):await exiftool().readRaw(absolute,{readArgs:['-G1:4','-a','-n','-api','RequestAll=3']});
  const result=metadataFromTags(tags as Record<string,unknown>,{...options,file:absolute});
  if(routing&&statKey(absolute,await stat(absolute,{bigint:true}))===key){if(routingCache.size>=50000)routingCache.clear();routingCache.set(key,structuredClone(result));}
  if(options.preview!==false)result.preview=await preview(absolute);
  if(options.preview!==false && !result.preview)result.fields.PreviewStatus='No supported embedded image preview is available for this file.';
  return result;
}
