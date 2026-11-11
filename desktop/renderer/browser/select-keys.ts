import type {KeyboardEvent} from 'react';
/** The system the renderer runs on: the main process's `state.platform` when the page has it, else read from the browser. */
export type SelectPlatform='darwin'|'win32'|'linux';
export const rendererPlatform=(known?:string):SelectPlatform=>known==='darwin'||known==='win32'||known==='linux'?known:/Mac/i.test(typeof navigator==='undefined'?'':navigator.platform)?'darwin':/Win/i.test(typeof navigator==='undefined'?'':navigator.platform)?'win32':'linux';
/** An entry of a select's list in document order: an option (disabled itself or by its group) or an optgroup's label, never chosen. */
export type SelectEntry={disabled?:boolean;group?:boolean};
export type SelectStepKey='ArrowUp'|'ArrowDown'|'Home'|'End';
/** The entry a key moves a closed select to: the previous or next enabled option, or the first or last; `current` when none. */
export function nextSelectIndex(entries:readonly SelectEntry[],current:number,key:SelectStepKey){const ok=(i:number)=>!entries[i]!.group&&!entries[i]!.disabled;
 if(key==='Home'||key==='End'){const order=entries.map((_,i)=>i);for(const i of key==='Home'?order:order.reverse())if(ok(i))return i;return current;}
 const step=key==='ArrowDown'?1:-1;for(let i=current+step;i>=0&&i<entries.length;i+=step)if(ok(i))return i;return current;}
/** Each system's own keys on a closed dropdown, which customizable select (`appearance: base-select`) otherwise replaces with
 * opening the list. Windows and Linux: Up, Down, Home and End choose the previous, next, first or last enabled option at once and
 * fire `change` (so React's onChange runs); Alt+Down, Alt+Up and F4 open the list, as do Space and Enter (the browser's own).
 * macOS: the browser's behavior stays, as a Mac's pop-up button opens its list on the arrows. Put on an element holding the selects. */
export function selectKeyDown(platform:SelectPlatform){
 if(platform==='darwin')return undefined;
 // win32 and linux:
 return (event:KeyboardEvent<HTMLElement>)=>{const select=event.target;if(event.defaultPrevented||!(select instanceof HTMLSelectElement)||select.disabled||select.multiple||event.ctrlKey||event.metaKey||event.shiftKey)return;let open=false;try{open=select.matches(':open');}catch{}if(open)return;
  if(event.key==='F4'||(event.altKey&&(event.key==='ArrowDown'||event.key==='ArrowUp'))){event.preventDefault();try{select.showPicker();}catch{}return;}
  if(event.altKey||!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();
  const options=[...select.options],entries=options.map(o=>({disabled:o.disabled||o.hidden===true||(o.parentElement instanceof HTMLOptGroupElement&&o.parentElement.disabled)}));
  const at=nextSelectIndex(entries,select.selectedIndex,event.key as SelectStepKey);if(at===select.selectedIndex||at<0)return;
  select.selectedIndex=at;select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));};
}
