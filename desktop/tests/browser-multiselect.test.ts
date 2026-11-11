import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider} from '../renderer/i18n';
import {addBlockSelection,addWithinLimit,filterSize,maxFilterValues,pickFits,selectedKeys,selectionSummary,toggleBlockSelection,unionFilters} from '../renderer/browser/selection';
import {dragRequestFor,LightroomDrag} from '../renderer/browser/LightroomDrag';
import type {BrowserAPI} from '../renderer/browser/api';
import {addBlock,createBlock,defaultConfiguration} from '../renderer/browser/configuration';
import {browserReducer,chosenFiles,effectiveFiles,effectiveSelections,fileSelected,fileSelectionCount,initialBrowserState,noFiles,queryFor,selectionFilter} from '../renderer/browser/state';
import {PagedList} from '../renderer/browser/use-paged';
import {VirtualList} from '../renderer/browser/VirtualList';
import {ColumnCheckAll} from '../renderer/browser/ColumnCheckAll';
import {openCatalog} from '../catalog/store';
import {library,record} from './catalog-fixtures';
import {buildDragPayload,collectDragFiles,MAX_DRAG_FILES,validDragRequest,type DragSource} from '../core/file-drag';
import type {CatalogPage,CatalogQuery,CatalogRecord,CatalogRow,Filter} from '../catalog/types';

const option=(value:string,label=value)=>({key:`value:string:${value}`,value,label});
const missing={key:'missing',label:'Missing details',missing:true};

test('a checkbox checks a row and a second one unchecks it; several rows stay checked in one column',()=>{
 const block=createBlock('date');
 let filter=toggleBlockSelection(block,undefined,option('2026-09'),true);
 assert.deepEqual(selectedKeys(filter),['value:string:2026-09']);
 filter=toggleBlockSelection(block,filter,option('2026-10'),true);
 assert.deepEqual(selectedKeys(filter),['value:string:2026-09','value:string:2026-10']);
 filter=toggleBlockSelection(block,filter,option('2026-09'),true);
 assert.deepEqual(selectedKeys(filter),['value:string:2026-10']);
 assert.equal(toggleBlockSelection(block,filter,option('2026-10'),true),undefined,'deselecting the last row clears the column');
 // A click picks one row alone.
 assert.deepEqual(selectedKeys(toggleBlockSelection(block,{kind:'values',field:'captureYearMonth',values:['2026-09','2026-10']},option('2026-11'),false)),['value:string:2026-11']);
});

test('Missing details joins values in one column instead of replacing them',()=>{
 const block=createBlock('camera');
 let filter=toggleBlockSelection(block,undefined,option('nikon z f','NIKON Z f'),true);
 filter=toggleBlockSelection(block,filter,missing,true);
 assert.deepEqual(filter,{kind:'values',field:'camera',blockId:block.id,values:['nikon z f'],labels:['NIKON Z f'],orMissing:true});
 assert.deepEqual(selectedKeys(filter),['value:string:nikon z f','missing']);
 filter=toggleBlockSelection(block,filter,option('nikon z f','NIKON Z f'),true);
 assert.deepEqual(filter,{kind:'missing',field:'camera',blockId:block.id});
 const iso=createBlock('iso');
 const ranges=addBlockSelection(iso,{kind:'missing',field:'iso',blockId:iso.id},[{key:'range:a',range:{min:100,max:200,maxInclusive:false},label:''}]);
 assert.deepEqual(ranges,{kind:'ranges',field:'iso',blockId:iso.id,ranges:[{min:100,max:200,maxInclusive:false}],orMissing:true});
});

test('checking every row adds each once and keeps choices from other pages; clearing the column clears its checks and pick',()=>{
 const block=createBlock('camera');
 const hidden=toggleBlockSelection(block,undefined,option('camera 201','Camera 201'),true);
 const all=addBlockSelection(block,hidden,[option('camera 1','Camera 1'),option('camera 201','Camera 201'),missing]);
 assert.deepEqual(all,{kind:'values',field:'camera',blockId:block.id,values:['camera 201','camera 1'],labels:['Camera 201','Camera 1'],orMissing:true});
 let s=initialBrowserState([block]);s={...s,libraryId:'l'};
 s=browserReducer(s,{type:'pick',blockId:block.id,filter:toggleBlockSelection(block,undefined,option('camera 7','Camera 7'),false)});
 s=browserReducer(s,{type:'select',blockId:block.id,filter:all});assert.ok(s.selections[block.id]);assert.ok(s.picks[block.id],'a pick outside the checked rows stays');
 s=browserReducer(s,{type:'select',blockId:block.id});assert.equal(s.selections[block.id],undefined);assert.equal(s.picks[block.id],undefined);
});

test('later columns show the union of the items chosen in earlier columns',()=>{
 let c=defaultConfiguration();c={...c,blocks:[]};for(const kind of ['date','date','camera'] as const)c=addBlock(c,kind,c.blocks.length);
 const [year,month,camera]=c.blocks as [typeof c.blocks[0],typeof c.blocks[0],typeof c.blocks[0]];
 let s={...initialBrowserState(c.blocks),libraryId:'l'};
 s=browserReducer(s,{type:'select',blockId:year.id,filter:selectionFilter(year,[2026])});
 s=browserReducer(s,{type:'select',blockId:month.id,filter:toggleBlockSelection(month,toggleBlockSelection(month,undefined,option('2026-09'),true),option('2026-10'),true)});
 const cameraColumn=queryFor(s,2).filters;
 assert.deepEqual(cameraColumn.map(f=>f.kind==='values'?f.values:[]),[[2026],['2026-09','2026-10']],'the camera column lists cameras of both months');
 assert.equal(queryFor(s,2).facetBlockId,camera.id);
});

test('the selection bar names each column’s choices with their number',()=>{
 const year={...createBlock('date'),dateGranularity:'year' as const,datePattern:'YYYY'};
 const month={...createBlock('date'),dateGranularity:'month' as const,datePattern:'YYYYMM'};
 const camera=createBlock('camera'),iso=createBlock('iso');
 assert.deepEqual(selectionSummary(year,{kind:'values',field:'captureYear',values:[2026]},'en','Missing details'),{text:'2026',count:1});
 assert.deepEqual(selectionSummary(month,{kind:'values',field:'captureYearMonth',values:['2026-09','2026-10']},'en','Missing details'),{text:'202609, 202610',count:2});
 assert.deepEqual(selectionSummary(camera,{kind:'values',field:'camera',values:['nikon z f'],labels:['NIKON Z f'],orMissing:true},'en','Missing details'),{text:'NIKON Z f, Missing details',count:2});
 assert.deepEqual(selectionSummary(camera,{kind:'values',field:'camera',values:['a','b','c','d','e'],labels:['A','B','C','D','E']},'en','Missing details'),{text:'A, B, C +2',count:5});
 assert.deepEqual(selectionSummary(iso,{kind:'ranges',field:'iso',ranges:[{min:100,max:200,maxInclusive:false},{min:400,max:400,maxInclusive:true}]},'en','Missing details').count,2);
 assert.match(selectionSummary(iso,{kind:'ranges',field:'iso',ranges:[{min:100,max:200,maxInclusive:false}]},'en','Missing details').text,/ISO 100/);
});

test('a click on a file only shows it and counts it; checkboxes and Shift check files without moving the preview',()=>{
 let s={...initialBrowserState([]),libraryId:'l'};
 s=browserReducer(s,{type:'toggleFile',fileId:'a'});s=browserReducer(s,{type:'toggleFile',fileId:'b'});
 assert.deepEqual(s.files,{all:false,ids:['a','b']});assert.equal(s.selectedFile,undefined,'checking never opens the preview');
 s=browserReducer(s,{type:'file',fileId:'z'});assert.equal(s.selectedFile,'z');assert.deepEqual(s.files.ids,['a','b'],'a click keeps the checked files');
 assert.deepEqual(effectiveFiles(s),{all:false,ids:['a','b','z']});
 s=browserReducer(s,{type:'file',fileId:'y'});assert.deepEqual(effectiveFiles(s).ids,['a','b','y'],'the next click replaces the last one');
 s=browserReducer(s,{type:'toggleFile',fileId:'b'});assert.deepEqual(s.files.ids,['a']);assert.equal(s.selectedFile,'y');
 s=browserReducer(s,{type:'addFiles',fileIds:['c','d','a']});assert.deepEqual(s.files.ids,['a','c','d']);assert.equal(s.selectedFile,'y','a Shift range leaves the preview');
 s=browserReducer(s,{type:'file',fileId:'a'});assert.deepEqual(effectiveFiles(s),s.files,'a click on a checked file adds nothing');
 s=browserReducer(s,{type:'file',fileId:'a'});assert.equal(s.selectedFile,undefined,'a second click lets it go');
 s=browserReducer(s,{type:'allFiles',select:true});assert.equal(fileSelectionCount(effectiveFiles(s),10),10);
 s=browserReducer(s,{type:'toggleFile',fileId:'c'});assert.equal(fileSelected(s.files,'c'),false);assert.equal(fileSelected(s.files,'a'),true);assert.equal(fileSelectionCount(effectiveFiles(s),10),9);
 s=browserReducer(s,{type:'file',fileId:'c'});assert.deepEqual(effectiveFiles(s),{all:true,ids:[]},'a clicked file unchecked after checking all counts again');assert.deepEqual(s.files,{all:true,ids:['c']});
 s=browserReducer(s,{type:'preview'});assert.equal(fileSelectionCount(effectiveFiles(s),10),9,'closing the preview lets the click go and keeps the checks');
 s=browserReducer(s,{type:'search',value:'IMG'});assert.equal(fileSelectionCount(effectiveFiles(s),10),0,'a new query starts with no files chosen');
 s=browserReducer(s,{type:'allFiles',select:true});s=browserReducer(s,{type:'file',fileId:'q'});s=browserReducer(s,{type:'allFiles',select:false});assert.equal(fileSelectionCount(effectiveFiles(s),10),0);assert.equal(s.selectedFile,undefined);
});

const row=(fileId:string,pairedRaw?:string):CatalogRow=>({fileId,libraryId:'l',relativePath:`${fileId}.JPG`,parentPath:'',name:`${fileId}.JPG`,mediaKind:'JPEG',extension:'jpg',size:'1',metadataStatus:'ready',values:{metadataStatus:'ready'},placement:{status:'inPlace',actualRelativePath:`${fileId}.JPG`,rulesScope:'r'},companionCount:0,...(pairedRaw?{pairedRaw:{fileId:pairedRaw,name:`${fileId}.NEF`,extension:'nef',size:'2'}}:{})});
const query:CatalogQuery={libraryId:'l',filters:[],sort:{field:'name',direction:'asc'},limit:200,cursor:'page-2'};

test('a drag carries the chosen files with their paired RAWs, or every file shown when none are chosen',()=>{
 assert.deepEqual(dragRequestFor('l',query,{all:false,ids:['a','b']},[row('a','a-raw'),row('b')]),{libraryId:'l',fileIds:['a','a-raw','b']});
 assert.deepEqual(dragRequestFor('l',query,effectiveFiles({files:{all:false,ids:['a']},selectedFile:'b'}),[row('a','a-raw'),row('b')]),{libraryId:'l',fileIds:['a','a-raw','b']},'the checked files and the clicked one');
 assert.deepEqual(dragRequestFor('l',query,effectiveFiles({files:{all:false,ids:[]},selectedFile:'b'}),[row('b')]),{libraryId:'l',fileIds:['b']},'the clicked file alone');
 const all=dragRequestFor('l',query,{all:false,ids:[]},[row('a')]);
 assert.ok('query' in all);assert.equal(all.query.cursor,undefined,'the whole result, not the loaded page');assert.deepEqual(all.except,[]);
 const except=dragRequestFor('l',query,{all:true,ids:['b']},[]);assert.ok('except' in except);assert.deepEqual(except.except,['b']);
 for(const request of [dragRequestFor('l',query,{all:false,ids:['a']},[]),all,except])assert.equal(validDragRequest(request),true);
 assert.equal(validDragRequest({libraryId:'l',query:{...query,libraryId:'other'},except:[]}),false,'one library per drag');
 assert.equal(validDragRequest({libraryId:'l',fileIds:[42]}),false);assert.equal(validDragRequest(null),false);
});

const render=(child:ReturnType<typeof createElement>)=>renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:child}));
const dragApi={prepareDrag:async()=>({token:'t',files:0,photos:0,companions:0,skipped:0}),startDrag:()=>{}} as unknown as BrowserAPI;
test('the Files column ends with a Drag to Lightroom handle showing what it carries',()=>{
 const props={api:dragApi,libraryId:'l',online:true,query,rows:[],revision:1};
 const all=render(createElement(LightroomDrag,{...props,selection:{all:false,ids:[]},total:202}));
 assert.match(all,/Drag to Lightroom/);assert.match(all,/All 202/);assert.match(all,/draggable="true"/);assert.match(all,/Lightroom Classic/);
 assert.match(render(createElement(LightroomDrag,{...props,selection:{all:false,ids:['a','b']},total:202})),/2 selected/);
 const offline=render(createElement(LightroomDrag,{...props,online:false,selection:{all:false,ids:[]},total:202}));
 assert.match(offline,/aria-disabled="true"/);assert.match(offline,/Connect the drive/);
 const many=render(createElement(LightroomDrag,{...props,selection:{all:false,ids:[]},total:MAX_DRAG_FILES+1}));
 assert.match(many,/draggable="false"/);assert.match(many,/at most 10,000/);
 assert.match(render(createElement(LightroomDrag,{...props,selection:{all:false,ids:[]},total:0})),/aria-disabled="true"/);
});

function fakeSource(rows:CatalogRow[],companions:Record<string,string[]>,paths:Record<string,string>,pageSize=2):DragSource&{queries:CatalogQuery[]}{
 const queries:CatalogQuery[]=[];
 return {queries,
  async query(q){queries.push(q);const start=q.cursor?Number(q.cursor):0;const page:CatalogPage={rows:rows.slice(start,start+pageSize),total:rows.length,revision:1,...(start+pageSize<rows.length?{nextCursor:String(start+pageSize)}:{})};return page;},
  async companions(_libraryId,ids){return ids.flatMap(id=>(companions[id]??[]).map(fileId=>({fileId,companionOf:id}) as CatalogRecord));},
  async resolve(fileId){const file=paths[fileId];if(!file)throw new Error('gone');return file;}};
}
test('the drag payload lists each photo, its paired RAW and sidecars once, skipping files that are gone',async()=>{
 const paths={a:'/p/a.JPG','a-raw':'/p/a.NEF','a-xmp':'/p/a.xmp',b:'/p/b.NEF','b-xmp':'/p/b.xmp',c:'/p/c.JPG'};
 const source=fakeSource([row('a','a-raw'),row('b'),row('c'),row('gone')],{'a-raw':['a-xmp'],b:['b-xmp','missing-xmp']},paths);
 const all=await collectDragFiles({libraryId:'l',query,except:[]},source);
 assert.deepEqual(all.files,['/p/a.JPG','/p/a.NEF','/p/a.xmp','/p/b.NEF','/p/b.xmp','/p/c.JPG']);
 assert.deepEqual({photos:all.photos,companions:all.companions,skipped:all.skipped},{photos:4,companions:2,skipped:1});
 assert.ok(source.queries.every(q=>q.limit===500),'pages through the whole result');
 const except=await collectDragFiles({libraryId:'l',query,except:['a','c']},source);assert.deepEqual(except.files,['/p/b.NEF','/p/b.xmp']);
 const chosen=await collectDragFiles({libraryId:'l',fileIds:['c','b','c']},source);assert.deepEqual(chosen.files,['/p/c.JPG','/p/b.NEF','/p/b.xmp']);
 const tooMany=await collectDragFiles({libraryId:'l',query,except:[]},source,3);assert.equal(tooMany.tooMany,true);assert.deepEqual(tooMany.files,[]);
 assert.deepEqual(buildDragPayload([{file:'/x',companions:['/x.xmp']},{file:'/x',companions:[]}]),['/x','/x.xmp']);
});

const camera=createBlock('camera'),iso=createBlock('iso'),day=defaultConfiguration().blocks.find(block=>block.kind==='date')!;
const values=(filter:Filter|undefined)=>filter?.kind==='values'?filter.values:filter;
test('a column’s checked rows and its pick join in one filter: each value once with its label, ranges, Missing details, dates',()=>{
 const nikon:Filter={kind:'values',field:'camera',blockId:camera.id,values:['nikon z f'],labels:['NIKON Z f']},sony:Filter={kind:'values',field:'camera',blockId:camera.id,values:['sony a7'],labels:['SONY A7']};
 assert.deepEqual(unionFilters(camera,nikon,sony),{kind:'values',field:'camera',blockId:camera.id,values:['nikon z f','sony a7'],labels:['NIKON Z f','SONY A7']});
 assert.deepEqual(unionFilters(camera,nikon,nikon),nikon,'the picked row among the checked ones adds nothing');
 assert.deepEqual(unionFilters(camera,undefined,sony),sony);assert.deepEqual(unionFilters(camera,nikon,undefined),nikon);assert.equal(unionFilters(camera,undefined,undefined),undefined);
 const format=createBlock('format');
 assert.deepEqual(unionFilters(format,{kind:'values',field:'format',blockId:format.id,values:['jpg','jpeg'],labels:['JPEG','JPEG']},{kind:'values',field:'format',blockId:format.id,values:['png']}),{kind:'values',field:'format',blockId:format.id,values:['jpg','jpeg','png'],labels:['JPEG','JPEG','png']},'a value without a label is labelled by itself');
 const missing:Filter={kind:'missing',field:'camera',blockId:camera.id};
 assert.deepEqual(unionFilters(camera,missing,nikon),{...nikon,orMissing:true});assert.deepEqual(unionFilters(camera,missing,missing),missing);
 assert.deepEqual(unionFilters(camera,{...nikon,orMissing:true},sony),{kind:'values',field:'camera',blockId:camera.id,values:['nikon z f','sony a7'],labels:['NIKON Z f','SONY A7'],orMissing:true});
 const bucket:Filter={kind:'ranges',field:'iso',blockId:iso.id,ranges:[{min:100,max:200,maxInclusive:false}],orMissing:true},iso400:Filter={kind:'values',field:'iso',blockId:iso.id,values:[400]};
 assert.deepEqual(unionFilters(iso,bucket,iso400),{kind:'ranges',field:'iso',blockId:iso.id,ranges:[{min:100,max:200,maxInclusive:false},{min:400,max:400,maxInclusive:true}],orMissing:true},'an exact value joins ranges as a range of its own');
 assert.deepEqual(unionFilters(iso,{kind:'ranges',field:'iso',blockId:iso.id,ranges:[{min:400,max:400,maxInclusive:true}]},iso400),{kind:'ranges',field:'iso',blockId:iso.id,ranges:[{min:400,max:400,maxInclusive:true}]},'one value once');
 assert.deepEqual(unionFilters(iso,{kind:'range',field:'iso',blockId:iso.id,min:100,max:400,maxInclusive:true},{kind:'values',field:'iso',blockId:iso.id,values:[800]}),{kind:'ranges',field:'iso',blockId:iso.id,ranges:[{min:100,max:400,maxInclusive:true},{min:800,max:800,maxInclusive:true}]},'a custom range and a value');
 const date=(...days:string[]):Filter=>({kind:'values',field:'captureDay',blockId:day.id,values:days,labels:days});
 assert.deepEqual(unionFilters(day,date('2026'),date('2026-11-03')),date('2026'),'a day inside a checked year adds nothing');
 assert.deepEqual(unionFilters(day,date('2026-11'),date('2026-11-03')),date('2026-11'),'nor inside a checked month');
 assert.deepEqual(unionFilters(day,date('2026-11-01','2025'),date('2026')),date('2025','2026'),'a picked year covers the checked days of it');
 assert.deepEqual(unionFilters(day,date('2025'),date('2026-11')),date('2025','2026-11'));
});

test('a click picks one row: the next click in the column moves it, the checked rows stay, and the column filters by both',()=>{
 const lens=createBlock('lens');let s={...initialBrowserState([camera,lens]),libraryId:'l'};
 const one=(value:string)=>toggleBlockSelection(camera,undefined,option(value),false)!;
 s=browserReducer(s,{type:'select',blockId:camera.id,filter:one('nikon')});
 s=browserReducer(s,{type:'pick',blockId:camera.id,filter:one('sony')});
 assert.deepEqual(values(queryFor(s).filters[0]),['nikon','sony']);
 s=browserReducer(s,{type:'pick',blockId:camera.id,filter:one('canon')});
 assert.deepEqual(s.selections[camera.id],one('nikon'),'checks are unaffected by picks');assert.deepEqual(values(queryFor(s).filters[0]),['nikon','canon'],'the previous pick is dropped');
 assert.deepEqual(values(queryFor(s,1).filters[0]),['nikon','canon'],'the next column lists within both');
 s=browserReducer(s,{type:'pick',blockId:camera.id});assert.equal(s.picks[camera.id],undefined);assert.deepEqual(values(queryFor(s).filters[0]),['nikon']);
});

test('checking a row keeps the column’s pick, unless it checks the picked row itself',()=>{
 let s={...initialBrowserState([camera]),libraryId:'l'};
 let checks=toggleBlockSelection(camera,undefined,option('nikon'),true);const sony=toggleBlockSelection(camera,undefined,option('sony'),false)!;
 s=browserReducer(s,{type:'select',blockId:camera.id,filter:checks});s=browserReducer(s,{type:'pick',blockId:camera.id,filter:sony});
 checks=toggleBlockSelection(camera,checks,option('canon'),true);s=browserReducer(s,{type:'select',blockId:camera.id,filter:checks});
 assert.deepEqual(s.picks[camera.id],sony,'checking another row keeps the pick');assert.deepEqual(values(queryFor(s).filters[0]),['nikon','canon','sony']);
 checks=toggleBlockSelection(camera,checks,option('nikon'),true);s=browserReducer(s,{type:'select',blockId:camera.id,filter:checks});assert.deepEqual(s.picks[camera.id],sony,'so does unchecking one');
 checks=toggleBlockSelection(camera,checks,option('sony'),true);s=browserReducer(s,{type:'select',blockId:camera.id,filter:checks});
 assert.equal(s.picks[camera.id],undefined,'the picked row, checked, is locked');assert.deepEqual(values(s.selections[camera.id]),['canon','sony']);
 s=browserReducer(s,{type:'pick',blockId:camera.id,filter:toggleBlockSelection(camera,undefined,option('fuji'),false)});s=browserReducer(s,{type:'select',blockId:camera.id});
 assert.deepEqual([s.selections[camera.id],s.picks[camera.id]],[undefined,undefined],'clearing the column clears both');
});

test('the rows show their checkbox, the picked row and the checked ones; the real folders have no checkboxes',()=>{
 const rows=[{key:'a',label:'Alpha',count:3},{key:'b',label:'Beta',count:2},{key:'c',label:'Gamma'}];
 const html=render(createElement(VirtualList,{rows,label:'List',checked:['a'],picked:'b',onPick:()=>{},onCheck:()=>{}}));
 assert.equal(html.match(/data-testid="row-check"/g)?.length,3);assert.match(html,/aria-multiselectable="true"/);
 assert.match(html,/role="option" aria-selected="true" data-row-key="a" class="browser-row is-checked"[^>]*><label class="browser-row-check"><input type="checkbox" tabindex="-1" data-testid="row-check" aria-label="Select Alpha" checked=""\/><\/label><span>Alpha<\/span><small>3<\/small>/);
 assert.match(html,/aria-selected="true" data-row-key="b" data-picked="true" class="browser-row is-active is-picked"/,'the picked row also has the keyboard cursor');assert.match(html,/aria-selected="false" data-row-key="c" class="browser-row"/);
 const folders=render(createElement(VirtualList,{rows,label:'Folders',checkable:false,picked:'b',onPick:()=>{}}));
 assert.doesNotMatch(folders,/row-check/);assert.match(folders,/aria-multiselectable="false"/);assert.match(folders,/class="browser-virtual-list is-single"/);assert.match(folders,/data-row-key="b" data-picked="true"[^>]*><span>Beta<\/span>/);
 assert.match(html,/data-row-key="a"[^>]*aria-description="Checked"/);assert.match(html,/data-row-key="b"[^>]*aria-description="Shown for now, not checked"/,'screen readers tell a checked row from a picked one');assert.doesNotMatch(html,/data-row-key="c"[^>]*aria-description/);assert.doesNotMatch(folders,/aria-description/);
 const master=(state:'none'|'some'|'all',disabled=false,name?:string)=>render(createElement(ColumnCheckAll,{state,disabled,name,onChange:()=>{}}));
 assert.match(master('none'),/title="Select all"[^]*data-testid="column-check-all" aria-label="Select all"\/>/);assert.match(master('all'),/title="Deselect all"[^]*aria-label="Deselect all" checked=""/);assert.match(master('some'),/aria-label="Deselect all"/,'its name says it clears the column');
 assert.match(master('none',false,'Camera'),/aria-label="Select all: Camera"/);assert.match(master('some',false,'Files'),/aria-label="Deselect all: Files"/);assert.match(master('some'),/title="Deselect all"/);assert.match(master('none',true),/disabled=""/);
});

test('unchecking the last checked row while another is picked is one step: Back restores both',()=>{
 let s={...initialBrowserState([camera]),libraryId:'l'};
 const a=toggleBlockSelection(camera,undefined,option('a'),true),b=toggleBlockSelection(camera,undefined,option('b'),false)!;
 s=browserReducer(s,{type:'select',blockId:camera.id,filter:a});s=browserReducer(s,{type:'pick',blockId:camera.id,filter:b});
 const before=s.past.length;s=browserReducer(s,{type:'select',blockId:camera.id,keepPick:true});
 assert.deepEqual([s.selections[camera.id],s.picks[camera.id]],[undefined,b],'the pick stays');assert.equal(s.past.length,before+1,'one history entry');
 s=browserReducer(s,{type:'back'});assert.deepEqual([s.selections[camera.id],s.picks[camera.id]],[a,b],'one Back: A checked and B picked');
 // The selection bar's × clears the column's checks and its pick in one step too.
 s=browserReducer(s,{type:'select',blockId:camera.id});assert.deepEqual([s.selections[camera.id],s.picks[camera.id]],[undefined,undefined]);
 s=browserReducer(s,{type:'back'});assert.deepEqual([s.selections[camera.id],s.picks[camera.id]],[a,b]);
});

test('a pick that would take a column past the catalog’s 500 values is left out, and the column does not show it picked',()=>{
 const full=selectionFilter(camera,Array.from({length:maxFilterValues},(_,i)=>`camera ${i}`)),inside=selectionFilter(camera,['camera 3']),outside=selectionFilter(camera,['other']);
 assert.equal(maxFilterValues,500);assert.equal(pickFits(camera,full,outside),false);assert.equal(unionFilters(camera,full,outside),full);
 assert.equal(pickFits(camera,full,inside),true,'a pick among the checked rows adds nothing');assert.equal(pickFits(camera,selectionFilter(camera,['x']),outside),true);
 const s={...initialBrowserState([camera]),libraryId:'l',selections:{[camera.id]:full},picks:{[camera.id]:outside}};
 const sent=effectiveSelections(s)[camera.id];assert.equal(sent?.kind==='values'&&sent.values.length,maxFilterValues);assert.deepEqual(queryFor(s).filters,[full]);
 const ranges:Filter={kind:'ranges',field:'iso',blockId:iso.id,ranges:Array.from({length:maxFilterValues},(_,i)=>({min:i+1,max:i+1,maxInclusive:true}))};
 assert.equal(unionFilters(iso,ranges,{kind:'values',field:'iso',blockId:iso.id,values:[9999]}),ranges);
});

test('catalog: Missing details OR values in one column, and companions are listed for their primaries',async()=>{
 const c=openCatalog(':memory:');await c.configure([library]);
 try{
  const ready=(camera?:string)=>({values:{metadataStatus:'ready' as const,...(camera?{camera,cameraKey:camera.toLowerCase()}:{})}});
  await c.apply([record('a','a.NEF',ready('Nikon')),record('b','b.NEF',ready('Sony')),record('c','c.NEF',ready()),record('a-xmp','a.xmp',{companionOf:'a',mediaKind:'Other',extension:'xmp'}),record('b-xmp','b.xmp',{companionOf:'b',mediaKind:'Other',extension:'xmp'})].map(r=>({kind:'upsert' as const,libraryId:library.libraryId,record:r,mutationRevision:0})));
  const q=(filters:Filter[]):CatalogQuery=>({libraryId:library.libraryId,filters,sort:{field:'name',direction:'asc'},limit:20});
  const names=async(filters:Filter[])=>(await c.query(q(filters))).rows.map(r=>r.name);
  assert.deepEqual(await names([{kind:'values',field:'camera',values:['Nikon'],orMissing:true}]),['a.NEF','c.NEF']);
  assert.deepEqual(await names([{kind:'values',field:'camera',values:['Nikon','Sony']}]),['a.NEF','b.NEF']);
  assert.deepEqual(await names([{kind:'values',field:'camera',values:[],orMissing:true}]),['c.NEF']);
  await assert.rejects(c.query(q([{kind:'values',field:'camera',values:['Nikon'],orMissing:'yes' as unknown as boolean}])),/Invalid filter/);
  assert.deepEqual((await c.companions(library.libraryId,['a','b','c'])).map(r=>[r.fileId,r.companionOf]),[['a-xmp','a'],['b-xmp','b']]);
  await assert.rejects(c.companions(library.libraryId,Array.from({length:501},(_,i)=>String(i))),/500/);
 }finally{await c.close();}
});

test('IPC: the preload exposes prepareDrag and startDrag, and main checks the sender before starting a system drag',async()=>{
 const read=(file:string)=>readFile(new URL(`../${file}`,import.meta.url),'utf8');
 const [preload,main,worker,client,session]=await Promise.all([read('preload.ts'),read('main.ts'),read('catalog/worker.ts'),read('catalog/process.ts'),read('catalog/session.ts')]);
 assert.match(preload,/prepareDrag:\(request:DragRequest\)[^\n]*ipcRenderer\.invoke\('importer:prepareDrag',request\)/);
 assert.match(preload,/startDrag:\(token:string,icon:string\)=>ipcRenderer\.send\('importer:startDrag',token,icon\)/,'a send: main starts the drag while the pointer is held');
 assert.match(main,/ipcMain\.handle\('importer:prepareDrag',async\(event,request:unknown\)=>\{trusted\(event\);if\(!validDragRequest\(request\)\)/);
 assert.match(main,/ipcMain\.on\('importer:startDrag',\(event,token:unknown,icon:unknown\)=>\{try\{trusted\(event\);\}catch\{return;\}/);
 assert.match(main,/event\.sender\.startDrag\(\{file:files\[0\]!,files,icon:image\}\)/);
 assert.match(main,/nativeImage\.createFromBitmap/,'macOS needs a drag picture: a fallback exists');
 for(const source of [worker,client,session])assert.match(source,/'companions'/,'the catalog worker serves companions');
});
test('Shift ranges and Select all check at most 500 values in a column, and the reducer never keeps more',async()=>{
 const rows=Array.from({length:600},(_,i)=>option(`camera ${i}`));
 const {filter,cut}=addWithinLimit(camera,selectionFilter(camera,['camera 0','x']),[...rows,missing]);
 assert.equal(cut,true);assert.equal(filter?.kind==='values'&&filter.values.length,maxFilterValues,'trimmed to the limit');assert.deepEqual(filter?.kind==='values'&&filter.values.slice(0,3),['camera 0','x','camera 1'],'in their order, after the checked ones');
 assert.equal(filter?.kind==='values'&&filter.orMissing,true,'Missing details adds no value and is still checked');
 assert.equal(filterSize(addBlockSelection(camera,undefined,rows)),maxFilterValues,'addBlockSelection is capped too');
 assert.deepEqual(addWithinLimit(camera,undefined,rows.slice(0,3)),{filter:selectionFilter(camera,['camera 0','camera 1','camera 2'],['camera 0','camera 1','camera 2']),cut:false});
 const format=createBlock('format'),merged={key:'format:JPEG',label:'JPEG',chip:'JPEG',values:['jpg','jpeg']};
 const nearly=selectionFilter(format,Array.from({length:maxFilterValues-1},(_,i)=>`f${i}`));
 assert.deepEqual(addWithinLimit(format,nearly,[merged,option('png')]),{filter:nearly,cut:true},'a merged row is added whole or not at all, and nothing after it');
 let s={...initialBrowserState([camera]),libraryId:library.libraryId};const before=s;
 s=browserReducer(s,{type:'select',blockId:camera.id,filter:selectionFilter(camera,rows.map(row=>row.value))});assert.equal(s,before,'a check past the limit is refused');
 s=browserReducer(s,{type:'pick',blockId:camera.id,filter:selectionFilter(camera,rows.map(row=>row.value))});assert.equal(s,before);
 s=browserReducer(s,{type:'select',blockId:camera.id,filter});
 const c=openCatalog(':memory:');await c.configure([library]);
 try{await c.query(queryFor(s));await c.facets(queryFor(s,0),'camera');}finally{await c.close();}
});

test('a click that does not fit beside 500 checked values is not kept, and a check that fills the column drops the click',()=>{
 const full=selectionFilter(camera,Array.from({length:maxFilterValues},(_,i)=>`camera ${i}`)),outside=selectionFilter(camera,['other']),inside=selectionFilter(camera,['camera 3']);
 let s={...initialBrowserState([camera]),libraryId:'l'};s=browserReducer(s,{type:'select',blockId:camera.id,filter:full});
 const before=s;s=browserReducer(s,{type:'pick',blockId:camera.id,filter:outside});assert.equal(s,before,'refused: nothing stored, no history, later columns kept');
 s=browserReducer(s,{type:'pick',blockId:camera.id,filter:inside});assert.deepEqual(s.picks[camera.id],inside,'a click among the checked rows adds nothing and is kept');
 let t={...initialBrowserState([camera]),libraryId:'l'};t=browserReducer(t,{type:'pick',blockId:camera.id,filter:outside});
 t=browserReducer(t,{type:'select',blockId:camera.id,filter:full});assert.equal(t.picks[camera.id],undefined,'the click no longer fits: it goes with the check');
 t=browserReducer(t,{type:'select',blockId:camera.id,filter:selectionFilter(camera,['a'])});assert.equal(t.picks[camera.id],undefined);
});

test('checking every file keeps the preview; clearing them lets the click go; a sort or pairing drops the click',()=>{
 let s={...initialBrowserState([]),libraryId:'l'};s=browserReducer(s,{type:'file',fileId:'a'});
 s=browserReducer(s,{type:'allFiles',select:true});assert.equal(s.selectedFile,'a','checking all never moves the preview');assert.deepEqual(s.files,{all:true,ids:[]});
 s=browserReducer(s,{type:'allFiles',select:false});assert.equal(s.selectedFile,undefined);assert.deepEqual(s.files,noFiles);
 s=browserReducer(s,{type:'file',fileId:'a'});s=browserReducer(s,{type:'toggleFile',fileId:'b'});
 const sorted=browserReducer(s,{type:'sort',sort:{field:'captured',direction:'desc'}});assert.equal(sorted.selectedFile,undefined,'the sort can move the click off the pages read');assert.deepEqual(sorted.files,s.files,'the same files: the checks stay');
 const paired=browserReducer(s,{type:'pairs',combine:false});assert.equal(paired.selectedFile,undefined);assert.deepEqual(paired.files,noFiles,'other rows shown: like a search, nothing chosen');
 assert.equal(fileSelectionCount(effectiveFiles(paired),10),0);
});

test('every file unchecked after checking them all is nothing chosen: the drag label and request both carry every file shown',()=>{
 const none={all:true,ids:['a','b']};assert.deepEqual(chosenFiles(none,2),noFiles);assert.deepEqual(chosenFiles({all:true,ids:['a']},2),{all:true,ids:['a']});assert.deepEqual(chosenFiles({all:false,ids:['a']},0),{all:false,ids:['a']});
 const request=dragRequestFor('l',query,chosenFiles(none,2),[row('a'),row('b')]);assert.ok('except' in request);assert.deepEqual(request.except,[],'every file, not every file except all of them');
 const html=render(createElement(LightroomDrag,{api:dragApi,libraryId:'l',online:true,query,rows:[row('a'),row('b')],revision:1,selection:none,total:2}));
 assert.match(html,/All 2/);assert.match(html,/draggable="true"/);
});

const paged=(pages=3)=>{
 const s={key:'A',revision:1,pages,calls:[] as string[]};const waiting:{settle:(error?:unknown)=>void}[]=[];
 const list=new PagedList<string>(cursor=>new Promise((resolve,reject)=>{const n=cursor?Number(cursor):0,key=s.key;s.calls.push(`${key}${n}`);waiting.push({settle:error=>error?reject(error):resolve({rows:[`${key}${n}a`,`${key}${n}b`],revision:s.revision,...(n+1<s.pages?{nextCursor:String(n+1)}:{})})});}));
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 /** Answers the oldest request (or fails it) and lets the list act on it. */
 const answer=async(error?:unknown)=>{await tick();const next=waiting.shift();assert.ok(next,'a request is waiting');next.settle(error);await tick();};
 const shown=()=>({rows:list.snapshot.value.rows.length,loading:list.snapshot.loading,more:!!list.snapshot.value.nextCursor,error:list.snapshot.error});
 return {s,list,answer,tick,waiting,shown};
};
const staleError=new Error('Catalog or query changed; restart pagination.');
test('a paged list never stays loading: a revision refresh while the next page loads, a stale cursor, a new query or none',async()=>{
 let p=paged();p.list.start(1);assert.equal(p.list.snapshot.loading,true);await p.answer();assert.deepEqual(p.shown(),{rows:2,loading:false,more:true,error:''});
 p.list.more();assert.equal(p.list.snapshot.loading,true);await p.tick();p.list.revise(2);p.list.revise(3);
 await p.answer();assert.deepEqual(p.shown(),{rows:4,loading:false,more:true,error:''},'the page appends; the refresh waits for it');
 await p.answer();await p.answer();assert.deepEqual(p.s.calls,['A0','A1','A0','A1'],'one refresh for both revisions, of the rows loaded');assert.equal(p.waiting.length,0);
 p.list.more();await p.answer();assert.deepEqual(p.shown(),{rows:6,loading:false,more:false,error:''},'paging goes on');
 // A cursor the index ended reads the list again.
 p=paged();p.list.start(1);await p.answer();p.list.more();await p.answer(staleError);assert.equal(p.list.snapshot.loading,false);await p.answer();assert.deepEqual(p.shown(),{rows:2,loading:false,more:true,error:''});
 // Another error waits for Retry instead of asking again.
 p.list.more();await p.answer(new Error('disk gone'));assert.deepEqual(p.shown(),{rows:2,loading:false,more:true,error:'Error: disk gone'});p.list.more();await p.tick();assert.equal(p.waiting.length,0);
 // A new query while a page loads: the old page is dropped, the list loads until the new first page arrives.
 p=paged();p.list.start(1);await p.answer();p.list.more();await p.tick();p.s.key='B';p.list.start(1);
 await p.answer();assert.deepEqual([p.list.snapshot.value.rows[0],p.list.snapshot.loading],['A0a',true],'the old query’s page is not shown');
 await p.answer();assert.deepEqual([p.list.snapshot.value.rows,p.list.snapshot.loading],[['B0a','B0b'],false]);
 // No query (no library): empty and idle, whatever was loading.
 p=paged();p.list.start(1);await p.answer();p.list.more();await p.tick();p.list.disable();assert.deepEqual(p.shown(),{rows:0,loading:false,more:false,error:''});await p.answer();assert.deepEqual(p.shown(),{rows:0,loading:false,more:false,error:''});
});

test('reading every page retries a stale cursor, waits out a refresh, and reads only the current query',async()=>{
 let p=paged();p.list.start(1);await p.answer();
 let all=p.list.readAll();await p.answer();await p.answer(staleError);for(let i=0;i<3;i++)await p.answer();
 assert.deepEqual(await all,['A0a','A0b','A1a','A1b','A2a','A2b'],'read again from the start');assert.deepEqual(p.shown(),{rows:6,loading:false,more:false,error:''});
 // A revision during the read: the read finishes, then the refresh runs.
 p=paged();p.list.start(1);await p.answer();all=p.list.readAll();await p.answer();p.s.revision=2;p.list.revise(2);await p.answer();await p.answer();
 assert.equal((await all)?.length,6);assert.equal(p.list.snapshot.loading,false);for(let i=0;i<3;i++)await p.answer();assert.equal(p.waiting.length,0);assert.equal(p.list.snapshot.value.revision,2);
 // Clicked before a new query's first page: the first page still loads, then every row of the new query.
 p=paged();p.list.start(1);await p.answer();p.s.key='B';p.list.start(1);all=p.list.readAll();
 for(let i=0;i<4;i++)await p.answer();
 assert.deepEqual(await all,['B0a','B0b','B1a','B1b','B2a','B2b']);assert.equal(p.list.snapshot.loading,false);
 p.list.revise(2);await p.tick();assert.equal(p.waiting.length,1,'later revisions still refresh the new query');await p.answer();await p.answer();await p.answer();
 // The query changes during the read: nothing comes back.
 p=paged();p.list.start(1);await p.answer();all=p.list.readAll();await p.answer();p.s.key='C';p.list.start(1);await p.answer();await p.answer();
 assert.equal(await all,undefined);assert.deepEqual([p.list.snapshot.value.rows[0],p.list.snapshot.loading],['C0a',false]);
});
