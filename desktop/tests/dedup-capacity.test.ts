import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {plan,execute,configureOrganizationRecovery} from '../core/index';
import {allocateDestinations,destinationSpace} from '../core/allocation';
import {MessageError} from '../messages';
import {SourceSpace} from '../renderer/RootApp';
import {I18nProvider,languages,createTranslator,formatBytes} from '../renderer/i18n';
import type {Metadata,PlanEntry,TransferPlan} from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2024-02-03T12:00:00Z',fields:{}});

/** Three 100-byte photos on the source; A and B are already copied to the destination. */
async function mostlyImported(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'photo-dedup-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'source'),root=path.join(base,'destination');await fs.mkdir(source);await fs.mkdir(root);
 for(const name of ['A','B'])await fs.writeFile(path.join(source,name+'.JPG'),name.repeat(100));
 await execute((await plan(source,[root],options,metadata)).plans[0]!);
 await fs.writeFile(path.join(source,'C.JPG'),'C'.repeat(100));
 return {source,root,transfer:(await plan(source,[root],options,metadata)).plans[0]!};
}

test('a source larger than the free space imports when its duplicates are already on the destination',async t=>{
 const {transfer}=await mostlyImported(t),raw=transfer.entries.reduce((sum,entry)=>sum+entry.size,0);
 assert.equal(raw,300);assert.deepEqual(transfer.entries.map(entry=>entry.skip).sort(),[false,true,true]);
 // 100 new bytes plus room to publish the largest new family; the 300-byte source total plays no part.
 const free=250;assert.ok(free<raw);
 assert.deepEqual(allocateDestinations([transfer],[free],'single'),[200]);
 assert.deepEqual(destinationSpace(transfer,free),{needed:200,free,existing:200,existingFiles:2,newFiles:1});
 const result=await execute(transfer);
 assert.equal(result.copied,1);assert.equal(result.skipped,2);assert.deepEqual(result.errors,[]);
});

test('new bytes that still exceed the free space are refused before anything is written, with the sizes',async t=>{
 const {root,transfer}=await mostlyImported(t),before=await fs.readdir(root,{recursive:true});
 assert.throws(()=>allocateDestinations([transfer],[150],'single'),(error:unknown)=>{
  assert.ok(error instanceof MessageError);assert.equal(error.key,'error.destinationNeedsSpace');
  assert.deepEqual(error.params,{index:1,needed:{bytes:200},free:{bytes:150},existing:{bytes:200}});
  return true;
 });
 assert.deepEqual(await fs.readdir(root,{recursive:true}),before);
});

const entry=(source:string,size:number,skip=false):PlanEntry=>({id:source,source,destination:'/backup/'+source,size,family:source,skip,kind:'Videos',digest:'fixture'});
test('videos routed to the video root count only when new, on the same destination',()=>{
 const transfer:TransferPlan={source:'/card',root:'/backup/photos',rootIdentity:'fixture',entries:[entry('photo.jpg',10,true)],
  videos:{source:'/card',root:'/backup/videos',rootIdentity:'fixture',entries:[entry('old.mp4',1000,true),entry('new.mp4',40)]}};
 assert.deepEqual(destinationSpace(transfer,90),{needed:80,free:90,existing:1010,existingFiles:2,newFiles:1});
 assert.deepEqual(allocateDestinations([transfer],[80],'single'),[80]);
 assert.throws(()=>allocateDestinations([transfer],[79],'single'),/Destination 1 needs 80 B free/);
});

test('a conflict copy written beside a different file counts as new bytes',()=>{
 const transfer:TransferPlan={source:'/card',root:'/backup',rootIdentity:'fixture',entries:[{...entry('a.jpg',30),destination:'/backup/Conflicts/0123/a.jpg'}]};
 assert.deepEqual(destinationSpace(transfer,100),{needed:60,free:100,existing:0,existingFiles:0,newFiles:1});
});

test('a source card shows the space an import needs, leaving out what is already on the destination, in every language',()=>{
 const render=(language:typeof languages[number],existing=300e9)=>renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(SourceSpace,{space:[{needed:2e9,free:5e9,existing,existingFiles:40000,newFiles:12}]})}));
 assert.ok(render('en').includes('Needs 2.0 GB of 5.0 GB free (300.0 GB already on the destination)'),render('en'));
 for(const language of languages){
  const t=createTranslator(language),size=(value:number)=>formatBytes(value,language);
  assert.ok(render(language).includes(t('Needs {needed} of {free} free ({existing} already on the destination)',{needed:size(2e9),free:size(5e9),existing:size(300e9)})),language);
  if(language!=='en')assert.notEqual(t('Needs {needed} of {free} free'),'Needs {needed} of {free} free',language);
  assert.ok(render(language,0).includes(t('Needs {needed} of {free} free',{needed:size(2e9),free:size(5e9)})),language);
 }
});
