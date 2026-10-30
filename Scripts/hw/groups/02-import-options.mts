/**
 * Import options on real exFAT: media layouts and folder-template tokens, companions and pairing, edited exports,
 * unknown-format rules, files without metadata, problem files, conflict naming, verify on/off, direct vs staged
 * copy, skip-errors and retry, and file timestamps. Every destination is hashed against its source (SHA-256) and the
 * sources are checked afterwards (hash, size, mtime). Metadata is synthetic (a table keyed by file name).
 */
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import type {Context,Metadata} from '../harness.mts';
import {destinationParts} from '../../../desktop/core/allocation.ts';
import {executeDestinations} from '../../../desktop/core/destinations.ts';
import {captureTimestamp} from '../../../desktop/capture-time.ts';

export const title='Import options: layouts, templates, companions, edited, unknown, no-metadata, problems, conflicts, verify, direct/staged, skip/retry, timestamps';

// The native helper sets the Created date; the app finds it under build/native, here we also accept an explicit path.
const here=path.dirname(fileURLToPath(import.meta.url));
const bridge=path.resolve(here,'../../../build/native/NativeCameraBridge');
if(!process.env.IMPORTER_NATIVE_BRIDGE&&existsSync(bridge))process.env.IMPORTER_NATIVE_BRIDGE=bridge;

const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
const D1='2023-07-15T10:20:30',D2='2022-12-31T23:59:59',D3='2024-02-29T08:05:00';
const NIKON='Nikon Z f',SONY='Sony A7 IV',CANON='Canon EOS R5';
const J=(...parts:string[])=>parts.filter(Boolean).join('/');
/** Folder for a capture string, written independently of the app's template code. */
const ymd=(date:string)=>({y:date.slice(0,4),m:date.slice(5,7),d:date.slice(8,10)});
const dir3=(date:string,camera:string)=>{const {y,m}=ymd(date);return `${y}/${y}${m}/${camera}`;};
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const conflictId=(pairs:[string,string][])=>createHash('sha256').update(JSON.stringify([...pairs].sort((a,b)=>compare(a[0],b[0])||compare(a[1],b[1])))).digest('hex').slice(0,16);

type Info=Partial<Metadata>;
function makeMeta(){
 const table=new Map<string,Info|Error>();
 let hook:((file:string)=>Promise<void>)|undefined;
 return {
  set(names:string|string[],info:Info|Error){for(const name of [names].flat())table.set(name.toLowerCase(),info);},
  onRead(next:((file:string)=>Promise<void>)|undefined){hook=next;},
  fn:async(file:string):Promise<Metadata>=>{
   if(hook)await hook(file);
   const found=table.get(path.basename(file).toLowerCase());
   if(found instanceof Error)throw found;
   return {fields:{},...(found??{})};
  },
 };
}
type Meta=ReturnType<typeof makeMeta>;

export default async function run(ctx:Context):Promise<void>{
 const {core,paths,sourceBox,libraryBox,check,scenario,skip,gMkdir,gWrite,gRm,gUtimes,sha,fileSha,exists,treeOf,files:FILES}=ctx;
 const TEMPLATE='{year}/{yyyymm}/{camera}';
 type PlanReq=Parameters<typeof core.plan>[2];
 type Planned=Awaited<ReturnType<typeof core.plan>>;
 type Src={dir:string;files:Map<string,string>};

 // ---- building blocks ---------------------------------------------------------------------------------------
 let counter=0;
 const newSrc=async(name:string):Promise<Src>=>{const dir=path.join(sourceBox,`src-${name}`);await gMkdir(dir);return {dir,files:new Map()};};
 const newLib=async(name:string)=>{const dir=path.join(libraryBox,`lib-${name}`);await gMkdir(dir);return dir;};
 /** Writes a source file (random bytes of `size`, or the given bytes) and records its hash. */
 const put=async(src:Src,rel:string,data:number|Buffer)=>{const bytes=Buffer.isBuffer(data)?data:randomBytes(data);await gWrite(path.join(src.dir,rel),bytes);const hash=sha(bytes);src.files.set(rel,hash);return hash;};
 const stamp=async(src:Src,rel:string,when:string)=>gUtimes(path.join(src.dir,rel),new Date(when));
 const snap=async(dir:string)=>{const out=new Map<string,string>();for(const [rel,hash] of await treeOf(dir)){const st=await fs.stat(path.join(dir,rel));out.set(rel,`${hash}:${st.size}:${st.mtimeMs}`);}return out;};
 const sourceSame=async(label:string,dir:string,before:Map<string,string>)=>{
  const after=await snap(dir),bad=[...new Set([...before.keys(),...after.keys()])].filter(k=>before.get(k)!==after.get(k));
  check(`${label}: source files unchanged (SHA-256, size, mtime)`,bad.length===0,bad.slice(0,5));
 };
 const treeIs=async(label:string,dir:string,expected:Map<string,string>,ignore?:(rel:string)=>boolean)=>{
  const actual=new Map([...await treeOf(dir)].filter(([rel])=>!ignore?.(rel))),bad:string[]=[];
  for(const [rel,hash] of expected){const got=actual.get(rel);if(got===undefined)bad.push('missing '+rel);else if(got!==hash)bad.push('hash differs '+rel);}
  for(const rel of actual.keys())if(!expected.has(rel))bad.push('unexpected '+rel);
  check(`${label}: destination holds exactly the expected files with source SHA-256`,bad.length===0,bad.slice(0,8));
  return bad.length===0;
 };
 /** expected map from "relative destination -> source relative name" using the source's recorded hashes. */
 const expectOf=(src:Src,map:Record<string,string>)=>{const out=new Map<string,string>();for(const [dest,name] of Object.entries(map)){const hash=src.files.get(name);if(hash===undefined)throw new Error('test bug: no source '+name);out.set(dest,hash);}return out;};
 const request=(extra:Record<string,unknown>={}):PlanReq=>({backup:false,template:TEMPLATE,layout:'flat',unknownRules:{},...extra}) as unknown as PlanReq;
 type ExecOptions={verify?:boolean;direct?:boolean};
 type Seen={direct:boolean;phases:Set<string>;outcomes:import('../../../desktop/core/index.ts').FileOutcome[]};
 const execPlans=async(plans:Planned['plans'],options:ExecOptions={}):Promise<{errors:string[];copied:number;skipped:number;seen:Seen}> => {
  const seen:Seen={direct:false,phases:new Set(),outcomes:[]};
  const results=await core.executeMany(plans.flatMap(destinationParts),undefined,(_i,p)=>{if(p.phase)seen.phases.add(p.phase);if(p.work?.direct)seen.direct=true;},{verify:options.verify,direct:options.direct,removeAppleDouble:false,onFileOutcome:o=>seen.outcomes.push(o)});
  return {errors:results.flatMap(r=>r instanceof Error?[r.message]:r.errors),copied:results.reduce((n,r)=>n+(r instanceof Error?0:r.copied),0),skipped:results.reduce((n,r)=>n+(r instanceof Error?0:r.skipped),0),seen};
 };
 const importTo=async(src:Src,roots:string[],extra:Record<string,unknown>,meta:Meta|((file:string)=>Promise<Metadata>),options:ExecOptions={})=>{
  const planned=await core.plan(src.dir,roots,request(extra),typeof meta==='function'?meta:meta.fn);
  const done=await execPlans(planned.plans,options);
  return {planned,...done};
 };
 const entriesOf=(planned:Planned)=>planned.plans.flatMap(destinationParts).flatMap(p=>p.entries);
 const rejects=async(work:()=>Promise<unknown>)=>{try{await work();return undefined;}catch(error){return error as Error;}};
 const LOCAL=(s:string)=>Date.parse(s);       // a date-time without an offset is the camera's wall clock = this Mac's local time
 const cleanRun=(label:string,r:{errors:string[]},planned?:Planned)=>check(`${label}: no plan failures and no copy errors`,r.errors.length===0&&(planned?.failures.length??0)===0,{errors:r.errors,failures:planned?.failures.map(f=>f.path+': '+f.error.message)});

 // ===============================================================================================================
 await scenario('1. All six media layouts (flat, format, type-format, photos-flat, videos-flat, video-root)',async()=>{
  const src=await newSrc('layouts'),M=makeMeta();
  const N=dir3(D1,NIKON),C=dir3(D2,CANON),S=dir3(D3,SONY);
  await put(src,'DSC_1001.NEF',300_001);await put(src,'DSC_1001.JPG',90_002);await put(src,'DSC_1001.xmp',2_000);
  await put(src,'CLIP_1002.MOV',200_003);await put(src,'IMG_1003.HEIC',80_004);await put(src,'MVI_1004.MP4',150_005);await put(src,'IMG_1005.TIF',60_006);
  M.set(['DSC_1001.NEF','DSC_1001.JPG'],{camera:NIKON,date:D1});M.set('CLIP_1002.MOV',{camera:SONY,date:D3});
  M.set(['IMG_1003.HEIC','MVI_1004.MP4','IMG_1005.TIF'],{camera:CANON,date:D2});
  // name, camera folder, is video, format folder (the xmp is filed as its original, the NEF)
  const items:[string,string,boolean,string][]=[['DSC_1001.NEF',N,false,'NEF'],['DSC_1001.JPG',N,false,'JPEG'],['DSC_1001.xmp',N,false,'NEF'],['CLIP_1002.MOV',S,true,'MOV'],['IMG_1003.HEIC',C,false,'HEIF'],['MVI_1004.MP4',C,true,'MP4'],['IMG_1005.TIF',C,false,'TIFF']];
  const sub=(layout:string,video:boolean,format:string)=>layout==='format'?format:layout==='type-format'?J(video?'Videos':'Photos',format):layout==='photos-flat'?(video?'Videos':''):layout==='videos-flat'?(video?'':'Photos'):'';
  for(const layout of ['flat','format','type-format','photos-flat','videos-flat']){
   const lib=await newLib('layout-'+layout),before=await snap(src.dir);
   const expected:Record<string,string>={};
   for(const [name,camera,video,format] of items)expected[J(camera,sub(layout,video,format),name)]=name;
   const r=await importTo(src,[lib],{layout},M);
   cleanRun(layout,r,r.planned);
   await treeIs(`layout ${layout}`,lib,expectOf(src,expected));
   await sourceSame(`layout ${layout}`,src.dir,before);
  }
  // video-root: videos under their own root with their own template; photos under the photo root.
  const lib=await newLib('layout-video-root'),videoLib=await newLib('layout-video-root-videos'),before=await snap(src.dir);
  const planned=await core.plan(src.dir,[lib],request({layout:'video-root',videoTemplate:'{camera}/{yyyyMMdd}',videoRoots:[videoLib]}),M.fn);
  check('video-root plan has a separate video plan',!!planned.plans[0]?.videos&&planned.plans[0].videos.root!==planned.plans[0].root,planned.plans[0]?.videos?.root);
  const result=await executeDestinations(planned.plans,{signal:new AbortController().signal,reorganize:false,verify:true,removeAppleDouble:false,validate:async()=>{},progress:()=>{},settled:()=>{}});
  check('video-root: executeDestinations reports no errors',result.errors.length===0&&planned.failures.length===0,{errors:result.errors});
  await treeIs('video-root photos root',lib,expectOf(src,{[J(N,'DSC_1001.NEF')]:'DSC_1001.NEF',[J(N,'DSC_1001.JPG')]:'DSC_1001.JPG',[J(N,'DSC_1001.xmp')]:'DSC_1001.xmp',[J(C,'IMG_1003.HEIC')]:'IMG_1003.HEIC',[J(C,'IMG_1005.TIF')]:'IMG_1005.TIF'}));
  await treeIs('video-root video root (video template {camera}/{yyyyMMdd})',videoLib,expectOf(src,{'Sony A7 IV/20240229/CLIP_1002.MOV':'CLIP_1002.MOV','Canon EOS R5/20221231/MVI_1004.MP4':'MVI_1004.MP4'}));
  await sourceSame('video-root',src.dir,before);
  // video-root with an empty video template falls back to the photo template.
  const lib2=await newLib('layout-video-root-b'),videoLib2=await newLib('layout-video-root-b-videos');
  const r2=await importTo(src,[lib2],{layout:'video-root',videoTemplate:'',videoRoots:[videoLib2]},M);
  cleanRun('video-root with an empty video template',r2,r2.planned);
  await treeIs('video-root (empty video template) video root',videoLib2,expectOf(src,{[J(S,'CLIP_1002.MOV')]:'CLIP_1002.MOV',[J(C,'MVI_1004.MP4')]:'MVI_1004.MP4'}));
  // Refused configurations.
  const noRoot=await rejects(()=>core.plan(src.dir,[lib2],request({layout:'video-root'}),M.fn));
  check('video-root without a video folder is refused',!!noRoot,String(noRoot));
  const nested=await rejects(()=>core.plan(src.dir,[lib2],request({layout:'video-root',videoRoots:[path.join(lib2,'inside')]}),M.fn));
  check('a video folder nested in the photo folder is refused',!!nested,String(nested));
 });

 // ===============================================================================================================
 await scenario('2. Folder template tokens and the paths they produce',async()=>{
  const src=await newSrc('templates'),M=makeMeta();
  const shots:[string,string,string][]=[['T_A.JPG',D1,NIKON],['T_B.JPG','2022-01-03T01:02:03','FUJIFILM X-T5/Pro'],['T_C.JPG','2024-12-31T23:59:59',CANON]];
  for(const [name,date,camera] of shots){await put(src,name,40_000+name.charCodeAt(2));M.set(name,{camera,date});}
  const safe=(camera:string)=>camera.replace('/','-');           // the camera name is made one folder name
  const cases:[string,(date:string,camera:string)=>string][]=[
   ['{year}/{month}/{day}/{camera}',(d,c)=>{const t=ymd(d);return J(t.y,t.m,t.d,safe(c));}],
   ['{camera}/{year}/{monthName}',(d,c)=>{const t=ymd(d);return J(safe(c),t.y,`${t.m} ${MONTHS[+t.m-1]}`);}],
   ['{yearMonthName}/{yyyyMMdd}/{camera}',(d,c)=>{const t=ymd(d);return J(`${t.y}-${t.m} ${MONTHS[+t.m-1]}`,t.y+t.m+t.d,safe(c));}],
   ['{year}-{month}-{day}/{camera}',(d,c)=>{const t=ymd(d);return J(`${t.y}-${t.m}-${t.d}`,safe(c));}],
   ['{yyyymm}',d=>{const t=ymd(d);return t.y+t.m;}],
  ];
  for(const [index,[template,folder]] of cases.entries()){
   const lib=await newLib('template-'+index),before=await snap(src.dir);
   const expected:Record<string,string>={};
   for(const [name,date,camera] of shots)expected[J(folder(date,camera),name)]=name;
   const r=await importTo(src,[lib],{template},M);
   cleanRun(template,r,r.planned);
   await treeIs(`template ${template}`,lib,expectOf(src,expected));
   await sourceSame(`template ${template}`,src.dir,before);
  }
  const lib=await newLib('template-bad');
  for(const bad of ['{year}/{bogus}','../{camera}','{camera}//{year}','{year}/CON']){
   const error=await rejects(()=>core.plan(src.dir,[lib],request({template:bad}),M.fn));
   check(`invalid template ${bad} is refused at planning`,!!error,'accepted');
  }
  check('refused templates wrote nothing',(await treeOf(lib)).size===0);
 });

 // ===============================================================================================================
 await scenario('3. Companions and pairing: RAW+JPG, XMP/AAE/DOP, Live Photo, DJI LRF, Sony XML/BIM, GoPro LRV/THM/chapters',async()=>{
  const src=await newSrc('companions'),M=makeMeta();
  const files:[string,number][]=[
   ['R_2001.NEF',250_001],['R_2001.JPG',70_002],['R_2001.xmp',1_100],['R_2001.NEF.xmp',1_200],['R_2001.NEF.dop',1_300],
   ['IMG_2001.HEIC',90_003],['IMG_2001.MOV',110_004],['IMG_2001.AAE',900],['IMG_O2001.AAE',950],
   ['IMG_2002.HEIC',90_005],['IMG_2002.MOV',100_006],
   ['DJI_0001.MP4',140_007],['DJI_0001.LRF',20_008],['DJI_0001.SRT',1_500],
   ['C0001.MP4',130_009],['C0001M01.XML',1_600],['C0001R01.BIM',1_700],
   ['GX010005.MP4',120_010],['GL010005.LRV',30_011],['GL010005.THM',4_012],
   ['GX010006.MP4',120_013],['GX020006.MP4',120_014],['GL010006.LRV',30_015],['GL020006.LRV',30_016],
  ];
  for(const [name,size] of files)await put(src,name,size);
  M.set(['R_2001.NEF','R_2001.JPG'],{camera:NIKON,date:D1});
  M.set('IMG_2001.HEIC',{camera:'iPhone 15 Pro',make:'Apple',contentId:'LIVE-0001',date:'2023-03-10T23:59:59'});
  M.set('IMG_2001.MOV',{camera:'iPhone 15 Pro',make:'Apple',contentId:'LIVE-0001',date:'2023-03-11T00:00:02'});
  M.set('IMG_2002.HEIC',{camera:'iPhone 15 Pro',make:'Apple',contentId:'LIVE-A',date:'2023-04-02T12:00:00'});
  M.set('IMG_2002.MOV',{camera:'iPhone 15 Pro',make:'Apple',contentId:'LIVE-B',date:'2023-05-01T12:00:00'});
  M.set(['DJI_0001.MP4','DJI_0001.LRF'],{camera:'DJI Mavic 3',date:'2023-06-01T09:00:00'});
  M.set('C0001.MP4',{camera:SONY,date:'2024-01-20T10:00:00'});
  M.set(['GX010005.MP4','GL010005.LRV'],{camera:'GoPro HERO11',date:'2023-05-31T23:59:50'});
  M.set(['GX010006.MP4','GL010006.LRV'],{camera:'GoPro HERO11',date:'2023-05-31T23:59:58'});
  M.set(['GX020006.MP4','GL020006.LRV'],{camera:'GoPro HERO11',date:'2023-06-01T00:00:12'});
  const groups:Record<string,string[]>={
   still:['R_2001.NEF','R_2001.JPG','R_2001.xmp','R_2001.NEF.xmp','R_2001.NEF.dop'],
   live:['IMG_2001.HEIC','IMG_2001.MOV','IMG_2001.AAE','IMG_O2001.AAE'],
   dji:['DJI_0001.MP4','DJI_0001.LRF','DJI_0001.SRT'],
   sony:['C0001.MP4','C0001M01.XML','C0001R01.BIM'],
   gopro:['GX010005.MP4','GL010005.LRV','GL010005.THM'],
   chapters:['GX010006.MP4','GX020006.MP4','GL010006.LRV','GL020006.LRV'],
  };
  const dirOf:Record<string,string>={still:dir3(D1,NIKON),live:dir3('2023-03-10','iPhone 15 Pro'),dji:dir3('2023-06-01','DJI Mavic 3'),sony:dir3('2024-01-20',SONY),gopro:dir3('2023-05-31','GoPro HERO11'),chapters:dir3('2023-05-31','GoPro HERO11')};
  const before=await snap(src.dir);

  // -- flat layout: every family in one folder, split only where nothing pairs.
  const lib=await newLib('companions-flat');
  const r=await importTo(src,[lib],{},M);
  cleanRun('companions (flat)',r,r.planned);
  const expected:Record<string,string>={[J(dir3('2023-04-02','iPhone 15 Pro'),'IMG_2002.HEIC')]:'IMG_2002.HEIC',[J(dir3('2023-05-01','iPhone 15 Pro'),'IMG_2002.MOV')]:'IMG_2002.MOV'};
  for(const [group,names] of Object.entries(groups))for(const name of names)expected[J(dirOf[group]!,name)]=name;
  await treeIs('companions (flat)',lib,expectOf(src,expected));
  await sourceSame('companions (flat)',src.dir,before);
  // The pairing itself, as the inventory resolved it.
  const rel=(p?:string)=>p?path.relative(src.dir,p):undefined;
  const pairs:Record<string,string|undefined>={'R_2001.xmp':'R_2001.NEF','R_2001.NEF.xmp':'R_2001.NEF','R_2001.NEF.dop':'R_2001.NEF','IMG_2001.AAE':'IMG_2001.HEIC','IMG_O2001.AAE':'IMG_2001.HEIC','IMG_2001.MOV':'IMG_2001.HEIC','IMG_2002.MOV':undefined,'DJI_0001.LRF':'DJI_0001.MP4','DJI_0001.SRT':'DJI_0001.MP4','C0001M01.XML':'C0001.MP4','C0001R01.BIM':'C0001.MP4','GL010005.LRV':'GX010005.MP4','GL010005.THM':'GL010005.LRV','GL010006.LRV':'GX010006.MP4','GL020006.LRV':'GX020006.MP4'};
  const byName=new Map(r.planned.inventory.files.map(f=>[path.basename(f.path),f]));
  const wrong=Object.entries(pairs).filter(([name,primary])=>rel(byName.get(name)?.companionOf)!==primary).map(([name,primary])=>`${name} -> ${rel(byName.get(name)?.companionOf)} (want ${primary})`);
  check('every companion is paired with its original (inventory.companionOf)',wrong.length===0,wrong);
  // One plan family per group.
  const famOf=new Map(entriesOf(r.planned).map(e=>[path.basename(e.source),e.family]));
  const split=Object.entries(groups).filter(([,names])=>new Set(names.map(n=>famOf.get(n))).size!==1).map(([g,names])=>`${g}: ${names.map(n=>famOf.get(n)).join(' | ')}`);
  check('each family is one plan family (never split)',split.length===0,split);
  check('the Live Photo MOV is not a separate video: its two dates (23:59:59 and 00:00:02) kept it with the still',!!await exists(path.join(lib,dirOf.live!,'IMG_2001.MOV')));
  check('GoPro chapters across midnight stay in the first chapter\'s month',!!await exists(path.join(lib,dirOf.chapters!,'GX020006.MP4')));

  // -- format layout: companions follow their original's format folder.
  const libFormat=await newLib('companions-format'),rf=await importTo(src,[libFormat],{layout:'format'},M);
  cleanRun('companions (format)',rf,rf.planned);
  const fmt:Record<string,string>={'R_2001.NEF':'NEF','R_2001.JPG':'JPEG','R_2001.xmp':'NEF','R_2001.NEF.xmp':'NEF','R_2001.NEF.dop':'NEF','IMG_2001.HEIC':'HEIF','IMG_2001.MOV':'HEIF','IMG_2001.AAE':'HEIF','IMG_O2001.AAE':'HEIF','IMG_2002.HEIC':'HEIF','IMG_2002.MOV':'MOV','DJI_0001.MP4':'MP4','DJI_0001.LRF':'MP4','DJI_0001.SRT':'MP4','C0001.MP4':'MP4','C0001M01.XML':'MP4','C0001R01.BIM':'MP4','GX010005.MP4':'MP4','GL010005.LRV':'MP4','GX010006.MP4':'MP4','GX020006.MP4':'MP4','GL010006.LRV':'MP4','GL020006.LRV':'MP4'};
  const placed=await treeOf(libFormat),bad:string[]=[];
  for(const [rp,hash] of placed){const name=path.basename(rp),want=fmt[name],folder=path.basename(path.dirname(rp));if(want!==folder)bad.push(`${name} in ${folder} (want ${want})`);if(src.files.get(name)!==hash)bad.push('hash '+name);}
  const thm=[...placed.keys()].find(k=>k.endsWith('GL010005.THM'));
  check('format layout: every file in its original\'s format folder, all hashes equal',bad.filter(b=>!b.startsWith('GL010005.THM')).length===0&&placed.size===files.length,bad);
  check('format layout: GoPro .THM is filed with its LRV, which is filed with the MP4 (family not split across format folders)',!!thm&&path.basename(path.dirname(thm))===path.basename(path.dirname([...placed.keys()].find(k=>k.endsWith('GL010005.LRV'))!)),thm);

  // -- video-root: videos and their companions go to the video root; a Live Photo's MOV stays with its still.
  const libV=await newLib('companions-vroot'),libVV=await newLib('companions-vroot-videos');
  const rv=await importTo(src,[libV],{layout:'video-root',videoTemplate:'{camera}/{yyyyMMdd}',videoRoots:[libVV]},M);
  cleanRun('companions (video-root)',rv,rv.planned);
  const photos:Record<string,string>={},videos:Record<string,string>={};
  for(const g of ['still','live'])for(const name of groups[g]!)photos[J(dirOf[g]!,name)]=name;
  photos[J(dir3('2023-04-02','iPhone 15 Pro'),'IMG_2002.HEIC')]='IMG_2002.HEIC';
  const vdir:Record<string,string>={dji:'DJI Mavic 3/20230601',sony:`${SONY}/20240120`,gopro:'GoPro HERO11/20230531',chapters:'GoPro HERO11/20230531'};
  for(const g of ['dji','sony','gopro','chapters'])for(const name of groups[g]!)videos[J(vdir[g]!,name)]=name;
  videos['iPhone 15 Pro/20230501/IMG_2002.MOV']='IMG_2002.MOV';
  await treeIs('video-root photo root (stills, Live Photo family)',libV,expectOf(src,photos));
  await treeIs('video-root video root (video originals with their companions)',libVV,expectOf(src,videos));
  await sourceSame('companions (all layouts)',src.dir,before);
 });

 // ===============================================================================================================
 await scenario('4. Edited exports: edited folder on import, organization by the edited-folder rule',async()=>{
  const src=await newSrc('edited'),M=makeMeta();
  const cam=dir3(D1,NIKON),edit=(folder:string)=>`2023/202307/${folder}/${NIKON}`;
  await put(src,'E_0001.JPG',50_001);await put(src,'E_0001.xmp',900);await put(src,'E_0002.NEF',120_002);await put(src,'E_0003.JPG',50_003);await put(src,'E_0003.NEF',110_004);await put(src,'editied/F_0004.JPG',50_005);
  M.set(['E_0001.JPG','E_0003.JPG'],{camera:NIKON,date:D1,edited:true});
  M.set('E_0002.NEF',{camera:NIKON,date:D1,edited:true});    // a RAW is never an edited export
  M.set('E_0003.NEF',{camera:NIKON,date:D1});
  M.set('F_0004.JPG',{camera:NIKON,date:D1});                 // sits in a folder named like the edited folder: an import does not classify by source folders
  const before=await snap(src.dir);
  const want=(folder:string,format?:boolean)=>({
   [J(edit(folder),'E_0001.JPG')]:'E_0001.JPG',[J(edit(folder),'E_0001.xmp')]:'E_0001.xmp',[J(edit(folder),'E_0003.JPG')]:'E_0003.JPG',
   [J(cam,format?'NEF':'','E_0002.NEF')]:'E_0002.NEF',[J(cam,format?'NEF':'','E_0003.NEF')]:'E_0003.NEF',[J(cam,format?'JPEG':'','F_0004.JPG')]:'editied/F_0004.JPG',
  });
  for(const [name,extra,folder,format] of [['default',{},'editied',false],['format layout',{layout:'format'},'editied',true],['custom folder',{editedFolder:'Bearbeitet'},'Bearbeitet',false]] as [string,Record<string,unknown>,string,boolean][]){
   const lib=await newLib('edited-'+name.replace(/\W/g,'')),r=await importTo(src,[lib],extra,M);
   cleanRun('edited import ('+name+')',r,r.planned);
   await treeIs(`edited import (${name}): edited JPG+xmp in ${folder}/<camera>, RAW and source-folder files normal`,lib,expectOf(src,want(folder,format)));
  }
  const bad=await rejects(async()=>core.plan(src.dir,[await newLib('edited-bad')],request({editedFolder:'a/b'}),M.fn));
  check('an edited folder name with a slash is refused',!!bad,'accepted');
  await sourceSame('edited import',src.dir,before);

  // Organization of a library: the edited-folder rule applies as well as the edited tag.
  const lib=await newLib('edited-org');                                               // seed files are written straight into the library
  const org:Src={dir:lib,files:new Map()};
  await put(org,'Unsorted/a_0010.JPG',40_010);await put(org,'Unsorted/editied/b_0011.JPG',40_011);await put(org,'Unsorted/editied/b_0011.xmp',800);await put(org,'Unsorted/c_0012.JPG',40_012);await put(org,'Unsorted/editied/d_0013.NEF',130_013);
  const OM=makeMeta();
  OM.set(['a_0010.JPG','b_0011.JPG','d_0013.NEF'],{camera:NIKON,date:D1});OM.set('c_0012.JPG',{camera:NIKON,date:D1,edited:true});
  const planned=await core.plan(lib,[lib],request({reorganize:true}),OM.fn);
  check('organization plan has no failures',planned.failures.length===0,planned.failures.map(f=>f.error.message));
  const moved=await core.executeReorganization(planned.plans[0]!);
  check('organization reports no errors',moved.errors.length===0,moved.errors);
  await treeIs('organization: a normal; b and c in editied/<camera>; the RAW inside an edited folder is not edited',lib,expectOf(org,{
   [J(cam,'a_0010.JPG')]:'Unsorted/a_0010.JPG',[J(edit('editied'),'b_0011.JPG')]:'Unsorted/editied/b_0011.JPG',[J(edit('editied'),'b_0011.xmp')]:'Unsorted/editied/b_0011.xmp',
   [J(edit('editied'),'c_0012.JPG')]:'Unsorted/c_0012.JPG',[J(cam,'d_0013.NEF')]:'Unsorted/editied/d_0013.NEF'}));
  const again=await core.plan(lib,[lib],request({reorganize:true}),OM.fn);
  check('a second organization finds everything in place',again.plans[0]!.entries.length===0,again.plans[0]!.entries.map(e=>e.source));
 });

 // ===============================================================================================================
 await scenario('5. Unknown-format rules: skip / other / camera / ask and explicit rules',async()=>{
  const src=await newSrc('unknown'),M=makeMeta();
  const cam=dir3(D1,NIKON);
  await put(src,'CAM_0001.JPG',60_001);await put(src,'notes.txt',3_001);await put(src,'UPPER.TXT',3_002);await put(src,'data.abc',3_003);await put(src,'data2.xyz',3_004);await put(src,'memo.wav',20_005);await put(src,'readme',3_006);
  M.set('CAM_0001.JPG',{camera:NIKON,date:D1});
  const before=await snap(src.dir);
  const skippedReasons=(p:Planned)=>Object.fromEntries((p.inventory.skipped??[]).map(s=>[path.basename(s.path),s.reason]));
  type Case={name:string;extra:Record<string,unknown>;expect:Record<string,string>;skipped:Record<string,string>};
  const base={'CAM_0001.JPG':J(cam,'CAM_0001.JPG'),'memo.wav':J(cam,'memo.wav')};      // unpaired camera audio goes to its camera by default
  const cases:Case[]=[
   {name:'skip (default)',extra:{},expect:{...base},skipped:{'notes.txt':'unknown-skip','UPPER.TXT':'unknown-skip','data.abc':'unknown-skip','data2.xyz':'unknown-skip',readme:'unknown-skip'}},
   {name:'ask',extra:{unknownDefault:'ask'},expect:{...base},skipped:{'notes.txt':'unknown-ask','UPPER.TXT':'unknown-ask','data.abc':'unknown-ask','data2.xyz':'unknown-ask',readme:'unknown-ask'}},
   {name:'other',extra:{unknownDefault:'other'},expect:{...base,'notes.txt':'Other files/txt/notes.txt','UPPER.TXT':'Other files/txt/UPPER.TXT','data.abc':'Other files/abc/data.abc','data2.xyz':'Other files/xyz/data2.xyz',readme:'Other files/readme'},skipped:{}},
   {name:'explicit rules (folder, null, camera) over skip',extra:{unknownRules:{txt:'Documents/Text',xyz:null,abc:{action:'camera'}}},expect:{...base,'notes.txt':'Documents/Text/notes.txt','UPPER.TXT':'Documents/Text/UPPER.TXT','data.abc':J(cam,'data.abc')},skipped:{'data2.xyz':'unknown-rule',readme:'unknown-skip'}},
   {name:'explicit rules over other',extra:{unknownDefault:'other',unknownRules:{xyz:null,wav:null}},expect:{'CAM_0001.JPG':base['CAM_0001.JPG'],'notes.txt':'Other files/txt/notes.txt','UPPER.TXT':'Other files/txt/UPPER.TXT','data.abc':'Other files/abc/data.abc',readme:'Other files/readme'},skipped:{'data2.xyz':'unknown-rule','memo.wav':'unknown-rule'}},
  ];
  for(const [index,c] of cases.entries()){
   const lib=await newLib('unknown-'+index),r=await importTo(src,[lib],c.extra,M);
   cleanRun('unknown '+c.name,r,r.planned);
   await treeIs(`unknown ${c.name}`,lib,expectOf(src,Object.fromEntries(Object.entries(c.expect).map(([name,dest])=>[dest,name]))));
   const got=skippedReasons(r.planned),wrong=Object.entries(c.skipped).filter(([n,reason])=>got[n]!==reason).map(([n,reason])=>`${n}: ${got[n]} (want ${reason})`);
   check(`unknown ${c.name}: skipped files carry their reasons (nothing dropped silently)`,wrong.length===0&&Object.keys(got).every(n=>n in c.skipped),{got,wrong});
  }
  const ask=await core.plan(src.dir,[await newLib('unknown-count')],request({unknownDefault:'ask'}),M.fn);
  check('inventory counts the unknown extensions (what the app asks about)',ask.inventory.unknownExtensions.txt===2&&ask.inventory.unknownExtensions.abc===1&&ask.inventory.unknownExtensions.xyz===1,ask.inventory.unknownExtensions);
  const badRule=await rejects(async()=>core.plan(src.dir,[await newLib('unknown-bad')],request({unknownRules:{txt:'../escape'}}),M.fn));
  check('an unknown-file rule that escapes the library is refused',!!badRule,'accepted');
  await sourceSame('unknown rules',src.dir,before);
 });

 // ===============================================================================================================
 await scenario('6. Files without metadata: keep / folder / fileDate',async()=>{
  const src=await newSrc('nometa'),M=makeMeta();
  await put(src,'OK_0001.JPG',50_001);await put(src,'sub/deeper/ND_0002.JPG',50_002);await put(src,'NC_0003.JPG',50_003);await put(src,'NDT_0004.JPG',50_004);await put(src,'UNR_0005.JPG',50_005);await put(src,'FAM_0006.NEF',90_006);await put(src,'FAM_0006.xmp',700);
  M.set('OK_0001.JPG',{camera:NIKON,date:D1});M.set('NC_0003.JPG',{date:D2});M.set('NDT_0004.JPG',{camera:SONY});
  M.set('UNR_0005.JPG',Object.assign(new Error('metadata cannot be read'),{}));
  const local=(y:number,m:number,d:number)=>`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}T12:00:00`;
  await stamp(src,'sub/deeper/ND_0002.JPG',local(2021,3,5));await stamp(src,'NC_0003.JPG',local(2017,4,6));await stamp(src,'NDT_0004.JPG',local(2020,11,20));await stamp(src,'UNR_0005.JPG',local(2019,8,9));await stamp(src,'FAM_0006.NEF',local(2018,1,15));await stamp(src,'FAM_0006.xmp',local(2018,1,16));await stamp(src,'OK_0001.JPG',local(2016,2,2));
  const before=await snap(src.dir);
  const ok={[J(dir3(D1,NIKON),'OK_0001.JPG')]:'OK_0001.JPG'};
  // keep: unknown files stay where they are; the review says how many and why.
  {
   const lib=await newLib('nometa-keep'),r=await importTo(src,[lib],{noMetadata:'keep'},M);
   cleanRun('no-metadata keep',r,r.planned);
   await treeIs('no-metadata keep: only the file with metadata is imported',lib,expectOf(src,ok));
   const s=r.planned.noMetadata;
   check('keep: summary counts 6 files (noDate 4, noCamera 1, unreadable 1)',s?.handling==='keep'&&s.count===6&&s.counts.noDate===4&&s.counts.noCamera===1&&s.counts.unreadable===1,s&&{count:s.count,counts:s.counts});
   await sourceSame('no-metadata keep',src.dir,before);
  }
  // folder: filed under the unknown-files folder with their subfolders; a family goes together.
  for(const [folderName,label] of [[undefined,'Unknown files'],['Needs review','Needs review']] as [string|undefined,string][]){
   const lib=await newLib('nometa-folder-'+label.replace(/\W/g,'')),r=await importTo(src,[lib],{noMetadata:'folder',...(folderName?{noMetadataFolder:folderName}:{})},M);
   cleanRun('no-metadata folder '+label,r,r.planned);
   await treeIs(`no-metadata folder "${label}"`,lib,expectOf(src,{...ok,[J(label,'sub/deeper/ND_0002.JPG')]:'sub/deeper/ND_0002.JPG',[J(label,'NC_0003.JPG')]:'NC_0003.JPG',[J(label,'NDT_0004.JPG')]:'NDT_0004.JPG',[J(label,'UNR_0005.JPG')]:'UNR_0005.JPG',[J(label,'FAM_0006.NEF')]:'FAM_0006.NEF',[J(label,'FAM_0006.xmp')]:'FAM_0006.xmp'}));
   await sourceSame('no-metadata folder '+label,src.dir,before);
  }
  for(const bad of ['2023','editied','Conflicts','a/b']){
   const error=await rejects(async()=>core.plan(src.dir,[await newLib('nometa-bad')],request({noMetadata:'folder',noMetadataFolder:bad}),M.fn));
   check(`unknown-files folder name "${bad}" is refused`,!!error,'accepted');
  }
  // fileDate: filed by the file's own time (camera and capture date used where each exists).
  {
   const lib=await newLib('nometa-filedate'),r=await importTo(src,[lib],{noMetadata:'fileDate'},M);
   cleanRun('no-metadata fileDate',r,r.planned);
   const U='Unknown files';
   await treeIs('no-metadata fileDate: file time, with the camera or date that is known',lib,expectOf(src,{...ok,
    [`2021/202103/${U}/ND_0002.JPG`]:'sub/deeper/ND_0002.JPG',[`2022/202212/${U}/NC_0003.JPG`]:'NC_0003.JPG',[`2020/202011/${SONY}/NDT_0004.JPG`]:'NDT_0004.JPG',
    [`2019/201908/${U}/UNR_0005.JPG`]:'UNR_0005.JPG',[`2018/201801/${U}/FAM_0006.NEF`]:'FAM_0006.NEF',[`2018/201801/${U}/FAM_0006.xmp`]:'FAM_0006.xmp'}));
   await sourceSame('no-metadata fileDate',src.dir,before);
  }
 });

 // ===============================================================================================================
 await scenario('7. Problem files: empty files on import, collectProblemFiles on/off on organization; unreadable',async()=>{
  const src=await newSrc('problems'),M=makeMeta();
  await put(src,'GOOD_1.JPG',50_001);await put(src,'E_2.JPG',Buffer.alloc(0));await put(src,'P_3.NEF',Buffer.alloc(0));await put(src,'P_3.xmp',600);
  M.set('GOOD_1.JPG',{camera:NIKON,date:D1});M.set(['E_2.JPG','P_3.NEF'],{camera:NIKON,date:D1});
  const before=await snap(src.dir),lib=await newLib('problems-import');
  const r=await importTo(src,[lib],{},M);
  cleanRun('empty files on import',r,r.planned);
  await treeIs('import: empty files and the companion of an empty file are not copied',lib,expectOf(src,{[J(dir3(D1,NIKON),'GOOD_1.JPG')]:'GOOD_1.JPG'}));
  const got=Object.fromEntries(r.planned.problems.map(p=>[p.relative,`${p.reason}/${p.collected}`]));
  check('import lists E_2.JPG and P_3.NEF as empty and P_3.xmp as emptyPrimary, none collected',got['E_2.JPG']==='empty/false'&&got['P_3.NEF']==='empty/false'&&got['P_3.xmp']==='emptyPrimary/false'&&Object.keys(got).length===3,got);
  check('the empty source files are still in the source',(await fs.stat(path.join(src.dir,'E_2.JPG'))).size===0&&(await fs.stat(path.join(src.dir,'P_3.NEF'))).size===0);
  await sourceSame('empty files on import',src.dir,before);
  // Organization: the library holds the same four files.
  const seedOrg=async(name:string)=>{
   const dir=await newLib(name),s:Src={dir,files:new Map()};
   await put(s,'loose/OK.JPG',50_011);await put(s,'loose/E_1.JPG',Buffer.alloc(0));await put(s,'loose/sub/P_3.NEF',Buffer.alloc(0));await put(s,'loose/sub/P_3.xmp',650);
   return s;
  };
  const OM=makeMeta();OM.set(['OK.JPG','E_1.JPG','P_3.NEF'],{camera:NIKON,date:D1});
  for(const collect of [true,false]){
   const org=await seedOrg('problems-org-'+collect),planned=await core.plan(org.dir,[org.dir],request({reorganize:true,collectProblems:collect}),OM.fn);
   check(`organization (collectProblemFiles ${collect}) plan has no failures`,planned.failures.length===0,planned.failures.map(f=>f.error.message));
   const flags=planned.problems.map(p=>`${p.relative}:${p.reason}:${p.collected}`).sort();
   check(`organization (collect ${collect}): three problem files reported with collected=${collect}`,planned.problems.length===3&&planned.problems.every(p=>p.collected===collect),flags);
   const moved=await core.executeReorganization(planned.plans[0]!);
   check(`organization (collect ${collect}) reports no errors`,moved.errors.length===0,moved.errors);
   const file=(rel:string)=>`Problem files/Empty files/${rel}`;
   await treeIs(`organization with collectProblemFiles ${collect}`,org.dir,expectOf(org,collect
    ?{[J(dir3(D1,NIKON),'OK.JPG')]:'loose/OK.JPG',[file('loose/E_1.JPG')]:'loose/E_1.JPG',[file('loose/sub/P_3.NEF')]:'loose/sub/P_3.NEF',[file('loose/sub/P_3.xmp')]:'loose/sub/P_3.xmp'}
    :{[J(dir3(D1,NIKON),'OK.JPG')]:'loose/OK.JPG','loose/E_1.JPG':'loose/E_1.JPG','loose/sub/P_3.NEF':'loose/sub/P_3.NEF','loose/sub/P_3.xmp':'loose/sub/P_3.xmp'}));
   if(collect){
    const again=await core.plan(org.dir,[org.dir],request({reorganize:true,collectProblems:true}),OM.fn);
    check('a second organization leaves the Problem files folder alone',again.plans[0]!.entries.length===0&&again.problems.length===0,{entries:again.plans[0]!.entries.length,problems:again.problems.length});
   }
  }
  // Unreadable files cannot be made on an exFAT mount (it ignores permissions), and the harness forbids other media.
  const probe=path.join(src.dir,'probe-unreadable.bin');await gWrite(probe,'x');await fs.chmod(probe,0);
  const readable=await fs.readFile(probe).then(()=>true,()=>false);await gRm(probe);
  if(readable)skip('unreadable problem files (collectProblemFiles on/off)','chmod 000 on this exFAT mount does not stop reads (permissions are ignored), so no file can be made unreadable inside the sandbox');
  else check('unreadable file is reported as a problem',false,'not implemented for a volume that enforces permissions');
 });

 // ===============================================================================================================
 await scenario('8. Conflict naming: folder (Conflicts/<id>) and number (name (n).ext, family shares n); identical content skipped',async()=>{
  const M=makeMeta(),cam=dir3(D1,NIKON);
  const names=['CF_0001.NEF','CF_0001.JPG','CF_0001.xmp','SOLO_0002.JPG','CF_0003.NEF','CF_0003.JPG','CF_0003.xmp'];
  M.set(['CF_0001.NEF','CF_0001.JPG','SOLO_0002.JPG','CF_0003.NEF','CF_0003.JPG'],{camera:NIKON,date:D1});
  const make=async(name:string,files:string[])=>{const s=await newSrc(name);for(const f of files)await put(s,f,20_000+Math.floor(Math.random()*30_000));return s;};
  const original=await make('conflict-orig',['CF_0001.NEF','CF_0001.JPG','SOLO_0002.JPG','CF_0003.JPG']);   // the library starts with these
  const v1=await make('conflict-v1',names),v2=await make('conflict-v2',names);                               // two other versions of every name
  for(const mode of ['folder','number'] as const){
   const lib=await newLib('conflict-'+mode);
   const r0=await importTo(original,[lib],{conflictNaming:mode},M);
   cleanRun(mode+': original import',r0,r0.planned);
   const have=expectOf(original,{[J(cam,'CF_0001.NEF')]:'CF_0001.NEF',[J(cam,'CF_0001.JPG')]:'CF_0001.JPG',[J(cam,'SOLO_0002.JPG')]:'SOLO_0002.JPG',[J(cam,'CF_0003.JPG')]:'CF_0003.JPG'});
   await treeIs(`${mode}: starting library`,lib,have);
   // identical content already there: re-importing the original is skipped entirely
   const again=await importTo(original,[lib],{conflictNaming:mode},M);
   check(`${mode}: identical content already present is skipped (nothing copied, every entry skip)`,again.copied===0&&entriesOf(again.planned).every(e=>e.skip)&&again.errors.length===0,{copied:again.copied,errors:again.errors});
   await treeIs(`${mode}: re-import of identical content adds nothing`,lib,have);
   // version 1
   const before1=await snap(v1.dir),r1=await importTo(v1,[lib],{conflictNaming:mode},M);
   cleanRun(mode+': conflicting import (v1)',r1,r1.planned);
   const h=(s:Src,n:string)=>s.files.get(n)!;
   const exp1=new Map(have);
   if(mode==='folder'){
    // Whole families go to Conflicts/<id>/ with their own names: CF_0001 (3 files), SOLO_0002 (1), CF_0003 (3 files, though only the JPG clashed).
    const id1=conflictId(['CF_0001.NEF','CF_0001.JPG','CF_0001.xmp'].map(n=>[n,h(v1,n)])),id2=conflictId([['SOLO_0002.JPG',h(v1,'SOLO_0002.JPG')]]),id3=conflictId(['CF_0003.NEF','CF_0003.JPG','CF_0003.xmp'].map(n=>[n,h(v1,n)]));
    for(const [id,ns] of [[id1,['CF_0001.NEF','CF_0001.JPG','CF_0001.xmp']],[id2,['SOLO_0002.JPG']],[id3,['CF_0003.NEF','CF_0003.JPG','CF_0003.xmp']]] as [string,string[]][])for(const n of ns)exp1.set(J(cam,'Conflicts',id,n),h(v1,n));
   }else{
    for(const n of ['CF_0001.NEF','CF_0001.JPG','CF_0001.xmp'])exp1.set(J(cam,n.replace(/^(CF_0001)/,'$1 (1)')),h(v1,n));
    exp1.set(J(cam,'SOLO_0002 (1).JPG'),h(v1,'SOLO_0002.JPG'));
    for(const n of ['CF_0003.NEF','CF_0003.JPG','CF_0003.xmp'])exp1.set(J(cam,n.replace(/^(CF_0003)/,'$1 (1)')),h(v1,n));
   }
   await treeIs(`${mode}: conflicting import (v1) lands as the ${mode==='folder'?'Conflicts/<id> folders':'numbered names'}, originals untouched`,lib,exp1);
   await sourceSame(mode+' v1',v1.dir,before1);
   // re-run of v1: its content is now present (as a conflict copy): nothing new
   const rerun=await importTo(v1,[lib],{conflictNaming:mode},M);
   check(`${mode}: re-running the conflicting import copies nothing`,rerun.copied===0&&rerun.errors.length===0,{copied:rerun.copied,errors:rerun.errors});
   await treeIs(`${mode}: re-run adds no second conflict copy`,lib,exp1);
   // version 2: a third content for the same names
   const r2=await importTo(v2,[lib],{conflictNaming:mode},M);
   cleanRun(mode+': second conflicting import (v2)',r2,r2.planned);
   const after2=await treeOf(lib),added=[...after2.keys()].filter(k=>!exp1.has(k));
   const n2=mode==='folder'?added.filter(k=>k.includes('/Conflicts/')).length:added.filter(k=>/ \(2\)\./.test(k)).length;
   check(`${mode}: v2 adds 7 files ${mode==='folder'?'in three more Conflicts folders':'numbered (2)'}`,added.length===7&&n2===7,added);
   if(mode==='number'){
    const sharing=['CF_0001 (2).NEF','CF_0001 (2).JPG','CF_0001 (2).xmp','CF_0003 (2).NEF','CF_0003 (2).JPG','CF_0003 (2).xmp','SOLO_0002 (2).JPG'].filter(n=>after2.get(J(cam,n))===undefined);
    check('number: family members share one n',sharing.length===0,sharing);
   }else{
    const folders=new Set(added.map(k=>path.dirname(k)));
    check('folder: v2 families sit in three Conflicts folders with different ids from v1',folders.size===3&&[...folders].every(f=>!exp1.has(J(f,'CF_0001.NEF'))),[...folders]);
   }
   const bad:string[]=[];for(const [k,v] of after2){if(exp1.has(k)&&exp1.get(k)!==v)bad.push(k);}
   check(`${mode}: earlier files untouched by the second conflict`,bad.length===0,bad);
  }
 });

 // ===============================================================================================================
 await scenario('9. verifyCopies on/off x exFAT direct vs staged copy',async()=>{
  const src=await newSrc('bulk'),M=makeMeta();
  const expected=new Map<string,string>(),captures:{name:string;date:string}[]=[];
  await put(src,'BIG_0001.NEF',3*1024*1024+17);await put(src,'BIG_0002.MP4',5*1024*1024+3);
  M.set('BIG_0001.NEF',{camera:CANON,date:'2023-09-09T09:09:09'});M.set('BIG_0002.MP4',{camera:SONY,date:'2023-09-10T10:10:10'});
  captures.push({name:'BIG_0001.NEF',date:'2023-09-09T09:09:09'},{name:'BIG_0002.MP4',date:'2023-09-10T10:10:10'});
  const cameras=[NIKON,SONY,CANON];
  for(let i=0;src.files.size<Math.max(FILES,12);i++){
   const stem=`BLK_${String(i).padStart(4,'0')}`,date=`${2020+(i%5)}-${String((i*5)%12+1).padStart(2,'0')}-${String(1+(i*7)%27).padStart(2,'0')}T12:${String(i%60).padStart(2,'0')}:00`,camera=cameras[i%3]!;
   await put(src,stem+'.JPG',30_000+i*997);M.set(stem+'.JPG',{camera,date});captures.push({name:stem+'.JPG',date});
   if(i%3===0){await put(src,stem+'.xmp',500+i);captures.push({name:stem+'.xmp',date});}
  }
  void expected;
  const cameraOf=(name:string)=>M.fn(path.join(src.dir,name));
  const before=await snap(src.dir);
  const matrix:[boolean,boolean|undefined][]=[[true,undefined],[false,undefined],[true,false],[false,false]];
  const capable=await paths.directCapable(await newLib('bulk-probe'),'');
  console.log('directCapable(library on this exFAT volume):',capable);
  check('the library volume is direct-capable (exFAT with single-link files)',capable===true);
  for(const [verify,direct] of matrix){
   const label=`verify ${verify?'on':'off'}, ${direct===false?'staged (direct:false)':'direct (default on exFAT)'}`;
   const lib=await newLib(`bulk-${verify}-${direct===false?'staged':'direct'}`);
   const r=await importTo(src,[lib],{},M,{verify,direct});
   cleanRun(label,r,r.planned);
   const want:Record<string,string>={};
   for(const {name} of captures){const meta=await cameraOf(name.endsWith('.xmp')?name.replace('.xmp','.JPG'):name);want[J(dir3(meta.date!,meta.camera!),name)]=name;}
   await treeIs(label,lib,expectOf(src,want));
   check(`${label}: copied ${src.files.size} files`,r.copied===src.files.size,{copied:r.copied,expected:src.files.size});
   const kinds=new Set(r.seen.outcomes.map(o=>o.verification));
   check(`${label}: every outcome is ${verify?'content-verified (re-read and compared)':'stream-only (written from a checksummed read, not re-read)'}`,r.seen.outcomes.length===src.files.size&&kinds.size===1&&kinds.has(verify?'content-verified':'stream-only'),{outcomes:r.seen.outcomes.length,kinds:[...kinds]});
   if(direct===false)check(`${label}: staged path used (a verifying phase ran, no direct work reported)`,!r.seen.direct&&r.seen.phases.has('verifying'),{direct:r.seen.direct,phases:[...r.seen.phases]});
   else check(`${label}: direct path used on exFAT (progress reports direct work, no separate staged verify phase)`,r.seen.direct&&!r.seen.phases.has('verifying'),{direct:r.seen.direct,phases:[...r.seen.phases]});
   const sha1=await Promise.all([...r.seen.outcomes].map(async o=>(await fileSha(o.destination))===o.sha256&&o.sha256===src.files.get(path.relative(src.dir,o.source))));
   check(`${label}: outcome checksums equal the source and the file on disk`,sha1.every(Boolean),sha1.filter(x=>!x).length);
   // dates on this run too
   const wrongDates:string[]=[];
   for(const [rel] of Object.entries(want)){
    const name=path.basename(rel),capture=captures.find(c=>c.name===name)!,expectMs=captureTimestamp(capture.date),st=await fs.stat(path.join(lib,rel));
    const sourceMs=(await fs.stat(path.join(src.dir,name))).mtimeMs;
    if(Math.abs(st.mtimeMs-(expectMs??sourceMs))>2000)wrongDates.push(`${rel} mtime ${new Date(st.mtimeMs).toISOString()}`);
   }
   check(`${label}: destination modified time = capture date`,wrongDates.length===0,wrongDates.slice(0,4));
  }
  await sourceSame('bulk',src.dir,before);
 });

 // ===============================================================================================================
 await scenario('10. Skip errors and retry: a file failing while planning, and between plan and execute',async()=>{
  const cam=dir3(D1,NIKON),M=makeMeta();
  const src=await newSrc('skip');
  for(const n of ['K_1.JPG','K_2.JPG','K_3.NEF','K_4.JPG'])await put(src,n,40_000+n.charCodeAt(2));await put(src,'K_3.xmp',900);
  M.set(['K_1.JPG','K_2.JPG','K_3.NEF','K_4.JPG'],{camera:NIKON,date:D1});
  const all=expectOf(src,{[J(cam,'K_1.JPG')]:'K_1.JPG',[J(cam,'K_2.JPG')]:'K_2.JPG',[J(cam,'K_3.NEF')]:'K_3.NEF',[J(cam,'K_3.xmp')]:'K_3.xmp',[J(cam,'K_4.JPG')]:'K_4.JPG'});
  const without=(...drop:string[])=>new Map([...all].filter(([k])=>!drop.some(d=>k.endsWith('/'+d))));
  // The failing file changes while it is being checked (its own metadata read rewrites it), so planning sees it change.
  const poisoned=path.join(src.dir,'K_3.NEF'),original=await fs.readFile(poisoned);
  let poison=true;
  M.onRead(async file=>{if(poison&&path.basename(file)==='K_3.NEF')await gWrite(poisoned,Buffer.concat([original,Buffer.from('x')]));});
  const libOff=await newLib('skip-off');
  const failed=await rejects(()=>core.plan(src.dir,[libOff],request({skipErrors:false}),M.fn));
  console.log('skipFileErrors off ->',failed?.message);
  check('skipFileErrors off: planning stops and names the file that changed',!!failed&&/K_3\.NEF/.test(failed.message),failed?.message);
  check('skipFileErrors off: nothing was written',(await treeOf(libOff)).size===0);
  await gWrite(poisoned,original);
  // skipFileErrors on: the bad file leaves its whole family out; the rest imports.
  poison=true;
  const libOn=await newLib('skip-on'),planned=await core.plan(src.dir,[libOn],request({skipErrors:true}),M.fn);
  const failPaths=planned.failures.map(f=>path.basename(f.path)).sort();console.log('plan failures:',failPaths.join(', '));
  check('skipFileErrors on: the failing file and its family are reported, not fatal',failPaths.includes('K_3.xmp')&&failPaths.includes('K_3.NEF'),failPaths);
  const first=await execPlans(planned.plans);
  check('skipFileErrors on: the rest imported without errors',first.errors.length===0&&first.copied===3,first);
  await treeIs('skipFileErrors on: the failed family is not split (neither NEF nor xmp copied)',libOn,expectOf(src,{[J(cam,'K_1.JPG')]:'K_1.JPG',[J(cam,'K_2.JPG')]:'K_2.JPG',[J(cam,'K_4.JPG')]:'K_4.JPG'}));
  // Retry later: the problem is gone; only the missing family is copied.
  poison=false;await gWrite(poisoned,original);
  const retry=await importTo(src,[libOn],{skipErrors:true},M);
  check('retry: planning has no failures and imports exactly the family that was left out',retry.planned.failures.length===0&&retry.copied===2&&retry.errors.length===0,{failures:retry.planned.failures.length,copied:retry.copied,errors:retry.errors});
  await treeIs('retry: library now holds everything with source hashes',libOn,all);
  // The Skip button: exclude the file (skipFileErrors off).
  poison=true;
  const libSkip=await newLib('skip-button'),skipped=await core.plan(src.dir,[libSkip],request({skipErrors:false,exclude:[poisoned]}),M.fn);
  check('Skip (exclude) lets a skipFileErrors-off plan go on without that file\'s family',skipped.failures.every(f=>/K_3/.test(f.path)),skipped.failures.map(f=>f.path));
  const sk=await execPlans(skipped.plans);
  check('Skip: remaining files imported',sk.errors.length===0,sk.errors);
  await treeIs('Skip: library without K_3.NEF and K_3.xmp',libSkip,without('K_3.NEF','K_3.xmp'));
  poison=false;M.onRead(undefined);

  // Between plan and execute: removed and changed files fail their family; the rest of the job completes; retry succeeds.
  const s2=await newSrc('skip-exec');
  await put(s2,'G_1.NEF',60_001);await put(s2,'G_1.xmp',700);await put(s2,'G_2.JPG',40_002);await put(s2,'G_3.JPG',40_003);await put(s2,'G_4.JPG',40_004);
  const M2=makeMeta();M2.set(['G_1.NEF','G_2.JPG','G_3.JPG','G_4.JPG'],{camera:NIKON,date:D1});
  for(const [skipErrors,direct] of [[true,undefined],[false,undefined],[true,false],[false,false]] as [boolean,boolean|undefined][]){
   const mode=`skipFileErrors ${skipErrors?'on':'off'}, ${direct===false?'staged':'direct'}`;
   const lib=await newLib(`skip-exec-${skipErrors}-${direct===false?'staged':'direct'}`),p2=await core.plan(s2.dir,[lib],request({skipErrors}),M2.fn);
   check(`${mode}: plan lists all five files`,entriesOf(p2).length===5&&p2.failures.length===0,entriesOf(p2).length);
   const savedXmp=await fs.readFile(path.join(s2.dir,'G_1.xmp')),savedG3=await fs.readFile(path.join(s2.dir,'G_3.JPG'));
   await gRm(path.join(s2.dir,'G_1.xmp'));                          // removed after planning
   await gWrite(path.join(s2.dir,'G_3.JPG'),randomBytes(41_000));    // changed after planning
   const res=await execPlans(p2.plans,{direct});
   check(`${mode}: the families that changed are reported as errors (G_1 family, G_3) and the rest completes`,res.errors.length===2&&res.errors.some(e=>/G_1/.test(e))&&res.errors.some(e=>/G_3/.test(e))&&res.copied===2,{errors:res.errors,copied:res.copied});
   const failedHere=(rel:string)=>/\/G_[13]\./.test('/'+rel);
   await treeIs(`${mode}: unchanged files published intact`,lib,expectOf(s2,{[J(cam,'G_2.JPG')]:'G_2.JPG',[J(cam,'G_4.JPG')]:'G_4.JPG'}),failedHere);
   const left=[...await treeOf(lib)].filter(([rel])=>failedHere(rel)).map(([rel,hash])=>`${rel}${hash===sha('')?' (0 bytes)':''}`);
   check(`${mode}: the failed families leave nothing at their final names`,left.length===0,left);
   // retry: put the sidecar back and re-plan
   await gWrite(path.join(s2.dir,'G_1.xmp'),savedXmp);
   const newG3=await fs.readFile(path.join(s2.dir,'G_3.JPG'));s2.files.set('G_3.JPG',sha(newG3));
   const rr=await importTo(s2,[lib],{skipErrors},M2,{direct});
   check(`${mode}: retry imports the two failed families (3 files)`,rr.copied===3&&rr.errors.length===0&&rr.planned.failures.length===0,{copied:rr.copied,errors:rr.errors});
   await treeIs(`${mode}: after retry everything is present with current source hashes`,lib,expectOf(s2,{[J(cam,'G_1.NEF')]:'G_1.NEF',[J(cam,'G_1.xmp')]:'G_1.xmp',[J(cam,'G_2.JPG')]:'G_2.JPG',[J(cam,'G_3.JPG')]:'G_3.JPG',[J(cam,'G_4.JPG')]:'G_4.JPG'}));
   await gWrite(path.join(s2.dir,'G_3.JPG'),savedG3);s2.files.set('G_3.JPG',sha(savedG3));
  }
 });

 // ===============================================================================================================
 await scenario('11. File timestamps: destination modified (and created) time = capture date, direct and staged',async()=>{
  const src=await newSrc('times'),M=makeMeta();
  const SRC_TIME='2020-02-02T12:00:00',OLD='1975-06-01T10:00:00';
  const dated:[string,string][]=[['TS_1.JPG',D1],['TS_2.NEF',D3],['TS_3.MOV','2021-12-25T18:30:15']];
  for(const [name,date] of dated){await put(src,name,60_000+name.charCodeAt(3));M.set(name,{camera:NIKON,date});}
  await put(src,'TS_2.xmp',800);
  await put(src,'TS_4.JPG',55_004);M.set('TS_4.JPG',{camera:NIKON});                     // a camera but no capture date: keeps the source's dates
  await put(src,'TS_5.JPG',55_005);M.set('TS_5.JPG',{camera:NIKON,date:OLD});            // before 1980: exFAT cannot store it
  for(const n of ['TS_4.JPG','TS_5.JPG'])await stamp(src,n,SRC_TIME);
  const before=await snap(src.dir),birthOf=async(name:string)=>(await fs.stat(path.join(src.dir,name))).birthtimeMs;
  const helper=!!process.env.IMPORTER_NATIVE_BRIDGE;
  console.log('native helper:',process.env.IMPORTER_NATIVE_BRIDGE??'(none found)');
  for(const direct of [undefined,false]){
   const mode=direct===false?'staged':'direct',lib=await newLib('times-'+mode),r=await importTo(src,[lib],{noMetadata:'fileDate'},M,{direct});
   cleanRun('timestamps '+mode,r,r.planned);
   const placed=await treeOf(lib),at=(name:string)=>[...placed.keys()].find(k=>path.basename(k)===name)!;
   const off:string[]=[],offBirth:string[]=[];
   const expectations:[string,number,number][]=[...dated.map(([n,d])=>[n,LOCAL(d),LOCAL(d)] as [string,number,number]),['TS_2.xmp',LOCAL(D3),LOCAL(D3)],['TS_4.JPG',LOCAL(SRC_TIME),await birthOf('TS_4.JPG')],['TS_5.JPG',LOCAL(SRC_TIME),await birthOf('TS_5.JPG')]];
   for(const [name,mtime,birth] of expectations){
    const rel=at(name);if(!rel){off.push('missing '+name);continue;}
    const st=await fs.stat(path.join(lib,rel));
    if(Math.abs(st.mtimeMs-mtime)>2000)off.push(`${name} modified ${new Date(st.mtimeMs).toISOString()} want ${new Date(mtime).toISOString()}`);
    if(Math.abs(st.birthtimeMs-birth)>2000)offBirth.push(`${name} created ${new Date(st.birthtimeMs).toISOString()} want ${new Date(birth).toISOString()}`);
   }
   check(`timestamps (${mode}): modified time equals the capture date (xmp follows its original; undated and pre-1980 files keep the source's dates)`,off.length===0,off);
   if(helper||offBirth.length===0)check(`timestamps (${mode}): created time equals the capture date (source created time where there is no capture date)`,offBirth.length===0,offBirth);
   else skip(`timestamps (${mode}): created time`,'native helper not found (run npm run native:mac); modified time only');
   await treeIs('timestamps ('+mode+') content',lib,expectOf(src,Object.fromEntries([...placed.keys()].map(k=>[k,path.basename(k)]))));
  }
  await sourceSame('timestamps',src.dir,before);
 });
}
