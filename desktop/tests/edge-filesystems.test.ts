import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {plan,execute,configureOrganizationRecovery} from '../core/index';
import type {Metadata} from '../shared';
import {assertCopied,diskImage,executeAll,fileSha,leftovers,put,run,temporary,tree} from './fixtures/edge';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false,template:'{year}/{camera}',layout:'format' as const,unknownRules:{}};
const darwin={skip:process.platform!=='darwin'};

test('capture dates exFAT or APFS cannot store keep the source dates instead of failing the copy',darwin,async t=>{
 const root=await temporary(t,'edge-dates-'),exfat=await diskImage(root,'32m','ExFAT','EXDATES');
 if(!exfat){t.skip('hdiutil unavailable');return;}
 const dates:Record<string,string>={'scan1975.JPG':'1975-06-01T12:00:00','scan1900.JPG':'1900-06-01T12:00:00','far2200.JPG':'2200-06-01T12:00:00','garbled9999.JPG':'9999-12-31T23:59:59','normal2024.JPG':'2024-06-01T12:00:00'};
 const source=path.join(root,'card'),sourceDate=new Date('2021-03-04T05:06:07Z');
 for(const name of Object.keys(dates)){await put(path.join(source,name),name);await fs.utimes(path.join(source,name),sourceDate,sourceDate);}
 for(const destination of [path.join(root,'apfs'),exfat]){
  await fs.mkdir(destination,{recursive:true});
  const {plans:[transfer]}=await plan(source,[destination],{...options,template:'{camera}',layout:'flat'},async file=>({camera:'Scanner',date:dates[path.basename(file)],fields:{}}));
  assert.deepEqual(await executeAll(transfer!),{copied:5,skipped:0,errors:[]},destination);
  await assertCopied(transfer!);
  for(const entry of transfer!.entries){
   const modified=(await fs.stat(entry.destination)).mtime.getTime(),capture=Date.parse(dates[path.basename(entry.source)]!);
   // Either the capture date or, where it cannot be stored, the source's own date: never the copy time.
   assert.ok(Math.abs(modified-capture)<=2000||Math.abs(modified-sourceDate.getTime())<=2000,`${destination}: ${entry.source} got ${new Date(modified).toISOString()}`);
  }
  // Dates every filesystem here can store are applied.
  assert.equal((await fs.stat(transfer!.entries.find(entry=>entry.source.endsWith('normal2024.JPG'))!.destination)).mtime.getTime(),Date.parse(dates['normal2024.JPG']!));
 }
});

test('an exFAT destination (no hard links) copies a mixed card exactly, and a second import skips everything',darwin,async t=>{
 const root=await temporary(t,'edge-exfat-'),exfat=await diskImage(root,'64m','ExFAT','EXMIX');
 if(!exfat){t.skip('hdiutil unavailable');return;}
 const source=path.join(root,'card');
 const names=['DCIM/100NIKON/DSC_0001.NEF','DCIM/100NIKON/DSC_0001.JPG','DCIM/100NIKON/DSC_0001.xmp','DCIM/100MEDIA/DJI_0002.MP4','DCIM/100MEDIA/DJI_0002.LRF','DCIM/100MEDIA/DJI_0002.SRT','Café.JPG','東京.HEIC','empty.JPG','L'.repeat(200)+'.JPG'];
 for(const [index,name] of names.entries())await put(path.join(source,name),name==='empty.JPG'?'':Buffer.alloc(100_000+index,index));
 const metadata=async():Promise<Metadata>=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00',fields:{}});
 const destination=path.join(exfat,'photobackup');await fs.mkdir(destination);
 const {plans:[transfer]}=await plan(source,[destination],options,metadata);
 assert.deepEqual(await execute(transfer!),{copied:names.length,skipped:0,errors:[]});
 await assertCopied(transfer!);assert.deepEqual(await leftovers(exfat),[]);
 const again=await plan(source,[destination],options,metadata);
 assert.ok(again.plans[0]!.entries.every(entry=>entry.skip));
 assert.deepEqual(await execute(again.plans[0]!),{copied:0,skipped:names.length,errors:[]});
 // The journaled exclusive copy path is used on APFS too when asked for.
 const apfs=path.join(root,'apfs');await fs.mkdir(apfs);
 const {plans:[exclusive]}=await plan(source,[apfs],options,metadata);
 assert.deepEqual(await execute(exclusive!,undefined,undefined,{exclusiveCopy:true}),{copied:names.length,skipped:0,errors:[]});
 await assertCopied(exclusive!);assert.deepEqual(await leftovers(apfs),[]);
});

test('a full destination reports errors, publishes nothing partial, keeps its files, and a retry finishes once there is room',darwin,async t=>{
 const root=await temporary(t,'edge-full-'),small=await diskImage(root,'8m','HFS+','EDGEFULL');
 if(!small){t.skip('hdiutil unavailable');return;}
 const source=path.join(root,'card');
 for(let index=0;index<6;index++)await put(path.join(source,`IMG_${index}.JPG`),Buffer.alloc(2*1024*1024,index+1));
 await put(path.join(small,'existing.txt'),'keep me');
 const metadata=async():Promise<Metadata>=>({camera:'Cam',date:'2024-02-03T12:00:00',fields:{}});
 const {plans:[transfer]}=await plan(source,[small],options,metadata);
 const result=await execute(transfer!);
 assert.ok(result.errors.length>0,'some files cannot fit');assert.equal(result.copied+result.errors.length,6);
 assert.equal(await fs.readFile(path.join(small,'existing.txt'),'utf8'),'keep me');
 assert.deepEqual(await leftovers(small),[]);
 // Whatever was published is complete and exact.
 for(const entry of transfer!.entries){const there=await fs.stat(entry.destination).catch(()=>undefined);if(there)assert.equal(await fileSha(entry.destination),await fileSha(entry.source));}
 // Make room on the same drive; a fresh plan copies the rest and skips what is there.
 const bigger=await diskImage(root,'32m','HFS+','EDGEROOM');assert.ok(bigger);
 await fs.unlink(path.join(small,'existing.txt'));
 for(const entry of transfer!.entries.slice(0,2))await fs.rm(entry.destination,{force:true});
 const {plans:[retry]}=await plan(source,[bigger!],options,metadata);
 assert.deepEqual(await execute(retry!),{copied:6,skipped:0,errors:[]});await assertCopied(retry!);
});

test('a read-only destination folder or volume fails cleanly without touching anything',darwin,async t=>{
 const root=await temporary(t,'edge-readonly-'),source=path.join(root,'card'),destination=path.join(root,'locked');
 await put(path.join(source,'A.JPG'),'a');await put(path.join(destination,'old.txt'),'old');
 const metadata=async():Promise<Metadata>=>({camera:'Cam',date:'2024-02-03T12:00:00',fields:{}});
 await fs.chmod(destination,0o555);
 const {plans:[transfer]}=await plan(source,[destination],options,metadata);
 const result=await execute(transfer!);
 assert.equal(result.copied,0);assert.equal(result.errors.length,1);assert.match(result.errors[0]!,/EACCES|permission/i);
 await fs.chmod(destination,0o755);
 assert.deepEqual([...(await tree(destination)).keys()],['old.txt']);
 // A volume mounted read-only.
 const mount=await diskImage(root,'8m','HFS+','EDGERO',{readOnly:true});assert.ok(mount);
 const {plans:[locked]}=await plan(source,[mount!],options,metadata);
 const readOnly=await execute(locked!);
 assert.equal(readOnly.copied,0);assert.equal(readOnly.errors.length,1);assert.match(readOnly.errors[0]!,/EROFS|read-only/i);
 assert.equal(await fs.readFile(path.join(source,'A.JPG'),'utf8'),'a');
});

test('a destination drive unplugged mid-run stops that copy and never writes to the empty mount folder left behind',darwin,async t=>{
 const root=await temporary(t,'edge-unplug-'),drive=await diskImage(root,'64m','HFS+','EDGEUNPLUG');
 if(!drive){t.skip('hdiutil unavailable');return;}
 const source=path.join(root,'card');
 for(let index=0;index<40;index++)await put(path.join(source,`IMG_${String(index).padStart(2,'0')}.JPG`),Buffer.alloc(512*1024,index+1));
 const metadata=async():Promise<Metadata>=>({camera:'Cam',date:'2024-02-03T12:00:00',fields:{}});
 const {plans:[transfer]}=await plan(source,[drive],options,metadata);
 let unplugged:Promise<unknown>|undefined;
 const outcome=await execute(transfer!,undefined,progress=>{if(!unplugged&&progress.completed>=2)unplugged=run('umount',['-f',drive]);}).then(value=>value,error=>error as Error);
 await unplugged;
 if(outcome instanceof Error)assert.match(outcome.message,/identity|ENOENT|ENXIO|EIO|not|unavailable/i);
 else {assert.ok(outcome.errors.length>0,'files after the unplug fail');assert.equal(outcome.copied+outcome.errors.length,40);}
 // The mount point is now an ordinary folder on this Mac: nothing may have been written into it.
 assert.deepEqual(await fs.readdir(drive),[]);
 for(const name of await fs.readdir(source))assert.equal((await fs.stat(path.join(source,name))).size,512*1024);
});
