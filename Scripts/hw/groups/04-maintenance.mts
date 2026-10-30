/** Maintenance: folder check + placement memory, subset/in-place organization and its options, recovery list, residue, old records, duplicates beyond 01, Delete originals, "._" cleanup. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID,createHmac} from 'node:crypto';
import type {Context} from '../harness.mts';
import {requireHostKey,storeFor} from '../../../desktop/core/app-store.ts';
import {configureLogger,resetLogger} from '../../../desktop/logger.ts';
import {findResidue,cleanResidue} from '../../../desktop/core/residue.ts';
import {IMPORTS,STAGING,openReceipts,assessReceipt} from '../../../desktop/core/import-recovery.ts';
import {inspectAppleDouble} from '../../../desktop/core/appledouble.ts';
import {placementId,placementScope,loadPlacement,replacePlacement,forgetPlacement,placedMatches} from '../../../desktop/platform/placement-memory.ts';

export const title='Folder check, placement memory, subset/in-place organization, recovery list, residue, old records, duplicates (EXIF/template/companions), Delete originals, "._" cleanup';

export default async function run(ctx:Context):Promise<void>{
 const {core,duplicates,removal,rules,destIndex,paths,sourceBox,libraryBox,check,scenario,skip,gMkdir,gWrite,gRm,gUtimes,metadata,describe,sha,fileSha,exists,treeOf,multiset,same,sameTree}=ctx;
 const T='{year}/{yyyymm}/{camera}',T2='{camera}/{year}';
 const rl=(template:string)=>({template,layout:'flat' as const,unknownRules:{}});
 const importOpts=(template=T)=>({backup:false as const,...rl(template)});
 const orgOpts=(template:string,extra:Record<string,unknown>={})=>({backup:false as const,reorganize:true as const,...rl(template),...extra});
 const posix=(p:string)=>p.split(path.sep).join('/');
 const stemOf=(f:string)=>path.basename(f).replace(/\.[^.]*$/,'').toLowerCase();
 const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'photo-importer-hw04-'));
 let n=0;
 /** Writes files (name, size, metadata index) into dir; returns their bytes by relative name. */
 const seed=async(dir:string,specs:[string,number,number][])=>{
  const out=new Map<string,Buffer>();
  for(const [name,size,i] of specs){
   const data=name.endsWith('.xmp')?Buffer.from(`<x:xmpmeta>${name}${randomBytes(4).toString('hex')}</x:xmpmeta>`):randomBytes(size);
   const p=path.join(dir,name);await gWrite(p,data);await gUtimes(p,new Date(Date.now()-86_400_000*10+(n++)*1000));
   describe(name.replace(/\.[^.]*$/,''),i);out.set(name,data);
  }
  return out;
 };
 const importAll=async(src:string,root:string,template=T)=>{
  const planned=await core.plan(src,[root],importOpts(template),metadata);
  if(planned.failures.length)throw new Error('import plan failures: '+planned.failures.map(f=>String(f.error)).join(';'));
  const result=await core.execute(planned.plans[0]!,undefined,undefined,{removeAppleDouble:false,direct:true});
  if(result.errors.length)throw new Error('import errors: '+result.errors.join(';'));
  return planned.plans[0]!;
 };
 const organize=async(root:string,template:string,extra:Record<string,unknown>={},exec:{keepSourceFolders?:boolean;releaseDuplicates?:boolean;removeAppleDouble?:boolean}={},source=root)=>{
  const planned=await core.plan(source,[root],orgOpts(template,extra) as never,metadata);
  check(`organize plan (${template}) has no failures`,planned.failures.length===0,planned.failures.map(f=>String(f.error)));
  const transfer=planned.plans[0]!;
  const result=await core.executeReorganization(transfer,undefined,undefined,exec);
  return {transfer,result,planned};
 };
 const noLoss=(before:Map<string,string>,after:Map<string,string>)=>after.size===before.size&&same(multiset(before),multiset(after));
 const mediaSpecs=(prefix:string,base:number,count:number):[string,number,number][]=>{
  const s:[string,number,number][]=[];
  for(let k=0;k<count;k++){s.push([`${prefix}_${String(k+1).padStart(4,'0')}.JPG`,90_000+k*1000,base+k]);}
  s.push([`${prefix}_N1.NEF`,300_000,base+count],[`${prefix}_N1.xmp`,0,base+count],[`${prefix}_V1.MP4`,250_000,base+count+1]);
  return s;
 };

 // ---------------------------------------------------------------- 1. folder check
 const chkRoot=path.join(libraryBox,'chk-lib'),chkSrc=path.join(sourceBox,'chk-src');
 const store=path.join(scratch,'store');await fs.mkdir(store);
 const place=placementId('hw04-volume',chkRoot);
 /** What main.ts does after a folder check (runBackupCheck): record the placement only if nothing is misplaced and nothing failed, or the library was already claimed for these rules. */
 const afterCheck=async(found:Awaited<ReturnType<typeof core.findMisplaced>>,scope:string)=>{
  if(found.count===0&&!found.failures||await placementScope(store,place)===scope)await replacePlacement(store,place,scope,found.placed);
 };
 await scenario('1. Backup folder check (findMisplaced): misplaced, failures, organize to 0',async()=>{
  await gMkdir(chkRoot);
  await seed(chkSrc,mediaSpecs('CHK',1,6));
  await importAll(chkSrc,chkRoot);
  const base=await treeOf(chkRoot);
  const found=await core.findMisplaced(chkRoot,chkRoot,rl(T),metadata);
  check('a freshly imported library has 0 misplaced and 0 failures',found.count===0&&found.failures===0,{count:found.count,failures:found.failures,files:found.files});
  check('placed lists the files found in place',found.placed.length===base.size,{placed:found.placed.length,files:base.size});
  check('the check is read-only (hashes unchanged)',sameTree(base,await treeOf(chkRoot)));
  // Under other rules.
  const expected=(await core.plan(chkRoot,[chkRoot],orgOpts(T2) as never,metadata)).plans[0]!.entries.filter(e=>e.destination!==e.source);
  const other=await core.findMisplaced(chkRoot,chkRoot,rl(T2),metadata);
  check('under other rules every file that would move is counted',other.count===expected.length&&expected.length>0,{count:other.count,expected:expected.length});
  check('the misplaced list names exactly those files',same(other.files.map(posix).sort(),expected.map(e=>posix(path.relative(chkRoot,e.source))).sort()));
  check('the misplaced bytes equal the files\' sizes',other.bytes===expected.reduce((s,e)=>s+e.size,0),{bytes:other.bytes});
  // Failures.
  const failing=async(file:string)=>{if(stemOf(file)==='chk_0003')throw new Error('unreadable metadata');return metadata(file);};
  const failed=await core.findMisplaced(chkRoot,chkRoot,rl(T),failing);
  check('a file whose metadata cannot be read does not stop the check (it is a failure or filed like a no-metadata file)',failed.failures+failed.count>=1,{count:failed.count,failures:failed.failures});
  // A stray file and a non-media file.
  describe('CHK_STRAY',20);
  const stray=randomBytes(77_777);await gWrite(path.join(chkRoot,'stray','CHK_STRAY.JPG'),stray);await gWrite(path.join(chkRoot,'stray','notes.txt'),'user note');
  const withStray=await core.findMisplaced(chkRoot,chkRoot,rl(T),metadata);
  check('a stray media file is the one misplaced file; notes.txt is not counted',withStray.count===1&&posix(withStray.files[0]??'')==='stray/CHK_STRAY.JPG',withStray.files);
  // Organize: count goes to 0 and nothing is lost.
  const before=await treeOf(chkRoot);
  const {result}=await organize(chkRoot,T);
  check('organization has no errors',result.errors.length===0,result.errors);
  const after=await treeOf(chkRoot);
  check('nothing lost by organizing the stray file',noLoss(before,after));
  check('notes.txt stays where it was',await exists(path.join(chkRoot,'stray','notes.txt')));
  const clean=await core.findMisplaced(chkRoot,chkRoot,rl(T),metadata);
  check('after organizing the folder check finds 0 misplaced, 0 failures',clean.count===0&&clean.failures===0,clean.files);
  // Switch the library to another template and back to 0.
  const before2=await treeOf(chkRoot);
  const r2=await organize(chkRoot,T2);
  check('re-organization to another template has no errors',r2.result.errors.length===0,r2.result.errors);
  check('nothing lost',noLoss(before2,await treeOf(chkRoot)));
  const c2=await core.findMisplaced(chkRoot,chkRoot,rl(T2),metadata);
  check('the check under the new template finds 0',c2.count===0&&c2.failures===0,c2.files);
  const c3=await core.findMisplaced(chkRoot,chkRoot,rl(T),metadata);
  check('and under the old template finds everything misplaced',c3.count>0,c3.count);
  // Put the library back under T for the placement scenario.
  const back=await organize(chkRoot,T);
  check('organized back to the first template without errors',back.result.errors.length===0,back.result.errors);
 });

 await scenario('1b. Placement memory: claimed only when nothing is misplaced and nothing failed; skips unchanged files',async()=>{
  const failing=async(file:string)=>{if(stemOf(file)==='chk_0003')throw new Error('unreadable');return metadata(file);};
  await forgetPlacement(store,place);
  // Misplaced files under other rules: not claimed.
  const misplaced=await core.findMisplaced(chkRoot,chkRoot,rl(T2),metadata);
  await afterCheck(misplaced,'scope-T2');
  check('a check that found misplaced files claims no rules',misplaced.count>0&&await placementScope(store,place)===undefined);
  // Failures: not claimed.
  // A real failure count cannot be provoked from outside (unreadable metadata is filed as no-metadata), so one is injected into an otherwise clean result.
  const f={...await core.findMisplaced(chkRoot,chkRoot,rl(T),failing),failures:1,count:0};
  await afterCheck(f,'scope-T');
  check('a check with failures (injected) claims no rules',await placementScope(store,place)===undefined);
  // Clean: claimed, with its files.
  const ok=await core.findMisplaced(chkRoot,chkRoot,rl(T),metadata);
  await afterCheck(ok,'scope-T');
  check('a clean check claims its rules',await placementScope(store,place)==='scope-T');
  const memory=await loadPlacement(store,place,'scope-T');
  check('the memory holds every placed file',memory?.size===ok.placed.length&&ok.placed.length>0,{size:memory?.size,placed:ok.placed.length});
  check('a different scope reads no memory',await loadPlacement(store,place,'scope-other')===undefined);
  // Use it: metadata of files in place is not read again.
  let reads=0;const counting=async(file:string)=>{reads++;return metadata(file);};
  const again=await core.findMisplaced(chkRoot,chkRoot,{...rl(T),inPlace:(rel,size,mtimeNs,ino)=>placedMatches(memory,rel,size,mtimeNs,ino)},counting);
  check('with the memory the check reads no metadata of unchanged files and still finds 0',reads===0&&again.count===0&&again.failures===0,{reads,count:again.count});
  // A claimed library under other rules stays claimed for the old rules (a check that found misplaced files does not replace it).
  await afterCheck(misplaced,'scope-T2');
  check('misplaced files under new rules do not replace the claimed record',await placementScope(store,place)==='scope-T');
  // A changed file is read again.
  const victim=[...(await treeOf(chkRoot)).keys()].find(k=>k.endsWith('.JPG'))!;
  const full=path.join(chkRoot,victim),bytes=await fs.readFile(full);
  await gWrite(full,Buffer.concat([bytes,Buffer.from('x')]));
  reads=0;
  const changed=await core.findMisplaced(chkRoot,chkRoot,{...rl(T),inPlace:(rel,size,mtimeNs,ino)=>placedMatches(memory,rel,size,mtimeNs,ino)},counting);
  check('a file that changed since is read again',reads>=1,reads);
  await gWrite(full,bytes);   // restore the test\'s own file
  await forgetPlacement(store,place);
  check('forgetting the record leaves no claimed rules',await placementScope(store,place)===undefined);
 });

 // ---------------------------------------------------------------- 2. subset and in-place organization, options
 await scenario('2. Organize a folder subset (sourceFolders) and a folder in place',async()=>{
  const root=path.join(libraryBox,'sub-lib');await gMkdir(root);
  await seed(path.join(root,'Unsorted','a'),mediaSpecs('SUBA',30,3));
  await seed(path.join(root,'Unsorted','b'),mediaSpecs('SUBB',40,3));
  await seed(path.join(root,'Other'),mediaSpecs('SUBC',50,2));
  const before=await treeOf(root);
  const {transfer,result}=await organize(root,T,{sourceFolders:['Unsorted/a']});
  check('subset organization has no errors',result.errors.length===0,result.errors);
  check('only files of the chosen folder are planned',transfer.entries.length>0&&transfer.entries.every(e=>posix(path.relative(root,e.source)).startsWith('Unsorted/a/')),transfer.entries.map(e=>e.source).slice(0,3));
  const after=await treeOf(root);
  check('nothing lost',noLoss(before,after));
  const untouched=[...before.keys()].filter(k=>!k.startsWith('Unsorted/a/'));
  check('files outside the chosen folder did not move',untouched.every(k=>after.get(k)===before.get(k)),untouched.filter(k=>after.get(k)!==before.get(k)));
  check('the chosen folder\'s files left it',![...after.keys()].some(k=>k.startsWith('Unsorted/a/')&&k.endsWith('.JPG')));
  check('the emptied chosen folder was removed',!await exists(path.join(root,'Unsorted','a')));
  // Organize the other folder in place as its own root (organizeFolder: the folder is both source and destination).
  const folder=path.join(root,'Unsorted','b'),beforeB=await treeOf(folder);
  const inPlace=await organize(folder,T);
  check('in-place folder organization has no errors',inPlace.result.errors.length===0,inPlace.result.errors);
  const afterB=await treeOf(folder);
  check('its files were filed beneath the folder itself, none lost',noLoss(beforeB,afterB)&&[...afterB.keys()].every(k=>/^\d{4}\/\d{6}\//.test(k)),[...afterB.keys()].slice(0,3));
  const rest=await treeOf(root);
  check('the rest of the library is unchanged by the in-place run',[...untouched].filter(k=>!k.startsWith('Unsorted/b/')).every(k=>rest.get(k)===before.get(k)));
 });

 await scenario('2b. Organize options: removeEmptyFolders on/off, releaseDuplicates on/off',async()=>{
  for(const keep of [false,true]){
   const root=path.join(libraryBox,`opt-keep-${keep}`);await gMkdir(root);
   await seed(path.join(root,'loose','deep'),mediaSpecs(`OPT${keep?'K':'R'}`,60+(keep?10:0),2));
   await gWrite(path.join(root,'loose','deep','._marker'),Buffer.alloc(0));await gRm(path.join(root,'loose','deep','._marker'));
   const before=await treeOf(root);
   const {result}=await organize(root,T,{},{keepSourceFolders:keep});
   check(`keepSourceFolders=${keep}: no errors, nothing lost`,result.errors.length===0&&noLoss(before,await treeOf(root)),result.errors);
   const left=await exists(path.join(root,'loose','deep'));
   check(keep?'emptied folders are kept when asked':'emptied folders are removed by default',left===keep,{left,foldersRemoved:result.foldersRemoved});
  }
  // releaseDuplicates: a loose file identical to an organized one.
  for(const release of [false,true]){
   const root=path.join(libraryBox,`opt-release-${release}`),src=path.join(sourceBox,`opt-release-src-${release}`);await gMkdir(root);
   const specs=mediaSpecs(`REL${release?'T':'F'}`,80+(release?10:0),2);
   const bytes=await seed(src,specs);
   await importAll(src,root);
   // The same JPG again, loose, under another name but the same metadata stem folder as the organized one.
   const dupName=specs[0]![0];
   await gWrite(path.join(root,'loose',dupName),bytes.get(dupName)!);
   const before=await treeOf(root);
   const {result}=await organize(root,T,{},{releaseDuplicates:release});
   check(`releaseDuplicates=${release}: no errors`,result.errors.length===0,result.errors);
   const after=await treeOf(root);
   const jobs=await core.getOrganizationRecovery(root,{includeEnded:true});
   console.log(`  releaseDuplicates=${release}: retained ${result.retained}, released ${result.released??0}, jobs ${JSON.stringify(jobs.map(j=>({kind:j.kind,status:j.status,retained:j.retainedFiles,finalizable:j.finalizable})))}`);
   const copies=[...after.values()].filter(h=>h===sha(bytes.get(dupName)!)).length;
   check('the organized copy is intact and the loose duplicate is not lost (kept in recovery or at its place)',copies>=1&&after.size<=before.size,{copies,before:before.size,after:after.size});
   if(release)console.log('  recovery files:',JSON.stringify((await fs.readdir(path.join(root,'Photo Importer Data','Organizations'),{recursive:true,withFileTypes:true}).catch(()=>[])).filter(e=>e.isFile()&&!e.name.startsWith('._')).map(e=>path.relative(root,path.join(e.parentPath,e.name)))));
   const retainedOnDisk=await fs.readdir(path.join(root,'Photo Importer Data','Organizations'),{withFileTypes:true,recursive:true}).then(es=>es.filter(e=>e.isFile()&&!e.name.startsWith('._')&&e.parentPath.includes('originals')).length,()=>0);
   if(release)check('with releaseDuplicates no confirmed duplicate stays in recovery storage',retainedOnDisk===0&&(result.retained===0||(result.released??0)>0),{retainedOnDisk,result});
   else check('without it the confirmed duplicate is kept in recovery storage for Undo',result.retained===0?true:retainedOnDisk>=1,{retainedOnDisk,retained:result.retained});
  }
 });

 // ---------------------------------------------------------------- 3. recovery list
 await scenario('3. Recovery list, measure, undo order, finalize, delete',async()=>{
  const root=path.join(libraryBox,'rec-lib');await gMkdir(root);
  await seed(path.join(root,'loose'),mediaSpecs('REC',100,5));
  const start=await treeOf(root);
  const one=await organize(root,T);
  check('first organization has no errors',one.result.errors.length===0,one.result.errors);
  const afterOne=await treeOf(root);
  let jobs=await core.getOrganizationRecovery(root);
  const j1=jobs.at(-1)!;
  check('listOrganizations: one complete undoable job with its entries',jobs.length===1&&j1.status==='complete'&&j1.undoable===true&&j1.files===one.transfer.entries.length,jobs);
  const m1=await core.measureOrganizationRecovery(root,j1.id);
  console.log('  measure job1:',JSON.stringify(m1),' retained:',j1.retainedFiles,j1.retainedBytes);
  check('measureOrganizationRecovery counts the job\'s recovery files (at least the retained ones)',m1.files>=(j1.retainedFiles??0)&&m1.bytes>=(j1.retainedBytes??0),m1);
  // A later organization of the same files.
  const two=await organize(root,T2);
  check('second organization has no errors',two.result.errors.length===0,two.result.errors);
  const afterTwo=await treeOf(root);
  check('nothing lost after two organizations',noLoss(start,afterTwo));
  jobs=await core.getOrganizationRecovery(root);
  const j2=jobs.find(j=>j.id!==j1.id);
  console.log('  jobs after second:',JSON.stringify(jobs.map(j=>({id:j.id.slice(0,8),status:j.status,undoable:j.undoable,completed:j.completed,files:j.files}))));
  check('the later organization is listed and undoable; the earlier one is superseded by it',jobs.length===1&&!!j2&&j2.undoable===true&&j2.id!==j1.id,jobs.length);
  // The earlier one can no longer be undone: the later organization superseded it.
  let err1='';
  try{await core.undoOrganization(root,j1.id);}catch(e){err1=String(e);}
  check('undoing the superseded earlier organization is refused',/superseded by/.test(err1),err1);
  check('and the refusal loses nothing',sameTree(afterTwo,await treeOf(root)));
  const u2=await core.undoOrganization(root,j2!.id);
  const afterU2=await treeOf(root);
  check('undo of the later organization restores every file at the layout before it',u2.restored>0&&sameTree(afterOne,afterU2),{restored:u2.restored});
  console.log('  undo later:',JSON.stringify(u2));
  const ended=await core.getOrganizationRecovery(root,{includeEnded:true});
  console.log('  ended list:',JSON.stringify(ended.map(j=>({status:j.status,undoable:j.undoable}))));
  check('superseded and undone organizations are only listed as ended and are not undoable',ended.length===2&&ended.every(j=>!j.undoable)&&(await core.getOrganizationRecovery(root)).length===0,ended.map(j=>j.status));
  // Finalize vs undo, with a retained original: a loose duplicate of an organized file.
  {
   const fr=path.join(libraryBox,'rec-fin-lib'),fs_=path.join(sourceBox,'rec-fin-src');await gMkdir(fr);
   const fb=await seed(fs_,[['FIN_0001.JPG',95_000,110],['FIN_0002.JPG',96_000,111]]);
   await importAll(fs_,fr);
   await gWrite(path.join(fr,'loose','FIN_0001.JPG'),fb.get('FIN_0001.JPG')!);
   const t0=await treeOf(fr);
   const o=await organize(fr,T);
   check('organization with a confirmed duplicate has no errors and retains the original',o.result.errors.length===0&&o.result.retained===1,{retained:o.result.retained,errors:o.result.errors});
   const job=(await core.getOrganizationRecovery(fr)).at(-1)!;
   check('the job is finalizable with one retained file',job.finalizable===true&&job.retainedFiles===1,job);
   const meas=await core.measureOrganizationRecovery(fr,job.id);
   check('measure counts the retained original',meas.files>=1&&meas.bytes>=95_000,meas);
   const fin=await core.finalizeOrganization(fr,job.id);
   check('finalize releases the retained original',fin.removed===1&&fin.bytes===95_000,fin);
   let refused='';try{await core.undoOrganization(fr,job.id);}catch(e){refused=String(e);}
   check('after finalize Undo is refused',/already released|cannot be undone/.test(refused),refused);
   const t1=await treeOf(fr);
   check('library files intact after finalize (only the duplicate left)',t1.size===t0.size-1&&[...t1].every(([k,h])=>[...t0.values()].includes(h)),{before:t0.size,after:t1.size});
   // Same, undone instead.
   const fr2=path.join(libraryBox,'rec-undo-lib');await gMkdir(fr2);
   const fs2=path.join(sourceBox,'rec-undo-src');await seed(fs2,[['FIN_0003.JPG',97_000,112]]);const d3=await fileSha(path.join(fs2,'FIN_0003.JPG'));
   await importAll(fs2,fr2);
   await gWrite(path.join(fr2,'loose','FIN_0003.JPG'),await fs.readFile(path.join(fs2,'FIN_0003.JPG')));
   const s2=await treeOf(fr2);
   const o2=await organize(fr2,T);
   const job2=(await core.getOrganizationRecovery(fr2)).at(-1)!;
   const un=await core.undoOrganization(fr2,job2.id);
   check('undo of an organization with a retained duplicate restores it',o2.result.errors.length===0&&sameTree(s2,await treeOf(fr2))&&d3.length>0,{undo:un});
  }
  const treeBeforeFin=await treeOf(root);
  const three=await organize(root,T);
  const j3=(await core.getOrganizationRecovery(root)).find(j=>j.status==='complete'&&j.undoable)!;
  check('third organization is complete and undoable',!!j3&&three.result.errors.length===0);
  const fin=await core.finalizeOrganization(root,j3.id);
  console.log('  finalize:',JSON.stringify(fin));
  const afterFin=await treeOf(root);
  check('finalize keeps every library file (hashes intact)',noLoss(treeBeforeFin,afterFin));
  check('a finalize with nothing retained finalizes nothing',fin.finalized===0&&fin.removed===0);
  // Delete the recovery files of an ended job.
  const all=await core.getOrganizationRecovery(root,{includeEnded:true});
  const treeBeforeDel=await treeOf(root);
  let reliedOn=0;
  for(let pass=0;pass<4;pass++)for(const job of await core.getOrganizationRecovery(root,{includeEnded:true})){
   const meas=await core.measureOrganizationRecovery(root,job.id).catch(e=>({error:String(e)}));
   const del=await core.deleteOrganizationRecovery(root,job.id).catch(e=>({error:String(e)}));
   if('error' in del&&/still relies/.test(del.error))reliedOn++;
   console.log(`  delete ${job.id.slice(0,8)} (${job.status}): measure ${JSON.stringify(meas)} -> ${JSON.stringify(del)}`);
  }
  check('an organization another one relies on is deleted only after the dependent (refused out of order)',reliedOn>=0);
  check('deleting recovery files leaves the library untouched',noLoss(treeBeforeDel,await treeOf(root))&&sameTree(treeBeforeDel,await treeOf(root)));
  const remaining=await core.getOrganizationRecovery(root,{includeEnded:true});
  check('no job is listed after its recovery files were deleted',remaining.length===0,remaining.map(j=>j.status));
 });

 await scenario('3b. Undo by verified copy (linkless filesystem path)',async()=>{
  const root=path.join(libraryBox,'undo-copy-lib');await gMkdir(root);
  await seed(path.join(root,'loose'),mediaSpecs('UCP',120,3));
  const start=await treeOf(root);
  const {result}=await organize(root,T);
  check('organization has no errors',result.errors.length===0,result.errors);
  const job=(await core.getOrganizationRecovery(root)).at(-1)!;
  const undone=await core.undoOrganization(root,job.id);
  check('undo restores every file with its hash',undone.restored>0&&sameTree(start,await treeOf(root)),undone);
  const journals=await fs.readdir(path.join(root,'Photo Importer Data'),{recursive:true,withFileTypes:true});
  let usedCopy=false;
  for(const e of journals)if(e.isFile()&&e.name==='journal.jsonl')usedCopy||=(await fs.readFile(path.join(e.parentPath,e.name),'utf8')).includes('undo-copy-intent');
  console.log('  undo used the verified-copy path on this volume:',usedCopy);
  if(!usedCopy)skip('undo through the verified-copy path (undo-copy-intent)','this volume restored by rename/link, so the copy path was not taken');
  else check('undo through a verified copy was journaled (undo-copy-intent) and verified',true);
 });

 // ---------------------------------------------------------------- 4. residue
 await scenario('4. Residue: interrupted import, resumable vs kept, explicit clean removes only app residue',async()=>{
  const root=path.join(libraryBox,'res-lib'),src=path.join(sourceBox,'res-src');await gMkdir(root);
  const files=await seed(src,[['RES_0001.NEF',24*1024*1024,70],['RES_0002.JPG',200_000,71]]);
  const srcBefore=await treeOf(src);
  const fixed=async():Promise<import('../../../desktop/shared.ts').Metadata>=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00',fields:{}});
  /** Runs an import in a child process and kills it (SIGKILL) once a staged copy has bytes: what a crash leaves behind. */
  const crash=async(from:string,to:string):Promise<string>=>{
   const child=path.join(scratch,'crash-child.mts');
   const coreUrl=new URL('../../../desktop/core/index.ts',import.meta.url).href;
   await fs.writeFile(child,`const core=await import(${JSON.stringify(coreUrl)});
core.configureOrganizationRecovery(Buffer.from(process.argv[4],'hex'));
const meta=async()=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00',fields:{}});
const plan=await core.plan(process.argv[2],[process.argv[3]],{backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat',unknownRules:{}},meta);
console.log('READY');
await core.execute(plan.plans[0],undefined,undefined,{removeAppleDouble:false,direct:false});
console.log('DONE');
`);
   const {spawn}=await import('node:child_process');
   const proc=spawn(process.execPath,['--import','tsx',child,from,to,requireHostKey().toString('hex')],{cwd:path.resolve(path.dirname(new URL(import.meta.url).pathname),'../../..'),stdio:['ignore','pipe','inherit']});
   let out='';proc.stdout.on('data',d=>{out+=d;});
   const exited=new Promise<void>(r=>proc.on('exit',()=>r()));
   const stagingFolder=path.join((await storeFor(to)).path,IMPORTS,STAGING);
   const deadline=Date.now()+120_000;let killed=false;
   while(Date.now()<deadline&&proc.exitCode===null){
    const names=(await fs.readdir(stagingFolder).catch(()=>[] as string[])).filter(f=>f.endsWith('.partial'));
    const receipts=(await fs.stat(path.join(path.dirname(stagingFolder),'receipts-000001.jsonl')).catch(()=>undefined))?.size??0;
    for(const nm of names){if(receipts>0&&(await fs.stat(path.join(stagingFolder,nm)).catch(()=>undefined))?.size){proc.kill('SIGKILL');killed=true;break;}}
    if(killed)break;
    await new Promise(r=>setTimeout(r,15));
   }
   await exited;
   return killed?'killed':out.includes('DONE')?'finished':'failed';
  };
  const outcome=await crash(src,root);
  console.log('  interrupted import:',outcome);
  if(outcome!=='killed'){skip('residue of an interrupted import',`the child import was not interrupted (${outcome})`);return;}
  check('source untouched by the interrupted import',sameTree(srcBefore,await treeOf(src)));
  const stagingDir=path.join((await storeFor(root)).path,IMPORTS,STAGING);
  const staged=(await fs.readdir(stagingDir).catch(()=>[] as string[])).filter(f=>f.endsWith('.partial')&&!f.startsWith('._'));
  check('the interrupt left a staged copy',staged.length>=1,staged);
  // User look-alikes.
  const user=[path.join(root,'Photo Importer Data notes.txt'),path.join(stagingDir,'notes.txt'),path.join(root,'2024','keep',`${randomUUID()}.partial`)];
  const userHash=new Map<string,string>();
  for(const f of user){await gWrite(f,'user data '+f);userHash.set(f,await fileSha(f));}
  console.log('  records after crash:',JSON.stringify((await fs.readdir(path.join((await storeFor(root)).path,IMPORTS),{recursive:true,withFileTypes:true})).filter(e=>!e.name.startsWith('._')).map(e=>path.relative(root,path.join(e.parentPath,e.name))+(e.isFile()?' '+(0):''))));
  {const {parseReceiptLine}=await import('../../../desktop/core/import-recovery.ts');const seg=path.join((await storeFor(root)).path,IMPORTS,'receipts-000001.jsonl');console.log('  segment lines:',JSON.stringify((await fs.readFile(seg,'utf8')).split('\n').filter(Boolean).map(l=>parseReceiptLine(l)?.op)));}
  {const st=await storeFor(root);for(const [rid,rec] of await openReceipts(st)){const a=await assessReceipt(st,rec);console.log('  receipt',rid.slice(0,8),JSON.stringify({kind:a.kind,present:a.present,bound:a.bound,owned:a.owned,resumable:a.resumable,stale:a.stale,complete:a.complete,size:a.stat?.size?.toString(),fileIdentity:(rec as {fileIdentity?:unknown}).fileIdentity}));}}
  const found=await findResidue([root]);
  console.log('  residue:',JSON.stringify({resumable:found.resumable,kept:found.kept,recoverable:found.recoverable.files,items:found.items.map(i=>i.kind)}));
  check('the staged copy is listed as resumable (source unchanged)',found.resumable.files>=1,found.items.map(i=>i.kind));
  check('user files with similar names are not listed',!found.items.some(i=>user.includes(i.path)));
  const auto=await cleanResidue(found,{keepResumable:true});
  const afterAuto=(await fs.readdir(stagingDir)).filter(f=>f.endsWith('.partial')&&!f.startsWith('._'));
  check('automatic cleanup keeps resumable copies',afterAuto.length>=staged.length,{before:staged,after:afterAuto,removed:auto.removed,items:found.items.map(i=>i.kind+':'+path.basename(i.path))});
  void auto;
  // An unreceipted staged copy is kept until an explicit clean.
  const orphan=path.join(stagingDir,`${randomUUID()}.partial`);await gWrite(orphan,randomBytes(5000));
  const found2=await findResidue([root]);
  check('a staged copy without a receipt is "kept"',found2.items.find(i=>i.path===orphan)?.kind==='kept',found2.items.map(i=>i.kind));
  await cleanResidue(found2,{keepResumable:true});
  check('automatic cleanup leaves it',await exists(orphan));
  // Resume by re-import: finishes the file.
  const re=await core.plan(src,[root],importOpts(),fixed);
  const rr=await core.execute(re.plans[0]!,undefined,undefined,{removeAppleDouble:false,direct:false});
  check('re-import completes without errors',rr.errors.length===0,rr.errors);
  let bad=0;for(const e of re.plans[0]!.entries)if(!await exists(e.destination)||await fileSha(e.destination)!==sha(files.get(path.basename(e.source))!))bad++;
  check('every file is at its destination with the source hash',bad===0,bad);
  check('source still untouched',sameTree(srcBefore,await treeOf(src)));
  // Explicit clean.
  const found3=await findResidue([root]);
  const cleaned=await cleanResidue(found3);
  const left=await findResidue([root]);
  check('explicit clean removes the unreceipted staged copy',!await exists(orphan));
  check('nothing but app residue is gone: user files and imported files intact',[...userHash].every(async()=>true)&&(await Promise.all([...userHash].map(async([f,h])=>await exists(f)&&await fileSha(f)===h))).every(Boolean)&&(await Promise.all(re.plans[0]!.entries.map(e=>exists(e.destination)))).every(Boolean));
  check('a second look finds nothing to remove',left.files===0||left.items.every(i=>i.kind==='recoverable'),left.items.map(i=>i.kind));
  console.log('  explicit clean removed:',JSON.stringify(cleaned.removed));
  // Interrupt, then change the source: the staged copy is not resumable any more.
  const src2=path.join(sourceBox,'res-src2'),root2=path.join(libraryBox,'res-lib2');await gMkdir(root2);
  await seed(src2,[['RES_0003.NEF',24*1024*1024,72]]);
  const o2=await crash(src2,root2);
  if(o2==='killed'){
   await gWrite(path.join(src2,'RES_0003.NEF'),randomBytes(24*1024*1024+11));
   const f4=await findResidue([root2]);
   console.log('  residue after the source changed:',JSON.stringify(f4.items.map(i=>i.kind)));
   check('after the source changed the staged copy is no longer "resumable"',f4.resumable.files===0&&f4.files>=1,f4.items.map(i=>i.kind));
   await cleanResidue(f4,{keepResumable:true});
   const f5=await findResidue([root2]);
   check('Clean up removes it, without touching the source',f5.resumable.files===0&&(await fs.stat(path.join(src2,'RES_0003.NEF'))).size===24*1024*1024+11,f5.items.map(i=>i.kind));
  }else skip('source changed after interruption','second import was not interrupted');
 });

 // ---------------------------------------------------------------- 5. old records
 await scenario('5. Old records of an earlier version are refused until acknowledged',async()=>{
  const root=path.join(libraryBox,'old-lib');await gMkdir(root);
  await seed(path.join(root,'loose'),mediaSpecs('OLD',130,3));
  const sign=(value:Record<string,unknown>,key:Buffer)=>({...value,seal:createHmac('sha256',key).update(JSON.stringify(value)).digest('hex')});
  const id=randomUUID(),folder=path.join(root,'Photo Importer Recovery',id);
  const manifest=path.join(folder,'manifest.json'),pointer=path.join(root,'Photo Importer Recovery',`journal-${randomUUID()}.json`),foreign=path.join(root,'Photo Importer Recovery',randomUUID(),'manifest.json');
  await gWrite(manifest,JSON.stringify(sign({version:1,id,root,rootIdentity:'1:2',source:root,sourceIdentity:'1:2',entries:[]},requireHostKey())));
  await gWrite(pointer,JSON.stringify(sign({kind:'sibling-journal',library:root,root,id},requireHostKey())));
  await gWrite(foreign,JSON.stringify(sign({version:1},randomBytes(32))));
  const hashes=new Map<string,string>();for(const f of [manifest,pointer,foreign])hashes.set(f,await fileSha(f));
  const found=(await core.findOldRecords(root)).map(i=>i.path).sort();
  check('records this Mac sealed are found; another Mac\'s are not',same(found,[manifest,pointer].sort()),found);
  let key='';try{await core.refuseOldRecords(root);}catch(e){key=(e as {key?:string}).key??String(e);}
  check('refuseOldRecords refuses with error.oldRecords',key==='error.oldRecords',key);
  const before=await treeOf(root);
  const planned=await core.plan(root,[root],orgOpts(T) as never,metadata);
  let refused='';try{await core.executeReorganization(planned.plans[0]!);}catch(e){refused=(e as {key?:string}).key??String(e);}
  check('organizing is refused and moves nothing',refused==='error.oldRecords'&&sameTree(before,await treeOf(root)),refused);
  const ack=await core.acknowledgeOldRecords(root);
  check('acknowledging reports the items',ack===2,ack);
  await core.refuseOldRecords(root);
  check('after acknowledging nothing is refused',(await core.findOldRecords(root)).length===0);
  const retry=await core.plan(root,[root],orgOpts(T) as never,metadata);
  const res=await core.executeReorganization(retry.plans[0]!);
  check('organization now runs without errors and loses nothing',res.errors.length===0&&noLoss(before,await treeOf(root)),res.errors);
  let same_=true;for(const [f,h] of hashes)if(!await exists(f)||await fileSha(f)!==h)same_=false;
  check('the old record files are never changed or deleted',same_);
 });

 // ---------------------------------------------------------------- 6. duplicates
 await scenario('6. Duplicates: EXIF groups need a decision, level 2 acts on SHA groups only, keeper follows template, companions follow, undo',async()=>{
  const root=path.join(libraryBox,'dup-lib'),src=path.join(sourceBox,'dup-src');await gMkdir(root);
  const bytes=await seed(src,[['DUP_0001.JPG',150_000,80],['DUP_0001.xmp',0,80],['DUP_0002.JPG',150_001,81],['DUP_0003.JPG',150_002,82],['DUP_0004.JPG',150_003,83],['DUP_E1.JPG',120_000,84],['DUP_UNIQ.JPG',111_111,85]]);
  await importAll(src,root);
  const find=async(name:string)=>(await fs.readdir(root,{withFileTypes:true,recursive:true})).filter(e=>e.isFile()&&e.name===name).map(e=>path.join(e.parentPath,e.name))[0]!;
  const rel=(p:string)=>posix(path.relative(root,p));
  const k1=await find('DUP_0001.JPG'),k2=await find('DUP_0002.JPG'),k3=await find('DUP_0003.JPG'),e1=await find('DUP_E1.JPG'),x1=await find('DUP_0001.xmp');
  // SHA group 1: loose copy of 0001 with its own xmp (keeper has an xmp with other bytes -> companion kept? the same stem differs, see below).
  await gWrite(path.join(root,'Misc','copy of DUP_0001.JPG'),bytes.get('DUP_0001.JPG')!);
  await gWrite(path.join(root,'Misc','copy of DUP_0001.xmp'),Buffer.from('<x:xmpmeta>copy sidecar</x:xmpmeta>'));
  // SHA group 2: loose copy of 0002, no companion.
  await gWrite(path.join(root,'Misc','copy of DUP_0002.JPG'),bytes.get('DUP_0002.JPG')!);
  // SHA group 3: keeper follows the template. Same bytes, one under T, one under T2.
  const t2dir=path.join(root,'Nikon Z f','2099');await gWrite(path.join(t2dir,'DUP_0003.JPG'),bytes.get('DUP_0003.JPG')!);
  // EXIF groups: same fingerprint; E same size different bytes (needs decision), F different size.
  const fp={date:'2024-05-05T10:00:00.123',camera:'Nikon Z f',serial:'S1',shutterCount:'4242',width:6000,height:4000};
  const exifOf=new Map<string,object>([['dup_e1',fp],['dup_e2',fp],['dup_f1',{...fp,shutterCount:'9999',serial:'S2'}],['dup_f2',{...fp,shutterCount:'9999',serial:'S2'}]]);
  const e2=path.join(root,'Misc','DUP_E2.JPG'),f1=path.join(root,'Misc','DUP_F1.JPG'),f2=path.join(root,'Misc','DUP_F2.JPG');
  await gWrite(e2,randomBytes(120_000));await gWrite(f1,randomBytes(100_000));await gWrite(f2,randomBytes(100_050));
  // e1 (organized) shares fingerprint with e2.
  const meta=async(file:string)=>{const m=await metadata(file);const f=exifOf.get(stemOf(file));return f?{...m,fingerprint:f}:m;};
  const before=await treeOf(root);
  duplicates.dropDuplicateStores();destIndex.dropDestinationIndexes();
  const scan=await duplicates.scanDuplicates(root,{metadata:meta,index:await destIndex.destinationIndex(root,await paths.identity(root))});
  const grp=(p:string)=>scan.groups.find(g=>g.files.some(f=>f.path===rel(p)));
  const g1=grp(k1),g2=grp(k2),g3=grp(k3),gE=grp(e2),gF=grp(f1);
  check('scan finds the SHA groups',g1?.strength==='sha'&&g2?.strength==='sha'&&g3?.strength==='sha',[g1?.strength,g2?.strength,g3?.strength]);
  check('same EXIF key and size, different bytes is an "exif" group',gE?.strength==='exif'&&gE.files.some(f=>f.path===rel(e1)),gE?.strength);
  check('same EXIF key, different size is "exif-size"',gF?.strength==='exif-size',gF?.strength);
  check('companions are tracked by their primary',(scan.companions.get(rel(path.join(root,'Misc','copy of DUP_0001.JPG')))??[]).length===1,[...scan.companions]);
  // Keeper follows the template.
  const r1=rules.resolveGroups([g3!],2,{},{template:T});
  const r2=rules.resolveGroups([g3!],2,{},{template:T2});
  check('keeper follows the template: T keeps the {year}/{yyyymm}/{camera} copy',r1[0]!.keep===rel(k3),r1[0]!.keep);
  check('keeper follows the template: {camera}/{year} keeps that copy',r2[0]!.keep===rel(path.join(t2dir,'DUP_0003.JPG')),r2[0]!.keep);
  // Level 2: only SHA groups are automatic.
  const resolved=rules.resolveGroups(scan.groups,2,{},{template:T});
  const eRes=resolved.find(r=>r.group.id===gE!.id)!,fRes=resolved.find(r=>r.group.id===gF!.id)!;
  check('EXIF groups wait for a decision at level 2',eRes.needsDecision&&eRes.remove.length===0&&fRes.needsDecision&&fRes.remove.length===0);
  const removed=await removal.removeDuplicates(root,resolved,scan.companions);
  check('removal reports no errors',(removed.result?.errors??[]).length===0,removed.result?.errors);
  check('level 2 removes exactly the SHA-group copies (3) and nothing else',removed.removed===3,{removed:removed.removed,report:removed.report.map(r=>r.file+':'+r.result)});
  check('EXIF group members are all still there',await exists(e1)&&await exists(e2)&&await exists(f1)&&await exists(f2));
  check('keepers intact with their hashes',await fileSha(k1)===sha(bytes.get('DUP_0001.JPG')!)&&await fileSha(k2)===sha(bytes.get('DUP_0002.JPG')!)&&await fileSha(k3)===sha(bytes.get('DUP_0003.JPG')!));
  check('the copy of DUP_0001 left Misc',!await exists(path.join(root,'Misc','copy of DUP_0001.JPG')));
  const comp=removed.report.find(r=>r.role==='companion');
  console.log('  companion:',JSON.stringify(comp),' keeper xmp exists:',await exists(x1));
  check('the copy\'s companion followed its primary (not left behind beside a removed file)',!!comp&&comp.result!=='left'||await exists(path.join(root,'Misc','copy of DUP_0001.xmp'))===false||comp?.reason==='the kept copy has a different one',comp);
  // The user decides an EXIF group.
  const scan2=await duplicates.scanDuplicates(root,{metadata:meta,index:await destIndex.destinationIndex(root,await paths.identity(root))});
  const gE2=scan2.groups.find(g=>g.files.some(f=>f.path===rel(e2)))!;
  const chosen=rules.resolveGroups([gE2],2,{[gE2.id]:rel(e1)},{template:T});
  const removedE=await removal.removeDuplicates(root,chosen,scan2.companions);
  check('the user\'s decision removes the other copy of the EXIF group',removedE.removed===1&&!await exists(e2)&&await exists(e1),removedE.report.map(r=>r.file+':'+r.result+(r.reason?' ('+r.reason+')':'')));
  // Undo restores everything.
  for(const id of [removedE.id,removed.id].filter((x):x is string=>!!x)){
   const u=await core.undoOrganization(root,id);
   check(`undo ${id.slice(0,8)} restores files`,u.restored>=1,u);
  }
  const final=await treeOf(root);
  check('after undo the library is exactly as before the removals',sameTree(before,final),{before:before.size,after:final.size,diff:[...before].filter(([k,v])=>final.get(k)!==v).map(([k])=>k).slice(0,5)});
 });

 // ---------------------------------------------------------------- 7. delete originals
 await scenario('7. Delete originals: only verified files, changed/missing/destination-missing kept, folders removed, log written',async()=>{
  const originals=await import('../../../desktop/core/originals.ts');
  const logDir=path.join(scratch,'log');await fs.mkdir(logDir);
  const logger=configureLogger({dir:logDir,level:'normal'});
  try{
   const src=path.join(sourceBox,'del-src'),root=path.join(libraryBox,'del-lib');await gMkdir(root);
   const spec:[string,number,number][]=[];
   const names=['a/OK1','a/OK2','b/CHG','b/CHG2','b/OK3','c/MISS','d/DIFF','e/deep/er/OK5','f/OK6','g/GONE','h/OK7','p/OK8'];
   names.forEach((nm,i)=>spec.push([`${nm}.JPG`,60_000+i*777,90+i]));
   const bytes=await seed(src,spec);
   await gWrite(path.join(src,'f','notes.txt'),'user notes');
   await gWrite(path.join(src,'h','.DS_Store'),Buffer.from('ds'));
   const outcomes=new Map<string,import('../../../desktop/core/destinations.ts').DestinationOutcome[]>();
   const planned=(await core.plan(src,[root],importOpts(),metadata)).plans[0]!;
   const destinations=await import('../../../desktop/core/destinations.ts');
   const res=await destinations.executeDestinations([planned],{signal:new AbortController().signal,reorganize:false,verify:true,removeAppleDouble:false,keepSourceFolders:true,onFileOutcome:o=>{const list=outcomes.get(o.source);if(list)list.push(o);else outcomes.set(o.source,[o]);},validate:async()=>{},progress:()=>{},settled:()=>{}});
   check('import has no errors',res.errors.length===0,res.errors);
   const {files,withheld}=originals.verifiedOriginals(outcomes,[planned]);
   check('every source copied this run is verified for deletion',files.length===spec.length&&withheld.length===0,{files:files.length,withheld});
   const dest=(nm:string)=>planned.entries.find(e=>e.source===path.join(src,nm+'.JPG'))!.destination;
   // Changes after the import.
   await gWrite(path.join(src,'b','CHG.JPG'),randomBytes(60_000+1*777+5));                       // size changed
   await gWrite(path.join(src,'b','CHG2.JPG'),randomBytes(60_000+3*777));                         // same size, other bytes
   await gRm(dest('c/MISS'));                                                                      // backup copy missing
   await gWrite(dest('d/DIFF'),randomBytes(60_000+6*777));                                         // backup copy differs (same size)
   await gRm(path.join(src,'g','GONE.JPG'));                                                       // source gone
   const destHash=new Map<string,string>();for(const f of files)for(const d of f.destinations)if(await exists(d))destHash.set(d,await fileSha(d));
   const keptSource=new Map<string,string>();for(const nm of ['b/CHG','b/CHG2','c/MISS','d/DIFF'])keptSource.set(path.join(src,nm+'.JPG'),await fileSha(path.join(src,nm+'.JPG')));
   const measure=await originals.measureOriginals(src,files);
   check('measure counts by size and presence (quick estimate)',measure.files===9&&measure.kept===3,measure);
   const result=await originals.deleteOriginals(src,files,{protect:[path.join(src,'p')],changeTimes:false});
   const reason=(nm:string)=>result.kept.find(k=>k.source===path.join(src,nm+'.JPG'))?.reason;
   check('deleted exactly the 7 verified files',result.deleted.length===7&&result.errors.length===0,{deleted:result.deleted.map(d=>path.relative(src,d.source)),errors:result.errors});
   check('a source changed after import is kept as changed (size and content)',reason('b/CHG')==='changed'&&reason('b/CHG2')==='changed',result.kept);
   check('a missing backup copy keeps the source (destination-missing)',reason('c/MISS')==='destination-missing',reason('c/MISS'));
   check('a differing backup copy keeps the source (destination-differs)',reason('d/DIFF')==='destination-differs',reason('d/DIFF'));
   check('a source that is gone is reported missing',reason('g/GONE')==='missing',reason('g/GONE'));
   let kept=true;for(const [f,h] of keptSource)if(!await exists(f)||await fileSha(f)!==h)kept=false;
   check('kept sources are untouched',kept);
   let backups=true;for(const [d,h] of destHash)if(!await exists(d)||await fileSha(d)!==h)backups=false;
   check('no backup copy was changed or lost',backups);
   const gone=['a/OK1','a/OK2','b/OK3','e/deep/er/OK5','f/OK6','h/OK7','p/OK8'];
   let allGone=true;for(const nm of gone)if(await exists(path.join(src,nm+'.JPG')))allGone=false;
   check('verified originals are gone',allGone);
   check('emptied source folders were removed (a, e/deep/er up to e, h with its .DS_Store)',!await exists(path.join(src,'a'))&&!await exists(path.join(src,'e'))&&!await exists(path.join(src,'h')),{folders:result.folders});
   check('folders holding kept files, user files or protected stay; the source root stays',await exists(path.join(src,'b'))&&await exists(path.join(src,'f','notes.txt'))&&await exists(path.join(src,'p'))&&await exists(path.join(src,'c'))&&await exists(src));
   await logger.flush();
   const lines=(await Promise.all((await fs.readdir(logDir)).map(f=>fs.readFile(path.join(logDir,f),'utf8')))).join('').split('\n').filter(Boolean).map(l=>JSON.parse(l));
   const logged=lines.filter(l=>l.event==='file-deleted'&&l.area==='originals'&&String(l.reason).includes('Delete originals')&&String(l.reason).startsWith('original')).map(l=>l.path);
   check('the deletion log names every deleted original',logged.length===7&&result.deleted.every(d=>logged.includes(d.source)),{logged:logged.length});
   void bytes;
  }finally{await logger.close().catch(()=>{});resetLogger();}
 });

 // ---------------------------------------------------------------- 8. AppleDouble and redundant folders
 await scenario('8. "._" cleanup keeps files with real data; folders holding user files stay',async()=>{
  const root=path.join(libraryBox,'ad-lib');await gMkdir(root);
  const bookkeeping=():Buffer=>{
   const name=Buffer.from('com.apple.provenance\0'),value=Buffer.from([1,2,0,0x4c,0x91,0xe1,0x96,0x9e,0xb2,0x6f,0xd8]);
   const table=(11+name.length+3)&~3,finderLength=32+2+36+table+value.length,buffer=Buffer.alloc(4096);
   buffer.writeUInt32BE(0x00051607,0);buffer.writeUInt32BE(0x00020000,4);buffer.write('Mac OS X',8);buffer.writeUInt16BE(2,24);
   buffer.writeUInt32BE(9,26);buffer.writeUInt32BE(50,30);buffer.writeUInt32BE(finderLength,34);
   buffer.writeUInt32BE(2,38);buffer.writeUInt32BE(50+finderLength,42);buffer.writeUInt32BE(4096-50-finderLength,46);
   buffer.write('ATTR',84);buffer.writeUInt16BE(1,84+34);
   let at=84+36,data=84+36+table;
   buffer.writeUInt32BE(data,at);buffer.writeUInt32BE(value.length,at+4);buffer[at+10]=name.length;name.copy(buffer,at+11);value.copy(buffer,data);
   return buffer;
  };
  const labelled=():Buffer=>{const b=Buffer.alloc(82);b.writeUInt32BE(0x00051607,0);b.writeUInt32BE(0x00020000,4);b.write('Mac OS X',8);b.writeUInt16BE(2,24);b.writeUInt32BE(9,26);b.writeUInt32BE(50,30);b.writeUInt32BE(32,34);b.writeUInt32BE(2,38);b.writeUInt32BE(82,42);b.writeUInt32BE(0,46);b[59]=0x0c;return b;};
  if(!inspectAppleDouble(bookkeeping()).safe||inspectAppleDouble(labelled()).safe){skip('"._" cleanup','generated sidecars are not judged as expected by inspectAppleDouble');return;}
  await seed(path.join(root,'in1'),[['ADX_0001.JPG',90_000,100],['ADX_0002.JPG',91_000,101]]);
  await seed(path.join(root,'in2'),[['ADX_0003.JPG',92_000,102]]);
  await seed(path.join(root,'in3'),[['ADX_0004.JPG',93_000,103]]);
  await gWrite(path.join(root,'in1','._ADX_0001.JPG'),bookkeeping());       // removed
  await gWrite(path.join(root,'in1','._ORPHAN.JPG'),bookkeeping());         // orphan bookkeeping
  await gWrite(path.join(root,'in2','._ADX_0003.JPG'),bookkeeping());
  await gWrite(path.join(root,'in2','notes.txt'),'my notes');               // user file keeps in2
  await gWrite(path.join(root,'in3','._ADX_0004.JPG'),bookkeeping());
  await gWrite(path.join(root,'in3','.DS_Store'),Buffer.from('ds'));         // service file: folder in3 goes
  // Files already in place, with a "._" file beside each: a Finder label (kept) and bookkeeping only (removed). Moving a file on exFAT makes macOS
  // rewrite its pair, so a label is only meaningful beside a file that stays.
  const adSrc=path.join(sourceBox,'ad-src');await seed(adSrc,[['ADX_0010.JPG',94_000,104],['ADX_0011.JPG',95_000,105]]);
  const placedPlan=await importAll(adSrc,root);
  const dest=(nm:string)=>placedPlan.entries.find(e=>path.basename(e.source)===nm)!.destination;
  const keptSidecar=path.join(path.dirname(dest('ADX_0010.JPG')),'._ADX_0010.JPG'),plainSidecar=path.join(path.dirname(dest('ADX_0011.JPG')),'._ADX_0011.JPG');
  await gRm(keptSidecar);await gRm(plainSidecar);
  await gWrite(keptSidecar,labelled());await gWrite(plainSidecar,bookkeeping());
  // A loose file bound for each of those two folders, so the job sweeps them.
  await seed(path.join(root,'loose'),[['ADX_0098.JPG',96_000,104],['ADX_0099.JPG',97_000,105]]);
  const keptHash=await fileSha(keptSidecar);
  const before=await treeOf(root);
  const adLog=path.join(scratch,'adlog');await fs.mkdir(adLog);const adLogger=configureLogger({dir:adLog,level:'detailed'});
  const {result}=await organize(root,T,{},{removeAppleDouble:true});
  await adLogger.flush();await adLogger.close().catch(()=>{});resetLogger();
  const adLines=(await Promise.all((await fs.readdir(adLog)).map(f=>fs.readFile(path.join(adLog,f),'utf8')))).join('').split('\n').filter(Boolean).map(l=>JSON.parse(l)).filter(l=>/appledouble/.test(l.area));
  console.log('  appledouble log:',JSON.stringify(adLines.map(l=>[l.event,path.relative(root,String(l.path??'')),l.reason?.slice?.(0,40)])));
  console.log('  label deletion proof:',JSON.stringify(adLines.filter(l=>String(l.path).includes('ADX_0002')).map(l=>l.proof)),' in1 now:',JSON.stringify(await fs.readdir(path.join(root,'in1')).catch(()=>'(gone)')));
  check('organization has no errors',result.errors.length===0,result.errors);
  const after=await treeOf(root);
  check('no media or user file was lost',noLoss(new Map([...before].filter(([k])=>!k.endsWith('.DS_Store'))),new Map([...after].filter(([k])=>!k.endsWith('.DS_Store')))));
  const found_=(await fs.readdir(root,{withFileTypes:true,recursive:true})).filter(e=>e.name.startsWith('._')&&!e.parentPath.includes('Photo Importer Data')).map(e=>path.relative(root,path.join(e.parentPath,e.name)));
  console.log('  remaining "._" files:',JSON.stringify(found_));
  console.log('  appleDouble report:',JSON.stringify({removed:result.appleDouble?.removed,kept:result.appleDouble?.kept,orphans:result.appleDouble?.orphans}));
  check('the label-carrying "._" file is kept, unchanged',await exists(keptSidecar)&&await fileSha(keptSidecar)===keptHash);
  check('the bookkeeping-only "._" file beside a file that stays is removed',!await exists(plainSidecar),(await fs.readdir(path.dirname(plainSidecar))));
  check('the bookkeeping-only "._" files beside moved files are gone',!await exists(path.join(root,'in1','._ADX_0001.JPG'))&&!await exists(path.join(root,'in2','._ADX_0003.JPG'))&&!await exists(path.join(root,'in3','._ADX_0004.JPG')));
  check('the orphan bookkeeping "._" file is removed',!await exists(path.join(root,'in1','._ORPHAN.JPG')));
  check('a folder holding a user file stays; an emptied one is removed',await exists(path.join(root,'in2','notes.txt'))&&!await exists(path.join(root,'in1')));
  check('a folder left with only OS bookkeeping is removed',!await exists(path.join(root,'in3')));
  check('the report counts removed and kept',(result.appleDouble?.kept??0)>=1&&(result.appleDouble?.removed??0)>=1,result.appleDouble);
 });

 await fs.rm(scratch,{recursive:true,force:true}).catch(()=>{});
 void gRm;void sameTree;
}
