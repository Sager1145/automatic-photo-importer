import test from 'node:test';
import assert from 'node:assert/strict';
import { inferCameraHints, analyzeSourceCameras } from '../source-cameras';
import type { Inventory, InventoryFile, Source } from '../shared';

const source: Source = { id:'card', name:'NIKON Z6III', path:'/Volumes/NIKON Z6III', transport:'storage' };
function file(relative:string, kind:InventoryFile['kind'], size:number, companionOf?:string):InventoryFile {
  return {path:`/Volumes/card/${relative}`, relative, kind, size, included:true, ...(companionOf ? {companionOf} : {})};
}
function inventory(files:InventoryFile[]):Inventory {
  return {files, media:0, companions:0, unknown:0, bytes:0, unknownExtensions:{}, elapsedMs:0};
}

test('drive, extension and specific camera layouts give hints without treating generic folders as camera evidence',()=>{
  const scan = inventory([
    file('DCIM/100NIKON/a.NEF','RAW',10),
    file('PRIVATE/M4ROOT/CLIP/a.MP4','Videos',20),
    file('NIKON001.DSC','Other',3),
  ]);
  assert.deepEqual(inferCameraHints(source,scan),[
    {name:'Nikon Z6III',evidence:'drive-name'},
    {name:'Nikon',evidence:'file-type'},
    {name:'Sony',evidence:'camera-layout'},
    {name:'Nikon',evidence:'camera-layout'},
  ]);
  assert.deepEqual(inferCameraHints({...source,name:'Untitled'},inventory([
    file('DCIM/photo.JPG','JPEG',10),file('PRIVATE/movie.MP4','Videos',20),
  ])),[]);
});

test('all media metadata confirms multiple cameras with normalized names and exact file and byte totals',async()=>{
  const scan = inventory([
    file('a.NEF','RAW',10),file('b.JPG','JPEG',21),
    file('clip.MP4','Videos',35),file('unknown.PNG','Images',7),
    file('a.XMP','Other',300,'/Volumes/card/a.NEF'),
    file('payload.bin','Other',900),
    file('companion.JPG','JPEG',500,'/Volumes/card/a.NEF'),
  ]);
  const reads:string[] = [];
  const updates:{status:string;checked:number;models:{name:string;files:number;bytes:number}[]}[] = [];
  const result = await analyzeSourceCameras(source,scan,async path=>{
    reads.push(path);
    const camera = path.endsWith('a.NEF') ? '  Nikon   Z6III ' : path.endsWith('b.JPG') ? 'nikon z6iii' : path.endsWith('clip.MP4') ? 'Sony ILCE-7M4' : undefined;
    return {camera,fields:{}};
  },undefined,summary=>updates.push(summary));
  assert.deepEqual(reads,['/Volumes/card/a.NEF','/Volumes/card/b.JPG','/Volumes/card/clip.MP4','/Volumes/card/unknown.PNG']);
  assert.equal(result.status,'complete');
  assert.equal(result.checked,4); assert.equal(result.total,4); assert.equal(result.unknown,1);
  assert.deepEqual(result.models,[{name:'Nikon Z6III',files:2,bytes:31},{name:'Sony ILCE-7M4',files:1,bytes:35}]);
  assert.equal(updates[0].status,'reading'); assert.equal(updates[0].checked,0); assert.deepEqual(updates[0].models,[]);
  assert.equal(updates.at(-1)?.status,'complete');
});

test('a branded drive and RAW format do not become confirmed cameras when metadata has no model',async()=>{
  const result = await analyzeSourceCameras(source,inventory([file('a.NEF','RAW',10)]),async()=>({fields:{}}));
  assert.deepEqual(result.hints,[{name:'Nikon Z6III',evidence:'drive-name'},{name:'Nikon',evidence:'file-type'}]);
  assert.deepEqual(result.models,[]); assert.equal(result.unknown,1); assert.equal(result.checked,1); assert.equal(result.status,'complete');
});

test('stopping analysis retains the completed camera results without reading more files',async()=>{
  const controller = new AbortController();
  let calls = 0;
  const result = await analyzeSourceCameras(source,inventory([
    file('a.NEF','RAW',10),file('b.ARW','RAW',20),file('c.MP4','Videos',30),
  ]),async()=>{
    calls += 1; controller.abort(); return {camera:'Nikon Z6III',fields:{}};
  },controller.signal);
  assert.equal(calls,1); assert.equal(result.status,'stopped'); assert.equal(result.checked,1); assert.equal(result.total,3); assert.equal(result.unknown,0);
  assert.deepEqual(result.models,[{name:'Nikon Z6III',files:1,bytes:10}]);
});

test('unreadable files are unknown and reported while later camera metadata is still analyzed',async()=>{
  const result = await analyzeSourceCameras(source,inventory([
    file('damaged.NEF','RAW',10),file('good.ARW','RAW',20),file('unlabeled.JPG','JPEG',5),
  ]),async path=>{
    if (path.endsWith('damaged.NEF')) throw new Error('Unreadable EXIF');
    return {camera:path.endsWith('good.ARW') ? 'Sony ILCE-7M4' : 'Unknown Camera',fields:{}};
  });
  assert.equal(result.status,'error'); assert.equal(result.checked,3); assert.equal(result.total,3); assert.equal(result.unknown,2);
  assert.equal(result.error,'1 media file could not be read.');
  assert.deepEqual(result.models,[{name:'Sony ILCE-7M4',files:1,bytes:20}]);
});

test('analysis checks beyond the first batch and progress snapshots retain their earlier state',async()=>{
  const scan = inventory(Array.from({length:17},(_,index)=>file(`${index}.JPG`,'JPEG',2)));
  const updates:{checked:number;models:{name:string;files:number;bytes:number}[]}[] = [];
  let reads = 0;
  const result = await analyzeSourceCameras(source,scan,async()=>{
    reads += 1; return {camera:reads === 17 ? 'Canon EOS R5' : 'Nikon Z6III',fields:{}};
  },undefined,summary=>updates.push(summary));
  assert.equal(reads,17); assert.equal(result.checked,17); assert.equal(result.total,17);
  assert.deepEqual(result.models,[{name:'Canon EOS R5',files:1,bytes:2},{name:'Nikon Z6III',files:16,bytes:32}]);
  assert.ok(updates.length > 2 && updates.length < 8);
  assert.equal(updates[1].checked,8);
  assert.deepEqual(updates[1].models,[{name:'Nikon Z6III',files:8,bytes:16}]);
});

test('an already stopped scan returns its hints without reading files',async()=>{
  const controller = new AbortController(); controller.abort();
  const result = await analyzeSourceCameras(source,inventory([file('a.NEF','RAW',10)]),async()=>{throw new Error('Must not read');},controller.signal);
  assert.equal(result.status,'stopped'); assert.equal(result.checked,0); assert.equal(result.unknown,0);
  assert.deepEqual(result.models,[]); assert.ok(result.hints.some(hint=>hint.evidence === 'drive-name'));
});

test('vendor-specific RAW extensions suggest makers rather than invented camera models',()=>{
  const scan = inventory([
    file('a.NRW','RAW',1),file('b.SR2','RAW',1),file('c.CRW','RAW',1),
    file('d.RAF','RAW',1),file('e.ORF','RAW',1),file('f.RW2','RAW',1),file('g.PEF','RAW',1),
    file('ignored.CR3','Other',1),file('sidecar.ARW','RAW',1,'/Volumes/card/a.NRW'),
  ]);
  assert.deepEqual(inferCameraHints({...source,name:'Untitled'},scan),[
    {name:'Nikon',evidence:'file-type'},{name:'Sony',evidence:'file-type'},
    {name:'Canon',evidence:'file-type'},{name:'Fujifilm',evidence:'file-type'},
    {name:'Olympus',evidence:'file-type'},{name:'Panasonic',evidence:'file-type'},{name:'Pentax',evidence:'file-type'},
  ]);
});


test('drive-name hints preserve single-letter model names and volume suffixes',()=>{
  assert.deepEqual(inferCameraHints({...source,name:'NIKON Z F   1  '},inventory([])),[
    {name:'Nikon Z F 1',evidence:'drive-name'},
  ]);
  assert.deepEqual(inferCameraHints({...source,name:'NIKON Z FC'},inventory([])),[
    {name:'Nikon Z FC',evidence:'drive-name'},
  ]);
});

test('lens metadata is tallied per normalized lens name with a count of files without a lens',async()=>{
 const scan=inventory([file('a.NEF','RAW',10),file('b.NEF','RAW',20),file('c.ARW','RAW',30),file('clip.MP4','Videos',40)]);
 const lenses:Record<string,string|undefined>={'a.NEF':'NIKKOR Z 40mm f/2','b.NEF':'nikkor  z 40mm F/2 ','c.ARW':'FE 24-70mm F2.8 GM II','clip.MP4':undefined};
 const result=await analyzeSourceCameras(source,scan,async file=>{const lens=lenses[file.split('/').pop()!];return {camera:'Camera',fields:{},...(lens?{exposure:{lens}}:{})};});
 assert.deepEqual(result.lenses,[{name:'NIKKOR Z 40mm f/2',files:2,bytes:30},{name:'FE 24-70mm F2.8 GM II',files:1,bytes:30}]);
 assert.equal(result.noLens,1);
});
