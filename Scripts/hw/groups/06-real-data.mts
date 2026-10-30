/**
 * Real user files, strictly READ-ONLY: scan, metadata (ExifTool), thumbnails and an import into the sandbox library.
 *
 *   HW_REAL_SOURCES=/Volumes/A006/2024/111SWART,/Volumes/Untitled/2018.4签名 node --import tsx Scripts/hw/run.mts --source=... --library=... --only=06-real-data
 *
 * The real folders are only ever READ (listed, hashed, given to ExifTool/sips/qlmanage, used as an import source).
 * Every write target is inside the sandbox (library) or the harness's temp app-data folder (HOME: thumbnail cache,
 * user caches). Every real file this group reads is registered with witnessFiles() first, so the run fails if one
 * changes; the names, sizes, mtimes and inodes of ALL files in each folder are also compared before and after.
 * Optional: HW_REAL_IMPORT_FILES (media files imported per folder, default 300), HW_REAL_IMPORT_MAX_MB (default 4096).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {Context} from '../harness.mts';
import type {InventoryFile,Metadata} from '../../../desktop/shared.ts';

export const title='Real files (read-only): scan, metadata, thumbnails, import';

const IMPORT_FILES=Math.max(1,Number(process.env.HW_REAL_IMPORT_FILES)||300);
const IMPORT_MAX_BYTES=(Number(process.env.HW_REAL_IMPORT_MAX_MB)||4096)*1024*1024;
const SAMPLE=40;
const importOptions={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};

const norm=(text:string)=>text.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const inside=(parent:string,child:string)=>{const r=path.relative(parent,child);return r!==''&&!r.startsWith('..')&&!path.isAbsolute(r);};
const ms=(n:number)=>`${n.toFixed(0)} ms`;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);

/** name -> "size:mtimeNs:ino" for every entry under dir: a read-only listing (lstat only). */
async function listing(dir:string):Promise<Map<string,string>>{
 const out=new Map<string,string>();
 for(const entry of await fs.readdir(dir,{withFileTypes:true,recursive:true})){
  const file=path.join(entry.parentPath,entry.name),s=await fs.lstat(file,{bigint:true});
  out.set(path.relative(dir,file),`${entry.isDirectory()?'d':'f'}:${s.size}:${s.mtimeNs}:${s.ino}`);
 }
 return out;
}
const diffListing=(a:Map<string,string>,b:Map<string,string>)=>[...new Set([...a.keys(),...b.keys()])].filter(k=>a.get(k)!==b.get(k));

export default async function run(ctx:Context):Promise<void>{
 const {core,check,scenario,skip,witnessFiles,fileSha,exists,libraryBox,sourceBox}=ctx;
 const raw=(process.env.HW_REAL_SOURCES??'').split(',').map(s=>s.trim()).filter(Boolean);
 if(!raw.length){skip('real data','HW_REAL_SOURCES is not set (comma-separated read-only folders, each under /Volumes/<name>/)');return;}

 // ---- validate the inputs: under /Volumes/<name>/, real directories, never inside (or around) a sandbox ----
 const sandboxes=[...new Set([path.dirname(sourceBox),path.dirname(libraryBox)])];
 const folders:string[]=[];
 for(const entry of raw){
  const resolved=path.resolve(entry);
  if(!/^\/Volumes\/[^/]+\/.+/.test(resolved)){check(`input ${entry}: under /Volumes/<name>/`,false,'must be a folder beneath a volume, not the volume root');continue;}
  let real:string;
  try{real=await fs.realpath(resolved);}catch(error){check(`input ${entry}: readable`,false,String(error));continue;}
  const bad=!/^\/Volumes\/[^/]+\/.+/.test(real)?'resolves outside /Volumes/<name>/: '+real
   :sandboxes.some(box=>real===box||inside(box,real)||inside(real,box))?'is inside (or contains) a sandbox'
   :path.basename(real).startsWith('photo-importer-hw-test-')?'looks like a sandbox'
   :!(await fs.stat(real)).isDirectory()?'is not a directory':'';
  if(bad){check(`input ${entry}: acceptable read-only source`,false,bad);continue;}
  folders.push(real);
 }
 if(!folders.length)return;
 const tmp=await fs.realpath(os.tmpdir());
 const home=process.env.HOME!;
 const thumbCache=path.join(home,'hw-real-thumbnails');
 check('thumbnail cache and user caches are in the temp app-data folder',inside(tmp,home)&&folders.every(f=>!inside(f,home)),home);

 const {metadata,embeddedPreview,closeMetadata}=await import('../../../desktop/platform/metadata.ts');
 const {thumbnail,systemDecoders}=await import('../../../desktop/platform/thumbnails.ts');
 const {mediaKindForPath}=await import('../../../desktop/media-formats.ts');
 const {ignoredName}=await import('../../../desktop/core/inventory.ts');
 const summaryOf=(file:string)=>metadata(file,{details:false});

 const compareTotals={files:0,date:0,camera:0,exposure:0,shutter:0,fingerprint:0,other:0,identical:0};
 try{
  for(const [index,folder] of folders.entries()){
   const label=`[${index+1}/${folders.length}] ${folder}`;
   console.log(`\n######## real folder ${label}`);
   const before=await listing(folder);
   let files:InventoryFile[]=[];
   let sample:InventoryFile[]=[];
   let subset:InventoryFile[]=[];

   // ---------------------------------------------------------------------------------------------- scan
   await scenario(`${label} Scan: inventory against an independent walk`,async()=>{
    const started=performance.now();
    const inv=await core.inventory(folder,{});
    console.log(`inventory: ${inv.files.length} files, ${inv.media} media, ${inv.companions} companions, ${inv.unknown} unknown, ${inv.system??0} system, ${inv.empty??0} empty, ${inv.bytes} bytes included, ${ms(performance.now()-started)}`);
    console.log('formats:',JSON.stringify(Object.fromEntries(Object.entries(inv.formats).map(([k,v])=>[k,v.files]))));
    console.log('unknown extensions:',JSON.stringify(inv.unknownExtensions),' system kinds:',JSON.stringify(inv.systemKinds));
    files=inv.files;
    // Independent walk: regular files only, no app artifacts or "._" files.
    let walkMedia=0,walkEmpty=0,walkOther=0,walkTotal=0;const walkKinds:Record<string,number>={};
    for(const entry of await fs.readdir(folder,{withFileTypes:true,recursive:true})){
     if(!entry.isFile()||ignoredName(entry.name))continue;
     walkTotal++;
     const kind=mediaKindForPath(entry.name),size=(await fs.lstat(path.join(entry.parentPath,entry.name))).size;
     if(kind==='Other'){walkOther++;continue;}
     if(size===0){walkEmpty++;continue;}
     walkMedia++;walkKinds[kind]=(walkKinds[kind]??0)+1;
    }
    const invKinds:Record<string,number>={};for(const f of inv.files)if(f.kind!=='Other'){invKinds[f.kind]=(invKinds[f.kind]??0)+1;}
    console.log(`walk: ${walkTotal} files, ${walkMedia} media ${JSON.stringify(walkKinds)}, ${walkEmpty} empty media, ${walkOther} non-media`);
    check('media count equals the independent walk',inv.media===walkMedia,{inventory:inv.media,walk:walkMedia});
    check('media count per kind equals the independent walk',same(Object.entries(invKinds).sort(),Object.entries(walkKinds).sort()),{invKinds,walkKinds});
    check('empty media files are reported as skipped, not listed',(inv.empty??0)===walkEmpty,{inventory:inv.empty,walk:walkEmpty});
    check('every listed file exists with the listed size',(await Promise.all(inv.files.map(async f=>(await fs.lstat(f.path).catch(()=>undefined))?.size===f.size))).every(Boolean));
    check('companions counted consistently',inv.companions===inv.files.filter(f=>!!f.companionOf).length);
    check('every companion points at a listed file',inv.files.filter(f=>f.companionOf).every(f=>inv.files.some(o=>o.path===f.companionOf)));
    check('unknown count equals the sum of unknown extensions',inv.unknown===Object.values(inv.unknownExtensions).reduce((a,b)=>a+b,0),{unknown:inv.unknown,extensions:inv.unknownExtensions});
    check('format figures add up to the media count',Object.values(inv.formats).reduce((a,v)=>a+v.files,0)===inv.media);
    const listedOther=inv.files.filter(f=>f.kind==='Other').length;
    console.log(`non-media listed: ${listedOther} (companions ${inv.companions}, system ${inv.system??0}, unknown ${inv.unknown}); walk non-media ${walkOther}; skipped entries ${inv.skipped?.length??0}`);
    check('every non-media walked file is listed or skipped with a reason',walkOther<=listedOther+(inv.skipped?.length??0),{walkOther,listedOther,skipped:inv.skipped?.length});
    skip(`${label} scan worker`,'desktop/scan-worker.ts needs Electron\'s process.parentPort; the inventory it runs is exercised above');
    // Sample across formats (round robin over evenly spread picks per extension).
    const byExt=new Map<string,InventoryFile[]>();
    for(const f of [...inv.files].filter(f=>f.kind!=='Other'&&!f.companionOf&&f.size>0).sort((a,b)=>a.relative<b.relative?-1:1)){const e=path.extname(f.path).toLowerCase();byExt.set(e,[...(byExt.get(e)??[]),f]);}
    const picks=[...byExt.entries()].sort((a,b)=>a[0]<b[0]?-1:1).map(([,list])=>{const n=Math.min(list.length,SAMPLE);return Array.from({length:n},(_,i)=>list[Math.floor(i*list.length/n)]!);});
    for(let round=0;sample.length<SAMPLE&&picks.some(p=>p[round]);round++)for(const p of picks)if(p[round]&&sample.length<SAMPLE)sample.push(p[round]!);
    console.log('metadata/thumbnail sample:',sample.length,'files; extensions',JSON.stringify([...new Set(sample.map(f=>path.extname(f.path).toLowerCase()))]));
    // Import subset: whole families only. A family is every included file of one folder sharing the stem before the first dot
    // (RAW+JPG pairs, sidecars, " (n)" copies) plus anything linked by companionOf. The cap stops before a family, never inside one.
    const stemKey=(f:InventoryFile)=>path.dirname(f.path)+'\0'+path.basename(f.path).split('.')[0]!.replace(/ \(\d+\)$/,'').normalize('NFC').toLowerCase();
    const rootOf=(f:InventoryFile):InventoryFile=>{let cur=f;const seen=new Set<string>();while(cur.companionOf&&!seen.has(cur.path)){seen.add(cur.path);const next=inv.files.find(o=>o.path===cur.companionOf);if(!next)break;cur=next;}return cur;};
    const families=new Map<string,InventoryFile[]>();
    for(const f of inv.files)if(f.included&&!f.system){const k=stemKey(rootOf(f));families.set(k,[...(families.get(k)??[]),f]);}
    // Union families that a companionOf link joins across stems (e.g. IMG.ARW.xmp) so they stay whole too.
    let bytes=0,count=0;
    const order=[...families.entries()].filter(([,m])=>m.some(f=>f.kind!=='Other'&&f.size>0)).sort((a,b)=>a[1][0]!.relative<b[1][0]!.relative?-1:1);
    for(const [,family] of order){
     const size=family.reduce((s,m)=>s+m.size,0),media=family.filter(m=>m.kind!=='Other').length;
     if(count+media>IMPORT_FILES||bytes+size>IMPORT_MAX_BYTES)break;
     subset.push(...family);bytes+=size;count+=media;
    }
    console.log(`import subset: ${count} media file(s), ${subset.length} with companions, ${(bytes/1048576).toFixed(1)} MB`);
    // Register everything this group will read BEFORE reading it.
    const toRead=new Map<string,string>();for(const f of [...sample,...subset])toRead.set(f.path,f.path);
    await witnessFiles([...toRead.keys()]);
    console.log(`witnessed ${toRead.size} real file(s)`);
   });
   if(!files.length){skip(`${label} remaining scenarios`,'no files listed');continue;}

   // ---------------------------------------------------------------------------------------------- metadata
   await scenario(`${label} Metadata: full reading, routing reading, comparison`,async()=>{
    if(!sample.length){skip('metadata','no media files');return;}
    const times:number[]=[];let datesOk=0,cameras=0,shutters=0,exposures=0,noDateRaw:string[]=[],noCamera:string[]=[],makeNoCamera:string[]=[],badDate:string[]=[],unequal:string[]=[];
    const perExt = new Map<string,{n:number;withDate:number;withCamera:number}>();
    const diffs:Record<string,number>={};
    for(const f of sample){
     const t0=performance.now();
     const full:Metadata=await metadata(f.path);
     times.push(performance.now()-t0);
     const quick:Metadata=await summaryOf(f.path);
     const e=path.extname(f.path).toLowerCase(),stat=perExt.get(e)??{n:0,withDate:0,withCamera:0};stat.n++;
     const rel=f.relative;
     if(full.date){
      const parsed=Date.parse(full.date.slice(0,19)+'Z');
      if(Number.isFinite(parsed)&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)?$/.test(full.date)&&parsed>Date.UTC(1990,0,1)&&parsed<Date.now()+86_400_000){datesOk++;stat.withDate++;}else badDate.push(`${rel}: ${full.date}`);
     }else if(f.kind==='RAW')noDateRaw.push(rel);
     if(full.camera?.trim()){cameras++;stat.withCamera++;}else{noCamera.push(rel);if(full.make)makeNoCamera.push(`${rel} (make ${full.make})`);}
     if(full.shutterCount!==undefined)shutters++;
     if(full.exposure)exposures++;
     perExt.set(e,stat);
     console.log(`  ${rel.slice(-60).padEnd(60)} ${String(full.camera??'-').padEnd(22)} ${String(full.date??'-').padEnd(30)} exp=${full.exposure?`f/${full.exposure.aperture??'?'} ${full.exposure.exposureTime??'?'}s iso${full.exposure.iso??'?'}`:'-'} shutter=${full.shutterCount??'-'}(${full.shutterNote})`);
     // summary vs full
     compareTotals.files++;let identical=true;
     const field=(name:string,a:unknown,b:unknown,bucket:keyof typeof compareTotals)=>{if(!same(a,b)){identical=false;compareTotals[bucket]++;diffs[name]=(diffs[name]??0)+1;unequal.push(`${rel}: ${name} full=${JSON.stringify(a)} summary=${JSON.stringify(b)}`);}};
     field('date',full.date,quick.date,'date');field('camera',full.camera,quick.camera,'camera');
     field('exposure',full.exposure,quick.exposure,'exposure');
     field('shutter',[full.shutterCount,full.shutterNote],[quick.shutterCount,quick.shutterNote],'shutter');
     field('fingerprint',full.fingerprint,quick.fingerprint,'fingerprint');
     for(const name of ['edited','make','contentId','origin'] as const)field(name,full[name],quick[name],'other');
     if(identical)compareTotals.identical++;
    }
    const sorted=[...times].sort((a,b)=>a-b);
    console.log(`full-read timing over ${times.length} files: median ${ms(sorted[Math.floor(sorted.length/2)]!)}, max ${ms(sorted.at(-1)!)}`);
    console.log('per extension (files / with date / with camera):',JSON.stringify(Object.fromEntries(perExt)));
    console.log(`with date ${datesOk}/${sample.length}, with camera ${cameras}/${sample.length}, with exposure ${exposures}, with shutter count ${shutters}`);
    if(noCamera.length)console.log('files without a camera:',noCamera.slice(0,10).join('; '));
    check('every capture date parses (plausible year, valid offset)',badDate.length===0,badDate.slice(0,5));
    check('every RAW file has a capture date',noDateRaw.length===0,noDateRaw.slice(0,5));
    check('every file with a Make has a camera',makeNoCamera.length===0,makeNoCamera.slice(0,5));
    check('every RAW file has a camera',sample.filter(f=>f.kind==='RAW').every(f=>!noCamera.includes(f.relative)),noCamera.filter(r=>sample.some(f=>f.relative===r&&f.kind==='RAW')).slice(0,5));
    check('routing (summary) reading equals the full reading for date and camera',!diffs.date&&!diffs.camera,unequal.filter(u=>/: (date|camera) /.test(u)).slice(0,5));
    console.log(`summary vs full on ${sample.length} files: identical in every compared field ${sample.length-new Set(unequal.map(u=>u.split(': ')[0])).size}; differing fields ${JSON.stringify(diffs)}`);
    for(const line of unequal.slice(0,15))console.log('  diff '+line);
   });

   // ---------------------------------------------------------------------------------------------- thumbnails
   await scenario(`${label} Thumbnails: system decode, embedded previews`,async()=>{
    if(!sample.length){skip('thumbnails','no media files');return;}
    const decoders=systemDecoders(embeddedPreview);
    const perKind=new Map<string,{n:number;ok:number;viaSystem:number;viaEmbedded:number;ms:number}>();
    const failed:string[]=[],notJpeg:string[]=[],noEmbedded:string[]=[];let rawEmbedded=0,raws=0;
    for(const f of sample){
     const t0=performance.now();
     let result;try{result=await thumbnail(f.path,{cache:thumbCache,decoders,size:600});}catch(error){result={via:'none' as const,problem:'unreadable' as const,src:undefined,error:String(error)};}
     const took=performance.now()-t0,ext=path.extname(f.path).toLowerCase().slice(1),stat=perKind.get(ext)??{n:0,ok:0,viaSystem:0,viaEmbedded:0,ms:0};
     stat.n++;stat.ms+=took;
     const src=(result as {src?:string}).src;
     if(src){
      const bytes=Buffer.from(src.replace(/^data:image\/jpeg;base64,/,''),'base64');
      if(bytes.length>0&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes.at(-1)===0xd9){stat.ok++;if(result.via==='system')stat.viaSystem++;else stat.viaEmbedded++;}else notJpeg.push(f.relative);
     }else failed.push(`${f.relative} (${result.via}/${(result as {problem?:string}).problem})`);
     if(f.kind==='RAW'){raws++;const embedded=await embeddedPreview(f.path);if(embedded&&embedded[0]===0xff&&embedded[1]===0xd8&&embedded.length>0)rawEmbedded++;else noEmbedded.push(f.relative);}
     perKind.set(ext,stat);
    }
    for(const [ext,s] of perKind)console.log(`  ${ext.padEnd(5)} ${s.ok}/${s.n} jpeg (system ${s.viaSystem}, embedded ${s.viaEmbedded}), ${ms(s.ms/s.n)} each`);
    if(raws)console.log(`RAW embedded previews (extractBinaryTagToBuffer): ${rawEmbedded}/${raws}`);
    check('every sampled file gets a thumbnail',failed.length===0,failed.slice(0,8));
    check('every thumbnail is a non-empty JPEG (SOI and EOI markers)',notJpeg.length===0,notJpeg.slice(0,5));
    if(raws)check('every RAW file yields an embedded preview JPEG',noEmbedded.length===0,noEmbedded.slice(0,5));
    const cached=(await fs.readdir(thumbCache).catch(()=>[])).length;
    check('thumbnails were cached in the temp app-data folder',cached>0,thumbCache);
    // Second call is a cache hit and byte-identical.
    const again=await thumbnail(sample[0]!.path,{cache:thumbCache,decoders,size:600}),first=await thumbnail(sample[0]!.path,{cache:thumbCache,decoders,size:600});
    check('a second request is served from the cache with identical bytes',!!again.src&&again.src===first.src);
   });

   // ---------------------------------------------------------------------------------------------- import
   await scenario(`${label} Import into the sandbox library with real metadata`,async()=>{
    if(!subset.length){skip('import','nothing to import');return;}
    const root=path.join(libraryBox,`real-import-${index+1}`);await ctx.gMkdir(root);
    const keep=new Set(subset.map(f=>f.path));
    let exclude:string[]=[];
    let planned!:Awaited<ReturnType<typeof core.plan>>;
    // The app skips a whole family when any member is excluded. If the stem grouping split one (a pairing it did not foresee),
    // the missing member's excluded partners are added to the subset and the plan is made again, so the subset only holds whole families.
    for(let attempt=0;;attempt++){
     exclude=files.filter(f=>f.included&&!keep.has(f.path)).map(f=>f.path);
     planned=await core.plan(folder,[root],{...importOptions,exclude},p=>metadata(p,{details:false}));
     const planSources=new Set(planned.plans[0]?.entries.map(e=>e.source));
     const split=subset.filter(f=>!planSources.has(f.path));
     if(!split.length||attempt>=5)break;
     const stems=new Set(split.map(f=>path.dirname(f.path)+'\0'+path.basename(f.path).split('.')[0]!.toLowerCase()));
     const added=files.filter(f=>f.included&&!keep.has(f.path)&&stems.has(path.dirname(f.path)+'\0'+path.basename(f.path).split('.')[0]!.toLowerCase()));
     console.log(`subset split a family (${split.length} file(s) not planned); adding ${added.length} partner file(s) and planning again`);
     if(!added.length)break;
     await witnessFiles(added.map(f=>f.path));
     for(const f of added){keep.add(f.path);subset.push(f);}
    }
    const skipped=new Set(exclude);
    const failures=planned.failures.filter(f=>!skipped.has(f.path));
    check('plan has no failures (besides the files left out on purpose)',failures.length===0,failures.slice(0,5).map(f=>f.path+': '+String(f.error)));
    const transfer=planned.plans[0]!;
    const entries=transfer.entries;
    check('the plan holds exactly the subset',entries.length===subset.length&&entries.every(e=>keep.has(e.source)),{entries:entries.length,subset:subset.length});
    for(const e of entries)await ctx.guard(e.destination);       // throws unless inside the sandbox
    check('every destination is inside the sandbox library',entries.every(e=>inside(root,e.destination)));
    const result=await core.execute(transfer,undefined,undefined,{direct:true,removeAppleDouble:false});
    check('execute reports no errors',result.errors.length===0,result.errors.slice(0,5));
    check('every planned file was copied or already present',result.copied===entries.filter(e=>!e.skip).length,{copied:result.copied,planned:entries.length});
    const bad:string[]=[];
    for(const e of entries){
     if(!await exists(e.destination)){bad.push('missing '+e.destination);continue;}
     if(await fileSha(e.destination)!==await fileSha(e.source))bad.push('hash '+e.destination);
    }
    check('every destination exists with the source SHA-256',bad.length===0,bad.slice(0,5));
    // Routing by real metadata.
    const by=new Map(entries.map(e=>[e.source,e]));
    let checked=0,undated=0,cameraless=0,conflicts=0,edited=0;const wrong:string[]=[];
    for(const f of subset){
     const e=by.get(f.path);if(!e||f.companionOf)continue;
     const meta=await summaryOf(f.path),rel=path.relative(root,e.destination).split(path.sep);
     if(rel.includes('Conflicts')){conflicts++;continue;}
     if(!meta.date){undated++;continue;}
     if(!meta.camera){cameraless++;continue;}
     checked++;
     const year=meta.date.slice(0,4),yyyymm=year+meta.date.slice(5,7);
     // Files with editor provenance (Lightroom, Photoshop, ...) go to <year>/<yyyymm>/<edited folder>/<camera> (default "editied").
     const tail=meta.edited?rel.slice(3):rel.slice(2);
     if(meta.edited)edited++;
     if(rel[0]!==year||rel[1]!==yyyymm||(meta.edited&&rel[2]!=='editied')||norm(tail[0]??'')!==norm(meta.camera))wrong.push(`${f.relative} -> ${rel.join('/')} (date ${meta.date}, camera ${meta.camera})`);
    }
    console.log(`routing checked on ${checked} files; ${undated} without a date, ${cameraless} without a camera, ${conflicts} in Conflicts (not checked); ${edited} edited (expected under the edited folder)`);
    check('files are filed by real capture year, month and camera',wrong.length===0,wrong.slice(0,5));
    // Companions together with their original.
    const apart:string[]=[];let companions=0;
    for(const f of subset){
     if(!f.companionOf)continue;
     const mine=by.get(f.path),theirs=by.get(f.companionOf);
     if(!mine||!theirs)continue;
     companions++;
     if(path.dirname(mine.destination)!==path.dirname(theirs.destination))apart.push(`${f.relative} -> ${path.relative(root,mine.destination)} vs ${path.relative(root,theirs.destination)}`);
    }
    console.log(`companions checked: ${companions}`);
    check('companions are filed in their original\'s folder',apart.length===0,apart.slice(0,5));
    // Re-plan is a no-op.
    const again=await core.plan(folder,[root],{...importOptions,exclude},p=>metadata(p,{details:false}));
    check('planning the same subset again finds everything present',again.plans[0]!.entries.every(e=>e.skip),again.plans[0]!.entries.filter(e=>!e.skip).length);
   });

   // ---------------------------------------------------------------------------------------------- unchanged
   await scenario(`${label} Real folder unchanged`,async()=>{
    const after=await listing(folder);
    const changed=diffListing(before,after);
    check('no entry of the real folder changed (names, sizes, mtimes, inodes)',changed.length===0,changed.slice(0,5));
    check('no file or folder was added to the real folder',after.size===before.size,{before:before.size,after:after.size});
   });
  }
  console.log(`\n== summary vs full reading, all folders: ${JSON.stringify(compareTotals)}`);
  console.log('(open question docs/architecture-and-features.md 12.4: `summary` may replace `exif` only if date and camera never differ; other fields listed above)');
 }finally{
  await closeMetadata().catch(()=>{});
 }
}
