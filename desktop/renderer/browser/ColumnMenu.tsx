import {useEffect,useId,useRef,useState,type KeyboardEvent,type ReactNode} from 'react';
import {Check,ChevronDown,Plus,Trash2,type LucideIcon} from 'lucide-react';
import {Icon} from '../ui';
import {useTranslation} from '../i18n';
import {addBlock,blockKinds,blockLabels,changeBlockKind,removeBlock,unusedBlockKind,updateBlock,type BlockKind,type BrowserConfiguration,type HierarchyBlock} from './configuration';
import {DateLevelToggles} from './HierarchyEditor';
/** A small menu in the top layer (the popover API), so the scrolling columns never clip it. Its button opens and closes it;
 * Escape or a click elsewhere closes it and focus returns to the button. Up and Down move between its items; Left and Right stay
 * in it (the columns' own arrow keys would move focus out of an open menu). The button discloses a group of buttons, not an ARIA menu.
 * It is the page's one popup look, shared with the dropdowns (`::picker(select)` in styles.css): under its button, aligned to the
 * button's start edge (`align="end"`: its end edge), at least as wide, capped at 20rem high or the room there, above it when
 * the room below is short. `content` is what the button shows (an icon alone when absent). */
export function MenuButton({label,icon,content,className='',panelClassName='',align='start',nameFromContent=false,wrap=button=>button,children}:{label:string;icon?:LucideIcon;content?:ReactNode;className?:string;panelClassName?:string;align?:'start'|'end';/** The button is named by what it shows (`label` is its tooltip and the panel's name). */nameFromContent?:boolean;/** Puts the button alone in an element (a heading), the menu staying outside it. */wrap?:(button:ReactNode)=>ReactNode;children:(close:()=>void)=>ReactNode}){
 const id=useId();const button=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);const [open,setOpen]=useState(false);
 // Placed before it shows, so no layout is needed: under the button (above it when the room below is under 12rem and the room
 // above is larger), its height capped by the room there. Scrolling the page or the columns, or resizing the window, closes it,
 // so it never stays away from its button.
 useEffect(()=>{const node=panel.current;if(!node)return;const before=(e:Event)=>{if((e as ToggleEvent).newState!=='open'||!button.current)return;const r=button.current.getBoundingClientRect(),rem=parseFloat(getComputedStyle(document.documentElement).fontSize)||16,page=document.documentElement.clientWidth;const below=window.innerHeight-r.bottom-12,above=r.top-12,up=below<12*rem&&above>below;const room=Math.min(20*rem,Math.max(0,up?above:below));Object.assign(node.style,{minWidth:`${Math.round(r.width)}px`,left:align==='start'?`${Math.round(Math.max(8,Math.min(r.left,page-8-Math.max(r.width,node.offsetWidth||14*rem))))}px`:'auto',right:align==='end'?`${Math.round(Math.max(8,page-r.right))}px`:'auto',top:up?'auto':`${Math.round(r.bottom+4)}px`,bottom:up?`${Math.round(window.innerHeight-r.top+4)}px`:'auto',maxHeight:`${Math.round(room)}px`});};const close=()=>{try{node.hidePopover();}catch{}};const scrolled=(e:Event)=>{if(!(e.target instanceof Node&&node.contains(e.target)))close();};const toggled=(e:Event)=>{const shown=(e as ToggleEvent).newState==='open';setOpen(shown);if(shown){window.addEventListener('scroll',scrolled,true);window.addEventListener('resize',close);(node.querySelector<HTMLElement>('[aria-pressed=true]')??node.querySelector<HTMLElement>('button:not(:disabled)'))?.focus();}else{window.removeEventListener('scroll',scrolled,true);window.removeEventListener('resize',close);}};node.addEventListener('beforetoggle',before);node.addEventListener('toggle',toggled);return()=>{node.removeEventListener('beforetoggle',before);node.removeEventListener('toggle',toggled);window.removeEventListener('scroll',scrolled,true);window.removeEventListener('resize',close);};},[align]);
 const close=()=>{try{panel.current?.hidePopover?.();}catch{}};
 const keys=(e:KeyboardEvent<HTMLDivElement>)=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight')e.stopPropagation();if(e.key!=='ArrowDown'&&e.key!=='ArrowUp')return;const items=[...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled)')];const at=items.indexOf(document.activeElement as HTMLElement);const next=items[(at+(e.key==='ArrowDown'?1:-1)+items.length)%items.length];if(next){e.preventDefault();next.focus();}};
 return <>{wrap(<button ref={button} type="button" className={['browser-menu-button',content===undefined?'':'has-text',className].filter(Boolean).join(' ')} popoverTarget={id} aria-controls={id} aria-expanded={open} aria-label={nameFromContent?undefined:label} title={label}>{content}{icon&&<Icon icon={icon} size={content===undefined?15:13}/>}</button>)}<div ref={panel} id={id} popover="auto" className={['browser-menu',panelClassName].filter(Boolean).join(' ')} role="group" aria-label={label} title="" onKeyDown={keys}>{children(close)}</div></>;
}
/** The nine fields as menu items: the current one checked. */
function FieldItems({current,onChoose}:{current?:BlockKind;onChoose:(kind:BlockKind)=>void}){
 const {t}=useTranslation();
 return <div className="browser-menu-fields">{blockKinds.map(kind=><button type="button" key={kind} className="browser-menu-item" data-field-kind={kind} aria-pressed={current===undefined?undefined:kind===current} onClick={()=>onChoose(kind)}><span className="browser-menu-check" aria-hidden="true">{kind===current&&<Icon icon={Check} size={14}/>}</span>{t(blockLabels[kind])}</button>)}</div>;
}
/** A category column's header menu, opened from the column's name (name and chevron), like the column headers of Lightroom Classic's Metadata filter: what the column shows,
 * a column added after it or this one removed, and a date column's Year, Month and Day levels. */
export function ColumnMenu({configuration,block,onChange}:{configuration:BrowserConfiguration;block:HierarchyBlock;onChange:(c:BrowserConfiguration)=>void}){
 const {t}=useTranslation();const field=t(blockLabels[block.kind]);const at=configuration.blocks.findIndex(b=>b.id===block.id);
 // A changed or removed column mounts anew and its button goes: focus moves to the menu button of the column now at its place (or
 // the one before it, or Add column after the last), once the columns show the change.
 const refocus=()=>{const strip=(document.activeElement as HTMLElement|null)?.closest<HTMLElement>('.browser-horizontal');if(!strip)return;requestAnimationFrame(()=>requestAnimationFrame(()=>{const button=(index:number)=>strip.querySelector<HTMLElement>(`[data-column-index="${index}"] .browser-menu-button`);(button(at)??button(at-1)??strip.querySelector<HTMLElement>('.browser-add-column .browser-menu-button'))?.focus();}));};
 return <MenuButton label={t('Column options: {field}',{field})} className="browser-column-name" content={<span>{field}</span>} icon={ChevronDown} wrap={button=><h3>{button}</h3>}>{close=><>
  <p className="browser-menu-heading">{t('Show in this column')}</p>
  <FieldItems current={block.kind} onChoose={kind=>{refocus();close();onChange(changeBlockKind(configuration,block.id,kind));}}/>
  {block.kind==='date'&&<><p className="browser-menu-heading">{t('Date levels')}</p><DateLevelToggles block={block} onChange={levels=>onChange(updateBlock(configuration,block.id,{dateLevels:levels}))}/></>}
  <hr/>
  <button type="button" className="browser-menu-item" onClick={()=>{close();onChange(addBlock(configuration,unusedBlockKind(configuration),at+1));}}><span className="browser-menu-check" aria-hidden="true"><Icon icon={Plus} size={14}/></span>{t('Add column after')}</button>
  <button type="button" className="browser-menu-item is-danger" onClick={()=>{refocus();close();onChange(removeBlock(configuration,block.id));}}><span className="browser-menu-check" aria-hidden="true"><Icon icon={Trash2} size={14}/></span>{t('Remove column')}</button>
 </>}</MenuButton>;
}
/** After the last column, as tall as a column header: "+ Add column" opens the fields, and the chosen one becomes a new last column. */
export function AddColumn({configuration,onChange}:{configuration:BrowserConfiguration;onChange:(c:BrowserConfiguration)=>void}){
 const {t}=useTranslation();
 return <div className="browser-add-column"><MenuButton label={t('Add a column')} content={<><Icon icon={Plus} size={14}/><span>{t('Add column')}</span></>}>{close=><><p className="browser-menu-heading">{t('Add a column')}</p><FieldItems onChoose={kind=>{close();onChange(addBlock(configuration,kind,configuration.blocks.length));}}/></>}</MenuButton></div>;
}
