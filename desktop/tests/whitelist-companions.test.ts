import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {inventory,plan} from '../core/index';
import type {Metadata} from '../shared';

const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const camera=async():Promise<Metadata>=>({camera:'Cam',date:'2024-03-04T10:00:00Z',fields:{}});
async function fixture(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'whitelist-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'card'),root=path.join(base,'destination');
 await fs.mkdir(source);await fs.mkdir(root);
 const put=async(relative:string,contents:string='data')=>{const file=path.join(source,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,contents);return file;};
 return {source,root,put};
}

test('sidecar extensions pair by double extension and never reach exiftool',async t=>{
 const {source,root,put}=await fixture(t);
 const raw=await put('DCIM/A/IMG_0001.CR3');
 const sidecars=[await put('DCIM/A/IMG_0001.CR3.pp3'),await put('DCIM/A/IMG_0001.CR3.acr'),await put('DCIM/A/IMG_0001.pp3'),await put('DCIM/A/IMG_0001.comask'),await put('DCIM/A/IMG_0001.on1'),await put('DCIM/A/IMG_0001.dr4'),await put('DCIM/A/IMG_0001.vrd'),await put('DCIM/A/IMG_0001.rmd'),await put('DCIM/A/IMG_0001.sidecar')];
 const scan=await inventory(source,{});
 for(const file of sidecars)assert.equal(scan.files.find(item=>item.path===file)?.companionOf,raw,file);
 const read:string[]=[];
 const found=await plan(source,[root],options,async file=>{read.push(path.basename(file));return camera();});
 assert.deepEqual(read,['IMG_0001.CR3']);
 assert.equal(found.plans[0]!.entries.length,10);
});

test('RawTherapee, darktable, Capture One, Nikon audio, Sony BIM, MOI and AAE companions pair',async t=>{
 const {source,put}=await fixture(t);
 const jpg=await put('A/x.jpg'),out=await put('A/x.jpg.out.pp3');
 const dt=await put('A/y.jpg'),dtx=await put('A/y_01.jpg.xmp'),dtNone=await put('A/z_02.jpg.xmp');
 const co=await put('B/c.nef'),cos=await put('B/CaptureOne/Settings131/c.nef.cos'),mask=await put('B/CaptureOne/Settings131/c.nef.comask'),cache=await put('B/CaptureOne/Cache/c.nef.cos');
 const nef=await put('C/DSC0001.NEF'),memo=await put('C/_DSC0001.WAV'),bwf=await put('C/_DSC0001.BWF');
 const exact=await put('C/_DSC0002.NEF'),exactWav=await put('C/_DSC0002.WAV');await put('C/DSC0002.NEF');
 const clip=await put('PRIVATE/M4ROOT/CLIP/C0001.MP4'),bim=await put('PRIVATE/M4ROOT/CLIP/C0001R01.BIM'),odd=await put('PRIVATE/M4ROOT/CLIP/C0002.BIM');
 const mod=await put('V/MOV001.MOD'),moi=await put('V/MOV001.MOI');
 const img=await put('I/IMG_1234.HEIC'),aae=await put('I/IMG_O1234.AAE');
 const scan=await inventory(source,{});
 const of=(file:string)=>scan.files.find(item=>item.path===file)?.companionOf;
 assert.equal(of(out),jpg);
 assert.equal(of(dtx),dt);assert.equal(of(dtNone),undefined);
 assert.equal(of(cos),co);assert.equal(of(mask),co);assert.equal(of(cache),undefined);
 assert.equal(of(memo),nef);assert.equal(of(bwf),nef);
 assert.equal(of(exactWav),exact);
 assert.equal(of(bim),clip);assert.equal(of(odd),undefined);
 assert.equal(of(moi),mod);assert.equal(of(aae),img);
});

test('a darktable XMP with an exact-name original keeps that match',async t=>{
 const {source,put}=await fixture(t);
 await put('y.jpg');const exact=await put('y_01.jpg.xmp'),original=await put('y_01.jpg');
 const scan=await inventory(source,{});
 assert.equal(scan.files.find(item=>item.path===exact)?.companionOf,original);
});

test('Capture One settings are filed beside the original in CaptureOne/Settings*',async t=>{
 const {source,root,put}=await fixture(t);
 const nef=await put('B/c.nef'),cos=await put('B/CaptureOne/Settings131/c.nef.cos');
 const found=await plan(source,[root],options,camera);
 const dest=(file:string)=>path.relative(root,found.plans[0]!.entries.find(entry=>entry.source===file)!.destination).split(path.sep).join('/');
 assert.equal(dest(nef),'2024/202403/Cam/c.nef');
 assert.equal(dest(cos),'2024/202403/Cam/CaptureOne/Settings131/c.nef.cos');
 const entries=found.plans[0]!.entries;
 assert.equal(entries.find(e=>e.source===cos)!.family,entries.find(e=>e.source===nef)!.family);
});

test('unpaired srt goes to Other files/srt and unpaired bwf to the camera folder',async t=>{
 const {source,root,put}=await fixture(t);
 await put('DCIM/A/IMG_0001.JPG');const srt=await put('DCIM/A/notes.srt');const bwf=await put('DCIM/A/memo.bwf');
 const found=await plan(source,[root],{...options,unknownDefault:'other'},camera);
 const dest=(file:string)=>path.relative(root,found.plans[0]!.entries.find(entry=>entry.source===file)!.destination).split(path.sep).join('/');
 assert.equal(dest(srt),'Other files/srt/notes.srt');
 assert.equal(dest(bwf),'2024/202403/Cam/memo.bwf');
});

test('an empty primary leaves its pp3 and cos companions in place',async t=>{
 const {source,root,put}=await fixture(t);
 const raw=await put('A/x.CR3',''),pp3=await put('A/x.CR3.pp3','edits'),cos=await put('A/CaptureOne/Settings1/x.CR3.cos','edits');
 await put('A/ok.JPG','photo');
 const found=await plan(source,[root],options,camera);
 assert.deepEqual(found.plans[0]!.entries.map(entry=>path.basename(entry.source)),['ok.JPG']);
 const skipped=found.inventory.skipped!;
 assert.ok(skipped.some(item=>item.path===raw&&item.reason==='empty'));
 for(const file of [pp3,cos])assert.ok(skipped.some(item=>item.path===file&&item.reason==='emptyPrimary'),file);
});

// Live Photo pairing
const live=(stillMeta:Partial<Metadata>,movMeta:Partial<Metadata>)=>async(file:string):Promise<Metadata>=>{
 const isMov=/\.mov$/i.test(file);
 return {camera:isMov?'iPhone MOV':'iPhone 15',date:isMov?'2024-03-04T10:00:01Z':'2024-03-04T10:00:00Z',fields:{},...(isMov?movMeta:stillMeta)};
};
async function livePair(t:test.TestContext,stillMeta:Partial<Metadata>,movMeta:Partial<Metadata>,stills=['IMG_0001.HEIC']){
 const {source,root,put}=await fixture(t);
 const files:string[]=[];for(const still of stills)files.push(await put('DCIM/100APPLE/'+still));
 const mov=await put('DCIM/100APPLE/IMG_0001.MOV');
 const found=await plan(source,[root],options,live(stillMeta,movMeta));
 const entry=(file:string)=>found.plans[0]!.entries.find(item=>item.source===file)!;
 return {found,files,mov,entry,root};
}
test('Live Photo MOV with the same ContentIdentifier joins the still',async t=>{
 const {entry,files,mov,root}=await livePair(t,{contentId:'ABC',make:'Apple'},{contentId:'ABC'});
 assert.equal(entry(mov).family,entry(files[0]!).family);
 assert.equal(path.relative(root,entry(mov).destination),'2024/202403/iPhone 15/IMG_0001.MOV');
});
test('Live Photo MOV with a different ContentIdentifier stays independent',async t=>{
 const {entry,files,mov,root}=await livePair(t,{contentId:'ABC',make:'Apple'},{contentId:'XYZ'});
 assert.notEqual(entry(mov).family,entry(files[0]!).family);
 assert.equal(path.relative(root,entry(mov).destination),'2024/202403/iPhone MOV/IMG_0001.MOV');
});
test('Live Photo without identifiers pairs when the still is from Apple',async t=>{
 const {entry,files,mov}=await livePair(t,{make:'Apple'},{});
 assert.equal(entry(mov).family,entry(files[0]!).family);
});
test('Live Photo without identifiers does not pair for a non-Apple still',async t=>{
 const {entry,files,mov}=await livePair(t,{make:'SONY'},{});
 assert.notEqual(entry(mov).family,entry(files[0]!).family);
});
test('Live Photo prefers the HEIC over a JPG of the same stem',async t=>{
 const {entry,files,mov,found}=await livePair(t,{contentId:'ABC',make:'Apple'},{contentId:'ABC'},['IMG_0001.JPG','IMG_0001.HEIC']);
 assert.equal(entry(mov).family,entry(files[1]!).family);
 assert.equal(found.inventory.files.find(f=>f.path===mov)?.companionOf,files[1]);
});
test('a MOV with no still is unchanged, and an empty still leaves its MOV in place',async t=>{
 const {source,root,put}=await fixture(t);
 await put('A/CLIP.MOV');const heic=await put('A/IMG_0001.HEIC',''),mov=await put('A/IMG_0001.MOV');
 const found=await plan(source,[root],options,live({contentId:'ABC',make:'Apple'},{contentId:'ABC',make:'Apple'}));
 assert.deepEqual(found.plans[0]!.entries.map(entry=>path.basename(entry.source)),['CLIP.MOV']);
 assert.ok(found.inventory.skipped!.some(item=>item.path===heic&&item.reason==='empty'));
 assert.ok(found.inventory.skipped!.some(item=>item.path===mov&&item.reason==='emptyPrimary'));
});

// Review fixes
const liveMeta=async(file:string):Promise<Metadata>=>/\.mov$/i.test(file)
 ?{camera:'iPhone MOV',date:'2024-04-04T10:00:01Z',make:'Apple',contentId:'ABC',fields:{}}
 :{camera:'iPhone 15',date:'2024-03-04T10:00:00Z',make:'Apple',contentId:'ABC',fields:{}};
const formatOptions={...options,layout:'format' as const};
test('a paired Live Photo MOV carries its own xmp and LRV (sorting first) to the still folder',async t=>{
 const {source,root,put}=await fixture(t);
 const heic=await put('DCIM/A/IMG_0001.HEIC'),mov=await put('DCIM/A/IMG_0001.MOV'),xmp=await put('DCIM/A/IMG_0001.MOV.xmp'),lrv=await put('DCIM/A/IMG_0001.LRV');
 const found=await plan(source,[root],formatOptions,liveMeta);
 const entries=found.plans[0]!.entries,entry=(f:string)=>entries.find(e=>e.source===f)!;
 const rel=(f:string)=>path.relative(root,entry(f).destination).split(path.sep).join('/');
 for(const f of [mov,xmp,lrv])assert.equal(path.dirname(rel(f)),'2024/202403/iPhone 15/HEIF',f);
 assert.equal(new Set([heic,mov,xmp,lrv].map(f=>entry(f).family)).size,1);
});
test('an empty still keeps its Live Photo MOV and the MOV companions in place',async t=>{
 const {source,root,put}=await fixture(t);
 await put('A/IMG_0001.HEIC','');const mov=await put('A/IMG_0001.MOV'),xmp=await put('A/IMG_0001.MOV.xmp');await put('A/ok.JPG');
 const found=await plan(source,[root],options,liveMeta);
 assert.deepEqual(found.plans[0]!.entries.map(e=>path.basename(e.source)),['ok.JPG']);
 for(const f of [mov,xmp])assert.ok(found.inventory.skipped!.some(i=>i.path===f&&i.reason==='emptyPrimary'),f);
});
test('the companion count includes Live Photo pairs',async t=>{
 const {source,root,put}=await fixture(t);
 await put('A/IMG_0001.HEIC');await put('A/IMG_0001.MOV');
 const found=await plan(source,[root],options,liveMeta);
 assert.equal(found.inventory.companions,1);
});
test('Live Photo pairing scales to many files',async t=>{
 const {source,root}=await fixture(t);
 const dir=path.join(source,'DCIM');await fs.mkdir(dir);
 const writes:Promise<void>[]=[];
 for(let i=0;i<6700;i++){const n=String(i).padStart(5,'0');for(const ext of ['HEIC','MOV','JPG'])writes.push(fs.writeFile(path.join(dir,`IMG_${n}.${ext}`),'x'));}
 await Promise.all(writes);
 const start=performance.now();
 await plan(source,[root],options,async()=>({camera:'P',date:'2024-03-04T10:00:00Z',make:'Apple',fields:{}}));
 const elapsed=performance.now()-start;
 console.log('live scale ms',Math.round(elapsed));
 // The rest of planning (stat, metadata, destinations) takes ~20 s for 20k files on its own; the quadratic pairing alone took ~500 s.
 assert.ok(elapsed<90000,String(elapsed));
});
test('a darktable XMP needs exactly two digits',async t=>{
 const {source,put}=await fixture(t);
 const jpg=await put('y.jpg'),two=await put('y_01.jpg.xmp'),three=await put('y_001.jpg.xmp');
 const scan=await inventory(source,{});
 assert.equal(scan.files.find(i=>i.path===two)?.companionOf,jpg);
 assert.equal(scan.files.find(i=>i.path===three)?.companionOf,undefined);
});
