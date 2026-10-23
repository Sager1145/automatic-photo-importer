import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import fsPatchable from 'node:fs/promises';
import childProcess, {execFile} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {promisify} from 'node:util';
import {createHash, randomBytes} from 'node:crypto';
import {plan, execute, configureOrganizationRecovery} from '../core/index';
import {findResidue, cleanResidue} from '../core/residue';
import {STREAMS, mountOf, volumeOf} from '../core/devices';
import {directCapable, identity} from '../core/paths';
import {applyFileTimestamps} from '../platform/file-timestamps';
import type {Metadata} from '../shared';

// Direct copies (no staging file, the name created with O_EXCL) on a 3 GB sparse exFAT image.
// SIGKILL stands for a crashed process; the page cache survives it, so power loss is not covered.
const run=promisify(execFile);
configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const CAPTURE=Date.parse('2024-02-03T12:00:00Z');
const metadata=async():Promise<Metadata>=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00Z',fields:{}});
const FILES=14;

let base='',mount='',card='',image='',available=false,counter=0;
const attach=()=>run('hdiutil',['attach','-quiet','-nobrowse','-mountpoint',mount,image]);
const detach=()=>run('hdiutil',['detach','-quiet','-force',mount]).then(()=>{},()=>{});
before(async()=>{
  if(process.platform!=='darwin') return;
  base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'exfat-direct-')));
  mount=path.join(base,'mount');image=path.join(base,'drive.sparseimage');
  try {
    await fs.mkdir(mount);
    await run('hdiutil',['create','-quiet','-type','SPARSE','-size','3g','-fs','ExFAT','-volname','DIRECT',path.join(base,'drive')]);
    await attach();
    card=path.join(base,'card');await fs.mkdir(card);
    for(let i=0;i<FILES;i++) await fs.writeFile(path.join(card,`DSC_${String(i).padStart(4,'0')}.NEF`),randomBytes((4+(i%3))*1024*1024));
    available=true;
  } catch { await detach(); }
});
after(async()=>{if(!base)return;await detach();await fs.rm(base,{recursive:true,force:true});});
async function ready(t:test.TestContext):Promise<{root:string;card:string}|undefined> {
  if(!available){t.skip('large exFAT disk images are unavailable here');return undefined;}
  const root=path.join(mount,`photobackup-${++counter}`);await fs.mkdir(root);
  return {root,card};
}
const sha=(file:string)=>fs.readFile(file).then(data=>createHash('sha256').update(data).digest('hex'));
async function media(root:string):Promise<string[]> {
  const found:string[]=[];
  for(const entry of await fs.readdir(root,{withFileTypes:true,recursive:true})) if(entry.isFile()&&/^DSC_/.test(entry.name)) found.push(path.join(entry.parentPath,entry.name));
  return found.sort();
}
async function leftovers(folder:string):Promise<string[]> {
  const found:string[]=[];
  for(const entry of await fs.readdir(folder,{withFileTypes:true,recursive:true}))
    if(/^(?:\.import|photo-importer)-(?!index)/.test(entry.name)) found.push(path.join(entry.parentPath,entry.name));
  return found;
}
/** Receipts that no longer name anything are the only thing a finished import may leave behind (a receipt cut short by a kill). */
async function assertNothingOwned(root:string) {
  for(const file of await leftovers(root)) {
    assert.ok(file.endsWith('.json'),`a file other than a receipt is left: ${file}`);
    const named=await fs.readFile(file,'utf8').then(text=>{try{return JSON.parse(text).file as string;}catch{return undefined;}},()=>undefined);
    assert.equal(named,undefined,`a receipt still names ${named}`);
  }
}
async function reimport(card:string,root:string,execution:{direct?:boolean}={}) {
  const result=await execute((await plan(card,[root],options,metadata)).plans[0]!,undefined,undefined,execution);
  assert.deepEqual(result.errors,[]);
  const found=await media(root);
  assert.equal(found.length,FILES);
  assert.deepEqual(found.filter(file=>file.includes('Conflicts')),[],'no conflict copies');
  for(const file of found) {
    const from=path.join(card,path.basename(file));
    assert.equal(await sha(file),await sha(from),`${path.basename(file)} holds the card file's bytes`);
    const stat=await fs.stat(file);
    assert.ok(Math.abs(stat.mtimeMs-CAPTURE)<2000,`${path.basename(file)} has the capture date as modified`);
    assert.ok(Math.abs(stat.birthtimeMs-CAPTURE)<2000,`${path.basename(file)} has the capture date as created`);
  }
  await assertNothingOwned(root);
  return result;
}
async function crash(card:string,root:string,mode:string) {
  const child=new URL('./fixtures/direct-crash-child.mts',import.meta.url).pathname;
  const signal=await new Promise<string|null>(resolve=>execFile('node',['--import','tsx',child,card,root,mode],{timeout:120000},error=>resolve((error as {signal?:string}|null)?.signal??null)));
  assert.equal(signal,'SIGKILL',`the child process was killed at ${mode}`);
}
/** Detach and attach again, with another image taking the old disk number in between. */
async function reattach(root:string) {
  const before=(await fs.stat(root,{bigint:true})).dev;
  const tag=randomBytes(4).toString('hex'),other=path.join(base,'other-'+tag),otherMount=path.join(base,'other-mount-'+tag);
  await fs.mkdir(otherMount);
  await run('hdiutil',['create','-quiet','-type','SPARSE','-size','64m','-fs','ExFAT','-volname','OTHER',other]).catch(()=>{});
  await detach();
  await run('hdiutil',['attach','-quiet','-nobrowse','-mountpoint',otherMount,other+'.sparseimage']).catch(()=>{});
  try { await attach(); } finally { await run('hdiutil',['detach','-quiet','-force',otherMount]).catch(()=>{}); }
  return {before,after:(await fs.stat(root,{bigint:true})).dev};
}

const POINTS=['before-r1','torn-r1','after-r1','after-open','after-r2','mid-stream','full-unverified','after-times','after-m','after-p','after-unlink'];
for(const point of POINTS) {
  test(`a crash at ${point} of a direct copy is finished by the next import without conflicts`,async t=>{
    const env=await ready(t);if(!env) return;
    await crash(env.card,env.root,point);
    if(point==='after-p'||point==='after-unlink') {
      // The kill came after a file was flushed: a whole, dated file is at its name (and, after-p, its receipt is still beside it).
      let whole=0,receipts=0;
      for(const file of await media(env.root)) if((await fs.stat(file)).size===(await fs.stat(path.join(env.card,path.basename(file)))).size&&Math.abs((await fs.stat(file)).birthtimeMs-CAPTURE)<2000) whole++;
      for(const file of await leftovers(env.root)) if(file.endsWith('.json')) receipts++;
      assert.ok(whole>=1,'a finished file was left');
      if(point==='after-p') assert.ok(receipts>=1,'its receipt was still there');
    }
    await reimport(env.card,env.root);
  });
}
for(const point of ['after-r1','after-open','mid-stream','after-times','after-m']) {
  test(`a crash at ${point} followed by attaching the volume again is finished by the next import`,async t=>{
    const env=await ready(t);if(!env) return;
    await crash(env.card,env.root,point);
    await reattach(env.root);
    await reimport(env.card,env.root);
  });
}

test('three interruptions in a row (after the name is created, mid-stream, before the read-back) still end in one finished, dated copy',async t=>{
  const env=await ready(t);if(!env) return;
  await crash(env.card,env.root,'after-open');
  await crash(env.card,env.root,'mid-stream');
  await crash(env.card,env.root,'full-unverified');
  await reimport(env.card,env.root);
});

test('a whole file left before its dates were set is finished, not just skipped, even when the next import is forced onto the staged path',async t=>{
  const env=await ready(t);if(!env) return;
  await crash(env.card,env.root,'full-unverified');
  await reimport(env.card,env.root,{direct:false});
});

test('a whole file whose direct receipt no longer binds it is neither skipped nor released',async t=>{
  const env=await ready(t);if(!env) return;
  await crash(env.card,env.root,'full-unverified');
  let target:string|undefined;
  for(const file of await media(env.root)) if((await fs.stat(file)).size===(await fs.stat(path.join(env.card,path.basename(file)))).size){target=file;break;}
  assert.ok(target,'the killed run left a whole file');
  // Another creation date, far from anything the receipt allows.
  const handle=await fs.open(target!,'r+');
  await applyFileTimestamps(handle,await fs.lstat(path.join(env.card,path.basename(target!)),{bigint:true}),CAPTURE+400*86400*1000);await handle.sync();await handle.close();
  const before=await leftovers(env.root);
  const result=await execute((await plan(env.card,[env.root],options,metadata)).plans[0]!);
  assert.ok(result.errors.some(error=>error.includes(path.basename(target!))&&/does not match its receipt/.test(error)),`reported: ${result.errors.join(' | ')}`);
  assert.ok(before.length>0);
  assert.ok((await leftovers(env.root)).some(file=>file.endsWith('.json')),'its receipts were not released');
  assert.equal(Math.round((await fs.stat(target!)).birthtimeMs/1000),Math.round((CAPTURE+400*86400*1000)/1000),'the file was not touched');
});

test('identical files with one destination name, copied in the same run, finish as one copy and one skip with no conflict and no error',async t=>{
  const env=await ready(t);if(!env) return;
  const twins=path.join(base,`twins-${counter}`);
  for(const folder of ['A','B']) await fs.mkdir(path.join(twins,folder),{recursive:true});
  for(let i=0;i<6;i++) {
    const data=randomBytes(3*1024*1024),name=`DSC_${String(i).padStart(4,'0')}.NEF`;
    for(const folder of ['A','B']) await fs.writeFile(path.join(twins,folder,name),data);
  }
  const result=await execute((await plan(twins,[env.root],options,metadata)).plans[0]!);
  assert.deepEqual(result.errors,[]);
  assert.equal(result.copied+result.skipped,12);
  const found=await media(env.root);
  assert.equal(found.length,6);assert.deepEqual(found.filter(file=>file.includes('Conflicts')),[]);
  for(const file of found) assert.ok(Math.abs((await fs.stat(file)).birthtimeMs-CAPTURE)<2000,`${path.basename(file)} has the capture date`);
  await assertNothingOwned(env.root);
});

/** While `t` lives, the first byte of the first block written to each named file (under `root`) is flipped on its way to the disk, as a failing drive would. */
async function corruptWrites(t:test.TestContext,root:string,names:string[]) {
  const probe=await fs.open(root,'r');await probe.close();
  const proto=Object.getPrototypeOf(probe) as {write:(...args:unknown[])=>Promise<unknown>},write=proto.write,open=fsPatchable.open.bind(fsPatchable);
  const paths=new WeakMap<object,string>(),done=new Set<string>();
  t.mock.method(fsPatchable,'open',async(...args:Parameters<typeof fsPatchable.open>)=>{const handle=await open(...args);paths.set(handle,String(args[0]));return handle;});
  syncBuiltinESMExports();
  proto.write=function(this:object,...args:unknown[]){
    const file=paths.get(this);
    if(file&&file.startsWith(root+path.sep)&&names.includes(path.basename(file))&&!done.has(file)){done.add(file);const buffer=args[0] as Buffer;buffer[args[1] as number]^=1;}
    return write.apply(this,args);
  };
  t.after(()=>{proto.write=write;t.mock.restoreAll();syncBuiltinESMExports();});
  return ()=>{proto.write=write;t.mock.restoreAll();syncBuiltinESMExports();};
}

test('a read-back mismatch removes a file this run created, with its receipts, and reports the error',async t=>{
  const env=await ready(t);if(!env) return;
  const restore=await corruptWrites(t,env.root,['DSC_0003.NEF']);
  const result=await execute((await plan(env.card,[env.root],options,metadata)).plans[0]!);
  restore();
  assert.ok(result.errors.some(error=>error.startsWith('DSC_0003.NEF')&&/verification failed/.test(error)),result.errors.join(' | '));
  assert.ok(!(await media(env.root)).some(file=>path.basename(file)==='DSC_0003.NEF'),'the corrupt file was removed');
  for(const file of await leftovers(env.root)) if(file.endsWith('.json')) assert.ok(!(await fs.readFile(file,'utf8')).includes('DSC_0003.NEF'),'its receipts were released');
  await reimport(env.card,env.root);
});

test('a read-back mismatch in a file resumed from an earlier run keeps the file and its receipt',async t=>{
  const env=await ready(t);if(!env) return;
  await crash(env.card,env.root,'mid-stream');
  let partial:string|undefined;
  for(const file of await media(env.root)) {const size=(await fs.stat(file)).size;if(size>0&&size<(await fs.stat(path.join(env.card,path.basename(file)))).size){partial=file;break;}}
  assert.ok(partial,'the killed run left a partial file');
  const restore=await corruptWrites(t,env.root,[path.basename(partial!)]);
  const result=await execute((await plan(env.card,[env.root],options,metadata)).plans[0]!);
  restore();
  assert.ok(result.errors.some(error=>error.startsWith(path.basename(partial!))&&/verification failed/.test(error)),result.errors.join(' | '));
  assert.ok(await fs.lstat(partial!).then(()=>true,()=>false),'the file this run did not create stays');
  const receipts=await Promise.all((await leftovers(env.root)).filter(file=>file.endsWith('.json')).map(file=>fs.readFile(file,'utf8').catch(()=>'')));
  assert.ok(receipts.some(text=>text.includes(path.basename(partial!))),'its receipt stays');
});

test('only an exFAT volume is direct: it is recognised by its UUID, and an APFS folder is not',async t=>{
  const env=await ready(t);if(!env) return;
  const volume=await volumeOf(await mountOf(env.root));
  assert.equal(volume.type,'exfat');assert.match(volume.uuid??'',/^[0-9A-F-]{36}$/i,'the volume has a UUID');
  assert.equal(await directCapable(env.root,await identity(env.root)),true);
  assert.equal(await directCapable(env.root,'0:0'),true,'the answer does not depend on a path or device number');
  const apfs=await fs.realpath(os.tmpdir());
  assert.equal(await directCapable(apfs,await identity(apfs)),false);
});

test('a direct copy writes no staging file, reads each backup file once, and flushes a handful of times per file',async t=>{
  const env=await ready(t);if(!env) return;
  const reads=new Map<string,number>(),opened:string[]=[],proto=await (async()=>{const probe=await fs.open(env.root,'r');await probe.close();return Object.getPrototypeOf(probe) as {sync:()=>Promise<void>};})();
  const open=fsPatchable.open.bind(fsPatchable),sync=proto.sync;let syncs=0,helpers=0;
  t.mock.method(fsPatchable,'open',async(...args:Parameters<typeof fsPatchable.open>)=>{
    const handle=await open(...args),file=String(args[0]);opened.push(file);
    if(file.startsWith(env.root+path.sep)&&/^DSC_/.test(path.basename(file))){const read=handle.read.bind(handle) as (...values:unknown[])=>Promise<{bytesRead:number}>;t.mock.method(handle,'read',async(...values:unknown[])=>{const result=await read(...values);if(result.bytesRead)reads.set(file,(reads.get(file)??0)+result.bytesRead);return result;});}
    return handle;
  });
  const spawn=childProcess.spawn.bind(childProcess);
  t.mock.method(childProcess,'spawn',(...args:Parameters<typeof childProcess.spawn>)=>{helpers++;return (spawn as (...values:unknown[])=>ReturnType<typeof childProcess.spawn>)(...args);});
  syncBuiltinESMExports();
  proto.sync=function(this:unknown){syncs++;return sync.call(this);};
  t.after(()=>{proto.sync=sync;t.mock.restoreAll();syncBuiltinESMExports();});
  const reviewed=(await plan(env.card,[env.root],options,metadata)).plans[0]!;
  syncs=0;helpers=0;reads.clear();
  const result=await execute(reviewed);
  proto.sync=sync;t.mock.restoreAll();syncBuiltinESMExports();
  assert.deepEqual(result,{copied:FILES,skipped:0,errors:[]});
  assert.equal(opened.filter(file=>file.endsWith('.partial')).length,0,'no staging file was opened');
  for(const entry of reviewed.entries) assert.equal(reads.get(entry.destination),entry.size,`${path.basename(entry.destination)} is read once`);
  assert.ok(helpers<=FILES,`${helpers} helper starts for ${FILES} files`);
  assert.ok(syncs<=7*FILES,`${syncs/FILES} flushes per file`);
  assert.deepEqual(await leftovers(env.root),[]);
});

test('with one stream slot and verification on, sixteen files finish: no step waits for a second slot while holding one',{timeout:240000},async t=>{
  const env=await ready(t);if(!env) return;
  const saved={...STREAMS};
  t.after(()=>{Object.assign(STREAMS,saved);});
  for(const kind of Object.keys(STREAMS) as (keyof typeof STREAMS)[]) STREAMS[kind]=1;
  const extra=path.join(base,'card16');await fs.mkdir(extra);
  for(let i=0;i<16;i++) await fs.writeFile(path.join(extra,`DSC_${String(i).padStart(4,'0')}.NEF`),randomBytes(600*1024));
  const result=await execute((await plan(extra,[env.root],options,metadata)).plans[0]!);
  assert.deepEqual(result,{copied:16,skipped:0,errors:[]});
});

test('a complete file at its final name that the user edited in place gets a conflict copy and is never truncated',async t=>{
  const env=await ready(t);if(!env) return;
  await crash(env.card,env.root,'after-m');
  const complete=[];
  for(const file of await media(env.root)) if((await fs.stat(file)).size===(await fs.stat(path.join(env.card,path.basename(file)))).size) complete.push(file);
  assert.ok(complete.length>0,'the killed run left a complete file');
  const edited=complete[0]!,handle=await fs.open(edited,'r+');
  await handle.write(Buffer.from([0xff,0xee]),0,2,100);await handle.close();
  const before=await sha(edited),size=(await fs.stat(edited)).size;
  const result=await execute((await plan(env.card,[env.root],options,metadata)).plans[0]!);
  assert.deepEqual(result.errors,[]);
  assert.equal(await sha(edited),before,'the edited file is untouched');
  assert.equal((await fs.stat(edited)).size,size);
  const conflicts=(await media(env.root)).filter(file=>file.includes('Conflicts')&&path.basename(file)===path.basename(edited));
  assert.equal(conflicts.length,1,'the card file went to Conflicts');
  assert.equal(await sha(conflicts[0]!),await sha(path.join(env.card,path.basename(edited))));
});

test('a partial whose bytes were changed goes to Conflicts and the partial stays byte for byte as it was',async t=>{
  const env=await ready(t);if(!env) return;
  await crash(env.card,env.root,'mid-stream');
  let partial:string|undefined;
  for(const file of await media(env.root)) {const size=(await fs.stat(file)).size;if(size>0&&size<(await fs.stat(path.join(env.card,path.basename(file)))).size){partial=file;break;}}
  assert.ok(partial,'the killed run left a partial file');
  const handle=await fs.open(partial!,'r+');await handle.write(Buffer.from([0xaa,0xbb,0xcc]),0,3,0);await handle.close();
  const before=await sha(partial!),size=(await fs.stat(partial!)).size;
  const result=await execute((await plan(env.card,[env.root],options,metadata)).plans[0]!);
  assert.deepEqual(result.errors,[]);
  assert.equal(await sha(partial!),before);assert.equal((await fs.stat(partial!)).size,size);
  const copies=(await media(env.root)).filter(file=>file.includes('Conflicts')&&path.basename(file)===path.basename(partial!));
  assert.equal(copies.length,1);
  assert.equal(await sha(copies[0]!),await sha(path.join(env.card,path.basename(partial!))));
});

test('an unfinished file with a preserved creation date, such as a Finder copy in progress, is never appended to',async t=>{
  const env=await ready(t);if(!env) return;
  await crash(env.card,env.root,'mid-stream');
  let partial:string|undefined;
  for(const file of await media(env.root)) {const size=(await fs.stat(file)).size;if(size>0&&size<(await fs.stat(path.join(env.card,path.basename(file)))).size){partial=file;break;}}
  assert.ok(partial,'the killed run left a partial file');
  // Replace it by another writer's unfinished copy: the same leading bytes, the capture date as its created date.
  const source=path.join(env.card,path.basename(partial!)),prefix=(await fs.readFile(source)).subarray(0,1024*1024);
  await fs.unlink(partial!);
  const handle=await fs.open(partial!,'wx');await handle.write(prefix,0,prefix.length,0);
  await applyFileTimestamps(handle,await fs.lstat(source,{bigint:true}),CAPTURE);await handle.sync();await handle.close();
  const before=await sha(partial!);
  const result=await execute((await plan(env.card,[env.root],options,metadata)).plans[0]!);
  assert.deepEqual(result.errors,[]);
  assert.equal(await sha(partial!),before,'the other writer\'s file is untouched');
  assert.equal((await fs.stat(partial!)).size,prefix.length);
  assert.equal((await media(env.root)).filter(file=>file.includes('Conflicts')&&path.basename(file)===path.basename(partial!)).length,1);
});

test('a receipt whose seal was altered grants nothing',async t=>{
  const env=await ready(t);if(!env) return;
  await crash(env.card,env.root,'mid-stream');
  const before=new Map<string,string>();
  for(const file of await media(env.root)) before.set(file,await sha(file));
  let forged=0;
  for(const file of await leftovers(env.root)) {
    if(!file.endsWith('.json')) continue;
    const text=await fs.readFile(file,'utf8').catch(()=>'');if(!text) continue;
    await fs.writeFile(file,text.replace(/"seal":"([0-9a-f])/,(_all,digit:string)=>`"seal":"${digit==='0'?'1':'0'}`));forged++;
  }
  assert.ok(forged>0);
  const result=await execute((await plan(env.card,[env.root],options,metadata)).plans[0]!);
  assert.deepEqual(result.errors,[]);
  for(const [file,hash] of before) if((await fs.stat(file)).size>0) assert.equal(await sha(file),hash,`${path.basename(file)} was left as it was`);
});

test('the idle residue cleanup never removes a media file at its final name, whatever state it is in',async t=>{
  const env=await ready(t);if(!env) return;
  await crash(env.card,env.root,'mid-stream');
  const before=await media(env.root);
  assert.ok(before.length>0);
  const found=await findResidue([env.root]);
  assert.ok(!found.items.some(item=>/DSC_/.test(path.basename(item.path))),'no media file is listed');
  await cleanResidue(found,{keepResumable:true});
  assert.deepEqual(await media(env.root),before);
  await cleanResidue(await findResidue([env.root]));
  assert.deepEqual(await media(env.root),before);
});

test('a Stop during a direct copy leaves the partial files, and the next import resumes them in place',async t=>{
  const env=await ready(t);if(!env) return;
  const controller=new AbortController(),reviewed=(await plan(env.card,[env.root],options,metadata)).plans[0]!;
  await assert.rejects(execute(reviewed,controller.signal,progress=>{if(progress.phase==='copying'&&progress.bytes>20*1048576)controller.abort();}),{name:'AbortError'});
  const partial=(await media(env.root)).filter(file=>!file.includes('Conflicts'));
  assert.ok(partial.length>0,'the stopped copy left its files in place');
  const result=await reimport(env.card,env.root);
  assert.equal(result.errors.length,0);
});

test('a failed folder flush fails the files that waited for it, leaves their receipts, and a retry finishes them',async t=>{
  const env=await ready(t);if(!env) return;
  const proto=await (async()=>{const probe=await fs.open(env.root,'r');await probe.close();return Object.getPrototypeOf(probe) as {sync:()=>Promise<void>};})();
  const open=fsPatchable.open.bind(fsPatchable),sync=proto.sync,folders=new WeakSet<object>();let armed=false,failed=0;
  t.mock.method(fsPatchable,'open',async(...args:Parameters<typeof fsPatchable.open>)=>{
    const handle=await open(...args);
    if((await handle.stat()).isDirectory()) folders.add(handle);
    return handle;
  });
  syncBuiltinESMExports();
  proto.sync=function(this:object){
    // The first flush of a folder once files are being written fails, as a failing drive would.
    if(folders.has(this)&&armed&&failed===0){failed++;return Promise.reject(Object.assign(new Error('EIO'),{code:'EIO'}));}
    return sync.call(this);
  };
  const reviewed=(await plan(env.card,[env.root],options,metadata)).plans[0]!;
  const timer=setInterval(()=>{media(env.root).then(files=>{if(files.length>0)armed=true;}).catch(()=>{});},2);
  let result;
  try { result=await execute(reviewed); } finally { clearInterval(timer);proto.sync=sync;t.mock.restoreAll();syncBuiltinESMExports(); }
  assert.equal(failed,1,'one flush failed');
  assert.ok(result.errors.length>=1,'the files that waited for it failed');
  assert.ok(result.copied<FILES,'they were not reported done');
  await reimport(env.card,env.root);
});

test('a family whose files were left finished by a kill gets its dates from the next import',async t=>{
  const env=await ready(t);if(!env) return;
  const family=path.join(base,`family-${counter}`);await fs.mkdir(family);
  for(let i=0;i<4;i++) {await fs.writeFile(path.join(family,`DSC_${String(i).padStart(4,'0')}.NEF`),randomBytes(3*1024*1024));await fs.writeFile(path.join(family,`DSC_${String(i).padStart(4,'0')}.JPG`),randomBytes(1024*1024));}
  await crash(family,env.root,'after-m');
  const result=await execute((await plan(family,[env.root],options,metadata)).plans[0]!);
  assert.deepEqual(result.errors,[]);
  const found=await media(env.root);
  assert.equal(found.length,8);assert.deepEqual(found.filter(file=>file.includes('Conflicts')),[]);
  for(const file of found) {
    assert.equal(await sha(file),await sha(path.join(family,path.basename(file))));
    assert.ok(Math.abs((await fs.stat(file)).birthtimeMs-CAPTURE)<2000,`${path.basename(file)} has the capture date`);
  }
  await assertNothingOwned(env.root);
});
