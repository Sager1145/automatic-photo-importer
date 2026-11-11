import {useRef,useState} from 'react';
import {Images} from 'lucide-react';
import type {CatalogQuery,CatalogRow} from '../../catalog/types';
import type {PreparedDrag} from '../../shared';
import {MAX_DRAG_FILES,type DragRequest} from '../../core/file-drag';
import {Icon} from '../ui';
import {useTranslation} from '../i18n';
import {chosenFiles,fileSelectionCount,type FileSelection} from './state';
import type {BrowserAPI} from './api';
/** The picture under the pointer while photos are dragged out: a small stack of photos with their number. */
function dragIcon(count:number):string{
 try{const canvas=document.createElement('canvas');canvas.width=canvas.height=64;const c=canvas.getContext('2d');if(!c)return '';
  const card=(x:number,y:number,fill:string)=>{c.fillStyle=fill;c.strokeStyle='#ffffff';c.lineWidth=2;c.beginPath();c.roundRect(x,y,40,30,5);c.fill();c.stroke();};
  card(16,8,'#4f6072');card(8,16,'#6f86a0');
  c.fillStyle='#ffffff';c.beginPath();c.moveTo(13,42);c.lineTo(22,31);c.lineTo(29,38);c.lineTo(34,34);c.lineTo(43,42);c.closePath();c.fill();
  const label=count>999?'999+':String(count);c.font='bold 13px system-ui, sans-serif';const width=Math.max(22,c.measureText(label).width+12);
  c.fillStyle='#d64545';c.beginPath();c.roundRect(63-width,42,width,20,10);c.fill();c.fillStyle='#ffffff';c.textAlign='center';c.textBaseline='middle';c.fillText(label,63-width/2,52.5);
  return canvas.toDataURL('image/png');}catch{return '';}
}
/** What a drag out of the Files column carries: the files chosen (`effectiveFiles`: the checked ones and the one clicked, each
 * with the RAW shown with it), or every file the columns show, except any unchecked after checking them all. */
export function dragRequestFor(libraryId:string,query:CatalogQuery,selection:FileSelection,rows:CatalogRow[]):DragRequest{
 if(!selection.all&&selection.ids.length)return {libraryId,fileIds:selection.ids.flatMap(id=>{const raw=rows.find(row=>row.fileId===id)?.pairedRaw;return raw?[id,raw.fileId]:[id];})};
 const {cursor:_,...rest}=query;return {libraryId,query:rest,except:selection.all?selection.ids:[]};
}
/** The Files column's last control, like LRTimelapse's drag button: drag it onto Lightroom Classic's Library grid or Import
 * window (or a file manager, Photoshop, any app that takes files). Main resolves the files when the pointer reaches it, so
 * the system drag starts at once. `selection` is what the Files column has chosen: `effectiveFiles` of the browser state. */
export function LightroomDrag({api,libraryId,online,query,selection,rows,total,revision}:{api:BrowserAPI;libraryId:string;online:boolean;query:CatalogQuery;selection:FileSelection;rows:CatalogRow[];total:number;revision:number}){
 const {t,formatNumber}=useTranslation();const chosen=fileSelectionCount(selection,total),count=chosen||total;
 // A selection that holds no file (every file unchecked after checking them all) carries every file shown, as its label says.
 const request=dragRequestFor(libraryId,query,chosenFiles(selection,total),rows);const key=JSON.stringify([request,revision]);
 const prepared=useRef<{key:string;promise:Promise<PreparedDrag>}>(undefined);const [ready,setReady]=useState<{key:string;result?:PreparedDrag;error?:string}>();
 const unavailable=!api.prepareDrag||!api.startDrag,disabled=unavailable||!online||count===0||count>MAX_DRAG_FILES;
 const prepare=()=>{if(disabled)return undefined;if(prepared.current?.key!==key){const promise=api.prepareDrag!(request);prepared.current={key,promise};promise.then(result=>setReady({key,result}),error=>setReady({key,error:String(error)}));}return prepared.current.promise;};
 const shown=ready?.key===key?ready:undefined;
 const note=!online?t('Connect the drive to drag photos.'):count>MAX_DRAG_FILES||shown?.result?.tooMany?t('Choose at most {max} photos to drag at once.',{max:formatNumber(MAX_DRAG_FILES)}):shown?.error?t('Could not prepare the drag.'):shown?.result?.skipped?t('{count} files could not be read and are left out.',{count:formatNumber(shown.result.skipped)}):shown?.result&&shown.result.files>count?t('{count} files, with paired RAWs and sidecars',{count:formatNumber(shown.result.files)}):'';
 return <div className="browser-drag-out" data-testid="lightroom-drag"><div role="button" tabIndex={disabled?-1:0} aria-disabled={disabled} draggable={!disabled} className={`browser-drag-handle ${disabled?'is-disabled':''}`} title={t('Drag onto Lightroom Classic’s Library grid or Import window to import these photos. File Explorer, Finder and other apps take the drop too; paired RAW files and sidecars such as .xmp go with them.')} onPointerEnter={()=>void prepare()?.catch(()=>{})} onPointerDown={()=>void prepare()?.catch(()=>{})} onFocus={()=>void prepare()?.catch(()=>{})} onDragStart={e=>{e.preventDefault();const promise=prepare();if(!promise)return;const icon=dragIcon(count);void promise.then(result=>{if(result.files&&!result.tooMany)api.startDrag!(result.token,icon);}).catch(()=>{});}}><Icon icon={Images} size={18}/><span className="browser-drag-label">{t('Drag to Lightroom')}</span><small>{chosen?t('{count} selected',{count:formatNumber(chosen)}):t('All {count}',{count:formatNumber(total)})}</small></div>{note&&<p className="browser-drag-note" role="status" title={note}>{note}</p>}</div>;
}
