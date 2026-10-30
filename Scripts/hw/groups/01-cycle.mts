/** The original nine end-to-end scenarios: import, re-import, conflict, organize, undo, finalize, duplicates, resume, NFC names. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import type {Context} from '../harness.mts';

export const title='Import, conflict, organize, undo, finalize, duplicates, resume, NFC names';

export default async function run(ctx:Context):Promise<void>{
 const {core,duplicates,removal,rules,destIndex,paths,sourceBox,libraryBox,check,scenario,skip,gMkdir,gWrite,gRm,gUtimes,metadata,describe,sha,fileSha,exists,treeOf,multiset,same,sameTree,files:FILES}=ctx;
 const sourceDir=path.join(sourceBox,'source'),source2Dir=path.join(sourceBox,'source2'),root=path.join(libraryBox,'library');
 await gMkdir(sourceDir);await gMkdir(source2Dir);await gMkdir(root);

 // Source files.
 const generated=new Map<string,Buffer>();   // relative name -> bytes
 const add=(name:string,data:Buffer,i:number)=>{generated.set(name,data);describe(name.replace(/\.[^.]*$/,''),i);};
 add('DSC_0001.NEF',randomBytes(3*1024*1024+17),1);add('dsc_0001.xmp',Buffer.from('<x:xmpmeta>one</x:xmpmeta>'),1);
 add('DSC_0001.JPG',randomBytes(900_000),1);
 add('Zebra.JPG',randomBytes(200_001),2);add('apple.JPG',randomBytes(200_002),3);add('_under.JPG',randomBytes(200_003),4);
 add('Éclair.JPG',randomBytes(200_004),5);add('IMG_a.JPG',randomBytes(200_005),6);add('IMG_B.JPG',randomBytes(200_006),7);
 add('IMG_0100.JPG',randomBytes(150_000),8);        // the conflict victim in scenario 3
 add('BIG_0001.MP4',randomBytes(5*1024*1024+3),9);add('BIG_0002.NEF',randomBytes(4*1024*1024+5),10);
 add('EMPTY_0001.JPG',Buffer.alloc(0),11);
 for(let i=20;generated.size<FILES;i++){
  const stem=`PIC_${String(i).padStart(4,'0')}`;
  if(i%4===0){add(stem+'.MP4',randomBytes(300_000+i),i);}
  else{add(stem+'.NEF',randomBytes(250_000+i),i);add(stem+'.JPG',randomBytes(80_000+i),i);add(stem+'.xmp',Buffer.from(`<x:xmpmeta>${stem}</x:xmpmeta>`),i);}
 }
 const sourceFiles=new Map<string,{hash:string;mtimeMs:number}>();
 const base=Date.now()-86_400_000*30;
 let n=0;
 for(const [name,data] of generated){const p=path.join(sourceDir,name);await gWrite(p,data);await gUtimes(p,new Date(base+(n++)*60_000));}
 for(const name of generated.keys()){const p=path.join(sourceDir,name);sourceFiles.set(name,{hash:await fileSha(p),mtimeMs:(await fs.stat(p)).mtimeMs});}
 console.log(`generated ${generated.size} source files`);


 const importOptions={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
 const organizeOptions=(template:string)=>({backup:false as const,reorganize:true as const,template,layout:'flat' as const,unknownRules:{}});
 // The first import also opts in to direct writes on exFAT (the library volume is exFAT), as the app does by default.
 const execOptions={removeAppleDouble:false};

 // Inode observations.
 const inodes={files:0,empty:0,high:0,negative:0,moveObserved:0,moveSynthetic:0};
 const synthetic=(ino:bigint,size:bigint)=>ino<0n||ino>=2n**63n||size===0n;
 core.setMoveObserver((_from,reviewed,_to,now)=>{inodes.moveObserved++;if(BigInt(reviewed.ino as unknown as string)<0n||now.ino<0n||now.ino>=2n**63n)inodes.moveSynthetic++;});
 const observeInodes=async()=>{
  for(const entry of await fs.readdir(root,{withFileTypes:true,recursive:true})){
   if(!entry.isFile()||entry.name.startsWith('._'))continue;
   const stat=await fs.lstat(path.join(entry.parentPath,entry.name),{bigint:true});
   inodes.files++;if(stat.size===0n)inodes.empty++;if(stat.ino>=2n**63n)inodes.high++;if(stat.ino<0n)inodes.negative++;
   void synthetic;
  }
 };

 let importedPlan:Awaited<ReturnType<typeof core.plan>>['plans'][number]|undefined;
 let conflictId='';

 await scenario('1. Import to the library (direct exFAT mode)',async()=>{
  const planned=await core.plan(sourceDir,[root],importOptions,metadata);
  check('plan has no failures',planned.failures.length===0,planned.failures.map(f=>String(f.error)));
  importedPlan=planned.plans[0]!;
  const entries=importedPlan.entries;
  check('plan lists entries',entries.length>0,entries.length);
  const result=await core.execute(importedPlan,undefined,undefined,{...execOptions,direct:true});
  check('execute reports no errors',result.errors.length===0,result.errors);
  check('every planned file was copied',result.copied===entries.filter(e=>!e.skip).length,{copied:result.copied,planned:entries.length});
  let bad:string[]=[];
  for(const entry of entries){
   if(!await exists(entry.destination)){bad.push('missing '+entry.destination);continue;}
   if(await fileSha(entry.destination)!==await fileSha(entry.source))bad.push('hash '+entry.destination);
  }
  check('every destination exists with the source SHA-256',bad.length===0,bad.slice(0,5));
  bad=[];
  for(const [name,before] of sourceFiles){
   const p=path.join(sourceDir,name),stat=await fs.stat(p);
   if(await fileSha(p)!==before.hash||stat.mtimeMs!==before.mtimeMs)bad.push(name);
  }
  check('source files are untouched (hash and mtime)',bad.length===0,bad);
  check('0-byte source file is not lost from the source',(await fs.stat(path.join(sourceDir,'EMPTY_0001.JPG'))).size===0);
  await observeInodes();
 });

 await scenario('2. Re-import the same source',async()=>{
  const before=await treeOf(root);
  const planned=await core.plan(sourceDir,[root],importOptions,metadata);
  const transfer=planned.plans[0]!;
  check('every entry is already there (skip)',transfer.entries.every(e=>e.skip),transfer.entries.filter(e=>!e.skip).map(e=>e.source));
  const result=await core.execute(transfer,undefined,undefined,{...execOptions,direct:true});
  check('nothing copied again',result.copied===0&&result.errors.length===0,result);
  check('library unchanged',sameTree(before,await treeOf(root)));
 });

 await scenario('3. Conflict: same name/date/camera, different bytes',async()=>{
  const bytes=randomBytes(150_001);
  await gWrite(path.join(source2Dir,'IMG_0100.JPG'),bytes);
  const before=await treeOf(root);
  const planned=await core.plan(source2Dir,[root],importOptions,metadata);
  const transfer=planned.plans[0]!;
  const entry=transfer.entries[0]!;
  const match=/[\\/]Conflicts[\\/]([^\\/]+)[\\/]/.exec(entry?.destination??'');
  check('the second file is planned into Conflicts/<id>/',!!match,entry?.destination);
  conflictId=match?.[1]??'';
  const result=await core.execute(transfer,undefined,undefined,{...execOptions,direct:true});
  check('conflict copy executed without errors',result.copied===1&&result.errors.length===0,result);
  check('conflict copy has the source bytes',!!entry&&await exists(entry.destination)&&await fileSha(entry.destination)===sha(bytes));
  const original=importedPlan?.entries.find(e=>path.basename(e.source)==='IMG_0100.JPG');
  check('the original is untouched',!!original&&await fileSha(original.destination)===sourceFiles.get('IMG_0100.JPG')!.hash);
  const after=await treeOf(root);
  check('exactly one file was added',after.size===before.size+1,{before:before.size,after:after.size});
  // Re-run: no second copy.
  const again=await core.plan(source2Dir,[root],importOptions,metadata);
  const rerun=await core.execute(again.plans[0]!,undefined,undefined,{...execOptions,direct:true});
  check('re-run copies nothing',rerun.copied===0&&rerun.errors.length===0,rerun);
  check('re-run adds no second conflict copy',(await treeOf(root)).size===after.size);
  check('re-run keeps the same Conflicts id',/[\\/]Conflicts[\\/]/.test(again.plans[0]!.entries[0]?.destination??'')&&again.plans[0]!.entries[0]!.destination.includes(`${path.sep}${conflictId}${path.sep}`),again.plans[0]!.entries[0]?.destination);
  // Codepoint-order id, computed the way core does it (a family of one file here).
  const expected=createHash('sha256').update(JSON.stringify([['IMG_0100.JPG',sha(bytes)]])).digest('hex').slice(0,16);
  check('Conflicts id equals the codepoint-order computation',conflictId===expected,{conflictId,expected});
  console.log('conflict id:',conflictId);
  await observeInodes();
 });

 const preOrganize=new Map<string,Map<string,string>>();
 let undoId='';
 /** Plan + run an in-place organization; returns the job id and the plan. */
 const organize=async(template:string,onProgress?:Parameters<typeof core.executeReorganization>[2],signal?:AbortSignal)=>{
  const planned=await core.plan(root,[root],organizeOptions(template),metadata);
  check(`organize plan (${template}) has no failures`,planned.failures.length===0,planned.failures.map(f=>String(f.error)));
  const transfer=planned.plans[0]!;
  const result=await core.executeReorganization(transfer,signal,onProgress);
  return {transfer,result};
 };

 await scenario('4. Organization with a changed folder template',async()=>{
  const before=await treeOf(root);preOrganize.set('4',before);
  const {transfer,result}=await organize('{camera}/{year}');
  check('no errors',result.errors.length===0,result.errors);
  const moving=transfer.entries.filter(e=>e.destination!==e.source);
  check('some files move',moving.length>0,moving.length);
  const after=await treeOf(root);
  const rel=(p:string)=>path.relative(root,p);
  const bad:string[]=[];
  for(const entry of moving){
   const from=rel(entry.source),to=rel(entry.destination);
   if(after.get(to)!==before.get(from))bad.push(`${from} -> ${to}`);
   if(after.has(from)&&from!==to)bad.push('still at '+from);
  }
  check('every moved file is at its new path with the same hash',bad.length===0,bad.slice(0,5));
  check('count and hashes preserved (nothing lost)',after.size===before.size&&same(multiset(before),multiset(after)),{before:before.size,after:after.size});
  const jobs=await core.getOrganizationRecovery(root);
  check('one recovery job, complete and undoable',jobs.length>=1&&jobs.at(-1)!.status==='complete'&&jobs.at(-1)!.undoable===true,jobs);
  undoId=jobs.at(-1)?.id??'';
  await observeInodes();
 });

 await scenario('5. Undo that organization',async()=>{
  const before=preOrganize.get('4')!;
  const undone=await core.undoOrganization(root,undoId);
  console.log('undo:',JSON.stringify(undone));
  const after=await treeOf(root);
  check('all files back at their previous paths with identical hashes',sameTree(before,after),{before:before.size,after:after.size,missing:[...before.keys()].filter(k=>after.get(k)!==before.get(k)).slice(0,5)});
 });

 await scenario('6. Organize again and finalize (release recovery files)',async()=>{
  const before=await treeOf(root);
  const {result}=await organize('{camera}/{year}');
  check('no errors',result.errors.length===0,result.errors);
  const job=(await core.getOrganizationRecovery(root)).at(-1);
  check('job found',!!job,job);
  const finalized=await core.finalizeOrganization(root,job!.id);
  console.log('finalize:',JSON.stringify(finalized));
  const after=await treeOf(root);
  check('hashes intact after finalize',after.size===before.size&&same(multiset(before),multiset(after)),{before:before.size,after:after.size});
  const left=(await core.getOrganizationRecovery(root)).filter(j=>j.id===job!.id);
  check('recovery store holds no retained files for it',left.every(j=>(j.retainedFiles??0)===0&&!j.finalizable),left);
  const kept=path.join(root,'Photo Importer Data','Organizations',job!.id,'originals');
  const originals=(await fs.readdir(kept,{withFileTypes:true,recursive:true}).catch(()=>[])).filter(e=>e.isFile());
  check('no original is left in the recovery area',originals.length===0,originals.length);
 });

 await scenario('7. Duplicates: scan, remove into recovery, undo',async()=>{
  const library=await treeOf(root);
  const victim=[...library.keys()].find(k=>/\.JPG$/.test(k)&&!k.includes('Conflicts'))!;
  const copyRel='Imported/copy of '+path.basename(victim);
  await gWrite(path.join(root,copyRel),await fs.readFile(path.join(root,victim)));
  duplicates.dropDuplicateStores();destIndex.dropDestinationIndexes();
  const scan=await duplicates.scanDuplicates(root,{metadata,index:await destIndex.destinationIndex(root,await paths.identity(root))});
  const posix=(p:string)=>p.split(path.sep).join('/');
  const group=scan.groups.find(g=>g.files.some(f=>f.path===copyRel));
  check('scan finds the duplicate group',!!group&&group.files.some(f=>f.path===posix(victim)),scan.groups.map(g=>g.files.map(f=>f.path)));
  if(!group)return;
  const resolved=rules.resolveGroups([group],2,{[group.id]:posix(victim)});
  const removed=await removal.removeDuplicates(root,resolved,scan.companions);
  check('removal reported no errors',(removed.result?.errors??[]).length===0,removed.result?.errors);
  check('exactly the copy was removed',removed.removed===1,removed.removed);
  check('the copy is no longer in the library',!await exists(path.join(root,copyRel)));
  check('the organized copy is kept with its hash',await exists(path.join(root,victim))&&await fileSha(path.join(root,victim))===library.get(victim));
  const job=(await core.getOrganizationRecovery(root)).find(j=>j.id===removed.id);
  check('removal is in the recovery store and undoable',job?.kind==='duplicates'&&job.undoable===true&&(job.retainedFiles??0)===1,job);
  const undone=await core.undoOrganization(root,removed.id!);
  check('undo restores the copy',undone.restored===1&&await exists(path.join(root,copyRel))&&await fileSha(path.join(root,copyRel))===library.get(victim),undone);
  check('the kept copy is still intact',await fileSha(path.join(root,victim))===library.get(victim));
  await gRm(path.join(root,copyRel));      // the test's own file, exact path
  const final=await treeOf(root);
  check('library back to its pre-duplicate state',sameTree(library,final));
 });

 await scenario('8. Organization interrupted between files, then resumed',async()=>{
  // No in-process hook exists for a mid-file stop of an exclusive copy without editing desktop/, so this stops the
  // run through the AbortSignal the app itself uses (between moves), then resumes it from its journal.
  const before=await treeOf(root);
  const controller=new AbortController();
  let aborted=false,total=0;
  let outcome:'finished'|'aborted'|'other'='finished';
  try{
   await organize('{year}/{yyyymm}/{camera}',progress=>{total=progress.total;if(!aborted&&progress.completed>=Math.max(1,Math.floor(progress.total/3))&&progress.completed<progress.total){aborted=true;controller.abort();}},controller.signal);
  }catch(error){outcome=(error as Error).name==='AbortError'?'aborted':'other';if(outcome==='other')throw error;}
  if(outcome!=='aborted'){skip('abort mid-organization','the run finished before the abort took effect (total '+total+')');return;}
  const jobs=(await core.getOrganizationRecovery(root)).filter(j=>j.status==='pending');
  check('an interrupted job is listed as pending',jobs.length===1,jobs);
  const mid=await treeOf(root);
  check('nothing lost at the interruption',mid.size===before.size&&same(multiset(before),multiset(mid)),{before:before.size,mid:mid.size});
  const resumed=await core.resumeOrganization(root,jobs[0]!.id);
  check('resume reports no errors',resumed.errors.length===0,resumed.errors);
  const after=await treeOf(root);
  check('after resume nothing is lost',after.size===before.size&&same(multiset(before),multiset(after)),{before:before.size,after:after.size});
  const planned=await core.plan(root,[root],organizeOptions('{year}/{yyyymm}/{camera}'),metadata);
  check('after resume the library is fully organized',planned.plans[0]!.entries.every(e=>e.destination===e.source),planned.plans[0]!.entries.filter(e=>e.destination!==e.source).length);
  await observeInodes();
 });

 await scenario('9. Precomposed (NFC) names on exFAT',async()=>{
  const NFC=(name:string)=>name.normalize('NFC');
  const forms=(p:string)=>[...new Set([p.normalize('NFC'),p.normalize('NFD')])];
  const gone=async(p:string)=>(await Promise.all(forms(p).map(exists))).every(there=>!there);
  const appledouble=await import('../../../desktop/core/appledouble.ts');
  /** A "._" file holding only bookkeeping (a provenance attribute), laid out as macOS writes it. */
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
  const nfcSource=path.join(sourceBox,'nfc-source'),nfcLibrary=path.join(libraryBox,'nfc-library'),nfcOrg=path.join(libraryBox,'nfc-org');
  const names=[NFC('Éclair.JPG'),NFC('でんしゃ.JPG'),NFC('한글.JPG'),NFC('東京で')+'/'+NFC('駅.JPG')];
  const bytes=new Map<string,Buffer>();
  for(const name of names){const data=randomBytes(120_000+bytes.size);bytes.set(name,data);await gWrite(path.join(nfcSource,name),data);}
  const listed=await fs.readdir(nfcSource);
  console.log('stored names listed as:',listed.map(n=>`${n} [${n===n.normalize('NFC')?'NFC':n===n.normalize('NFD')?'NFD':'other'}]`).join(', '));
  await gMkdir(nfcLibrary);
  // Import, verify the copies.
  const planned=await core.plan(nfcSource,[nfcLibrary],importOptions,metadata);
  check('plan has no failures',planned.failures.length===0,planned.failures.map(f=>String(f.error)));
  const transfer=planned.plans[0]!;
  check('all four files are planned',transfer.entries.length===names.length,transfer.entries.map(e=>e.source));
  const outcomes=new Map<string,import('../../../desktop/core/destinations.ts').DestinationOutcome[]>();
  const destinations=await import('../../../desktop/core/destinations.ts');
  const result=await destinations.executeDestinations([transfer],{signal:new AbortController().signal,reorganize:false,verify:true,removeAppleDouble:false,keepSourceFolders:true,onFileOutcome:o=>{const list=outcomes.get(o.source);if(list)list.push(o);else outcomes.set(o.source,[o]);},validate:async()=>{},progress:()=>{},settled:()=>{}});
  check('import reports no errors',result.errors.length===0&&result.copied===names.length,result);
  const bad:string[]=[];
  for(const entry of transfer.entries){if(!await exists(entry.destination)||await fileSha(entry.destination)!==await fileSha(entry.source))bad.push(entry.destination);}
  check('every copy exists with the source SHA-256',bad.length===0,bad);
  // Delete originals, as main.ts removeOriginals calls it.
  const originals=await import('../../../desktop/core/originals.ts');
  const {files,withheld}=originals.verifiedOriginals(outcomes,[transfer]);
  check('every source is verified for deletion',files.length===names.length&&withheld.length===0,{files:files.length,withheld});
  const deleted=await originals.deleteOriginals(nfcSource,files,{protect:[],changeTimes:false});
  check('Delete originals deleted every file without errors',deleted.deleted.length===names.length&&deleted.errors.length===0&&deleted.kept.length===0,deleted);
  const survivors:string[]=[];
  for(const name of names)if(!await gone(path.join(nfcSource,name)))survivors.push(name);
  check('each source file is gone (lstat ENOENT in NFC and NFD)',survivors.length===0,survivors);
  check('the emptied NFC folder was removed by the folder cleanup',deleted.folders>=1&&await gone(path.join(nfcSource,NFC('東京で'))),{folders:deleted.folders,left:await fs.readdir(nfcSource)});
  // Organization of library files with NFC names.
  const shiba=NFC('東京で'),camera=NFC('카메라');
  await gWrite(path.join(nfcOrg,shiba,NFC('でんしゃ.JPG')),randomBytes(90_001));
  await gWrite(path.join(nfcOrg,camera,NFC('한글.JPG')),randomBytes(90_002));
  await gWrite(path.join(nfcOrg,camera,'notes.txt'),'keep');
  const sidecar=bookkeeping();
  const verdict=appledouble.inspectAppleDouble(sidecar);
  if(!verdict.safe)skip('AppleDouble sidecar removal','the generated sidecar is not judged bookkeeping-only: '+verdict.reason);
  else await gWrite(path.join(nfcOrg,camera,'._'+NFC('한글.JPG')),sidecar);
  const before=await treeOf(nfcOrg);
  const orgPlan=await core.plan(nfcOrg,[nfcOrg],organizeOptions('{camera}/{year}'),metadata);
  check('organize plan has no failures',orgPlan.failures.length===0,orgPlan.failures.map(f=>String(f.error)));
  const moved=await core.executeReorganization(orgPlan.plans[0]!,undefined,undefined,{removeAppleDouble:true});
  check('organization reports no errors',moved.errors.length===0,moved.errors);
  const after=await treeOf(nfcOrg);
  check('both media files moved with their hashes',after.size===before.size&&same(multiset(before),multiset(after)),{before:[...before.keys()],after:[...after.keys()]});
  check('the emptied NFC-named folder was removed',await gone(path.join(nfcOrg,shiba)),await fs.readdir(nfcOrg));
  if(verdict.safe)check('the bookkeeping-only "._" file beside the NFC-named file was removed',await gone(path.join(nfcOrg,camera,'._'+NFC('한글.JPG'))),{report:moved.appleDouble,left:await fs.readdir(path.join(nfcOrg,camera)).catch(()=>[])});
  check('notes.txt (not media) is untouched',await exists(path.join(nfcOrg,camera,'notes.txt')));
 });

 core.setMoveObserver(undefined);
 console.log('\n== exFAT inode observations');
 console.log(JSON.stringify(inodes));
 console.log(`files with a temporary (negative) inode: ${inodes.negative}; at or above 2^63: ${inodes.high}; 0-byte files: ${inodes.empty}; moves observed: ${inodes.moveObserved}, with a synthetic inode: ${inodes.moveSynthetic}`);
}
