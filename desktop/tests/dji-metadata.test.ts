import test from 'node:test';
import assert from 'node:assert/strict';
import {metadataFromTags} from '../platform/metadata';

// Tags as ExifTool reports a real Osmo Pocket 3 clip with -G1 -fast and no -ee.
const pocket3={'ItemList:Encoder':'DJI OsmoPocket3','QuickTime:CreateDate':'2026:05:23 17:50:04'};
const routing=(tags:Record<string,unknown>,file:string)=>metadataFromTags(tags,{details:false,file});

test('a DJI clip without a Model tag is named from its ItemList Encoder',()=>{
 assert.equal(routing(pocket3,'DJI_20260524015004_0015_D.MP4').camera,'DJI OsmoPocket3');
 assert.equal(routing(pocket3,'DJI_20260524015004_0015_D.LRF').camera,'DJI OsmoPocket3','the LRF proxy carries the same tags');
});

test('a Model tag still wins, and a software encoder is never a camera name',()=>{
 assert.equal(routing({...pocket3,'Track3:Model':'DJI Osmo Pocket 3'},'DJI_20260524015004_0015_D.MP4').camera,'DJI Osmo Pocket 3');
 assert.equal(routing({'ItemList:Encoder':'Lavf58.76.100'},'clip.mp4').camera,undefined);
});

test('the DJI file name gives the local capture time and the UTC CreateDate gives its offset',()=>{
 assert.equal(routing(pocket3,'DJI_20260524015004_0015_D.MP4').date,'2026-05-24T01:50:04+08:00');
 // The name can trail CreateDate by a second: the recorded instant is kept, shown at the derived offset.
 assert.equal(routing({...pocket3,'QuickTime:CreateDate':'2025:05:15 07:01:02'},'DJI_20250515020101_0001_D.MP4').date,'2025-05-15T02:01:02-05:00');
 assert.equal(routing({...pocket3,'QuickTime:CreateDate':'2026:08:04 16:53:43'},'DJI_20260804125343_0046_D.MP4').date,'2026-08-04T12:53:43-04:00');
});

test('a renamed clip keeps the recorded CreateDate',()=>{
 assert.equal(routing(pocket3,'holiday.mp4').date,'2026-05-23T17:50:04');
});

test('when the name and CreateDate are not a whole offset apart, the name is the local time without an offset',()=>{
 // Some DJI firmware writes CreateDate at the end of the clip: 8 h plus a 30 min 30 s recording.
 assert.equal(routing(pocket3,'DJI_20260524022034_0015_D.MP4').date,'2026-05-24T02:20:34');
 assert.equal(routing(pocket3,'DJI_20260601015004_0015_D.MP4').date,'2026-06-01T01:50:04','the camera clock names the file');
});

test('an Encoder stored in UserData names the camera too',()=>{
 assert.equal(routing({'UserData:Encoder':'DJI OsmoAction5 Pro'},'DJI_20260204004329_0001_D.MP4').camera,'DJI OsmoAction5 Pro');
});

test('without CreateDate the DJI file name supplies the local wall clock',()=>{
 assert.equal(routing({'ItemList:Encoder':'DJI OsmoPocket3'},'DJI_20260524015004_0015_D.MP4').date,'2026-05-24T01:50:04');
});

test('a photo date from EXIF is never replaced by the file name',()=>{
 const photo={'IFD0:Model':'FC3582','ExifIFD:DateTimeOriginal':'2026:05:24 01:50:04'};
 assert.equal(routing(photo,'DJI_20260524095004_0001_D.JPG').date,'2026-05-24T01:50:04');
});

test('older DJI drones write a generic encoder string, which is not a camera name',()=>{
 assert.equal(routing({'ItemList:Encoder':'Dji AVC Encoder'},'DJI_0001.MP4').camera,undefined);
 assert.equal(routing({'ItemList:Encoder':'DJI Mini4 Pro'},'DJI_20240601120000_0001_D.MP4').camera,'DJI Mini4 Pro');
});

test('a CreateDate already in local time stays a wall clock, never labelled UTC',()=>{
 assert.equal(routing({...pocket3,'QuickTime:CreateDate':'2026:05:24 01:50:04'},'DJI_20260524015004_0015_D.MP4').date,'2026-05-24T01:50:04');
});
