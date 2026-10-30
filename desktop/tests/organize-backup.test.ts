import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { plan, findMisplaced, executeReorganization, configureOrganizationRecovery } from '../core/index';
import type { Metadata } from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options = {backup:false as const, template:'{year}/{yyyymm}/{camera}', layout:'format' as const, unknownRules:{}};
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
  await put('Photo Importer Recovery/0f/originals/1/D.JPG');
  await put('Photo Importer Data/Organizations/0f/originals/1/D.JPG');
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
  const result=await executeReorganization(reviewed,undefined,undefined);
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
  // Only the two misplaced files are read; bytes are reported as they stream, and progress ends at their full size.
  assert.ok(reading.every(item=>item.total===2));assert.deepEqual([...new Set(reading.map(item=>item.count))].sort(),[0,1,2]);
  assert.equal(reading.at(-1)!.count,2);assert.equal(reading.at(-1)!.bytes,reading.at(-1)!.totalBytes);
});

test('a backup-scope review plans only files under the backup folder, never the rest of the destination',async t=>{
  const {root,put}=await fixture(t);
  const destination=path.dirname(root);
  const stray=await put('wrong place/A.JPG');
  const outside=path.join(destination,'Other stuff','B.JPG');await fs.mkdir(path.dirname(outside),{recursive:true});await fs.writeFile(outside,'not part of the backup');
  // With a separate video root, main.ts opens a 'backup' review on the destination with sourceFolders = the backup folders; the whole-destination review has none.
  const scoped=(await plan(destination,[root],{...options,reorganize:true,sourceFolders:[path.basename(root)]},metadata)).plans.flatMap(item=>item.entries.map(entry=>entry.source));
  assert.deepEqual(scoped,[stray]);
  const whole=(await plan(destination,[destination],{...options,reorganize:true},metadata)).plans.flatMap(item=>item.entries.map(entry=>entry.source));
  assert.ok(whole.includes(outside),'the whole destination would have planned the outside file');
});

test('with the default layout the backup library is the backup folder itself, so a review plans only files under it',async t=>{
  const {root,put}=await fixture(t);
  const destination=path.dirname(root);
  const stray=await put('wrong place/A.JPG');
  const outside=path.join(destination,'Other stuff','B.JPG');await fs.mkdir(path.dirname(outside),{recursive:true});await fs.writeFile(outside,'not part of the backup');
  // backupLibrary returns source=<destination>/<basePath> and no sourceFolders for this layout; that source is planned directly.
  const planned=(await plan(root,[root],{...options,reorganize:true},metadata)).plans.flatMap(item=>item.entries.map(entry=>entry.source));
  assert.deepEqual(planned,[stray]);
  assert.ok(!planned.includes(outside));
});

test('main.ts wires the backup-scope review: refuses outside folders, uses the backup library folders, keeps the scope for re-plans',async()=>{
  const source=await fs.readFile(path.join(__dirname,'../main.ts'),'utf8');
  const start=source.indexOf("case 'previewOrganization':"),block=source.slice(start,source.indexOf("case 'applyReview'",start));
  assert.ok(block.includes("input.scope==='backup'")&&block.includes('backupLibrary(prefs)')&&block.includes("error.backupFolderOutside")&&block.includes('library.sourceFolders'),block);
  assert.ok(/backupScope\?sourceFolders:state\.organizationFolders/.test(source),'chosen folders never leak into a backup-scope review');
  assert.ok(source.includes("request.backupScope)state.review.scope='backup'"),'the review remembers its scope for the problem-files toggle');
});

test('main.ts re-plans an open review for this run only with reviewNoMetadata, and the choice survives apply, job and retry',async()=>{
  const source=await fs.readFile(path.join(__dirname,'../main.ts'),'utf8');
  const shared=await fs.readFile(path.join(__dirname,'../shared.ts'),'utf8');
  assert.match(shared,/\{type:'reviewNoMetadata';handling:NoMetadataHandling\}/);
  const start=source.indexOf("case 'reviewFileDate':case 'reviewNoMetadata':");assert.ok(start>0,'one case serves both actions');
  const body=source.slice(start,source.indexOf("\n  }",start));
  assert.match(body,/if\(!reviewed\|\|busy\(\)\|\|state\.busyReview\)break;/);
  assert.match(body,/input\.type==='reviewFileDate'\?'fileDate'/);
  assert.match(body,/useFileDate:true,confirmed:true/);
  assert.match(body,/useFileDate:false,confirmed:true,handling,prefs:\{\.\.\.request\.prefs,noMetadataHandling:handling\}/);
  assert.doesNotMatch(body,/state\.preferences|savePreferences|patchPreferences/);
  assert.match(await fs.readFile(path.join(__dirname,'../review-job.ts'),'utf8'),/noMetadataHandling:prepared\.handling/);
  assert.match(body,/const origin=reviewed\.origin;await openReview\(source,backup,next,destinationIndex\);if\(origin&&reviewed\)reviewed\.origin=origin;/,'a re-plan keeps the job it was parked from');
  assert.match(source,/prefs\.noMetadataHandling=job\.noMetadataHandling/);
  assert.match(source,/prefs:jobPreferences\(job\)/);
  // Retry and Skip share one rerun (the consolidation), so the carried choice has a single place.
  assert.equal(source.match(/next\.noMetadataHandling=failed\.noMetadataHandling/g)?.length,1,'the one rerun keeps it');
  assert.equal(source.match(/\brerun\(failed,/g)?.length,2,'both retry paths go through it');
});
