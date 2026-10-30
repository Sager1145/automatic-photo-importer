import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {Inventory} from '../../../shared';
import type {Check} from '../harness';
import {syntheticJob} from '../synthetic';
import {withFigures} from '../../../core/inventory';

/** Check painted text fragments, not only their flex boxes (ellipsis can conceal overflowing text). */
function capacityGeometry(){
 const failures:string[]=[],surfaces:{labels:number;width:number;rows:number}[]=[];
 for(const capacity of document.querySelectorAll<HTMLElement>('.storage-capacity')){
  if(!capacity.checkVisibility())continue;
  const box=capacity.getBoundingClientRect(),track=capacity.querySelector('.storage-track')!.getBoundingClientRect();
  if(Math.abs(track.left-box.left)>1||Math.abs(track.right-box.right)>1)failures.push('capacity track is not full width');
  const labels=[...capacity.querySelectorAll<HTMLElement>('.storage-heading>span,.storage-legend>span,.storage-logical-note')];
  const fragments:{label:number;rect:DOMRect}[]=[];
  for(const [index,label] of labels.entries()){
   if(!label.checkVisibility()||!label.textContent?.trim()){failures.push('missing or hidden capacity label');continue;}
   const walker=document.createTreeWalker(label,NodeFilter.SHOW_TEXT);
   while(walker.nextNode()){
    if(!walker.currentNode.textContent?.trim())continue;
    const range=document.createRange();range.selectNodeContents(walker.currentNode);
    for(const rect of range.getClientRects()){
     fragments.push({label:index,rect});
     if(rect.left<box.left-1||rect.right>box.right+1||rect.top<box.top-1||rect.bottom>box.bottom+1)failures.push('capacity text extends outside its surface: '+label.textContent);
     for(let parent:HTMLElement|null=label;parent&&parent!==capacity.parentElement;parent=parent.parentElement){
      const css=getComputedStyle(parent),r=parent.getBoundingClientRect();
      if(/hidden|clip/.test(css.overflowX)&&(rect.left<r.left-1||rect.right>r.right+1))failures.push('capacity text clipped horizontally: '+label.textContent);
      if(/hidden|clip/.test(css.overflowY)&&(rect.top<r.top-1||rect.bottom>r.bottom+1))failures.push('capacity text clipped vertically: '+label.textContent);
     }
    }
   }
  }
  for(let i=0;i<fragments.length;i++)for(let j=i+1;j<fragments.length;j++){
   const a=fragments[i]!,b=fragments[j]!;
   if(a.label!==b.label&&Math.min(a.rect.right,b.rect.right)-Math.max(a.rect.left,b.rect.left)>1&&Math.min(a.rect.bottom,b.rect.bottom)-Math.max(a.rect.top,b.rect.top)>1)failures.push('overlapping capacity labels');
  }
  const local=fragments.map(item=>item.rect.top);
  surfaces.push({labels:labels.length,width:box.width,rows:new Set(local.map(top=>Math.round(top/4)*4)).size});
 }
 const legend=document.querySelector('article[data-source-id="fixture:1"] .storage-legend');
 return {failures,surfaces,legend:legend?[...legend.querySelectorAll('span')].map(label=>label.textContent?.trim()):[]};
}

export const capacityLayoutChecks=():Check[]=>[{
 id:'import-capacity-responsive',stage:'imports',title:'Complete capacity numbers and multi-format legends wrap without clipping or overlap at narrow widths and 100–200% text',
 covers:['full-width capacity track','complete multi-format legend','capacity text clipping and overlap','list/grid/Activity/Settings capacity','four locales'],budgetMs:180000,
 skip:async h=>h.hooks?undefined:'needs QA injection hook',run:async h=>{
  await h.media([{name:'prefers-reduced-motion',value:'reduce'}]);
  const formats=['NEF','ARW','CR3','JPG','JPEG','PNG','HEIC','HEIF','MP4','MOV','MTS','TIFF'];
  const inventory:Inventory=withFigures({files:formats.map((format,i)=>({path:`/qa/frame-${i}.${format}`,relative:`frame-${i}.${format}`,size:1024**3,kind:'Images',included:true})),media:formats.length,companions:0,unknown:0,bytes:formats.length*1024**3,unknownExtensions:{},elapsedMs:100});
  const state=await h.state(),sources=state.sources.map(source=>({...source,total:987.6*1024**3,free:123.4*1024**3}));
  h.hooks!.set('sources',sources);h.hooks!.set('sourceInventories',{...state.sourceInventories,'fixture:1':inventory});
  const job=syntheticJob('capacity-responsive',{phase:'complete',source:sources.find(source=>source.id==='fixture:1')!});job.backup=true;job.inventory=inventory;h.hooks!.addJobs([job]);
  const measurements:unknown[]=[],failures:unknown[]=[];
  for(const [width,height] of [[1000,720],[1120,800],[1440,940]] as const){await h.size(width,height);
   for(const language of ['en','zh-Hans','zh-Hant','ja'] as const)for(const textScale of [1,1.5,2]){
    await h.prefs({language,textScale});
    for(const view of ['import-list','import-grid','activity','settings'] as const){
     if(view.startsWith('import')){await h.prefs({sourceLayout:view==='import-list'?'list':'grid'});await h.nav('Files & folders');}
     else if(view==='activity')await h.nav('Jobs');
     else{await h.nav('Settings');await h.settingsTab('storage');}
     const result=await h.probe(capacityGeometry),context={width,height,language,textScale,view};
     measurements.push({...context,...result});
     if(!result.surfaces.length||result.failures.length||view!=='settings'&&formats.some(format=>!result.legend.includes(format)))failures.push({...context,...result});
     if(width===1000&&textScale===2&&(language==='en'||language==='zh-Hans')){
      await h.js("(document.querySelector('article[data-source-id=\"fixture:1\"] .storage-capacity')||document.querySelector('.storage-capacity'))?.scrollIntoView({block:'center'})");
      await h.shot(`capacity-${view}-${language}-1000-200`);
     }
    }
   }
  }
  await fs.writeFile(path.join(h.report,'capacity-responsive.json'),JSON.stringify({measurements,failures},null,2));
  assert.deepEqual(failures,[],`capacity layout failures: ${JSON.stringify(failures.slice(0,5))}`);
 }
}];
