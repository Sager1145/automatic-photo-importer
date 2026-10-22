import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import * as core from '../core/index';
import {sameHardLink,sameFile,movedFileIdentity} from '../core/recovery';

core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{},reorganize:true};
const metadata=async()=>({camera:'Sony',date:'2024-02-03',fields:{}});
const rename={strategy:'rename' as const};
async function fixture(t:test.TestContext,count=1){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'organization-rename-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const originals:string[]=[];
 for(let index=0;index<count;index++){const file=path.join(root,'incoming',`A${index}.JPG`);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,`precious original ${index}`);originals.push(file);}
 const destination=(index=0)=>path.join(root,'2024/202402/Sony/JPEG',`A${index}.JPG`);
 return {root,originals,original:originals[0]!,destination};
}
const prepare=async(root:string)=>(await core.plan(root,[root],options,metadata)).plans[0]!;
const recoveryFiles=async(root:string,id:string)=>{const found:string[]=[];const walk=async(folder:string)=>{for(const entry of await fs.readdir(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isDirectory())await walk(file);else found.push(path.relative(path.join(root,'Photo Importer Recovery',id),file));}};await walk(path.join(root,'Photo Importer Recovery',id,'originals')).catch(()=>{});return found;};

test('a same-volume organization renames the original into place without copying or keeping a duplicate',async t=>{
 const f=await fixture(t),before=await fs.lstat(f.original,{bigint:true});
 const p=await prepare(f.root);
 const read={bytes:0},open=fs.open.bind(fs);
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const handle=await open(...args);if(String(args[0]).endsWith('.JPG')){const reader=handle.read.bind(handle);t.mock.method(handle,'read',async(...values:Parameters<typeof handle.read>)=>{const result=await reader(...values);read.bytes+=result.bytesRead;return result;});}return handle;});syncBuiltinESMExports();
 const result=await core.executeReorganization(p,undefined,undefined,rename);
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

test('a destination appearing during the move is never overwritten',async t=>{
 const f=await fixture(t),p=await prepare(f.root);
 const link=fs.link.bind(fs);
 t.mock.method(fs,'link',async(from:string,to:string)=>{if(to===f.destination())await fs.writeFile(to,'someone else');return link(from,to);});syncBuiltinESMExports();
 const result=await core.executeReorganization(p,undefined,undefined,rename);
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.equal(result.moved,0);assert.match(result.errors.join('\n'),/appeared|changed/i);
 assert.equal(await fs.readFile(f.destination(),'utf8'),'someone else');
 assert.equal(await fs.readFile(f.original,'utf8'),'precious original 0');
});

test('a cross-device move falls back to the verified copy that keeps the original for undo',async t=>{
 const f=await fixture(t),p=await prepare(f.root);
 const link=fs.link.bind(fs);
 t.mock.method(fs,'link',async(from:string,to:string)=>{if(from===f.original||to===f.destination())throw Object.assign(new Error('cross-device link'),{code:'EXDEV'});return link(from,to);});syncBuiltinESMExports();
 const result=await core.executeReorganization(p,undefined,undefined,rename);
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
 const result=await core.executeReorganization(p,undefined,undefined,rename);
 assert.match(result.errors.join('\n'),/changed/i);assert.equal(result.moved,0);
 assert.equal(await fs.readFile(f.original,'utf8'),'precious original 0');
 await assert.rejects(fs.lstat(f.destination()),{code:'ENOENT'});
});

test('undo moves renamed files back and is journaled so it cannot run twice',async t=>{
 const f=await fixture(t,2),before=await fs.lstat(f.original,{bigint:true});
 await core.executeReorganization(await prepare(f.root),undefined,undefined,rename);
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
 await core.executeReorganization(await prepare(f.root));
 const [job]=await core.getOrganizationRecovery(f.root);assert.equal(job!.retainedFiles,1);
 const undone=await core.undoOrganization(f.root,job!.id);
 assert.equal(undone.restored,1);assert.equal(undone.removed,1);
 assert.equal(await fs.readFile(f.original,'utf8'),'precious original 0');
 await assert.rejects(fs.lstat(f.destination()),{code:'ENOENT'});
});

test('a finalized organization cannot be undone',async t=>{
 const f=await fixture(t);
 await core.executeReorganization(await prepare(f.root));
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
 const original=${JSON.stringify(f.original)},root=${JSON.stringify(f.root)},when=${JSON.stringify(when)};
 const link=filesystem.link,unlink=filesystem.unlink,rename=filesystem.rename;
 filesystem.link=async(from,to)=>{if(from===original&&when==='after-intent')process.exit(91);if(from===original&&when==='after-rename')throw Object.assign(new Error('no links'),{code:'ENOTSUP'});const result=await link(from,to);if(from===original&&when==='after-link')process.exit(91);return result;};
 filesystem.rename=async(from,to)=>{const result=await rename(from,to);if(from===original&&when==='after-rename')process.exit(91);return result;};
 const {plans:[p]}=await plan(root,[root],${JSON.stringify(options)},async()=>({camera:'Sony',date:'2024-02-03',fields:{}}));
 await executeReorganization(p,undefined,undefined,{strategy:'rename'});process.exit(0);`);
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
 const result=await core.executeReorganization(p,undefined,undefined,rename);
 assert.match(result.errors.join('\n'),/changed/i);assert.equal(result.moved,0);
 for(const [index,file] of f.originals.entries())assert.ok((await fs.readFile(file,'utf8')).startsWith(index===2?'edited':'precious'));
 for(let index=0;index<3;index++)await assert.rejects(fs.lstat(f.destination(index)),{code:'ENOENT'});
});

test('a capture date the filesystem cannot store keeps the moved file and its original dates instead of failing',async t=>{
 const f=await fixture(t),before=await fs.lstat(f.original);
 const p=await (await core.plan(f.root,[f.root],options,async()=>({camera:'Sony',date:'2024-02-03T12:00:00',fields:{}}))).plans[0]!;
 const futimes=fs.open.bind(fs);
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const handle=await futimes(...args);if(String(args[0])===f.destination())t.mock.method(handle,'utimes',async()=>{throw Object.assign(new Error('date out of range'),{code:'EINVAL'});});return handle;});syncBuiltinESMExports();
 const result=await core.executeReorganization(p,undefined,undefined,rename);
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
 await core.executeReorganization(p,controller.signal,undefined,rename).catch(()=>{});
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

test('an empty file is organized by the copy path, which works on exFAT',async t=>{
 const f=await fixture(t);await fs.writeFile(f.original,'');
 const result=await core.executeReorganization(await prepare(f.root),undefined,undefined,rename);
 assert.deepEqual(result.errors,[]);assert.equal(result.moved,1);
 assert.equal((await fs.lstat(f.destination())).size,0);
});

const dated=async(root:string)=>(await core.plan(root,[root],options,async()=>({camera:'Sony',date:'2024-02-03T12:00:00',fields:{}}))).plans[0]!;
// Journal events are signed lines of one log; each test rearranges or drops whole lines.
const eventLog=(root:string,id:string)=>path.join(root,'Photo Importer Recovery',id,'event-log.jsonl');
const eventLines=async(root:string,id:string)=>(await fs.readFile(eventLog(root,id),'utf8')).split('\n').filter(Boolean);
const isEvent=(event:string)=>(line:string)=>JSON.parse(line).event===event;
const rewriteLog=async(root:string,id:string,lines:string[])=>fs.writeFile(eventLog(root,id),lines.map(line=>line+'\n').join(''));

test('a moved file given its capture date stays recognised however its journal events are ordered',async t=>{
 const f=await fixture(t,2);
 await core.executeReorganization(await dated(f.root),undefined,undefined,rename);
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
 await core.executeReorganization(await dated(f.root),undefined,undefined,rename);
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

test('an organization journals into one append-only log, not one file per event',async t=>{
 const f=await fixture(t,5);
 assert.deepEqual((await core.executeReorganization(await prepare(f.root),undefined,undefined,rename)).errors,[]);
 const [job]=await core.getOrganizationRecovery(f.root);assert.equal(job!.status,'complete');
 const names=await fs.readdir(path.join(f.root,'Photo Importer Recovery',job!.id));
 assert.deepEqual(names.filter(name=>name.startsWith('event-')),['event-log.jsonl']);
 const log=path.join(f.root,'Photo Importer Recovery',job!.id,'event-log.jsonl');
 assert.ok(!(await fs.readFile(log,'utf8')).slice(0,-1).split('\n').includes(''),'one event per line, no blank lines');
 // A write cut short by power loss leaves a torn last line, which carries no event.
 await fs.appendFile(path.join(f.root,'Photo Importer Recovery',job!.id,'event-log.jsonl'),'{"id":"torn');
 assert.equal((await core.getOrganizationRecovery(f.root))[0]!.status,'complete');
 assert.equal((await core.undoOrganization(f.root,job!.id)).restored,5);
 assert.match(await fs.readFile(log,'utf8'),/\{"id":"torn\n\{/,'the next event starts on its own line');
 for(const original of f.originals)assert.ok((await fs.stat(original)).isFile());
});
