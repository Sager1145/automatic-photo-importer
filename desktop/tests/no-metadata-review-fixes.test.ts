import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {plan,execute,executeReorganization,findMisplaced,getOrganizationRecovery,undoOrganization,configureOrganizationRecovery} from '../core/index';
import {defaultPreferences} from '../preferences';
import {ruleOptions} from '../routing-options';
import {unknownDecision} from '../unknown-confirm';
import {routingScope} from '../platform/routing-memory';
import {placementScope} from '../platform/placement-memory';
import {validNoMetadataFolder} from '../no-metadata';
import type {Metadata} from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const base={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
async function fixture(t:test.TestContext){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'no-metadata-fixes-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),library=path.join(root,'library');
  await fs.mkdir(source);await fs.mkdir(library);
  const put=async(dir:string,relative:string,contents='x')=>{const file=path.join(dir,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,contents);await fs.utimes(file,new Date('2020-01-01T12:00:00'),new Date('2020-01-01T12:00:00'));return file;};
  return {root,source,library,put};
}
const exists=(file:string)=>fs.lstat(file).then(()=>true,()=>false);
const entries=(found:Awaited<ReturnType<typeof plan>>)=>found.plans.flatMap(item=>[...item.entries,...item.videos?.entries??[]]);
const names=(found:Awaited<ReturnType<typeof plan>>)=>entries(found).map(entry=>path.basename(entry.source)).sort();
const known:Metadata={camera:'Cam',date:'2022-05-06T12:00:00Z',fields:{}};

test('one builder gives every caller the same rules, and each rule changes the routing and placement scopes',()=>{
  const rules=ruleOptions(defaultPreferences);
  assert.equal(rules.noMetadata,'keep');assert.equal(rules.noMetadataFolder,'Unknown files');
  assert.equal(ruleOptions(defaultPreferences,true).noMetadata,'fileDate');
  const scopes=(prefs:typeof defaultPreferences,fileDate=false)=>{const r=ruleOptions(prefs,fileDate);return [routingScope(r),placementScope({...r,basePaths:[]})];};
  const original=scopes(defaultPreferences);
  for(const changed of [{...defaultPreferences,noMetadataHandling:'folder' as const},{...defaultPreferences,noMetadataFolder:'Other name'}])assert.notDeepEqual(scopes(changed),original);
  assert.notDeepEqual(scopes(defaultPreferences,true),original);
});

test('the folder check built from the shared rules does not flag unknown files, legacy Unknown Camera ones included',async t=>{
  const f=await fixture(t);
  await f.put(f.library,'2021/202103/Unknown Camera/NOCAM_1.JPG');await f.put(f.library,'old/SNAP_2.PNG');await f.put(f.library,'old/IMG_3.JPG');
  const meta=async(file:string):Promise<Metadata>=>/NOCAM/.test(file)?{date:'2021-03-04T10:00:00Z',fields:{}}:/SNAP/.test(file)?{fields:{}}:known;
  const flat={...defaultPreferences,mediaLayout:'flat' as const};
  const check=(prefs:typeof defaultPreferences)=>findMisplaced(f.library,f.library,{...ruleOptions({...prefs,mediaLayout:'flat'}),unknownRules:{}},meta);
  assert.deepEqual((await check(flat)).files,['old/IMG_3.JPG']);
  const folder={...flat,noMetadataHandling:'folder' as const};
  assert.deepEqual((await check(folder)).files.sort(),['2021/202103/Unknown Camera/NOCAM_1.JPG','old/IMG_3.JPG','old/SNAP_2.PNG']);
  await f.put(f.library,'Unknown files/old/SNAP_2.PNG');await fs.rm(path.join(f.library,'old/SNAP_2.PNG'));
  assert.ok(!(await check(folder)).files.includes('Unknown files/old/SNAP_2.PNG'));
});

test('an exiftool Error alone does not make a file unknown; with no date and no camera it does',async t=>{
  const f=await fixture(t);
  await f.put(f.source,'IMG_1.JPG');await f.put(f.source,'IMG_2.JPG');
  const found=await plan(f.source,[f.library],{...base,noMetadata:'keep'},async file=>path.basename(file)==='IMG_1.JPG'?{...known,fields:{'ExifTool:Error':'Bad MakerNotes'}}:{fields:{'ExifTool:Error':'File format error'}});
  assert.deepEqual(names(found),['IMG_1.JPG']);
  assert.deepEqual(found.noMetadata?.files.map(item=>[item.relative,item.reason]),[['IMG_2.JPG','unreadable']]);
});

test('a camera-rule file takes its folder context: filed normally beside a dated camera file, unknown when the folder gives nothing',async t=>{
  const f=await fixture(t);
  await f.put(f.source,'DCIM/100NIKON/A.NEF');await f.put(f.source,'DCIM/100NIKON/INDEX01.DSC');
  const alone=path.join(f.root,'alone');await f.put(alone,'LOOSE/INDEX02.DSC');
  const rules={dsc:{action:'camera' as const}};
  const meta=async(file:string):Promise<Metadata>=>file.endsWith('A.NEF')?known:{fields:{}};
  for(const mode of ['keep','folder'] as const){
    const found=await plan(f.source,[f.library],{...base,unknownRules:rules,noMetadata:mode},meta);
    assert.equal(found.noMetadata,undefined,mode);
    const index=entries(found).filter(entry=>entry.source.endsWith('INDEX01.DSC'));
    assert.equal(index.length,1,mode);assert.equal(index[0]!.destination,path.join(f.library,'2022/202205/Cam/INDEX01.DSC'));
    const lone=await plan(alone,[f.library],{...base,unknownRules:rules,noMetadata:mode},meta);
    assert.deepEqual(lone.noMetadata?.files.map(item=>item.relative),['LOOSE/INDEX02.DSC'],mode);
    const loose=entries(lone);
    if(mode==='keep')assert.equal(loose.length,0);else{assert.equal(loose.length,1);assert.equal(loose[0]!.destination,path.join(f.library,'Unknown files/LOOSE/INDEX02.DSC'));}
  }
});

test('names a folder template can produce are refused',()=>{
  for(const name of ['2024','202405','20240506','05','05 May','5 May','2024-05 May','2024-5 Mar','Conflicts','con','a'.repeat(121)])assert.equal(validNoMetadataFolder(name),false,name);
  const taken=['editied','photobackup/raw','videobackup'];
  for(const name of ['editied','EDITIED','photobackup','videobackup'])assert.equal(validNoMetadataFolder(name,taken),false,name);
  assert.equal(validNoMetadataFolder('Unknown files',taken),true);
  for(const name of ['Unknown files','Ohne Datum','2024 trip'])assert.equal(validNoMetadataFolder(name),true,name);
});

for(const mode of ['keep','folder'] as const)test(`families stay whole under ${mode}: Live Photo, GoPro chapters, RAW+JPG`,async t=>{
  const f=await fixture(t);
  for(const name of ['LIVE_A.HEIC','LIVE_A.MOV','LIVE_B.HEIC','LIVE_B.MOV','GX010001.MP4','GX020001.MP4','GL010001.LRV','GX010002.MP4','GX020002.MP4','RAW_A.CR3','RAW_A.JPG','RAW_B.CR3','RAW_B.JPG'])await f.put(f.source,`DCIM/${name}`);
  const meta=async(file:string):Promise<Metadata>=>{
    const name=path.basename(file);
    const dated=['LIVE_B.HEIC','GX010002.MP4','GX020001.MP4','RAW_A.JPG','RAW_B.CR3'];
    const contentId=name.startsWith('LIVE_A')?'A':name.startsWith('LIVE_B')?'B':undefined;
    return dated.includes(name)?{...known,...(contentId?{contentId}:{})}:{fields:{},...(contentId?{contentId}:{})};
  };
  const found=await plan(f.source,[f.library],{...base,noMetadata:mode},meta);
  const unknown=(found.noMetadata?.files.map(item=>path.basename(item.relative))??[]).sort();
  const kept=names(found);
  // Live A and RAW A (primaries without a date) are unknown whole; Live B and RAW B (dated primaries) go on whole.
  // GoPro: the first chapter decides; recording 1 starts undated, recording 2 starts dated.
  const unknownFamilies=['GL010001.LRV','GX010001.MP4','GX020001.MP4','LIVE_A.HEIC','LIVE_A.MOV','RAW_A.CR3','RAW_A.JPG'].sort();
  if(mode==='keep'){assert.deepEqual(unknown,unknownFamilies);assert.deepEqual(kept,['GX010002.MP4','GX020002.MP4','LIVE_B.HEIC','LIVE_B.MOV','RAW_B.CR3','RAW_B.JPG']);}
  else{
    assert.deepEqual(unknown,unknownFamilies);
    assert.deepEqual(kept,[...unknownFamilies,'GX010002.MP4','GX020002.MP4','LIVE_B.HEIC','LIVE_B.MOV','RAW_B.CR3','RAW_B.JPG'].sort());
    const filed=entries(found).filter(entry=>unknownFamilies.includes(path.basename(entry.source)));
    assert.ok(filed.every(entry=>path.dirname(entry.destination)===path.join(f.library,'Unknown files/DCIM')));
  }
});

test('undoing a folder-mode organization puts every file back where it was',async t=>{
  const f=await fixture(t);
  await f.put(f.library,'old/trip/SNAP_1.PNG','snap');await f.put(f.library,'old/IMG_2.JPG','img');await f.put(f.library,'2021/202103/Unknown Camera/NOCAM_3.JPG','nocam');
  const meta=async(file:string):Promise<Metadata>=>/NOCAM/.test(file)?{date:'2021-03-04T10:00:00Z',fields:{}}:/SNAP/.test(file)?{fields:{}}:known;
  const found=await plan(f.library,[f.library],{...base,reorganize:true,noMetadata:'folder'},meta);
  assert.deepEqual((await executeReorganization(found.plans[0]!,undefined,undefined)).errors,[]);
  assert.equal(await exists(path.join(f.library,'Unknown files/old/trip/SNAP_1.PNG')),true);
  const [job]=await getOrganizationRecovery(f.library);
  await undoOrganization(f.library,job!.id);
  assert.equal(await fs.readFile(path.join(f.library,'old/trip/SNAP_1.PNG'),'utf8'),'snap');
  assert.equal(await fs.readFile(path.join(f.library,'2021/202103/Unknown Camera/NOCAM_3.JPG'),'utf8'),'nocam');
  assert.equal(await fs.readFile(path.join(f.library,'old/IMG_2.JPG'),'utf8'),'img');
  assert.equal(await exists(path.join(f.library,'Unknown files/old/trip/SNAP_1.PNG')),false);
});

test('after switching from file dates to the folder, importing the same card again copies nothing',async t=>{
  const f=await fixture(t);
  await f.put(f.source,'DCIM/SNAP_1.PNG','screenshot');
  const meta=async():Promise<Metadata>=>({fields:{}});
  const first=await plan(f.source,[f.library],{...base,noMetadata:'fileDate'},meta);
  assert.deepEqual((await execute(first.plans[0]!,undefined,undefined,{verify:true})).errors,[]);
  const second=await plan(f.source,[f.library],{...base,noMetadata:'folder',lookElsewhere:async()=>true},meta);
  assert.equal(second.elsewhere?.files,1);
  assert.equal((await execute(second.plans[0]!,undefined,undefined,{verify:true})).copied,0);
  assert.equal(await exists(path.join(f.library,'Unknown files/DCIM/SNAP_1.PNG')),false);
});

test('a started job asks first only when nothing else holds the review, and waits its turn otherwise',()=>{
  const ask={found:true,automatic:false,confirmed:false,queuedAutomatically:false,reviewOpen:false,othersRunning:false};
  assert.equal(unknownDecision(ask),'park');
  assert.equal(unknownDecision({...ask,found:false}),'run');
  assert.equal(unknownDecision({...ask,automatic:true}),'run');
  assert.equal(unknownDecision({...ask,queuedAutomatically:true}),'run');
  assert.equal(unknownDecision({...ask,confirmed:true}),'run');
  assert.equal(unknownDecision({...ask,reviewOpen:true}),'defer','a review is already open: no second one over it');
  assert.equal(unknownDecision({...ask,othersRunning:true}),'defer','another job is running: a review cannot start over it');
  assert.equal(unknownDecision({...ask,reviewOpen:true,automatic:true}),'run');
});
