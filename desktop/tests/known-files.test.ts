import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {inventory,plan} from '../core/index';
import {knownSystemFile} from '../core/known-files';
import type {Metadata} from '../shared';

const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=async(file:string):Promise<Metadata>=>({camera:/\.(?:nef|nksc)$/i.test(file)?'NIKON Z f':/\.mp4$/i.test(file)?'Osmo Pocket 3':'ILCE-7CM2',date:'2025-06-26T13:50:35+08:00',fields:{}});
const alias=Buffer.concat([Buffer.from('book\0\0\0\0mark\0\0\0\0','latin1'),Buffer.alloc(600,1)]);
async function fixture(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'photo-known-files-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'card'),root=path.join(base,'destination');
 await fs.mkdir(source);await fs.mkdir(root);
 const put=async(relative:string,contents:string|Buffer='data')=>{const file=path.join(source,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,contents);return file;};
 return {source,root,put};
}
const byName=(scan:Awaited<ReturnType<typeof inventory>>,relative:string)=>scan.files.find(file=>file.relative.split(path.sep).join('/')===relative);

const systemLayouts:[string,string,string][]=[
 ['DCIM/100NCZ_F/NC_FLLST.DAT','nikon-file-list','Nikon'],
 ['NIKON001.DSC','nikon-card-index','Nikon'],
 ['PRIVATE/SONY/BODYDATA.DAT','sony-body-data','Sony'],
 ['AVF_INFO/AVIN0001.BNP','sony-avf-info','Sony'],
 ['AVF_INFO/AVIN0001.INP','sony-avf-info','Sony'],
 ['AVF_INFO/AVIN0001.INT','sony-avf-info','Sony'],
 ['PRIVATE/DATABASE/DATABASE.BIN','sony-database','Sony'],
 ['SONY/SONYCARD.IND','sony-card-index','Sony'],
 ['PRIVATE/SONY/SONYCARD.IND','sony-card-index','Sony'],
 ['M4ROOT/MEDIAPRO.XML','sony-clip-catalog','Sony'],
 ['PRIVATE/M4ROOT/MEDIAPRO.XML','sony-clip-catalog','Sony'],
 ['FFDB/FFXFER.DAT','fujifilm-transfer','Fujifilm'],
 ['FFDB/FFDB_X-T5_1234567.db','fujifilm-database','Fujifilm'],
 ['EOSMISC/M0001.CTG','canon-catalog','Canon'],
 ['PMHOME/LICENSE/LICENSE01.TXT','device-license','Other device'],
 ['PMHOME/LICENSE/LICENSE.RST','device-license','Other device'],
];

test('camera and card system files are recognised by their layout, not by bare extension',()=>{
 for(const [relative,id,vendor] of systemLayouts){const found=knownSystemFile(relative);assert.equal(found?.id,id,relative);assert.equal(found?.vendor,vendor,relative);assert.ok(found?.label,relative);}
 assert.equal(knownSystemFile('2024/card dump/DCIM/100NIKON/nc_fllst.dat')?.id,'nikon-file-list');
 for(const relative of ['INDEX.DAT','DCIM/100NCZ_F/NOTES.DAT','Projects/catalog.db','DCIM/README.XML','Documents/LICENSE.TXT','MEDIAPRO.XML.bak'])assert.equal(knownSystemFile(relative),undefined,relative);
});

test('system files are excluded silently and counted apart from unknown files',async t=>{
 const {source,put}=await fixture(t);
 for(const [relative] of systemLayouts)await put(relative);
 await put('DCIM/100NCZ_F/DSC_0001.NEF');await put('INDEX.DAT');
 const scan=await inventory(source,{unknownRules:{dsc:{action:'camera'}}});
 assert.equal(scan.system,systemLayouts.length);
 assert.equal(scan.systemKinds?.['sony-avf-info'],3);
 assert.ok(systemLayouts.every(([relative])=>byName(scan,relative)?.included===false&&byName(scan,relative)?.system));
 assert.equal(scan.unknown,1);assert.deepEqual(scan.unknownExtensions,{dat:1});
 assert.ok(scan.skipped?.some(item=>item.reason==='system'&&item.path.endsWith('NC_FLLST.DAT')));
 const backup=await inventory(source,{backup:true});
 assert.ok(backup.files.every(file=>file.included));
});

test('a Finder alias is recognised by its bytes and never imported',async t=>{
 const {source,put}=await fixture(t);
 await put('DSC00048.JPG的替身',alias);await put('notes.bin',Buffer.from('bookmark but not an alias'));
 const scan=await inventory(source,{});
 assert.equal(byName(scan,'DSC00048.JPG的替身')?.system?.id,'macos-alias');
 assert.equal(byName(scan,'DSC00048.JPG的替身')?.included,false);
 assert.equal(byName(scan,'notes.bin')?.system,undefined);
});

test('Lightroom double-extension XMP and NX Studio NKSC_PARAM edits travel with their originals',async t=>{
 const {source,root,put}=await fixture(t);
 const arw=await put('DCIM/100MSDCF/_A672715.ARW');const xmp=await put('DCIM/100MSDCF/_A672715.ARW.xmp');
 const nef=await put('DCIM/100NCZ_F/_NZF0008.NEF');const nksc=await put('DCIM/100NCZ_F/NKSC_PARAM/_NZF0008.NEF.nksc');
 const scan=await inventory(source,{});
 assert.equal(scan.files.find(file=>file.path===xmp)?.companionOf,arw);
 assert.equal(scan.files.find(file=>file.path===nksc)?.companionOf,nef);
 assert.equal(scan.unknown,0);
 const {plans}=await plan(source,[root],options,metadata);
 const destination=(file:string)=>path.relative(root,plans[0]!.entries.find(entry=>entry.source===file)!.destination).split(path.sep).join('/');
 assert.equal(destination(xmp),'2025/202506/ILCE-7CM2/_A672715.ARW.xmp');
 assert.equal(destination(nef),'2025/202506/NIKON Z f/_NZF0008.NEF');
 assert.equal(destination(nksc),'2025/202506/NIKON Z f/NKSC_PARAM/_NZF0008.NEF.nksc');
 const family=(file:string)=>plans[0]!.entries.find(entry=>entry.source===file)!.family;
 assert.equal(family(nksc),family(nef));assert.equal(family(xmp),family(arw));
});

test('audio beside a video is its companion; other camera audio goes to the camera folder by default',async t=>{
 const {source,root,put}=await fixture(t);
 const clip=await put('DCIM/DJI_001/DJI_20260524015004_0015_D.MP4');const memo=await put('DCIM/DJI_001/DJI_20260524015004_0015_D.WAV');
 const mic=await put('DCIM/DJI_001/DJI_20260524020000_0016_D.WAV');await put('DCIM/DJI_001/DJI_20260524020000_0016_D.M4A');
 const scan=await inventory(source,{});
 assert.equal(scan.files.find(file=>file.path===memo)?.companionOf,clip);
 assert.equal(scan.files.find(file=>file.path===mic)?.included,true);
 const {plans}=await plan(source,[root],options,metadata);
 assert.equal(path.relative(root,plans[0]!.entries.find(entry=>entry.source===mic)!.destination).split(path.sep).join('/'),'2025/202506/Osmo Pocket 3/DJI_20260524020000_0016_D.WAV');
 const skipped=await inventory(source,{unknownRules:{wav:null}});
 assert.equal(skipped.files.find(file=>file.path===mic)?.included,false);
 assert.equal(skipped.files.find(file=>file.path===memo)?.included,true);
});

test('the unknown-file default decides files without an explicit rule',async t=>{
 const {source,root,put}=await fixture(t);
 await put('DCIM/100MSDCF/DSC0001.ARW');const zip=await put('DCIM/100MSDCF/backup.zip');const dat=await put('INDEX.DAT');const bare=await put('README');
 const skip=await inventory(source,{unknownDefault:'skip'});
 assert.equal(skip.files.find(file=>file.path===zip)?.included,false);
 assert.ok(skip.skipped?.some(item=>item.path===zip&&item.reason==='unknown-skip'));
 const ask=await inventory(source,{unknownDefault:'ask'});
 assert.ok(ask.skipped?.some(item=>item.path===zip&&item.reason==='unknown-ask'));
 assert.deepEqual(ask.unknownExtensions,skip.unknownExtensions);
 const {plans}=await plan(source,[root],{...options,unknownDefault:'other',unknownRules:{dat:null}},metadata);
 const destination=(file:string)=>plans[0]!.entries.find(entry=>entry.source===file)?.destination;
 assert.equal(destination(zip),path.join(root,'Other files','zip','backup.zip'));
 assert.equal(destination(bare),path.join(root,'Other files','README'));
 assert.equal(destination(dat),undefined);
 const explicit=await plan(source,[root],{...options,unknownDefault:'skip',unknownRules:{zip:'Archives'}},metadata);
 assert.equal(explicit.plans[0]!.entries.find(entry=>entry.source===zip)?.destination,path.join(root,'Archives','backup.zip'));
});

test('whitelist system patterns match their vendor layouts and nothing else',()=>{
 const system:[string,string][]=[
  ['2024/111SWART/NC_FLLST.DAT','nikon-file-list'],['NC_FLLST.DAT','nikon-file-list'],
  ['CANONMSC/M0001.CTG','canon-catalog'],['MISC/AUTPRINT.MRK','dpof-print-order'],
  ['PRIVATE/M4ROOT/THMBNL/C0001T01.JPG','sony-xavc-thumbnail'],
  ['CONTENTS/ICON/C0001.BMP','p2-icon'],['CONTENTS/LASTCLIP.TXT','p2-last-clip'],
  ['PRIVATE/AVCHD/BDMV/CLIPINF/00000.CPI','avchd-index'],['PRIVATE/AVCHD/BDMV/PLAYLIST/00000.MPL','avchd-index'],
  ['PRIVATE/AVCHD/BDMV/INDEX.BDM','avchd-index'],['PRIVATE/AVCHD/BDMV/MOVIEOBJ.BDM','avchd-index'],
  ['PRIVATE/AVCHD/BDMV/BACKUP/INDEX.BDM','avchd-index'],['PRIVATE/AVCHD/BDMV/BACKUP/CLIPINF/00000.CPI','avchd-index'],
  ['CONTENTS/CLIPS001/A001C001.CIF','canon-xf-index'],['CONTENTS/CLIPS001/A001C001.SIF','canon-xf-index'],['CONTENTS/INDEX.MIF','canon-xf-index'],
 ];
 for(const [relative,id] of system)assert.equal(knownSystemFile(relative)?.id,id,relative);
 for(const relative of ['notes/data.dat','notes/data.mrk','Photos/C0001T01.JPG','Pictures/ICON/a.bmp','notes/LASTCLIP.TXT','Docs/INDEX.BDM','Docs/a.cif','Docs/INDEX.MIF'])assert.equal(knownSystemFile(relative),undefined,relative);
});

test('a Sony thumbnail JPG is a system file, not a photo; backup still includes it',async t=>{
 const {source,put}=await fixture(t);
 await put('PRIVATE/M4ROOT/THMBNL/C0001T01.JPG');await put('DCIM/100MSDCF/DSC0001.JPG');
 const scan=await inventory(source,{});
 const thumb=byName(scan,'PRIVATE/M4ROOT/THMBNL/C0001T01.JPG')!;
 assert.equal(thumb.system?.id,'sony-xavc-thumbnail');assert.equal(thumb.included,false);assert.equal(thumb.kind,'Other');
 assert.equal(scan.media,1);
 const backup=await inventory(source,{backup:true});
 assert.equal(byName(backup,'PRIVATE/M4ROOT/THMBNL/C0001T01.JPG')?.included,true);
});
