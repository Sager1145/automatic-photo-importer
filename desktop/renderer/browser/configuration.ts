import {photographicStops,parseNumericInput as parseCatalogNumericInput} from '../../catalog/values';
import type {CategoryField,NumericBucket,NumericField} from '../../catalog/types';
export const blockKinds=['date','name','format','camera','lens','focal','aperture','shutter','iso'] as const;
export type BlockKind=typeof blockKinds[number];
export interface HierarchyBlock {id:string;kind:BlockKind;dateGranularity:'year'|'month'|'day';datePattern:string;nameMode:'initial'|'exact';formatMode:'extension'|'kind';numericMode:'exact'|'buckets';boundaries:number[];}
export interface BrowserPreset {id:string;name:string;blocks:HierarchyBlock[];}
export interface BrowserConfiguration {version:1;columnWidth?:number;blocks:HierarchyBlock[];presets:BrowserPreset[];activePresetId?:string;}
export const configurationKey='photo-importer.browser.v1';
export const blockLabels:Record<BlockKind,string>={date:'Date',name:'Name',format:'Format',camera:'Camera',lens:'Lens',focal:'Focal length',aperture:'Aperture',shutter:'Shutter speed',iso:'ISO'};
const numericFields:Partial<Record<BlockKind,NumericField>>={focal:'focalLengthMm',aperture:'fNumber',shutter:'exposureSeconds',iso:'iso'};
let serial=0;
function id(){return `block-${Date.now().toString(36)}-${(++serial).toString(36)}`;}
export function createBlock(kind:BlockKind):HierarchyBlock{const field=numericFields[kind];return {id:id(),kind,dateGranularity:'month',datePattern:'YYYY-MM',nameMode:'initial',formatMode:'extension',numericMode:['aperture','shutter','iso'].includes(kind)?'buckets':'exact',boundaries:[...(field?photographicStops[field]:[])]};}
const preset=(id:string,name:string,kinds:BlockKind[]):BrowserPreset=>({id,name,blocks:kinds.map(createBlock)});
export const builtInPresets:BrowserPreset[]=[...blockKinds.map(k=>preset(`builtin-${k}`,blockLabels[k],[k])),preset('builtin-date-camera-format','Date → Camera → Format',['date','camera','format']),preset('builtin-camera-lens-focal','Camera → Lens → Focal length',['camera','lens','focal']),preset('builtin-aperture-date-format-camera','Aperture → Date → Format → Camera',['aperture','date','format','camera'])];
export function defaultConfiguration():BrowserConfiguration{return {version:1,blocks:builtInPresets[9]!.blocks.map(b=>({...b,id:id(),boundaries:[...b.boundaries]})),presets:[],activePresetId:'builtin-date-camera-format'};}
const edited=(c:BrowserConfiguration,blocks:HierarchyBlock[]):BrowserConfiguration=>({...c,blocks,activePresetId:undefined});
export function addBlock(c:BrowserConfiguration,kind:BlockKind,at:number):BrowserConfiguration {const blocks=[...c.blocks];blocks.splice(Math.max(0,Math.min(at,blocks.length)),0,createBlock(kind));return edited(c,blocks);}
export function moveBlock(c:BrowserConfiguration,blockId:string,at:number):BrowserConfiguration {const blocks=[...c.blocks],from=blocks.findIndex(b=>b.id===blockId);if(from<0)return c;const [block]=blocks.splice(from,1);blocks.splice(Math.max(0,Math.min(at,blocks.length)),0,block!);return edited(c,blocks);}
export function removeBlock(c:BrowserConfiguration,blockId:string):BrowserConfiguration{return edited(c,c.blocks.filter(b=>b.id!==blockId));}
export function updateBlock(c:BrowserConfiguration,blockId:string,patch:Partial<Omit<HierarchyBlock,'id'|'kind'>>):BrowserConfiguration{return edited(c,c.blocks.map(b=>b.id===blockId?{...b,...patch}:b));}
export function savePreset(c:BrowserConfiguration,name:string,presetId=`preset-${Date.now().toString(36)}`):BrowserConfiguration {if(!name.trim())return c;return {...c,activePresetId:presetId,presets:[...c.presets,{id:presetId,name:name.trim(),blocks:c.blocks.map(b=>({...b,boundaries:[...b.boundaries]}))}]};}
export function renamePreset(c:BrowserConfiguration,presetId:string,name:string):BrowserConfiguration{return name.trim()?{...c,presets:c.presets.map(p=>p.id===presetId?{...p,name:name.trim()}:p)}:c;}
export function deletePreset(c:BrowserConfiguration,presetId:string):BrowserConfiguration{return {...c,activePresetId:c.activePresetId===presetId?undefined:c.activePresetId,presets:c.presets.filter(p=>p.id!==presetId)};}
export function applyPreset(c:BrowserConfiguration,presetId:string):BrowserConfiguration {const p=[...builtInPresets,...c.presets].find(p=>p.id===presetId);return p?{...c,activePresetId:presetId,blocks:p.blocks.map(b=>({...b,id:id(),boundaries:[...b.boundaries]}))}:c;}
export function safeDatePattern(value:string):boolean{return value.length>0&&value.length<=40&&/^(YYYY|MM|DD|[ /._–-])+$/.test(value);}
export function fieldForBlock(b:HierarchyBlock):CategoryField {return ({date:b.dateGranularity==='year'?'captureYear':b.dateGranularity==='month'?'captureYearMonth':'captureDay',name:b.nameMode==='exact'?'name':'nameInitial',format:b.formatMode==='kind'?'mediaKind':'format',camera:'camera',lens:'lens',focal:'focalLengthMm',aperture:'fNumber',shutter:'exposureSeconds',iso:'iso'} as const)[b.kind];}
export function isNumeric(field:CategoryField):field is NumericField{return ['focalLengthMm','fNumber','exposureSeconds','iso'].includes(field);}
export function numericBuckets(values:number[]):NumericBucket[]{const edges=[...new Set(values.filter(Number.isFinite))].sort((a,b)=>a-b);return edges.length?[{max:edges[0],maxInclusive:false},...edges.slice(1).map((max,i)=>({min:edges[i],max,maxInclusive:false})),{min:edges.at(-1),maxInclusive:true}]:[];}
function validBlock(value:unknown):value is HierarchyBlock {if(!value||typeof value!=='object')return false;const b=value as HierarchyBlock;return typeof b.id==='string'&&blockKinds.includes(b.kind)&&['year','month','day'].includes(b.dateGranularity)&&safeDatePattern(b.datePattern)&&['initial','exact'].includes(b.nameMode)&&['extension','kind'].includes(b.formatMode)&&['exact','buckets'].includes(b.numericMode)&&Array.isArray(b.boundaries)&&b.boundaries.every(n=>typeof n==='number'&&Number.isFinite(n));}
export function readConfiguration(storage:Pick<Storage,'getItem'>):BrowserConfiguration {try{const c=JSON.parse(storage.getItem(configurationKey)??'null') as BrowserConfiguration;if(c?.version===1&&Array.isArray(c.blocks)&&c.blocks.every(validBlock)&&new Set(c.blocks.map(b=>b.id)).size===c.blocks.length&&Array.isArray(c.presets)&&c.presets.every(p=>typeof p.id==='string'&&typeof p.name==='string'&&Array.isArray(p.blocks)&&p.blocks.every(validBlock)))return c;}catch{}return defaultConfiguration();}
export function writeConfiguration(storage:Pick<Storage,'setItem'>,c:BrowserConfiguration):void {storage.setItem(configurationKey,JSON.stringify(c));}

/** Parses photographic values as data, including shutter fractions; never evaluates expressions. */
export function parseNumericInput(value:string,kind:BlockKind):number|undefined {const field=numericFields[kind];if(!field)return;try{return parseCatalogNumericInput(field,value);}catch{return;}}
