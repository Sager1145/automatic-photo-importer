import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {plan,inventory,configureOrganizationRecovery} from '../core/index';
import {formatFolder,mediaKindForPath} from '../media-formats';
import {buildTemplate,parseTemplate,type FolderPath} from '../folder-template';
import {metadata as readMetadata,closeMetadata} from '../platform/metadata';
import type {MediaLayout,Metadata,PlanEntry} from '../shared';
import {assertCopied,executeAll,fileSha,leftovers,parts,put,temporary} from './fixtures/edge';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const layouts:MediaLayout[]=['flat','format','type-format','photos-flat','videos-flat','video-root'];
const base={backup:false,template:'{year}/{yyyymm}/{camera}',unknownRules:{}};
const fixed=async():Promise<Metadata>=>({camera:'Fixture Cam',date:'2026-10-03T12:00:00',fields:{}});
const camera='2026/202610/Fixture Cam';

/** Every extension media-formats.ts lists, read from the source so the test follows the list. */
async function listedExtensions():Promise<string[]> {
 const source=await fs.readFile(fileURLToPath(new URL('../media-formats.ts',import.meta.url)),'utf8');
 const block=source.slice(source.indexOf('Object.entries({'),source.indexOf('})) {'));
 return [...block.matchAll(/^\s*\w+: '([a-z0-9 ]+)',?$/gm)].flatMap(match=>match[1]!.split(' '));
}
async function drive(t:test.TestContext,prefix:string){
 const root=await temporary(t,prefix),source=path.join(root,'card'),photos=path.join(root,'drive','photobackup'),videos=path.join(root,'drive','videobackup');
 for(const folder of [source,photos,videos])await fs.mkdir(folder,{recursive:true});
 return {root,source,photos,videos};
}
const by=(entries:PlanEntry[],name:string)=>entries.find(entry=>path.basename(entry.source)===name)!;

/** Copying every extension in every layout takes minutes; the stress suite does that. */
const copyLayouts=new Set<MediaLayout>(process.env.EDGE_COPY_ALL_LAYOUTS?layouts:['video-root']);
test('every listed media extension, in either case, is planned and filed by format in all six layouts and copied exactly',async t=>{
 const extensions=await listedExtensions();
 assert.ok(extensions.length>60,'the extension list was read');
 for(const layout of layouts){
  const {source,photos,videos}=await drive(t,`edge-ext-${layout}-`);
  for(const [index,extension] of extensions.entries())await put(path.join(source,'DCIM',`F${String(index).padStart(4,'0')}.${index%2?extension.toUpperCase():extension}`),`bytes ${index} ${extension}`);
  const {inventory:scan,plans:[transfer]}=await plan(source,[photos],{...base,layout,videoRoots:[videos]},fixed);
  assert.equal(scan.files.length,extensions.length);assert.equal(scan.skipped?.length,0,layout);
  const entries=parts(transfer!).flatMap(part=>part.entries);
  assert.equal(entries.length,extensions.length,layout);
  for(const part of parts(transfer!))for(const entry of part.entries){
   const video=mediaKindForPath(entry.source)==='Videos',format=formatFolder(entry.source),relative=path.relative(part.root,entry.destination).split(path.sep);
   assert.equal(part===transfer?'photos':'videos',layout==='video-root'&&video?'videos':'photos',entry.source);
   const inside=relative.slice(3,-1);
   const want=layout==='format'?[format]:layout==='type-format'?[video?'Videos':'Photos',format]:layout==='photos-flat'?(video?['Videos']:[]):layout==='videos-flat'?(video?[]:['Photos']):[];
   assert.deepEqual(inside,want,`${layout}: ${entry.source}`);
  }
  if(!copyLayouts.has(layout))continue;
  const result=await executeAll(transfer!);
  assert.deepEqual(result,{copied:extensions.length,skipped:0,errors:[]},layout);
  await assertCopied(transfer!);
  assert.deepEqual(await leftovers(path.dirname(photos)),[]);
 }
});

// Companions and proxies of each camera family travel with their original.
const families:{name:string;original:string;companions:string[]}[]=[
 {name:'GoPro chapter proxy and thumbnail',original:'100GOPRO/GX010123.MP4',companions:['100GOPRO/GL010123.LRV','100GOPRO/GX010123.THM']},
 {name:'GoPro HEVC',original:'100GOPRO/GH010124.MP4',companions:['100GOPRO/GL010124.LRV']},
 {name:'Insta360 proxy',original:'DCIM/Camera01/VID_20261003_120000_00_001.insv',companions:['DCIM/Camera01/LRV_20261003_120000_01_001.lrv']},
 {name:'DJI proxy, subtitles and audio',original:'DCIM/100MEDIA/DJI_0007.MP4',companions:['DCIM/100MEDIA/DJI_0007.LRF','DCIM/100MEDIA/DJI_0007.SRT','DCIM/100MEDIA/DJI_0007.WAV']},
 {name:'Sony XML',original:'PRIVATE/M4ROOT/CLIP/C0009.MP4',companions:['PRIVATE/M4ROOT/CLIP/C0009M01.XML']},
 {name:'Canon THM',original:'DCIM/100CANON/MVI_0010.MOV',companions:['DCIM/100CANON/MVI_0010.THM']},
 {name:'JVC MOI',original:'SD_VIDEO/PRG001/MOV011.MOD',companions:['SD_VIDEO/PRG001/MOV011.MOI']},
 {name:'RAW with XMP sidecars',original:'DCIM/100NIKON/DSC_0012.NEF',companions:['DCIM/100NIKON/DSC_0012.xmp','DCIM/100NIKON/DSC_0012.NEF.xmp','DCIM/100NIKON/DSC_0012.JPG']},
];
for(const layout of layouts)test(`${layout}: companions and proxies of every camera family land beside their original`,async t=>{
 const {source,photos,videos}=await drive(t,'edge-companions-');
 for(const family of families)for(const name of [family.original,...family.companions])await put(path.join(source,name),'bytes of '+name);
 // Proxies without an original are imported as videos of their own.
 await put(path.join(source,'100GOPRO/GL020999.LRV'),'lonely gopro proxy');await put(path.join(source,'DCIM/100MEDIA/DJI_0099.LRF'),'lonely dji proxy');
 const {inventory:scan,plans:[transfer]}=await plan(source,[photos],{...base,layout,videoRoots:[videos]},fixed);
 assert.equal(scan.skipped?.length,0);
 const entries=parts(transfer!).flatMap(part=>part.entries);
 for(const family of families){
  const original=by(entries,path.basename(family.original));
  for(const companion of family.companions){
   const entry=by(entries,path.basename(companion));
   // A JPEG beside a RAW is a still of its own family and keeps its own format folder.
   if(companion.endsWith('.JPG'))continue;
   assert.equal(path.dirname(entry.destination),path.dirname(original.destination),`${family.name}: ${companion}`);
   assert.equal(entry.family,original.family,`${family.name}: ${companion}`);
  }
 }
 for(const lonely of ['GL020999.LRV','DJI_0099.LRF'])assert.equal(by(entries,lonely).kind,'Videos');
 if(!copyLayouts.has(layout))return;
 assert.equal((await executeAll(transfer!)).errors.length,0);
 await assertCopied(transfer!);
});

test('unknown formats, camera service files and extensionless files are never dropped silently',async t=>{
 const {source,photos}=await drive(t,'edge-unknown-');
 const names=['DCIM/100NIKON/DSC_0001.NEF','DCIM/100NIKON/NC_FLLST.DAT','NIKON001.DSC','PRIVATE/M4ROOT/MEDIAPRO.XML','PRIVATE/SONY/SONYCARD.IND','FFDB/FFXFER.DAT','EOSMISC/X.CTG',
  'notes.txt','README','archive.tar.gz','data.d@t','weird.ext with space','.hidden','DCIM/100NIKON/DSC_0002.unknownraw','MISC/thing.DAT'];
 for(const name of names)await put(path.join(source,name),'bytes of '+name);
 for(const unknownDefault of ['skip','other','ask'] as const){
  const {inventory:scan,plans:[transfer]}=await plan(source,[photos],{...base,layout:'format',unknownDefault},fixed);
  const planned=new Set(transfer!.entries.map(entry=>entry.source)),skipped=new Set(scan.skipped!.map(file=>file.path));
  // Every listed file is either planned or reported as skipped, never both or neither.
  for(const file of scan.files)assert.equal(planned.has(file.path)!==skipped.has(file.path),true,`${unknownDefault}: ${file.relative}`);
  assert.equal(scan.files.length,names.length);
  for(const service of ['NC_FLLST.DAT','NIKON001.DSC','MEDIAPRO.XML','SONYCARD.IND','FFXFER.DAT','X.CTG'])assert.equal(scan.skipped!.find(file=>path.basename(file.path)===service)?.reason,'system',service);
  if(unknownDefault==='other'){
   assert.equal(path.relative(photos,by(transfer!.entries,'notes.txt').destination),'Other files/txt/notes.txt');
   // An extension that is not a plain word gets the shared Other files folder.
   assert.equal(path.relative(photos,by(transfer!.entries,'data.d@t').destination),'Other files/data.d@t');
   assert.equal(path.relative(photos,by(transfer!.entries,'weird.ext with space').destination),'Other files/weird.ext with space');
   assert.equal((await executeAll(transfer!)).errors.length,0);await assertCopied(transfer!);
  }
 }
 // A drive backup copies service files too.
 const {plans:[backup]}=await plan(source,[photos],{...base,backup:true,layout:'flat'},fixed);
 assert.equal(backup!.entries.length,names.length);
});

test('Unicode, NFD, emoji, 255-byte, control-character and dash-led names copy byte-exactly',async t=>{
 const {source,photos}=await drive(t,'edge-names-');
 const long='L'.repeat(251)+'.JPG',multibyte='写'.repeat(83)+'.JPG';
 const names=['Caf\u00e9_NFC.JPG','Cafe\u0301_NFD.JPG','東京タワー.JPG','📷🌅.HEIC','-leading-dash.JPG','new\nline.JPG','tab\there.JPG','colon:name.JPG','  spaced  .JPG',long,multibyte,'Ünïcödé/földer/ñ.NEF','\u0041\u030A.JPG','sub/\u00C5.jpg'];
 assert.equal(Buffer.byteLength(long),255);assert.equal(Buffer.byteLength(multibyte),253);
 for(const [index,name] of names.entries())await put(path.join(source,name),`bytes ${index}`);
 for(const layout of ['format','video-root'] as const){
  const destination=path.join(photos,layout),videos=path.join(path.dirname(photos),'videos-'+layout);await fs.mkdir(destination);await fs.mkdir(videos);
  const {plans:[transfer]}=await plan(source,[destination],{...base,layout,videoRoots:[videos]},fixed);
  const entries=parts(transfer!).flatMap(part=>part.entries);
  assert.equal(entries.length,names.length);
  // NFD Å.JPG and NFC Å.jpg (in another folder) are one name on APFS; different bytes go to a conflict folder.
  assert.equal(new Set(entries.map(entry=>entry.destination.normalize('NFC').toLowerCase())).size,names.length);
  assert.equal((await executeAll(transfer!)).errors.length,0,layout);
  await assertCopied(transfer!);
 }
});

test('a 64-level-deep source tree and many same-named files in separate folders lose nothing',async t=>{
 const {source,photos}=await drive(t,'edge-deep-');
 let deep=source;for(let level=0;level<64;level++)deep=path.join(deep,`d${level}`);
 await put(path.join(deep,'DEEP.JPG'),'deep bytes');
 // 40 folders with DSC_0001.JPG: 30 different files and 10 copies of one file.
 for(let index=0;index<40;index++)await put(path.join(source,`${100+index}NIKON`,'DSC_0001.JPG'),index<30?`unique ${index}`:'shared bytes');
 const {plans:[transfer]}=await plan(source,[photos],{...base,layout:'format'},fixed);
 const destinations=new Set(transfer!.entries.map(entry=>entry.destination));
 // The 10 identical files share one destination; the rest get one each.
 assert.equal(destinations.size,1+31);
 assert.equal((await executeAll(transfer!)).errors.length,0);
 await assertCopied(transfer!);
 assert.equal(await fs.readFile(path.join(photos,camera,'JPEG','DEEP.JPG'),'utf8'),'deep bytes');
});

test('garbled camera names and dates never fail a plan or escape the camera folder',async t=>{
 const {source,photos}=await drive(t,'edge-garbled-');
 const cases:Record<string,Metadata>={
  'A.JPG':{camera:'../../etc',date:'2026-10-03',fields:{}},
  'B.JPG':{camera:'CON',date:'0000-00-00T00:00:00',fields:{}},
  'C.JPG':{camera:'a/b\\c:d*e?f"g<h>i|j',date:'2026-02-30T10:00:00',fields:{}},
  'D.JPG':{camera:'   ',date:'2026-13-01T10:00:00',fields:{}},
  'E.JPG':{camera:'x'.repeat(500),date:'garbage',fields:{}},
  'F.JPG':{camera:'Ctrl\u0000\u0007Cam\u007f',date:'',fields:{}},
  'G.JPG':{camera:'Brace{year}Cam',date:'2026-10-03T12:00:00',fields:{}},
  'H.JPG':{camera:'{camera}',date:'2026-10-03T12:00:00',fields:{}},
  'I.JPG':{camera:'Trailing dots...',date:'1969-12-31T23:59:59',fields:{}},
  'J.JPG':{camera:'.',date:'9999-12-31T23:59:59',fields:{}},
  'K.JPG':{fields:{}},
 };
 for(const name of Object.keys(cases))await put(path.join(source,name),'bytes of '+name);
 await fs.utimes(path.join(source,'K.JPG'),new Date('2025-05-05T12:00:00'),new Date('2025-05-05T12:00:00'));
 const {plans:[transfer]}=await plan(source,[photos],{...base,layout:'format'},async file=>cases[path.basename(file)]!);
 for(const entry of transfer!.entries){
  const relative=path.relative(photos,entry.destination);
  assert.ok(!relative.startsWith('..')&&!path.isAbsolute(relative),relative);
  assert.ok(relative.split(path.sep).every(part=>part&&part!=='.'&&part!=='..'&&Buffer.byteLength(part)<=255&&!/[\u0000-\u001f\u007f]/u.test(part)),relative);
 }
 assert.equal(path.relative(photos,by(transfer!.entries,'K.JPG').destination),'2025/202505/Unknown Camera/JPEG/K.JPG');
 // Braces in a camera name are part of the name, not template tokens.
 assert.equal(path.relative(photos,by(transfer!.entries,'G.JPG').destination),'2026/202610/Brace{year}Cam/JPEG/G.JPG');
 assert.equal(path.relative(photos,by(transfer!.entries,'H.JPG').destination),'2026/202610/{camera}/JPEG/H.JPG');
 assert.deepEqual((await executeAll(transfer!)).errors,[]);
 await assertCopied(transfer!);
});

test('files with no, empty or garbage EXIF are read by ExifTool without failing the plan',async t=>{
 const {source,photos}=await drive(t,'edge-exif-');
 t.after(()=>closeMetadata());
 await put(path.join(source,'empty.JPG'),'');await put(path.join(source,'empty.NEF'),'');
 await put(path.join(source,'random.JPG'),Buffer.from(Array.from({length:4096},(_,i)=>(i*7919)%256)));
 await put(path.join(source,'truncated.JPG'),Buffer.from([0xff,0xd8,0xff,0xe1,0x00,0x40,0x45,0x78,0x69,0x66,0,0,0x49,0x49,0x2a,0]));
 await put(path.join(source,'text.MP4'),'this is not a video');await put(path.join(source,'png-header.HEIC'),Buffer.from('89504e470d0a1a0a','hex'));
 const {inventory:scan,plans:[transfer]}=await plan(source,[photos],{...base,layout:'format'},file=>readMetadata(file,{preview:false,details:false}));
 assert.equal(transfer!.entries.length,6);
 // Unreadable files fall back to Unknown Camera and their modified date; ExifTool's complaints are listed.
 for(const entry of transfer!.entries)assert.match(path.relative(photos,entry.destination),/^\d{4}\/\d{6}\/Unknown Camera\//);
 assert.ok((scan.issues??[]).length>0);
 assert.equal((await executeAll(transfer!)).errors.length,0);
 await assertCopied(transfer!);
});

test('capture dates keep the camera calendar day, and dateless files use the local day of their modified time',async t=>{
 const {source,photos}=await drive(t,'edge-zones-');
 const dates:Record<string,string>={'west.JPG':'2026-10-03T23:30:00-05:00','east.JPG':'2026-01-01T00:30:00+14:00','utc.JPG':'2026-12-31T23:59:59Z','frac.JPG':'2026-06-15T12:00:00.123456+05:45'};
 for(const name of [...Object.keys(dates),'dateless.JPG'])await put(path.join(source,name),name);
 const instant=new Date('2026-10-03T23:30:00Z');await fs.utimes(path.join(source,'dateless.JPG'),instant,instant);
 const previous=process.env.TZ;t.after(()=>{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;});
 const want:Record<string,string>={'America/Los_Angeles':'20261003','Asia/Tokyo':'20261004','UTC':'20261003'};
 for(const [zone,day] of Object.entries(want)){
  process.env.TZ=zone;
  const {plans:[transfer]}=await plan(source,[photos],{...base,template:'{yyyyMMdd}/{camera}',layout:'flat'},async file=>({camera:'Cam',date:dates[path.basename(file)],fields:{}}));
  const folders=Object.fromEntries(transfer!.entries.map(entry=>[path.basename(entry.source),path.relative(photos,entry.destination).split(path.sep)[0]]));
  assert.deepEqual(folders,{'west.JPG':'20261003','east.JPG':'20260101','utc.JPG':'20261231','frac.JPG':'20260615','dateless.JPG':day},zone);
 }
});

test('the folder path builder round-trips every combination and each template plans valid folders',async t=>{
 const {source,photos}=await drive(t,'edge-builder-');
 await put(path.join(source,'A.JPG'),'a');
 const combos:FolderPath[]=[];
 for(const order of ['date','camera'] as const)for(const year of [false,true])for(const monthOn of [false,true])for(const monthFull of [false,true])for(const english of [false,true])for(const dayOn of [false,true])for(const dayFull of [false,true])
  combos.push({order,year,month:{on:monthOn,full:monthFull,english},day:{on:dayOn,full:dayFull}});
 const templates=new Set<string>();
 for(const value of combos){
  const template=buildTemplate(value),parsed=parseTemplate(template);
  assert.ok(parsed,template);assert.equal(buildTemplate(parsed),template);templates.add(template);
 }
 for(const template of templates){
  const {plans:[transfer]}=await plan(source,[photos],{...base,template,layout:'flat'},fixed);
  const folder=path.relative(photos,path.dirname(transfer!.entries[0]!.destination));
  assert.equal(folder.split(path.sep).length,template.split('/').length,template);
  assert.ok(folder.includes('Fixture Cam'),template);
 }
 // Custom templates the builder cannot show stay custom.
 for(const custom of ['{camera}/{year}/{camera}','{year}/fixed/{camera}','{day}/{month}/{year}/{camera}'])assert.equal(parseTemplate(custom),undefined,custom);
});

test('a camera audio file with no video goes to its camera folder; a plain inventory reports each file once',async t=>{
 const {source}=await drive(t,'edge-audio-');
 await put(path.join(source,'DCIM/100MEDIA/DJI_0001.MP4'),'v');await put(path.join(source,'DCIM/100MEDIA/DJI_0002.WAV'),'a');
 const scan=await inventory(source,{});
 assert.equal(new Set(scan.files.map(file=>file.path)).size,scan.files.length);
 assert.equal(scan.files.find(file=>file.path.endsWith('DJI_0002.WAV'))?.included,true);
});
