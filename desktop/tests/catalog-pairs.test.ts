import test from 'node:test';
import assert from 'node:assert/strict';
import {openCatalog} from '../catalog/store';
import {library,record} from './catalog-fixtures';
import type {CatalogQuery,CatalogRecord,Filter} from '../catalog/types';

const q=(filters:Filter[]=[],extra:Partial<CatalogQuery>={}):CatalogQuery=>({libraryId:library.libraryId,filters,sort:{field:'name',direction:'asc'},limit:50,combinePairs:true,...extra});
const shot=(captureRaw:string,camera='Nikon')=>({metadataStatus:'ready' as const,camera,cameraKey:camera.toLowerCase(),captureRaw,captureDay:'2024-01-31',captureYear:2024,captureMonth:1,iso:400});
const jpeg=(id:string,relativePath:string,values=shot('2024:01:31 23:59:00.12-05:00')):CatalogRecord=>record(id,relativePath,{mediaKind:'JPEG',extension:'jpg',values});
async function setup(){
 const c=openCatalog(':memory:');await c.configure([library]);
 const records=[
  record('raw1','day/DSC_0001.NEF',{values:shot('2024:01:31 23:59:00.47-05:00')}),jpeg('jpg1','day/DSC_0001.JPG'),
  // Same name, another capture: EXIF says these are different photos.
  record('raw2','day/DSC_0002.NEF',{values:shot('2024:01:31 23:59:10-05:00')}),jpeg('jpg2','day/DSC_0002.JPG',shot('2024:02:01 08:00:00-05:00')),
  // Same name and time from another camera.
  record('raw3','day/DSC_0003.NEF',{values:shot('2024:01:31 23:59:20-05:00')}),jpeg('jpg3','day/DSC_0003.JPG',shot('2024:01:31 23:59:20-05:00','Canon')),
  // A HEIF with a DNG, as phones write them; and a RAW alone.
  record('raw4','day/IMG_0004.DNG',{extension:'dng',values:shot('2024:01:31 23:59:30-05:00')}),record('heif4','day/IMG_0004.HEIC',{mediaKind:'HEIF',extension:'heic',values:shot('2024:01:31 23:59:30-05:00')}),
  record('raw5','day/DSC_0005.NEF',{values:shot('2024:01:31 23:59:40-05:00')}),
  // Same name and time in another folder is not a pair.
  jpeg('jpg6','other/DSC_0005.JPG',shot('2024:01:31 23:59:40-05:00')),
 ];
 await c.apply(records.map(record=>({kind:'upsert' as const,libraryId:library.libraryId,record,mutationRevision:1})));
 return c;
}

test('a RAW and its JPEG or HEIF show as one file only when folder, name, capture time and camera agree',async()=>{const c=await setup();try{
 const page=await c.query(q());
 assert.deepEqual(page.rows.map(row=>row.fileId),['jpg1','jpg2','raw2','jpg3','raw3','jpg6','raw5','heif4']);
 assert.equal(page.total,8);
 assert.deepEqual(page.rows.find(row=>row.fileId==='jpg1')!.pairedRaw,{fileId:'raw1',name:'DSC_0001.NEF',extension:'nef',size:'9007199254740993'});
 assert.equal(page.rows.find(row=>row.fileId==='heif4')!.pairedRaw?.fileId,'raw4');
 assert.equal(page.rows.find(row=>row.fileId==='jpg2')!.pairedRaw,undefined);
 const separate=await c.query(q([],{combinePairs:false}));assert.equal(separate.total,10);assert.ok(separate.rows.every(row=>!row.pairedRaw));
}finally{await c.close();}});

test('counts follow the combined files, except where the two members differ',async()=>{const c=await setup();try{
 const cameras=await c.facets(q(),'camera');
 assert.deepEqual(cameras.rows.map(row=>[row.value,row.count]),[['canon',1],['nikon',7]]);
 const formats=await c.facets(q(),'format');
 assert.deepEqual(Object.fromEntries(formats.rows.map(row=>[row.value,row.count])),{dng:1,heic:1,jpg:4,nef:4});
 const raws=await c.query(q([{kind:'values',field:'format',values:['nef','dng']}]));assert.equal(raws.total,5,'a format filter shows every RAW');
 const folders=await c.directories({...q(),parentPath:''});assert.deepEqual(folders.rows.map(row=>[row.name,row.count]),[['day',7],['other',1]]);
 const search=await c.query(q([],{nameContains:'.nef'}));assert.equal(search.total,4,'a search the JPEG does not match still finds the RAW');
}finally{await c.close();}});
