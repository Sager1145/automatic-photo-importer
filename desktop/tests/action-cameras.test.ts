import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inventory} from '../core';
import {metadataFromTags} from '../platform/metadata';
import {mediaKindForPath} from '../media-formats';

async function card(t:test.TestContext,names:string[]){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'action-cam-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const folder=path.join(root,'DCIM','100GOPRO');await fs.mkdir(folder,{recursive:true});
 for(const name of names)await fs.writeFile(path.join(folder,name),name);
 const found=await inventory(root,{});
 return (name:string)=>found.files.find(item=>path.basename(item.path)===name)!;
}

test('a GoPro GL proxy and THM thumbnail travel with their GX/GH video; a lone proxy is still imported',async t=>{
 const file=await card(t,['GX010042.MP4','GL010042.LRV','GX010042.THM','GH020043.MP4','GL020043.LRV','GL010099.LRV']);
 assert.equal(file('GL010042.LRV').companionOf,file('GX010042.MP4').path);
 assert.equal(file('GX010042.THM').companionOf,file('GX010042.MP4').path);
 assert.equal(file('GL020043.LRV').companionOf,file('GH020043.MP4').path,'AVC chapters use GH');
 assert.equal(file('GL010099.LRV').companionOf,undefined);
 assert.equal(file('GL010099.LRV').kind,'Videos');assert.equal(file('GL010099.LRV').included,true,'a proxy without its original is kept as video');
});

test('an Insta360 LRV pairs with the VID of the same shot and lens; both lens files of one shot are kept',async t=>{
 // Insta360 manual: [prefix]_[date]_[time]_[lens 0/1][master 0 / proxy 1]_[sequence].
 const file=await card(t,['VID_20240416_213000_00_001.insv','VID_20240416_213000_10_001.insv','LRV_20240416_213000_01_001.lrv','IMG_20240416_213500_00_002.insp']);
 assert.equal(file('LRV_20240416_213000_01_001.lrv').companionOf,file('VID_20240416_213000_00_001.insv').path);
 for(const name of ['VID_20240416_213000_00_001.insv','VID_20240416_213000_10_001.insv'])assert.equal(file(name).included,true,name);
 assert.equal(file('IMG_20240416_213500_00_002.insp').kind,'Images');
});

test('GoPro, Insta360 and other action-camera files are recognised media',()=>{
 for(const name of ['GOPR0001.JPG','GX010001.MP4','GOPR0001.GPR','GS010001.360'])assert.notEqual(mediaKindForPath(name),'Other',name);
 assert.equal(mediaKindForPath('GOPR0001.GPR'),'RAW');
 assert.equal(mediaKindForPath('GL010001.LRV'),'Videos');
});

test('GoPro videos are named from the GPMF model; Insta360 files without a model fall back to Insta360',()=>{
 assert.equal(metadataFromTags({'GoPro:Model':'HERO12 Black'},{details:false,file:'GX010001.MP4'}).camera,'HERO12 Black');
 assert.equal(metadataFromTags({'IFD0:Make':'Insta360','IFD0:Model':'Insta360 X4'},{details:false,file:'IMG_20240416_213500_00_002.insp'}).camera,'Insta360 X4');
 assert.equal(metadataFromTags({},{details:false,file:'VID_20240416_213000_00_001.insv'}).camera,'Insta360');
 assert.equal(metadataFromTags({},{details:false,file:'clip.mp4'}).camera,undefined);
});
