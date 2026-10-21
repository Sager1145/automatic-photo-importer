/** CPU-only normalization benchmark. No media files or ExifTool processes are read. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {metadataFromTags} from '../desktop/platform/metadata.ts';

const repository=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output=path.join(repository,'build/architecture-review/metadata-benchmark.json');
const iterations=200,warmup=20,rounds=3;
const results=[];
for(const generatedTags of [1000,5000]){
  const tags:Record<string,unknown>=Object.fromEntries(Array.from({length:generatedTags},(_,index)=>[
    `Maker:Tag${index}`,{Value:index,Text:`value${index}`},
  ]));
  Object.assign(tags,{
    'ExifIFD:DateTimeOriginal':'2026:07:01 00:30:00',
    'ExifIFD:OffsetTimeOriginal':'+08:00',
    'IFD0:Model':'NIKON Z f',
    'ExifIFD:ISO':400,
  });
  const rich=metadataFromTags(tags),routing=metadataFromTags(tags,{details:false});
  assert.deepEqual(routing,{camera:rich.camera,date:rich.date,fields:{}});
  assert.equal(rich.date,'2026-07-01T00:30:00+08:00');
  assert.equal(rich.camera,'NIKON Z f');
  assert.equal(rich.fields['Maker:Tag0.Value'],0);
  assert.deepEqual(rich.exposure,{iso:400});
  const richMs:number[]=[],routingMs:number[]=[];
  for(const details of [true,false])for(let index=0;index<warmup;index++)metadataFromTags(tags,{details});
  for(let round=0;round<rounds;round++){
    // Alternate measurement order to reduce a fixed warm-cache/order bias.
    for(const details of round%2?[false,true]:[true,false]){
      const started=performance.now();
      for(let index=0;index<iterations;index++)metadataFromTags(tags,{details});
      (details?richMs:routingMs).push(performance.now()-started);
    }
  }
  const median=(values:number[])=>[...values].sort((left,right)=>left-right)[Math.floor(values.length/2)]!;
  results.push({generatedTags,totalTags:Object.keys(tags).length,parityPassed:true,
    rich:{samplesMs:richMs,medianMs:median(richMs)},
    routing:{samplesMs:routingMs,medianMs:median(routingMs)},
    normalizationSpeedup:median(richMs)/median(routingMs)});
}
const report={command:'node --import tsx Scripts/measure-metadata.mts',
  measuredAt:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,
  scope:'Current metadataFromTags rich versus details:false; generated nested tags only. No ExifTool, media I/O, filesystem scanning or end-to-end throughput measurement. No historical baseline comparison.',
  iterations,warmup,rounds,results};
await mkdir(path.dirname(output),{recursive:true});
await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
console.log(`Report: ${output}`);
