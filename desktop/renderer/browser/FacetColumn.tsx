import {useMemo,useState,type ReactNode} from 'react';
import type {Filter} from '../../catalog/types';
import {Button} from '../ui';
import {useTranslation} from '../i18n';
import {formatNumericValue} from '../../catalog/values';
import {cameraDisplayName} from '../../camera-names';
import {addDates,buildDateTree,covers,dateState,dateTreeSummary,find,toggleDate,visibleDateRows,type DateNode} from './date-tree';
import {blockLabels,dateTreeLevels,fieldForBlock,isNumeric,parseNumericInput,type HierarchyBlock} from './configuration';
import {queryFor,type BrowserState} from './state';
import {addWithinLimit,bucketRows,chosenRowKeys,displayFacetValue,filterSize,formatRows,maxFilterValues,pickFits,selectedKeys,selectionFilter,toggleBlockSelection,unionFilters,visibleBucketRows,type BrowserOption} from './selection';
import {allFacets,usePaged} from './use-paged';
import {VirtualList} from './VirtualList';
import {ColumnCheckAll} from './ColumnCheckAll';
import type {BrowserAPI} from './api';
export function ColumnError({error,onRetry}:{error:string;onRetry:()=>void}){const {t}=useTranslation();return error?<div className="browser-column-error" role="alert"><p>{t('Could not read the catalog.')}</p><details><summary>{t('Details')}</summary><p>{error}</p></details><Button onClick={onRetry}>{t('Retry')}</Button></div>:null;}
function NumericRange({block,selection,onSelect}:{block:HierarchyBlock;selection?:Filter;onSelect:(filter?:Filter)=>void}){
 const {t}=useTranslation();const [min,setMin]=useState(''),[max,setMax]=useState('');const field=fieldForBlock(block);if(!isNumeric(field))return null;const minimum=parseNumericInput(min,block.kind),maximum=parseNumericInput(max,block.kind);const valid=(min!==''||max!=='')&&(!min||minimum!==undefined)&&(!max||maximum!==undefined)&&(minimum===undefined||maximum===undefined||minimum<=maximum);
 return <details className="browser-range"><summary>{t('Custom range')}</summary><form onSubmit={e=>{e.preventDefault();if(valid)onSelect({kind:'range',field,blockId:block.id,...(min?{min:minimum}:{}),...(max?{max:maximum}:{}),maxInclusive:true});}}><label>{t('Minimum')}<input type="text" inputMode="decimal" value={min} onChange={e=>setMin(e.target.value)}/></label><label>{t('Maximum')}<input type="text" inputMode="decimal" value={max} onChange={e=>setMax(e.target.value)}/></label><Button type="submit" disabled={!valid}>{t('Use range')}</Button>{selection?.kind==='range'&&<p>{selection.min??'−∞'} – {selection.max??'∞'}</p>}</form></details>;
}
/** One category column. A click on a row picks it (`onPick`: one row at a time, until another click); its checkbox checks it
 * (`onSelect`: the column's checked rows, until unchecked; `keepPick` keeps the click when they clear). The column filters the next ones by both. */
export function FacetColumn({block,depth,state,revision,api,onSelect,onPick,nameMenu}:{block:HierarchyBlock;depth:number;state:BrowserState;revision:number;api:BrowserAPI;onSelect:(filter?:Filter,keepPick?:boolean)=>void;onPick:(filter?:Filter)=>void;/** The column's heading as the button of its menu (an `<h3>` holding the name); absent, the name alone. */nameMenu?:ReactNode}){
 const {t,language,formatNumber}=useTranslation();const upstream=queryFor(state,depth);const query={...upstream,filters:upstream.filters.filter(filter=>filter.blockId!==block.id)};const field=fieldForBlock(block);const key=JSON.stringify([query,block]);
 const levels=dateTreeLevels(block);const grouped=levels.length>0||block.kind==='format'&&block.formatMode==='extension';
 const data=usePaged<BrowserOption>(key,revision,async cursor=>{const q={...query,cursor};const facets=grouped?await allFacets(api,query,field):await api.catalogFacets(q,field);let rows:BrowserOption[];if(levels.length)rows=facets.rows.map(row=>({key:`value:${typeof row.value}:${row.value}`,value:row.value,label:String(row.value),count:row.count}));else if(grouped)rows=formatRows(block,facets.rows);else if(block.numericMode==='buckets'&&isNumeric(field)){rows=bucketRows(block,[]);const totals=await Promise.all(rows.map(row=>api.catalogQuery({...query,filters:[...query.filters.filter(f=>f.blockId!==block.id),{kind:'range',field,blockId:`${block.id}-count`,...row.range}],limit:1})));rows=rows.map((row,i)=>({...row,count:totals[i]!.total}));}else rows=facets.rows.map(row=>({key:`value:${typeof row.value}:${row.value}`,value:row.value,label:block.kind==='date'?displayFacetValue(block,row.value,language):isNumeric(field)&&typeof row.value==='number'?formatNumericValue(field,row.value):row.value==='其他'?t('Other'):block.kind==='camera'?cameraDisplayName(row.label):row.label,count:row.count}));return {...facets,rows,...(block.numericMode==='buckets'&&isNumeric(field)?{nextCursor:undefined}:{})};},!!state.libraryId);
 const selection=state.selections[block.id],pick=state.picks[block.id];const chosen=useMemo(()=>unionFilters(block,selection,pick),[block,selection,pick]);const missingRow=(count:number):BrowserOption=>({key:'missing',label:t('Missing details'),count,missing:true});
 // A date tree: the catalog's values at the finest level, grouped under years and months; a row's arrow shows the rows below it.
 const tree=useMemo(()=>levels.length?buildDateTree(data.rows.map(row=>({value:row.value!,count:row.count??0})),levels,language):[],[data.rows,levels.join(),language]);
 const [expanded,setExpanded]=useState<ReadonlySet<string>>(()=>new Set());
 const chosenDates=selection?.kind==='values'?selection.values.map(String):[];
 const treeRows=useMemo(()=>visibleDateRows(tree,expanded).map(({node,depth,expanded:open}):BrowserOption=>({key:`date:${node.value}`,value:node.value,label:node.label,chip:node.chip,count:node.count,depth,expandable:node.children.length>0,expanded:open,...(dateState(chosenDates,node)==='partial'?{partial:true}:{})})),[tree,expanded,chosenDates.join()]);
 const rows=useMemo(()=>[...(levels.length?treeRows:visibleBucketRows(data.rows,chosen)),...(data.missingCount?[missingRow(data.missingCount)]:[])],[levels.length,treeRows,data.rows,data.missingCount,chosen,t]);
 const checked=levels.length?[...rows.filter(row=>{const node=row.value===undefined?undefined:find(tree,String(row.value));return !!node&&dateState(chosenDates,node)==='full';}).map(row=>row.key),...(selectedKeys(selection).includes('missing')?['missing']:[])]:chosenRowKeys(rows,selection);
 // The picked row: one date of the tree, or the one row whose values the pick holds; none when it does not fit beside the checks.
 const picked=!pick||!pickFits(block,selection,pick)?undefined:levels.length?pick.kind==='missing'?'missing':pick.kind==='values'&&pick.values.length===1?`date:${pick.values[0]}`:undefined:chosenRowKeys(rows,pick)[0];const shown=[...new Set([...checked,...(picked?[picked]:[])])];
 const buckets=block.numericMode==='buckets'&&isNumeric(field);const [selecting,setSelecting]=useState(false);
 // A column filters by at most `maxFilterValues` values: a check or a click past them is refused, a Shift range or Select all
 // stops there, and the column says why.
 const [note,setNote]=useState('');const limitNote=t('A column can filter by at most {max} values.',{max:formatNumber(maxFilterValues)});
 // A column's choices travel in one filter of at most 500 values; a column with more cannot check every row.
 const tooMany=!buckets&&!levels.length&&(data.total??0)>500;const all=!data.hasMore&&rows.length>0&&rows.every(row=>checked.includes(row.key));
 /** A date tree's choices as a filter: the years, months and days, and Missing details. */
 const dateFilter=(values:string[],missing:boolean):Filter|undefined=>values.length?{...selectionFilter(block,values,values.map(value=>find(tree,value)?.chip??value)),...(missing?{orMissing:true}:{})}:missing?{kind:'missing',field,blockId:block.id}:undefined;
 const missingChosen=selectedKeys(selection).includes('missing');
 // A date tree counts its top rows (each year, and Missing details) in its header; its checkbox is set when every year is fully checked.
 const summary=levels.length?dateTreeSummary(tree,chosenDates,{shown:!!data.missingCount,chosen:missingChosen},picked?.startsWith('date:')?picked.slice(5):picked):undefined;
 const master=(summary?summary.all:all)?'all':selection?'some':'none';
 const dateRow=(row:BrowserOption)=>row.value===undefined?undefined:find(tree,String(row.value));
 const send=(filter?:Filter,keepPick?:boolean)=>{if(filterSize(filter)>maxFilterValues){setNote(limitNote);return;}setNote('');onSelect(filter,keepPick);};
 // Unchecking the last checked row clears the column's checks; a click on another row stays.
 const check=(filter?:Filter)=>send(filter,true);
 const checkRow=(row:BrowserOption)=>{if(!levels.length){check(toggleBlockSelection(block,selection,row,true));return;}if(row.missing){check(dateFilter(chosenDates,!missingChosen));return;}const node=dateRow(row);if(node)check(dateFilter(toggleDate(chosenDates,tree,node,true),missingChosen));};
 /** The filter of one row alone: what a click picks. */
 const rowFilter=(row:BrowserOption):Filter|undefined=>{if(!levels.length)return toggleBlockSelection(block,undefined,row,false);if(row.missing)return {kind:'missing',field,blockId:block.id};const node=dateRow(row);return node?dateFilter([node.value],false):undefined;};
 /** Checks rows (a Shift range, Select all) in their order up to the limit; nothing is sent when nothing changes. */
 const sendAdded=(filter:Filter|undefined,cut:boolean)=>{setNote(cut?limitNote:'');if(JSON.stringify(filter)!==JSON.stringify(selection))onSelect(filter);};
 const addNodes=(nodes:readonly DateNode[],missing:boolean)=>{const dates=addDates(chosenDates,nodes,maxFilterValues);sendAdded(dateFilter(dates,missingChosen||missing),nodes.some(node=>!covers(dates,node.value)));};
 const add=(added:readonly BrowserOption[])=>{if(levels.length){addNodes(added.map(dateRow).filter((node):node is DateNode=>!!node),added.some(row=>row.missing));return;}const {filter,cut}=addWithinLimit(block,selection,added);sendAdded(filter,cut);};
 const selectAll=async()=>{if(levels.length){addNodes(tree,!!data.missingCount);return;}setSelecting(true);try{const loaded=data.hasMore?await data.readAll():data.rows;if(loaded)add([...visibleBucketRows(loaded,selection),...(data.missingCount?[missingRow(data.missingCount)]:[])]);}finally{setSelecting(false);}};
 // Both sides of the header count the same rows: each value, bucket, format or year, and Missing details when it is shown.
 const count=summary?summary.total:buckets||grouped?rows.length:data.total===undefined?undefined:data.total+(data.missingCount?1:0);
 const selectedCount=summary?summary.chosen:buckets||grouped?shown.length:Math.min(new Set(selectedKeys(chosen)).size,count??Number.MAX_SAFE_INTEGER);
 const name=t(blockLabels[block.kind]);const observed=data.min!==undefined&&data.max!==undefined?t('Observed: {min}–{max}',{min:isNumeric(field)&&typeof data.min==='number'?formatNumericValue(field,data.min):data.min,max:isNumeric(field)&&typeof data.max==='number'?formatNumericValue(field,data.max):data.max}):'';
 // The coverage keeps one line: known and missing first, then what fits of pending, unreadable and the observed range; all of it in its tooltip.
 const coverage=[t('{known} known · {missing} missing',{known:formatNumber(data.knownCount??0),missing:formatNumber(data.missingCount??0)}),...(data.pendingCount?[t('{count} pending',{count:formatNumber(data.pendingCount)})]:[]),...(data.errorCount?[t('{count} unreadable',{count:formatNumber(data.errorCount)})]:[]),...(observed?[observed]:[])].join(' · ');
 // One header line, as in Lightroom's columns: the check-all box over the rows' boxes, the name that opens the column menu, the count.
 return <section className={`browser-column${levels.length?' is-tree':''}`} data-column-index={depth} data-testid="facet-column"><header><ColumnCheckAll state={master} name={name} disabled={master==='none'&&(!rows.length||tooMany||selecting)} title={master==='none'&&tooMany?t('Too many values to select at once'):undefined} onChange={select=>select?void selectAll():send()}/>{nameMenu??<h3>{name}</h3>}<small title={selectedCount?t('{count} selected',{count:formatNumber(selectedCount)}):undefined}>{!!selectedCount&&<span className="browser-column-selected">{formatNumber(selectedCount)}/</span>}{count===undefined?'—':formatNumber(count)}</small></header><p className="browser-coverage" title={coverage}>{coverage}</p>{note&&<p className="browser-column-note" role="status">{note}</p>}<ColumnError error={data.error} onRetry={data.reload}/><VirtualList rows={rows} checked={checked} picked={picked} label={`${depth+1}. ${t(blockLabels[block.kind])}`} loading={data.loading} hasMore={data.hasMore} onMore={data.more} onClear={()=>send()} onPick={row=>{const filter=row.key===picked?undefined:rowFilter(row);if(filter&&!pickFits(block,selection,filter)){setNote(limitNote);return;}setNote('');onPick(filter);}} onCheck={checkRow} onExtend={add} onExpand={(row,open)=>setExpanded(previous=>{const next=new Set(previous);if(row.value!==undefined){if(open)next.add(String(row.value));else next.delete(String(row.value));}return next;})}/>{isNumeric(field)&&<NumericRange block={block} selection={state.selections[block.id]} onSelect={onSelect}/>}</section>;
}
