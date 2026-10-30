import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inventory, plan, execute} from '../core/index';
import {configureOrganizationRecovery} from '../core/index';
import {withFigures} from '../core/inventory';
configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');

test('camera imports include standalone DJI LRF videos and preserve their bytes',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dji-lrf-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'card'),destination=path.join(root,'backup');
 await fs.mkdir(source);await fs.mkdir(destination);
 const name='DJI_20260524015004_0015_D.LRF',payload=Buffer.from('DJI low-resolution video fixture');
 await fs.writeFile(path.join(source,name),payload);
 await fs.writeFile(path.join(source,'NIKON001.DSC'),'service index');
 const scan=await inventory(source,{});
 assert.equal(scan.media,1);
 assert.equal(scan.files.find(file=>file.relative===name)?.kind,'Videos');
 assert.equal(scan.files.find(file=>file.relative===name)?.included,true);
 const prepared=await plan(source,[destination],{backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{}},async()=>({camera:'DJI Osmo Pocket 3',date:'2026-05-24T01:50:04+08:00',fields:{}}));
 assert.equal(prepared.plans[0].entries.length,1);
 assert.equal(path.relative(destination,prepared.plans[0].entries[0].destination),'2026/202605/DJI Osmo Pocket 3/LRF/'+name);
 assert.deepEqual(await execute(prepared.plans[0]),{copied:1,skipped:0,errors:[]});
 assert.deepEqual(await fs.readFile(prepared.plans[0].entries[0].destination),payload);
 assert.deepEqual(await fs.readFile(path.join(source,name)),payload);
 assert.equal((await inventory(source,{unknownRules:{lrf:null}})).files.find(file=>file.relative===name)?.included,true);
});

test('paired DJI LRF inherits its original video routing without matching other directories',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dji-lrf-pair-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'card'),destination=path.join(root,'backup');
 await fs.mkdir(source);await fs.mkdir(destination);
 for(const folder of ['paired','standalone','ambiguous'])await fs.mkdir(path.join(source,folder));
 for(const name of ['paired/DJI_001.MP4','paired/DJI_001.lRf','paired/DJI_001.SRT','standalone/DJI_001.LRF','ambiguous/DJI_002.LRF','ambiguous/DJI_002.MP4','ambiguous/DJI_002.MOV'])await fs.writeFile(path.join(source,name),'bytes '+name);
 const scan=await inventory(source,{});
 assert.equal(scan.files.find(file=>file.relative==='paired/DJI_001.lRf')?.companionOf,path.join(source,'paired/DJI_001.MP4'));
 assert.equal(scan.files.find(file=>file.relative==='standalone/DJI_001.LRF')?.companionOf,undefined);
 assert.equal(scan.files.find(file=>file.relative==='ambiguous/DJI_002.LRF')?.companionOf,undefined);
 assert.equal(scan.files.find(file=>file.relative==='paired/DJI_001.SRT')?.companionOf,path.join(source,'paired/DJI_001.MP4'));
 assert.equal(scan.files.find(file=>file.relative==='paired/DJI_001.SRT')?.included,true);
 const prepared=await plan(source,[destination],{backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{}},async file=>file.endsWith('.MP4')?{camera:'DJI Osmo Pocket 3',date:'2026-05-24T01:50:04+08:00',fields:{}}:{fields:{}});
 const entries=prepared.plans[0].entries;
 const original=entries.find(entry=>entry.source.endsWith('paired/DJI_001.MP4'))!;
 const proxy=entries.find(entry=>entry.source.endsWith('paired/DJI_001.lRf'))!;
 assert.equal(path.dirname(proxy.destination),path.dirname(original.destination));
 assert.equal(proxy.family,original.family);
 assert.equal(proxy.captureTimeMs,original.captureTimeMs);
 assert.equal(path.basename(proxy.destination),'DJI_001.lRf');
});

test('DJI proxy videos remain visible in scanned format summaries when paired',async()=>{
 const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
 const {CapacityBar}=await import('../renderer/RootApp');
 const {I18nProvider}=await import('../renderer/i18n');
 const markup=renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(CapacityBar,{total:1000,free:500,inventory:withFigures({files:[{path:'/card/DJI_001.LRF',relative:'DJI_001.LRF',kind:'Videos',size:100,included:true,companionOf:'/card/DJI_001.MP4'}],media:1,companions:1,unknown:0,bytes:100,unknownExtensions:{},elapsedMs:0})})}));
 assert.ok(markup.includes('LRF'),'An actual proxy video must have its own format segment');
});
