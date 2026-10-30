import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {nativeCameraHelperPath} from '../platform/camera-bridge';
import * as core from '../core/index';
import {sameHardLink,sameFile,movedFileIdentity} from '../core/recovery';
import {journalFileFor,journalFolderFor,journalLines,organizeByCopy} from './fixtures/records';

core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{},reorganize:true as const};
const metadata=async()=>({camera:'Sony',date:'2024-02-03',fields:{}});
async function fixture(t:test.TestContext,count=1){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'organization-rename-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const originals:string[]=[];
 for(let index=0;index<count;index++){const file=path.join(root,'incoming',`A${index}.JPG`);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,`precious original ${index}`);originals.push(file);}
 const destination=(index=0)=>path.join(root,'2024/202402/Sony/JPEG',`A${index}.JPG`);
 return {root,originals,original:originals[0]!,destination};
}
const prepare=async(root:string)=>(await core.plan(root,[root],options,metadata)).plans[0]!;
const recoveryFiles=async(root:string,id:string)=>{const found:string[]=[],base=await journalFolderFor(root,id);const walk=async(folder:string)=>{for(const entry of await fs.readdir(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isDirectory())await walk(file);else found.push(path.relative(base,file));}};await walk(path.join(base,'originals')).catch(()=>{});return found;};

async function refuseExclusiveRename(t:test.TestContext,root:string){
 if(process.platform!=='darwin')return;
 const real=await nativeCameraHelperPath();assert.ok(real);
 const helper=path.join(root,'linkless-helper.cjs'),previous=process.env.IMPORTER_NATIVE_BRIDGE;
 await fs.writeFile(helper,`#!${process.execPath}\nif(process.argv[2]==='--rename-exclusive'){process.stdout.write('{"errno":45}');process.exit(1);}const child=require('node:child_process').spawnSync(${JSON.stringify(real)},process.argv.slice(2),{stdio:['ignore','inherit','inherit',3]});process.exit(child.status??1);\n`,{mode:0o700});
 process.env.IMPORTER_NATIVE_BRIDGE=helper;
 t.after(()=>{if(previous===undefined)delete process.env.IMPORTER_NATIVE_BRIDGE;else process.env.IMPORTER_NATIVE_BRIDGE=previous;});
}

for(const kind of ['rename','copy'] as const)test(`undo restores a ${kind} organization when neither links nor exclusive rename are supported`,async t=>{
 const f=await fixture(t),p=await prepare(f.root);
 const result=kind==='copy'?await organizeByCopy(p):await core.executeReorganization(p);assert.deepEqual(result.errors,[]);
 const [job]=await core.getOrganizationRecovery(f.root,{verifyContents:false});
 await refuseExclusiveRename(t,f.root);
 t.mock.method(fs,'link',async()=>{throw Object.assign(new Error('no links'),{code:'ENOTSUP'});});syncBuiltinESMExports();
 try{
  assert.equal((await core.undoOrganization(f.root,job!.id)).restored,1);
  assert.equal(await fs.readFile(f.original,'utf8'),'precious original 0');
  await assert.rejects(fs.lstat(f.destination()),{code:'ENOENT'});
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

for(const kind of ['rename','copy'] as const)for(const when of ['mid-copy','after-source-unlink','changed-partial'] as const)test(`a ${kind} Undo copy interrupted ${when} preserves bytes and can be checked safely`,async t=>{
 const f=await fixture(t),bytes=Buffer.alloc(2*1024*1024,0x61);await fs.writeFile(f.original,bytes);
 const p=await prepare(f.root);assert.deepEqual((kind==='copy'?await organizeByCopy(p):await core.executeReorganization(p)).errors,[]);
 const [job]=await core.getOrganizationRecovery(f.root,{verifyContents:false});
 const from=kind==='rename'?f.destination():path.join(await journalFolderFor(f.root,job!.id),(await recoveryFiles(f.root,job!.id))[0]!);
 await refuseExclusiveRename(t,f.root);
 const script=path.join(f.root,'undo-crash.mjs');
 await fs.writeFile(script,`import filesystem from 'node:fs/promises';
 import {syncBuiltinESMExports} from 'node:module';
 import {undoOrganization,configureOrganizationRecovery} from ${JSON.stringify(path.resolve('desktop/core/index.ts'))};
 configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
 const to=${JSON.stringify(f.original)},from=${JSON.stringify(from)},when=${JSON.stringify(when)};
 const open=filesystem.open,unlink=filesystem.unlink;
 filesystem.link=async()=>{throw Object.assign(new Error('no links'),{code:'ENOTSUP'});};
 filesystem.open=async(file,...args)=>{const handle=await open(file,...args);if(file===to&&args[0]==='wx'&&when!=='after-source-unlink'){const write=handle.write.bind(handle);handle.write=async(buffer,offset,length,position)=>{await write(buffer,offset,Math.min(7,length),position);process.exit(91);};}return handle;};
 filesystem.unlink=async(file)=>{const result=await unlink(file);if(file===from&&when==='after-source-unlink')process.exit(91);return result;};
 syncBuiltinESMExports();
 await undoOrganization(${JSON.stringify(f.root)},${JSON.stringify(job!.id)});process.exit(0);`);
 const child=spawnSync(process.execPath,['--import','tsx',script],{cwd:process.cwd(),encoding:'utf8'});
 assert.equal(child.status,91,child.stderr);
 const pending=(await core.getOrganizationRecovery(f.root,{verifyContents:false}))[0]!;assert.equal(pending.status,'pending');assert.equal(pending.undoable,true);
 t.mock.method(fs,'link',async()=>{throw Object.assign(new Error('no links'),{code:'ENOTSUP'});});syncBuiltinESMExports();
 try{
  if(when==='changed-partial'){
   await fs.writeFile(f.original,'foreign');
   await assert.rejects(core.undoOrganization(f.root,job!.id),/occupied|changed/i);
   assert.equal(await fs.readFile(f.original,'utf8'),'foreign');assert.deepEqual(await fs.readFile(from),bytes);
  }else{
   await core.undoOrganization(f.root,job!.id);
   assert.deepEqual(await fs.readFile(f.original),bytes);
   await assert.rejects(fs.lstat(f.destination()),{code:'ENOENT'});
   assert.deepEqual(await core.getOrganizationRecovery(f.root),[]);
  }
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('a same-volume organization renames the original into place without copying or keeping a duplicate',async t=>{
 const f=await fixture(t),before=await fs.lstat(f.original,{bigint:true});
 const p=await prepare(f.root);
 const read={bytes:0},open=fs.open.bind(fs);
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const handle=await open(...args);if(String(args[0]).endsWith('.JPG')){const reader=handle.read.bind(handle);t.mock.method(handle,'read',async(...values:Parameters<typeof handle.read>)=>{const result=await reader(...values);read.bytes+=result.bytesRead;return result;});}return handle;});syncBuiltinESMExports();
 const result=await core.executeReorganization(p,undefined,undefined);
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.deepEqual(result.errors,[]);assert.equal(result.moved,1);assert.equal(result.retained,0);assert.equal(result.retainedBytes,0);
 assert.equal(read.bytes,0,'a rename reads no media bytes');
 const after=await fs.lstat(f.destination(),{bigint:true});
 assert.equal(after.ino,before.ino);assert.equal(after.dev,before.dev);
 await assert.rejects(fs.lstat(f.original),{code:'ENOENT'});
 const [job]=await core.getOrganizationRecovery(f.root);
 assert.equal(job!.status,'complete');assert.equal(job!.retainedFiles,0);assert.equal(job!.retainedBytes,0);assert.equal(job!.finalizable,false);assert.equal(job!.undoable,true);
 assert.deepEqual(await recoveryFiles(f.root,job!.id),[]);
});

test('a new organization is recorded as a rename without being asked for one',async t=>{
 const f=await fixture(t);
 const result=await core.executeReorganization(await prepare(f.root));
 assert.deepEqual(result.errors,[]);assert.equal(result.moved,1);assert.equal(result.retained,0);
 const [job]=await core.getOrganizationRecovery(f.root);
 assert.equal(JSON.parse((await journalLines(f.root,job!.id))[0]!).strategy,'rename');
});

test('a journal recorded without a strategy (an earlier version\'s copy) still runs as a verified copy and its signed header is never rewritten',async t=>{
 const f=await fixture(t);
 const result=await organizeByCopy(await prepare(f.root));
 assert.deepEqual(result.errors,[]);assert.equal(result.moved,1);
 assert.equal(result.retained,1,'the copy keeps the original for undo');
 const header=(await journalLines(f.root,result.id))[0]!;
 assert.equal(JSON.parse(header).strategy,undefined);
 assert.deepEqual((await core.resumeOrganization(f.root,result.id)).errors,[]);
 assert.equal((await journalLines(f.root,result.id))[0],header,'the header stays as it was signed');
 assert.equal(await fs.readFile(f.destination(),'utf8'),'precious original 0');
 const [job]=await core.getOrganizationRecovery(f.root);assert.equal(job!.retainedFiles,1);assert.equal(job!.finalizable,true);
});

test('a destination appearing during the move is never overwritten',async t=>{
 const f=await fixture(t),p=await prepare(f.root);
 const link=fs.link.bind(fs);
 t.mock.method(fs,'link',async(from:string,to:string)=>{if(to===f.destination())await fs.writeFile(to,'someone else');return link(from,to);});syncBuiltinESMExports();
 const result=await core.executeReorganization(p,undefined,undefined);
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.equal(result.moved,0);assert.match(result.errors.join('\n'),/appeared|changed/i);
 assert.equal(await fs.readFile(f.destination(),'utf8'),'someone else');
 assert.equal(await fs.readFile(f.original,'utf8'),'precious original 0');
});

test('full recheck hashes renamed files even when their size and modified date still match',async t=>{
 const f=await fixture(t);
 assert.deepEqual((await core.executeReorganization(await prepare(f.root))).errors,[]);
 const [job]=await core.getOrganizationRecovery(f.root,{verifyContents:false});
 const before=await fs.stat(f.destination());
 await fs.writeFile(f.destination(),'corrupt! original 0');
 await fs.utimes(f.destination(),before.atime,before.mtime);
 assert.equal((await fs.stat(f.destination())).size,before.size);
 const checked=await core.resumeOrganization(f.root,job!.id,undefined,undefined,{full:true});
 assert.match(checked.errors.join('\n'),/changed|verification/i);
 assert.equal(await fs.readFile(f.destination(),'utf8'),'corrupt! original 0');
});

for(const undo of [false,true])test(`a destination racing a linkless ${undo?'undo':'organization'} is never overwritten`,async t=>{
 const f=await fixture(t),p=await prepare(f.root);
 let id:string|undefined;
 if(undo){assert.deepEqual((await core.executeReorganization(p)).errors,[]);id=(await core.getOrganizationRecovery(f.root,{verifyContents:false}))[0]!.id;}
 const from=undo?f.destination():f.original,to=undo?f.original:f.destination();
 const link=fs.link.bind(fs),lstat=fs.lstat.bind(fs);let refused=false,injected=false;
 t.mock.method(fs,'link',async(source:string,target:string)=>{if(source===from&&target===to){refused=true;throw Object.assign(new Error('no hard links'),{code:'ENOTSUP'});}return link(source,target);});
 t.mock.method(fs,'lstat',async(...args:Parameters<typeof fs.lstat>)=>{
  try{return await lstat(...args);}catch(error){
   if(String(args[0])===to&&refused&&!injected&&(error as NodeJS.ErrnoException).code==='ENOENT'){injected=true;await fs.writeFile(to,'concurrent writer');}
   throw error;
  }
 });syncBuiltinESMExports();
 try{
  if(undo)await assert.rejects(core.undoOrganization(f.root,id!));
  else assert.ok((await core.executeReorganization(p)).errors.length>0,'the racing destination must be reported');
  assert.ok(injected,'the other writer arrived after the final absence check');
  assert.equal(await fs.readFile(to,'utf8'),'concurrent writer');
  assert.equal(await fs.readFile(from,'utf8'),'precious original 0');
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('linkless organization and undo keep the same inode without making retained copies',{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t),before=await fs.lstat(f.original,{bigint:true}),p=await prepare(f.root),link=fs.link.bind(fs);
 t.mock.method(fs,'link',async(from:string,to:string)=>{if(from===f.original||from===f.destination())throw Object.assign(new Error('no links'),{code:'ENOTSUP'});return link(from,to);});syncBuiltinESMExports();
 try{
  const moved=await core.executeReorganization(p);assert.deepEqual(moved.errors,[]);assert.equal(moved.moved,1);assert.equal(moved.retained,0);assert.equal(moved.copied,0);
  assert.equal((await fs.lstat(f.destination(),{bigint:true})).ino,before.ino);
  const [job]=await core.getOrganizationRecovery(f.root,{verifyContents:false});
  assert.equal((await core.undoOrganization(f.root,job!.id)).restored,1);
  assert.equal((await fs.lstat(f.original,{bigint:true})).ino,before.ino);
  assert.equal(await fs.readFile(f.original,'utf8'),'precious original 0');
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('a cross-device move falls back to the verified copy that keeps the original for undo',async t=>{
 const f=await fixture(t),p=await prepare(f.root);
 const link=fs.link.bind(fs);
 t.mock.method(fs,'link',async(from:string,to:string)=>{if(from===f.original||to===f.destination())throw Object.assign(new Error('cross-device link'),{code:'EXDEV'});return link(from,to);});syncBuiltinESMExports();
 const result=await core.executeReorganization(p,undefined,undefined);
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.deepEqual(result.errors,[]);assert.equal(result.moved,1);
 assert.equal(result.retained,1);assert.equal(result.retainedBytes,Buffer.byteLength('precious original 0'));
 assert.equal(await fs.readFile(f.destination(),'utf8'),'precious original 0');
 const [job]=await core.getOrganizationRecovery(f.root);
 assert.equal(job!.retainedFiles,1);assert.equal(job!.finalizable,true);
});

test('a source changed after review is not moved',async t=>{
 const f=await fixture(t),p=await prepare(f.root);
 await fs.chmod(f.original,0o600);
 const result=await core.executeReorganization(p,undefined,undefined);
 assert.match(result.errors.join('\n'),/changed/i);assert.equal(result.moved,0);
 assert.equal(await fs.readFile(f.original,'utf8'),'precious original 0');
 await assert.rejects(fs.lstat(f.destination()),{code:'ENOENT'});
});

test('undo moves renamed files back and is journaled so it cannot run twice',async t=>{
 const f=await fixture(t,2),before=await fs.lstat(f.original,{bigint:true});
 await core.executeReorganization(await prepare(f.root),undefined,undefined);
 const [job]=await core.getOrganizationRecovery(f.root);
 await fs.rm(path.join(f.root,'incoming'),{recursive:true,force:true});
 const undone=await core.undoOrganization(f.root,job!.id);
 assert.equal(undone.restored,2);
 assert.equal((await fs.lstat(f.original,{bigint:true})).ino,before.ino);
 assert.equal(await fs.readFile(f.originals[1]!,'utf8'),'precious original 1');
 await assert.rejects(fs.lstat(f.destination()),{code:'ENOENT'});
 assert.deepEqual(await core.getOrganizationRecovery(f.root),[],'an undone organization is no longer listed');
 await assert.rejects(core.resumeOrganization(f.root,job!.id),/undone/i);
});

test('undo of a copied organization restores the kept original and removes only the published copy',async t=>{
 const f=await fixture(t);
 await organizeByCopy(await prepare(f.root));
 const [job]=await core.getOrganizationRecovery(f.root);assert.equal(job!.retainedFiles,1);
 const undone=await core.undoOrganization(f.root,job!.id);
 assert.equal(undone.restored,1);assert.equal(undone.removed,1);
 assert.equal(await fs.readFile(f.original,'utf8'),'precious original 0');
 await assert.rejects(fs.lstat(f.destination()),{code:'ENOENT'});
});

test('a finalized organization cannot be undone',async t=>{
 const f=await fixture(t);
 await organizeByCopy(await prepare(f.root));
 const [job]=await core.getOrganizationRecovery(f.root);
 const released=await core.finalizeOrganization(f.root,job!.id);assert.equal(released.removed,1);
 const [after]=await core.getOrganizationRecovery(f.root);
 assert.equal(after!.retainedFiles,0);assert.equal(after!.finalizable,false);assert.equal(after!.undoable,false);
 await assert.rejects(core.undoOrganization(f.root,job!.id),/released|finalized/i);
});

for(const when of ['after-intent','after-link','after-rename'] as const)test(`a process killed ${when} resumes the move without losing the original`,async t=>{
 const f=await fixture(t),script=path.join(f.root,'crash.mjs'),module=path.resolve('desktop/core/index.ts');
 await fs.writeFile(script,`import filesystem from 'node:fs/promises';
 import {plan,executeReorganization,configureOrganizationRecovery} from ${JSON.stringify(module)};
 configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
 const original=${JSON.stringify(f.original)},destination=${JSON.stringify(f.destination())},root=${JSON.stringify(f.root)},when=${JSON.stringify(when)};
 const link=filesystem.link,unlink=filesystem.unlink,open=filesystem.open;
 filesystem.link=async(from,to)=>{if(from===original&&when==='after-intent')process.exit(91);if(from===original&&when==='after-rename')throw Object.assign(new Error('no links'),{code:'ENOTSUP'});const result=await link(from,to);if(from===original&&when==='after-link')process.exit(91);return result;};
 filesystem.open=async(file,...args)=>{if(file===destination&&when==='after-rename')process.exit(91);return open(file,...args);};
 const {plans:[p]}=await plan(root,[root],${JSON.stringify(options)},async()=>({camera:'Sony',date:'2024-02-03',fields:{}}));
 await executeReorganization(p,undefined,undefined);process.exit(0);`);
 const child=spawnSync(process.execPath,['--import','tsx',script],{cwd:process.cwd(),encoding:'utf8'});
 assert.equal(child.status,91,child.stderr);await fs.unlink(script);
 const [job]=await core.getOrganizationRecovery(f.root);assert.equal(job!.status,'pending');
 const resumed=await core.resumeOrganization(f.root,job!.id);
 assert.deepEqual(resumed.errors,[]);assert.equal(resumed.moved,1);
 assert.equal(await fs.readFile(f.destination(),'utf8'),'precious original 0');
 await assert.rejects(fs.lstat(f.original),{code:'ENOENT'});
 assert.equal((await core.getOrganizationRecovery(f.root))[0]!.status,'complete');
});

test('a file changed after review stops the run before any file is moved',async t=>{
 const f=await fixture(t,3),p=await prepare(f.root);
 await fs.writeFile(f.originals[2]!,'edited after review, longer');
 const result=await core.executeReorganization(p,undefined,undefined);
 assert.match(result.errors.join('\n'),/changed/i);assert.equal(result.moved,0);
 for(const [index,file] of f.originals.entries())assert.ok((await fs.readFile(file,'utf8')).startsWith(index===2?'edited':'precious'));
 for(let index=0;index<3;index++)await assert.rejects(fs.lstat(f.destination(index)),{code:'ENOENT'});
});

test('a capture date the filesystem cannot store keeps the moved file and its original dates instead of failing',async t=>{
 const f=await fixture(t),before=await fs.lstat(f.original);
 const p=await (await core.plan(f.root,[f.root],options,async()=>({camera:'Sony',date:'2024-02-03T12:00:00',fields:{}}))).plans[0]!;
 const futimes=fs.open.bind(fs);
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const handle=await futimes(...args);if(String(args[0])===f.destination())t.mock.method(handle,'utimes',async()=>{throw Object.assign(new Error('date out of range'),{code:'EINVAL'});});return handle;});syncBuiltinESMExports();
 const result=await core.executeReorganization(p,undefined,undefined);
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.deepEqual(result.errors,[]);assert.equal(result.moved,1);
 assert.match((result.notes??[]).join('\n'),/kept their original dates/i);
 assert.equal((await fs.lstat(f.destination())).mtimeMs,before.mtimeMs);
 const [job]=await core.getOrganizationRecovery(f.root);assert.equal(job!.status,'complete');
});

test('two names count as one file only through a real hard link on the same device',()=>{
 const stat=(dev:bigint,ino:bigint,nlink:bigint)=>({dev,ino,nlink});
 assert.equal(sameHardLink(stat(1n,13n,2n),stat(1n,13n,2n)),true);
 // exFAT cross-linked entries after an unplug: equal inode numbers, one link each.
 assert.equal(sameHardLink(stat(1n,13n,1n),stat(1n,13n,1n)),false);
 assert.equal(sameHardLink(stat(1n,13n,2n),stat(2n,13n,2n)),false);
});

test('an organization stopped partway can be undone, and an interrupted undo can be finished',async t=>{
 const f=await fixture(t,3),p=await prepare(f.root),controller=new AbortController();
 let moves=0;const link=fs.link.bind(fs);
 t.mock.method(fs,'link',async(from:string,to:string)=>{const result=await link(from,to);if(f.originals.includes(from)&&++moves===2)controller.abort();return result;});syncBuiltinESMExports();
 await core.executeReorganization(p,controller.signal,undefined).catch(()=>{});
 t.mock.restoreAll();syncBuiltinESMExports();
 let [job]=await core.getOrganizationRecovery(f.root);
 assert.equal(job!.status,'pending');assert.equal(job!.undoable,true,'a partly moved organization can be undone');
 const stopper=new AbortController();let restores=0;const relink=fs.link.bind(fs);
 t.mock.method(fs,'link',async(from:string,to:string)=>{const result=await relink(from,to);if(f.originals.includes(to)&&++restores===1)stopper.abort();return result;});syncBuiltinESMExports();
 await core.undoOrganization(f.root,job!.id,stopper.signal).catch(()=>{});
 t.mock.restoreAll();syncBuiltinESMExports();
 [job]=await core.getOrganizationRecovery(f.root);
 assert.ok(job,'an interrupted undo stays listed');assert.equal(job!.undoable,true);assert.equal(job!.error,undefined);
 await core.undoOrganization(f.root,job!.id);
 for(const [index,file] of f.originals.entries())assert.equal(await fs.readFile(file,'utf8'),`precious original ${index}`);
 assert.deepEqual(await core.getOrganizationRecovery(f.root),[]);
});

test('an empty file is left where it is: it is not planned or moved',async t=>{
 const f=await fixture(t);await fs.writeFile(f.original,'');
 const reviewed=await prepare(f.root);
 assert.deepEqual(reviewed.entries,[]);
 const result=await core.executeReorganization(reviewed,undefined,undefined);
 assert.deepEqual(result.errors,[]);assert.equal(result.moved,0);
 assert.equal((await fs.lstat(f.original)).size,0);
});

const dated=async(root:string)=>(await core.plan(root,[root],options,async()=>({camera:'Sony',date:'2024-02-03T12:00:00',fields:{}}))).plans[0]!;
// Journal events are signed lines of one log; each test rearranges or drops whole lines.
// Header and entries are the first two lines; the rest are events (the signed lines of one journal).
const eventLines=async(root:string,id:string)=>(await journalLines(root,id)).slice(2);
const isEvent=(event:string)=>(line:string)=>JSON.parse(line).event===event;
const rewriteLog=async(root:string,id:string,lines:string[])=>fs.writeFile(await journalFileFor(root,id),[...(await journalLines(root,id)).slice(0,2),...lines].map(line=>line+'\n').join(''));

test('a moved file given its capture date stays recognised however its journal events are ordered',async t=>{
 const f=await fixture(t,2);
 await core.executeReorganization(await dated(f.root),undefined,undefined);
 const [job]=await core.getOrganizationRecovery(f.root);
 assert.equal(job!.status,'complete');
 const lines=await eventLines(f.root,job!.id);assert.ok(lines.some(isEvent('timed')),'dates were applied and journaled');
 // Put the older records last, as a journal from an older version has no chronological order.
 await rewriteLog(f.root,job!.id,[...lines.filter(line=>!isEvent('renamed')(line)),...lines.filter(isEvent('renamed'))]);
 assert.equal((await core.getOrganizationRecovery(f.root))[0]!.status,'complete');
 assert.equal((await core.resumeOrganization(f.root,job!.id)).errors.length,0);
 assert.equal((await core.undoOrganization(f.root,job!.id)).restored,2);
});

test('a crash after a moved file was dated but before that was journaled still resumes and undoes',async t=>{
 const f=await fixture(t);
 await core.executeReorganization(await dated(f.root),undefined,undefined);
 const [job]=await core.getOrganizationRecovery(f.root);
 await rewriteLog(f.root,job!.id,(await eventLines(f.root,job!.id)).filter(line=>!isEvent('timed')(line)));
 assert.equal((await core.getOrganizationRecovery(f.root))[0]!.status,'complete');
 assert.deepEqual((await core.resumeOrganization(f.root,job!.id)).errors,[]);
 assert.equal((await core.undoOrganization(f.root,job!.id)).restored,1);
 assert.equal(await fs.readFile(f.original,'utf8'),'precious original 0');
});

test('an empty file is identified without its inode number, which exFAT changes on rename',()=>{
 const reviewed={dev:'7',ino:'-23',size:'0',mtime:'100',ctime:'100'};
 const stat=(ino:bigint,mtime:bigint)=>({dev:7n,ino,size:0n,mtimeNs:mtime,ctimeNs:mtime}) as unknown as import('node:fs').BigIntStats;
 assert.equal(sameFile(stat(-12n,100n),reviewed),true);
 assert.equal(sameFile(stat(-12n,101n),reviewed),false);
 assert.equal(sameFile(stat(5n,100n),{...reviewed,ino:'4',size:'0'}),true);
 assert.equal(sameFile(stat(5n,100n),{...reviewed,ino:'4',size:'10'} as never),false);
});

test('a restored Modified date rounded to the filesystem resolution still identifies the original',()=>{
 const entry={stat:{dev:'7',ino:'24',size:'10',mtime:'1792573947340000000',ctime:'1792573947340000000'},captureTimeMs:undefined} as never;
 const stat=(mtime:bigint)=>({dev:7n,ino:24n,size:10n,mtimeNs:mtime,ctimeNs:mtime,isFile:()=>true,isSymbolicLink:()=>false}) as unknown as import('node:fs').BigIntStats;
 assert.equal(movedFileIdentity(stat(1792573947330000000n),entry),true,'exFAT stores 10 ms steps');
 assert.equal(movedFileIdentity(stat(1792573946340000000n),entry),false,'a second off is another date');
});

test('an organization journals into one append-only file, not one file per event',async t=>{
 const f=await fixture(t,5);
 assert.deepEqual((await core.executeReorganization(await prepare(f.root),undefined,undefined)).errors,[]);
 const [job]=await core.getOrganizationRecovery(f.root);assert.equal(job!.status,'complete');
 const names=await fs.readdir(await journalFolderFor(f.root,job!.id));
 assert.equal(names.includes('journal.jsonl'),true);assert.deepEqual(names.filter(name=>name.startsWith('event-')),[]);
 const log=await journalFileFor(f.root,job!.id);
 assert.ok(!(await fs.readFile(log,'utf8')).slice(0,-1).split('\n').includes(''),'one record per line, no blank lines');
 // A write cut short by power loss leaves a torn last line, which carries no event.
 await fs.appendFile(log,'{"id":"torn');
 assert.equal((await core.getOrganizationRecovery(f.root))[0]!.status,'complete');
 assert.equal((await core.undoOrganization(f.root,job!.id)).restored,5);
 assert.match(await fs.readFile(log,'utf8'),/\{"id":"torn\n\{/,'the next event starts on its own line');
 for(const original of f.originals)assert.ok((await fs.stat(original)).isFile());
});
