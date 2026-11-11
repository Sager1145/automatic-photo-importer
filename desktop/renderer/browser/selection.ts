import type {FacetRow,Filter,NumericBucket} from '../../catalog/types';
import type {Language} from '../../shared';
import {formatNumericValue,formatNumericBucket} from '../../catalog/values';
import {formatGroup} from '../../media-formats';
import {cameraDisplayName} from '../../camera-names';
import {fieldForBlock,isNumeric,numericBuckets,type HierarchyBlock} from './configuration';
/** One column's choice of exact values, with what the rows showed for them. */
export function selectionFilter(block:HierarchyBlock,values:(string|number)[],labels?:string[]):Filter {return {kind:'values',field:fieldForBlock(block),values,blockId:block.id,...(labels?{labels}:{})};}
export interface BrowserOption {key:string;label:string;count?:number;value?:string|number;range?:NumericBucket;missing?:boolean;/** Shown after the label, e.g. the RAW paired with a JPEG. */badge?:string;/** One row for several values (JPG, JPEG and JPE as JPEG): choosing it chooses them all. */values?:(string|number)[];/** The selection bar's text for this row, when it differs from the label. */chip?:string;/** A tree row: its depth, and whether it has rows below it and shows them. */depth?:number;expandable?:boolean;expanded?:boolean;/** Some rows below it are checked, not all: shown striped, its checkbox half set. */partial?:boolean;}
/** The values a row stands for, each as a row of its own, so a merged row is chosen and unchosen as a whole. */
export function memberOptions(row:BrowserOption):BrowserOption[]{return row.values?row.values.map(value=>({key:`value:${typeof value}:${value}`,value,label:row.chip??row.label,chip:row.chip??row.label})):[row];}
/** The keys of the shown rows that are chosen: a merged row when every value it stands for is. */
export function chosenRowKeys(rows:readonly BrowserOption[],filter:Filter|undefined):string[]{const chosen=new Set(selectedKeys(filter));return rows.filter(row=>memberOptions(row).every(member=>chosen.has(member.key))).map(row=>row.key);}
const rangeKey=(range:NumericBucket)=>`range:${JSON.stringify(range)}`;
const membershipKey=(range:NumericBucket)=>range.min!==undefined&&range.min===range.max&&range.maxInclusive?`value:number:${range.min}`:rangeKey(range);
export function bucketRows(block:HierarchyBlock,rows:FacetRow[]):BrowserOption[]{const field=fieldForBlock(block);if(!isNumeric(field))return [];return numericBuckets(block.boundaries).map(range=>({key:rangeKey(range),range,label:formatNumericBucket(field,range),count:rows.reduce((sum,row)=>sum+(typeof row.value==='number'&&(range.min===undefined||row.value>=range.min)&&(range.max===undefined||(range.maxInclusive?row.value<=range.max:row.value<range.max))?row.count:0),0)}));}
export function visibleBucketRows(rows:BrowserOption[],selection:Filter|undefined):BrowserOption[]{const selected=new Set(selectedKeys(selection));return rows.filter(row=>!row.range||(row.count??0)>0||selected.has(row.key));}
/** Rows chosen in one column are alternatives (OR); Missing details joins them as `orMissing`. */
export function selectionFromRows(block:HierarchyBlock,rows:BrowserOption[]):Filter|undefined{if(!rows.length)return undefined;const field=fieldForBlock(block);const missing=rows.some(r=>r.missing),known=rows.filter(r=>!r.missing);if(!known.length)return {kind:'missing',field,blockId:block.id};const orMissing=missing?{orMissing:true}:{};if(isNumeric(field)&&known.some(r=>r.range))return {kind:'ranges',field,blockId:block.id,ranges:known.flatMap(r=>r.range?[r.range]:typeof r.value==='number'?[{min:r.value,max:r.value,maxInclusive:true}]:[]),...orMissing};const chosen=known.filter(r=>r.value!==undefined);return {...selectionFilter(block,chosen.map(r=>r.value!),block.kind==='camera'||block.kind==='lens'||chosen.some(r=>r.chip!==undefined)?chosen.map(r=>r.chip??r.label):undefined),...orMissing};}
/** Selection membership belongs to the block's filter, including choices outside the loaded page. */
function selectionOptions(filter:Filter|undefined):BrowserOption[] {
 let previous:BrowserOption[]=[];
 if(filter?.kind==='values')previous=filter.values.map((value,index)=>({key:`value:${typeof value}:${value}`,value,label:filter.labels?.[index]??String(value),...(filter.labels?.[index]!==undefined?{chip:filter.labels[index]}:{})}));
 if(filter?.kind==='missing')previous=[{key:'missing',label:'',missing:true}];
 if(filter?.kind==='range'||filter?.kind==='ranges')previous=(filter.kind==='range'?[filter]:filter.ranges).map(value=>{const range:NumericBucket={...(value.min===undefined?{}:{min:value.min}),...(value.max===undefined?{}:{max:value.max}),maxInclusive:value.maxInclusive??true};return {key:membershipKey(range),range,label:''};});
 if((filter?.kind==='values'||filter?.kind==='ranges')&&filter.orMissing)previous.push({key:'missing',label:'',missing:true});
 return previous;
}
/** A checkbox toggles one row; without `multi` the filter is that row alone (a click's temporary choice). */
export function toggleBlockSelection(block:HierarchyBlock,filter:Filter|undefined,row:BrowserOption,multi:boolean):Filter|undefined {
 const previous=selectionOptions(filter),members=memberOptions(row),memberKeys=new Set(members.map(member=>member.key));
 let next=multi?previous:[];
 if(multi&&members.every(member=>previous.some(option=>option.key===member.key)))next=next.filter(option=>!memberKeys.has(option.key));
 else next=[...next.filter(option=>!memberKeys.has(option.key)),...members];
 return selectionFromRows(block,next);
}
/** Checks rows (a Shift range, or the column's checkbox) in addition to the column's checked rows, keeping choices outside the loaded page. */
export function addBlockSelection(block:HierarchyBlock,filter:Filter|undefined,rows:BrowserOption[]):Filter|undefined {return addWithinLimit(block,filter,rows).filter;}
/** Adds rows in their order while the filter holds at most `maxFilterValues` (a merged row adds all its values or none);
 * `cut` when some were left out. Missing details adds no value, so it is always added. */
export function addWithinLimit(block:HierarchyBlock,filter:Filter|undefined,rows:readonly BrowserOption[]):{filter:Filter|undefined;cut:boolean} {
 const next=selectionOptions(filter),keys=new Set(next.map(option=>option.key));let size=next.filter(option=>!option.missing).length,cut=false;
 for(const row of rows){const members=memberOptions(row).filter(member=>!keys.has(member.key)),adds=members.filter(member=>!member.missing).length;if(adds&&(cut||size+adds>maxFilterValues)){cut=true;continue;}size+=adds;for(const member of members){keys.add(member.key);next.push(member);}}
 return {filter:selectionFromRows(block,next),cut};
}
/** The most values (or ranges) one filter may hold: the catalog refuses more. */
export const maxFilterValues=500;
/** How many values (or ranges) a filter holds, which the catalog limits to `maxFilterValues`. */
export const filterSize=(f:Filter|undefined)=>f?.kind==='values'?f.values.length:f?.kind==='ranges'?f.ranges.length:0;
/** Everything two filters of one column choose, as one filter (the catalog ORs one filter's values): the checked rows and
 * the clicked one. Values, ranges and Missing details each once, with their labels; a date inside a chosen year or month adds nothing.
 * When the two together would hold more than `maxFilterValues`, `a` alone (the checked rows without the click). */
export function unionFilters(block:HierarchyBlock,a:Filter|undefined,b:Filter|undefined):Filter|undefined {const both=joinFilters(block,a,b);return a&&filterSize(both)>maxFilterValues?a:both;}
/** Whether `b` (a click) joins `a` (the checked rows) within the catalog's limit. */
export function pickFits(block:HierarchyBlock,a:Filter|undefined,b:Filter|undefined):boolean {return !a||!b||filterSize(joinFilters(block,a,b))<=maxFilterValues;}
function joinFilters(block:HierarchyBlock,a:Filter|undefined,b:Filter|undefined):Filter|undefined {
 if(!a||!b)return a??b;if(a.kind==='placement'||b.kind==='placement')return b;
 const seen=new Set<string>();let rows=[...selectionOptions(a),...selectionOptions(b)].filter(row=>!seen.has(row.key)&&!!seen.add(row.key));
 if(block.kind==='date')rows=rows.filter(row=>row.value===undefined||!rows.some(other=>other.value!==undefined&&String(row.value).startsWith(String(other.value)+'-')));
 return selectionFromRows(block,rows);
}
/** Whether `outer` holds every row `inner` chooses (the clicked row is among the checked ones). */
export function filterIncludes(outer:Filter|undefined,inner:Filter):boolean {const keys=new Set(selectionOptions(outer).map(row=>row.key));const own=selectionOptions(inner);return own.length>0&&own.every(row=>keys.has(row.key));}
/** Chip text for exact values and single ranges, in the same units as the columns. */
export function selectionValueLabel(block:HierarchyBlock,filter:Filter,language:Language):string {const field=fieldForBlock(block);if(filter.kind==='values')return filter.values.map((value,index)=>filter.labels?.[index]??displayFacetValue(block,value,language)).join(', ');if(filter.kind==='range')return isNumeric(field)?formatNumericBucket(field,{min:filter.min,max:filter.max,maxInclusive:filter.maxInclusive??true}):`${filter.min??'−∞'} – ${filter.max??'∞'}`;if(filter.kind==='ranges')return filter.ranges.map(range=>formatNumericBucket(filter.field,{min:range.min,max:range.max,maxInclusive:range.maxInclusive??true})).join(', ');return '';}
/** The selection bar's text for one column: its choices in column units (the first few, then how many more), and how many there are. */
export function selectionSummary(block:HierarchyBlock,filter:Filter,language:Language,missingLabel:string,shown=3):{text:string;count:number}{
 const parts=filter.kind==='values'?filter.values.map((value,index)=>selectionValueLabel(block,{...filter,values:[value],...(filter.labels?{labels:[filter.labels[index]!]}:{})},language)):filter.kind==='ranges'?filter.ranges.map(range=>selectionValueLabel(block,{kind:'range',field:filter.field,...range},language)):filter.kind==='range'?[selectionValueLabel(block,filter,language)]:[];
 if(filter.kind==='missing'||(filter.kind==='values'||filter.kind==='ranges')&&filter.orMissing)parts.push(missingLabel);
 // A merged row (JPEG for JPG and JPEG, a chosen year) is one choice.
 parts.splice(0,parts.length,...new Set(parts));
 const text=parts.length>shown?`${parts.slice(0,shown).join(', ')} +${parts.length-shown}`:parts.join(', ');
 return {text,count:parts.length};
}
export function displayFacetValue(block:HierarchyBlock,value:string|number,language:Language):string {const field=fieldForBlock(block);if(isNumeric(field)&&typeof value==='number')return formatNumericValue(field,value);if(block.kind==='camera')return cameraDisplayName(String(value));if(block.kind!=='date')return String(value);const match=String(value).match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);if(!match)return String(value);let pattern=block.datePattern;if(block.dateGranularity==='year')pattern='YYYY';if(block.dateGranularity==='month'&&!pattern.includes('YYYY'))pattern='YYYY '+pattern;return pattern.replace(/YYYY|MM|DD/g,token=>token==='YYYY'?match[1]!:token==='MM'?match[2]??'—':match[3]??'—');}
export function selectedKeys(filter:Filter|undefined):string[]{if(!filter)return [];if(filter.kind==='missing')return ['missing'];const missing=(filter.kind==='values'||filter.kind==='ranges')&&filter.orMissing?['missing']:[];if(filter.kind==='values')return [...filter.values.map(v=>`value:${typeof v}:${v}`),...missing];if(filter.kind==='ranges')return [...filter.ranges.map(r=>membershipKey({...r,maxInclusive:r.maxInclusive??true})),...missing];return [];}
/** Format rows as shown: with `mergeSpellings` one row per format (JPG, JPEG and JPE as JPEG), with `rawAsOne` one RAW row. */
export function formatRows(block:HierarchyBlock,rows:readonly {value:string|number;count:number}[]):BrowserOption[] {
 const groups=new Map<string,{values:(string|number)[];count:number}>();
 for(const row of rows){const name=formatGroup(String(row.value),{mergeSpellings:block.mergeSpellings,rawAsOne:block.rawAsOne});const group=groups.get(name)??{values:[],count:0};group.values.push(row.value);group.count+=row.count;groups.set(name,group);}
 return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([name,group])=>group.values.length===1?{key:`value:${typeof group.values[0]}:${group.values[0]}`,value:group.values[0],label:name,chip:name,count:group.count}:{key:`format:${name}`,values:group.values,label:name,chip:name,count:group.count});
}
