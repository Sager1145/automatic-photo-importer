import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as core from '../core/index';
import type {Metadata,Progress} from '../shared';
import {translationCatalogs} from '../renderer/i18n';
import {backendMessages} from '../messages';

// "Everything must update": each phase of reading, checking, converting and deleting organization records counts its own work.
core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
core.setConversionGate(()=>false);
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2026-10-03T12:00:00',fields:{}});
const base={backup:false,template:'{year}/{yyyymm}/{camera}',unknownRules:{}};
const camera='2026/202610/Sony A7';
const names=['C0016.MOV','C0017.MOV','A.JPG','B.JPG','D.JPG'];

async function finished(t:test.TestContext,strategy:core.OrganizationStrategy='copy'){
 const drive=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'recovery-progress-')));
 t.after(()=>fs.rm(drive,{recursive:true,force:true}));
 const photos=path.join(drive,'photobackup'),card=path.join(drive,'2025');
 for(const folder of [photos,card])await fs.mkdir(folder,{recursive:true});
 for(const name of names)await fs.writeFile(path.join(card,name),'bytes of '+name);
 const plan=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['2025']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(plan,undefined,undefined,{strategy})).errors,[]);
 const [journal]=await core.getOrganizationRecovery(photos);
 return {drive,photos,id:journal!.id};
}

test('finalize, undo and delete report reading the history before they change anything',async t=>{
 const steps=(into:string[])=>(progress:core.OrganizationProgress)=>{if(into.at(-1)!==progress.step)into.push(progress.step);};
 const a=await finished(t),finalizing:string[]=[];
 await core.finalizeOrganization(a.photos,a.id,undefined,steps(finalizing));
 assert.equal(finalizing[0],'history');assert.ok(finalizing.includes('checking')&&finalizing.includes('releasing'));
 const b=await finished(t),undoing:string[]=[];
 await core.undoOrganization(b.photos,b.id,undefined,steps(undoing));
 assert.equal(undoing[0],'history');assert.ok(undoing.includes('restoring'));
 const c=await finished(t),deleting:core.OrganizationProgress[]=[];
 await core.deleteOrganizationRecovery(c.photos,c.id,undefined,progress=>deleting.push(progress));
 assert.equal(deleting[0]!.step,'history');
 const measuring=deleting.filter(progress=>progress.step==='measuring');
 assert.ok(measuring.length>0,'the tally counts files');assert.ok(measuring.at(-1)!.completed>0);
 const removing=deleting.filter(progress=>progress.step==='deleting');
 assert.ok(removing.length>2,'files are counted as they are removed, not once at the end');
 assert.equal(removing.at(-1)!.completed,removing.at(-1)!.total);
 for(let index=1;index<removing.length;index++)assert.ok(removing[index]!.completed>=removing[index-1]!.completed);
 await assert.rejects(fs.stat(path.join(c.photos,'Photo Importer Recovery')),{code:'ENOENT'},'the recovery folder is gone');
});

test('measuring an organization counts files as it goes',async t=>{
 const {photos,id}=await finished(t);
 const counts:number[]=[];
 const size=await core.measureOrganizationRecovery(photos,id,undefined,files=>counts.push(files));
 assert.ok(counts.length>2);assert.equal(counts.at(-1),size.files);
 for(let index=1;index<counts.length;index++)assert.ok(counts[index]!>=counts[index-1]!);
});

test('a duplicates check reports which earlier journal it reads and how many records',async t=>{
 const {photos}=await finished(t);
 const updates:{journal:number;journals:number;read:number;total:number}[]=[];
 await core.placedByEarlierJournals(photos,undefined,update=>updates.push(update));
 assert.ok(updates.length>=2);
 assert.deepEqual([updates[0]!.journal,updates[0]!.journals],[1,1]);
 assert.ok(updates.at(-1)!.read>0&&updates.at(-1)!.read===updates.at(-1)!.total);
});

test('looking for the later organization that took files over counts the journals it reads',async t=>{
 // The A006 pair: B moved some of A's videos on, so A's check reads the later journals.
 const drive=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'recovery-later-')));
 t.after(()=>fs.rm(drive,{recursive:true,force:true}));
 const photos=path.join(drive,'photobackup'),videos=path.join(drive,'videobackup'),card=path.join(drive,'2025');
 for(const folder of [photos,videos,card])await fs.mkdir(folder,{recursive:true});
 for(const name of names)await fs.writeFile(path.join(card,name),'bytes of '+name);
 const a=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['2025']},metadata)).plans[0]!;
 const controller=new AbortController();
 await assert.rejects(core.executeReorganization(a,controller.signal,value=>{if(value.step==='moving'&&/\.MOV$/i.test(value.file))controller.abort();},{strategy:'rename'}),{name:'AbortError'});
 const [journal]=await core.getOrganizationRecovery(photos);const A=journal!.id;
 const store=path.join(photos,'Photo Importer Recovery',A),hidden=path.join(drive,'hidden-'+A);
 await fs.rename(store,hidden);
 const {plans:[split]}=await core.plan(drive,[photos],{...base,layout:'video-root',videoRoots:[videos],sourceFolders:['photobackup','videobackup'],reorganize:true},metadata);
 assert.deepEqual((await core.executeReorganization(split!.videos!,undefined,undefined,{strategy:'rename'})).errors,[]);
 await fs.mkdir(path.dirname(store),{recursive:true});await fs.rename(hidden,store);
 assert.ok((await fs.readdir(path.join(videos,camera))).length>0);
 const listing:{done:number;total:number}[]=[];
 await core.getOrganizationRecovery(photos,{onProgress:update=>{if(update.later)listing.push(update.later);}});
 assert.ok(listing.length>=2,'the listing reports the later journals');
 assert.equal(listing.at(-1)!.done,listing.at(-1)!.total);
 const resuming:Progress[]=[];
 await core.resumeOrganization(photos,A,undefined,progress=>{if(progress.step==='later')resuming.push(progress);});
 assert.ok(resuming.length>=2,'a resume reports them too');
 assert.equal(resuming.at(-1)!.completed,resuming.at(-1)!.total);
});

test('every new progress label and job message exists in all four languages',()=>{
 const labels=['Reading later organizations: {completed} of {total}','Reading earlier organization records: {completed} of {total}','Reading earlier organizations: journal {journal} of {journals}, records {completed} of {total}','Converting the organization record: {completed} of {total}','Removing old record files: {completed} of {total}','Measuring: {completed} files','Preparing destinations: {completed} of {total}','Comparing the backup with the drive: {completed} of {total}','Loading the destination index: {size} of {totalSize}','Reading organization history is paused while a job uses the drive. It continues afterwards.'];
 for(const label of labels)for(const catalog of Object.values(translationCatalogs))assert.ok(catalog[label],`${label} in ${Object.keys(catalog).length} entries`);
 for(const key of ['job.readingLater','job.readingEarlier','job.converting','job.cleaning','job.measuring'] as const){
  const entry=backendMessages[key];
  for(const language of ['en','zh-Hans','zh-Hant','ja'] as const)assert.ok(entry[language],`${key} ${language}`);
 }
});
