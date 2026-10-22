import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {plan,execute} from '../core';

// Reintroducing per-file readback before the next source is staged must fail:
// reads/writes below use real files; instrumentation observes actual I/O order.
test('all new files finish staging before any standalone content validation reads',async t=>{
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'copy-phases-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'source'),root=path.join(base,'destination');await fs.mkdir(source);await fs.mkdir(root);
 const names=['first.bin','second.bin','third.bin'];
 for(const [index,name] of names.entries())await fs.writeFile(path.join(source,name),Buffer.alloc(2*1024*1024,index+1));
 const {plans:[transfer]}=await plan(source,[root],{backup:true,template:'{camera}',layout:'flat' as const,unknownRules:{}},async()=>({fields:{}}));
 const sourceOpens=new Map<string,number>(),stageSizes=new Map<string,number>();let readbacks=0;const prematureReads:string[]=[];
 const open=fs.open.bind(fs);
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await open(...args),file=String(args[0]);
  if(file.startsWith(source+path.sep)){
   const count=(sourceOpens.get(file)??0)+1;sourceOpens.set(file,count);
   if(count>1){readbacks++;if([...stageSizes.values()].filter(size=>size===2*1024*1024).length!==3)prematureReads.push('source:'+path.basename(file));}
  }
  if(file.startsWith(root+path.sep)&&file.endsWith('.partial')){
   if(args[1]==='wx'){
    stageSizes.set(file,0);const write=handle.write.bind(handle);
    t.mock.method(handle,'write',async(...values:Parameters<typeof handle.write>)=>{const result=await write(...values);stageSizes.set(file,(stageSizes.get(file)??0)+result.bytesWritten);return result;});
   }else{readbacks++;if([...stageSizes.values()].filter(size=>size===2*1024*1024).length!==3)prematureReads.push('stage');}
  }
  return handle;
 });syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const phases:string[]=[];
 const result=await execute(transfer,undefined,value=>{if(value.phase&&phases.at(-1)!==value.phase)phases.push(value.phase);if(value.phase==='verifying')assert.equal(value.bytes,6*1024*1024,'Verification starts only after all copy bytes');});
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.deepEqual(result,{copied:3,skipped:0,errors:[]});assert.deepEqual(prematureReads,[],'Validation rereads must wait until every source file is staged');assert.ok(readbacks>0,'Copies must still be validated');assert.deepEqual(phases,['copying','verifying']);
 for(const [index,name] of names.entries()){assert.deepEqual(await fs.readFile(path.join(root,name)),Buffer.alloc(2*1024*1024,index+1));assert.deepEqual(await fs.readFile(path.join(source,name)),Buffer.alloc(2*1024*1024,index+1));}
});

test('source cards distinguish copying from verification in every language',async()=>{
 const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
 const {ImportDesk}=await import('../renderer/RootApp'),{I18nProvider,languages}=await import('../renderer/i18n');
 const labels=[['Copying files','Verifying copied files'],['正在复制文件','正在验证已复制文件'],['正在複製檔案','正在驗證已複製檔案'],['ファイルをコピー中','コピーしたファイルを検証中']];
 for(const [index,language] of languages.entries())for(const phase of ['copying','verifying'] as const){
  const source={id:'card',name:'Card',path:'/fixture/card',transport:'storage' as const};
  const state:import('../shared').AppState={preferences:{language,appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:['/fixture/destination'],copyMode:'single',basePath:'photobackup',template:'{camera}',mediaLayout:'flat' as const,videoBasePath:'videobackup',videoTemplate:'',allowFolderSource:false,unknownRules:{}},sources:[source],jobs:[{id:'job',source,phase,detail:'',errors:[],backup:false,progress:{phase,completed:0,total:1,bytes:1,totalBytes:1,speed:0,file:'test.JPG'}}],history:[],platform:'darwin'};
  const markup=renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(ImportDesk,{state,act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}})}));
  assert.ok(markup.includes(labels[index][phase==='copying'?0:1]),`${language} ${phase} must show the actual transfer phase`);
  assert.ok(markup.includes(`aria-valuenow="${phase==='copying'?100:0}"`),'Verification progress must use checked files, not fully transferred bytes');
 }
});

test('Stop between copy and validation publishes nothing and retains every source',async t=>{
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'copy-phase-stop-')));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'source'),root=path.join(base,'destination');await fs.mkdir(source);await fs.mkdir(root);
 for(const name of ['one.bin','two.bin'])await fs.writeFile(path.join(source,name),'original '+name);
 await fs.writeFile(path.join(root,'sentinel'),'existing');
 const {plans:[transfer]}=await plan(source,[root],{backup:true,template:'{camera}',layout:'flat' as const,unknownRules:{}},async()=>({fields:{}}));
 const control=new AbortController();let copiedAll=false;
 await assert.rejects(execute(transfer,control.signal,value=>{if(value.phase==='verifying'){copiedAll=value.bytes===32;control.abort();}}),{name:'AbortError'});
 assert.ok(copiedAll);assert.deepEqual(await fs.readdir(root),['sentinel']);assert.equal(await fs.readFile(path.join(root,'sentinel'),'utf8'),'existing');
 for(const name of ['one.bin','two.bin'])assert.equal(await fs.readFile(path.join(source,name),'utf8'),'original '+name);
});
