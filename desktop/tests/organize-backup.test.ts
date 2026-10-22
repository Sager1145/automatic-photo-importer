import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { plan, findMisplaced, executeReorganization, configureOrganizationRecovery } from '../core/index';
import type { Metadata } from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options = {backup:false, template:'{year}/{yyyymm}/{camera}', layout:'format' as const, unknownRules:{}};
const metadata = async ():Promise<Metadata> => ({camera:'Sony A7',date:'2024-02-03T12:00:00Z',fields:{}});
async function fixture(t:test.TestContext) {
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'photo-backup-organize-')));
  t.after(async()=>{await fs.chmod(base,0o755).catch(()=>{});await fs.rm(base,{recursive:true,force:true});});
  const root=path.join(base,'photobackup');await fs.mkdir(root);
  const put=async (relative:string, contents='bytes of '+relative)=>{const p=path.join(root,relative); await fs.mkdir(path.dirname(p),{recursive:true}); await fs.writeFile(p,contents); return p;};
  return {root,put};
}

test('the misplaced check counts only backup files outside the folder the rules give them',async t=>{
  const {root,put}=await fixture(t);
  await put('wrong place/A.JPG');
  await put('2024/202402/Sony A7/JPEG/B.JPG');
  const found=await findMisplaced(root,root,options,metadata);
  assert.deepEqual(found.files,['wrong place/A.JPG']);
  assert.equal(found.count,1);
  assert.equal(found.bytes,'bytes of wrong place/A.JPG'.length);
});

test('conflict copies, drive backups and the recovery store are never counted or moved',async t=>{
  const {root,put}=await fixture(t);
  await put('2024/202402/Sony A7/JPEG/Conflicts/abc123/A.JPG');
  await put('Drive backups/Card 1/DCIM/C.JPG');
  await put('.photo-importer-recovery/0f/originals/1/D.JPG');
  assert.equal((await findMisplaced(root,root,options,metadata)).count,0);
  const reviewed=(await plan(root,[root],{...options,reorganize:true},metadata)).plans[0]!;
  assert.deepEqual(reviewed.entries,[]);
});

test('organizing the backup folder moves misplaced files without reading organized ones',async t=>{
  const {root,put}=await fixture(t);
  const stray=await put('wrong place/A.JPG');
  const organized=await put('2024/202402/Sony A7/JPEG/B.JPG');
  // An unreadable organized file proves planning never opens files that stay where they are.
  await fs.chmod(organized,0o000);
  t.after(()=>fs.chmod(organized,0o644).catch(()=>{}));
  const reviewed=(await plan(root,[root],{...options,reorganize:true},metadata)).plans[0]!;
  assert.deepEqual(reviewed.entries.map(entry=>entry.source),[stray]);
  const result=await executeReorganization(reviewed,undefined,undefined,{strategy:'rename'});
  assert.equal(result.moved,1);assert.deepEqual(result.errors,[]);
  assert.equal(await fs.readFile(path.join(root,'2024/202402/Sony A7/JPEG/A.JPG'),'utf8'),'bytes of wrong place/A.JPG');
  await assert.rejects(fs.stat(stray),{code:'ENOENT'});
});

test('organization planning reports files checked and files read out of their totals',async t=>{
  const {root,put}=await fixture(t);
  await put('wrong place/A.JPG');await put('wrong place/C.JPG');
  await put('2024/202402/Sony A7/JPEG/B.JPG');
  const seen:{count:number;step?:string;total?:number;bytes?:number;totalBytes?:number}[]=[];
  await plan(root,[root],{...options,reorganize:true},metadata,undefined,(count,_file,detail)=>seen.push({count,...detail}));
  const checking=seen.filter(item=>item.step==='checking'),reading=seen.filter(item=>item.step==='reading');
  assert.deepEqual(checking.map(item=>item.total),[3,3,3]);
  assert.deepEqual(checking.map(item=>item.count).sort(),[1,2,3]);
  assert.equal(checking.at(-1)!.bytes,checking.at(-1)!.totalBytes);
  // Only the two misplaced files are read, and progress ends at their full size.
  assert.deepEqual(reading.map(item=>item.total),[2,2]);
  assert.equal(reading.at(-1)!.count,2);assert.equal(reading.at(-1)!.bytes,reading.at(-1)!.totalBytes);
});
