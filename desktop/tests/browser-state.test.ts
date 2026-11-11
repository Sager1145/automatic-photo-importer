import test from 'node:test';
import {readCatalogPreview} from '../renderer/browser/preview';
import assert from 'node:assert/strict';
import {clampPreviewWidth,minListWidth,minPreviewWidth,previewHandleWidth,defaultConfiguration,createBlock,addBlock,moveBlock,removeBlock,updateBlock,savePreset,renamePreset,deletePreset,applyPreset,readConfiguration,writeConfiguration,fieldForBlock,numericBuckets,safeDatePattern,parseNumericInput} from '../renderer/browser/configuration';
import {initialBrowserState,browserReducer,effectiveSelections,facetSort,queryFor,rangeFrom,selectionFilter,LatestRequest,keyboardIntent,virtualWindow} from '../renderer/browser/state';
import {openCatalog} from '../catalog/store';
import {library} from './catalog-fixtures';

test('arbitrary repeated blocks retain identity and complete configuration across preset restart',()=>{
 let c=defaultConfiguration(); c={...c,blocks:[]};
 for(const kind of ['aperture','date','format','camera','aperture'] as const)c=addBlock(c,kind,c.blocks.length);
 assert.equal(new Set(c.blocks.map(b=>b.id)).size,5);
 c=updateBlock(c,c.blocks[1]!.id,{dateGranularity:'month',datePattern:'YYYY / MM'});
 c=updateBlock(c,c.blocks[2]!.id,{formatMode:'kind'});
 c=moveBlock(c,c.blocks[4]!.id,0);
 assert.deepEqual(c.blocks.map(b=>b.kind),['aperture','aperture','date','format','camera']);
 c=removeBlock(c,c.blocks[1]!.id); c=savePreset(c,'My view','saved');
 const memory=new Map<string,string>(); const storage={getItem:(k:string)=>memory.get(k)??null,setItem:(k:string,v:string)=>{memory.set(k,v);}};
 writeConfiguration(storage,c); const restarted=readConfiguration(storage);
 assert.deepEqual(restarted.blocks,c.blocks); assert.equal(restarted.presets[0]!.name,'My view');
 c=renamePreset(restarted,'saved','Renamed'); assert.equal(c.presets[0]!.name,'Renamed');
 c=applyPreset({...c,blocks:[]},'saved'); assert.equal(c.blocks.length,4);
 assert.equal(fieldForBlock(c.blocks[1]!),'captureYearMonth');assert.equal(fieldForBlock(c.blocks[2]!),'mediaKind');
 assert.equal(deletePreset(c,'saved').presets.length,0);
});
test('configuration rejects invalid stored blocks and unsafe date tokens; custom numeric buckets preserve shared boundaries',()=>{
 assert.equal(safeDatePattern('YYYY-MM-DD'),true);assert.equal(safeDatePattern('YYYY/<script>'),false);
 assert.deepEqual(readConfiguration({getItem:()=>'{broken'}).blocks.map(b=>b.kind),['date','camera','format']);
 assert.deepEqual(numericBuckets([2.8,4,8]),[{max:2.8,maxInclusive:false},{min:2.8,max:4,maxInclusive:false},{min:4,max:8,maxInclusive:false},{min:8,maxInclusive:true}]);
});
test('changing a left category clears only downstream selections and exact multi-select is OR across a block',()=>{
 let c=defaultConfiguration(); c={...c,blocks:[]};for(const k of ['camera','lens','format'] as const)c=addBlock(c,k,c.blocks.length);
 let s=initialBrowserState(c.blocks);s=browserReducer(s,{type:'library',libraryId:'lib'});
 const [camera,lens,format]=s.blocks;
 s=browserReducer(s,{type:'select',blockId:camera!.id,filter:selectionFilter(camera!,['Nikon'])});
 s=browserReducer(s,{type:'select',blockId:lens!.id,filter:selectionFilter(lens!,['24–70'])});
 s=browserReducer(s,{type:'select',blockId:format!.id,filter:selectionFilter(format!,['nef'])});
 s=browserReducer(s,{type:'select',blockId:lens!.id,filter:selectionFilter(lens!,['24–70','50'])});
 assert.deepEqual(queryFor(s).filters.map(f=>f.kind==='values'?f.values:[]),[['Nikon'],['24–70','50']]);
 assert.deepEqual(queryFor(s,1).filters.map(f=>f.blockId),[camera!.id,lens!.id]);
 const kept=s.selections;s=browserReducer(s,{type:'sort',sort:{field:'name',direction:'desc'}});s=browserReducer(s,{type:'width',width:280});assert.deepEqual(s.selections,kept);
 s=browserReducer(s,{type:'back'});assert.deepEqual(Object.keys(s.selections).length,3);s=browserReducer(s,{type:'forward'});assert.deepEqual(Object.keys(s.selections).length,2);
 s=browserReducer(s,{type:'mode',mode:'folders'});assert.deepEqual(queryFor(s).filters,[]);assert.equal(queryFor(s).parentPath,'');
});
test('repeated range and exact blocks emit independent constraints and bucket endpoints',()=>{
 let c:ReturnType<typeof defaultConfiguration>={...defaultConfiguration(),blocks:[]}; c=addBlock(c,'focal',0); c=addBlock(c,'focal',1);
 let s=browserReducer(initialBrowserState(c.blocks),{type:'library',libraryId:'l'});
 s=browserReducer(s,{type:'select',blockId:c.blocks[0]!.id,filter:{kind:'range',field:'focalLengthMm',min:24,max:70,maxInclusive:false,blockId:c.blocks[0]!.id}});
 s=browserReducer(s,{type:'select',blockId:c.blocks[1]!.id,filter:selectionFilter(c.blocks[1]!,[50])});
 assert.equal(queryFor(s,1).facetBlockId,c.blocks[1]!.id);assert.equal(queryFor(s,1).filters.length,2);assert.equal(queryFor(s).filters[0]!.kind,'range');
});
test('late requests cannot replace newer selection or preview and keyboard navigation leaves editors alone',async()=>{
 const gate=new LatestRequest(); const old=gate.begin();const current=gate.begin();assert.equal(gate.isCurrent(old),false);assert.equal(gate.isCurrent(current),true);gate.cancel();assert.equal(gate.isCurrent(current),false);
 assert.equal(keyboardIntent('ArrowDown',false,3,10),4);assert.equal(keyboardIntent('Home',false,3,10),0);assert.equal(keyboardIntent('End',false,3,10),9);assert.equal(keyboardIntent('ArrowDown',true,3,10),undefined);assert.equal(keyboardIntent('Tab',false,3,10),undefined);
 assert.deepEqual(virtualWindow(10000,440,352,44),{start:8,end:20,paddingTop:352,paddingBottom:439120});
});

test('photographic range input accepts shutter fractions and units without evaluating expressions',()=>{
 assert.equal(parseNumericInput('1/125','shutter'),.008);assert.equal(parseNumericInput('0.008s','shutter'),.008);assert.equal(parseNumericInput('2s','shutter'),2);assert.equal(parseNumericInput('f/2.8','aperture'),2.8);assert.equal(parseNumericInput('50 mm','focal'),50);assert.equal(parseNumericInput('1/0','shutter'),undefined);assert.equal(parseNumericInput('2 + 3','iso'),undefined);
});

test('placement filters stay independent of virtual hierarchy and disappear on clear',()=>{
 let s=browserReducer(initialBrowserState([]),{type:'library',libraryId:'l'});
 s=browserReducer(s,{type:'placement',status:'misplaced'});assert.deepEqual(queryFor(s).filters,[{kind:'placement',status:'misplaced'}]);
 s=browserReducer(s,{type:'mode',mode:'folders'});assert.deepEqual(queryFor(s).filters,[{kind:'placement',status:'misplaced'}]);
 s=browserReducer(s,{type:'clear'});assert.deepEqual(queryFor(s).filters,[]);
});

test('preview resolves file identity before reading media and discards responses after selection changes',async()=>{
 let resolveOld!:(value:string)=>void;const oldPath=new Promise<string>(resolve=>{resolveOld=resolve;});const calls:string[]=[];let current='old';
 const api={catalogResolve:async(_library:string,id:string)=>id==='old'?oldPath:'/authorized/new.nef',thumbnail:async(path:string)=>{calls.push('thumbnail:'+path);return {via:'none' as const};},summary:async(path:string)=>{calls.push('summary:'+path);return {fields:{},camera:'Nikon'};}};
 const old=readCatalogPreview(api,'lib','old',()=>current==='old');current='new';const fresh=await readCatalogPreview(api,'lib','new',()=>current==='new');resolveOld('/authorized/old.nef');
 assert.equal(await old,undefined);assert.equal(fresh?.metadata?.camera,'Nikon');assert.deepEqual(calls,['thumbnail:/authorized/new.nef','summary:/authorized/new.nef']);
 let valid=true;let finish!:(value:{via:'none'})=>void;const delayed=readCatalogPreview({...api,thumbnail:()=>new Promise(resolve=>{finish=resolve;})},'lib','new',()=>valid);await new Promise(resolve=>setImmediate(resolve));valid=false;finish({via:'none'});assert.equal(await delayed,undefined);
});

test('new photographic blocks and built-ins use standard-stop buckets while saved custom configurations survive restart',()=>{
 const aperture=createBlock('aperture'),iso=createBlock('iso'),shutter=createBlock('shutter');
 for(const block of [aperture,iso,shutter])assert.equal(block.numericMode,'buckets');
 assert.deepEqual(aperture.boundaries,[1,1.4,2,2.8,4,5.6,8,11,16,22,32]);assert.deepEqual(iso.boundaries,[50,100,200,400,800,1600,3200,6400,12800,25600,51200,102400]);
 assert.deepEqual(shutter.boundaries,[1/8000,1/4000,1/2000,1/1000,1/500,1/250,1/125,1/60,1/30,1/15,1/8,1/4,1/2,1,2,4,8,15,30]);
 let c=applyPreset(defaultConfiguration(),'builtin-aperture');assert.equal(c.blocks[0]!.numericMode,'buckets');
 c=updateBlock(c,c.blocks[0]!.id,{numericMode:'exact',boundaries:[1.8,3.2]});c=savePreset(c,'Custom','custom-stops');const storage={getItem:()=>JSON.stringify(c)};const restarted=readConfiguration(storage);const applied=applyPreset(restarted,'custom-stops');assert.equal(applied.blocks[0]!.numericMode,'exact');assert.deepEqual(applied.blocks[0]!.boundaries,[1.8,3.2]);
});

test('each column is narrowed by the choices in the columns before it, in any order, and choices survive reordering',()=>{
 let c=defaultConfiguration();c={...c,blocks:[]};
 for(const kind of ['date','camera','format'] as const)c=addBlock(c,kind,c.blocks.length);
 const [date,camera,format]=c.blocks as [typeof c.blocks[0],typeof c.blocks[0],typeof c.blocks[0]];
 let s=browserReducer(initialBrowserState(c.blocks),{type:'library',libraryId:'l'});
 s=browserReducer(s,{type:'select',blockId:date.id,filter:selectionFilter(date,['2020-07'])});
 s=browserReducer(s,{type:'select',blockId:camera.id,filter:selectionFilter(camera,['canon eos 5d mark iii'],['Canon EOS 5D Mark III'])});
 const fields=(depth:number)=>queryFor(s,depth).filters.flatMap(filter=>filter.kind==='placement'?[]:[filter.field]);
 assert.deepEqual(fields(2),[fieldForBlock(date),'camera'],'Format is narrowed by the date and the camera');
 assert.deepEqual(fields(1),[fieldForBlock(date),'camera'],'Camera lists within the date (its own choice is set aside by the facet query)');
 // Camera first: the same choices narrow the columns now after it.
 c=moveBlock(c,camera.id,0);s=browserReducer(s,{type:'blocks',blocks:c.blocks});
 assert.deepEqual(Object.keys(s.selections).sort(),[camera.id,date.id].sort(),'choices survive reordering');
 assert.deepEqual(queryFor(s,0).filters.map(filter=>filter.kind==='placement'?'':filter.field),['camera']);
 assert.deepEqual(fields(2).sort(),['camera',fieldForBlock(date)].sort());
 assert.equal(queryFor(s).filters.length,2,'the Files column applies every choice');
 // A block that now groups by another field drops its choice.
 c=updateBlock(c,date.id,{dateGranularity:'year',datePattern:'YYYY'});s=browserReducer(s,{type:'blocks',blocks:c.blocks});
 assert.deepEqual(Object.keys(s.selections),[camera.id]);
});

test('a pick, like a check, drops the checks and picks of the columns after it; Back and Forward bring a pick back',()=>{
 let c=defaultConfiguration();c={...c,blocks:[]};for(const k of ['camera','lens','format'] as const)c=addBlock(c,k,c.blocks.length);
 let s=browserReducer(initialBrowserState(c.blocks),{type:'library',libraryId:'l'});const [camera,lens,format]=s.blocks as [typeof c.blocks[0],typeof c.blocks[0],typeof c.blocks[0]];
 const values=()=>queryFor(s).filters.map(f=>f.kind==='values'?f.values:[]);
 s=browserReducer(s,{type:'select',blockId:camera.id,filter:selectionFilter(camera,['Nikon'])});
 s=browserReducer(s,{type:'pick',blockId:camera.id,filter:selectionFilter(camera,['Sony'])});
 s=browserReducer(s,{type:'select',blockId:lens.id,filter:selectionFilter(lens,['24–70'])});
 s=browserReducer(s,{type:'pick',blockId:lens.id,filter:selectionFilter(lens,['50'])});
 s=browserReducer(s,{type:'pick',blockId:format.id,filter:selectionFilter(format,['nef'])});
 s=browserReducer(s,{type:'file',fileId:'f'});
 assert.deepEqual(values(),[['Nikon','Sony'],['24–70','50'],['nef']]);
 assert.deepEqual(Object.keys(effectiveSelections(s)),[camera.id,lens.id,format.id]);
 // Another pick in the first column: its own check stays, the columns after it start over, and so do the files.
 s=browserReducer(s,{type:'pick',blockId:camera.id,filter:selectionFilter(camera,['Canon'])});
 assert.deepEqual(values(),[['Nikon','Canon']]);assert.deepEqual(Object.keys(s.picks),[camera.id]);assert.equal(s.selectedFile,undefined);
 s=browserReducer(s,{type:'back'});assert.deepEqual(values(),[['Nikon','Sony'],['24–70','50'],['nef']],'Back brings every pick back');
 s=browserReducer(s,{type:'back'});assert.deepEqual(values(),[['Nikon','Sony'],['24–70','50']]);
 s=browserReducer(s,{type:'forward'});s=browserReducer(s,{type:'forward'});assert.deepEqual(values(),[['Nikon','Canon']]);
 // Checking in the second column drops the third's pick, keeps its own.
 s=browserReducer(s,{type:'back'});s=browserReducer(s,{type:'select',blockId:lens.id,filter:selectionFilter(lens,['24–70','35'])});
 assert.deepEqual(values(),[['Nikon','Sony'],['24–70','35','50']]);
 // A new hierarchy keeps a pick whose block still groups by the same field.
 s=browserReducer(s,{type:'blocks',blocks:[lens,camera,format]});assert.deepEqual(Object.keys(s.picks).sort(),[camera.id,lens.id].sort());
 s=browserReducer(s,{type:'blocks',blocks:[lens,format]});assert.deepEqual(Object.keys(s.picks),[lens.id]);
 for(const action of [{type:'clear'},{type:'mode',mode:'folders'},{type:'library',libraryId:'other'}] as const){const cleared=browserReducer(s,action);assert.deepEqual([cleared.selections,cleared.picks],[{},{}],action.type);}
});
test('the layout fields: absent by default, clamped and validated on read, and kept through a write and read',()=>{
 const c=defaultConfiguration();
 for(const key of ['previewWidth','previewLarge','hideBars','hideColumns'] as const)assert.equal(c[key],undefined,`${key} starts absent (default layout, everything shown)`);
 assert.equal(clampPreviewWidth(100),minPreviewWidth,'never narrower than the minimum');
 assert.equal(clampPreviewWidth(500,1000),500);
 assert.equal(clampPreviewWidth(900,1000),1000-minListWidth-previewHandleWidth,'the list keeps its minimum');
 assert.equal(clampPreviewWidth(900,300),minPreviewWidth,'a room too small still gets the minimum preview');
 assert.equal(clampPreviewWidth(380.6),381);
 const memory=new Map<string,string>();const storage={getItem:(k:string)=>memory.get(k)??null,setItem:(k:string,v:string)=>{memory.set(k,v);}};
 writeConfiguration(storage,{...c,previewWidth:520,previewLarge:true,hideBars:true,hideColumns:false});
 const read=readConfiguration(storage);
 assert.deepEqual([read.previewWidth,read.previewLarge,read.hideBars,read.hideColumns],[520,true,true,false]);
 assert.deepEqual(read.blocks,c.blocks,'the view is unchanged');
 const odd=readConfiguration({getItem:()=>JSON.stringify({...c,previewWidth:99999,previewLarge:'yes',hideBars:1,hideColumns:null})});
 assert.equal(odd.previewWidth,clampPreviewWidth(99999),'an oversized width is clamped');
 assert.ok(!('previewLarge' in odd)&&!('hideBars' in odd)&&!('hideColumns' in odd),'invalid values are dropped, so their defaults apply');
 assert.ok(!('previewWidth' in readConfiguration({getItem:()=>JSON.stringify({...c,previewWidth:-5})})));
 assert.ok(!('previewWidth' in readConfiguration({getItem:()=>JSON.stringify({...c,previewWidth:'wide'})})));
});
test('the category columns do not query by the files’ sort, so a new sort reloads only the files; the catalog takes their query',async()=>{
 const camera=createBlock('camera');let s=browserReducer(initialBrowserState([camera]),{type:'library',libraryId:library.libraryId});
 const column=JSON.stringify(queryFor(s,0));s=browserReducer(s,{type:'sort',sort:{field:'captured',direction:'desc'}});
 assert.equal(JSON.stringify(queryFor(s,0)),column,'the column’s key is unchanged');assert.deepEqual(queryFor(s,0).sort,facetSort);assert.deepEqual(queryFor(s).sort,{field:'captured',direction:'desc'},'the files follow the sort');
 const c=openCatalog(':memory:');await c.configure([library]);
 try{await c.facets(queryFor(s,0),'camera');await c.query({...queryFor(s,0),limit:1});}finally{await c.close();}
});

test('the first library and silent corrections leave no history entry: Back never lands on no library, and Forward stays',()=>{
 const camera=createBlock('camera');let s=browserReducer(initialBrowserState([camera]),{type:'library',libraryId:'A'});
 assert.deepEqual([s.libraryId,s.past.length,s.future.length],['A',0,0],'from no library: nothing to go Back to');
 s=browserReducer(s,{type:'select',blockId:camera.id,filter:selectionFilter(camera,['Nikon'])});s=browserReducer(s,{type:'back'});s=browserReducer(s,{type:'back'});
 assert.deepEqual([s.libraryId,s.selections],['A',{}],'Back stops at the first library');
 s=browserReducer(s,{type:'forward'});s=browserReducer(s,{type:'placement',status:'misplaced'});s=browserReducer(s,{type:'library',libraryId:'B'});
 const past=s.past.length;s=browserReducer(s,{type:'placement',silent:true});
 assert.deepEqual([s.placement,s.past.length,s.future.length],[undefined,past,0],'a silent placement: applied, no entry');
 s=browserReducer(s,{type:'back'});assert.deepEqual([s.libraryId,s.placement,s.future.length],['A','misplaced',1]);
 const future=s.future;s=browserReducer(s,{type:'placement',silent:true});assert.equal(s.future,future,'a silent correction keeps Forward');assert.equal(s.placement,undefined);
 s=browserReducer(s,{type:'library',libraryId:'C',silent:true});assert.deepEqual([s.libraryId,s.past.length,s.future],['C',past-1,future]);assert.deepEqual([s.selections,s.picks],[{},{}],'a silent library clears the columns like any other');
 s=browserReducer(s,{type:'forward'});assert.equal(s.libraryId,'B');
 // A library chosen by the user is a step back, as before.
 s=browserReducer(s,{type:'library',libraryId:'D'});s=browserReducer(s,{type:'back'});assert.equal(s.libraryId,'B');
});

test('a Shift range runs from the cursor to the row, nearest the cursor first',()=>{
 const rows=['a','b','c','d','e'];
 assert.deepEqual(rangeFrom(rows,1,3),['b','c','d']);assert.deepEqual(rangeFrom(rows,3,0),['d','c','b','a'],'Shift+Home from the cursor');assert.deepEqual(rangeFrom(rows,2,4),['c','d','e'],'Shift+End through the last row');assert.deepEqual(rangeFrom(rows,2,2),['c']);
});
