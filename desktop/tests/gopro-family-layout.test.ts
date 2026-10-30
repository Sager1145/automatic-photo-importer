import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {plan} from '../core/index';
import type {Metadata} from '../shared';

const metadata=async(file:string):Promise<Metadata>=>/\.THM$/i.test(file)?{fields:{}}:{camera:'HERO11 Black',date:'2024-03-05T10:00:00Z',fields:{}};

for(const layout of ['format','type-format','video-root'] as const) {
 test(`GoPro MP4, LRV and THM land together in the ${layout} layout`,async t=>{
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gopro-family-')));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const card=path.join(base,'card'),folder=path.join(card,'DCIM','100GOPRO'),root=path.join(base,'photobackup'),videos=path.join(base,'videos');
  await fs.mkdir(folder,{recursive:true});await fs.mkdir(root);await fs.mkdir(videos);
  for(const name of ['GX010005.MP4','GL010005.LRV','GL010005.THM'])await fs.writeFile(path.join(folder,name),name);
  const result=await plan(card,[root],{backup:false,template:'{year}/{yyyymm}/{camera}',layout,unknownRules:{},...(layout==='video-root'?{videoRoots:[videos]}:{})},metadata),reviewed=result.plans;
  const entries=reviewed.flatMap(item=>[...item.entries,...(item.videos?.entries??[])]);
  assert.equal(entries.length,3);
  assert.equal(new Set(entries.map(item=>path.dirname(item.destination))).size,1,entries.map(item=>item.destination).join('\n'));
  assert.equal(new Set(entries.map(item=>item.family)).size,1);
 });
}
