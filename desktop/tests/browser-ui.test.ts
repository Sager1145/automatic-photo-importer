import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {browserTranslationRows} from '../renderer/browser/translations';
import {I18nProvider,createTranslator} from '../renderer/i18n';
import {selectedKeys,HierarchyEditor,PresetSidebar,BrowserPage,PreviewPanel,selectionFromRows,bucketRows,displayFacetValue,visibleBucketRows,toggleBlockSelection,selectionValueLabel} from '../renderer/browser/BrowserPage';
import {defaultConfiguration,addBlock,createBlock,blockLabels} from '../renderer/browser/configuration';
import type {BrowserAPI} from '../renderer/browser/BrowserPage';
import type {CatalogRow,CatalogLibrary,Filter} from '../catalog/types';
import type {Language} from '../shared';
const render=(child:ReturnType<typeof createElement>,language:Language='en')=>renderToStaticMarkup(createElement(I18nProvider,{language,children:child}));
const api:BrowserAPI={catalogQuery:async()=>({rows:[],total:0,revision:1}),catalogDirectories:async()=>({rows:[],revision:1}),catalogFacets:async(_q,field)=>({field,rows:[],total:0,knownCount:0,missingCount:0,pendingCount:0,errorCount:0,revision:1}),catalogStatus:async(libraryId)=>({libraryId,online:false,revision:1,dirty:false,state:'idle',progress:{discovered:0,read:0,failed:0},total:0,checked:0,misplaced:0,unclassifiable:0,unchecked:0}),catalogResolve:async()=>{throw new Error('offline');},thumbnail:async()=>({via:'none'}),summary:async()=>({fields:{}}),exif:async()=>({fields:{}})};
const library:CatalogLibrary={libraryId:'l',volumeId:'v',trustedVolumeId:true,name:'Photos',relativeRoot:'photos',role:'photos',online:false,rulesScope:'r',revision:1};
test('editor supplies drag insertion plus labeled keyboard add, move, remove and independent date/format controls',()=>{
 const c=defaultConfiguration();const html=render(createElement(HierarchyEditor,{configuration:c,onChange:()=>{}}));
 for(const k of ['date','name','format','camera','lens','focal','aperture','shutter','iso'])assert.match(html,new RegExp(`data-block-kind="${k}"`));
 assert.match(html,/draggable="true"/);assert.match(html,/Move earlier/);assert.match(html,/Move later/);assert.match(html,/Remove block/);assert.match(html,/Date granularity/);assert.match(html,/Date display/);assert.match(html,/Files always come last/);
 assert.match(render(createElement(HierarchyEditor,{configuration:{...c,blocks:[createBlock('format')]},onChange:()=>{}})),/Media kind/);
});
test('sidebar presets are a bounded disclosure and include single aperture and the complete composite',()=>{
 const html=render(createElement(PresetSidebar,{configuration:defaultConfiguration(),onChange:()=>{},onOpen:()=>{}}));
 assert.match(html,/<details/);assert.match(html,/builtin-aperture/);assert.match(html,/builtin-aperture-date-format-camera/);assert.match(html,/Save current view/);
});
test('offline and empty libraries have clear states with read-only refresh and no organization execution',()=>{
 const html=render(createElement(BrowserPage,{libraries:[library],statuses:{},configuration:defaultConfiguration(),onConfiguration:()=>{},api,onRefresh:()=>{},onStop:()=>{},onOrganization:()=>{},onReveal:()=>{}}));
 assert.match(html,/Library browser/);assert.match(html,/Offline/);assert.match(html,/Refresh index/);assert.match(html,/Real folders/);assert.match(html,/Categories/);assert.doesNotMatch(html,/Apply reviewed organization|Organize now/);
 const empty=render(createElement(BrowserPage,{libraries:[],statuses:{},configuration:defaultConfiguration(),onConfiguration:()=>{},api,onRefresh:()=>{},onStop:()=>{},onOrganization:()=>{},onReveal:()=>{}}));assert.match(empty,/No indexed libraries/);
});
test('numeric bucket selections OR selected ranges within one block, preserve exclusive boundaries, and missing remains selectable',()=>{
 const block={...createBlock('aperture'),numericMode:'buckets' as const,boundaries:[2.8,4]};
 const rows=bucketRows(block,[{value:2,label:'2',count:3},{value:2.8,label:'2.8',count:2},{value:4,label:'4',count:7}]);assert.deepEqual(rows.map(r=>r.count),[3,2,7]);
 const filter=selectionFromRows(block,[rows[0]!,rows[1]!]);assert.deepEqual(filter,{kind:'ranges',field:'fNumber',blockId:block.id,ranges:[{max:2.8,maxInclusive:false},{min:2.8,max:4,maxInclusive:false}]});
 assert.deepEqual(selectionFromRows(block,[{key:'missing',label:'Missing',count:2,missing:true}]),{kind:'missing',field:'fNumber',blockId:block.id});
});
test('date display keeps grouping keys intact and preview paths remain relative with separate organize navigation',()=>{
 const date={...createBlock('date'),datePattern:'MM / YYYY'};assert.equal(displayFacetValue(date,'2025-01','en'),'01 / 2025');assert.equal(displayFacetValue(date,'2026-01','en'),'01 / 2026');
 const row:CatalogRow={fileId:'f',libraryId:'l',relativePath:'Unsorted/a.nef',parentPath:'Unsorted',name:'a.nef',mediaKind:'RAW',extension:'nef',size:'10',metadataStatus:'ready',values:{metadataStatus:'ready',camera:'Nikon'},placement:{status:'misplaced',actualRelativePath:'Unsorted/a.nef',expectedRoute:{role:'photos',relativePath:'2026/a.nef'},rulesScope:'r'},companionCount:0};
 const html=render(createElement(PreviewPanel,{row,online:false,api,onOrganization:()=>{},onReveal:()=>{},onClose:()=>{}}));assert.match(html,/Unsorted\/a.nef/);assert.match(html,/2026\/a.nef/);assert.match(html,/Open organization tool/);assert.doesNotMatch(html,/Organize now|Apply/);
});
test('all browser labels translate in the four supported languages',()=>{
 for(const language of ['zh-Hans','zh-Hant','ja'] as const){const t=createTranslator(language);for(const label of ['Library browser','Add block','Real folders','Categories','Save current view','Date granularity','Open organization tool',...Object.values(blockLabels).filter(label=>label!=='ISO')])assert.notEqual(t(label),label,`${language}: ${label}`);}
});

test('translated browser controls preserve dynamic numbers and user values',()=>{
 for(const row of browserTranslationRows.trim().split('\n').filter(Boolean)){const [english,...translations]=row.split('|');assert.equal(translations.length,3);const placeholders=(text:string)=>[...text.matchAll(/\{(.*?)\}/g)].map(m=>m[1]).sort();for(const translation of translations){assert.ok(translation.trim());assert.deepEqual(placeholders(translation),placeholders(english!));}}
});

test('bucket candidates use photographic edge labels and hide empty unselected ranges',()=>{
 const block={...createBlock('aperture'),boundaries:[2.8,4]};const rows=bucketRows(block,[{value:2.8,label:'2.8',count:3}]);assert.deepEqual(rows.map(r=>r.label),['< f/2.8','≥ f/2.8 – < f/4','≥ f/4']);
 assert.deepEqual(visibleBucketRows(rows,undefined).map(r=>r.label),['≥ f/2.8 – < f/4']);
 const selected=selectionFromRows(block,[rows[2]!]);assert.deepEqual(visibleBucketRows(rows,selected).map(r=>r.label),['≥ f/2.8 – < f/4','≥ f/4']);
 const shutter={...createBlock('shutter'),boundaries:[1/125,2]};assert.deepEqual(bucketRows(shutter,[]).map(r=>r.label),['< 1/125 s','≥ 1/125 s – < 2 s','≥ 2 s']);
 const html=render(createElement(HierarchyEditor,{configuration:{...defaultConfiguration(),blocks:[createBlock('shutter')]},onChange:()=>{}}));assert.match(html,/value="1\/8000 s, 1\/4000 s/);assert.doesNotMatch(html,/0.0166667/);
});

test('block toggles retain raw hidden numeric values and ranges without rebuilding from current rows',()=>{
 const block=createBlock('iso');const current={kind:'values' as const,field:'iso' as const,blockId:block.id,values:[125]};
 assert.deepEqual(toggleBlockSelection(block,current,{key:'value:number:400',value:400,label:'ISO 400'},true),{kind:'values',field:'iso',blockId:block.id,values:[125,400]});
 const bucket={key:'range:{"min":800,"max":1600,"maxInclusive":false}',range:{min:800,max:1600,maxInclusive:false},label:'ISO bucket'};
 assert.deepEqual(toggleBlockSelection(block,current,bucket,true),{kind:'ranges',field:'iso',blockId:block.id,ranges:[{min:125,max:125,maxInclusive:true},{min:800,max:1600,maxInclusive:false}]});
});

test('exact value mixed with a custom range stays selected and toggles off without duplicates',()=>{
 const block=createBlock('iso');const row={key:'value:number:800',value:800,label:'ISO 800'};
 const custom={kind:'range' as const,field:'iso' as const,blockId:block.id,min:100,max:400,maxInclusive:true};
 const mixed=toggleBlockSelection(block,custom,row,true);
 assert.deepEqual(mixed,{kind:'ranges',field:'iso',blockId:block.id,ranges:[{min:100,max:400,maxInclusive:true},{min:800,max:800,maxInclusive:true}]});
 assert.ok(selectedKeys(mixed).includes('value:number:800'));
 const removed=toggleBlockSelection(block,mixed,row,true);
 assert.deepEqual(removed,{kind:'ranges',field:'iso',blockId:block.id,ranges:[{min:100,max:400,maxInclusive:true}]});
 let filter:Filter|undefined=mixed;for(let i=0;i<4;i++)filter=toggleBlockSelection(block,filter,row,true)!;
 assert.deepEqual(filter,mixed);
 assert.equal((filter as {ranges:unknown[]}).ranges.length,2);
});

test('selection chips use photographic units for exact values and ranges',()=>{
 const aperture=createBlock('aperture'),shutter=createBlock('shutter'),camera=createBlock('camera');
 assert.equal(selectionValueLabel(aperture,{kind:'values',field:'fNumber',values:[1.8,2.8]},'en'),'f/1.8, f/2.8');
 assert.equal(selectionValueLabel(shutter,{kind:'values',field:'exposureSeconds',values:[0.01666666667]},'en'),'1/60 s');
 assert.equal(selectionValueLabel(aperture,{kind:'range',field:'fNumber',min:2,max:4,maxInclusive:true},'en'),'≥ f/2 – ≤ f/4');
 assert.equal(selectionValueLabel(camera,{kind:'values',field:'camera',values:['QA Camera Alpha']},'en'),'QA Camera Alpha');
});
