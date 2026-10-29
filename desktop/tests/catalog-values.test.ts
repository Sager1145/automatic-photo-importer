import test from 'node:test';
import assert from 'node:assert/strict';
import {formatNumericValue,photographicStops,parseNumericInput} from '../catalog/values';

test('photographic inputs retain physical capture units',()=>{
  assert.equal(parseNumericInput('exposureSeconds','1/125'),0.008);
  assert.equal(parseNumericInput('exposureSeconds','2s'),2);
  assert.equal(parseNumericInput('exposureSeconds','0.008s'),0.008);
  assert.equal(parseNumericInput('fNumber','f/2.8'),2.8);
  assert.equal(parseNumericInput('focalLengthMm','24mm'),24);
  assert.equal(parseNumericInput('iso','800'),800);
});

test('invalid numbers are rejected and ranges use inclusive ordered endpoints',async()=>{
  const {parseRange}=await import('../catalog/values');
  for(const field of ['exposureSeconds','fNumber','focalLengthMm','iso'] as const)
    for(const input of ['0','-1','NaN','Infinity','1e999','oops',''])
      assert.throws(()=>parseNumericInput(field,input),/positive/);
  for(const input of ['1/0','1/-125','1/125mm'])assert.throws(()=>parseNumericInput('exposureSeconds',input));
  assert.throws(()=>parseNumericInput('iso','f/800'));
  assert.deepEqual(parseRange('exposureSeconds','1/1000','1/125'),{min:0.001,max:0.008});
  assert.deepEqual(parseRange('fNumber','','f/5.6'),{max:5.6});
  assert.deepEqual(parseRange('iso','800',''),{min:800});
  assert.deepEqual(parseRange('iso','  ',' '),{});
  assert.deepEqual(parseRange('iso','800','800'),{min:800,max:800});
  assert.throws(()=>parseRange('iso','800','400'),/minimum/i);
});

test('catalog values keep trusted raw capture values and distinguish missing metadata from errors',async()=>{
  const {catalogValues}=await import('../catalog/values');
  const values=catalogValues({date:'2026-01-01T00:15:00+09:00',camera:'  CAFE\u0301   Camera  ',make:' ACME ',
    exposure:{lens:'  Prime  35mm ',focalLength:35,aperture:2.8,iso:800,exposureTime:0.008},fields:{}});
  assert.deepEqual(values,{metadataStatus:'ready',captureRaw:'2026-01-01T00:15:00+09:00',captureZone:'+09:00',captureYear:2026,captureMonth:1,captureDay:'2026-01-01',
    make:'ACME',makeKey:'acme',camera:'CAFÉ Camera',cameraKey:'café camera',lens:'Prime 35mm',lensKey:'prime 35mm',focalLengthMm:35,fNumber:2.8,iso:800,exposureSeconds:0.008});
  assert.notEqual(catalogValues({fields:{},exposure:{exposureTime:0.0083}}).exposureSeconds,values.exposureSeconds);
  assert.deepEqual(catalogValues({fields:{},exposure:{iso:0,focalLength:-1,aperture:Infinity,exposureTime:NaN}}),{metadataStatus:'ready'});
  assert.deepEqual(catalogValues({fields:{}}),{metadataStatus:'ready'});
  assert.deepEqual(catalogValues({fields:{'ExifTool:Error':'Unreadable file'},exposure:{iso:800}}),{metadataStatus:'error',metadataError:'Unreadable file'});
  assert.equal(catalogValues({fields:{'ExifTool:Warning':'Minor issue'}}).metadataStatus,'ready');
  assert.equal(catalogValues({fields:{},date:'2026-02-30T12:00:00Z'}).captureDay,undefined);
});

test('numeric buckets count every observed boundary exactly once, with a closed final edge',async()=>{
  const {numericBuckets}=await import('../catalog/values');
  const buckets=numericBuckets('focalLengthMm',20,150);
  assert.deepEqual(buckets,[{min:20,max:24,maxInclusive:false},{min:24,max:35,maxInclusive:false},{min:35,max:50,maxInclusive:false},
    {min:50,max:85,maxInclusive:false},{min:85,max:135,maxInclusive:false},{min:135,max:150,maxInclusive:true}]);
  for(const value of [20,24,35,50,85,135,150])assert.equal(buckets.filter(bucket=>value>=bucket.min!&&(value<bucket.max!||(bucket.maxInclusive&&value===bucket.max))).length,1);
  assert.deepEqual(numericBuckets('iso',800,800),[{min:800,max:800,maxInclusive:true}]);
  assert.deepEqual(numericBuckets('iso',0,800),[]);
  assert.deepEqual(numericBuckets('iso',800,400),[]);
  assert.deepEqual(numericBuckets('fNumber',1.8,2.8),[{min:1.8,max:2,maxInclusive:false},{min:2,max:2.8,maxInclusive:true}]);
  assert.deepEqual(numericBuckets('exposureSeconds',0.0005,0.008),[{min:0.0005,max:0.001,maxInclusive:false},{min:0.001,max:0.002,maxInclusive:false},{min:0.002,max:0.004,maxInclusive:false},{min:0.004,max:0.008,maxInclusive:true}]);
});
test('catalog name sort keys share natural number ordering for scans and moves',async()=>{const {catalogNameSortKey}=await import('../catalog/values');assert.ok(catalogNameSortKey('File2.NEF')<catalogNameSortKey('file10.NEF'));assert.equal(catalogNameSortKey('CAFÉ.NEF'),catalogNameSortKey('Cafe\u0301.nef'));});

test('photographic labels round-trip nominal stops and preserve intermediate recorded exposure values',()=>{
 assert.equal(formatNumericValue('fNumber',2.8),'f/2.8');assert.equal(formatNumericValue('iso',400),'ISO 400');assert.equal(formatNumericValue('exposureSeconds',1/125),'1/125 s');assert.equal(formatNumericValue('exposureSeconds',2),'2 s');
 for(const field of ['fNumber','iso','exposureSeconds'] as const)for(const stop of photographicStops[field])assert.equal(parseNumericInput(field,formatNumericValue(field,stop)),stop);
 assert.equal(formatNumericValue('fNumber',1.8),'f/1.8');assert.equal(formatNumericValue('iso',125),'ISO 125');assert.equal(formatNumericValue('exposureSeconds',1/160),'1/160 s');assert.equal(formatNumericValue('exposureSeconds',.0083),'0.0083 s');
 assert.equal(photographicStops.exposureSeconds.includes(1/60),true);assert.equal(photographicStops.exposureSeconds.includes(.0166667),false);
});

test('reciprocal shutter labels tolerate decoder precision while keeping distinct recorded values',()=>{
 const decoded=0.01666666667;
 assert.equal(formatNumericValue('exposureSeconds',decoded),'1/60 s');
 assert.equal(formatNumericValue('exposureSeconds',.0083),'0.0083 s');
 assert.equal(formatNumericValue('exposureSeconds',1/160),'1/160 s');
});
