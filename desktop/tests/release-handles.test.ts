// Once an operation ends, however it ends, the app holds nothing open on the drives it used: other programs (Lightroom,
// Explorer, Finder) can read, rename and delete the files, and the drives eject at once. Each test runs one operation
// with every open through `fs` tracked (fixtures/open-handles), then asserts none is left. The same check with the
// system's own probe (exclusive opens on Windows, lsof/proc elsewhere) is a platform feature (platform-features.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {trackOpenFiles} from './fixtures/open-handles';
import {plan,execute,executeReorganization,findMisplaced,configureOrganizationRecovery,discardPausedCopies,PausedCopies} from '../core/index';
import {executeDestinations} from '../core/destinations';
import {dropDestinationIndexes} from '../core/destination-index';
import {inventory} from '../core/inventory';
import {findResidue,findRunResidue,cleanResidue} from '../core/residue';
import {runTrace} from '../core/run-trace';
import {getOrganizationRecovery,undoOrganization} from '../core/recovery';
import {applyConflictChoices,nameOnDisk} from '../core/name-conflicts';
import {ConflictBook} from '../name-conflicts';
import {withJob} from '../logger';
import {terminateHasher} from '../core/hasher';
import {regularHandles} from '../core/paths';
import {createReadStream} from 'node:fs';
import {closeCameraBridge,prepareCamera} from '../platform/camera-bridge';
import type {Metadata,Progress} from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'ILCE-7M4',date:'2026-10-25T10:00:00',fields:{}});
const bytes=(seed:number,size:number)=>{const data=Buffer.alloc(size);for(let i=0;i<size;i+=997)data[i]=(i+seed)%251;data[0]=seed;return data;};

async function fixture(t:test.TestContext,count=4,size=300_000){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'release-handles-')));
 t.after(async()=>{dropDestinationIndexes();await terminateHasher();await fs.rm(base,{recursive:true,force:true});});
 const card=path.join(base,'card'),library=path.join(base,'photobackup'),scratch=path.join(base,'scratch');
 for(const folder of [path.join(card,'DCIM','100MSDCF'),library,scratch])await fs.mkdir(folder,{recursive:true});
 for(let index=0;index<count;index++)await fs.writeFile(path.join(card,'DCIM','100MSDCF',`DSC0000${index}.JPG`),bytes(index+1,size+index));
 return {base,card,library,scratch,tracker:trackOpenFiles(t)};
}
/** Nothing under the fixture is open any more; and the operation did open files, so the tracking saw it. */
function released(f:{base:string;tracker:ReturnType<typeof trackOpenFiles>},label:string){
 assert.ok(f.tracker.opens([f.base])>0,`${label}: the tracker saw the operation's opens`);
 assert.deepEqual(f.tracker.held([f.base]),[],`${label}: still open`);
}
/** The checks the app runs on a library after a job: Check folder layout, the leftovers check and a rescan. */
async function checks(f:{library:string;scratch:string;card:string}){
 await findMisplaced(f.library,f.library,{template:options.template,layout:options.layout},metadata);
 await findResidue([f.library],{temporary:f.scratch});
 await inventory(f.card,{});
}

test('the tracking sees a file, a stream and a folder left open, and what was closed',async t=>{
 const f=await fixture(t,1);
 const file=path.join(f.card,'DCIM','100MSDCF','DSC00000.JPG');
 const handle=await fs.open(file,'r'),folder=await fs.opendir(f.card);
 const stream=createReadStream(file);await new Promise(resolve=>stream.once('open',resolve));
 assert.deepEqual(f.tracker.held([f.base]).sort(),[`file ${file}`,`file ${file}`,`folder ${f.card}`].sort());
 // The check closed them; the stream then finds its descriptor gone.
 stream.on('error',()=>{});stream.destroy();void handle;void folder;
 await (await fs.open(file,'r')).close();
 for await(const _ of await fs.opendir(f.card)){/* Iterating to the end closes it. */}
 const read=createReadStream(file);read.resume();await new Promise(resolve=>read.once('close',resolve));
 assert.deepEqual(f.tracker.held([f.base]),[]);
});

test('opening a pair of files closes the first when the second cannot be opened',async t=>{
 const f=await fixture(t,1);
 const file=path.join(f.card,'DCIM','100MSDCF','DSC00000.JPG');
 await assert.rejects(regularHandles(file,path.join(f.card,'missing.JPG')),{code:'ENOENT'});
 released(f,'pair');
});

test('an import from a card, and the checks after it, leave nothing open',async t=>{
 const f=await fixture(t);
 const {plans:[transfer]}=await plan(f.card,[f.library],options,metadata);
 assert.deepEqual((await execute(transfer!)).errors,[]);
 released(f,'import');
 await checks(f);
 released(f,'checks');
 // Planned again: every file is already in the library (the skip-existing path).
 const {plans:[again]}=await plan(f.card,[f.library],options,metadata);
 await execute(again!);
 released(f,'second import');
});

test('a stopped import, and Clean up of what it left, leave nothing open',async t=>{
 const f=await fixture(t,6,2_000_000);
 const {plans:[transfer]}=await plan(f.card,[f.library],options,metadata);
 const stop=new AbortController();
 await withJob('release-stop',async()=>{
  await assert.rejects(execute(transfer!,stop.signal,(progress:Progress)=>{if(progress.bytes>0)stop.abort();}),(error:Error)=>error.name==='AbortError');
 });
 released(f,'stop');
 const residue=await findRunResidue({job:'release-stop',...runTrace('release-stop')!});
 await cleanResidue(residue);
 released(f,'Clean up');
});

test('an import that fails on a file that changed leaves nothing open',async t=>{
 const f=await fixture(t);
 const {plans:[transfer]}=await plan(f.card,[f.library],options,metadata);
 // The card's file changed after it was planned: its copy fails, the others go on.
 await fs.appendFile(path.join(f.card,'DCIM','100MSDCF','DSC00001.JPG'),'more');
 const result=await execute(transfer!).catch((error:Error)=>({errors:[error.message]}));
 assert.ok(result.errors.length>0,'the changed file failed');
 released(f,'failed import');
});

test('Pause, then Continue, leaves nothing open while paused or after',async t=>{
 const f=await fixture(t,6,2_000_000);
 const {plans}=await plan(f.card,[f.library],options,metadata);
 const copies=new PausedCopies();
 const run=(stopWhen?:(value:Progress)=>boolean)=>{const control=new AbortController();return executeDestinations(plans,{signal:control.signal,reorganize:false,paused:copies,validate:async()=>{},settled:()=>{},progress:(_index,value)=>{if(stopWhen?.(value))control.abort();}});};
 await assert.rejects(run(value=>value.phase==='copying'&&value.completed>=2),(error:Error)=>error.name==='AbortError');
 released(f,'paused');
 await run();
 released(f,'continued');
 await discardPausedCopies(copies);
});

test('an organization, with duplicate release or undone, leaves nothing open',async t=>{
 const f=await fixture(t,0);
 const put=async(relative:string,data:Buffer)=>{const file=path.join(f.library,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,data);};
 await put('2026/202610/ILCE-7M4/A.JPG',bytes(1,50_000));
 await put('old card/A.JPG',bytes(1,50_000));
 await put('old card/B.JPG',bytes(2,60_000));
 const organize=async(releaseDuplicates:boolean)=>{const {plans:[transfer]}=await plan(f.library,[f.library],{...options,reorganize:true},metadata);return executeReorganization(transfer!,undefined,undefined,{releaseDuplicates});};
 const result=await organize(true);
 assert.deepEqual(result.errors,[]);
 assert.equal(result.released,1);
 released(f,'organization releasing a duplicate');
 await put('old card/C.JPG',bytes(3,70_000));
 assert.deepEqual((await organize(false)).errors,[]);
 released(f,'organization');
 const undoable=(await getOrganizationRecovery(f.library)).filter(job=>job.undoable!==false);
 assert.ok(undoable.length>0,'an organization to undo');
 for(const job of undoable)await undoOrganization(f.library,job.id).catch(()=>{});
 released(f,'undo');
});

test('resolving same-name conflicts (Keep both, Overwrite) leaves nothing open',async t=>{
 const f=await fixture(t,0);
 const folder=path.join(f.library,'2026','202610','ILCE-7M4');await fs.mkdir(folder,{recursive:true});
 // The card holds photos the library already has under their names: each one is a conflict to resolve.
 await fs.writeFile(path.join(folder,'DSC00001.JPG'),bytes(1,40_000));await fs.writeFile(path.join(folder,'DSC00002.JPG'),bytes(2,40_000));
 await fs.writeFile(path.join(f.card,'DCIM','100MSDCF','DSC00001.JPG'),bytes(1,40_000));await fs.writeFile(path.join(f.card,'DCIM','100MSDCF','DSC00002.JPG'),bytes(2,40_000));
 const {plans:[transfer]}=await plan(f.card,[f.library],options,metadata);
 const book=new ConflictBook(),byId=new Map(transfer!.entries.map(entry=>[entry.id,entry]));
 await execute(transfer!,undefined,undefined,{onFileOutcome:outcome=>{book.note(outcome,byId.get(outcome.entryId),transfer!,0);}});
 for(const item of book.list())book.retarget(item.id,await nameOnDisk(item.existing));
 const [keep,overwrite]=book.list().sort((a,b)=>a.relative.localeCompare(b.relative));
 assert.ok(keep&&overwrite,'two conflicts');
 book.choose('keep',[keep.id]);book.choose('overwrite',[overwrite.id]);
 const results=await applyConflictChoices(book.take());
 assert.ok(results.every(item=>item.ok),String(results.map(item=>item.error)));
 released(f,'conflicts');
});

test('a USB camera import closes its device session when it ends, and every file it read',async t=>{
 const f=await fixture(t,0);
 // A stand-in helper: the camera's files in memory; it logs what each request opened and let go.
 const helper=path.join(f.base,'bridge.cjs'),journal=path.join(f.scratch,'bridge.log');
 await fs.writeFile(helper,`const fs=require('node:fs');const data=Buffer.alloc(120000,7);const note=text=>fs.appendFileSync(${JSON.stringify(journal)},text+'\\n');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');let input='';
process.stdin.on('data',chunk=>{input+=chunk;let at;while((at=input.indexOf('\\n'))>=0){const c=JSON.parse(input.slice(0,at));input=input.slice(at+1);
 if(c.command==='list')send({id:c.id,result:[{name:'Fixture',cameraID:'fixture'}]});
 else if(c.command==='files'){note('open fixture');send({id:c.id,result:['DSC00001.JPG','DSC00002.JPG'].map((name,index)=>({storage:'Slot 1',folder:['DCIM','100MSDCF'],name,size:data.length,modified:Date.parse('2026-10-25T10:00:00Z'),objectID:'o'+(index+1)}))});}
 else if(c.command==='read'){note('read '+c.objectID);const part=data.subarray(c.offset,c.offset+c.length);send({id:c.id,result:{bytes:part.length,data:part.toString('base64')}});}
 else if(c.command==='release'){note('release '+c.objectID);send({id:c.id,result:true});}
 else if(c.command==='close'){note('close '+c.cameraID);send({id:c.id,result:true});}
 else send({id:c.id,error:'Unknown native camera command.'});}});`);
 const prior=process.env.IMPORTER_NATIVE_BRIDGE;process.env.IMPORTER_NATIVE_BRIDGE=helper;
 t.after(async()=>{await closeCameraBridge();if(prior===undefined)delete process.env.IMPORTER_NATIVE_BRIDGE;else process.env.IMPORTER_NATIVE_BRIDGE=prior;});
 const lines=async()=>(await fs.readFile(journal,'utf8').catch(()=>'')).trim().split('\n').filter(Boolean);
 const source={id:'camera:fixture',name:'Fixture',path:'camera://fixture',transport:'camera' as const};
 for(const stopped of [false,true]){
  await fs.rm(journal,{force:true});
  const stage=await prepareCamera(source);
  try{
   const {plans:[transfer]}=await plan(stage.path,[f.library],options,metadata);
   const stop=new AbortController();
   const run=execute(transfer!,stop.signal,progress=>{if(stopped&&progress.bytes>0)stop.abort();});
   if(stopped)await run.catch(()=>{});else assert.deepEqual((await run).errors,[]);
  }finally{await stage.cleanup();}
  const log=await lines();
  assert.equal(log.at(-1),'close fixture',`${stopped?'stopped':'finished'}: the session is closed last: ${log.join(', ')}`);
  const read=new Set(log.filter(line=>line.startsWith('read ')).map(line=>line.slice(5))),freed=new Set(log.filter(line=>line.startsWith('release ')).map(line=>line.slice(8)));
  assert.ok(read.size>0,'the camera was read');
  assert.deepEqual([...read].filter(id=>!freed.has(id)),[],'every file read was released');
  released(f,stopped?'stopped camera import':'camera import');
  if(!stopped)for(const file of await fs.readdir(f.library,{recursive:true}))if(/\.JPG$/i.test(String(file)))await fs.rm(path.join(f.library,String(file)));
 }
});

test('a camera that is listed but whose import fails before it starts is closed too',async t=>{
 const f=await fixture(t,0);
 const helper=path.join(f.base,'bridge.cjs'),journal=path.join(f.scratch,'bridge.log');
 await fs.writeFile(helper,`const fs=require('node:fs');const note=text=>fs.appendFileSync(${JSON.stringify(journal)},text+'\\n');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');let input='';
process.stdin.on('data',chunk=>{input+=chunk;let at;while((at=input.indexOf('\\n'))>=0){const c=JSON.parse(input.slice(0,at));input=input.slice(at+1);
 if(c.command==='files'){note('open');send({id:c.id,result:{not:'a list'}});}
 else if(c.command==='close'){note('close');send({id:c.id,result:true});}
 else send({id:c.id,error:'Unknown native camera command.'});}});`);
 const prior=process.env.IMPORTER_NATIVE_BRIDGE;process.env.IMPORTER_NATIVE_BRIDGE=helper;
 t.after(async()=>{await closeCameraBridge();if(prior===undefined)delete process.env.IMPORTER_NATIVE_BRIDGE;else process.env.IMPORTER_NATIVE_BRIDGE=prior;});
 await assert.rejects(prepareCamera({id:'camera:fixture',name:'Fixture',path:'camera://fixture',transport:'camera'}),/invalid file list/);
 // The close is sent without waiting for the helper; give it the moment it needs to arrive.
 for(let tries=0;tries<50&&!(await fs.readFile(journal,'utf8').catch(()=>'')).includes('close');tries++)await new Promise(resolve=>setTimeout(resolve,20));
 assert.deepEqual((await fs.readFile(journal,'utf8')).trim().split('\n'),['open','close']);
});
