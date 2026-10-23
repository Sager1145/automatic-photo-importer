import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import filesystem from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import { metadataFromTags } from '../platform/metadata';
import { classifyVolume, parseLinuxVolumes, parseWindowsVolumes, parseMacPhysicalStores, resolveMacPhysicalIdentity, validateDestination, volumeInfo } from '../platform/volumes';

test('camera and card media are sources; ordinary external SSDs are not', () => {
  assert.equal(classifyVolume({ path: '/Volumes/Card', removable: true }, []).source, true);
  assert.equal(classifyVolume({ path: '/Volumes/SSD', external: true }, []).source, false);
  assert.equal(classifyVolume({ path: '/Volumes/Camera', external: true }, ['dcim']).camera, true);
  assert.equal(classifyVolume({ path: '/Volumes/Camera' }, ['PRIVATE']).camera, true);
});
test('Linux volumes preserve physical disk identity across partitions', () => {
  const volumes = parseLinuxVolumes({blockdevices:[{name:'sdb',path:'/dev/sdb',rm:true,tran:'usb',children:[{path:'/dev/sdb1',mountpoints:['/media/card'],uuid:'card-id',label:'CARD'}]}]});
  assert.deepEqual(volumes.map(v => [v.path,v.volumeId,v.physicalId,v.removable]), [['/media/card','card-id','/dev/sdb',true]]);
});
test('Windows SD cards are removable even with a fixed volume drive type', () => {
  const [card,ssd] = parseWindowsVolumes([{Path:'E:\\',DriveType:3,BusType:'SD',UniqueId:'disk1',VolumeId:'vol1'},{Path:'F:\\',DriveType:3,BusType:'USB',UniqueId:'disk2'}]);
  assert.equal(card.removable,true); assert.equal(ssd.removable,false);
});
test('mechanical and total counters remain distinct and image counts never substitute', () => {
  const result = metadataFromTags({'Nikon:MechanicalShutterCount':9059,'Nikon:ShutterCount':10057,'Nikon:ImageCount':20000});
  assert.equal(result.shutterCount,9059); assert.equal(result.shutterNote,'mechanical');
  assert.equal(metadataFromTags({'Sony:ImageCount':300}).shutterCount,undefined); assert.equal(metadataFromTags({'Sony:ImageCount':300}).shutterNote,'image-count');
  assert.equal(metadataFromTags({'Nikon:ShutterCount':4294965247}).shutterCount,undefined);
  assert.equal(metadataFromTags({'Nikon:ShutterCount':4294967295}).shutterCount,undefined);
  assert.equal(metadataFromTags({'Nikon:ShutterCount':0}).shutterCount,0);
});
test('conflicting counters are reported without selecting an arbitrary value', () => {
  assert.equal(metadataFromTags({'Nikon:ShutterCount':10,'XMP:ShutterCount':11}).shutterCount,undefined);
  assert.equal(metadataFromTags({'Nikon:MechanicalShutterCount':10,'XMP:MechanicalShutterCount':11}).shutterNote,'mechanical-conflict');
  assert.equal(metadataFromTags({'Nikon:ShutterCount':10,'XMP:ShutterCount':11}).shutterNote,'total-conflict');
});
test('Sony ILCE-7M5 requires a corrected identified decoder', () => {
  for(const version of ['13.43',undefined]) assert.equal(metadataFromTags({'EXIF:Model':'ILCE-7M5','Sony:ShutterCount':568,'ExifTool:ExifToolVersion':version}).shutterCount,undefined);
  assert.equal(metadataFromTags({'EXIF:Model':'ILCE-7M5','Sony:ShutterCount':568,'ExifTool:ExifToolVersion':'13.59'}).shutterCount,568);
  assert.equal(metadataFromTags({'EXIF:Model':'ILCE-7M5','XMP:ShutterCount':568,'ExifTool:ExifToolVersion':'13.59'}).shutterCount,undefined);
});
test('capture dates preserve wall-clock date and normalized camera model', () => {
  const result=metadataFromTags({'EXIF:Model':' ILCE-7M5 ','EXIF:DateTimeOriginal':'2026:10:20 00:30:00+09:00'});
  assert.equal(result.date,'2026-10-20T00:30:00+09:00'); assert.equal(result.camera,'ILCE-7M5');
});
test('Sony video embedded XML supplies its camera model without replacing preferred model tags', () => {
  const tags={'XML:DeviceManufacturer':'Sony','XML:DeviceModelName':' ILCE-6700 ','XML:DeviceSerialNo':4294967295,'QuickTime:CreateDate':'2025:06:14 18:20:30+09:00'};
  const result=metadataFromTags(tags);
  assert.equal(result.camera,'ILCE-6700');assert.equal(result.date,'2025-06-14T18:20:30+09:00');
  assert.equal(result.shutterCount,undefined);
  assert.equal(metadataFromTags({...tags,'EXIF:Model':'Preferred Camera'}).camera,'Preferred Camera');
  assert.equal(metadataFromTags({...tags,'QuickTime:CameraModelName':'Preferred Video Camera'}).camera,'Preferred Video Camera');
});
test('Sony XML capture date preserves the local month before QuickTime UTC-like creation time', () => {
  const tags={'XML:DeviceModelName':'ILCE-6700','QuickTime:CreateDate':'2025:06:30 17:20:30','XML:CreationDateValue':'2025:07:01 01:20:30+08:00'};
  assert.equal(metadataFromTags(tags).date,'2025-07-01T01:20:30+08:00');
  assert.equal(metadataFromTags({...tags,'EXIF:DateTimeOriginal':'2025:07:02 03:04:05+09:00'}).date,'2025-07-02T03:04:05+09:00');
  assert.equal(metadataFromTags({...tags,'Composite:SubSecDateTimeOriginal':'2025:07:03 03:04:05.123+09:00'}).date,'2025-07-03T03:04:05.123+09:00');
});
test('EXIF composites retain recorded offsets and fractions without overriding conflicting original dates', () => {
  const tags={'ExifIFD:DateTimeOriginal':'2025:07:01 00:01:02','Composite:SubSecDateTimeOriginal':'2025:07:01 00:01:02.123+08:00'};
  assert.equal(metadataFromTags(tags).date,'2025-07-01T00:01:02.123+08:00');
  assert.equal(metadataFromTags({...tags,'Composite:SubSecDateTimeOriginal':'2025:07:02 00:01:02.123+08:00'}).date,'2025-07-01T00:01:02');
  assert.equal(metadataFromTags({...tags,'ExifIFD:DateTimeOriginal':'2025:07:01 00:01:02+09:00'}).date,'2025-07-01T00:01:02+09:00');
});
test('EXIF original and digitized offset/subsecond fields enrich only their own date family', () => {
  assert.equal(metadataFromTags({'ExifIFD:DateTimeOriginal':'2025:07:01 00:01:02','ExifIFD:OffsetTimeOriginal':'+08:00','ExifIFD:SubSecTimeOriginal':'0045','ExifIFD:OffsetTimeDigitized':'-07:00'}).date,'2025-07-01T00:01:02.0045+08:00');
  assert.equal(metadataFromTags({'ExifIFD:CreateDate':'2025:07:01 00:01:02','ExifIFD:OffsetTimeDigitized':'-07:00','ExifIFD:SubSecTimeDigitized':'123','ExifIFD:OffsetTimeOriginal':'+08:00'}).date,'2025-07-01T00:01:02.123-07:00');
  assert.equal(metadataFromTags({'ExifIFD:CreateDate':'2025:07:01 00:01:02','Composite:SubSecCreateDate':'2025:07:01 00:01:02.456-07:00'}).date,'2025-07-01T00:01:02.456-07:00');
});
test('Apple Keys capture offset wins over a QuickTime date without timezone or inferred computer timezone', () => {
  assert.equal(metadataFromTags({'QuickTime:CreateDate':'2025:06:30 16:01:02','Keys:CreationDate':'2025:07:01 00:01:02+08:00'}).date,'2025-07-01T00:01:02+08:00');
  assert.equal(metadataFromTags({'QuickTime:CreateDate':'2025:06:30 16:01:02','Nikon:TimeZone':480}).date,'2025-06-30T16:01:02');
});
test('blank and invalid grouped values do not hide valid camera models or capture dates', () => {
  const result=metadataFromTags({'IFD0:Model':' ','XMP:Model':42,'QuickTime:Model':{value:'wrong'},'Copy1:Model':'NIKON Z f','ExifIFD:DateTimeOriginal':'2025:02:30 00:00:00','Copy1:DateTimeOriginal':'2025:07:01 00:01:02+25:00','Copy2:DateTimeOriginal':'2025:07:01 00:01:02+0800'});
  assert.equal(result.camera,'NIKON Z f');assert.equal(result.date,'2025-07-01T00:01:02+08:00');
  assert.equal(metadataFromTags({'IFD0:Model':'unknown','XML:DeviceModelName':' ILCE-6700 '}).camera,'ILCE-6700');
});
test('standard decoded model tags support camera brands without treating makers or camera-type codes as models', () => {
  for(const model of ['NIKON Z f','Canon EOS R5','X100VI','DC-S5M2','OM-1','PENTAX K-1','HERO12 Black'])assert.equal(metadataFromTags({'IFD0:Model':` ${model} `}).camera,model);
  // DJI camera codes become the product name (desktop/platform/dji-models.ts).
  assert.equal(metadataFromTags({'IFD0:Model':' FC3582 '}).camera,'DJI Mini 3 Pro');
  assert.equal(metadataFromTags({'IFD0:Make':'Canon','Canon:CameraType':248,'GoPro:DeviceName':'Global Settings','QuickTime:Encoder':'Lavf60'}).camera,undefined);
});
test('primary standard camera model wins over preview and edited metadata regardless of object order', () => {
  assert.equal(metadataFromTags({'IFD1:Model':'Preview Camera','XMP:Model':'Edited Camera','Keys:Model':'Video Camera','IFD0:Copy1:Model':'NIKON Z f'}).camera,'NIKON Z f');
  assert.equal(metadataFromTags({'XMP:Model':'Edited Camera','Keys:Model':'iPhone 16 Pro'}).camera,'iPhone 16 Pro');
});
test('date enrichment keeps grouped offsets local and does not borrow another metadata group’s timezone', () => {
  const result=metadataFromTags({'XMP:DateTimeOriginal':'2025:07:01 00:01:02','ExifIFD:OffsetTimeOriginal':'+08:00','ExifIFD:SubSecTimeOriginal':'456'});
  assert.equal(result.date,'2025-07-01T00:01:02');
  assert.equal(metadataFromTags({'ExifIFD:DateTimeOriginal':'2025:07:01 00:01:02.123+09:00','Composite:SubSecDateTimeOriginal':'2025:07:01 00:01:02.456+09:00'}).date,'2025-07-01T00:01:02.123+09:00');
});
test('Nikon MOV uses its unique recorded string timezone without converting numeric maker fields', () => {
  const tags={'QuickTime:Copy1:CreateDate':'2026:08:02 09:02:03','Nikon:Copy1:TimeZone':'+08:00','Nikon:Model':'NIKON Z f','Nikon:CreateDate':'2026:08:02 17:02:03','Nikon:DateTimeOriginal':'2026:08:02 17:02:03','Nikon:TimeZone':480,'Nikon:DaylightSavings':0};
  assert.equal(metadataFromTags(tags).date,'2026-08-02T17:02:03+08:00');
  assert.equal(metadataFromTags({...tags,'Nikon:DateTimeOriginal':'2026:08:02 17:02:03-04:00'}).date,'2026-08-02T17:02:03-04:00');
  assert.equal(metadataFromTags({...tags,'Nikon:Copy2:TimeZone':'-04:00'}).date,'2026-08-02T17:02:03');
  assert.equal(metadataFromTags({'Nikon:DateTimeOriginal':'2026:08:02 17:02:03','Nikon:TimeZone':480,'Nikon:DaylightSavings':1}).date,'2026-08-02T17:02:03');
});
test('ExifTool copy labels do not separate original timestamps from their EXIF offset fields', () => {
  assert.equal(metadataFromTags({'ExifIFD:Copy1:DateTimeOriginal':'2026:08:02 13:41:58','ExifIFD:OffsetTimeOriginal':'+08:00','ExifIFD:SubSecTimeOriginal':13}).date,'2026-08-02T13:41:58.13+08:00');
  assert.equal(metadataFromTags({'ExifIFD:Copy2:CreateDate':'2026:08:02 13:41:58','ExifIFD:OffsetTimeDigitized':'+08:00','ExifIFD:SubSecTimeDigitized':13}).date,'2026-08-02T13:41:58.13+08:00');
});
test('explicit video content dates outrank generic container original timestamps', () => {
  const container={'QuickTime:DateTimeOriginal':'2026:06:30 16:30:00','QuickTime:CreateDate':'2026:06:30 16:30:00'};
  assert.equal(metadataFromTags({...container,'Keys:CreationDate':'2026:07:01 00:30:00+08:00'}).date,'2026-07-01T00:30:00+08:00');
  assert.equal(metadataFromTags({...container,'XML:CreationDateValue':'2026:07:01 00:30:00+08:00'}).date,'2026-07-01T00:30:00+08:00');
  assert.equal(metadataFromTags({...container,'Keys:CreationDate':'2026:07:01 00:30:00+08:00','ExifIFD:DateTimeOriginal':'2026:07:02 01:02:03-04:00'}).date,'2026-07-02T01:02:03-04:00');
  assert.equal(metadataFromTags({...container,'IFD0:DateTimeOriginal':'2026:07:02 01:02:03-04:00','Keys:CreationDate':'2026:07:01 00:30:00+08:00'}).date,'2026-07-02T01:02:03-04:00');
});
test('unknown-group original dates remain usable but cannot hide explicit content dates', () => {
  const original={'Unknown:DateTimeOriginal':'2026:06:30 16:30:00'};
  assert.equal(metadataFromTags(original).date,'2026-06-30T16:30:00');
  assert.equal(metadataFromTags({...original,'Keys:CreationDate':'2026:07:01 00:30:00+08:00'}).date,'2026-07-01T00:30:00+08:00');
  assert.equal(metadataFromTags({'Nikon:DateTimeOriginal':'2026:07:02 01:02:03+08:00','Keys:CreationDate':'2026:07:01 00:30:00+08:00'}).date,'2026-07-02T01:02:03+08:00');
});
test('conflicting EXIF subsecond copies stay unknown even when a composite selects one', () => {
  const tags={'ExifIFD:DateTimeOriginal':'2026:07:01 00:30:00','ExifIFD:SubSecTimeOriginal':'12','ExifIFD:Copy1:SubSecTimeOriginal':'98','Composite:SubSecDateTimeOriginal':'2026:07:01 00:30:00.12+08:00'};
  assert.equal(metadataFromTags(tags).date,'2026-07-01T00:30:00+08:00');
  assert.equal(metadataFromTags({...tags,'ExifIFD:DateTimeOriginal':'2026:07:01 00:30:00.56+08:00'}).date,'2026-07-01T00:30:00.56+08:00');
});
test('a composite cannot hide conflicting paired EXIF timezone offsets', () => {
  const tags={'ExifIFD:DateTimeOriginal':'2026:07:01 00:30:00','ExifIFD:OffsetTimeOriginal':'+08:00','ExifIFD:Copy1:OffsetTimeOriginal':'-04:00','Composite:SubSecDateTimeOriginal':'2026:07:01 00:30:00.12+08:00'};
  assert.equal(metadataFromTags(tags).date,'2026-07-01T00:30:00.12');
  assert.equal(metadataFromTags({...tags,'ExifIFD:DateTimeOriginal':'2026:07:01 00:30:00+09:00'}).date,'2026-07-01T00:30:00+09:00');
});
test('EXIF composites do not enrich an XMP or unrelated group original merely sharing its wall clock', () => {
  assert.equal(metadataFromTags({'XMP:DateTimeOriginal':'2026:07:01 00:30:00','Composite:SubSecDateTimeOriginal':'2026:07:01 00:30:00.12-04:00'}).date,'2026-07-01T00:30:00');
  assert.equal(metadataFromTags({'Composite:SubSecDateTimeOriginal':'2026:07:01 00:30:00.12-04:00'}).date,'2026-07-01T00:30:00.12-04:00');
});
test('a unique paired EXIF offset takes precedence over a conflicting composite offset', () => {
  assert.equal(metadataFromTags({'ExifIFD:DateTimeOriginal':'2026:07:01 00:30:00','ExifIFD:OffsetTimeOriginal':'+08:00','Composite:SubSecDateTimeOriginal':'2026:07:01 00:30:00+09:00'}).date,'2026-07-01T00:30:00+08:00');
});
test('a unique paired EXIF subsecond takes precedence over a conflicting composite fraction', () => {
  assert.equal(metadataFromTags({'ExifIFD:DateTimeOriginal':'2026:07:01 00:30:00','ExifIFD:SubSecTimeOriginal':'12','Composite:SubSecDateTimeOriginal':'2026:07:01 00:30:00.98+08:00'}).date,'2026-07-01T00:30:00.12+08:00');
});
test('exposure summary uses canonical EXIF lens and exposure values in their recorded units', () => {
  const result=metadataFromTags({'ExifIFD:LensModel':' NIKKOR Z 24-70mm f/2.8 S ','ExifIFD:FNumber':2.8,'ExifIFD:ISO':400,'ExifIFD:ExposureTime':0.008,'ExifIFD:FocalLength':50,'ExifIFD:ExposureCompensation':-0.3333333333});
  assert.deepEqual(result.exposure,{lens:'NIKKOR Z 24-70mm f/2.8 S',aperture:2.8,iso:400,exposureTime:0.008,focalLength:50,exposureCompensation:-0.3333333333});
});
test('exposure summary never labels APEX shutter values or lens IDs as direct capture settings', () => {
  assert.equal(metadataFromTags({'ExifIFD:ShutterSpeedValue':7,'ExifIFD:ApertureValue':5,'Nikon:LensID':147}).exposure,undefined);
  const result=metadataFromTags({'ExifIFD:FNumber':0,'ExifIFD:ExposureTime':-1,'ExifIFD:ISO':'unknown','ExifIFD:FocalLength':Infinity,'ExifIFD:LensModel':147,'ExifIFD:ExposureCompensation':0});
  assert.deepEqual(result.exposure,{exposureCompensation:0});
});
test('exposure summary skips invalid grouped values and prefers standard EXIF settings', () => {
  const result=metadataFromTags({'Nikon:FNumber':4,'ExifIFD:FNumber':'2.8','ExifIFD:ISO':' ','ExifIFD:Copy1:ISO':800,'ExifIFD:LensModel':' ','ExifIFD:Copy1:LensModel':'XF23mmF2 R WR','ExifIFD:ExposureTime':'0.002'});
  assert.deepEqual(result.exposure,{lens:'XF23mmF2 R WR',aperture:2.8,iso:800,exposureTime:0.002});
});
test('destination rejects nested camera folders through symlinks and reports capacity', async () => {
  const root=await mkdtemp(join(tmpdir(),'importer-platform-'));
  try {
    const card=join(root,'card'); await mkdir(card); await mkdir(join(card,'DCIM')); await symlink(card,join(root,'alias'),'dir');
    await assert.rejects(validateDestination(join(root,'alias','nested'),[{id:'card',name:'Card',path:card,transport:'storage',camera:true}]),/source|camera|card/i);
    await validateDestination(join(root,'backup'),[]);
    const info=await volumeInfo(root); assert.equal(info.available,true); assert.ok((info.total??0)>0); assert.ok((info.free??0)>0);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('APFS volumes resolve to their underlying physical drive', () => {
  const map=parseMacPhysicalStores({Containers:[{ContainerReference:'disk5',PhysicalStores:[{DeviceIdentifier:'disk4s2'}]}]});
  assert.equal(map.get('disk5'),'disk4');
});
test('a disappeared macOS mount is unavailable and cannot become a destination folder', {skip:process.platform!=='darwin'}, async () => {
  const target='/Volumes/photo-importer-nonexistent-test-card/nested';
  assert.equal((await volumeInfo(target)).available,false);
  await assert.rejects(validateDestination(target,[]),/mounted|available/i);
});

test('unresolved virtual APFS containers cannot establish physical independence', () => {
  const virtual={path:'/Volumes/SSD',physicalId:'disk5',virtual:true};
  assert.equal(resolveMacPhysicalIdentity(virtual,new Map()),undefined);
  assert.equal(resolveMacPhysicalIdentity(virtual,new Map([['disk5','disk4']])),'disk4');
  assert.equal(resolveMacPhysicalIdentity({path:'/Volumes/exFAT',physicalId:'disk4'},new Map()),'disk4');
});

test('system and internal filesystems do not become camera cards because of PRIVATE folders', () => {
  assert.deepEqual(classifyVolume({path:'/',external:false},['private','DCIM']),{camera:false,source:false});
  assert.deepEqual(classifyVolume({path:'/home',external:false},['PRIVATE']),{camera:false,source:false});
  assert.deepEqual(classifyVolume({path:'C:\\',external:false},['PRIVATE']),{camera:false,source:false});
  assert.deepEqual(classifyVolume({path:'/Volumes/CAMERA',external:true},['PRIVATE']),{camera:true,source:true});
});

test('installer disk images are not automatic sources, while write-protected camera cards remain sources', () => {
  assert.equal(classifyVolume({path:'/Volumes/Installer',removable:true,diskImage:true},[]).source,false);
  assert.equal(classifyVolume({path:'/Volumes/Card',removable:true,readOnly:true},['DCIM']).source,true);
});


test('destination status uses the caller’s volume snapshot for this refresh', async t => {
  const root=await realpath(await mkdtemp(join(tmpdir(),'volume-snapshot-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const info=await volumeInfo(root,[{path:root,volumeId:'refresh-volume',physicalId:'refresh-disk',external:false}]);
  assert.equal(info.available,true);assert.equal(info.volumeId,'refresh-volume');assert.equal(info.physicalId,'refresh-disk');
});

test('an external fixed-media destination is rejected when its camera-layout probe fails', async t => {
  const root=await realpath(await mkdtemp(join(tmpdir(),'volume-probe-failure-')));
  const platform=Object.getOwnPropertyDescriptor(process,'platform')!;
  t.after(async()=>{t.mock.restoreAll();syncBuiltinESMExports();Object.defineProperty(process,'platform',platform);await rm(root,{recursive:true,force:true});});
  // Exercise the same unreadable-layout fallback without probing real mounted media.
  Object.defineProperty(process,'platform',{value:'linux',configurable:true});
  t.mock.method(filesystem,'readdir',async()=>{throw Object.assign(new Error('Directory access denied'),{code:'EACCES'});});
  syncBuiltinESMExports();
  await assert.rejects(validateDestination(join(root,'backup'),[],{volumes:[{path:root,volumeId:'fixed-card',external:true,removable:false}]}),/could not inspect|could not check|layout|access/i);
});

test('a successfully inspected ordinary external SSD remains a valid destination', async t => {
  const root=await realpath(await mkdtemp(join(tmpdir(),'volume-probe-success-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const info=await validateDestination(join(root,'backup'),[],{volumes:[{path:root,volumeId:'external-ssd',external:true,removable:false}]});
  assert.equal(info.available,true);assert.equal(info.volumeId,'external-ssd');
});

test('a remembered destination accepts only the explicitly selected volume', async t => {
  const root=await realpath(await mkdtemp(join(tmpdir(),'volume-identity-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const volumes=[{path:root,volumeId:'volume-a',external:false}];
  assert.equal((await validateDestination(root,[],{volumes,identity:'volume-a'})).volumeId,'volume-a');
  await assert.rejects(validateDestination(root,[],{volumes,identity:'volume-b'}),/changed/);
  await assert.rejects(validateDestination(root,[],{volumes,identity:''}),/identified/);
});

test('routing metadata skips inspector work with identical camera/date normalization', () => {
  const fixtures:Record<string,unknown>[]=[
    {'IFD1:Model':'Preview','IFD0:Copy1:Model':'NIKON Z f','ExifIFD:Copy2:DateTimeOriginal':'2026:08:02 13:41:58','ExifIFD:OffsetTimeOriginal':'+08:00','ExifIFD:SubSecTimeOriginal':13,'Composite:SubSecDateTimeOriginal':'2026:08:02 13:41:58.13+08:00'},
    {'XML:DeviceModelName':'ILCE-6700','XML:CreationDateValue':'2025:07:01 00:30:00+08:00','QuickTime:DateTimeOriginal':'2025:06:30 16:30:00'},
    {'Keys:Model':'iPhone 16 Pro','Keys:CreationDate':'2025:07:01 00:30:00-04:00','QuickTime:CreateDate':'2025:07:01 04:30:00'},
    {'Nikon:DateTimeOriginal':'2026:08:02 17:02:03','Nikon:TimeZone':480,'Nikon:Copy1:TimeZone':'+08:00'},
    {'ExifIFD:DateTimeOriginal':'2026:07:01 00:30:00','ExifIFD:OffsetTimeOriginal':'+08:00','ExifIFD:Copy1:OffsetTimeOriginal':'-04:00','Composite:SubSecDateTimeOriginal':'2026:07:01 00:30:00.12+08:00'},
    {'XMP:DateTimeOriginal':'2026:07:01 00:30:00','Composite:SubSecDateTimeOriginal':'2026:07:01 00:30:00.12-04:00'},
  ];
  for(const fixture of fixtures){
    const tags={...fixture,'ExifIFD:ISO':400,'Nikon:ShutterCount':0,'Maker:Details':{nested:['a','b']}};
    const rich=metadataFromTags(tags),routing=metadataFromTags(tags,{details:false});
    assert.deepEqual(routing,{...rich,fields:{}},'both reads go through the one interpreter');
    assert.deepEqual(rich.exposure,{iso:400});assert.equal(rich.shutterCount,0);
    assert.equal(rich.fields['Maker:Details.nested'],'["a","b"]');
    assert.deepEqual(metadataFromTags(tags,{details:true}),rich);
  }
});

test('destination capacity status does not enumerate camera layouts, but destination validation still does', async t => {
  const root=await realpath(await mkdtemp(join(tmpdir(),'volume-capacity-')));
  const platform=Object.getOwnPropertyDescriptor(process,'platform')!;
  t.after(async()=>{t.mock.restoreAll();syncBuiltinESMExports();Object.defineProperty(process,'platform',platform);await rm(root,{recursive:true,force:true});});
  Object.defineProperty(process,'platform',{value:'linux',configurable:true});
  const probe=t.mock.method(filesystem,'readdir',async()=>{throw Object.assign(new Error('Directory access denied'),{code:'EACCES'});});
  syncBuiltinESMExports();
  const snapshot=[{path:root,volumeId:'capacity-volume',physicalId:'capacity-disk',external:true}];
  const status=await volumeInfo(root,snapshot);
  assert.equal(status.available,true);assert.equal(probe.mock.callCount(),0);assert.ok((status.total??0)>0);
  assert.equal(Object.hasOwn(status,'camera'),false);
  await assert.rejects(validateDestination(root,[],{volumes:snapshot}),/inspect this volume/);
  assert.equal(probe.mock.callCount(),1);
});

test('Android phone videos are named from their QuickTime Keys model',()=>{
  assert.equal(metadataFromTags({'Keys:AndroidMake':'Google','Keys:AndroidModel':'Pixel 8 Pro'},{details:false}).camera,'Pixel 8 Pro');
});

test('Sony bodies that record only ShutterCount2 or ShutterCount3 still report a count',()=>{
  assert.equal(metadataFromTags({'IFD0:Model':'ILCE-7M3','Sony:ShutterCount2':12345}).shutterCount,12345);
  assert.equal(metadataFromTags({'IFD0:Model':'ILCE-7RM3','Sony:ShutterCount3':678}).shutterCount,678);
});

test('the duplicate fingerprint takes its exposure from the summary values, standard EXIF first',()=>{
  const tags={'XMP:ISO':100,'ExifIFD:ISO':400,'XMP:FNumber':0,'ExifIFD:FNumber':2.8,'ExifIFD:ExposureTime':0.004,'ExifIFD:ExposureCompensation':-0.3};
  const {fingerprint,exposure}=metadataFromTags(tags,{details:false});
  assert.deepEqual(exposure,{iso:400,aperture:2.8,exposureTime:0.004,exposureCompensation:-0.3});
  assert.deepEqual({iso:fingerprint?.iso,aperture:fingerprint?.aperture,exposureTime:fingerprint?.exposureTime,exposureCompensation:fingerprint?.exposureCompensation},{iso:'400',aperture:'2.8',exposureTime:'0.004',exposureCompensation:'-0.3'});
});
