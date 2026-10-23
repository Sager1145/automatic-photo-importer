import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { inventory, plan as planDestinations, execute, executeReorganization, configureOrganizationRecovery } from '../core/index';
import type { Metadata } from '../shared';
import {openReceiptsFor,stagingFor} from './fixtures/receipts';
/** Directory listing without the destination checksum index, which every copy may refresh. */
const visible=async(folder:string)=>(await fs.readdir(folder)).filter(name=>!name.startsWith('photo-importer-index'));


async function plan(source:string,root:string,...args:Parameters<typeof planDestinations> extends [string,string[],...infer Rest]?Rest:never){return (await planDestinations(source,[root],...args)).plans[0]!;}
configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options = {backup:false, template:'{year}/{yyyymm}/{camera}', layout:'format' as const, unknownRules:{}};
const metadata = async ():Promise<Metadata> => ({camera:'Sony A7',date:'2024-02-03T12:00:00Z',fields:{}});
async function fixture(t:test.TestContext) {
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'photo-core-')));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const source=path.join(base,'source'), root=path.join(base,'destination');
  await fs.mkdir(source); await fs.mkdir(root);
  const put=async (relative:string, contents:string|Buffer='original')=>{const p=path.join(source,relative); await fs.mkdir(path.dirname(p),{recursive:true}); await fs.writeFile(p,contents); return p;};
  return {base,source,root,put};
}

test('inventory discovers Sony video companions and excludes unmatched DSC files',async t=>{
  const {source,put}=await fixture(t);
  await put('PRIVATE/M4ROOT/CLIP/C0001.MP4'); await put('PRIVATE/M4ROOT/CLIP/C0001M01.XML');
  await put('DCIM/DSC0001.ARW'); await put('DCIM/DSC0001.JPG'); await put('DCIM/DSC0001.XMP');
  await put('DCIM/DSC0002.DAT'); await put('DCIM/README.XML');
  const scan=await inventory(source,{});
  assert.equal(scan.media,3); assert.equal(scan.companions,2); assert.equal(scan.unknown,2);
  assert.equal(scan.files.find(f=>f.relative.endsWith('C0001M01.XML'))?.companionOf,path.join(source,'PRIVATE/M4ROOT/CLIP/C0001.MP4'));
  assert.equal(scan.files.find(f=>f.relative.endsWith('.DAT'))?.included,false);
});

test('media inventory leaves active downloads untouched while every-file backup includes them',async t=>{
  const {source,put}=await fixture(t);
  const active=['_NZF8326.NEF.baiduyun.p.downloading','A.JPG.part','B.NEF.partial','C.MP4.crdownload','D.ARW.TMP'];
  for(const name of active)await put(name,'unfinished');
  await put('shoot.downloading/E.NEF','unfinished directory');
  await put('ready.NEF','finished');await put('INDEX01.DSC','camera index');
  const scan=await inventory(source,{});
  assert.deepEqual(scan.files.map(file=>file.relative).sort(),['INDEX01.DSC','ready.NEF']);
  assert.equal(scan.media,1);assert.equal(scan.unknown,1);
  assert.equal(scan.files.find(file=>file.relative==='ready.NEF')?.included,true);
  assert.equal(scan.files.find(file=>file.relative==='INDEX01.DSC')?.included,false);
  const backup=await inventory(source,{backup:true});
  assert.deepEqual(backup.files.map(file=>file.relative).sort(),[...active,'shoot.downloading/E.NEF','ready.NEF','INDEX01.DSC'].sort());
  assert.ok(backup.files.every(file=>file.included));
  for(const name of active)assert.equal(await fs.readFile(path.join(source,name),'utf8'),'unfinished');
});

test('backup includes hidden user files and unknowns without metadata and preserves folders',async t=>{
  const {source,root,put}=await fixture(t);
  await put('.private/config.data','secret'); await put('DCIM/DSC0002.DAT','unknown'); await put('.DS_Store'); await put('.Spotlight-V100/index'); await put('._junk');
  const p=await plan(source,root,{...options,backup:true},async()=>{throw new Error('Backup must not read metadata');});
  assert.deepEqual(p.entries.map(e=>path.relative(root,e.destination)).sort(),['.private/config.data','DCIM/DSC0002.DAT']);
  assert.deepEqual(await execute(p),{copied:2,skipped:0,errors:[]});
  assert.equal(await fs.readFile(path.join(root,'.private/config.data'),'utf8'),'secret');
  assert.equal(await fs.readFile(path.join(source,'.private/config.data'),'utf8'),'secret');
});

test('copy verifies duplicates, never replaces extras, and shares collision stem across RAW/JPEG/sidecars',async t=>{
  const {source,root,put}=await fixture(t);
  await put('DSC0001.ARW','new raw'); await put('DSC0001.JPG','new jpeg'); await put('DSC0001.XMP','sidecar');
  const rawFolder=path.join(root,'2024/202402/Sony A7/ARW'); await fs.mkdir(rawFolder,{recursive:true});
  await fs.writeFile(path.join(rawFolder,'DSC0001.ARW'),'old raw'); await fs.writeFile(path.join(root,'extra.txt'),'keep');
  const p=await plan(source,root,options,metadata);
  const stems=p.entries.map(e=>path.basename(e.destination,path.extname(e.destination)));
  assert.equal(new Set(stems).size,1); assert.equal(stems[0],'DSC0001');assert.ok(p.entries.every(entry=>entry.destination.includes(path.sep+'Conflicts'+path.sep)));
  assert.deepEqual(await execute(p),{copied:3,skipped:0,errors:[]});
  assert.equal(await fs.readFile(path.join(rawFolder,'DSC0001.ARW'),'utf8'),'old raw');
  assert.equal(await fs.readFile(path.join(root,'extra.txt'),'utf8'),'keep');
  const repeated=await plan(source,root,options,metadata);
  assert.ok(repeated.entries.every(e=>e.skip));
  assert.deepEqual(await execute(repeated),{copied:0,skipped:3,errors:[]});
  assert.equal(await fs.readFile(path.join(source,'DSC0001.ARW'),'utf8'),'new raw');
});

test('Sony XML collision suffix stays before M01 and follows the MP4',async t=>{
  const {source,root,put}=await fixture(t);
  await put('C0001.MP4','movie'); await put('C0001M01.XML','metadata');
  await fs.mkdir(path.join(root,'2024/202402/Sony A7/MP4'),{recursive:true});
  await fs.writeFile(path.join(root,'2024/202402/Sony A7/MP4/C0001.MP4'),'different');
  const p=await plan(source,root,options,metadata);
  const video=p.entries.find(e=>e.kind==='Videos')!; const xml=p.entries.find(e=>e.kind==='Other')!;
  assert.equal(path.basename(xml.destination),path.basename(video.destination,'.MP4')+'M01.XML');
  assert.equal(path.dirname(xml.destination),path.dirname(video.destination));
});

test('custom unknown folders stay beneath root and reject traversal on every platform',async t=>{
  const {source,root,put}=await fixture(t); await put('DSC0001.DAT','data');
  for (const folder of ['../escape','/absolute','C:\\escape','a\\b','a/../b','a//b','a:stream','a/./b']) {
    await assert.rejects(plan(source,root,{...options,unknownRules:{dat:folder}},metadata),/invalid|unsafe/i);
  }
  const p=await plan(source,root,{...options,unknownRules:{'.DAT':'Custom/Files'}},metadata);
  assert.equal(p.entries[0]?.destination,path.join(root,'Custom/Files/DSC0001.DAT'));
});

test('missing camera and capture date use explicit fallback and UTC file modification date',async t=>{
  const {source,root,put}=await fixture(t); const f=await put('A.JPG');
  await fs.utimes(f,new Date('2020-12-31T23:59:59Z'),new Date('2020-12-31T23:59:59Z'));
  const p=await plan(source,root,options,async()=>({fields:{}}));
  assert.equal(p.entries[0]?.destination,path.join(root,'2020/202012/Unknown files/JPEG/A.JPG'));
});

test('RAW and JPEG retain conflicting camera/date metadata rather than inherit incorrect values',async t=>{
  const {source,root,put}=await fixture(t); await put('A.ARW'); await put('A.JPG');
  const p=await plan(source,root,options,async f=>({camera:f.endsWith('.ARW')?'Camera One':'Camera Two',date:f.endsWith('.ARW')?'2021-01-01T00:00:00Z':'2022-02-01T00:00:00Z',fields:{}}));
  assert.ok(p.entries.find(e=>e.kind==='RAW')?.destination.includes('2021/202101/Camera One'));
  assert.ok(p.entries.find(e=>e.kind==='JPEG')?.destination.includes('2022/202202/Camera Two'));
});

for(const scenario of [
  {name:'the same instant with different explicit offsets',raw:'2024-02-03T12:00:00+09:00',jpeg:'2024-02-03T03:00:00Z',together:true},
  {name:'different explicitly zoned instants',raw:'2024-02-03T12:00:00+09:00',jpeg:'2024-02-03T12:00:00Z',together:false},
  {name:'a fraction missing from one explicitly zoned timestamp',raw:'2024-02-03T12:00:00.987654+09:00',jpeg:'2024-02-03T03:00:00Z',together:true},
  {name:'a fraction missing from one unknown-zone timestamp',raw:'2024-02-03T12:00:00.987654',jpeg:'2024-02-03T12:00:00',together:true},
  {name:'matching shared fractional precision',raw:'2024-02-03T12:00:00.123456Z',jpeg:'2024-02-03T12:00:00.123Z',together:true},
  {name:'different shared submillisecond precision',raw:'2024-02-03T12:00:00.123456Z',jpeg:'2024-02-03T12:00:00.123457Z',together:false},
])test(`RAW/JPEG family comparison respects ${scenario.name}`,async t=>{
  const {source,root,put}=await fixture(t);await put('PAIR.ARW','raw');await put('PAIR.JPG','jpeg');
  const p=await plan(source,root,options,async file=>({camera:'Sony A7',date:file.endsWith('.ARW')?scenario.raw:scenario.jpeg,fields:{}}));
  assert.equal(new Set(p.entries.map(entry=>entry.family)).size,scenario.together?1:2);
});

test('mixed known/unknown capture zones and naive DST wall clocks never inherit the host timezone',async t=>{
  const previous=process.env.TZ;t.after(()=>{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;});
  const {source,root,put}=await fixture(t);await put('PAIR.ARW','raw');await put('PAIR.JPG','jpeg');
  for(const zone of ['UTC','America/Toronto','Asia/Tokyo']){
    process.env.TZ=zone;
    for(const [raw,jpeg] of [['2024-02-03T12:00:00+09:00','2024-02-03T12:00:00'],['2024-02-03T12:00:00','2024-02-03T12:00:00+09:00']]){
      const p=await plan(source,root,options,async file=>({camera:'Sony A7',date:file.endsWith('.ARW')?raw:jpeg,fields:{}}));
      assert.equal(new Set(p.entries.map(entry=>entry.family)).size,1,`Mixed capture zones must stay together under ${zone}`);
    }
    const p=await plan(source,root,options,async file=>({camera:'Sony A7',date:file.endsWith('.ARW')?'2024-03-10T02:15:00':'2024-03-10T03:15:00',fields:{}}));
    assert.equal(new Set(p.entries.map(entry=>entry.family)).size,2,`Distinct naive wall clocks must stay distinct under ${zone}`);
  }
});

test('source changes after planning cause an error and never publish changed bytes',async t=>{
  const {source,root,put}=await fixture(t); const f=await put('A.JPG','original');
  const p=await plan(source,root,options,metadata); await fs.writeFile(f,'modified');
  const result=await execute(p); assert.equal(result.copied,0); assert.equal(result.errors.length,1);
  await assert.rejects(fs.stat(p.entries[0]!.destination));
});

test('rejects source/destination overlap, symlink targets, and substituted destination root',async t=>{
  const {base,source,root,put}=await fixture(t); await put('A.JPG');
  await assert.rejects(plan(source,source,options,metadata),/already in your backup/i);
  // A backup folder inside the source is left out of it instead of refused.
  const nested=path.join(source,'nested'); await fs.mkdir(nested); await fs.writeFile(path.join(nested,'B.JPG'),'kept out');
  assert.ok((await plan(source,nested,options,metadata)).entries.every(entry=>!entry.source.startsWith(nested+path.sep)));
  await fs.rm(nested,{recursive:true});
  const outside=path.join(base,'outside'); await fs.mkdir(outside);
  await fs.symlink(outside,path.join(root,'2024'),'dir');
  await assert.rejects(plan(source,root,options,metadata),/symbolic|unsafe/i);
  await fs.unlink(path.join(root,'2024'));
  const p=await plan(source,root,options,metadata);
  await fs.rename(root,root+'-old'); await fs.mkdir(root);
  await assert.rejects(execute(p),/changed|identity/i);
});

test('inventory skips symbolic files and directories and abort prevents publication',async t=>{
  const {source,root,put}=await fixture(t); const file=await put('A.JPG');
  await fs.symlink(file,path.join(source,'B.JPG')); await fs.symlink(root,path.join(source,'linked'),'dir');
  assert.equal((await inventory(source,{})).files.length,1);
  const p=await plan(source,root,options,metadata); const controller=new AbortController(); controller.abort();
  await assert.rejects(execute(p,controller.signal),{name:'AbortError'});
  assert.deepEqual(await visible(root),[]);
});

test('concurrent plans allocate one consistent family suffix without overwriting',async t=>{
  const {base,source,root,put}=await fixture(t); await put('A.ARW','first raw'); await put('A.JPG','first jpeg');
  const source2=path.join(base,'source2'); await fs.mkdir(source2); await fs.writeFile(path.join(source2,'A.ARW'),'second raw'); await fs.writeFile(path.join(source2,'A.JPG'),'second jpeg');
  const [p1,p2]=await Promise.all([plan(source,root,options,metadata),plan(source2,root,options,metadata)]);
  const results=await Promise.all([execute(p1),execute(p2)]); assert.equal(results.reduce((n,r)=>n+r.copied,0),4); assert.ok(results.every(r=>r.errors.length===0));
  const camera=path.join(root,'2024/202402/Sony A7'),[conflict]=await visible(path.join(camera,'Conflicts'));assert.ok(conflict);
  const originals=await Promise.all(['ARW/A.ARW','JPEG/A.JPG'].map(file=>fs.readFile(path.join(camera,file),'utf8')));
  const incoming=await Promise.all(['ARW/A.ARW','JPEG/A.JPG'].map(file=>fs.readFile(path.join(camera,'Conflicts',conflict,file),'utf8')));
  assert.deepEqual([originals,incoming].sort(),[['first raw','first jpeg'],['second raw','second jpeg']].sort());
  const repeated=await Promise.all([plan(source,root,options,metadata),plan(source2,root,options,metadata)]);assert.ok(repeated.every(transfer=>transfer.entries.every(entry=>entry.skip)));
});

test('duplicate removal after preview is restored and replaced duplicate is retained',async t=>{
  const {source,root,put}=await fixture(t); await put('A.JPG','original');
  const p=await plan(source,root,options,metadata); await execute(p);
  const duplicate=await plan(source,root,options,metadata); assert.equal(duplicate.entries[0]?.skip,true);
  await fs.unlink(duplicate.entries[0]!.destination);
  assert.equal((await execute(duplicate)).copied,1);
  const changedDuplicate=await plan(source,root,options,metadata); await fs.writeFile(changedDuplicate.entries[0]!.destination,'foreign!');
  assert.equal((await execute(changedDuplicate)).copied,1);
  assert.equal(await fs.readFile(changedDuplicate.entries[0]!.destination,'utf8'),'foreign!');
});

test('calendar folders retain EXIF wall-clock date across timezone offsets',async t=>{
  const {source,root,put}=await fixture(t); await put('A.JPG');
  const p=await plan(source,root,{...options,template:'{year}/{month}/{day}/{yyyyMMdd}/{camera}'},async()=>({camera:'Sony',date:'2026-10-20T00:30:00+09:00',fields:{}}));
  assert.equal(p.entries[0]?.destination,path.join(root,'2026/10/20/20261020/Sony/JPEG/A.JPG'));
});

test('abort during streaming removes only owned staging files and retains all originals',async t=>{
  const {source,root,put}=await fixture(t); const data=Buffer.alloc(3*1024*1024,65); await put('A.ARW',data);
  await fs.writeFile(path.join(root,'keep.txt'),'destination extra');
  const p=await plan(source,root,options,metadata), controller=new AbortController();
  await assert.rejects(execute(p,controller.signal,progress=>{if(progress.bytes>0) controller.abort();}),{name:'AbortError'});
  assert.equal((await fs.stat(path.join(source,'A.ARW'))).size,data.length);
  assert.equal(await fs.readFile(path.join(root,'keep.txt'),'utf8'),'destination extra');
  assert.deepEqual(await visible(path.dirname(p.entries[0]!.destination)),[]);
});

test('mutation during streaming produces an error without publishing mixed content',async t=>{
  const {source,root,put}=await fixture(t); const file=await put('A.ARW',Buffer.alloc(3*1024*1024,65));
  const p=await plan(source,root,options,metadata); let changed=false;
  const {writeFileSync}=await import('node:fs');
  const result=await execute(p,undefined,progress=>{if(!changed && progress.bytes>0) {changed=true;writeFileSync(file,Buffer.alloc(3*1024*1024,66));}});
  assert.equal(result.copied,0); assert.equal(result.errors.length,1);
  await assert.rejects(fs.stat(p.entries[0]!.destination));
  assert.deepEqual(await visible(path.dirname(p.entries[0]!.destination)),[]);
});

test('destination ancestor substituted after plan cannot redirect writes outside root',async t=>{
  const {base,source,root,put}=await fixture(t); await put('A.JPG');
  const p=await plan(source,root,options,metadata), outside=path.join(base,'outside'); await fs.mkdir(outside);
  await fs.symlink(outside,path.join(root,'2024'),'dir');
  const result=await execute(p); assert.equal(result.copied,0); assert.equal(result.errors.length,1);
  assert.deepEqual(await visible(outside),[]);
});

test('exclusive copy publication verifies files on filesystems without hard links',async t=>{
  const {source,root,put}=await fixture(t); const original=await put('A.JPG','original bytes');
  await fs.writeFile(path.join(root,'keep.txt'),'existing destination data');
  const p=await plan(source,root,options,metadata);
  const result=await execute(p,undefined,undefined,{exclusiveCopy:true});
  assert.deepEqual(result,{copied:1,skipped:0,errors:[]});
  assert.equal(await fs.readFile(p.entries[0]!.destination,'utf8'),'original bytes');
  assert.equal(await fs.readFile(original,'utf8'),'original bytes');
  assert.equal(await fs.readFile(path.join(root,'keep.txt'),'utf8'),'existing destination data');
  assert.deepEqual(await visible(path.dirname(p.entries[0]!.destination)),['A.JPG']);
});

test('interrupted exclusive publication retains intent journal and partial output without touching originals',async t=>{
  const {source,root,put}=await fixture(t); const original=await put('A.JPG','original bytes');
  await fs.writeFile(path.join(root,'keep.txt'),'existing destination data');
  const p=await plan(source,root,options,metadata);
  const filesystem=(await import('node:fs/promises')).default;
  const open=filesystem.open.bind(filesystem);
  t.mock.method(filesystem,'open',async(...args:Parameters<typeof filesystem.open>)=>{const handle=await open(...args);if(String(args[0])===p.entries[0]!.destination&&args[1]==='wx'){const write=handle.write.bind(handle);t.mock.method(handle,'write',async(buffer:Buffer,offset:number,length:number,position:number|null)=>{await write(buffer,offset,Math.min(length,7),position);throw Object.assign(new Error('Simulated removable-volume interruption'),{code:'EIO'});});}return handle;});
  const result=await execute(p,undefined,undefined,{exclusiveCopy:true});
  assert.equal(result.copied,0); assert.equal(result.errors.length,1);
  assert.equal(await fs.readFile(original,'utf8'),'original bytes');
  assert.equal(await fs.readFile(path.join(root,'keep.txt'),'utf8'),'existing destination data');
  assert.equal(await fs.readFile(p.entries[0]!.destination,'utf8'),'origina');
  // Nothing of the app's beside the media: the publication receipt stays open in the records folder's log.
  const remaining=await visible(path.dirname(p.entries[0]!.destination));
  assert.equal(remaining.some(name=>name.startsWith('photo-importer-')||name.endsWith('.partial')),false);
  assert.deepEqual(await fs.readdir(await stagingFor(root)),[],'the staged copy is gone');
  const receipts=[...(await openReceiptsFor(root)).values()].filter(record=>record.kind==='publication');
  assert.equal(receipts.length,1);
  const intent=receipts[0]!;
  assert.equal(intent.source,original); assert.equal(intent.destination,p.entries[0]!.destination); assert.equal(intent.sha256,createHash('sha256').update(await fs.readFile(original)).digest('hex'));
});

test('exclusive fallback loses a destination race without overwriting the winning file',async t=>{
  const {source,root,put}=await fixture(t); const original=await put('A.JPG','original bytes');
  const p=await plan(source,root,options,metadata), reviewed=p.entries[0]!.destination;
  const filesystem=(await import('node:fs/promises')).default, open=filesystem.open.bind(filesystem);
  let raceWon=false;
  t.mock.method(filesystem,'open',async(...args:Parameters<typeof filesystem.open>)=>{if(String(args[0])===reviewed&&args[1]==='wx'&&!raceWon){raceWon=true;await fs.writeFile(reviewed,'other writer!!',{flag:'wx'});}return open(...args);});
  assert.deepEqual(await execute(p,undefined,undefined,{exclusiveCopy:true}),{copied:1,skipped:0,errors:[]});
  assert.equal(await fs.readFile(reviewed,'utf8'),'other writer!!');
  assert.equal(await fs.readFile(original,'utf8'),'original bytes');
  const [conflict]=await visible(path.join(path.dirname(path.dirname(reviewed)),'Conflicts'));assert.ok(conflict);
  assert.equal(await fs.readFile(path.join(path.dirname(path.dirname(reviewed)),'Conflicts',conflict,'JPEG/A.JPG'),'utf8'),'original bytes');
});


test('reviewed library reorganization moves a wrong-folder original only after verification',async t=>{
  const {source,put}=await fixture(t); const original=await put('incoming/A.JPG','original bytes');
  const p=await plan(source,source,{...options,reorganize:true},metadata);
  assert.equal(p.entries[0]?.destination,path.join(source,'2024/202402/Sony A7/JPEG/A.JPG'));
  const result=await executeReorganization(p);
  assert.deepEqual(result,{copied:1,skipped:0,errors:[],moved:1,retained:1,retainedBytes:14});
  await assert.rejects(fs.stat(original));
  assert.equal(await fs.readFile(p.entries[0]!.destination,'utf8'),'original bytes');
});

test('reorganization stashes identical wrong-folder duplicates and retains already organized files',async t=>{
  const {source,put}=await fixture(t); const original=await put('incoming/A.JPG','original bytes');
  const organized=await put('2024/202402/Sony A7/JPEG/A.JPG','original bytes');
  const p=await plan(source,source,{...options,reorganize:true},metadata);
  // The already organized file is not planned at all; only the duplicate is journaled.
  assert.equal(p.entries.length,1);
  const result=await executeReorganization(p);
  assert.deepEqual(result,{copied:0,skipped:1,errors:[],moved:1,retained:1,retainedBytes:14});
  await assert.rejects(fs.stat(original),{code:'ENOENT'});
  assert.equal(await fs.readFile(organized,'utf8'),'original bytes');
});

test('stale reorganization source fails without removing its original',async t=>{
  const {source,put}=await fixture(t); const original=await put('incoming/A.JPG','original bytes');
  const p=await plan(source,source,{...options,reorganize:true},metadata);
  await fs.writeFile(original,'modified bytes');
  const result=await executeReorganization(p);
  assert.equal(result.moved,0); assert.equal(result.retained,0,'nothing moved, so nothing is kept for undo'); assert.equal(result.errors.length,1);
  assert.equal(await fs.readFile(original,'utf8'),'modified bytes');
  await assert.rejects(fs.stat(p.entries[0]!.destination));
});

test('reorganization retains a source whose identity timestamps changed after review',async t=>{
  const {source,put}=await fixture(t); const original=await put('incoming/A.JPG','original bytes');
  const p=await plan(source,source,{...options,reorganize:true},metadata);
  await fs.utimes(original,new Date('2000-01-01T00:00:00Z'),new Date('2000-01-01T00:00:00Z'));
  const result=await executeReorganization(p);
  assert.equal(result.moved,0); assert.equal(result.retained,0,'nothing moved, so nothing is kept for undo'); assert.equal(result.errors.length,1);
  assert.equal(await fs.readFile(original,'utf8'),'original bytes');
});

test('runtime reorganization collision copies to a new name and retains the unreviewed original',async t=>{
  const {source,put}=await fixture(t); const original=await put('incoming/A.JPG','original bytes');
  const p=await plan(source,source,{...options,reorganize:true},metadata);
  await fs.mkdir(path.dirname(p.entries[0]!.destination),{recursive:true});
  await fs.writeFile(p.entries[0]!.destination,'other writer!!');
  const result=await executeReorganization(p);
  // Nothing was moved, so no original is kept for undo; it is still at its source path.
  assert.deepEqual(result,{copied:1,skipped:0,errors:[],moved:0,retained:0,retainedBytes:0});
  assert.equal(await fs.readFile(original,'utf8'),'original bytes');
  assert.equal(await fs.readFile(p.entries[0]!.destination,'utf8'),'other writer!!');
});

test('reorganization requires a reviewed plan for one library and forbids backup mode',async t=>{
  const {source,root,put}=await fixture(t); await put('A.JPG');
  await assert.rejects(plan(source,root,{...options,reorganize:true},metadata),/same|library/i);
  await assert.rejects(plan(source,source,{...options,reorganize:true,backup:true},metadata),/backup|library/i);
  const copy=await plan(source,root,options,metadata);
  await assert.rejects(executeReorganization(copy),/review|reorganization/i);
});

test('source mutation after verified staging is rejected by the publication recheck',async t=>{
 const {source,root,put}=await fixture(t),original=await put('A.JPG','original bytes');
 const prepared=await plan(source,root,options,metadata);
 const filesystem=(await import('node:fs/promises')).default,open=filesystem.open;let changed=false;
 t.mock.method(filesystem,'open',async(...args:Parameters<typeof open>)=>{
  const handle=await open(...args);
  if(String(args[0]).endsWith('.partial')&&(typeof args[1]==='number'||args[1]==='r')){
   const close=handle.close.bind(handle);
   t.mock.method(handle,'close',async()=>{await close();if(!changed){changed=true;await fs.writeFile(original,'modified bytes');}});
  }
  return handle;
 });
 const result=await execute(prepared);assert.equal(changed,true);assert.equal(result.copied,0);assert.equal(result.errors.length,1);
 assert.equal(await fs.readFile(original,'utf8'),'modified bytes');await assert.rejects(fs.stat(prepared.entries[0]!.destination));
 assert.deepEqual(await visible(path.dirname(prepared.entries[0]!.destination)),[]);
});

for(const operation of ['planning','executing'] as const)test(`${operation} a duplicate during staging-link cleanup does not mistake inode metadata changes for changed bytes`,async t=>{
 const {source,root,put}=await fixture(t);await put('.hidden-note','fixture note');
 const prepared=await plan(source,root,{...options,backup:true},metadata),destination=prepared.entries[0].destination;
 const filesystem=(await import('node:fs/promises')).default,open=filesystem.open.bind(filesystem),unlink=filesystem.unlink.bind(filesystem);
 let cleanupStarted=false,cleanupFinished=false,releaseRead!:()=>void,noticeRead!:()=>void;
 const cleaned=new Promise<void>(resolve=>{releaseRead=resolve;}),reading=new Promise<void>(resolve=>{noticeRead=resolve;});
 let concurrent:Promise<{skipped?:number;error?:unknown}>|undefined;
 t.mock.method(filesystem,'open',async(...args:Parameters<typeof filesystem.open>)=>{
  const handle=await open(...args);
  if(String(args[0])===destination){const read=handle.read.bind(handle);t.mock.method(handle,'read',async(...readArgs:Parameters<typeof handle.read>)=>{if(cleanupStarted&&!cleanupFinished){noticeRead();await cleaned;}return read(...readArgs);});}
  return handle;
 });
 t.mock.method(filesystem,'unlink',async(file:Parameters<typeof filesystem.unlink>[0])=>{
  if(!cleanupStarted&&String(file).endsWith('.partial')){
   cleanupStarted=true;
   concurrent=operation==='planning'
    ?plan(source,root,{...options,backup:true},metadata).then(transfer=>({skipped:transfer.entries.filter(entry=>entry.skip).length}),error=>({error}))
    :execute(prepared).then(result=>({skipped:result.skipped,error:result.errors[0]}),error=>({error}));
   // An unlocked planner reaches its first read and pauses until the link is
   // removed. A serialized planner waits for cleanup, so release it shortly.
   let timer:ReturnType<typeof setTimeout>|undefined;
   await Promise.race([reading,new Promise<void>(resolve=>{timer=setTimeout(resolve,150);})]);
   if(timer)clearTimeout(timer);
   await unlink(file);cleanupFinished=true;releaseRead();return;
  }
  return unlink(file);
 });
 assert.deepEqual(await execute(prepared),{copied:1,skipped:0,errors:[]});
 assert.equal(cleanupStarted,true);const result=await concurrent!;
 assert.equal(result.error,undefined);
 assert.equal(result.skipped,1);
 assert.equal(await fs.readFile(destination,'utf8'),'fixture note');
});
