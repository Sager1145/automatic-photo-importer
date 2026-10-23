import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {plan} from '../core/index';
import type {Metadata} from '../shared';

const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{}};
// A recording that starts before midnight on 31 January; its second chapter starts in February.
const dates:Record<string,string>={'GX010042.MP4':'2024-01-31T23:50:00Z','GX020042.MP4':'2024-02-01T00:07:00Z','GX030042.MP4':'2024-02-01T00:24:00Z','GX010043.MP4':'2024-02-01T09:00:00Z'};
const metadata=async(file:string):Promise<Metadata>=>({camera:'HERO12 Black',date:dates[path.basename(file)],fields:{}});

test('GoPro chapters of one recording stay together, routed by the first chapter, each keeping its own time',async t=>{
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gopro-chapters-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const card=path.join(base,'card'),folder=path.join(card,'DCIM','100GOPRO'),root=path.join(base,'photobackup');
 await fs.mkdir(folder,{recursive:true});await fs.mkdir(root);
 for(const name of [...Object.keys(dates),'GL020042.LRV'])await fs.writeFile(path.join(folder,name),name);
 const reviewed=(await plan(card,[root],options,metadata)).plans[0]!;
 const entry=(name:string)=>reviewed.entries.find(item=>path.basename(item.source)===name)!;
 const recording=['GX010042.MP4','GX020042.MP4','GX030042.MP4','GL020042.LRV'].map(entry);
 assert.equal(new Set(recording.map(item=>path.dirname(item.destination))).size,1,'one folder for the whole recording');
 assert.match(path.dirname(entry('GX020042.MP4').destination),/202401/);
 assert.equal(new Set(recording.filter(item=>item.kind==='Videos').map(item=>item.family)).size,1,'one family');
 assert.equal(entry('GX020042.MP4').captureTimeMs,Date.parse('2024-02-01T00:07:00Z'),'each chapter keeps its own capture time');
 assert.match(path.dirname(entry('GX010043.MP4').destination),/202402/,'another recording routes by its own time');
 assert.notEqual(entry('GX010043.MP4').family,entry('GX010042.MP4').family);
});

test('a file without capture metadata is filed by the local calendar day it was last modified',async t=>{
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'local-mtime-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const card=path.join(base,'card'),root=path.join(base,'photobackup'),clip=path.join(card,'DCIM','CLIP0001.MP4');
 await fs.mkdir(path.dirname(clip),{recursive:true});await fs.mkdir(root);await fs.writeFile(clip,'video');
 // 23:50 on 31 January where the camera was: in UTC this may already be February.
 const evening=new Date(2024,0,31,23,50);await fs.utimes(clip,evening,evening);
 const reviewed=(await plan(card,[root],options,async()=>({fields:{}}))).plans[0]!;
 assert.match(path.relative(root,reviewed.entries[0]!.destination),/^2024\/202401\//);
});
