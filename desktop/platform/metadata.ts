import { ExifTool } from 'exiftool-vendored';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import type { Exposure, Metadata } from '../shared';

let reader:ExifTool|undefined;
function exiftool():ExifTool {
  return reader ??= new ExifTool({maxProcs:Math.max(2,Math.min(6,Math.floor(availableParallelism()/2))),taskTimeoutMillis:12000,spawnTimeoutMillis:12000});
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
function cameraModel(entries:TagEntries):string|undefined {
  for(const name of ['Model','CameraModelName','CameraModel','DeviceModelName']){
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
/** Pure interpretation keeps maker-note counter rules testable without camera hardware. */
/** `file` (its name only) lets DJI clips take their local capture time from the name. */
export function metadataFromTags(tags:Record<string,unknown>, options:{details?:boolean;file?:string}={}):Metadata {
  const entries=Object.entries(tags);
  const camera=cameraModel(entries),date=djiLocalDate(options.file,entries,recordedDate(entries));
  const fields:Record<string,unknown>={};
  const result:Metadata={camera,date,fields};
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
  const total=entries.filter(([key])=>tagName(key)==='ShutterCount');
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
async function preview(filename:string):Promise<string|undefined> {
  const extension=path.extname(filename).toLowerCase();
  if(['.mov','.mp4','.m4v','.avi','.mts','.m2ts','.mxf','.3gp','.webm'].includes(extension))return undefined;
  const info=await stat(filename);
  if(['.jpg','.jpeg','.png','.webp'].includes(extension)&&info.size<=previewLimit) {
    const mime=extension==='.png'?'image/png':extension==='.webp'?'image/webp':'image/jpeg';
    return `data:${mime};base64,${(await readFile(filename)).toString('base64')}`;
  }
  // HEIF and camera RAW files can expose JPEG previews. Only our private temporary directory is written.
  const scratch=await mkdtemp(path.join(tmpdir(),'photo-importer-preview-'));
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
  }finally{await rm(scratch,{recursive:true,force:true});}
  return undefined;
}
// Routing reads only what camera, capture date, editor provenance, lens and
// read errors need. Composite SubSec* tags pull in their own source tags.
const routingTags=[
  'Model','CameraModelName','CameraModel','DeviceModelName',
  'DateTimeOriginal','SubSecDateTimeOriginal','SubSecTimeOriginal','OffsetTimeOriginal',
  'CreateDate','SubSecCreateDate','SubSecTimeDigitized','OffsetTimeDigitized','CreationDate','CreationDateValue','TimeZone',
  'Software','ProcessingSoftware','CreatorTool','ImageEditingSoftware','RAWDevelopingSoftware','HistorySoftwareAgent','History',
  'Encoder','LensModel','Error','Warning',
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
export async function metadata(filename:string, options:{preview?:boolean;details?:boolean}={}):Promise<Metadata> {
  const absolute=path.resolve(filename),before=await stat(absolute,{bigint:true});if(!before.isFile())throw new Error('Choose a media file to inspect.');
  const routing=options.details===false&&options.preview===false,key=statKey(absolute,before);
  if(routing){const cached=routingCache.get(key);if(cached)return structuredClone(cached);}
  // Routing skips RequestAll's per-file macOS stat/mdls/xattr subprocesses and
  // trailer scans (-fast keeps maker notes). Full inspection keeps everything.
  // Grouped raw values preserve duplicate tags and the camera's recorded clock.
  const readArgs=['-G1:4','-a','-n',...(options.details===false?['-fast',...routingTags]:['-api','RequestAll=3'])];
  const tags=await exiftool().readRaw(absolute,{readArgs});
  const result=metadataFromTags(tags as Record<string,unknown>,{...options,file:absolute});
  if(routing&&statKey(absolute,await stat(absolute,{bigint:true}))===key){if(routingCache.size>=50000)routingCache.clear();routingCache.set(key,structuredClone(result));}
  if(options.preview!==false)result.preview=await preview(absolute);
  if(options.preview!==false && !result.preview)result.fields.PreviewStatus='No supported embedded image preview is available for this file.';
  return result;
}
