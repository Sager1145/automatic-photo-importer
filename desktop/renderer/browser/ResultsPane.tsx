import {useEffect,useRef,useState,type CSSProperties,type Dispatch,type ReactNode} from 'react';
import type {CatalogQuery,CatalogRow} from '../../catalog/types';
import {useTranslation} from '../i18n';
import {effectiveFiles,fileSelected,fileSelectionCount,type BrowserAction,type BrowserState} from './state';
import type {usePaged} from './use-paged';
import {VirtualList} from './VirtualList';
import {ColumnError} from './FacetColumn';
import {ColumnCheckAll} from './ColumnCheckAll';
import {LightroomDrag} from './LightroomDrag';
import type {BrowserAPI} from './api';
import {clampPreviewWidth,maxPreviewWidth,minPreviewWidth} from './configuration';
/** The preview's default width beside the list: about a third of the room, within 250–380 px. */
export const defaultPreviewWidth=(room:number)=>Math.round(Math.max(250,Math.min(380,room*.34)));
/** Below the columns, like Lightroom Classic's grid under its filter bar: the files the columns show, with their count, check-all,
 * sort and the handle that drags them out in the header; the picked file's preview (`preview`) sits beside the list. The page
 * closes the preview on Escape, here and in the columns, before a list clears. */
export function ResultsPane({state,dispatch,files,api,libraryId,online,query,revision,preview,tools,height,previewWidth,previewLarge=false,onPreviewWidth}:{state:BrowserState;dispatch:Dispatch<BrowserAction>;files:ReturnType<typeof usePaged<CatalogRow>>;api:BrowserAPI;libraryId:string;online:boolean;query:CatalogQuery;revision:number;preview?:ReactNode;/** More controls for how the files are listed, after Sort. */tools?:ReactNode;height?:number;/** The preview's chosen width; absent: the default. */previewWidth?:number;/** The preview takes all the room but the list's minimum. */previewLarge?:boolean;/** The divider was dragged (a width) or double-clicked (undefined: the default). */onPreviewWidth?:(width:number|undefined)=>void}){
 const {t,formatNumber}=useTranslation();
 // The body's width is measured (never the panes), so the preview's width can leave the list its minimum.
 const body=useRef<HTMLDivElement>(null);const [room,setRoom]=useState<number>();
 useEffect(()=>{const node=body.current;if(!node||typeof ResizeObserver==='undefined')return;const update=()=>setRoom(node.clientWidth||undefined);update();const observer=new ResizeObserver(update);observer.observe(node);return()=>observer.disconnect();},[]);
 const widest=room===undefined?undefined:clampPreviewWidth(maxPreviewWidth,room),shownWidth=room===undefined?undefined:previewLarge?widest:clampPreviewWidth(previewWidth??defaultPreviewWidth(room),room);const total=files.total??0;const chosen=effectiveFiles(state),count=fileSelectionCount(chosen,total),checked=fileSelectionCount(state.files,total);
 return <section className={`browser-results ${preview?'has-preview':''}`} data-testid="browser-files" style={{height}} aria-label={t('Files')}>
  <header><ColumnCheckAll name={t('Files')} state={checked===0?'none':checked>=total&&total>0?'all':'some'} disabled={total===0} onChange={select=>dispatch({type:'allFiles',select})}/><h3>{t('Files')}</h3><small title={count?t('{count} selected',{count:formatNumber(count)}):undefined}>{count>0&&<span className="browser-column-selected">{formatNumber(count)}/</span>}{formatNumber(total)}</small>
   <label className="browser-field browser-sort"><span>{t('Sort')}</span><select value={`${state.sort.field}:${state.sort.direction}`} onChange={e=>{const [field,direction]=e.target.value.split(':');dispatch({type:'sort',sort:{field:field as CatalogQuery['sort']['field'],direction:direction as 'asc'|'desc'}});}}><option value="name:asc">{t('Name A–Z')}</option><option value="name:desc">{t('Name Z–A')}</option><option value="captured:desc">{t('Newest capture first')}</option><option value="captured:asc">{t('Oldest capture first')}</option></select></label>{tools}
   <LightroomDrag api={api} libraryId={libraryId} online={online} query={query} selection={chosen} rows={files.rows} total={total} revision={revision}/></header>
  <div ref={body} className="browser-results-body" style={preview&&shownWidth!==undefined?{'--browser-preview-width':`${shownWidth}px`} as CSSProperties:undefined}><div className="browser-results-list"><ColumnError error={files.error} onRetry={files.reload}/><VirtualList label={t('Files')} rows={files.rows.map(r=>({key:r.fileId,label:r.name,badge:r.pairedRaw?`${r.extension.toUpperCase()} + ${r.pairedRaw.extension.toUpperCase()}`:r.extension.toUpperCase()}))} checked={files.rows.filter(r=>fileSelected(state.files,r.fileId)).map(r=>r.fileId)} picked={state.selectedFile} loading={files.loading} hasMore={files.hasMore} onMore={files.more} onPick={r=>dispatch({type:'file',fileId:r.key})} onCheck={r=>dispatch({type:'toggleFile',fileId:r.key})} onExtend={added=>dispatch({type:'addFiles',fileIds:added.map(r=>r.key)})} onClear={()=>dispatch({type:'allFiles',select:false})}/></div>{preview&&onPreviewWidth&&<PreviewResize width={shownWidth} max={widest??maxPreviewWidth} onResize={onPreviewWidth}/>}{preview}</div>
 </section>;
}
/** The divider between the list and the preview: drag it, or use Left (wider preview) and Right on it; double-click restores the default. */
function PreviewResize({width,max,onResize}:{width?:number;max:number;onResize:(width:number|undefined)=>void}){
 const {t}=useTranslation();const clamp=(value:number)=>Math.round(Math.max(minPreviewWidth,Math.min(max,value)));const current=(node:HTMLElement)=>width??node.nextElementSibling?.getBoundingClientRect().width??minPreviewWidth;
 return <div className="browser-preview-resize" role="separator" aria-orientation="vertical" aria-label={t('Preview width')} title={t('Drag or use the arrow keys to resize the preview. Double-click restores the default width.')} aria-valuemin={minPreviewWidth} aria-valuemax={Math.round(max)} aria-valuenow={width===undefined?undefined:Math.round(width)} tabIndex={0} onDoubleClick={()=>onResize(undefined)} onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();e.stopPropagation();onResize(clamp(current(e.currentTarget)+(e.key==='ArrowLeft'?20:-20)));}}} onPointerDown={e=>{e.preventDefault();const start=e.clientX,from=current(e.currentTarget);const move=(event:PointerEvent)=>onResize(clamp(from-(event.clientX-start)));const end=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);};window.addEventListener('pointermove',move);window.addEventListener('pointerup',end,{once:true});}}><span/></div>;
}
