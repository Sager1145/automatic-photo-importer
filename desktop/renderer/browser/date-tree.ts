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

/** A row's files are chosen when it or a row above it is checked (a checked year covers its months and days). */
export const covers=(chosen:readonly string[],value:string)=>chosen.some(v=>value===v||value.startsWith(v+'-'));

/** How a row's checkbox shows: checked when the row is checked itself or every row below it is (all its months, or all their
 * days); partial (half set, the row striped) when only some rows below it are; none otherwise. Rows below a checked row are
 * not checked themselves. */
export function dateState(chosen:readonly string[],node:DateNode):'full'|'partial'|'none' {
 if(chosen.includes(node.value))return 'full';
 if(!node.children.length)return 'none';
 const states=node.children.map(child=>dateState(chosen,child));
 if(states.every(state=>state==='full'))return 'full';
 return states.some(state=>state!=='none')?'partial':'none';
}

/** The column's header: its top rows (each year, and Missing details when `missing.shown`), how many have anything in them chosen
 * (checked, or the clicked `picked` date or 'missing'), and whether all is checked: every year full, and Missing details if shown. */
export function dateTreeSummary(tree:readonly DateNode[],chosen:readonly string[],missing:{shown:boolean;chosen:boolean},picked?:string):{all:boolean;chosen:number;total:number} {
 const top=[...tree.map(node=>dateState(chosen,node)!=='none'||picked!==undefined&&covers([node.value],picked)),...(missing.shown?[missing.chosen||picked==='missing']:[])];
 return {all:tree.length>0&&tree.every(node=>dateState(chosen,node)==='full')&&(!missing.shown||missing.chosen),chosen:top.filter(Boolean).length,total:top.length};
}
/** A row's checkbox (`multi`; Space or Ctrl/Command-click in the list) checks it or, when checked, unchecks it; every other
 * check stays, so years, months and days of several years can be checked together. Checking a row unchecks the rows
 * above it (a month inside a checked year leaves only that month of the year checked, the year's other months not) and
 * the rows below it, which it covers. Without `multi` it becomes the only one. */
export function toggleDate(chosen:readonly string[],_tree:readonly DateNode[],node:DateNode,multi:boolean):string[] {
 if(!multi)return [node.value];
 if(chosen.includes(node.value))return chosen.filter(v=>v!==node.value);
 return [...chosen.filter(v=>!node.value.startsWith(v+'-')&&!v.startsWith(node.value+'-')),node.value];
}
/** Checks rows (a Shift range, or the column's checkbox), dropping checks they cover. */
export function addDates(chosen:readonly string[],nodes:readonly DateNode[]):string[] {
 let next=[...chosen];
 for(const node of nodes)if(!covers(next,node.value))next=[...next.filter(v=>!v.startsWith(node.value+'-')),node.value];
 return next;
}
export function find(tree:readonly DateNode[],value:string):DateNode|undefined {
 for(const node of tree){if(node.value===value)return node;if(value.startsWith(node.value+'-')){const below=find(node.children,value);if(below)return below;}}
 return undefined;
}
