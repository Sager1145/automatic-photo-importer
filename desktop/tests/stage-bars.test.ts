import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider} from '../renderer/i18n';
import {ImportDashboard,OrganizationProgress,ProgressDisplay,SidebarSources,SourceRow,SourceSteps,jobStageLayers,totalStageLayers} from '../renderer/RootApp';
import type {AppState,Job,Progress} from '../shared';

const preferences:AppState['preferences']={language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:['/Volumes/A006'],copyMode:'single',basePath:'photobackup',template:'{year}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',allowFolderSource:false,unknownRules:{}} as AppState['preferences'];
const card={id:'card',name:'Card',path:'/Volumes/CARD',transport:'storage' as const,selected:true,total:128e9,free:40e9};
const stateWith=(extra:Partial<AppState>):AppState=>({preferences,sources:[card],jobs:[],history:[],platform:'darwin',...extra});
const render=(node:ReturnType<typeof createElement>)=>renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:node}));
const css=readFileSync(new URL('../renderer/styles.css',import.meta.url),'utf8');
const progress=(extra:Partial<Progress>={}):Progress=>({phase:'copying',completed:40,total:100,bytes:40,totalBytes:100,speed:1e6,file:'a.jpg',startedAt:new Date(0).toISOString(),...extra});
const job=(phase:Job['phase'],extra:Partial<Progress>={},more:Partial<Job>={}):Job=>({id:'j'+Math.random(),source:card,phase,errors:[],backup:false,startedAt:new Date(Date.now()-60000).toISOString(),progress:progress(extra),...more});
const layersOf=(markup:string)=>[...markup.matchAll(/<span[^>]*data-layer=""[^>]*>/g)].map(match=>({kind:match[0].match(/data-step="(\w[\w-]*)"/)?.[1],scale:Number(match[0].match(/scaleX\(([\d.]+)\)/)?.[1])}));
const totalOf=(state:AppState)=>{const markup=render(createElement(ImportDashboard,{state,act:()=>{}}));const start=markup.lastIndexOf('<div',markup.indexOf('data-testid="total-progress"'));return markup.slice(start,markup.indexOf('progress-display-line',start));};

test('a bar at stage 2 and 40% shows a full stage-1 layer under a 40% stage-2 layer',()=>{
 const markup=render(createElement(ProgressDisplay,{label:'x',fraction:.4,stages:[{kind:'scan',fraction:1},{kind:'copy',fraction:.4}]}));
 assert.deepEqual(layersOf(markup),[{kind:'scan',scale:1},{kind:'copy',scale:.4}]);
 assert.match(markup,/role="progressbar"/);assert.match(markup,/aria-valuenow="40"/);assert.match(markup,/aria-valuetext="Copying, 40%"/);
 const verifying=render(createElement(ProgressDisplay,{label:'x',fraction:.23,stages:[{kind:'scan',fraction:1},{kind:'copy',fraction:1},{kind:'verify',fraction:.23}]}));
 assert.match(verifying,/aria-valuetext="Verifying, 23%"/);
 assert.deepEqual(layersOf(verifying).map(layer=>layer.kind),['scan','copy','verify']);
 assert.deepEqual(layersOf(render(createElement(ProgressDisplay,{label:'x',fraction:.5,step:'tidy'}))),[{kind:'tidy',scale:.5}],'a single-stage bar is its stage color');
});

test('a job card derives its layers from the stage it is on',()=>{
 assert.deepEqual(jobStageLayers(job('copying')),[{kind:'scan',fraction:1},{kind:'copy',fraction:.4}]);
 const verifying=jobStageLayers(job('verifying',{phase:'verifying',completed:23,total:100,bytes:0,totalBytes:0,work:{files:23,bytes:23,totalFiles:100,totalBytes:100}}));
 assert.deepEqual(verifying.map(layer=>layer.kind),['scan','copy','verify']);assert.deepEqual(verifying.slice(0,2).map(layer=>layer.fraction),[1,1]);
 assert.deepEqual(jobStageLayers(job('queued',{},{progress:undefined})),[]);
});

test('the total bar takes the stage of the least advanced job and is never orange',()=>{
 const copying=job('copying'),verifying=job('verifying',{phase:'verifying',completed:90,total:100});
 const alone=totalStageLayers([copying]);assert.equal(alone.at(-1)!.kind,'copy');
 const mixed=totalStageLayers([copying,verifying]);
 assert.equal(mixed.at(-1)!.kind,'copy','the least advanced stage is on top');
 assert.ok(mixed.at(-1)!.fraction>.4,'jobs already past the stage count as done in it');
 assert.deepEqual(mixed.slice(0,-1).map(layer=>layer.fraction),[1]);
 for(const jobs of [[copying],[verifying],[copying,verifying]]){
  const markup=totalOf(stateWith({jobs}));
  const layers=layersOf(markup);assert.ok(layers.length>=2,'layered');assert.ok(layers.every(layer=>layer.kind&&layer.kind!=='undefined'),'every layer has a stage color');
 }
 assert.equal(layersOf(totalOf(stateWith({jobs:[verifying]}))).at(-1)!.kind,'verify');
 assert.match(css,/\.progress-track>span\[data-step\]\{background:var\(--step\)\}/);
});

test('the completed state keeps every layer full and ends in the final stage color',()=>{
 const done=job('complete',{phase:'verifying',completed:100,total:100},{});
 const layers=totalStageLayers([done]);assert.deepEqual(layers.map(layer=>layer.kind),['scan','copy','verify']);assert.ok(layers.every(layer=>layer.fraction===1));
 const markup=totalOf(stateWith({jobs:[done]}));
 assert.deepEqual(layersOf(markup),[{kind:'scan',scale:1},{kind:'copy',scale:1},{kind:'verify',scale:1}]);
 assert.deepEqual(layersOf(render(createElement(ProgressDisplay,{label:'x',fraction:.5,finished:true,stages:[{kind:'scan',fraction:1},{kind:'copy',fraction:.5}]}))),[{kind:'scan',scale:1},{kind:'copy',scale:1}]);
});

test('paused turns every layer yellow with the stage widths kept, and resuming brings the stage colors back',()=>{
 assert.match(css,/\.progress-display\[data-paused\] \.progress-track>span\{background:var\(--warning\)\}/);
 assert.match(css,/\.source-status\.paused\{color:var\(--warning\)\}/,'the Paused text uses the same token');
 const paused=job('stopped',{},{paused:true}),running=job('copying');
 const bar=(item:Job)=>render(createElement(OrganizationProgress,{job:item}));
 const pausedMarkup=bar(paused),runningMarkup=bar(running);
 assert.match(pausedMarkup,/data-paused=""/);assert.ok(!/data-paused/.test(runningMarkup),'resumed: no paused mark');
 assert.deepEqual(layersOf(pausedMarkup),layersOf(runningMarkup),'the widths and stage colors stay in the markup');
 assert.match(bar(job('copying',{},{stopping:'pause'})),/data-paused=""/,'pausing counts as paused');
 assert.match(totalOf(stateWith({jobs:[paused]})),/data-paused=""/);
 assert.ok(!/data-paused/.test(totalOf(stateWith({jobs:[running]}))));
 assert.ok(!/data-paused/.test(totalOf(stateWith({jobs:[paused,{...running,source:{...card,id:'other'}}]}))),'one job still running: the queue is not paused');
 const steps=render(createElement(SourceSteps,{job:paused,scanning:false,verifyOff:false}));assert.match(steps,/data-paused=""/);
 assert.match(render(createElement(SidebarSources,{state:stateWith({jobs:[paused]}),onOpen:()=>{}})),/class="mini-steps"[^>]*data-paused=""|data-paused=""[^>]*class="mini-steps"/);
 assert.ok(!/data-paused/.test(render(createElement(SidebarSources,{state:stateWith({jobs:[running]}),onOpen:()=>{}}))));
});

test('layers animate by transform inside an isolated clipping track, below every overlay, and not at all with reduced motion',()=>{
 const track=css.match(/\.progress-track\{[^}]*\}/)![0];assert.match(track,/overflow:hidden/);assert.match(track,/isolation:isolate/);
 const layer=css.match(/\.progress-track>span\[data-layer\]\{[^}]*\}/)![0];assert.match(layer,/position:absolute/);assert.doesNotMatch(layer,/z-index/);
 for(const rule of css.match(/[^}\n]*\.progress-track[^{]*\{[^}]*\}/g)!)assert.doesNotMatch(rule,/z-index/,rule);
 assert.match(css,/\.progress-track>span\{transition:transform var\(--slow\) var\(--spring\)\}/);
 const reduced=css.slice(css.indexOf('@media (prefers-reduced-motion:reduce)'));
 assert.match(reduced.slice(0,reduced.indexOf('\n}\n')),/\.progress-track>span\{transition:none\}/);
});

const lightness=(hex:string)=>{const [r,g,b]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);return .2126*r+.7152*g+.0722*b;};
const rgb=(hex:string)=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);
const contrast=(a:string,b:string)=>{const x=lightness(a),y=lightness(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
const hue=(hex:string)=>{const [r,g,b]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255),max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;const h=max===r?((g-b)/d)%6:max===g?(b-r)/d+2:(r-g)/d+4;return (h*60+360)%360;};
const hueGap=(a:string,b:string)=>{const d=Math.abs(hue(a)-hue(b));return Math.min(d,360-d);};
const matrices={deuteranopia:[[.367322,.860646,-.227968],[.280085,.672501,.047413],[-.01182,.04294,.968881]],protanopia:[[.152286,1.052583,-.204868],[.114503,.786281,.099216],[-.003882,-.048116,1.051998]]};
const lab=(v:number[])=>{const [r,g,b]=v.map(x=>Math.min(1,Math.max(0,x))),X=(.4124*r+.3576*g+.1805*b)/.95047,Y=.2126*r+.7152*g+.0722*b,Z=(.0193*r+.1192*g+.9505*b)/1.08883,f=(t:number)=>t>.008856?Math.cbrt(t):7.787*t+16/116;return [116*f(Y)-16,500*(f(X)-f(Y)),200*(f(Y)-f(Z))];};
const simulated=(hex:string,kind:keyof typeof matrices)=>{const v=rgb(hex);return matrices[kind].map(row=>row[0]!*v[0]!+row[1]!*v[1]!+row[2]!*v[2]!);};
const deltaE=(a:number[],b:number[])=>{const x=lab(a),y=lab(b);return Math.hypot(x[0]!-y[0]!,x[1]!-y[1]!,x[2]!-y[2]!);};

test('the stage palette keeps neighbouring stages apart in hue and for color-blind eyes, and stays readable in both themes',()=>{
 const kinds=['scan','read','compare','copy','verify','move','tidy','delete','folder-check'];
 const light=css.slice(css.indexOf(':root{'),css.indexOf(':root[data-theme=dark]{')),dark=css.slice(css.indexOf(':root[data-theme=dark]{'));
 // Neighbours in the order a job moves through its steps: an import, its scan sub-steps, an organization, delete originals.
 const neighbours=[['scan','read'],['read','compare'],['scan','copy'],['read','copy'],['compare','copy'],['copy','verify'],['compare','move'],['move','tidy'],['tidy','delete'],['move','verify']];
 const surfaces={light:[light.match(/--window:(#[0-9a-f]{6})/)![1]!,light.match(/--surface:(#[0-9a-f]{6})/)![1]!],dark:[dark.match(/--window:(#[0-9a-f]{6})/)![1]!,dark.match(/--surface:(#[0-9a-f]{6})/)![1]!,dark.match(/--surface-raised:(#[0-9a-f]{6})/)![1]!,/* filled rows: the translucent fill over --surface, as painted */'#343438']};
 for(const [theme,block] of [['light',light],['dark',dark]] as const){
  const color=Object.fromEntries(kinds.map(kind=>[kind,block.match(new RegExp(`--step-${kind}:(#[0-9a-f]{6})`))?.[1]!]));
  assert.equal(new Set(Object.values(color)).size,kinds.length,`${theme}: distinct`);
  for(const kind of kinds){
   for(const surface of surfaces[theme])assert.ok(contrast(color[kind]!,surface)>=4.5,`${theme} ${kind} contrast ${contrast(color[kind]!,surface).toFixed(2)} on ${surface}`);
   const h=hue(color[kind]!);assert.ok(h>=80&&h<=334,`${theme} ${kind} hue ${h.toFixed(0)} stays clear of red, orange and amber`);
  }
  for(const [a,b] of neighbours){
   assert.ok(hueGap(color[a]!,color[b]!)>=33,`${theme} ${a}/${b} hue gap ${hueGap(color[a]!,color[b]!).toFixed(0)}`);
   for(const kind of ['deuteranopia','protanopia'] as const)assert.ok(deltaE(simulated(color[a]!,kind),simulated(color[b]!,kind))>=7,`${theme} ${a}/${b} ${kind} deltaE ${deltaE(simulated(color[a]!,kind),simulated(color[b]!,kind)).toFixed(1)}`);
  }
 }
});

const steps=['checking','comparing','existing','copying','verifying:link'];
const shares=(...values:number[])=>steps.map((step,index)=>({step,share:values[index]!}));

test('a job bar is as long as the percent: 2% never fills a layer',()=>{
 const planning=job('verifying',{phase:'planning',step:'checking',completed:2,total:100,bytes:0,totalBytes:0},{fraction:.02,cost:{done:2,total:100},stageShares:shares(.02,.02,.02,.02,.02)});
 const layers=jobStageLayers(planning);
 assert.ok(layers.length>=1);
 for(const layer of layers)assert.ok(layer.fraction<=.02+1e-9,`layer ${layer.kind} ${layer.fraction}`);
});

test('a finished first stage stays under the next colour, and the layers are cumulative cost shares',()=>{
 const copying=job('copying',{},{fraction:.278,cost:{done:27.8,total:100},stageShares:shares(.1,.12,.13,.278,.278)});
 const layers=jobStageLayers(copying);
 assert.deepEqual(layers.map(layer=>layer.kind),['scan','copy']);
 assert.ok(Math.abs(layers[0]!.fraction-.13)<1e-9);
 assert.ok(Math.abs(layers[1]!.fraction-.278)<1e-9);
 const total=totalStageLayers([copying]);
 assert.ok(Math.abs(total[0]!.fraction-.13)<1e-9&&Math.abs(total[1]!.fraction-.278)<1e-9);
});

test('the Drive details toggle keeps stage telemetry visible and controls its detail panel',()=>{
 const markup=render(createElement(SourceRow,{source:card,act:()=>{},configured:true}));
 const row=markup.match(/<div class="source-step-row"[^>]*>([\s\S]*?)<\/button><\/div>/)?.[1]??'';
 assert.match(row,/data-testid="source-steps"/);
 const toggle=row.match(/<button[^>]*drive-details-toggle[^>]*>/)?.[0]??'';
 assert.match(toggle,/aria-expanded="false"/);
 const id=toggle.match(/aria-controls="([^"]+)"/)?.[1];
 assert.ok(id);assert.ok(markup.includes(`id="${id}"`));

 assert.doesNotMatch(markup.match(/<summary[\s\S]*?<\/summary>/)?.[0]??'',/Drive details/);

 assert.match(css,/\.source-step-row\{[^}]*flex-wrap:wrap/);
});
