import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import * as core from '../core/index';
import {journalFolderFor,journalFileFor,editJournalLine} from './fixtures/records';

async function singlePlan(source:string,root:string,...args:Parameters<typeof core.plan> extends [string,string[],...infer Rest]?Rest:never){return (await core.plan(source,[root],...args)).plans[0]!;}
core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{},reorganize:true};
const metadata=async()=>({camera:'Sony',date:'2024-02-03',fields:{}});
async function fixture(t:test.TestContext) {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'organization-recovery-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const original=path.join(root,'incoming/A.JPG');await fs.mkdir(path.dirname(original));await fs.writeFile(original,'precious original');
 return {root,original};
}
async function retained(root:string,id:string,index=0):Promise<string> {
 const folder=path.join(await journalFolderFor(root,id),'originals',String(index));
 for(const slot of await fs.readdir(folder)){const contents=await fs.readdir(path.join(folder,slot));if(contents.length)return path.join(folder,slot,contents[0]!);}
 throw new Error('Retained original missing');
}
test('organization retains original bytes in durable recovery storage and excludes them from scans',async t=>{
 const {root,original}=await fixture(t);const p=await singlePlan(root,root,options,metadata);
 const r=await core.executeReorganization(p);assert.equal(r.moved,1);
 assert.equal(typeof core.getOrganizationRecovery,'function');
 const jobs=await core.getOrganizationRecovery(root);assert.equal(jobs.length,1);assert.equal(jobs[0]!.status,'complete');
 const saved=await retained(root,jobs[0]!.id);
 assert.equal(await fs.readFile(saved,'utf8'),'precious original');await assert.rejects(fs.stat(original));
 assert.equal((await core.inventory(root,{backup:true})).files.length,1);
 assert.equal((await core.resumeOrganization(root,jobs[0]!.id)).moved,1);
});
test('organization can move folders into a newly selected descendant base folder',async t=>{
 const {root,original}=await fixture(t);const destination=path.join(root,'newbase');await fs.mkdir(destination);
 const p=await singlePlan(root,destination,options,metadata);assert.equal((await core.executeReorganization(p)).moved,1);
 assert.equal(await fs.readFile(p.entries[0]!.destination,'utf8'),'precious original');await assert.rejects(fs.stat(original));
});

async function crash(t:test.TestContext,when:'publish'|'stash'|'copy') {
 const f=await fixture(t);const script=path.join(f.root,'crash.mjs');
 const module=path.resolve('desktop/core/index.ts');
 await fs.writeFile(script,`import filesystem from 'node:fs/promises';
 import {plan,executeReorganization,configureOrganizationRecovery} from ${JSON.stringify(module)};
 configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
 const original=${JSON.stringify(f.original)},root=${JSON.stringify(f.root)};
 const originalRename=filesystem.rename,originalLink=filesystem.link;
 filesystem.rename=async(...args)=>{const r=await originalRename(...args);if(args[0]===original&&${JSON.stringify(when)}==='stash')process.exit(91);return r;};
 filesystem.link=async(...args)=>{if(${JSON.stringify(when)}==='copy')throw Object.assign(new Error('links unsupported'),{code:'ENOTSUP'});const r=await originalLink(...args);if(!String(args[1]).includes('Photo Importer Data')&&${JSON.stringify(when)}==='publish')process.exit(91);return r;};
 const originalOpen=filesystem.open;filesystem.open=async(...args)=>{const h=await originalOpen(...args);if(${JSON.stringify(when)}==='copy'&&String(args[0]).endsWith('/2024/202402/Sony/JPEG/A.JPG')){const write=h.write.bind(h);h.write=async(...writeArgs)=>{await write(writeArgs[0],writeArgs[1],Math.min(4,writeArgs[2]),writeArgs[3]);process.exit(91);};}return h;};
 const {plans:[p]}=await plan(root,[root],${JSON.stringify(options)},async()=>({camera:'Sony',date:'2024-02-03',fields:{}}));
 await executeReorganization(p);process.exit(0);`);
 const child=spawnSync(process.execPath,['--import','tsx',script],{cwd:process.cwd(),encoding:'utf8'});
 assert.equal(child.status,91,child.stderr);await fs.unlink(script);
 const jobs=await core.getOrganizationRecovery(f.root);assert.equal(jobs.length,1);assert.equal(jobs[0]!.status,'pending');
 return {...f,id:jobs[0]!.id,destination:path.join(f.root,'2024/202402/Sony/JPEG/A.JPG')};
}
for(const when of ['publish','stash'] as const)test(`fresh process resumes abrupt exit after ${when} without losing originals`,async t=>{
 const f=await crash(t,when);const r=await core.resumeOrganization(f.root,f.id);assert.deepEqual(r.errors,[]);assert.equal(r.moved,1);
 assert.equal(await fs.readFile(f.destination,'utf8'),'precious original');
 assert.equal(await fs.readFile(await retained(f.root,f.id),'utf8'),'precious original');
 assert.equal((await core.getOrganizationRecovery(f.root))[0]!.status,'complete');
});
test('recovery refuses a changed source and keeps it at its original path',async t=>{
 const f=await crash(t,'publish');await fs.writeFile(f.original,'user changed original');
 const r=await core.resumeOrganization(f.root,f.id);assert.ok(r.errors.length);assert.equal(r.moved,0);
 assert.equal(await fs.readFile(f.original,'utf8'),'user changed original');
});
test('recovery keeps corrupt published data and original bytes without overwriting either',async t=>{
 const f=await crash(t,'publish');await fs.writeFile(f.destination,'foreign changed target');
 const r=await core.resumeOrganization(f.root,f.id);assert.ok(r.errors.length);assert.equal(r.moved,0);
 assert.equal(await fs.readFile(f.destination,'utf8'),'foreign changed target');assert.equal(await fs.readFile(f.original,'utf8'),'precious original');
});
test('recovery rejects symbolic recovery directories and traversal identifiers',async t=>{
 const {root}=await fixture(t);const outside=await fs.mkdtemp(path.join(os.tmpdir(),'recovery-outside-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));
 await fs.symlink(outside,path.join(root,'Photo Importer Data'),'dir');
 // A linked records folder is never read, and never written to.
 assert.deepEqual(await core.getOrganizationRecovery(root),[]);
 await assert.rejects(core.executeReorganization(await singlePlan(root,root,options,metadata)),/unsafe/i);
 await assert.rejects(core.resumeOrganization(root,'../escape'),/invalid|unsafe/i);assert.deepEqual(await fs.readdir(outside),[]);
});

test('cancellation after the first relocation retains every original and a later recheck finishes',async t=>{
 const {root,original}=await fixture(t);const second=path.join(root,'incoming/B.JPG');await fs.writeFile(second,'second precious original');
 const p=await singlePlan(root,root,options,metadata),controller=new AbortController();
 const filesystem=(await import('node:fs/promises')).default,rename=filesystem.rename;
 t.mock.method(filesystem,'rename',async(from:string,to:string)=>{await rename(from,to);if(from===original)controller.abort();});
 await assert.rejects(core.executeReorganization(p,controller.signal),{name:'AbortError'});t.mock.restoreAll();
 const [job]=await core.getOrganizationRecovery(root);assert.ok(job);assert.equal(job.status,'pending');
 assert.equal(await fs.readFile(await retained(root,job.id),'utf8'),'precious original');
 assert.equal(await fs.readFile(second,'utf8'),'second precious original');
 const result=await core.resumeOrganization(root,job.id);assert.deepEqual(result.errors,[]);assert.equal(result.moved,2);
});
test('hostile journal traversal and symbolic saved-original paths cannot redirect recovery',async t=>{
 const f=await crash(t,'publish'),journal=await journalFileFor(f.root,f.id);
 const text=await fs.readFile(journal,'utf8');await editJournalLine(f.root,f.id,1,entries=>{entries.entries[0].source=path.join(f.root,'../outside.JPG');return entries;});
 await assert.rejects(core.resumeOrganization(f.root,f.id),/unsafe|invalid|authentication/i);
 assert.equal(await fs.readFile(f.original,'utf8'),'precious original');
 await fs.writeFile(journal,text);const saved=path.join(await journalFolderFor(f.root,f.id),'originals');await fs.symlink(path.dirname(f.original),saved,'dir');
 const result=await core.resumeOrganization(f.root,f.id);assert.ok(result.errors.length);assert.equal(await fs.readFile(f.original,'utf8'),'precious original');
});
test('an absent recovery root returns no jobs and creates no directories',async t=>{
 const {root}=await fixture(t),missing=path.join(root,'absent');assert.deepEqual(await core.getOrganizationRecovery(missing),[]);await assert.rejects(fs.stat(missing));
});
test('a replaced source parent is rejected even when the reviewed file is moved into it',async t=>{
 const f=await crash(t,'publish');const parent=path.dirname(f.original);await fs.rename(parent,parent+'-old');await fs.mkdir(parent);await fs.rename(path.join(parent+'-old','A.JPG'),f.original);
 const r=await core.resumeOrganization(f.root,f.id);assert.ok(r.errors.length);assert.equal(r.moved,0);assert.equal(await fs.readFile(f.original,'utf8'),'precious original');
});
test('unsupported directory synchronization prevents relocation and retains originals',async t=>{
 const {root,original}=await fixture(t);const p=await singlePlan(root,root,options,metadata);
 const filesystem=(await import('node:fs/promises')).default,open=filesystem.open;
 t.mock.method(filesystem,'open',async(...args:Parameters<typeof open>)=>{const handle=await open(...args);if((await handle.stat()).isDirectory())handle.sync=async()=>{throw Object.assign(new Error('Directory sync unsupported'),{code:'ENOTSUP'});};return handle;});
 await assert.rejects(core.executeReorganization(p),/unsupported/);assert.equal(await fs.readFile(original,'utf8'),'precious original');
});

test('fresh process resumes an interrupted exclusive publication while retaining the incomplete target',async t=>{
 const f=await crash(t,'copy');const result=await core.resumeOrganization(f.root,f.id);assert.deepEqual(result.errors,[]);assert.equal(result.moved,1);
 assert.equal(await fs.readFile(f.destination,'utf8'),'precious original');
 const job=await journalFolderFor(f.root,f.id);const failed=await fs.readdir(job);assert.ok(failed.some(name=>name.startsWith('incomplete-')));
 assert.equal(await fs.readFile(await retained(f.root,f.id),'utf8'),'precious original');
});

test('a forged valid journal cannot authorize moving another file',async t=>{
 const f=await crash(t,'publish');
 const foreign=path.join(f.root,'incoming/foreign.JPG');await fs.writeFile(foreign,'precious original');const stat=await fs.lstat(foreign,{bigint:true});
 await editJournalLine(f.root,f.id,1,entries=>{entries.entries[0].source=foreign;entries.entries[0].stat={dev:String(stat.dev),ino:String(stat.ino),size:String(stat.size),mtime:String(stat.mtimeNs),ctime:String(stat.ctimeNs)};return entries;});
 await assert.rejects(core.resumeOrganization(f.root,f.id),/authentication/i);
 assert.equal(await fs.readFile(foreign,'utf8'),'precious original');assert.equal(await fs.readFile(f.original,'utf8'),'precious original');
 assert.match((await core.getOrganizationRecovery(f.root))[0]!.error!,/authentication/i);
});

test('rechecking a completed operation restores a missing destination from retained originals',async t=>{
 const {root}=await fixture(t);const p=await singlePlan(root,root,options,metadata);await core.executeReorganization(p);
 const [job]=await core.getOrganizationRecovery(root);await fs.unlink(p.entries[0]!.destination);
 assert.equal((await core.getOrganizationRecovery(root))[0]!.status,'pending');
 const result=await core.resumeOrganization(root,job!.id);assert.deepEqual(result.errors,[]);assert.equal(result.copied,1);assert.equal(result.moved,1);
 assert.equal(await fs.readFile(p.entries[0]!.destination,'utf8'),'precious original');
 assert.equal(await fs.readFile(await retained(root,job!.id),'utf8'),'precious original');
});
test('exclusive-copy recovery refuses an altered incomplete destination',async t=>{
 const f=await crash(t,'copy');await fs.writeFile(f.destination,'foreign');
 const result=await core.resumeOrganization(f.root,f.id);assert.ok(result.errors.length);assert.equal(result.moved,0);
 assert.equal(await fs.readFile(f.destination,'utf8'),'foreign');assert.equal(await fs.readFile(f.original,'utf8'),'precious original');
});

test('a colliding exclusive stash slot preserves the competing bytes and original',async t=>{
 const {root,original}=await fixture(t),p=await singlePlan(root,root,options,metadata);
 const filesystem=(await import('node:fs/promises')).default,mkdir=filesystem.mkdir;let competitor:string|undefined;
 t.mock.method(filesystem,'mkdir',async(...args:Parameters<typeof mkdir>)=>{
  const folder=String(args[0]);if(path.basename(path.dirname(folder))==='0'&&path.basename(path.dirname(path.dirname(folder)))==='originals') {
   await mkdir(...args);competitor=path.join(folder,'A.JPG');await fs.writeFile(competitor,'competing retained original');throw Object.assign(new Error('Slot already exists'),{code:'EEXIST'});
  }return mkdir(...args);
 });
 const result=await core.executeReorganization(p);assert.ok(result.errors.length);assert.equal(result.moved,0);assert.ok(competitor);
 assert.equal(await fs.readFile(competitor,'utf8'),'competing retained original');assert.equal(await fs.readFile(original,'utf8'),'precious original');
});
test('a live review cannot be changed to authorize a broader source root',async t=>{
 const {root,original}=await fixture(t),p=await singlePlan(root,root,options,metadata);p.source=path.dirname(root);
 await assert.rejects(core.executeReorganization(p),/review|unchanged/i);assert.equal(await fs.readFile(original,'utf8'),'precious original');
});

test('cached recovery listing reads no media bytes while an explicit recheck detects corruption',async t=>{
 const {root}=await fixture(t),p=await singlePlan(root,root,options,metadata);await core.executeReorganization(p);
 const [job]=await core.getOrganizationRecovery(root),saved=await retained(root,job!.id),destination=p.entries[0]!.destination;
 await fs.writeFile(destination,'different content'); // Same length as the reviewed original.
 const filesystem=(await import('node:fs/promises')).default,open=filesystem.open;
 t.mock.method(filesystem,'open',async(...args:Parameters<typeof open>)=>{
  const handle=await open(...args);if(String(args[0])===saved||String(args[0])===destination)handle.read=async()=>{throw new Error('Cached listing read media bytes');};return handle;
 });
 const cached=await core.getOrganizationRecovery(root,{verifyContents:false});assert.equal(cached[0]!.status,'complete');assert.equal(cached[0]!.error,undefined);
 t.mock.restoreAll();const result=await core.resumeOrganization(root,job!.id);assert.ok(result.errors.length);
 assert.equal(await fs.readFile(saved,'utf8'),'precious original');assert.equal(await fs.readFile(destination,'utf8'),'different content');
 assert.equal((await core.getOrganizationRecovery(root))[0]!.status,'pending');
});

test('explicit finalization removes only retained duplicates and preserves journal rechecks',async t=>{
 const {root,original}=await fixture(t),existing=path.join(root,'2024/202402/Sony/JPEG/B.JPG');
 await fs.mkdir(path.dirname(existing),{recursive:true});await fs.writeFile(existing,'already organized original');
 const p=await singlePlan(root,root,options,metadata);assert.deepEqual((await core.executeReorganization(p)).errors,[]);
 const [job]=await core.getOrganizationRecovery(root),saved=await retained(root,job!.id,p.entries.findIndex(entry=>entry.source===original));
 const result=await core.finalizeOrganization(root,job!.id);assert.equal(result.removed,1);assert.equal(result.bytes,Buffer.byteLength('precious original'));
 await assert.rejects(fs.stat(saved));assert.equal(await fs.readFile(existing,'utf8'),'already organized original');
 assert.equal((await core.getOrganizationRecovery(root))[0]!.status,'complete');
 assert.deepEqual((await core.resumeOrganization(root,job!.id)).errors,[]);
 assert.equal((await core.finalizeOrganization(root,job!.id)).removed,0);
});

for(const fault of ['missing','corrupt','symlink','source reappeared'] as const)test(`finalization preserves retained originals when ${fault}`,async t=>{
 const {root,original}=await fixture(t),p=await singlePlan(root,root,options,metadata);await core.executeReorganization(p);
 const [job]=await core.getOrganizationRecovery(root),saved=await retained(root,job!.id),destination=p.entries[0]!.destination;
 if(fault==='missing')await fs.unlink(destination);
 else if(fault==='corrupt')await fs.writeFile(destination,'changed target');
 else if(fault==='symlink'){await fs.rename(destination,destination+'.kept');await fs.symlink(destination+'.kept',destination);}
 else {await fs.mkdir(path.dirname(original),{recursive:true});await fs.writeFile(original,'new user file');}
 await assert.rejects(core.finalizeOrganization(root,job!.id));assert.equal(await fs.readFile(saved,'utf8'),'precious original');
});

test('finalization requires a fully completed journal',async t=>{
 const f=await crash(t,'publish');await assert.rejects(core.finalizeOrganization(f.root,f.id),/Finish|complete/i);
 assert.equal(await fs.readFile(f.original,'utf8'),'precious original');
});

for(const when of ['intent','unlink'] as const)test(`finalization resumes a fresh process exit after ${when}`,async t=>{
 const {root}=await fixture(t),p=await singlePlan(root,root,options,metadata);await core.executeReorganization(p);
 const [job]=await core.getOrganizationRecovery(root),saved=await retained(root,job!.id),script=path.join(root,'finalize-crash.mjs');
 await fs.writeFile(script,`import filesystem from 'node:fs/promises';
 import {configureOrganizationRecovery,finalizeOrganization} from ${JSON.stringify(path.resolve('desktop/core/index.ts'))};
 configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
 const unlink=filesystem.unlink;filesystem.unlink=async(...args)=>{if(String(args[0])===${JSON.stringify(saved)}){if(${JSON.stringify(when)}==='intent')process.exit(92);const result=await unlink(...args);process.exit(92);return result;}return unlink(...args);};
 await finalizeOrganization(${JSON.stringify(root)},${JSON.stringify(job!.id)});process.exit(0);`);
 const child=spawnSync(process.execPath,['--import','tsx',script],{cwd:process.cwd(),encoding:'utf8'});assert.equal(child.status,92,child.stderr);await fs.unlink(script);
 assert.equal((await core.getOrganizationRecovery(root))[0]!.status,'complete');
 const finalized=await core.finalizeOrganization(root,job!.id);assert.equal(finalized.removed,when==='intent'?1:0);
 await assert.rejects(fs.stat(saved));assert.equal(await fs.readFile(p.entries[0]!.destination,'utf8'),'precious original');
 assert.deepEqual((await core.resumeOrganization(root,job!.id)).errors,[]);
});

test('a released original is never recreated or silently accepted after its target disappears',async t=>{
 const {root}=await fixture(t),p=await singlePlan(root,root,options,metadata);await core.executeReorganization(p);
 const [job]=await core.getOrganizationRecovery(root);await core.finalizeOrganization(root,job!.id);await fs.unlink(p.entries[0]!.destination);
 assert.equal((await core.getOrganizationRecovery(root))[0]!.status,'pending');
 assert.ok((await core.resumeOrganization(root,job!.id)).errors.length);
 await assert.rejects(core.finalizeOrganization(root,job!.id));
});

test('finalization validates the whole journal before deleting the first retained original',async t=>{
 const {root}=await fixture(t);await fs.writeFile(path.join(root,'incoming/B.JPG'),'second precious original');
 const p=await singlePlan(root,root,options,metadata);await core.executeReorganization(p);
 const [job]=await core.getOrganizationRecovery(root),first=await retained(root,job!.id,0),second=await retained(root,job!.id,1);
 await fs.writeFile(p.entries[1]!.destination,'invalid second target');await assert.rejects(core.finalizeOrganization(root,job!.id));
 assert.equal(await fs.readFile(first,'utf8'),'precious original');assert.equal(await fs.readFile(second,'utf8'),'second precious original');
});


test('finalizing relocated duplicates releases the retained copy while preserving the existing target',async t=>{
 const {root,original}=await fixture(t),destination=path.join(root,'2024/202402/Sony/JPEG/A.JPG');
 await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,'precious original');
 const p=await singlePlan(root,root,options,metadata);assert.deepEqual((await core.executeReorganization(p)).errors,[]);
 const [job]=await core.getOrganizationRecovery(root);const result=await core.finalizeOrganization(root,job!.id);
 // The existing target is already in place, so the journal holds only the relocated duplicate.
 assert.equal(result.removed,1);assert.equal(result.finalized,1);await assert.rejects(fs.stat(original),{code:'ENOENT'});
 assert.equal((await core.getOrganizationRecovery(root))[0]!.status,'complete');
 assert.deepEqual((await core.resumeOrganization(root,job!.id)).errors,[]);assert.equal((await core.finalizeOrganization(root,job!.id)).removed,0);
 assert.equal(await fs.readFile(destination,'utf8'),'precious original');
});


test('fully finalized entries ignore obsolete source directories and preserve reused source paths',async t=>{
 const {root,original}=await fixture(t),p=await singlePlan(root,root,options,metadata);await core.executeReorganization(p);
 const [job]=await core.getOrganizationRecovery(root);await core.finalizeOrganization(root,job!.id);
 await assert.rejects(fs.stat(path.dirname(original)),{code:'ENOENT'});
 assert.equal((await core.getOrganizationRecovery(root))[0]!.status,'complete');
 assert.deepEqual((await core.resumeOrganization(root,job!.id)).errors,[]);
 assert.equal((await core.finalizeOrganization(root,job!.id)).removed,0);
 await fs.mkdir(path.dirname(original));await fs.writeFile(original,'new unrelated user photo');
 assert.equal((await core.getOrganizationRecovery(root))[0]!.status,'complete');
 assert.deepEqual((await core.resumeOrganization(root,job!.id)).errors,[]);
 assert.equal((await core.finalizeOrganization(root,job!.id)).removed,0);
 assert.equal(await fs.readFile(original,'utf8'),'new unrelated user photo');
 assert.equal(await fs.readFile(p.entries[0]!.destination,'utf8'),'precious original');
 // Releasing the original never weakens validation of the remaining target.
 await fs.writeFile(p.entries[0]!.destination,'different content');
 assert.equal((await core.getOrganizationRecovery(root))[0]!.status,'pending');
 assert.ok((await core.resumeOrganization(root,job!.id)).errors.length);
 await assert.rejects(core.finalizeOrganization(root,job!.id));
 assert.equal(await fs.readFile(original,'utf8'),'new unrelated user photo');
});

test('a second entry interrupted during exclusive publication resumes using its own journal index',async t=>{
 const {root,original}=await fixture(t),second=path.join(root,'incoming/B.JPG');await fs.writeFile(second,'second precious original');
 const p=await singlePlan(root,root,options,metadata),target=p.entries.find(entry=>entry.source===second)!.destination;
 const filesystem=(await import('node:fs/promises')).default,open=filesystem.open;
 t.mock.method(filesystem,'link',async()=>{throw Object.assign(new Error('No hard links'),{code:'ENOTSUP'});});
 t.mock.method(filesystem,'open',async(...args:Parameters<typeof open>)=>{
  const handle=await open(...args);
  if(String(args[0])===target&&args[1]==='wx'){
   const write=handle.write.bind(handle);let interrupted=false;
   t.mock.method(handle,'write',async(buffer:Buffer,offset:number,length:number,position:number|null)=>{if(!interrupted){interrupted=true;await write(buffer,offset,Math.min(4,length),position);throw Object.assign(new Error('Interrupted second publication'),{code:'EIO'});}return write(buffer,offset,length,position);});
  }
  return handle;
 });
 const result=await core.executeReorganization(p);assert.equal(result.errors.length,1);
 assert.equal(await fs.readFile(original,'utf8'),'precious original');assert.equal(await fs.readFile(second,'utf8'),'second precious original');assert.equal(await fs.readFile(target,'utf8'),'seco');
 t.mock.restoreAll();const [job]=await core.getOrganizationRecovery(root);assert.equal(job!.status,'pending');
 const resumed=await core.resumeOrganization(root,job!.id);assert.deepEqual(resumed.errors,[]);assert.equal(resumed.moved,2);
 assert.equal(await fs.readFile(target,'utf8'),'second precious original');assert.equal((await core.getOrganizationRecovery(root))[0]!.status,'complete');
});

test('finalizing and undoing report n of x progress through their checking and their changes',async t=>{
 const {root}=await fixture(t),destination=path.join(root,'2024/202402/Sony/JPEG/A.JPG');
 await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,'precious original');
 const second=path.join(root,'incoming/B.JPG');await fs.writeFile(second,'another original');
 const p=await singlePlan(root,root,options,metadata);assert.deepEqual((await core.executeReorganization(p,undefined,undefined,{strategy:'rename'})).errors,[]);
 const [job]=await core.getOrganizationRecovery(root);
 const seen:{step:string;completed:number;total:number}[]=[];
 const released=await core.finalizeOrganization(root,job!.id,undefined,progress=>seen.push({step:progress.step,completed:progress.completed,total:progress.total}));
 assert.equal(released.removed,1);
 const checking=seen.filter(item=>item.step==='checking'),releasing=seen.filter(item=>item.step==='releasing');
 assert.deepEqual(checking.map(item=>item.completed),[1,2]);assert.ok(checking.every(item=>item.total===2));
 assert.deepEqual(releasing.at(-1),{step:'releasing',completed:2,total:2});

 const other=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'organization-undo-progress-')));
 t.after(()=>fs.rm(other,{recursive:true,force:true}));
 for(const name of ['C.JPG','D.JPG']){await fs.mkdir(path.join(other,'incoming'),{recursive:true});await fs.writeFile(path.join(other,'incoming',name),name);}
 const q=await singlePlan(other,other,options,metadata);assert.deepEqual((await core.executeReorganization(q,undefined,undefined,{strategy:'rename'})).errors,[]);
 const [moved]=await core.getOrganizationRecovery(other);const undoing:{step:string;completed:number;total:number}[]=[];
 assert.equal((await core.undoOrganization(other,moved!.id,undefined,progress=>undoing.push({step:progress.step,completed:progress.completed,total:progress.total}))).restored,2);
 assert.deepEqual(undoing.filter(item=>item.step==='checking').map(item=>item.completed),[1,2]);
 assert.deepEqual(undoing.filter(item=>item.step==='restoring').at(-1),{step:'restoring',completed:2,total:2});
});
