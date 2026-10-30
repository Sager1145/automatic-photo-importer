/** Destinations: single / mirror / fill-first copy modes, isolation of a failing destination, space reservation across plans,
 * drive backup (additive and mirror), destination validation and the pure eject decisions. Two libraries on two volumes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import type {Context} from '../harness.mts';

export const title='Copy modes, failing destination, space reservation, drive backup, destination validation, eject decisions';

export default async function run(ctx:Context):Promise<void>{
 const {core,sourceBox,libraryBox,check,scenario,skip,gMkdir,gWrite,gRm,gCopy,guard,metadata,describe,fileSha,exists,treeOf,sameTree,files:FILES}=ctx;
 const allocation=await import('../../../desktop/core/allocation.ts');
 const driveBackup=await import('../../../desktop/core/drive-backup.ts');
 const destinations=await import('../../../desktop/core/destinations.ts');
 const volumesModule=await import('../../../desktop/platform/volumes.ts');
 const eject=await import('../../../desktop/source-eject.ts');
 const sourceDir=path.join(sourceBox,'sources');
 await gMkdir(sourceDir);

 // ---- source files: families of NEF + JPG + xmp (and single videos), distinct capture dates and cameras ----
 const generated=new Map<string,Buffer>();
 const stems:string[]=[];
 for(let i=1;generated.size<FILES;i++){
  const stem=`DST_${String(i).padStart(4,'0')}`;stems.push(stem);describe(stem,i);
  if(i%5===0)generated.set(stem+'.MP4',randomBytes(260_000+i*7));
  else{generated.set(stem+'.NEF',randomBytes(220_000+i*13));generated.set(stem+'.JPG',randomBytes(70_000+i*11));generated.set(stem+'.xmp',Buffer.from(`<x:xmpmeta>${stem}</x:xmpmeta>`));}
 }
 for(const [name,data] of generated)await gWrite(path.join(sourceDir,name),data);
 const sourceBefore=await treeOf(sourceDir);
 console.log(`generated ${generated.size} source files in ${stems.length} families`);
 check('source tree generated',sourceBefore.size===generated.size,{expected:generated.size,got:sourceBefore.size});

 const importOptions={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
 const run1={signal:new AbortController().signal,reorganize:false,verify:true,removeAppleDouble:false,keepSourceFolders:true,progress:()=>{},settled:()=>{}};
 const exec=(plans:Awaited<ReturnType<typeof core.plan>>['plans'],validate:(index:number)=>Promise<void>=async()=>{})=>destinations.executeDestinations(plans,{...run1,validate});
 const fresh=async(name:string)=>{const a=path.join(sourceBox,name,'A'),b=path.join(libraryBox,name,'B');await gMkdir(a);await gMkdir(b);return {a,b};};
 const sourceUnchanged=async(label:string)=>{const now=await treeOf(sourceDir);check(`${label}: source files unchanged (SHA-256)`,sameTree(sourceBefore,now),{before:sourceBefore.size,now:now.size});};
 type PlanT=Awaited<ReturnType<typeof core.plan>>['plans'][number];
 /** Every non-skipped planned file exists with its source's SHA-256. */
 const verifyPlan=async(label:string,plan:PlanT)=>{
  const bad:string[]=[];
  for(const entry of plan.entries){if(!await exists(entry.destination)||await fileSha(entry.destination)!==sourceBefore.get(path.relative(sourceDir,entry.source)))bad.push(entry.destination);}
  check(`${label}: every copy exists with the source SHA-256 (${plan.entries.length} files)`,bad.length===0,bad.slice(0,5));
 };
 const familyKey=(rel:string)=>path.basename(rel).replace(/\.[^.]*$/,'').toLowerCase();
 const plain=(plans:PlanT[])=>plans.length;
 void plain;

 // ---- 1. single ----
 await scenario('1. copyMode single: one destination',async()=>{
  const {a,b}=await fresh('single');
  const planned=await core.plan(sourceDir,[a],importOptions,metadata);
  check('plan has no failures and one destination',planned.failures.length===0&&planned.plans.length===1,planned.failures.map(f=>String(f.error)));
  const result=await exec(planned.plans);
  check('import reports no errors, copied everything',result.errors.length===0&&result.copied===generated.size,result);
  await verifyPlan('single',planned.plans[0]!);
  const onA=await treeOf(a);
  check('destination holds exactly the source files',onA.size===generated.size&&[...sourceBefore.values()].every(h=>[...onA.values()].includes(h)),{files:onA.size});
  check('the other library stays empty',(await treeOf(b)).size===0);
  await sourceUnchanged('single');
 });

 // ---- 2. mirror ----
 let mirrorPlan:PlanT[]=[];
 await scenario('2a. copyMode mirror: both destinations get every family',async()=>{
  const {a,b}=await fresh('mirror');
  const planned=await core.plan(sourceDir,[a,b],importOptions,metadata);
  check('plan has no failures and two destinations',planned.failures.length===0&&planned.plans.length===2,planned.failures.map(f=>String(f.error)));
  mirrorPlan=planned.plans;
  const result=await exec(planned.plans);
  check('import reports no errors, copied to both',result.errors.length===0&&result.copied===generated.size*2,{copied:result.copied,errors:result.errors});
  await verifyPlan('mirror disk 1',planned.plans[0]!);await verifyPlan('mirror disk 2',planned.plans[1]!);
  const ta=await treeOf(a),tb=await treeOf(b);
  check('both libraries hold identical trees (paths and SHA-256)',sameTree(ta,tb)&&ta.size===generated.size,{a:ta.size,b:tb.size});
  const fam=new Set([...ta.keys()].map(familyKey));
  check('every family is on both disks',stems.every(s=>fam.has(s.toLowerCase())),{families:fam.size,expected:stems.length});
  await sourceUnchanged('mirror');
 });

 await scenario('2b. mirror: a destination replaced mid-run fails alone',async()=>{
  const {a,b}=await fresh('mirror-fail');
  const planned=await core.plan(sourceDir,[a,b],importOptions,metadata);
  // The first destination's folder is deleted and recreated after planning: a different folder than the one planned.
  await fs.rmdir(await guard(a));await gMkdir(a);
  const result=await exec(planned.plans);
  check('the failure is reported for destination 1 only',result.errors.length>0&&result.errors.every(e=>e.startsWith('Destination 1:')),result.errors.slice(0,3));
  check('destination 2 got every file',result.copied>=generated.size,{copied:result.copied});
  await verifyPlan('surviving disk 2',planned.plans[1]!);
  check('destination 1 received nothing',(await treeOf(a)).size===0);
  await sourceUnchanged('mirror-fail replaced');
 });

 await scenario('2c. mirror: destination 2 fails validation, destination 1 completes',async()=>{
  const {a,b}=await fresh('mirror-validate');
  const planned=await core.plan(sourceDir,[a,b],importOptions,metadata);
  const result=await exec(planned.plans,async index=>{if(index===1)throw new Error('simulated: disk 2 not available');});
  check('the failure is reported for destination 2 only',result.errors.length===1&&result.errors[0]!.startsWith('Destination 2:'),result.errors);
  await verifyPlan('surviving disk 1',planned.plans[0]!);
  check('destination 2 received nothing',(await treeOf(b)).size===0);
  await sourceUnchanged('mirror-fail validation');
 });

 await scenario('2d. mirror: destination made read-only (chmod) fails alone',async()=>{
  const {a,b}=await fresh('mirror-chmod');
  const planned=await core.plan(sourceDir,[a,b],importOptions,metadata);
  // Create the folders the plan writes into first (planning does not), then try to take write permission away from one.
  await fs.chmod(await guard(a),0o555);
  let enforced=false;
  try{await gWrite(path.join(a,'probe.tmp'),'x');await gRm(path.join(a,'probe.tmp'));}catch{enforced=true;}
  try{
   if(!enforced)skip('chmod read-only destination','this exFAT mount ignores chmod (a probe file could still be created); isolation is covered by 2b and 2c');
   else{
    const result=await exec(planned.plans);
    check('destination 1 error is reported, destination 2 got every file',result.errors.some(e=>e.startsWith('Destination 1:'))&&!result.errors.some(e=>e.startsWith('Destination 2:')),result.errors.slice(0,3));
    await verifyPlan('surviving disk 2',planned.plans[1]!);
   }
  }finally{await fs.chmod(await guard(a),0o755);}
  await sourceUnchanged('mirror-chmod');
 });

 // ---- 3. sequential fill-first ----
 await scenario('3. copyMode sequential (fill-first): families never split, disk 2 gets only the rest',async()=>{
  const {a,b}=await fresh('fill');
  // Measure the families, then pick a capacity for disk 1 that holds roughly half of them.
  const probe=await core.plan(sourceDir,[a],importOptions,metadata);
  const familyBytes=new Map<string,number>();
  for(const e of allocation.destinationEntries(probe.plans[0]!))familyBytes.set(e.family,(familyBytes.get(e.family)??0)+e.size);
  const total=[...familyBytes.values()].reduce((x,y)=>x+y,0),largest=Math.max(...familyBytes.values());
  const capacity=Math.floor(total/2)+largest;
  const planned=await core.plan(sourceDir,[a,b],{...importOptions,fillFirst:first=>allocation.fillFirst(first,capacity).kept},metadata);
  check('plan has no failures and two destinations',planned.failures.length===0&&planned.plans.length===2,planned.failures.map(f=>String(f.error)));
  const [first,second]=planned.plans as [PlanT,PlanT];
  const n1=first.entries.length,n2=second.entries.length;
  check('disk 1 takes part, disk 2 takes the rest (no file twice, none lost)',n1>0&&n2>0&&n1+n2===generated.size,{n1,n2,total:generated.size});
  const sources1=new Set(first.entries.map(e=>e.source)),sources2=new Set(second.entries.map(e=>e.source));
  check('no source is planned for both disks',![...sources1].some(s=>sources2.has(s)));
  const fam1=new Set(first.entries.map(e=>e.family)),fam2=new Set(second.entries.map(e=>e.family));
  check('no family is split across the disks',![...fam1].some(f=>fam2.has(f)));
  check('disk 1 plan fits the simulated capacity',allocation.requiredTransferSpace(first)<=capacity,{needed:allocation.requiredTransferSpace(first),capacity});
  check('allocateDestinations accepts the split plans',(()=>{try{allocation.allocateDestinations([first,second],[capacity,Number.MAX_SAFE_INTEGER],'sequential');return true;}catch{return false;}})());
  check('allocateDestinations refuses when disk 2 cannot hold the rest (error.bothNeedSpace)',(()=>{try{allocation.allocateDestinations([first,second],[capacity,1],'sequential');return false;}catch(error){return (error as {key?:string;code?:string}).key==='error.bothNeedSpace'||/bothNeedSpace/.test(JSON.stringify(error)+String(error));}})());
  const result=await exec(planned.plans);
  check('import reports no errors',result.errors.length===0&&result.copied===generated.size,result);
  await verifyPlan('fill-first disk 1',first);await verifyPlan('fill-first disk 2',second);
  const ta=await treeOf(a),tb=await treeOf(b);
  const fa=new Set([...ta.keys()].map(familyKey)),fb=new Set([...tb.keys()].map(familyKey));
  check('on disk: families are disjoint between the libraries',![...fa].some(f=>fb.has(f)),{a:fa.size,b:fb.size});
  check('on disk: the two libraries together equal the source',ta.size+tb.size===generated.size&&[...sourceBefore.values()].sort().join()===[...ta.values(),...tb.values()].sort().join());
  check('every family is complete on its disk (all its files together)',stems.every(s=>{const key=s.toLowerCase();const expected=[...generated.keys()].filter(n=>familyKey(n)===key).length;const got=[...ta.keys()].filter(k=>familyKey(k)===key).length+[...tb.keys()].filter(k=>familyKey(k)===key).length;return got===expected&&(fa.has(key)!==fb.has(key));}));
  await sourceUnchanged('fill-first');
  // A capacity that holds everything keeps disk 2 empty.
  const roomyDir=path.join(a,'roomy');await gMkdir(roomyDir);
  const roomy=await core.plan(sourceDir,[roomyDir,b],{...importOptions,fillFirst:f=>allocation.fillFirst(f,Number.MAX_SAFE_INTEGER).kept},metadata);
  check('with room for everything disk 2 is planned empty',roomy.plans[0]!.entries.length===generated.size&&roomy.plans[1]!.entries.length===0,{n1:roomy.plans[0]!.entries.length,n2:roomy.plans[1]!.entries.length});
 });

 // ---- 4. space reservation ----
 await scenario('4. Space reservation across two concurrent plans on one volume',async()=>{
  const r1=await fresh('reserve-1'),r2=await fresh('reserve-2');
  const volumes=await volumesModule.mountedVolumes();
  const volA1=allocation.reservationVolume(volumes,r1.a),volA2=allocation.reservationVolume(volumes,r2.a),volB=allocation.reservationVolume(volumes,r1.b);
  check('two folders on one volume share one reservation key',volA1===volA2,{volA1,volA2});
  check('the key is the mounted volume, not the folder',volA1===ctx.sourceVolume||volA1.startsWith('/Volumes/'),volA1);
  check('a folder on the other volume has its own key (when the volumes differ)',ctx.sourceVolume===ctx.libraryVolume||volB!==volA1,{volA1,volB});
  const p1=(await core.plan(sourceDir,[r1.a],importOptions,metadata)).plans[0]!,p2=(await core.plan(sourceDir,[r2.a],importOptions,metadata)).plans[0]!;
  const need1=allocation.requiredTransferSpace(p1),need2=allocation.requiredTransferSpace(p2);
  check('a plan needs at least its pending bytes',need1>=[...generated.values()].reduce((s,d)=>s+d.length,0),{need1});
  const reservations=new Map<string,{volume:string;bytes:number}[]>([['job1',[{volume:volA1,bytes:need1}]]]);
  const free=need1+need2+10_000_000;
  const infoOf=(p:string)=>({path:p,free});
  const seenByJob2=allocation.freeAfterReservations('job2',[infoOf(r2.a)],volumes,reservations)[0]!;
  const seenByJob1=allocation.freeAfterReservations('job1',[infoOf(r1.a)],volumes,reservations)[0]!;
  check('job 2 sees free space reduced by job 1\'s reservation',seenByJob2===free-need1,{seenByJob2,expected:free-need1});
  check('a job never counts its own reservation',seenByJob1===free,{seenByJob1,free});
  if(volB!==volA1){const other=allocation.freeAfterReservations('job2',[infoOf(r1.b)],volumes,reservations)[0]!;check('a reservation on one volume does not reduce another volume',other===free,{other});}
  check('job 2 is accepted when both fit',(()=>{try{allocation.allocateDestinations([p2],[seenByJob2],'single');return true;}catch{return false;}})());
  const tight=allocation.freeAfterReservations('job2',[{path:r2.a,free:need1+need2-1}],volumes,reservations)[0]!;
  check('job 2 is refused when the shared volume cannot hold both',(()=>{try{allocation.allocateDestinations([p2],[tight],'single');return false;}catch{return true;}})(),{tight,need2});
  const released=new Map(reservations);released.delete('job1');
  check('a finished job releases its space',allocation.freeAfterReservations('job2',[infoOf(r2.a)],volumes,released)[0]===free);
  // Two plans really running at once on the same volume.
  const [x,y]=await Promise.all([exec([p1]),exec([p2])]);
  check('two concurrent imports on one volume report no errors',x.errors.length===0&&y.errors.length===0&&x.copied===generated.size&&y.copied===generated.size,{x:x.errors,y:y.errors});
  await verifyPlan('concurrent plan 1',p1);await verifyPlan('concurrent plan 2',p2);
  await sourceUnchanged('reservation');
 });

 // ---- 5. drive backup ----
 await scenario('5. Drive backup: additive keeps removed files; mirror moves them to "Removed by mirror"; restore verified',async()=>{
  const {a,b}=await fresh('drive');
  const driveSource=path.join(sourceBox,'drive-source');
  const files=new Map<string,Buffer>();
  files.set('root.txt',randomBytes(5_000));
  for(let i=0;i<Math.max(8,Math.floor(FILES/2));i++)files.set(`${i%2?'DCIM/100HWT':'DCIM/101HWT'}/IMG_${String(i).padStart(4,'0')}.JPG`,randomBytes(60_000+i));
  files.set('notes/readme.md',Buffer.from('keep me'));
  for(const [rel,data] of files)await gWrite(path.join(driveSource,rel),data);
  const origin=new Map<string,string>();for(const [rel,data] of files)origin.set(rel,ctx.sha(data));
  const drive=(mirror:boolean)=>({name:'HWDRIVE',identity:'volume:PIHWT03-'+path.basename(a)+':',mirror});
  const request=(mirror:boolean)=>({backup:true as const,unknownRules:{},drive:drive(mirror)});
  const folderIn=(root:string)=>path.join(root,driveBackup.DRIVE_BACKUPS,'HWDRIVE');
  const backupOf=async(root:string)=>{const t=await treeOf(folderIn(root));return t;};

  // Additive.
  const first=await core.plan(driveSource,[a,b],request(false),metadata);
  check('additive plan has no failures, two destinations',first.failures.length===0&&first.plans.length===2,first.failures.map(f=>String(f.error)));
  check('additive plan lists no removals',first.plans.every(p=>!p.removals));
  const r1=await exec(first.plans);
  check('first drive backup reports no errors',r1.errors.length===0&&r1.copied===files.size*2,r1);
  for(const root of [a,b]){const t=await backupOf(root);check(`backup on ${root===a?'disk 1':'disk 2'} mirrors the drive layout with the drive SHA-256s`,t.size===files.size&&[...files.keys()].every(rel=>t.get(rel.split('/').join(path.sep))===origin.get(rel)),{files:t.size});}
  const removedA='DCIM/100HWT/IMG_0001.JPG',removedB='notes/readme.md',changed='DCIM/101HWT/IMG_0000.JPG';
  await gRm(path.join(driveSource,removedA));await gRm(path.join(driveSource,removedB));
  const newBytes=randomBytes(files.get(changed)!.length);                       // same size, different content
  await gWrite(path.join(driveSource,changed),newBytes);
  const newSha=ctx.sha(newBytes);
  const additive=await core.plan(driveSource,[a,b],request(false),metadata);
  check('additive re-plan finds no removals',additive.plans.every(p=>!p.removals?.length));
  const ra=await exec(additive.plans);
  check('additive re-run reports no errors',ra.errors.length===0,ra.errors);
  for(const root of [a,b]){
   check(`additive keeps the files deleted from the drive (${root===a?'disk 1':'disk 2'})`,await exists(path.join(folderIn(root),removedA))&&await exists(path.join(folderIn(root),removedB)));
  }
  // Mirror: a fresh pair of destinations seeded by a full additive backup of the original content, so the review sees 2 missing + 1 changed.
  const m=await fresh('drive-mirror');
  // Seed both mirror destinations with the ORIGINAL drive content through the real code path (claims the folder with its marker).
  const seedSource=path.join(sourceBox,'drive-seed');
  for(const [rel,data] of files)await gWrite(path.join(seedSource,rel),data);
  const seedPlan=await core.plan(seedSource,[m.a,m.b],request(true),metadata);
  check('seed mirror plan (nothing to remove yet) lists no removals',seedPlan.plans.every(p=>!p.removals?.length),seedPlan.plans.map(p=>p.removals));
  const rs=await exec(seedPlan.plans);
  check('seed backup reports no errors',rs.errors.length===0&&rs.copied===files.size*2,rs);
  const seeded=await backupOf(m.a);
  check('seeded mirror destination holds the original drive',seeded.size===files.size);
  const reviewed=await core.plan(driveSource,[m.a,m.b],request(true),metadata);
  check('mirror review has no failures',reviewed.failures.length===0,reviewed.failures.map(f=>String(f.error)));
  for(const [i,p] of reviewed.plans.entries()){
   const removals=p.removals??[];
   const rels=removals.map(r=>path.relative(folderIn(i?m.b:m.a),r.path).split(path.sep).join('/')).sort();
   check(`mirror detects the 2 removed files and the changed one on disk ${i+1}`,rels.length===3&&rels.join()===[changed,removedA,removedB].sort().join(),rels);
   check(`removal reasons are missing/changed on disk ${i+1}`,removals.filter(r=>r.reason==='missing').length===2&&removals.filter(r=>r.reason==='changed').length===1,removals.map(r=>r.reason));
  }
  const beforeRun=await backupOf(m.a);
  check('review alone moves nothing (backup unchanged until executed)',beforeRun.size===files.size&&beforeRun.get(removedA.split('/').join(path.sep))===origin.get(removedA));
  const rm=await exec(reviewed.plans);
  check('mirror run reports no errors',rm.errors.length===0,rm.errors);
  check('mirror run moved 3 files aside on each disk',rm.removed===6,{removed:rm.removed});
  for(const [i,root] of [m.a,m.b].entries()){
   const label=`disk ${i+1}`,t=await backupOf(root);
   check(`${label}: removed files are gone from the drive folder`,!t.has(removedA.split('/').join(path.sep))&&!t.has(removedB.split('/').join(path.sep)));
   check(`${label}: the changed file now has the drive's new content`,t.get(changed.split('/').join(path.sep))===newSha);
   const holdingRoot=path.join(root,driveBackup.DRIVE_BACKUPS,'Removed by mirror');
   const held=await treeOf(holdingRoot);
   const heldByRel=new Map([...held].map(([k,v])=>[k.split(path.sep).slice(2).join('/'),v]));   // <stamp>/<drive folder>/<rel>
   check(`${label}: the holding folder keeps the removed files with their original SHA-256 (never deleted)`,heldByRel.get(removedA)===origin.get(removedA)&&heldByRel.get(removedB)===origin.get(removedB),[...heldByRel.keys()]);
   check(`${label}: the replaced version of the changed file is kept too`,heldByRel.get(changed)===origin.get(changed));
   check(`${label}: nothing was lost (kept + held cover every file ever backed up)`,t.size+held.size===files.size+1,{kept:t.size,held:held.size});
   check(`${label}: the emptied "notes" folder is removed from the drive folder`,!await exists(path.join(folderIn(root),'notes')));
  }
  // Restore: copy the backup back and compare with the drive.
  const restore=path.join(sourceBox,'restore');
  const t=await backupOf(m.a);
  for(const rel of t.keys())await gCopy(path.join(folderIn(m.a),rel),path.join(restore,rel));
  const restored=await treeOf(restore),drive0=await treeOf(driveSource);
  check('restore from the mirror backup equals the drive (SHA-256)',sameTree(restored,drive0),{restored:restored.size,drive:drive0.size});
  // The additive destinations still restore the old files too.
  const restoreAdd=path.join(sourceBox,'restore-additive');
  for(const rel of (await backupOf(a)).keys())await gCopy(path.join(folderIn(a),rel),path.join(restoreAdd,rel));
  const ra2=await treeOf(restoreAdd);
  check('additive backup restores every file ever backed up, removed ones included',[...files.keys()].every(rel=>rel===changed||ra2.get(rel.split('/').join(path.sep))===origin.get(rel)),ra2.size);
  // A foreign folder under the drive's name is not claimed.
  check('driveFolder gives the same drive the same folder',await driveBackup.driveFolder(m.a,drive(true))==='HWDRIVE');
  check('driveFolder gives another drive a numbered folder',await driveBackup.driveFolder(m.a,{...drive(true),identity:'volume:OTHER:'})==='HWDRIVE 2');
  const mirrorAgain=await core.plan(driveSource,[m.a,m.b],request(true),metadata);
  check('after the mirror run a new review finds nothing to remove',mirrorAgain.plans.every(p=>!p.removals?.length),mirrorAgain.plans.map(p=>p.removals?.length));
  await sourceUnchanged('drive backup (sources dir)');
 });

 // ---- 6. destination validation ----
 await scenario('6. Destination validation',async()=>{
  const {a,b}=await fresh('validate');
  const known:never[]=[];
  for(const [label,dir] of [['source-volume library',a],['library-volume library',b]] as const){
   const info=await volumesModule.validateDestination(dir,known).then(i=>i,e=>e as Error);
   check(`validateDestination accepts the ${label}`,!(info instanceof Error)&&info.available===true&&!!info.volumeId&&(info.free??0)>0,info instanceof Error?String(info):info);
   if(!(info instanceof Error)){
    const again=await volumesModule.validateDestination(dir,known,{identity:info.volumeId}).then(()=>true,()=>false);
    check(`${label}: the saved volume identity is accepted`,again);
    const wrong=await volumesModule.validateDestination(dir,known,{identity:'0000-wrong'}).then(()=>false,()=>true);
    check(`${label}: a different volume identity is refused`,wrong);
   }
  }
  const missingChild=path.join(b,'does','not','exist','yet');
  check('a folder that does not exist yet (parent present) is accepted',await volumesModule.validateDestination(missingChild,known).then(i=>i.available,()=>false));
  check('a relative destination is refused',await volumesModule.validateDestination('relative/path',known).then(()=>false,()=>true));
  check('a destination inside a known source is refused',await volumesModule.validateDestination(path.join(a,'inside'),[{id:'s',name:'s',path:a,transport:'folder'} as never]).then(()=>false,()=>true));
  // onCameraCard on the real mounts.
  const volumes=await volumesModule.mountedVolumes();
  for(const [label,dir] of [['source volume',a],['library volume',b]] as const){
   const volume=volumesModule.volumeOf(volumes,dir);
   const card=await volumesModule.onCameraCard(dir);
   console.log(`INFO  onCameraCard(${label}) = ${card}; volume ${JSON.stringify({path:volume?.path,fsType:volume?.fsType,external:volume?.external,removable:volume?.removable,diskImage:volume?.diskImage,kind:volume?.kind})}`);
   check(`onCameraCard is false for the ${label} (a plain external drive is not a camera card)`,card===false,{card,volume});
  }
  // Synthetic: a plain external SSD (not removable, no camera folders) is neither a card nor refused; a DCIM volume is.
  const ssd={path:'/Volumes/PIHWT03-SSD',external:true,removable:false,fsType:'exfat'};
  const classify=async(v:typeof ssd)=>volumesModule.classifyVolume(v,['Photos','Projects','Backups']) as {camera:boolean;source:boolean};
  check('synthetic plain external SSD (non-removable, ordinary folders): onCameraCard false',await volumesModule.onCameraCard('/Volumes/PIHWT03-SSD/x',{volumes:async()=>[ssd],classify:classify as never})===false);
  const card={...ssd,removable:true};
  const cardVerdict=await volumesModule.onCameraCard('/Volumes/PIHWT03-SSD/x',{volumes:async()=>[card],classify:(async v=>volumesModule.classifyVolume(v,['DCIM'])) as never});
  check('synthetic DCIM volume: onCameraCard true',cardVerdict===true);
  const flashVerdict=await volumesModule.onCameraCard('/Volumes/PIHWT03-SSD/x',{volumes:async()=>[card],classify:(async v=>volumesModule.classifyVolume(v,['Photos'])) as never});
  console.log(`INFO  synthetic removable-flagged volume with ordinary folders (no DCIM): onCameraCard = ${flashVerdict} (classifyVolume treats removable=true as a source)`);
  check('synthetic unknown volume counts as a card (safe answer)',await volumesModule.onCameraCard('/nowhere/x',{volumes:async()=>[]})===true);
 });

 // ---- 7. eject decisions (pure; nothing is ejected) ----
 await scenario('7. Eject decisions (pure functions, no real eject)',async()=>{
  const mk=(id:string,p:string,transport='storage'):never=>({id,name:id,path:p,transport} as never);
  const drive=mk('d1','/Volumes/CARD1'),camera=mk('c1','camera://x','camera'),folder=mk('f1','/Volumes/CARD1/DCIM','folder');
  const job=(id:string,source:never,phase:string,extra:object={}):never=>({id,source,phase,errors:[],groups:[],...extra} as never);
  check('ejectable: storage and folder yes, camera no',eject.ejectable(drive)&&eject.ejectable(folder)&&!eject.ejectable(camera));
  check('overlaps: a folder on a card overlaps the card; empty paths never overlap',eject.overlaps('/Volumes/CARD1/DCIM','/Volumes/CARD1')&&!eject.overlaps('/Volumes/CARD1','/Volumes/CARD2')&&!eject.overlaps('','/x')&&!eject.overlaps('/Volumes/CARD10','/Volumes/CARD1'));
  const idle={sources:[drive,folder],jobs:[] as never[]};
  check('an idle source is not in use',!eject.sourceInUse(idle as never,drive));
  const running={sources:[drive,folder],jobs:[job('j1',drive,'copying')]};
  check('a running job on the card puts it, and a folder inside it, in use',eject.sourceInUse(running as never,drive)&&eject.sourceInUse(running as never,folder));
  check('a scan in progress puts the source in use',eject.sourceInUse({...idle,scanningSources:['d1']} as never,drive));
  check('a busy path inside the card puts it in use',eject.sourceInUse({...idle,busyPaths:['/Volumes/CARD1/DCIM/x']} as never,drive));
  check('a different volume is unaffected',!eject.sourceInUse({...idle,busyPaths:['/Volumes/CARD2/x']} as never,drive));
  const done={sources:[drive,camera],jobs:[job('j2',drive,'complete'),job('j3',camera,'complete')]};
  check('doneSources: a clean complete card is offered, a camera never',eject.doneSources(done as never).map(s=>s.id).join()==='d1');
  check('doneSources: a card holding a backup is not offered',eject.doneSources(done as never,s=>s.id==='d1').length===0);
  check('doneSources: a failed import is not offered',eject.doneSources({sources:[drive],jobs:[job('j4',drive,'complete',{failedFiles:2})]} as never).length===0);
  check('doneSources: a card in use is not offered',eject.doneSources({sources:[drive],jobs:[job('j6',drive,'queued'),job('j5',drive,'complete')]} as never).length===0);
  const prefs={autoEject:true,deleteOriginalsCards:false,verifyCopies:true};
  const j=job('j7',drive,'complete');
  const viewDone={sources:[drive],jobs:[j]};
  check('autoEjectDecision: clean verified import ejects',eject.autoEjectDecision(viewDone as never,j,drive as never,prefs)==='eject');
  check('autoEjectDecision: off when autoEject is false',eject.autoEjectDecision(viewDone as never,j,drive as never,{...prefs,autoEject:false})==='no');
  check('autoEjectDecision: never for a folder or a camera',eject.autoEjectDecision({sources:[folder],jobs:[job('j8',folder,'complete')]} as never,job('j8',folder,'complete'),folder as never,prefs)==='no');
  check('autoEjectDecision: a card holding a backup is not ejected',eject.autoEjectDecision(viewDone as never,j,drive as never,prefs,()=>true)==='no');
  check('autoEjectDecision: busy while a scan uses the card',eject.autoEjectDecision({...viewDone,scanningSources:['d1']} as never,j,drive as never,prefs)==='busy');
  const failed=job('j9',drive,'complete',{failedFiles:1});
  check('autoEjectDecision: a failed import is not ejected',eject.autoEjectDecision({sources:[drive],jobs:[failed]} as never,failed,drive as never,prefs)==='no');
  check('originalsVolumeChanged: a different recorded volume is detected',eject.originalsVolumeChanged('A','B')&&!eject.originalsVolumeChanged('A','A')&&!eject.originalsVolumeChanged(undefined,'B'));
  check('originalsBlocked: another live job on the card blocks Delete originals',eject.originalsBlocked({sources:[drive],jobs:[job('x1',drive,'copying'),job('x2',drive,'complete')]} as never,job('x2',drive,'complete'),'/Volumes/CARD1')&&!eject.originalsBlocked({sources:[drive],jobs:[job('x2',drive,'complete')]} as never,job('x2',drive,'complete'),'/Volumes/CARD1'));
 });
}
