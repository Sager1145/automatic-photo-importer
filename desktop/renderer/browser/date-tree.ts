import type {Language} from '../../shared';
import type {DateLevel} from './configuration';

/** One row of the Library browser's date tree: a year, month or day (only the levels the block shows), with the files
 * under it. `value` is what the catalog filters by: the date to that level ("2026", "2026-11", "2026-11-03"), which a
 * capture day or month matches by its start, so a whole year or month is one value. */
export interface DateNode {value:string;level:DateLevel;label:string;/** The date in full, for the selection bar. */chip:string;count:number;children:DateNode[];}

const lengths:Record<DateLevel,number>={year:4,month:7,day:10};
const utc=(value:string)=>{const [y,m='01',d='01']=value.split('-');return new Date(Date.UTC(Number(y),Number(m)-1,Number(d)));};
const format=(language:Language,options:Intl.DateTimeFormatOptions,value:string)=>new Intl.DateTimeFormat(language,{timeZone:'UTC',...options}).format(utc(value));

/** A row's label. Each level says only what its parents do not: under a year a month is its name, under a month a day is
 * its number and weekday ("3 · Tuesday"); without the level above, the label carries it ("November 2026", "Nov 3 · Tue"). */
export function dateLabel(value:string,level:DateLevel,levels:readonly DateLevel[],language:Language):string {
 if(level==='year')return value.slice(0,4);
 if(level==='month')return format(language,levels.includes('year')?{month:'long'}:{year:'numeric',month:'long'},value);
 const weekday=format(language,{weekday:levels.includes('month')?'long':'short'},value);
 const day=levels.includes('month')?format(language,{day:'numeric'},value):levels.includes('year')?format(language,{month:'short',day:'numeric'},value):format(language,{year:'numeric',month:'short',day:'numeric'},value);
 return `${day} · ${weekday}`;
}
/** The date in full at its level, for the selection bar ("2026", "November 2026", "Nov 3, 2026"). */
export function dateChip(value:string,level:DateLevel,language:Language):string {
 if(level==='year')return value.slice(0,4);
 return format(language,level==='month'?{year:'numeric',month:'long'}:{year:'numeric',month:'short',day:'numeric'},value);
}

/** The tree for the catalog's values at the finest level shown (days "2026-11-03", months "2026-11" or years), oldest first. */
export function buildDateTree(rows:readonly {value:string|number;count:number}[],levels:readonly DateLevel[],language:Language):DateNode[] {
 const roots:DateNode[]=[];const byValue=new Map<string,DateNode>();
 const finest=levels.at(-1)!;
 for(const row of rows){
  const full=String(row.value);if(full.length<lengths[finest]||!/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(full))continue;
  let siblings=roots;
  for(const level of levels){
   const value=full.slice(0,lengths[level]);let node=byValue.get(value);
   if(!node){node={value,level,label:dateLabel(value,level,levels,language),chip:dateChip(value,level,language),count:0,children:[]};byValue.set(value,node);siblings.push(node);}
   node.count+=row.count;siblings=node.children;
  }
 }
 const sort=(nodes:DateNode[])=>{nodes.sort((a,b)=>a.value<b.value?-1:a.value>b.value?1:0);for(const node of nodes)sort(node.children);};
 sort(roots);return roots;
}

export interface DateRow {node:DateNode;depth:number;expanded:boolean;}
/** The rows shown: every top row, and the children of each expanded row. */
export function visibleDateRows(tree:readonly DateNode[],expanded:ReadonlySet<string>):DateRow[] {
 const rows:DateRow[]=[];
 const walk=(nodes:readonly DateNode[],depth:number)=>{for(const node of nodes){const open=expanded.has(node.value)&&node.children.length>0;rows.push({node,depth,expanded:open});if(open)walk(node.children,depth+1);}};
 walk(tree,0);return rows;
}

/** A row is chosen when it or a row above it is (a chosen year covers its months and days). */
export const covers=(chosen:readonly string[],value:string)=>chosen.some(v=>value===v||value.startsWith(v+'-'));

/** A click on a row. Alone it becomes the only choice. With Command or Space (`multi`) it is added, or taken out: a row
 * chosen through its year or month leaves that choice as its other months or days, so everything else stays chosen.
 * Choosing a row drops the choices below it, which it now covers. */
export function toggleDate(chosen:readonly string[],tree:readonly DateNode[],node:DateNode,multi:boolean):string[] {
 if(!multi)return [node.value];
 if(chosen.includes(node.value))return chosen.filter(v=>v!==node.value);
 const above=chosen.find(v=>node.value.startsWith(v+'-'));
 if(above===undefined)return [...chosen.filter(v=>!v.startsWith(node.value+'-')),node.value];
 // Split the covering choice into the rows beside the path down to this one.
 const next=chosen.filter(v=>v!==above);let level=find(tree,above);
 while(level&&level.value!==node.value){const step=level.children.find(child=>node.value===child.value||node.value.startsWith(child.value+'-'));for(const child of level.children)if(child!==step)next.push(child.value);level=step;}
 return next;
}
/** Adds rows (a Shift range, or Select all), dropping choices they cover. */
export function addDates(chosen:readonly string[],nodes:readonly DateNode[]):string[] {
 let next=[...chosen];
 for(const node of nodes)if(!covers(next,node.value))next=[...next.filter(v=>!v.startsWith(node.value+'-')),node.value];
 return next;
}
export function find(tree:readonly DateNode[],value:string):DateNode|undefined {
 for(const node of tree){if(node.value===value)return node;if(value.startsWith(node.value+'-')){const below=find(node.children,value);if(below)return below;}}
 return undefined;
}
