import path from 'node:path';
import {defaultLimits,clampCpuThreads,clampMemoryLimitMB,savedLimits} from './resource-limits';
import type {DriveCameraRecord,MediaLayout,NoMetadataHandling,Preferences} from './shared';
import {DEFAULT_TEXT_SCALE,LOG_LEVELS,UNKNOWN_FILES_FOLDER} from './shared';
import {DEFAULT_EDITED_FOLDER} from './folder-template';
import {validNoMetadataFolder} from './no-metadata';
import {stableDevices} from './device-selection';

export const noMetadataModes:readonly NoMetadataHandling[]=['keep','folder','fileDate'];
export const mediaLayouts:readonly MediaLayout[]=['flat','format','type-format','photos-flat','videos-flat','video-root'];

export const defaultPreferences:Preferences={sourceLayout:'list',showDashboard:true,language:'en',appearance:'system',textScale:DEFAULT_TEXT_SCALE,accent:'coral',automatic:false,parallel:5,destinations:[],destinationIds:[],videoDestinations:[],videoDestinationIds:[],copyMode:'single',editedFolder:DEFAULT_EDITED_FOLDER,template:'{year}/{yyyymm}/{camera}',mediaLayout:'video-root',videoTemplate:'',backupMode:'additive',verifyCopies:true,skipFileErrors:true,collectProblemFiles:true,removeAppleDouble:true,unknownDefault:'skip',noMetadataHandling:'folder',noMetadataFolder:UNKNOWN_FILES_FOLDER,conflictNaming:'folder',autoEject:false,deleteOriginalsFolders:true,deleteOriginalsCards:false,logLevel:'normal',rememberedDevices:{},ignoredDevices:{},deviceHistory:{},unknownRules:{},...defaultLimits()};

const oneOf=<T>(value:unknown,allowed:readonly T[],fallback:T):T=>allowed.includes(value as T)?value as T:fallback;
const bounded=(value:unknown,min:number,max:number,fallback:number):number=>{const number=Number(value);return value===null||value===''||!Number.isFinite(number)||number===0?fallback:Math.min(max,Math.max(min,number));};
const flag=(value:unknown,fallback:boolean):boolean=>typeof value==='boolean'?value:fallback;
const text=(value:unknown,fallback:string):string=>typeof value==='string'?value:fallback;
// Entries are cleaned one by one: destinations and their identities are matched by position.
const strings=(value:unknown,fallback:string[]):string[]=>Array.isArray(value)?Array.from(value,item=>typeof item==='string'?item:''):[...fallback];
function records<T extends Record<string,string>>(value:unknown,fields:(keyof T)[]):Record<string,T> {
 if(!value||typeof value!=='object')return {};
 return Object.fromEntries(Object.entries(value).filter(([,item])=>!!item&&typeof item==='object'&&fields.every(field=>typeof (item as Record<string,unknown>)[field as string]==='string'))) as Record<string,T>;
}

const counts=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0;
const tallies=(value:unknown)=>Array.isArray(value)?value.filter(item=>typeof item?.name==='string'&&counts(item.files)&&counts(item.bytes)).map(({name,files,bytes})=>({name,files,bytes})):[];
// Saved by an earlier scan; anything malformed is dropped rather than shown.
function cameraRecord(value:unknown):DriveCameraRecord|undefined {
 const item=value as Partial<DriveCameraRecord>|undefined;
 if(!item||typeof item!=='object'||typeof item.scanned!=='string'||!['complete','stopped','error'].includes(item.status as string)||!counts(item.checked)||!counts(item.total)||!counts(item.unknown)||!Array.isArray(item.models))return undefined;
 return {scanned:item.scanned,status:item.status!,checked:item.checked,total:item.total,unknown:item.unknown,models:tallies(item.models),...(Array.isArray(item.lenses)?{lenses:tallies(item.lenses)}:{})};
}
function history(value:unknown):NonNullable<Preferences['deviceHistory']> {
 return Object.fromEntries(Object.entries(records<{name:string}>(value,['name'])).map(([id,entry])=>{const {cameras,...rest}=entry as NonNullable<Preferences['deviceHistory']>[string];const record=cameraRecord(cameras);return [id,record?{...rest,cameras:record}:rest];}));
}

/** The photo and video folders of each destination. Settings saved before folders were chosen held a drive (or folder)
 * per destination and two folder names inside each, `basePath` ("photobackup") and `videoBasePath` ("videobackup"): those
 * become the folders they named, both on the drive they were on. */
function chosenFolders(value:Record<string,unknown>,base:Preferences):Pick<Preferences,'destinations'|'destinationIds'|'videoDestinations'|'videoDestinationIds'> {
 const destinations=strings(value.destinations,base.destinations),destinationIds=strings(value.destinationIds,base.destinationIds??[]);
 if(value.videoDestinations===undefined&&Array.isArray(value.destinations)){
  const photo=typeof value.basePath==='string'?value.basePath:'photobackup',video=typeof value.videoBasePath==='string'?value.videoBasePath:'videobackup';
  const inside=(drive:string,folder:string)=>drive&&path.isAbsolute(drive)?path.resolve(drive,folder):drive;
  return {destinations:destinations.map(drive=>inside(drive,photo)),destinationIds,videoDestinations:video?destinations.map(drive=>inside(drive,video)):[],videoDestinationIds:video?[...destinationIds]:[]};
 }
 return {destinations,destinationIds,videoDestinations:strings(value.videoDestinations,base.videoDestinations??[]),videoDestinationIds:strings(value.videoDestinationIds,base.videoDestinationIds??[])};
}

/** The single set of preference rules, for settings read from disk and for every change the
 * interface sends: each field that is missing or invalid keeps its value from `base`. */
export function normalizePreferences(input:unknown,base:Preferences=defaultPreferences):Preferences {
 const value=(input&&typeof input==='object'?input:{}) as Record<string,unknown>,limits=savedLimits(value);
 return {
  sourceLayout:oneOf(value.sourceLayout,['list','grid'] as const,base.sourceLayout??'list'),
  showDashboard:flag(value.showDashboard,base.showDashboard!==false),
  language:oneOf(value.language,['en','zh-Hans','zh-Hant','ja'] as const,base.language),
  appearance:oneOf(value.appearance,['system','light','dark'] as const,base.appearance),
  textScale:bounded(value.textScale,1,2,base.textScale),
  accent:oneOf(value.accent,['coral','ocean','forest'] as const,base.accent),
  automatic:flag(value.automatic,base.automatic),
  parallel:Math.round(bounded(value.parallel,1,10,base.parallel)),
  ...chosenFolders(value,base),
  copyMode:oneOf(value.copyMode,['single','mirror','sequential'] as const,base.copyMode),
  template:text(value.template,base.template),
  // Settings saved before media layouts had an on/off switch for media-type folders.
  // The old media switch was a choice only when on; off was just its default, so it gets today's.
  mediaLayout:oneOf(value.mediaLayout,mediaLayouts,value.separateMedia===true&&value.mediaLayout===undefined?'format':base.mediaLayout??'video-root'),
  videoTemplate:text(value.videoTemplate,base.videoTemplate??''),
  backupMode:oneOf(value.backupMode,['additive','mirror'] as const,base.backupMode??'additive'),
  verifyCopies:value.verifyCopies===undefined?base.verifyCopies!==false:value.verifyCopies!==false,
  // Saved as skipFileErrors: an older skipErrors:false only recorded that option's earlier default (off).
  skipFileErrors:flag(value.skipFileErrors,base.skipFileErrors!==false),
  removeAppleDouble:flag(value.removeAppleDouble,base.removeAppleDouble!==false),
  collectProblemFiles:value.collectProblemFiles===undefined?base.collectProblemFiles!==false:value.collectProblemFiles!==false,
  unknownDefault:oneOf(value.unknownDefault,['skip','other','ask'] as const,base.unknownDefault??'skip'),
  rememberedDevices:value.rememberedDevices===undefined?{...base.rememberedDevices}:stableDevices(records<{name:string;lastSelected:string}>(value.rememberedDevices,['name','lastSelected'])),
  ignoredDevices:value.ignoredDevices===undefined?{...base.ignoredDevices}:stableDevices(records<{name:string;ignoredAt:string}>(value.ignoredDevices,['name','ignoredAt'])),
  deviceHistory:value.deviceHistory===undefined?{...base.deviceHistory}:stableDevices(history(value.deviceHistory)),
  unknownRules:{...(value.unknownRules&&typeof value.unknownRules==='object'?value.unknownRules as Preferences['unknownRules']:base.unknownRules)},
  noMetadataHandling:oneOf(value.noMetadataHandling,noMetadataModes,base.noMetadataHandling??'folder'),
  noMetadataFolder:validNoMetadataFolder(value.noMetadataFolder)?value.noMetadataFolder:validNoMetadataFolder(base.noMetadataFolder)?base.noMetadataFolder:UNKNOWN_FILES_FOLDER,
  conflictNaming:oneOf(value.conflictNaming,['folder','number'] as const,base.conflictNaming??'folder'),
  autoEject:flag(value.autoEject,base.autoEject===true),
  deleteOriginalsFolders:flag(value.deleteOriginalsFolders,base.deleteOriginalsFolders!==false),
  deleteOriginalsCards:flag(value.deleteOriginalsCards,base.deleteOriginalsCards===true),
  logLevel:oneOf(value.logLevel,LOG_LEVELS,base.logLevel??'normal'),
  editedFolder:text(value.editedFolder,base.editedFolder),
  // The thread pool reads the saved limits by the same rule before anything starts; a limit not given keeps the base one, then this machine's default.
  maxCpuThreads:limits.maxCpuThreads??clampCpuThreads(base.maxCpuThreads),
  memoryLimitMB:limits.memoryLimitMB??clampMemoryLimitMB(base.memoryLimitMB),
 };
}
