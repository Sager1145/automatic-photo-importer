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
import {defaultConfiguration,addBlock,createBlock,blockLabels,changeBlockKind,unusedBlockKind,presetMenu,applyPreset,readConfiguration,configurationKey,restoreDefaultView,savePreset} from '../renderer/browser/configuration';
import {paneHeights,minWorkspaceHeight,heightHandle,minContentHeight,minResultsHeight,editorHeight,editorShare,minEditorHeight,minEditingWorkspaceHeight,editingResultsHeight} from '../renderer/browser/HorizontalStrip';
import {nextSelectIndex,rendererPlatform,selectKeyDown} from '../renderer/browser/select-keys';
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
const page=(configuration=defaultConfiguration(),lib:CatalogLibrary=library)=>render(createElement(BrowserPage,{libraries:[lib],statuses:{},configuration,onConfiguration:()=>{},api,onRefresh:()=>{},onStop:()=>{},onOrganization:()=>{},onReveal:()=>{}}));
test('the page reads as one tool, a row per purpose: where you are, what you see, what is chosen, then the columns, the height handle and the results',()=>{
 const html=page();
 const at=(part:string)=>{const index=html.indexOf(part);assert.ok(index>=0,`${part} on the page`);return index;};
 // In order: the source row (Back and Forward, the library, the mode, the index status with Refresh index), the filter bar (the
 // Filter group, then the View group with the preset menu, Columns and RAW + JPEG), the path row (the hint, then Clear all), the
 // column editor (closed), the columns with Add column after them, the handle, the results (Sort at the start, the layout toggles
 // and Drag to Lightroom at the end).
 const order=['<div class="browser-toolbar">','<div class="browser-source-row">','aria-label="Back"','aria-label="Forward"','aria-label="Library"','aria-label="Browser mode"','<div class="browser-status"','Refresh index','<div class="browser-filter-bar"','<div class="browser-filter-group">','Search names','Needs organization','<div class="browser-view-group"','browser-preset-menu','>Columns</span></button>','class="browser-toggle"','<div class="browser-path-row">','browser-selection-hint','>Clear all</button>','data-testid="hierarchy-editor"','<div class="browser-workspace">','class="browser-horizontal browser-columns"','data-testid="facet-column"','class="browser-add-column"','browser-height-resize','data-testid="browser-files"','Newest capture first','class="browser-layout-toggles"','data-testid="lightroom-drag"'].map(at);
 assert.deepEqual(order,[...order].sort((a,b)=>a-b),'regions in order');
 const toolbar=html.slice(at('<div class="browser-toolbar">'),at('<div class="browser-path-row">'));
 // The index status is one line that opens its details; it is named by what it shows, and the details stay in the page for the popover.
 assert.match(toolbar,/<div class="browser-status" data-state="offline"><button type="button" class="browser-menu-button has-text browser-status-summary"[^>]*aria-expanded="false" title="Index details"><span class="browser-status-dot" aria-hidden="true"><\/span><span class="browser-status-text" role="status"><span class="browser-status-long">Offline · 0 indexed files<\/span><span class="browser-status-short" aria-hidden="true">0<\/span><\/span>/,'the index status sits in the source row as one line, with the count alone for a narrow toolbar');
 // Narrow, Refresh index, Stop indexing, Columns and RAW + JPEG show only their icons: each keeps its name as its text (visually hidden) and a tooltip.
 assert.match(toolbar,/<button type="button" class="button button-secondary  "[^>]*title="Refresh index"[^>]*><svg[^]*?<\/svg><span class="browser-compact-text">Refresh index<\/span><\/button>/,'Refresh index keeps its name when only its icon shows');
 assert.match(toolbar,/class="button button-secondary  browser-columns-button"[^>]*title="Add, remove and arrange the columns, and save the view as a preset"[^>]*><svg[^]*?<\/svg><span class="browser-compact-text">Columns<\/span><\/button>/,'Columns keeps its name and tooltip');
 // The toolbar's dropdowns show the chosen option through their own button, so a narrowed one ends in an ellipsis.
 assert.equal(toolbar.match(/<select[^>]*><button><selectedcontent><\/selectedcontent><\/button>/g)?.length,3,'library, placement and preset dropdowns');
 assert.doesNotMatch(toolbar,/browser-status-summary"[^>]*aria-label=/,'the status line is named by its text');
 assert.match(toolbar,/popover="auto" class="browser-menu browser-status-details" role="group" aria-label="Index details"[^>]*><p>Offline — indexed details are available\. Connect the drive for previews\.<\/p>/,'the details open from the status line');
 assert.match(toolbar,/<div class="browser-view-group" role="group" aria-label="View"><span class="browser-filter-label" aria-hidden="true">View<\/span>/,'the View group has its caption, as Filter does');
 assert.match(html,/<div class="browser-path-row"><p class="browser-selection-hint">[^<]+<\/p><button[^>]*browser-clear-all[^>]*disabled=""[^>]*>Clear all<\/button><\/div>/,'Clear all ends the path row and is off while nothing is chosen');
 assert.ok(!html.includes('browser-selection-bar'),'no empty selection row');
 assert.match(html,/<details id="[^"]+" class="browser-editor[^"]*" data-testid="hierarchy-editor">/,'the column editor starts closed');
 assert.match(html,/aria-expanded="false" aria-controls="([^"]+)"[^>]*>[^]*?Columns<\/span><\/button>/,'the Columns button controls the editor');
 // A column header is one line: the check-all box, the heading (the name, as its menu's button; the menu stays out of the heading), the count; the coverage keeps one line with all of it in its tooltip.
 const column=html.slice(at('data-testid="facet-column"'),at('class="browser-add-column"'));
 assert.match(column,/<header><label class="browser-column-check"[^>]*><input type="checkbox" data-testid="column-check-all"[^>]*\/><\/label><h3><button type="button" class="browser-menu-button has-text browser-column-name"[^>]*aria-label="Column options: Date"[^>]*><span>Date<\/span><svg[^]*?<\/button><\/h3><div[^>]*popover="auto"[^>]*>[^]*?<\/div><small>—<\/small><\/header><p class="browser-coverage" title="0 known · 0 missing">0 known · 0 missing<\/p>/);
 assert.match(html,/<div class="browser-add-column"><button type="button" class="browser-menu-button has-text"[^>]*aria-label="Add a column"[^>]*><svg[^]*?<span>Add column<\/span><\/button>/,'Add column after the last column');
 // The results: Files, the count and Sort at the start; the layout toggles and the drag-out handle at the end. No Files column in the strip and no preview until a file is picked.
 const results=html.slice(at('data-testid="browser-files"'));
 assert.match(results,/<header><div class="browser-results-title">[^]*<h3>Files<\/h3><small>0<\/small>[^]*Newest capture first[^]*<\/div><div class="browser-results-tools">[^]*data-testid="lightroom-drag"[^]*<\/header>/);
 assert.ok(!html.includes('browser-file-column')&&!html.includes('data-testid="browser-preview"'));
 assert.ok(html.slice(at('class="browser-horizontal browser-columns"'),at('browser-height-resize')).includes('aria-label="Column options: Date"'),'each category column has its header menu');
 // A browsed folder has no placement filter; the rest of the bar stays.
 const browsed=page(defaultConfiguration(),{...library,browseOnly:true});assert.ok(!browsed.includes('browser-placement-filter')&&browsed.includes('<div class="browser-view-group"'),'no placement filter for a browsed folder');
});
test('the view preset menu lists the built-in views and the saved ones, and shows Custom view when none is active',()=>{
 const c=defaultConfiguration();
 assert.match(page(c),/<select><button><selectedcontent><\/selectedcontent><\/button><option value="" disabled="">Custom view<\/option><optgroup label="Built-in views"><option value="builtin-date-camera-format" selected="">Date → Camera → Format<\/option>/);
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
 for(const language of ['zh-Hans','zh-Hant','ja'] as const){const t=createTranslator(language);for(const label of ['Filter','View','Columns','View preset','Show in this column','Add column after','Remove column','Add a column','Add column','Index details','Page layout','indexed {time}'])assert.notEqual(t(label),label,`${language}: ${label}`);}
});
test('the results header toggles the bars and the columns (a neutral pair, pressed = shown); hidden, they are not rendered and the results keep their parts',()=>{
 const shown=page();
 assert.match(shown,/<div class="browser-view-group"[^]*<button type="button" class="browser-toggle" aria-pressed="true"[^>]*>[^]*?<span class="browser-compact-text">RAW \+ JPEG<\/span><\/button><\/div>/,'RAW + JPEG ends the View group, its name kept in it when only its icon shows');
 assert.match(shown,/<div class="browser-results-tools"><div class="browser-layout-toggles" role="group" aria-label="Page layout"><button type="button" class="browser-layout-toggle" aria-pressed="true" aria-label="Show the library and filter bars" title="[^"]+">[^]*?<\/button><button type="button" class="browser-layout-toggle" aria-pressed="true" aria-label="Show the category columns" title="[^"]+">[^]*?<\/button><\/div><div class="browser-drag-out" data-testid="lightroom-drag"/,'the layout pair, then Drag to Lightroom last');
 assert.equal(shown.match(/class="browser-toggle"/g)?.length,1,'browser-toggle stays the RAW + JPEG toggle only');
 assert.ok(!shown.includes('browser-filter-note'),'no filter note while nothing is hidden');
 const bars=page({...defaultConfiguration(),hideBars:true});
 for(const gone of ['browser-toolbar','browser-source-row','browser-filter-bar','browser-status','browser-path-row','browser-clear-all','browser-selection-bar','hierarchy-editor'])assert.ok(!bars.includes(gone),`${gone} hidden with the bars`);
 for(const kept of ['class="browser-horizontal browser-columns"','browser-height-resize','data-testid="browser-files"','RAW + JPEG','data-testid="lightroom-drag"'])assert.ok(bars.includes(kept),`${kept} kept`);
 assert.match(bars,/<div class="browser-results-tools"><button type="button" class="browser-toggle"[^]*?RAW \+ JPEG<\/span><\/button><div class="browser-layout-toggles"/,'with the bars hidden, RAW + JPEG moves to the results header');
 assert.equal(bars.match(/class="browser-toggle"/g)?.length,1);
 assert.match(bars,/aria-pressed="false" aria-label="Show the library and filter bars"/);
 const columns=page({...defaultConfiguration(),hideColumns:true});
 for(const gone of ['class="browser-horizontal browser-columns"','browser-height-resize','data-testid="facet-column"','browser-add-column'])assert.ok(!columns.includes(gone),`${gone} hidden with the columns`);
 for(const kept of ['<div class="browser-toolbar">','<div class="browser-filter-bar"','<div class="browser-path-row">','<div class="browser-workspace">','data-testid="browser-files"'])assert.ok(columns.includes(kept),`${kept} kept`);
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
test('a height saved before the columns had their own (the whole area) is dropped: the columns and the results split the room as by default',()=>{
 const blocks=defaultConfiguration().blocks;const stored=(value:object)=>({getItem:(key:string)=>key===configurationKey?JSON.stringify({version:1,blocks,presets:[],activePresetId:'builtin-date-camera-format',...value}):null});
 const old=readConfiguration(stored({contentHeight:560,columnWidth:260,previewWidth:300,hideBars:true}));
 assert.ok(!('contentHeight' in old),'the old field goes on the next write');assert.equal(old.columnsHeight,undefined);
 assert.equal(old.columnWidth,260);assert.equal(old.previewWidth,300);assert.equal(old.hideBars,true);assert.deepEqual(old.blocks.map(b=>b.kind),['date','camera','format'],'the rest of an old view still loads');
 assert.deepEqual(paneHeights(800,old.columnsHeight),paneHeights(800,undefined));const split=paneHeights(800,undefined);assert.equal(split.columns,Math.round((800-heightHandle)*.45));assert.equal(split.results,800-heightHandle-split.columns!);
 assert.ok(paneHeights(800,560).results!<split.results!,'560 read as the columns alone would squeeze the results');
 assert.equal(readConfiguration(stored({columnsHeight:300})).columnsHeight,300,'the new field is kept');assert.equal(readConfiguration(stored({columnsHeight:'tall'})).columnsHeight,undefined);
});
test('the columns, their handle and the results fit the least room exactly, and the results take all of it with the columns hidden',()=>{
 assert.equal(minWorkspaceHeight,minContentHeight+heightHandle+minResultsHeight);
 for(const room of [minWorkspaceHeight,500,1000]){const {columns,results}=paneHeights(room,undefined);assert.equal(columns!+heightHandle+results!,room,`${room}px`);assert.ok(columns!>=minContentHeight&&results!>=minResultsHeight);}
 assert.equal(paneHeights(minWorkspaceHeight,2000).columns,minContentHeight,'a saved height leaves the results their minimum');
 assert.equal(paneHeights(600,undefined,true).results,600);assert.deepEqual(paneHeights(undefined,300),{columns:300,columnsMax:2400,results:undefined});
});
test('Restore default view restores the default columns only: presets and every layout setting stay',()=>{
 const c={...savePreset(addBlock(defaultConfiguration(),'iso',0),'Mine','preset-mine'),columnWidth:300,columnsHeight:320,previewWidth:420,previewLarge:true,hideBars:true,hideColumns:true,combinePairs:false};
 const restored=restoreDefaultView(c);assert.deepEqual(restored.blocks.map(b=>b.kind),['date','camera','format']);assert.equal(restored.activePresetId,'builtin-date-camera-format');
 assert.deepEqual(restored.presets,c.presets);for(const key of ['columnWidth','columnsHeight','previewWidth','previewLarge','hideBars','hideColumns','combinePairs'] as const)assert.equal(restored[key],c[key],key);
});
test('the filter bar is a labelled group, the storage error names no one system, the menus do not inherit the strip help, and the hints translate',()=>{
 const html=page();assert.match(html,/<div class="browser-filter-bar" role="group" aria-label="Library filter"/);assert.doesNotMatch(html,/role="toolbar"/,'no toolbar role without its arrow-key behaviour');
 const failed=render(createElement(BrowserPage,{libraries:[library],statuses:{},configuration:defaultConfiguration(),onConfiguration:()=>{},api,onRefresh:()=>{},onStop:()=>{},onOrganization:()=>{},onReveal:()=>{},storageError:true}));
 assert.match(failed,/role="alert">This view could not be saved on this computer\.<\/p>/);assert.doesNotMatch(failed,/this Mac/);
 assert.match(html,/class="browser-horizontal browser-columns" aria-label="Library columns" title="[^"]*Right from the last column moves to the files[^"]*Esc closes the preview first, then clears/,'the strip help says what Right and Esc do');
 const menu=render(createElement(ColumnMenu,{configuration:defaultConfiguration(),block:defaultConfiguration().blocks[0]!,onChange:()=>{}}));assert.match(menu,/class="browser-menu" role="group" aria-label="[^"]+" title=""/,'an empty title stops the strip help showing over the menu');
 for(const language of ['zh-Hans','zh-Hant','ja'] as const){const t=createTranslator(language);for(const label of ['This view could not be saved on this computer.','Click a folder to open it: its subfolders show in the next column, its files below.','Click a folder (or press Enter) to open it: its subfolders show in the next column. Arrow keys navigate; Right from the last column moves to the files, Left comes back. Esc closes the preview. Tab moves to controls.'])assert.notEqual(t(label),label,`${language}: ${label}`);assert.doesNotMatch(t('This view could not be saved on this computer.'),/Mac/);}
});
test('a closed dropdown steps to the previous or next enabled option, past disabled options and group labels, or to the first or last',()=>{
 const entries=[{disabled:true},{group:true},{},{},{disabled:true},{group:true},{},{disabled:true}];
 assert.equal(nextSelectIndex(entries,2,'ArrowDown'),3);assert.equal(nextSelectIndex(entries,3,'ArrowDown'),6,'skips a disabled option and a group label');
 assert.equal(nextSelectIndex(entries,6,'ArrowDown'),6,'stays on the last enabled option');assert.equal(nextSelectIndex(entries,6,'ArrowUp'),3);
 assert.equal(nextSelectIndex(entries,2,'ArrowUp'),2,'a disabled first option (Custom view) is never chosen');
 assert.equal(nextSelectIndex(entries,6,'Home'),2);assert.equal(nextSelectIndex(entries,2,'End'),6);
 assert.equal(nextSelectIndex(entries,-1,'ArrowDown'),2,'nothing chosen: Down picks the first enabled option');
 assert.equal(nextSelectIndex([{disabled:true},{group:true}],-1,'Home'),-1,'no enabled option: nothing changes');
 // macOS keeps the browser's own keys (the list opens); Windows and Linux change the value in place.
 assert.equal(selectKeyDown('darwin'),undefined);assert.equal(typeof selectKeyDown('win32'),'function');assert.equal(typeof selectKeyDown('linux'),'function');
 assert.equal(rendererPlatform('darwin'),'darwin');assert.equal(rendererPlatform('win32'),'win32');assert.equal(rendererPlatform('linux'),'linux');
});
test('the open column editor takes what the workspace minimum leaves, at most its share, and in a short window enough to use while the workspace keeps its editing minimum',()=>{
 // A tall window: the editor takes its share; the workspace keeps more than its minimum.
 assert.equal(editorHeight(1000),Math.round(1000*editorShare));assert.ok(1000-editorHeight(1000)>=minWorkspaceHeight);
 // Middle: what the workspace minimum leaves.
 assert.equal(editorHeight(640),640-minWorkspaceHeight);
 // Short (a 720px window): the editor keeps its least height; the workspace shrinks to its editing minimum, never below.
 assert.equal(editorHeight(407),Math.min(minEditorHeight,407-minEditingWorkspaceHeight));assert.ok(407-editorHeight(407)>=minEditingWorkspaceHeight);
 for(const room of [300,407,500,640,800,1200])assert.ok(editorHeight(room)>0&&editorHeight(room)<=Math.round(room*editorShare)+1,'never over its share');
 // While editing, the results may shrink toward their editing minimum so the columns and handle still fit the room.
 const short=paneHeights(minEditingWorkspaceHeight,undefined,false,true);assert.equal(short.columns,minContentHeight);assert.equal(short.results,editingResultsHeight);assert.equal(short.columns!+heightHandle+short.results!,minEditingWorkspaceHeight);
 assert.deepEqual(paneHeights(600,undefined,false,true),paneHeights(600,undefined),'with room enough, editing changes nothing');
});
