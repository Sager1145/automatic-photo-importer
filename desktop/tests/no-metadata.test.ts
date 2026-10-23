import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {plan,execute,executeReorganization,findMisplaced,configureOrganizationRecovery} from '../core/index';
import {validNoMetadataFolder} from '../no-metadata';
import {safeComponent} from '../core/paths';
import type {Metadata} from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const base={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
// SNAP: nothing. NOCAM: a date but no camera. SHOT: a date and a known origin (Screenshots), no camera. BROKEN: cannot be read.
const metadata=async(file:string):Promise<Metadata>=>{
  const name=path.basename(file);
  if(name.includes('BROKEN'))throw new Error('Cannot read file');
  if(name.includes('SNAP'))return {fields:{}};
  if(name.includes('NOCAM'))return {date:'2021-03-04T10:00:00Z',fields:{}};
  if(name.includes('SHOT'))return {date:'2021-03-04T10:00:00Z',origin:'Screenshots',fields:{}};
  return {camera:'Cam',date:'2022-05-06T12:00:00Z',fields:{}};
};
async function fixture(t:test.TestContext){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'no-metadata-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),library=path.join(root,'library'),videos=path.join(root,'videos');
  for(const dir of [source,library,videos])await fs.mkdir(dir);
  const put=async(dir:string,relative:string,contents:string)=>{const file=path.join(dir,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,contents);await fs.utimes(file,new Date('2020-01-01T12:00:00'),new Date('2020-01-01T12:00:00'));return file;};
  return {root,source,library,videos,put};
}
const exists=(file:string)=>fs.lstat(file).then(()=>true,()=>false);
const entries=(found:Awaited<ReturnType<typeof plan>>)=>found.plans.flatMap(item=>[...item.entries,...item.videos?.entries??[]]);
const sources=(found:Awaited<ReturnType<typeof plan>>)=>entries(found).map(entry=>path.basename(entry.source)).sort();

test('import keep: unknown files are not copied, known origins are, and nothing unverified is claimed',async t=>{
  const f=await fixture(t);
  await f.put(f.source,'DCIM/IMG_1.JPG','dated');await f.put(f.source,'DCIM/NOCAM_2.JPG','no camera');await f.put(f.source,'DCIM/SNAP_3.PNG','screenshot');await f.put(f.source,'DCIM/SHOT_4.PNG','shot');await f.put(f.source,'DCIM/BROKEN_5.JPG','zzz');
  const found=await plan(f.source,[f.library],{...base,noMetadata:'keep'},metadata);
  assert.deepEqual(sources(found),['IMG_1.JPG','SHOT_4.PNG']);
  assert.deepEqual(found.noMetadata?.files.map(item=>[item.relative,item.reason]).sort(),[['DCIM/BROKEN_5.JPG','unreadable'],['DCIM/NOCAM_2.JPG','noCamera'],['DCIM/SNAP_3.PNG','noDate']]);
  assert.deepEqual(found.noMetadata?.counts,{noDate:1,noCamera:1,unreadable:1});
  assert.equal(found.noMetadata?.count,3);
  assert.equal(found.noMetadata?.handling,'keep');
  assert.ok(entries(found).find(entry=>entry.source.endsWith('SHOT_4.PNG'))!.destination.includes(path.join('2021','202103','Screenshots')));
  const verified:string[]=[];
  const result=await execute(found.plans[0]!,undefined,undefined,{verify:true,onVerified:source=>verified.push(path.basename(source))});
  assert.deepEqual(result.errors,[]);
  assert.deepEqual(verified.sort(),['IMG_1.JPG','SHOT_4.PNG']);
  for(const name of ['NOCAM_2.JPG','SNAP_3.PNG','BROKEN_5.JPG'])assert.equal(await exists(path.join(f.source,'DCIM',name)),true);
});

test('a companion follows its primary in both directions',async t=>{
  const f=await fixture(t);
  await f.put(f.source,'SNAP_A.CR3','raw');await f.put(f.source,'SNAP_A.xmp','side');
  await f.put(f.source,'IMG_B.CR3','raw');await f.put(f.source,'IMG_B.xmp','side');
  const found=await plan(f.source,[f.library],{...base,noMetadata:'keep'},async file=>path.basename(file)==='IMG_B.CR3'?{camera:'Cam',date:'2022-05-06T12:00:00Z',fields:{}}:{fields:{}});
  assert.deepEqual(found.noMetadata?.files.map(item=>item.relative).sort(),['SNAP_A.CR3','SNAP_A.xmp']);
  assert.deepEqual(sources(found),['IMG_B.CR3','IMG_B.xmp']);
});

test('fileDate and an unset option file by file time, and no folder is ever called Unknown Camera',async t=>{
  const f=await fixture(t);
  await f.put(f.source,'SNAP_1.PNG','screenshot');await f.put(f.source,'NOCAM_2.JPG','no camera');
  for(const noMetadata of ['fileDate' as const,undefined]){
    const found=await plan(f.source,[f.library],{...base,...(noMetadata?{noMetadata}:{})},metadata);
    assert.deepEqual(sources(found),['NOCAM_2.JPG','SNAP_1.PNG']);
    assert.equal(found.noMetadata,undefined);
    const snap=entries(found).find(entry=>entry.source.endsWith('SNAP_1.PNG'))!;
    assert.ok(snap.destination.includes(path.join('2020','202001')));
    for(const entry of entries(found))assert.ok(!/unknown camera/i.test(entry.destination),entry.destination);
  }
  assert.equal(safeComponent(''),'Unknown files');
});

test('import folder files unknown files under the default name, and under the video root for videos',async t=>{
  const f=await fixture(t);
  await f.put(f.source,'DCIM/SNAP_1.PNG','screenshot');await f.put(f.source,'DCIM/SNAP_2.MP4','clip');await f.put(f.source,'DCIM/NOCAM_3.JPG','no camera');await f.put(f.source,'DCIM/IMG_4.JPG','dated');
  const found=await plan(f.source,[f.library],{...base,layout:'video-root' as const,videoRoots:[f.videos],noMetadata:'folder'},metadata);
  const photo=found.plans[0]!.entries.find(entry=>entry.source.endsWith('SNAP_1.PNG'))!,video=found.plans[0]!.videos!.entries.find(entry=>entry.source.endsWith('SNAP_2.MP4'))!,nocam=found.plans[0]!.entries.find(entry=>entry.source.endsWith('NOCAM_3.JPG'))!;
  assert.equal(photo.destination,path.join(f.library,'Unknown files/DCIM/SNAP_1.PNG'));
  assert.equal(nocam.destination,path.join(f.library,'Unknown files/DCIM/NOCAM_3.JPG'));
  assert.equal(video.destination,path.join(f.videos,'Unknown files/DCIM/SNAP_2.MP4'));
  assert.equal(found.noMetadata?.count,3);assert.equal(found.noMetadata?.folder,'Unknown files');
  const result=await execute(found.plans[0]!,undefined,undefined,{verify:true});
  assert.deepEqual(result.errors,[]);
  assert.equal(await fs.readFile(photo.destination,'utf8'),'screenshot');
});

test('organization keep leaves unknown files where they are, and the misplaced check accepts them, legacy Unknown Camera folders included',async t=>{
  const f=await fixture(t);
  const snap=await f.put(f.library,'old/SNAP_1.PNG','screenshot');await f.put(f.library,'old/IMG_2.JPG','dated');
  const legacy=await f.put(f.library,'2021/202103/Unknown Camera/NOCAM_3.JPG','no camera');
  const options={...base,reorganize:true,noMetadata:'keep' as const};
  const found=await plan(f.library,[f.library],options,metadata);
  assert.deepEqual(sources(found),['IMG_2.JPG']);
  assert.equal(found.noMetadata?.count,2);
  const result=await executeReorganization(found.plans[0]!,undefined,undefined,{strategy:'rename'});
  assert.deepEqual(result.errors,[]);
  assert.equal(await fs.readFile(snap,'utf8'),'screenshot');assert.equal(await exists(legacy),true);
  assert.equal(await exists(path.join(f.library,'2022/202205/Cam/IMG_2.JPG')),true);
  const again=await findMisplaced(f.library,f.library,{template:base.template,layout:base.layout,unknownRules:{},noMetadata:'keep'},metadata);
  assert.equal(again.count,0);
});

test('organization folder moves unknown files under the named folder, removes emptied Unknown Camera folders, and is stable',async t=>{
  const f=await fixture(t);
  await f.put(f.library,'old/trip/SNAP_1.PNG','screenshot');await f.put(f.library,'old/IMG_2.JPG','dated');
  await f.put(f.library,'2021/202103/Unknown Camera/NOCAM_3.JPG','no camera');
  const options={...base,reorganize:true,noMetadata:'folder' as const,noMetadataFolder:'Not dated'};
  const found=await plan(f.library,[f.library],options,metadata);
  assert.equal(found.noMetadata?.folder,'Not dated');
  const result=await executeReorganization(found.plans[0]!,undefined,undefined,{strategy:'rename'});
  assert.deepEqual(result.errors,[]);
  assert.equal(await fs.readFile(path.join(f.library,'Not dated/old/trip/SNAP_1.PNG'),'utf8'),'screenshot');
  assert.equal(await fs.readFile(path.join(f.library,'Not dated/2021/202103/NOCAM_3.JPG'),'utf8'),'no camera');
  assert.equal(await exists(path.join(f.library,'2021/202103/Unknown Camera')),false,'the emptied legacy folder is removed');
  const again=await findMisplaced(f.library,f.library,{template:base.template,layout:base.layout,unknownRules:{},noMetadata:'folder',noMetadataFolder:'Not dated'},metadata);
  assert.equal(again.count,0);
  assert.deepEqual(sources(await plan(f.library,[f.library],options,metadata)),[]);
});

test('the folder name must be one safe folder name',async t=>{
  const f=await fixture(t);
  await f.put(f.source,'SNAP_1.PNG','screenshot');
  for(const name of ['','  ','..','a/b','a\\b','{year}','Conflicts','Problem files','Drive backups','Unknown Camera'])
    await assert.rejects(plan(f.source,[f.library],{...base,noMetadata:'folder',noMetadataFolder:name},metadata),/safe folder name/,JSON.stringify(name));
  assert.equal(validNoMetadataFolder('Unknown files'),true);assert.equal(validNoMetadataFolder('Ohne Datum'),true);
  // A name is only checked when it is used.
  await plan(f.source,[f.library],{...base,noMetadata:'keep',noMetadataFolder:'..'},metadata);
});
