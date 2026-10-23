import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {plan,executeReorganization,configureOrganizationRecovery,getOrganizationRecovery,undoOrganization,resumeOrganization} from '../core/index';
import * as core from '../core/index';
import {migrateDrive,SimulatedCrash} from '../core/migrate/index';
import {registerDestinations} from '../core/app-store';
import {journalFolderFor,journalLines} from './fixtures/records';
import {toLegacy,FIXTURE_KEY} from './fixtures/legacy-records';
import type {Metadata} from '../shared';

configureOrganizationRecovery(FIXTURE_KEY);
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00Z',fields:{}});
const exists=(file:string)=>fs.lstat(file).then(()=>true,()=>false);
/** What a listing says about one journal, for comparing before and after a conversion. */
const summary=(job:Awaited<ReturnType<typeof getOrganizationRecovery>>[number]|undefined)=>job&&{status:job.status,files:job.files,completed:job.completed,retainedFiles:job.retainedFiles,retainedBytes:job.retainedBytes,finalizable:job.finalizable,undoable:job.undoable,error:job.error,converting:job.converting};
const listed=async(root:string,id:string)=>(await getOrganizationRecovery(root,{verifyContents:false,includeEnded:true})).filter(job=>job.id===id);

/** A library (inside its own folder, so other tests' folders are never its neighbours) organized by copy, so its
 * originals are kept for undo, then rewritten as the earlier version would have left it. */
async function legacyLibrary(t:test.TestContext,format:'log'|'files'|'both'='log',count=3){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'migrate-journal-')));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const root=path.join(base,'library'),incoming=path.join(root,'incoming');await fs.mkdir(incoming,{recursive:true});
 const originals=new Map<string,Buffer>();
 for(let index=0;index<count;index++){const name=`DSC_${String(index).padStart(4,'0')}.NEF`,bytes=Buffer.alloc(1500+index,index+1);originals.set(path.join(incoming,name),bytes);await fs.writeFile(path.join(incoming,name),bytes);}
 const reviewed=(await plan(root,[root],{...options,reorganize:true,sourceFolders:['incoming']},metadata)).plans[0]!;
 const result=await executeReorganization(reviewed,undefined,undefined,{strategy:'copy',keepSourceFolders:true});
 assert.deepEqual(result.errors,[]);assert.equal(result.retained,count);
 const [job]=await getOrganizationRecovery(root);
 const before=summary((await listed(root,job!.id))[0]);
 const legacy=await toLegacy(root,job!.id,{format});
 return {base,root,id:job!.id,before,legacy,originals,reviewed};
}
/** After a finished conversion: the journal is listed once, as before, from the store; the old folder is gone; undo
 * puts every original back with its bytes. */
async function converted(f:Awaited<ReturnType<typeof legacyLibrary>>){
 const jobs=await listed(f.root,f.id);
 assert.equal(jobs.length,1,'listed exactly once');
 assert.deepEqual(summary(jobs[0]),f.before,'the same status and counts as before');
 assert.equal(await exists(f.legacy),false,'the earlier version\'s folder is gone');
 assert.equal(await exists(path.join(f.root,'Photo Importer Recovery')),false);
 const folder=await journalFolderFor(f.root,f.id);
 assert.ok((await journalLines(f.root,f.id)).some(line=>line.includes('"migration-complete"')));
 const undo=await undoOrganization(f.root,f.id);
 assert.equal(undo.restored,f.originals.size);
 for(const [file,bytes] of f.originals)assert.deepEqual(await fs.readFile(file),bytes,file);
 return folder;
}

test('an earlier version\'s journal with kept originals is converted into the store, reads the same, and still undoes',async t=>{
 for(const format of ['log','files','both'] as const){
  const f=await legacyLibrary(t,format);
  assert.equal((await listed(f.root,f.id))[0]?.converting,true,'listed as being converted');
  await assert.rejects(resumeOrganization(f.root,f.id),/being converted/,'nothing but the converter uses it meanwhile');
  const result=await migrateDrive([f.root]);
  assert.deepEqual(result.problems,[],format);assert.equal(result.converted,1);assert.equal(result.pending,0);
  await converted(f);
 }
});

test('the conversion reports its steps with counters that move',async t=>{
 const f=await legacyLibrary(t,'files',6);
 const seen:{step:string;completed:number;total:number}[]=[];
 await migrateDrive([f.root],{onProgress:progress=>seen.push({...progress})});
 for(const step of ['looking','converting','originals','removing','cleanup'])assert.ok(seen.some(item=>item.step===step),step);
 const originals=seen.filter(item=>item.step==='originals');
 assert.equal(originals.at(-1)!.completed,6);assert.equal(originals.at(-1)!.total,6);
 assert.ok(seen.filter(item=>item.step==='converting').some(item=>item.completed>0&&item.total>0));
});

// Every step, stopped right after its change is durable: the next run finishes, the journal is found exactly once
// throughout, reads the same, and undo puts the originals back.
const points=['N1','N2','N3','N4','N5','N6:moved','N6:logged','N7','N8:partial','N8'];
for(const point of points)test(`a conversion stopped after ${point} is finished by the next run`,async t=>{
 const f=await legacyLibrary(t,'both');
 await assert.rejects(migrateDrive([f.root],{crash:at=>{if(at===point)throw new SimulatedCrash(at);}}),SimulatedCrash);
 assert.equal((await listed(f.root,f.id)).length,1,'found exactly once while stopped');
 for(const [file] of f.originals)assert.equal(await exists(file),false,'nothing put back by a stop');
 const result=await migrateDrive([f.root]);
 assert.deepEqual(result.problems,[]);
 await converted(f);
});

test('a conversion killed outright (SIGKILL) mid-way is finished by the next run',async t=>{
 for(const point of ['N3','N6:moved','N8:partial']){
  const f=await legacyLibrary(t,'files',4);
  const script=path.join(f.base,'kill.mts');
  await fs.writeFile(script,`import {configureOrganizationRecovery} from ${JSON.stringify(path.resolve('desktop/core/index.ts'))};
import {migrateDrive} from ${JSON.stringify(path.resolve('desktop/core/migrate/index.ts'))};
configureOrganizationRecovery(${JSON.stringify(FIXTURE_KEY)});
await migrateDrive([${JSON.stringify(f.root)}],{crash:at=>{if(at===${JSON.stringify(point)})process.kill(process.pid,'SIGKILL');}});
process.exit(3);`);
  const child=spawnSync(process.execPath,['--import','tsx',script],{encoding:'utf8',env:process.env});
  assert.equal(child.signal,'SIGKILL',`${point}: ${child.stderr}`);
  assert.equal((await listed(f.root,f.id)).length,1,point);
  assert.deepEqual((await migrateDrive([f.root])).problems,[],point);
  await converted(f);
 }
});

test('a journal another Mac sealed is left exactly as it is and reported',async t=>{
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'migrate-foreign-')));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const root=path.join(base,'library');await fs.mkdir(path.join(root,'incoming'),{recursive:true});await fs.writeFile(path.join(root,'incoming','A.NEF'),'a');
 const reviewed=(await plan(root,[root],{...options,reorganize:true,sourceFolders:['incoming']},metadata)).plans[0]!;
 await executeReorganization(reviewed,undefined,undefined,{strategy:'copy'});
 const [job]=await getOrganizationRecovery(root);
 const legacy=await toLegacy(root,job!.id,{key:'another-macs-host-recovery-secret-32b'});
 const before=await fs.readdir(legacy,{recursive:true});
 const result=await migrateDrive([root]);
 assert.ok(result.problems.some(problem=>/could not be read/.test(problem)),result.problems.join('; '));assert.ok(result.problems.some(problem=>/Kept .*Photo Importer Recovery/.test(problem)),'its folder is kept');assert.equal(result.pending,1);
 assert.deepEqual(await fs.readdir(legacy,{recursive:true}),before,'untouched');
 assert.equal((await listed(root,job!.id))[0]?.converting,true);
});

test('a store copy that is not this folder\'s own conversion stops the conversion: multiple copies',async t=>{
 const f=await legacyLibrary(t);
 // A valid, sealed journal with the same id already in the store, converted from another folder.
 const {sealedLine,storeFor}=await import('../core/app-store');await storeFor(f.root);
 const {seal:_seal,version:_version,kind,entries,...manifest}=JSON.parse(await fs.readFile(path.join(f.legacy,'manifest.json'),'utf8'));
 const store=path.join(f.root,'Photo Importer Data','Organizations',f.id);await fs.mkdir(store,{recursive:true});
 const header=sealedLine('organization',{...manifest,...(kind?{dupKind:kind}:{}),folders:[],convertedFrom:{path:path.join(f.base,'elsewhere','Photo Importer Recovery',f.id),records:0,sha256:'0'.repeat(64)}});
 await fs.writeFile(path.join(store,'journal.jsonl'),header+'\n'+sealedLine('entries',{id:f.id,entries})+'\n');
 const before=await fs.readdir(f.legacy,{recursive:true});
 const result=await migrateDrive([f.root]);
 assert.ok(result.problems.some(problem=>/more than one place/.test(problem)),result.problems.join('; '));
 assert.deepEqual(await fs.readdir(f.legacy,{recursive:true}),before,'the earlier version\'s journal and originals stay as they were');
 await assert.rejects(core.resumeOrganization(f.root,f.id),/more than one place/);
});

test('both names for one file after a stop between writing and committing the converted journal: First Aid, nothing unlinked',async t=>{
 const f=await legacyLibrary(t);
 await assert.rejects(migrateDrive([f.root],{crash:at=>{if(at==='N4')throw new SimulatedCrash(at);}}),SimulatedCrash);
 const folder=path.join(f.root,'Photo Importer Data','Organizations',f.id);
 const temporary=(await fs.readdir(folder)).find(name=>name.endsWith('.tmp'))!;
 // APFS hard link: the committed name and the temporary one are one file.
 await fs.link(path.join(folder,temporary),path.join(folder,'journal.jsonl'));
 const result=await migrateDrive([f.root]);
 assert.ok(result.problems.some(problem=>/First Aid needed/.test(problem)),result.problems.join('; '));
 assert.ok(await exists(path.join(folder,temporary)));assert.ok(await exists(path.join(folder,'journal.jsonl')));
 assert.ok(await exists(path.join(f.legacy,'manifest.json')));
});

test('a kept original changed after it was kept is left where it is and reported',async t=>{
 const f=await legacyLibrary(t);
 const [first]=await fs.readdir(path.join(f.legacy,'originals','0'));
 const original=(await fs.readdir(path.join(f.legacy,'originals','0',first!))).map(name=>path.join(f.legacy,'originals','0',first!,name))[0]!;
 await fs.appendFile(original,'changed');
 const result=await migrateDrive([f.root]);
 assert.ok(result.problems.some(problem=>/changed/.test(problem)),result.problems.join('; '));
 assert.ok(await exists(original),'left where it is');
});

test('anything unexpected in the earlier version\'s folder keeps that folder, and is reported; the journal still converts',async t=>{
 const f=await legacyLibrary(t);
 await fs.writeFile(path.join(f.legacy,'notes.txt'),'mine');
 const result=await migrateDrive([f.root]);
 assert.ok(result.problems.some(problem=>/notes\.txt/.test(problem)),result.problems.join('; '));
 assert.equal(await fs.readFile(path.join(f.legacy,'notes.txt'),'utf8'),'mine');
 assert.equal(await exists(path.join(f.legacy,'manifest.json')),false);
 const jobs=await listed(f.root,f.id);assert.equal(jobs.length,1);assert.equal(jobs[0]!.converting,undefined);
 // What is left of it no longer blocks organizing.
 await assert.doesNotReject(resumeOrganization(f.root,f.id));
});

// What converting the earlier version's own formats must keep doing (these were the event-log compaction's cases).
test('a tampered per-event record stops the conversion before anything is written; nothing is laundered into the store',async t=>{
 const f=await legacyLibrary(t,'files');
 const [event]=(await fs.readdir(f.legacy)).filter(name=>name.startsWith('event-'));
 const file=path.join(f.legacy,event!),record=JSON.parse(await fs.readFile(file,'utf8'));
 await fs.writeFile(file,JSON.stringify({...record,at:'2000-01-01T00:00:00.000Z'}));
 const before=(await fs.readdir(f.legacy,{recursive:true})).sort();
 const result=await migrateDrive([f.root]);
 assert.ok(result.problems.some(problem=>/could not be read/.test(problem)),result.problems.join('; '));
 assert.deepEqual((await fs.readdir(f.legacy,{recursive:true})).sort(),before);
 assert.equal(await exists(path.join(f.root,'Photo Importer Data','Organizations',f.id,'journal.jsonl')),false);
});

test('a per-event record cut short, and junk an interrupted write left at the end of the log, carry no event and do not stop the conversion',async t=>{
 const f=await legacyLibrary(t,'both');
 await fs.writeFile(path.join(f.legacy,'event-00000000-0000-4000-8000-000000000000.json'),'{"id":"'+f.id+'","ev');
 await fs.appendFile(path.join(f.legacy,'event-log.jsonl'),'\0'.repeat(5000));
 assert.deepEqual((await migrateDrive([f.root])).problems,[]);
 await converted(f);
});

test('a conversion committed into the library\'s store is finished there even when records now go to a destination above it',async t=>{
 const f=await legacyLibrary(t);
 await assert.rejects(migrateDrive([f.root],{crash:at=>{if(at==='N5')throw new SimulatedCrash(at);}}),SimulatedCrash);
 const committed=path.join(f.root,'Photo Importer Data','Organizations',f.id,'journal.jsonl');
 assert.ok(await exists(committed));
 // The folder above becomes a configured destination: new records would go to its store.
 registerDestinations([f.base]);t.after(()=>registerDestinations([]));
 assert.deepEqual((await migrateDrive([f.root])).problems,[]);
 assert.ok(await exists(committed),'finished where it was committed');
 assert.equal(await exists(path.join(f.base,'Photo Importer Data','Organizations',f.id)),false);
 await converted(f);
});
