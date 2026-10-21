import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ExifTool} from 'exiftool-vendored';
import {metadata,closeMetadata,routingEntries,primeRouting} from '../platform/metadata';

async function scratch(t:test.TestContext){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'routing-metadata-'));
 t.after(async()=>{await closeMetadata();await fs.rm(root,{recursive:true,force:true});});return root;
}

test('routing extraction avoids optional all-tag work while the inspector retains it',async t=>{
 const root=await scratch(t),file=path.join(root,'photo.JPG');await fs.writeFile(file,'only the external decoder is stubbed');
 const args:string[][]=[];
 t.mock.method(ExifTool.prototype,'readRaw',async(_file:string,options:{readArgs:string[]})=>{
  args.push(options.readArgs);return {'IFD0:Model':'NIKON Z f','ExifIFD:DateTimeOriginal':'2025:06:26 13:50:35','ExifIFD:OffsetTimeOriginal':'+08:00','IFD0:Software':'Adobe Lightroom Classic 15.2.1','ExifIFD:LensModel':'NIKKOR Z 40mm f/2','Nikon:ShutterCount':1234};
 });
 assert.deepEqual(await metadata(file,{preview:false,details:false}),{camera:'NIKON Z f',date:'2025-06-26T13:50:35+08:00',edited:true,fields:{},exposure:{lens:'NIKKOR Z 40mm f/2'}});
 const rich=await metadata(file,{preview:false});assert.equal(rich.camera,'NIKON Z f');assert.ok(Object.keys(rich.fields).length>0);assert.equal(rich.shutterCount,'1,234');
 const routing=args[0]!;
 assert.deepEqual(routing.slice(0,4),['-G1:4','-a','-n','-fast'],'Routing keeps groups, duplicates and decoded numbers, and skips trailer scans');
 for(const tag of ['-Model','-DeviceModelName','-DateTimeOriginal','-OffsetTimeOriginal','-CreationDateValue','-TimeZone','-Software','-HistorySoftwareAgent','-LensModel','-Error'])assert.ok(routing.includes(tag),`routing requests ${tag}`);
 assert.ok(!routing.includes('-api')&&!routing.some(arg=>/ShutterCount/i.test(arg)),'Routing never requests all tags or shutter counters');
 assert.deepEqual(args[1],['-G1:4','-a','-n','-api','RequestAll=3'],'Full inspection must keep all-tag extraction');
});

test('routing metadata is reused until the file changes',async t=>{
 const root=await scratch(t),file=path.join(root,'photo.JPG');await fs.writeFile(file,'first');
 let reads=0;
 t.mock.method(ExifTool.prototype,'readRaw',async()=>{reads++;return {'IFD0:Model':`Camera ${reads}`};});
 assert.equal((await metadata(file,{preview:false,details:false})).camera,'Camera 1');
 assert.equal((await metadata(file,{preview:false,details:false})).camera,'Camera 1');
 assert.equal(reads,1);
 await fs.writeFile(file,'second version');
 assert.equal((await metadata(file,{preview:false,details:false})).camera,'Camera 2');
 await metadata(file,{preview:false});assert.equal(reads,3,'Full inspection always reads');
});

test('real disposable image preserves camera, zoned capture time and editor routing without RequestAll',async t=>{
 const root=await scratch(t),file=path.join(root,'photo.PNG');
 await fs.copyFile(path.resolve('Assets/AppIcon-preview.png'),file);
 const writer=new ExifTool({maxProcs:1});
 try{await writer.write(file,{Model:'NIKON Z f',DateTimeOriginal:'2025:06:26 13:50:35',OffsetTimeOriginal:'+08:00',Software:'Adobe Lightroom Classic 15.2.1'});}finally{await writer.end();}
 const routing=await metadata(file,{preview:false,details:false}),rich=await metadata(file,{preview:false});
 assert.deepEqual({camera:routing.camera,date:routing.date,edited:routing.edited},{camera:'NIKON Z f',date:'2025-06-26T13:50:35+08:00',edited:true});
 assert.deepEqual({camera:routing.camera,date:routing.date,edited:routing.edited},{camera:rich.camera,date:rich.date,edited:rich.edited});
});

function atom(type:string,payload:Buffer){const header=Buffer.alloc(8);header.writeUInt32BE(payload.length+8);header.write(type,4,'latin1');return Buffer.concat([header,payload]);}

test('real disposable MP4 retains Sony XML model and capture offset without RequestAll',async t=>{
 const root=await scratch(t),file=path.join(root,'clip.MP4');
 const xml=Buffer.from('<?xml version="1.0"?><NonRealTimeMeta xmlns="urn:schemas-professionalDisc:nonRealTimeMeta:ver.2.00"><Device manufacturer="Sony" modelName="ILCE-6700"/><CreationDate value="2025-07-01T01:20:30+08:00"/></NonRealTimeMeta>');
 const ftyp=atom('ftyp',Buffer.from('isom\0\0\0\0isomiso2','latin1'));
 // Sony's top-level Meta box has the version header; the embedded XML box
 // is parsed through ExifTool's normal QuickTime XML decoder.
 const meta=atom('meta',Buffer.concat([Buffer.alloc(4),atom('xml ',xml)]));
 await fs.writeFile(file,Buffer.concat([ftyp,meta]));
 const routing=await metadata(file,{preview:false,details:false}),rich=await metadata(file,{preview:false});
 assert.deepEqual({camera:routing.camera,date:routing.date},{camera:'ILCE-6700',date:'2025-07-01T01:20:30+08:00'});
 assert.deepEqual({camera:routing.camera,date:routing.date,edited:routing.edited},{camera:rich.camera,date:rich.date,edited:rich.edited});
});

test('metadata read during a scan is handed to the import and used only while the file is unchanged',async t=>{
 const root=await scratch(t),file=path.join(root,'handoff.JPG');await fs.writeFile(file,'scanned');
 let reads=0;
 t.mock.method(ExifTool.prototype,'readRaw',async()=>{reads++;return {'IFD0:Model':`Camera ${reads}`};});
 await metadata(file,{preview:false,details:false});
 const entries=routingEntries();assert.ok(entries.some(([key])=>key.startsWith(file+'\0')));
 primeRouting(entries.map(([key,value])=>[key,{...value,camera:'From scan'}]));
 assert.equal((await metadata(file,{preview:false,details:false})).camera,'From scan');assert.equal(reads,1);
 await fs.writeFile(file,'changed after the scan');
 assert.equal((await metadata(file,{preview:false,details:false})).camera,'Camera 2');
});
