import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ExifTool} from 'exiftool-vendored';
import {metadata,closeMetadata,setRoutingBatch} from '../platform/metadata';

/** A 134-byte JPEG; ExifTool writes the EXIF under test into it. */
const JPEG=Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=','base64');
const variants:Record<string,unknown>[]=[
  {Make:'NIKON CORPORATION',Model:'NIKON Z f',DateTimeOriginal:'2025:06:26 13:50:35',OffsetTimeOriginal:'+08:00',SubSecTimeOriginal:'42',LensModel:'NIKKOR Z 40mm f/2',Software:'Adobe Lightroom Classic 15.2.1'},
  {Make:'Apple',Model:'iPhone 15 Pro',DateTimeOriginal:'2024:12:31 23:59:59',CreateDate:'2024:12:31 23:59:59',LensModel:'iPhone 15 Pro back camera 6.765mm f/1.78'},
  {Make:'DJI',Model:'FC3682',DateTimeOriginal:'2023:01:02 03:04:05'},
  {Model:'Unknown',CreateDate:'2020:02:29 12:00:00'},
  {},
];

async function build(root:string,names:string[]) {
  const tool=new ExifTool({maxProcs:1});
  try {
    for(const [index,name] of names.entries()) {
      const file=path.join(root,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JPEG);
      const tags=variants[index%variants.length]!;
      if(Object.keys(tags).length)await tool.write(file,tags as never,{writeArgs:['-overwrite_original']});
    }
  } finally {await tool.end();}
}

test('batched routing reads give exactly the results of reading each file alone',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'routing-batch-'));
  t.after(async()=>{setRoutingBatch(16);await closeMetadata();await fs.rm(root,{recursive:true,force:true});});
  const names=Array.from({length:40},(_,index)=>`IMG_${String(index).padStart(3,'0')}${index%7===0?' é 写真':''}.JPG`);
  // The same files in two folders, so neither read is served from the other's cache entry.
  await build(path.join(root,'alone'),names);
  for(const name of names)await fs.mkdir(path.join(root,'batched'),{recursive:true}).then(()=>fs.copyFile(path.join(root,'alone',name),path.join(root,'batched',name)));
  await fs.writeFile(path.join(root,'alone','BROKEN.JPG'),'not an image at all');await fs.copyFile(path.join(root,'alone','BROKEN.JPG'),path.join(root,'batched','BROKEN.JPG'));
  const all=[...names,'BROKEN.JPG'];
  const read=(folder:string)=>Promise.all(all.map(name=>metadata(path.join(root,folder,name),{details:false})));

  setRoutingBatch(1);
  const alone=await read('alone');
  setRoutingBatch(16);
  const requests:number[]=[];
  const original=ExifTool.prototype.enqueueTask;
  t.mock.method(ExifTool.prototype,'enqueueTask',function(this:ExifTool,task:()=>{args:string[]}){requests.push(1);return original.call(this,task as never);});
  const batched=await read('batched');

  assert.deepEqual(batched,alone,'batching must not change what is extracted');
  assert.ok(alone.some(item=>item.camera==='NIKON Z f')&&alone.some(item=>item.exposure?.lens==='NIKKOR Z 40mm f/2')&&alone.some(item=>item.edited),'fixtures carry the tags under test');
  assert.ok(alone.at(-1)!.camera===undefined,'the unreadable file stays unread in both modes');
  assert.ok(requests.length<all.length/2,`${all.length} files took ${requests.length} ExifTool requests`);
});

test('routing reads of one file at the same time share one request and the cache serves the next',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'routing-share-'));
  t.after(async()=>{await closeMetadata();await fs.rm(root,{recursive:true,force:true});});
  await build(root,['one.JPG']);
  let calls=0;
  const original=ExifTool.prototype.readRaw as (...args:unknown[])=>Promise<unknown>;
  t.mock.method(ExifTool.prototype,'readRaw',function(this:ExifTool,...args:unknown[]){calls++;return original.apply(this,args);});
  const file=path.join(root,'one.JPG');
  const results=await Promise.all([1,2,3].map(()=>metadata(file,{details:false})));
  await metadata(file,{details:false});
  assert.equal(calls,1);
  assert.deepEqual(results[0],results[2]);
});
