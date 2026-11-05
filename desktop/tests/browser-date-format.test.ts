import test from 'node:test';
import assert from 'node:assert/strict';
import {openCatalog} from '../catalog/store';
import {library,record} from './catalog-fixtures';
import type {CatalogQuery,Filter} from '../catalog/types';
import {formatGroup} from '../media-formats';
import {addDates,buildDateTree,covers,dateState,toggleDate,visibleDateRows} from '../renderer/browser/date-tree';
import {addBlock,createBlock,dateTreeLevels,defaultConfiguration,fieldForBlock,readConfiguration,updateBlock,type HierarchyBlock} from '../renderer/browser/configuration';
import {chosenRowKeys,formatRows,selectionSummary,toggleBlockSelection} from '../renderer/browser/BrowserPage';

// The day counts of the Lightroom view this follows: November 2026, days 1-3, and one older day.
const days=[{value:'2026-11-01',count:1},{value:'2026-11-02',count:5},{value:'2026-11-03',count:382},{value:'2025-06-10',count:4}];

test('dates show as a tree of the chosen levels, each label saying only what its parents do not',()=>{
 const tree=buildDateTree(days,['year','month','day'],'en');
 assert.deepEqual(visibleDateRows(tree,new Set(['2026','2026-11'])).map(({node,depth})=>[depth,node.label,node.count]),
  [[0,'2025',4],[0,'2026',388],[1,'November',388],[2,'1 · Sunday',1],[2,'2 · Monday',5],[2,'3 · Tuesday',382]]);
 // Collapsed rows hide what is below them; a row without children has nothing to open.
 assert.deepEqual(visibleDateRows(tree,new Set()).map(row=>row.node.value),['2025','2026']);
 assert.deepEqual(visibleDateRows(tree,new Set(['2026-11'])).map(row=>row.node.value),['2025','2026']);
 // Without months, days carry their month; without years, months carry their year.
 assert.deepEqual(visibleDateRows(buildDateTree(days,['year','day'],'en'),new Set(['2026'])).slice(1).map(row=>row.node.label),['2026','Nov 1 · Sun','Nov 2 · Mon','Nov 3 · Tue']);
 assert.deepEqual(buildDateTree(days,['month','day'],'en').map(node=>node.label),['June 2025','November 2026']);
 // Each language's own month and weekday names, and a full date for the selection bar.
 const zh=buildDateTree(days,['year','month','day'],'zh-Hans')[1]!;
 assert.equal(zh.children[0]!.label,'十一月');assert.equal(zh.children[0]!.children[2]!.label,'3日 · 星期二');assert.equal(zh.children[0]!.children[2]!.chip,'2026年11月3日');
 assert.equal(buildDateTree(days,['year','month','day'],'ja')[1]!.children[0]!.children[0]!.label,'1日 · 日曜日');
});

test('choosing a row unchooses only the rows above and below it; a partly chosen row is striped, a fully chosen one full',()=>{
 const tree=buildDateTree([...days,{value:'2026-10-20',count:2}],['year','month','day'],'en');
 const year=tree[1]!,october=year.children[0]!,november=year.children[1]!,first=november.children[0]!,second=november.children[1]!;
 assert.ok(covers(['2026'],'2026-11-02')&&!covers(['2026-1'],'2026-11-02'));
 assert.deepEqual(toggleDate([],tree,year,false),['2026']);
 // A chosen year: only the year is highlighted, and all of it is chosen.
 assert.deepEqual([year,november,second].map(node=>dateState(['2026'],node)),['full','none','none']);
 // A month inside a chosen year: only that month; the year goes, the other year stays.
 let chosen=toggleDate(['2025','2026'],tree,november,true);
 assert.deepEqual(chosen.sort(),['2025','2026-11']);
 assert.deepEqual([year,october,november].map(node=>dateState(chosen,node)),['partial','none','full']);
 // Another month too: both chosen, the year now full (every month chosen).
 chosen=toggleDate(chosen,tree,october,true);
 assert.deepEqual(chosen.sort(),['2025','2026-10','2026-11']);assert.equal(dateState(chosen,year),'full');
 // A day of a chosen month: that month goes, the other month stays.
 chosen=toggleDate(chosen,tree,second,true);
 assert.deepEqual(chosen.sort(),['2025','2026-10','2026-11-02']);
 assert.deepEqual([year,november,first,second].map(node=>dateState(chosen,node)),['partial','partial','none','full']);
 // Clicking a chosen row unchooses it.
 assert.deepEqual(toggleDate(['2026'],tree,year,true),[]);
 // Choosing a month drops its days, which it now covers; a Shift range adds without duplicates.
 assert.deepEqual(toggleDate(['2026-11-01','2025'],tree,november,true).sort(),['2025','2026-11']);
 assert.deepEqual(addDates(['2026-11'],[november,second,tree[0]!]).sort(),['2025','2026-11']);
});

test('the catalog filters capture days and months by a year or month, as one value each',async()=>{
 const c=openCatalog(':memory:');await c.configure([library]);
 try{
  const shots=[['a','2025-06-10'],['b','2026-10-20'],['c','2026-11-02'],['d','2026-11-03']] as const;
  await c.apply(shots.map(([id,day])=>({kind:'upsert' as const,libraryId:library.libraryId,record:record(id,`${id}.NEF`,{values:{metadataStatus:'ready',captureDay:day,captureYear:Number(day.slice(0,4)),captureMonth:Number(day.slice(5,7))}}),mutationRevision:0})));
  const q=(filter:Filter):CatalogQuery=>({libraryId:library.libraryId,filters:[filter],sort:{field:'name',direction:'asc'},limit:20});
  const ids=async(field:'captureDay'|'captureYearMonth',values:string[])=>(await c.query(q({kind:'values',field,values}))).rows.map(row=>row.fileId);
  assert.deepEqual(await ids('captureDay',['2026']),['b','c','d']);
  assert.deepEqual(await ids('captureDay',['2026-11','2025-06-10']),['a','c','d']);
  assert.deepEqual(await ids('captureDay',['2026-11-03']),['d']);
  assert.deepEqual(await ids('captureYearMonth',['2026']),['b','c','d']);
  // Anything else is still matched exactly: "202" is no year, "2026-1" no month.
  assert.deepEqual(await ids('captureDay',['202','2026-1']),[]);
 }finally{await c.close();}
});

test('spellings of one format are one row, upper or lower case; RAW formats become one row only when asked',()=>{
 assert.deepEqual(['jpg','JPEG','Jpe','jfif'].map(ext=>formatGroup(ext)),['JPEG','JPEG','JPEG','JPEG']);
 assert.deepEqual(['tif','tiff','heic','HEIF','hif','mpg','mpeg','mts','m2ts'].map(ext=>formatGroup(ext)),['TIFF','TIFF','HEIF','HEIF','HEIF','MPEG','MPEG','MTS','MTS']);
 assert.deepEqual(['jpg','arw','png'].map(ext=>formatGroup(ext,{mergeSpellings:false})),['JPG','ARW','PNG']);
 assert.deepEqual(['arw','NEF','raf','cr3','dng','jpg'].map(ext=>formatGroup(ext,{rawAsOne:true})),['RAW','RAW','RAW','RAW','RAW','JPEG']);
 const block:HierarchyBlock={...createBlock('format')};
 const facets=[{value:'arw',count:382},{value:'jpeg',count:2},{value:'jpg',count:5},{value:'nef',count:3}];
 assert.deepEqual(formatRows(block,facets).map(row=>[row.label,row.count,row.values??row.value]),[['ARW',382,'arw'],['JPEG',7,['jpeg','jpg']],['NEF',3,'nef']]);
 assert.deepEqual(formatRows({...block,mergeSpellings:false},facets).map(row=>row.label),['ARW','JPEG','JPG','NEF']);
 assert.deepEqual(formatRows({...block,rawAsOne:true},facets).map(row=>[row.label,row.count]),[['JPEG',7],['RAW',385]]);
});

test('a merged format row is chosen and unchosen as a whole, and the selection bar names it once',()=>{
 const block=createBlock('format');const rows=formatRows(block,[{value:'jpeg',count:2},{value:'jpg',count:5},{value:'png',count:1}]);
 const jpeg=rows.find(row=>row.label==='JPEG')!,png=rows.find(row=>row.label==='PNG')!;
 const chosen=toggleBlockSelection(block,undefined,jpeg,false)!;
 assert.deepEqual(chosen.kind==='values'&&chosen.values,['jpeg','jpg']);
 assert.deepEqual(chosenRowKeys(rows,chosen),[jpeg.key]);
 assert.deepEqual(selectionSummary(block,chosen,'en','Missing details'),{text:'JPEG',count:1});
 const both=toggleBlockSelection(block,chosen,png,true)!;
 assert.deepEqual(selectionSummary(block,both,'en','Missing details'),{text:'JPEG, PNG',count:2});
 const back=toggleBlockSelection(block,both,jpeg,true)!;
 assert.deepEqual(back.kind==='values'&&back.values,['png']);
});

test('date levels: new and saved date fields are trees, one level is a flat list, and a granularity alone stays flat',()=>{
 let c=defaultConfiguration();
 const date=c.blocks.find(block=>block.kind==='date')!;
 assert.deepEqual(dateTreeLevels(date),['year','month','day']);assert.equal(fieldForBlock(date),'captureDay');
 c=updateBlock(c,date.id,{dateLevels:['year','month']});
 assert.deepEqual(dateTreeLevels(c.blocks[0]!),['year','month']);assert.equal(fieldForBlock(c.blocks[0]!),'captureYearMonth');
 c=updateBlock(c,date.id,{dateLevels:['month']});assert.deepEqual(dateTreeLevels(c.blocks[0]!),[]);assert.equal(fieldForBlock(c.blocks[0]!),'captureYearMonth');
 assert.equal(updateBlock(c,date.id,{dateLevels:[]}),c,'at least one level stays');
 c=updateBlock(c,date.id,{dateGranularity:'year'});assert.deepEqual(dateTreeLevels(c.blocks[0]!),[]);assert.equal(fieldForBlock(c.blocks[0]!),'captureYear');
 assert.deepEqual(dateTreeLevels(addBlock({...c,blocks:[]},'date',0).blocks[0]!),['year','month','day']);
 // A view saved before date trees (a month list) opens as the full tree.
 const saved={...defaultConfiguration(),blocks:[{...createBlock('date'),dateLevels:undefined}]};
 assert.deepEqual(dateTreeLevels(readConfiguration({getItem:()=>JSON.stringify(saved)}).blocks[0]!),['year','month','day']);
});
