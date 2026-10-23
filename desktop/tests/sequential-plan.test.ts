import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {plan} from '../core/index';
import {allocateDestinations,destinationEntries} from '../core/allocation';
import type {Metadata} from '../shared';

const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2024-02-03T12:00:00Z',fields:{}});

test('fill-first names each file only against the files that land on its own disk',async t=>{
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'photo-sequential-')));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const source=path.join(base,'card'),roots=[path.join(base,'one'),path.join(base,'two')];
  for(const folder of [path.join(source,'DCIM/100'),path.join(source,'DCIM/101'),...roots])await fs.mkdir(folder,{recursive:true});
  // Same name, different bytes: on one disk the second would go to Conflicts/. Disk 1 has room for the first only.
  await fs.writeFile(path.join(source,'DCIM/100/A.JPG'),'first file');
  await fs.writeFile(path.join(source,'DCIM/101/A.JPG'),'two');
  const {plans}=await plan(source,roots,{...options,fillFirst:()=>20},metadata);
  assert.deepEqual(allocateDestinations(plans,[20,100],'sequential'),[20,6]);
  const placed=plans.map(item=>destinationEntries(item).map(entry=>[path.relative(source,entry.source),path.relative(item.root,entry.destination)]));
  assert.deepEqual(placed,[[['DCIM/100/A.JPG','2024/202402/Sony A7/JPEG/A.JPG']],[['DCIM/101/A.JPG','2024/202402/Sony A7/JPEG/A.JPG']]]);
});
