import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {browserTranslationRows} from '../renderer/browser/translations';
import {I18nProvider,createTranslator} from '../renderer/i18n';
import {BrowserPage} from '../renderer/browser/BrowserPage';
import {HierarchyEditor} from '../renderer/browser/HierarchyEditor';
import {PreviewPanel} from '../renderer/browser/PreviewPanel';
import {selectedKeys,selectionFromRows,bucketRows,displayFacetValue,visibleBucketRows,toggleBlockSelection,selectionValueLabel} from '../renderer/browser/selection';
import {defaultConfiguration,addBlock,createBlock,blockLabels,changeBlockKind,unusedBlockKind,presetMenu,applyPreset} from '../renderer/browser/configuration';
import {AddColumn,ColumnMenu} from '../renderer/browser/ColumnMenu';
import type {BrowserAPI} from '../renderer/browser/api';
import type {CatalogRow,CatalogLibrary,Filter} from '../catalog/types';
import type {Language} from '../shared';
const render=(child:ReturnType<typeof createElement>,language:Language='en')=>renderToStaticMarkup(createElement(I18nProvider,{language,children:child}));
const api:BrowserAPI={catalogQuery:async()=>({rows:[],total:0,revision:1}),catalogDirectories:async()=>({rows:[],revision:1}),catalogFacets:async(_q,field)=>({field,rows:[],total:0,knownCount:0,missingCount:0,pendingCount:0,errorCount:0,revision:1}),catalogStatus:async(libraryId)=>({libraryId,online:false,revision:1,dirty:false,state:'idle',progress:{discovered:0,read:0,failed:0},total:0,checked:0,misplaced:0,unclassifiable:0,unchecked:0}),catalogResolve:async()=>{throw new Error('offline');},thumbnail:async()=>({via:'none'}),summary:async()=>({fields:{}}),exif:async()=>({fields:{}})};
const library:CatalogLibrary={libraryId:'l',volumeId:'v',trustedVolumeId:true,name:'Photos',relativeRoot:'photos',role:'photos',online:false,rulesScope:'r',revision:1};
test('editor supplies drag insertion plus labeled keyboard add, move, remove and independent date/format controls',()=>{
 const c=defaultConfiguration();const html=render(createElement(HierarchyEditor,{configuration:c,onChange:()=>{}}));
 for(const k of ['date','name','format','camera','lens','focal','aperture','shutter','iso'])assert.match(html,new RegExp(`data-block-kind="${k}"`));
 assert.match(html,/draggable="true"/);assert.match(html,/Move earlier/);assert.match(html,/Move later/);assert.match(html,/Remove block/);assert.match(html,/Date levels/);assert.match(html,/Shown as a tree/);for(const level of ['Year','Month','Day'])assert.match(html,new RegExp(`>${level}</label>`));assert.match(html,/Files always come last/);
 // Year, Month and Day under the Date level, all on for a new view; the toggles are buttons with a pressed state.
 assert.match(html,/data-testid="date-level-toggles"><button type="button" aria-pressed="true">Year<\/button><button type="button" aria-pressed="true">Month<\/button><button type="button" aria-pressed="true">Day<\/button>/);
 assert.match(render(createElement(HierarchyEditor,{configuration:{...c,blocks:[createBlock('format')]},onChange:()=>{}})),/Media kind/);
});
test('one view panel holds the levels, fields, presets and a single-row save form',()=>{
 const c=defaultConfiguration();const html=render(createElement(HierarchyEditor,{configuration:{...c,presets:[{id:'preset-mine',name:'Mine',blocks:c.blocks}]},onChange:()=>{}}));
 assert.equal(html.match(/<details/g)?.length,1,'presets and the hierarchy share one disclosure');
 for(const part of ['data-testid="hierarchy-clear"','data-testid="browser-presets"','builtin-aperture-date-format-camera','data-preset-id="preset-mine"','Rename: Mine','Save current view','Restore default view','Drag a field by its grip onto the levels','browser-grip','class="browser-field-add" aria-label="Add block: Date"','data-testid="hierarchy-editor-toggle"','Edit levels'])assert.ok(html.includes(part),part);
 assert.ok(!html.includes('data-preset-id="builtin-aperture"'),'single fields are the field row, not presets');
 assert.match(html,/<form class="browser-preset-save">[^]*Preset name[^]*<input[^]*Save current view[^]*Restore default view[^]*<\/form>/,'name, save and restore on one form row');
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
test('the preview labels exposure like the columns do: shutter fractions, f-numbers and millimetres',()=>{
 const row:CatalogRow={fileId:'f',libraryId:'l',relativePath:'a.jpg',parentPath:'',name:'a.jpg',mediaKind:'JPEG',extension:'jpg',size:'10',metadataStatus:'ready',values:{metadataStatus:'ready',exposureSeconds:0.008,fNumber:2.8,focalLengthMm:35},placement:{status:'inPlace',actualRelativePath:'a.jpg',rulesScope:'r'},companionCount:0};
 const html=render(createElement(PreviewPanel,{row,online:false,api,onOrganization:()=>{},onReveal:()=>{},onClose:()=>{}}));
 assert.match(html,/1\/125 s/);assert.doesNotMatch(html,/0\.008 s/);assert.match(html,/f\/2\.8/);assert.match(html,/35 mm/);
});
test('date display keeps grouping keys intact and preview paths remain relative with separate organize navigation',()=>{
 const date={...createBlock('date'),datePattern:'MM / YYYY'};assert.equal(displayFacetValue(date,'2025-01','en'),'01 / 2025');assert.equal(displayFacetValue(date,'2026-01','en'),'01 / 2026');
 const row:CatalogRow={fileId:'f',libraryId:'l',relativePath:'Unsorted/a.nef',parentPath:'Unsorted',name:'a.nef',mediaKind:'RAW',extension:'nef',size:'10',metadataStatus:'ready',values:{metadataStatus:'ready',camera:'Nikon'},placement:{status:'misplaced',actualRelativePath:'Unsorted/a.nef',expectedRoute:{role:'photos',relativePath:'2026/a.nef'},rulesScope:'r'},companionCount:0};
 const html=render(createElement(PreviewPanel,{row,online:false,api,onOrganization:()=>{},onReveal:()=>{},onClose:()=>{}}));assert.match(html,/Unsorted\/a.nef/);assert.match(html,/2026\/a.nef/);assert.match(html,/Open organization tool/);assert.doesNotMatch(html,/Organize now|Apply/);
});
test('all browser labels translate in the four supported languages',()=>{
 for(const language of ['zh-Hans','zh-Hant','ja'] as const){const t=createTranslator(language);for(const label of ['Library browser','Add block','Real folders','Categories','Save current view','Date levels','Edit levels','Merge spellings of one format','Show every RAW format as RAW','Open organization tool',...Object.values(blockLabels).filter(label=>label!=='ISO')])assert.notEqual(t(label),label,`${language}: ${label}`);}
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
const page=(configuration=defaultConfiguration())=>render(createElement(BrowserPage,{libraries:[library],statuses:{},configuration,onConfiguration:()=>{},api,onRefresh:()=>{},onStop:()=>{},onOrganization:()=>{},onReveal:()=>{}}));
test('the page reads as one tool: source, filter bar, columns, height handle, results; the selection path shows only when something is chosen',()=>{
 const html=page();
 const at=(part:string)=>{const index=html.indexOf(part);assert.ok(index>=0,`${part} on the page`);return index;};
 // In order: the source row (library, then the index status with Refresh index), the filter bar, the column editor (closed), the columns, the handle, the results.
 const order=['<div class="browser-toolbar">','<div class="browser-source-row">','aria-label="Library"','aria-label="Back"','<div class="browser-status">','Refresh index','<div class="browser-filter-bar"','aria-label="Browser mode"','Search names','Needs organization','<div class="browser-filter-end">','browser-preset-menu','>Columns</button>','>Clear all</button>','data-testid="hierarchy-editor"','<div class="browser-workspace">','class="browser-horizontal browser-columns"','data-testid="facet-column"','class="browser-add-column"','browser-height-resize','data-testid="browser-files"','Newest capture first','RAW + JPEG'].map(at);
 assert.deepEqual(order,[...order].sort((a,b)=>a-b),'regions in order');
 const toolbar=html.slice(at('<div class="browser-toolbar">'),at('data-testid="hierarchy-editor"'));
 assert.match(toolbar,/<div class="browser-status"><div class="browser-status-text" role="status">[^]*Offline/,'the index status sits in the source row');
 assert.match(html,/<button[^>]*browser-clear-all[^>]*disabled=""[^>]*>Clear all<\/button>/,'Clear all is off while nothing is chosen');
 assert.ok(!html.includes('browser-selection-bar'),'no empty selection row');
 assert.match(html,/<details id="[^"]+" class="browser-editor[^"]*" data-testid="hierarchy-editor">/,'the column editor starts closed');
 assert.match(html,/aria-expanded="false" aria-controls="([^"]+)"[^>]*>[^]*?Columns<\/button>/,'the Columns button controls the editor');
 // The results: Files, the count, sort and the drag-out handle in the header; no Files column in the strip and no preview until a file is picked.
 const results=html.slice(at('data-testid="browser-files"'));
 assert.match(results,/<header>[^]*<h3>Files<\/h3><small>0<\/small>[^]*Newest capture first[^]*data-testid="lightroom-drag"[^]*<\/header>/);
 assert.ok(!html.includes('browser-file-column')&&!html.includes('data-testid="browser-preview"'));
 assert.ok(html.slice(at('class="browser-horizontal browser-columns"'),at('browser-height-resize')).includes('aria-label="Column options: Date"'),'each category column has its header menu');
});
test('the view preset menu lists the built-in views and the saved ones, and shows Custom view when none is active',()=>{
 const c=defaultConfiguration();
 assert.match(page(c),/<select><option value="" disabled="">Custom view<\/option><optgroup label="Built-in views"><option value="builtin-date-camera-format" selected="">Date → Camera → Format<\/option>/);
 const mine={...c,presets:[{id:'preset-mine',name:'Mine',blocks:c.blocks}],activePresetId:undefined};const html=page(mine);
 assert.match(html,/<option value="" disabled="" selected="">Custom view<\/option>/);assert.match(html,/<optgroup label="Saved views"><option value="preset-mine">Mine<\/option><\/optgroup>/);
 assert.ok(!html.includes('value="builtin-iso"'),'single fields are not listed');
 // A single-field view is listed while it is the active one, so the menu still names it.
 const single=applyPreset(c,'builtin-iso');assert.deepEqual(presetMenu(single).builtIn.map(p=>p.id),['builtin-iso','builtin-date-camera-format','builtin-camera-lens-focal','builtin-aperture-date-format-camera']);
 assert.match(page(single),/<option value="builtin-iso" selected="">ISO<\/option>/);
 assert.match(createTranslator('ja')('Custom view'),/カスタム/);
});
test('a column header menu changes the field in place, adds a column after it or removes it',()=>{
 const c=defaultConfiguration();const [date,camera,format]=c.blocks;
 const changed=changeBlockKind(c,camera!.id,'lens');
 assert.deepEqual(changed.blocks.map(b=>b.kind),['date','lens','format']);assert.equal(changed.blocks[0],date);assert.equal(changed.blocks[2],format);
 assert.notEqual(changed.blocks[1]!.id,camera!.id,'a new block, so the old choice in that column does not carry over');assert.equal(changed.activePresetId,undefined,'an edited view is custom');
 const toDate=changeBlockKind(c,format!.id,'date');assert.deepEqual(toDate.blocks[2]!.dateLevels,['year','month','day'],'a new date column is the full tree');
 assert.equal(changeBlockKind(c,camera!.id,'camera'),c,'the same field changes nothing');assert.equal(changeBlockKind(c,'missing','iso'),c);
 assert.equal(unusedBlockKind(c),'name');assert.equal(unusedBlockKind({...c,blocks:[]}),'date');
 let all=c;for(let i=0;i<9;i++)all=addBlock(all,unusedBlockKind(all),all.blocks.length);assert.equal(unusedBlockKind(all),'date','every field shown: Date again');
 const menu=render(createElement(ColumnMenu,{configuration:c,block:date!,onChange:()=>{}}));
 assert.match(menu,/popover="auto"/);assert.match(menu,/aria-label="Column options: Date"/);assert.doesNotMatch(menu,/aria-haspopup/,'a button that discloses a group, not an ARIA menu');assert.match(menu,/aria-controls="([^"]+)"[^]*id="\1" popover="auto" class="browser-menu" role="group"/);assert.match(menu,/Show in this column/);
 for(const kind of ['date','name','format','camera','lens','focal','aperture','shutter','iso'])assert.match(menu,new RegExp(`data-field-kind="${kind}" aria-pressed="${kind==='date'}"`));
 assert.ok(!menu.includes('data-block-kind'),'the editor\'s field chips stay the only [data-block-kind]');
 assert.match(menu,/data-testid="date-level-toggles"><button type="button" aria-pressed="true">Year<\/button>/);assert.match(menu,/Add column after/);assert.match(menu,/Remove column/);
 assert.doesNotMatch(render(createElement(ColumnMenu,{configuration:c,block:camera!,onChange:()=>{}})),/date-level-toggles/,'Year, Month and Day only on a date column');
 const add=render(createElement(AddColumn,{configuration:c,onChange:()=>{}}));assert.match(add,/class="browser-add-column"/);assert.match(add,/aria-label="Add a column"/);assert.equal(add.match(/data-field-kind=/g)?.length,9);assert.doesNotMatch(add,/aria-pressed/,'no field is current in a new column');
 for(const language of ['zh-Hans','zh-Hant','ja'] as const){const t=createTranslator(language);for(const label of ['Filter','Columns','View preset','Show in this column','Add column after','Remove column','Add a column'])assert.notEqual(t(label),label,`${language}: ${label}`);}
});
test('the results header toggles the bars and the columns (pressed = shown); hidden, they are not rendered and the results keep their parts',()=>{
 const shown=page();
 assert.match(shown,/<button type="button" class="browser-toggle" aria-pressed="true"[^>]*>[^]*?RAW \+ JPEG<\/button><button type="button" class="browser-layout-toggle" aria-pressed="true" aria-label="Show the library and filter bars" title="[^"]+">[^]*?<\/button><button type="button" class="browser-layout-toggle" aria-pressed="true" aria-label="Show the category columns" title="[^"]+">[^]*?<\/button>[^]*data-testid="lightroom-drag"/,'after RAW + JPEG, before Drag to Lightroom');
 assert.equal(shown.match(/class="browser-toggle"/g)?.length,1,'browser-toggle stays the RAW + JPEG toggle only');
 assert.ok(!shown.includes('browser-filter-note'),'no filter note while nothing is hidden');
 const bars=page({...defaultConfiguration(),hideBars:true});
 for(const gone of ['browser-toolbar','browser-source-row','browser-filter-bar','browser-status','browser-selection-bar','hierarchy-editor'])assert.ok(!bars.includes(gone),`${gone} hidden with the bars`);
 for(const kept of ['class="browser-horizontal browser-columns"','browser-height-resize','data-testid="browser-files"','RAW + JPEG','data-testid="lightroom-drag"'])assert.ok(bars.includes(kept),`${kept} kept`);
 assert.match(bars,/aria-pressed="false" aria-label="Show the library and filter bars"/);
 const columns=page({...defaultConfiguration(),hideColumns:true});
 for(const gone of ['class="browser-horizontal browser-columns"','browser-height-resize','data-testid="facet-column"','browser-add-column'])assert.ok(!columns.includes(gone),`${gone} hidden with the columns`);
 for(const kept of ['<div class="browser-toolbar">','<div class="browser-filter-bar"','<div class="browser-workspace">','data-testid="browser-files"'])assert.ok(columns.includes(kept),`${kept} kept`);
 assert.match(columns,/aria-pressed="false" aria-label="Show the category columns"/);
 assert.match(columns,/<header>[^]*<h3>Files<\/h3><small>0<\/small>/,'the count stays the first small in the header');
 const both=page({...defaultConfiguration(),hideBars:true,hideColumns:true});
 assert.ok(!both.includes('browser-toolbar')&&!both.includes('class="browser-horizontal browser-columns"')&&!both.includes('browser-height-resize'));
 assert.match(both,/<section class="browser-results [^"]*" data-testid="browser-files"[^]*aria-label="Show the library and filter bars"[^]*aria-label="Show the category columns"/,'both toggles stay reachable');
});
test('the preview header has a Larger preview toggle beside Close preview; the details sit under the picture',()=>{
 const row:CatalogRow={fileId:'f',libraryId:'l',relativePath:'a.jpg',parentPath:'',name:'a.jpg',mediaKind:'JPEG',extension:'jpg',size:'10',metadataStatus:'ready',values:{metadataStatus:'ready'},placement:{status:'inPlace',actualRelativePath:'a.jpg',rulesScope:'r'},companionCount:0} as CatalogRow;
 const props={row,online:false,api,onOrganization:()=>{},onReveal:()=>{},onClose:()=>{}};
 const normal=render(createElement(PreviewPanel,{...props,onLarge:()=>{}})),large=render(createElement(PreviewPanel,{...props,large:true,onLarge:()=>{}}));
 assert.match(normal,/<aside class="browser-preview" data-testid="browser-preview"[^>]*><header><h3>a.jpg<\/h3><div class="browser-preview-tools"><button type="button" class="[^"]*browser-preview-size" aria-label="Larger preview" aria-pressed="false"[^>]*>[^]*?<\/button><button[^>]*aria-label="Close preview"/);
 assert.match(large,/<aside class="browser-preview is-large"[^]*aria-label="Larger preview" aria-pressed="true"/);
 assert.match(normal,/<div class="browser-photo"[^]*<\/div><div class="browser-preview-info">[^]*<dl class="browser-file-details"><div>/,'the details scroll under the picture');
 assert.ok(!render(createElement(PreviewPanel,props)).includes('Larger preview'),'no toggle without a handler');
 assert.ok(!normal.includes('class="browser-toggle"'));
});
