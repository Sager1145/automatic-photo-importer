import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider} from '../renderer/i18n';
import {addBlockSelection,dragRequestFor,LightroomDrag,selectedKeys,selectionSummary,toggleBlockSelection,type BrowserAPI} from '../renderer/browser/BrowserPage';
import {addBlock,createBlock,defaultConfiguration} from '../renderer/browser/configuration';
import {browserReducer,fileSelected,fileSelectionCount,initialBrowserState,queryFor,selectionFilter} from '../renderer/browser/state';
import {openCatalog} from '../catalog/store';
import {library,record} from './catalog-fixtures';
import {buildDragPayload,collectDragFiles,MAX_DRAG_FILES,validDragRequest,type DragSource} from '../core/file-drag';
import type {CatalogPage,CatalogQuery,CatalogRecord,CatalogRow,Filter} from '../catalog/types';

const option=(value:string,label=value)=>({key:`value:string:${value}`,value,label});
const missing={key:'missing',label:'Missing details',missing:true};

test('a click selects a row and a second click deselects it; several rows stay selected in one column',()=>{
 const block=createBlock('date');
 let filter=toggleBlockSelection(block,undefined,option('2026-09'),true);
 assert.deepEqual(selectedKeys(filter),['value:string:2026-09']);
 filter=toggleBlockSelection(block,filter,option('2026-10'),true);
 assert.deepEqual(selectedKeys(filter),['value:string:2026-09','value:string:2026-10']);
 filter=toggleBlockSelection(block,filter,option('2026-09'),true);
 assert.deepEqual(selectedKeys(filter),['value:string:2026-10']);
 assert.equal(toggleBlockSelection(block,filter,option('2026-10'),true),undefined,'deselecting the last row clears the column');
 // Arrow keys and Enter select one row only.
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

test('Select all adds every row once and keeps choices from other pages; Deselect all clears the column',()=>{
 const block=createBlock('camera');
 const hidden=toggleBlockSelection(block,undefined,option('camera 201','Camera 201'),true);
 const all=addBlockSelection(block,hidden,[option('camera 1','Camera 1'),option('camera 201','Camera 201'),missing]);
 assert.deepEqual(all,{kind:'values',field:'camera',blockId:block.id,values:['camera 201','camera 1'],labels:['Camera 201','Camera 1'],orMissing:true});
 let s=initialBrowserState([block]);s={...s,libraryId:'l'};
 s=browserReducer(s,{type:'select',blockId:block.id,filter:all});assert.ok(s.selections[block.id]);
 s=browserReducer(s,{type:'select',blockId:block.id});assert.equal(s.selections[block.id],undefined);
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

test('files toggle one by one, Select all takes every file shown, and deselecting after Select all leaves the rest',()=>{
 let s={...initialBrowserState([]),libraryId:'l'};
 s=browserReducer(s,{type:'toggleFile',fileId:'a'});s=browserReducer(s,{type:'toggleFile',fileId:'b'});
 assert.deepEqual(s.files,{all:false,ids:['a','b']});assert.equal(s.selectedFile,'b','the preview shows the last file chosen');
 s=browserReducer(s,{type:'toggleFile',fileId:'b'});assert.deepEqual(s.files.ids,['a']);assert.equal(s.selectedFile,undefined);
 s=browserReducer(s,{type:'addFiles',fileIds:['c','d','a']});assert.deepEqual(s.files.ids,['a','c','d']);
 s=browserReducer(s,{type:'allFiles',select:true});assert.equal(fileSelectionCount(s.files,10),10);
 s=browserReducer(s,{type:'toggleFile',fileId:'c'});assert.equal(fileSelected(s.files,'c'),false);assert.equal(fileSelected(s.files,'a'),true);assert.equal(fileSelectionCount(s.files,10),9);
 s=browserReducer(s,{type:'preview'});assert.equal(fileSelectionCount(s.files,10),9,'closing the preview keeps the selection');
 s=browserReducer(s,{type:'file',fileId:'z'});assert.deepEqual(s.files,{all:false,ids:['z']},'arrow keys choose one file');
 s=browserReducer(s,{type:'search',value:'IMG'});assert.equal(fileSelectionCount(s.files,10),0,'a new query starts with no files chosen');
 s=browserReducer(s,{type:'allFiles',select:true});s=browserReducer(s,{type:'allFiles',select:false});assert.equal(fileSelectionCount(s.files,10),0);
});

const row=(fileId:string,pairedRaw?:string):CatalogRow=>({fileId,libraryId:'l',relativePath:`${fileId}.JPG`,parentPath:'',name:`${fileId}.JPG`,mediaKind:'JPEG',extension:'jpg',size:'1',metadataStatus:'ready',values:{metadataStatus:'ready'},placement:{status:'inPlace',actualRelativePath:`${fileId}.JPG`,rulesScope:'r'},companionCount:0,...(pairedRaw?{pairedRaw:{fileId:pairedRaw,name:`${fileId}.NEF`,extension:'nef',size:'2'}}:{})});
const query:CatalogQuery={libraryId:'l',filters:[],sort:{field:'name',direction:'asc'},limit:200,cursor:'page-2'};

test('a drag carries the chosen files with their paired RAWs, or every file shown when none are chosen',()=>{
 assert.deepEqual(dragRequestFor('l',query,{all:false,ids:['a','b']},[row('a','a-raw'),row('b')]),{libraryId:'l',fileIds:['a','a-raw','b']});
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
