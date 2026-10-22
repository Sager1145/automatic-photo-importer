import type {MediaLayout,Preferences} from './shared';

export const mediaLayouts:readonly MediaLayout[]=['flat','format','type-format','photos-flat','videos-flat','video-root'];

export const defaultPreferences:Preferences={sourceLayout:'list',showDashboard:true,language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:5,destinations:[],destinationIds:[],copyMode:'single',editedFolder:'editied',basePath:'photobackup',template:'{year}/{yyyymm}/{camera}',mediaLayout:'video-root',videoBasePath:'videobackup',videoTemplate:'',allowFolderSource:false,backupMode:'additive',verifyCopies:true,removeEmptySourceFolders:true,releaseDuplicatesAfterOrganizing:false,autoOrganizeBackup:'ask',unknownDefault:'skip',rememberedDevices:{},ignoredDevices:{},deviceHistory:{},unknownRules:{}};

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

/** The single set of preference rules, for settings read from disk and for every change the
 * interface sends: each field that is missing or invalid keeps its value from `base`. */
export function normalizePreferences(input:unknown,base:Preferences=defaultPreferences):Preferences {
 const value=(input&&typeof input==='object'?input:{}) as Record<string,unknown>;
 return {
  sourceLayout:oneOf(value.sourceLayout,['list','grid'] as const,base.sourceLayout??'list'),
  showDashboard:flag(value.showDashboard,base.showDashboard!==false),
  language:oneOf(value.language,['en','zh-Hans','zh-Hant','ja'] as const,base.language),
  appearance:oneOf(value.appearance,['system','light','dark'] as const,base.appearance),
  textScale:bounded(value.textScale,1,2,base.textScale),
  accent:oneOf(value.accent,['coral','ocean','forest'] as const,base.accent),
  automatic:flag(value.automatic,base.automatic),
  parallel:Math.round(bounded(value.parallel,1,10,base.parallel)),
  destinations:strings(value.destinations,base.destinations),
  destinationIds:strings(value.destinationIds,base.destinationIds??[]),
  copyMode:oneOf(value.copyMode,['single','mirror','sequential'] as const,base.copyMode),
  basePath:text(value.basePath,base.basePath),
  template:text(value.template,base.template),
  // Settings saved before media layouts had an on/off switch for media-type folders.
  // The old media switch was a choice only when on; off was just its default, so it gets today's.
  mediaLayout:oneOf(value.mediaLayout,mediaLayouts,value.separateMedia===true&&value.mediaLayout===undefined?'format':base.mediaLayout??'video-root'),
  videoBasePath:text(value.videoBasePath,base.videoBasePath??'videobackup'),
  videoTemplate:text(value.videoTemplate,base.videoTemplate??''),
  allowFolderSource:flag(value.allowFolderSource,base.allowFolderSource),
  backupMode:oneOf(value.backupMode,['additive','mirror'] as const,base.backupMode??'additive'),
  verifyCopies:value.verifyCopies===undefined?base.verifyCopies!==false:value.verifyCopies!==false,
  removeEmptySourceFolders:value.removeEmptySourceFolders===undefined?base.removeEmptySourceFolders!==false:value.removeEmptySourceFolders!==false,
  releaseDuplicatesAfterOrganizing:flag(value.releaseDuplicatesAfterOrganizing,base.releaseDuplicatesAfterOrganizing===true),
  autoOrganizeBackup:oneOf(value.autoOrganizeBackup,['off','ask','auto'] as const,base.autoOrganizeBackup??'ask'),
  unknownDefault:oneOf(value.unknownDefault,['skip','other','ask'] as const,base.unknownDefault??'skip'),
  rememberedDevices:value.rememberedDevices===undefined?{...base.rememberedDevices}:records<{name:string;lastSelected:string}>(value.rememberedDevices,['name','lastSelected']),
  ignoredDevices:value.ignoredDevices===undefined?{...base.ignoredDevices}:records<{name:string;ignoredAt:string}>(value.ignoredDevices,['name','ignoredAt']),
  deviceHistory:value.deviceHistory===undefined?{...base.deviceHistory}:records<{name:string}>(value.deviceHistory,['name']) as Preferences['deviceHistory'],
  unknownRules:{...(value.unknownRules&&typeof value.unknownRules==='object'?value.unknownRules as Preferences['unknownRules']:base.unknownRules)},
  editedFolder:text(value.editedFolder,base.editedFolder??'editied'),
 };
}
