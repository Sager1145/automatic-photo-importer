// Probes that run inside the renderer. Each is a self-contained function: it is serialized with toString(),
// so it must not use anything from this module's scope. Run them with Harness.probe(fn,arg).

/** Buttons that grew far past what their label needs (a bar, not a button). Tabs, segments and switches may stretch,
 * and so may list rows that open something (.inventory-open: "4 included files · 8.4 MB ›" spans its card by design). */
export function wideButtons(): {text:string;cls:string;width:number;need:number}[] {
 const out:{text:string;cls:string;width:number;need:number}[]=[];
 for(const b of document.querySelectorAll<HTMLElement>('button,.button,[role=button]')){
  const r=b.getBoundingClientRect();if(!r.width||!r.height||b.closest('[hidden],dialog:not([open])'))continue;
  if(b.matches('.nav-item,.sidebar-item,.inventory-open,[role=tab],[role=switch],[role=radio],.appearance-segments button,.segmented button')||b.closest('[role=tablist],[role=radiogroup],.segmented'))continue;
  const style=b.style.cssText;b.style.setProperty('width','max-content','important');b.style.setProperty('flex','none','important');b.style.setProperty('min-width','0','important');
  const need=b.getBoundingClientRect().width;b.style.cssText=style;
  if(r.width>need*1.5&&r.width-need>64)out.push({text:(b.textContent||b.getAttribute('aria-label')||'').trim().slice(0,40),cls:String(b.className),width:Math.round(r.width),need:Math.round(need)});
 }
 return out;
}

/** Content a box cuts off without an ellipsis or line clamp, controls that spill out of their box, and controls a clipping ancestor cuts. */
export function clippedControls(): Record<string,unknown>[] {
 const out:Record<string,unknown>[]=[];
 const name=(e:Element)=>(e.getAttribute('aria-label')||e.textContent||'').trim().replace(/\s+/g,' ').slice(0,40)+' <'+e.tagName.toLowerCase()+(typeof e.className==='string'&&e.className?'.'+e.className.trim().split(/\s+/).join('.'):'')+'>';
 const controls='button,.button,input:not([type=checkbox]),select,[role=progressbar],[role=meter],.storage-track,.segmented,.source-layout-switch,.titlebar-actions,.source-steps,.mini-steps,.status-pill,.selection-chip,.parallel-source-control,.dashboard-total,.organization-progress-line,.progress-display-line';
 // File tables scroll sideways by design; tracks clip their fill to the rounded bar.
 const scrollers='.file-table-scroll,.review-table-scroll';
 const tracks='.progress-track,.storage-track,.sidebar-capacity';
 const hidden=(e:Element)=>!!e.closest('[hidden],dialog:not([open]),details:not([open])>:not(summary),.connection-screen')||!(e as HTMLElement).checkVisibility({visibilityProperty:true});
 for(const e of document.querySelectorAll<HTMLElement>('body *')){
  if(e.scrollWidth<=e.clientWidth+1&&e.scrollHeight<=e.clientHeight+1)continue;
  const s=getComputedStyle(e);
  if(s.overflowX==='visible'&&s.overflowY==='visible'||e.matches(scrollers+','+tracks)||e.clientWidth<=1||s.textOverflow==='ellipsis'||s.webkitLineClamp!=='none'&&!!s.webkitLineClamp)continue;
  if(hidden(e))continue;
  const wide=e.scrollWidth>e.clientWidth+1,tall=(s.overflowY==='hidden'||s.overflowY==='clip')&&e.scrollHeight>e.clientHeight+1;
  if(wide||tall)out.push({kind:'content cut off',control:name(e),need:[e.scrollWidth,e.scrollHeight],box:[e.clientWidth,e.clientHeight]});
 }
 for(const e of document.querySelectorAll<HTMLElement>(controls)){
  if(hidden(e))continue;
  const r=e.getBoundingClientRect();if(r.width<1||r.height<1)continue;
  const s=getComputedStyle(e);
  if(s.overflowX==='visible'&&s.textOverflow!=='ellipsis'&&e.scrollWidth>e.clientWidth+1&&e.clientWidth>0){out.push({kind:'content spills out',control:name(e),need:e.scrollWidth,width:e.clientWidth});continue;}
  for(let a=e.parentElement;a&&a!==document.body;a=a.parentElement){
   const c=getComputedStyle(a);if(c.display==='contents')continue;
   const b=a.getBoundingClientRect(),left=b.left+a.clientLeft,top=b.top+a.clientTop,right=left+a.clientWidth,bottom=top+a.clientHeight;
   const clipX=c.overflowX!=='visible'&&!a.matches(scrollers),clipY=c.overflowY==='hidden'||c.overflowY==='clip';
   if(clipX&&(r.left<left-1||r.right>right+1)||clipY&&(r.top<top-1||r.bottom>bottom+1)){out.push({kind:'clipped by ancestor',control:name(e),by:name(a).replace(/^.*</,'<'),control_box:[Math.round(r.left),Math.round(r.top),Math.round(r.right),Math.round(r.bottom)],clip_box:[Math.round(left),Math.round(top),Math.round(right),Math.round(bottom)]});break;}
  }
 }
 return out;
}

/** Every open error surface ([data-error-layer]) hit-tested on a 5x3 grid: misses are points where something else is drawn on top. */
export function errorLayers(): {testid:string;topLayer:boolean;misses:string[];transition:boolean}[] {
 return [...document.querySelectorAll<HTMLElement>('[data-error-layer]')].filter(e=>e.matches(':popover-open')||(e instanceof HTMLDialogElement&&e.open)).map(layer=>{
  const r=layer.getBoundingClientRect(),misses:string[]=[];
  for(const fx of [.1,.3,.5,.7,.9])for(const fy of [.2,.5,.8]){
   const x=r.left+r.width*fx,y=r.top+r.height*fy;if(x<0||y<0||x>=innerWidth||y>=innerHeight)continue;
   const hit=document.elementFromPoint(x,y);if(!hit||!layer.contains(hit))misses.push(`${Math.round(x)},${Math.round(y)}: ${hit?hit.tagName.toLowerCase()+'.'+String(hit.className).split(/\s+/).join('.'):'nothing'}`);
  }
  // A dialog's grid also covers its backdrop-free content only; a toast is small, so every point counts.
  return {testid:layer.dataset.testid??layer.className,topLayer:layer.matches(':popover-open,:modal'),misses,transition:!!document.documentElement.dataset.transition};
 });
}

/** Visible text with an unfilled {placeholder}, undefined, NaN or [object Object]. */
export function brokenText(): string[] {
 const out=new Set<string>();
 const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
 for(let node=walker.nextNode();node;node=walker.nextNode()){
  const text=node.textContent?.trim();if(!text)continue;
  const parent=node.parentElement;if(!parent||parent.closest('script,style,code,[hidden],dialog:not([open])')||!parent.checkVisibility({visibilityProperty:true}))continue;
  if(/\{[A-Za-z]\w*\}|\bundefined\b|\bNaN\b|\[object Object\]/.test(text))out.add(text.slice(0,120));
 }
 for(const e of document.querySelectorAll<HTMLElement>('[aria-label],[title]'))for(const value of [e.getAttribute('aria-label'),e.getAttribute('title')])if(value&&/\{[A-Za-z]\w*\}|\bundefined\b|\bNaN\b/.test(value))out.add('attribute: '+value.slice(0,120));
 return [...out];
}

/** Visible texts and labels with two or more Latin words: in another language these are untranslated unless they are user data.
 * Folder previews are left out: they show folder names as they are on disk. */
export function latinPhrases(): string[] {
 const out=new Set<string>(),phrase=/[A-Za-z]{2,}[^\n]*?\s[A-Za-z]{2,}/;
 const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
 for(let node=walker.nextNode();node;node=walker.nextNode()){
  const text=node.textContent?.replace(/\s+/g,' ').trim();if(!text||!phrase.test(text))continue;
  const parent=node.parentElement;if(!parent||parent.closest('script,style,code,input,textarea,select,[hidden],dialog:not([open]),.error-path,.folder-preview>div')||!parent.checkVisibility({visibilityProperty:true}))continue;
  out.add(text);
 }
 for(const e of document.querySelectorAll<HTMLElement>('button[aria-label],[role=progressbar][aria-label]')){const value=e.getAttribute('aria-label')?.trim();if(value&&phrase.test(value)&&e.checkVisibility())out.add('aria-label: '+value);}
 return [...out];
}

/** Each visible progress display: its step colour, the painted colour of its top (last) layer, every layer with its own
 * step colour, and the warning colour, as rgb strings. */
export function progressDisplays(): {testid:string;step:string;paused:boolean;fill:string;stepColor:string;warning:string;layers:{step:string;fill:string;stepColor:string}[];cardText:string}[] {
 const probe=document.createElement('i');document.body.append(probe);
 const resolve=(value:string)=>{probe.style.color='';probe.style.color=value;return getComputedStyle(probe).color;};
 const warning=resolve('var(--warning)');
 const out=[...document.querySelectorAll<HTMLElement>('[data-progress-display]')].filter(e=>e.checkVisibility()).map(display=>{
  const track=display.querySelector<HTMLElement>('.progress-track'),fills=track?[...track.children] as HTMLElement[]:[];
  const step=display.dataset.step??'';
  const card=display.closest<HTMLElement>('article,li,section');
  return {testid:display.dataset.testid??'',step,paused:!!display.closest('[data-paused],.is-paused,[data-state=paused]')||display.dataset.state==='paused',
   fill:fills.length?getComputedStyle(fills.at(-1)!).backgroundColor:'',stepColor:step?resolve(`var(--step-${step})`):'',warning,
   layers:fills.map(f=>({step:f.dataset.step??'',fill:getComputedStyle(f).backgroundColor,stepColor:f.dataset.step?resolve(`var(--step-${f.dataset.step})`):''})),cardText:(card?.textContent??'').slice(0,160)};
 });
 probe.remove();return out;
}

/** Text that fails the minimum contrast against the background painted behind it. Disabled and faded controls are left out. */
export function lowContrast(minimum: number): {text:string;ratio:number;color:string;background:string}[] {
 // Colours come as rgb()/rgba(), or as color(srgb r g b / a) with 0-1 channels when color-mix() made them.
 const parse=(value:string)=>{const srgb=value.match(/color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)/);if(srgb)return {r:+srgb[1]!*255,g:+srgb[2]!*255,b:+srgb[3]!*255,a:srgb[4]===undefined?1:+srgb[4]};const m=value.match(/[\d.]+/g)?.map(Number)??[0,0,0,0];return {r:m[0]!,g:m[1]!,b:m[2]!,a:m.length>3?m[3]!:1};};
 const lum=({r,g,b}:{r:number;g:number;b:number})=>{const f=(c:number)=>{c/=255;return c<=.03928?c/12.92:((c+.055)/1.055)**2.4;};return .2126*f(r)+.7152*f(g)+.0722*f(b);};
 const blend=(top:{r:number;g:number;b:number;a:number},bottom:{r:number;g:number;b:number})=>({r:top.r*top.a+bottom.r*(1-top.a),g:top.g*top.a+bottom.g*(1-top.a),b:top.b*top.a+bottom.b*(1-top.a)});
 const background=(e:Element)=>{const stack:{r:number;g:number;b:number;a:number}[]=[];for(let a:Element|null=e;a;a=a.parentElement){const s=getComputedStyle(a);if(s.backgroundImage!=='none')return undefined;const c=parse(s.backgroundColor);if(c.a>0)stack.push(c);if(c.a>=1)break;}let base={r:255,g:255,b:255};const root=parse(getComputedStyle(document.body).backgroundColor);if(root.a>0)base=root;for(const c of stack.reverse())base=blend(c,base);return base;};
 const out:{text:string;ratio:number;color:string;background:string}[]=[];
 const seen=new Set<Element>();
 const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
 for(let node=walker.nextNode();node;node=walker.nextNode()){
  const parent=node.parentElement,text=node.textContent?.trim();if(!parent||!text||seen.has(parent))continue;seen.add(parent);
  if(parent.closest('[hidden],dialog:not([open]),:disabled,[aria-disabled=true],svg,script,style,.boot')||!parent.checkVisibility({visibilityProperty:true,opacityProperty:true}))continue;
  let faded=false;for(let a:Element|null=parent;a;a=a.parentElement)if(parseFloat(getComputedStyle(a).opacity)<1){faded=true;break;}if(faded)continue;
  const back=background(parent);if(!back)continue;
  const fore=parse(getComputedStyle(parent).color);const color=blend(fore,back);
  const l1=lum(color),l2=lum(back),ratio=(Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05);
  const style=getComputedStyle(parent),size=parseFloat(style.fontSize);
  const required=minimum>=4.5&&(size>=24||size>=18.66&&Number(style.fontWeight)>=700)?3:minimum;
  if(ratio<required)out.push({text:text.slice(0,60),ratio:Math.round(ratio*100)/100,color:getComputedStyle(parent).color,background:`rgb(${Math.round(back.r)}, ${Math.round(back.g)}, ${Math.round(back.b)})`});
 }
 return out;
}

/** Positions of the stats of the progress display inside the given element, to compare before and after the file row changes. */
export function statsGeometry(selector: string): Record<string,number[]>|null {
 const display=document.querySelector(selector)?.querySelector<HTMLElement>('[data-progress-display]');if(!display)return null;
 const out:Record<string,number[]>={};
 for(const e of display.querySelectorAll<HTMLElement>('.progress-track,.progress-display-line,.progress-display-line>*')){const r=e.getBoundingClientRect();out[(e.dataset.testid??e.className)||e.tagName]=[Math.round(r.left*2)/2,Math.round(r.top*2)/2,Math.round(r.width*2)/2];}
 return out;
}
