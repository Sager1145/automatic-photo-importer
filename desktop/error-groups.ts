import {codeOf,groupedCodes,pathOf,type Severity} from './error-log';
import {MAX_GROUP_ITEMS} from './shared';
import type {Message} from './messages';

/** What a row needs of an error entry; the renderer's display errors satisfy it. */
export interface Groupable {id?:string;code?:string;source:string;message:Message;severity:Severity;jobId?:string;sourceId?:string;count?:number;items?:{path:string;detail?:string}[];}
export interface RowItem<E> {path?:string;detail?:string;/** The entry this item stands for; its message is formatted only when shown. */entry?:E;}
/** One row of All errors: all entries of one (job, code, severity) when the code is grouped, else a single entry. */
export interface ErrorRow<E extends Groupable> {key:string;code:string;severity:Severity;/** Problems the row stands for. */count:number;merged:boolean;entries:E[];/** At most MAX_GROUP_ITEMS; the rest are fetched on demand. */items:RowItem<E>[];}

/** Builds the rows in order of first appearance. Work is linear in the entries; no paths are formatted. */
export function buildRows<E extends Groupable>(errors:E[]):ErrorRow<E>[]{
 const rows:ErrorRow<E>[]=[],merged=new Map<string,ErrorRow<E>>();
 for(const [index,error] of errors.entries()){
  const code=error.code??codeOf(error.message),weight=error.count??1;
  const add=(row:ErrorRow<E>)=>{
   row.entries.push(error);row.count+=weight;
   if(error.items)for(const item of error.items){if(row.items.length>=MAX_GROUP_ITEMS)break;row.items.push({path:item.path,...(item.detail?{detail:item.detail}:{})});}
   else if(row.items.length<MAX_GROUP_ITEMS){const path=pathOf(error.message);row.items.push({...(path?{path}:{}),entry:error});}
  };
  if(groupedCodes.has(code)){
   const key=`${error.jobId??error.sourceId??''}|${error.source}|${code}|${error.severity}`;
   let row=merged.get(key);
   if(!row){row={key,code,severity:error.severity,count:0,merged:true,entries:[],items:[]};merged.set(key,row);rows.push(row);}
   add(row);
  }else{
   const row:ErrorRow<E>={key:error.id??`row${index}`,code,severity:error.severity,count:0,merged:false,entries:[],items:[]};
   add(row);rows.push(row);
  }
 }
 // One plain entry keeps its own card with the full message; only real groups (or entries that already stand for many) collapse.
 for(const row of rows)if(row.merged&&row.entries.length===1&&!row.entries[0]!.items)row.merged=false;
 return rows;
}
/** The badge: rows needing attention per severity, from the summaries; paths are never touched. */
export function rowCounts<E extends Groupable>(rows:ErrorRow<E>[]){
 let errors=0,warnings=0;for(const row of rows)if(row.severity==='error')errors++;else warnings++;
 return {errors,warnings};
}
