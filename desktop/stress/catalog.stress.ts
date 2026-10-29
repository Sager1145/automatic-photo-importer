import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openCatalog} from '../catalog/store';
import {catalogNameSortKey} from '../catalog/values';
import type {CatalogRecord,CatalogQuery,CatalogLibrary,Catalog} from '../catalog/types';

const primaryCount=Number(process.env.CATALOG_STRESS_COUNT??100000);
const rounds=20;
const library:CatalogLibrary={libraryId:'stress-library',volumeId:'stress-volume',trustedVolumeId:true,relativeRoot:'photobackup',name:'Disposable stress library',role:'photos',online:true,rulesScope:'stress-rules',revision:0};
function record(i:number,companion=false):CatalogRecord {
 const name=`IMG_${String(i).padStart(7,'0')}.${companion?'xmp':['jpg','png','nef','heic'][i%4]}`;
 const parentPath=`${2020+i%5}/${String(1+Math.floor(i/5)%12).padStart(2,'0')}/Camera-${i%8}`;
 return {fileId:`${companion?'companion':'primary'}-${i}`,libraryId:library.libraryId,relativePath:parentPath+'/'+name,parentPath,name,nameSortKey:catalogNameSortKey(name),nameInitial:'I',stat:{size:'12345678',mtimeNs:'1700000000000000000',ctimeNs:'1700000000000000000',ino:String(i+1)},mediaKind:companion?'Other':(['JPEG','Images','RAW','HEIF'] as const)[i%4]!,extension:companion?'xmp':['jpg','png','nef','heic'][i%4]!,...(companion?{companionOf:`primary-${i}`} :{}),values:{metadataStatus:'ready',captureYear:2020+i%5,captureMonth:1+Math.floor(i/5)%12,captureDay:`${2020+i%5}-${String(1+Math.floor(i/5)%12).padStart(2,'0')}-${String(1+Math.floor(i/60)%28).padStart(2,'0')}`,camera:`Camera ${i%8}`,cameraKey:`camera ${i%8}`,lens:`Lens ${i%12}`,lensKey:`lens ${i%12}`,focalLengthMm:[24,35,50,85,135][i%5],fNumber:[1.4,2,2.8,4,5.6,8][Math.floor(i/7)%6],iso:[100,200,400,800,1600][Math.floor(i/11)%5],exposureSeconds:[1/1000,1/250,1/60,1/15][Math.floor(i/13)%4]},metadataVersion:1,placement:{status:i%3===0?'misplaced':'inPlace',actualRelativePath:parentPath+'/'+name,rulesScope:'stress-rules'}};
}
const percentile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]!;

test('100k primary catalog records: bounded real SQLite pages, facets and measured latency',async(t)=>{
 assert.ok(Number.isSafeInteger(primaryCount)&&primaryCount>=1000);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'photo-catalog-stress-'));
 const database=path.join(root,'library.sqlite');let catalog:Catalog=openCatalog(database);
 t.after(async()=>{await catalog.close().catch(()=>{});});
 const report:{[key:string]:unknown}={root,primaryCount,companions:Math.ceil(primaryCount/5),node:process.version,platform:process.platform,architecture:process.arch,coldDefinition:'Catalog closed/reopened before each first request; OS disk cache is not purged.',rounds,exifCalls:0,fixtureKind:'Typed catalog records; no media parsing, EXIF throughput or renderer claims.'};
 await catalog.configure([library]);const run=await catalog.beginScan(library.libraryId,['']);
 const start=performance.now();let buffer:CatalogRecord[]=[];
 for(let i=0;i<primaryCount;i++){
  buffer.push(record(i));if(i%5===0)buffer.push(record(i,true));
  if(buffer.length>=499){await catalog.ingest(run,buffer);buffer=[];}
 }
 if(buffer.length)await catalog.ingest(run,buffer);
 await catalog.endScan(run,'complete');const ingestMs=performance.now()-start;
 report.ingest={ms:ingestMs,primaryPerSecond:primaryCount/(ingestMs/1000),recordsPerSecond:(primaryCount+Math.ceil(primaryCount/5))/(ingestMs/1000)};
 assert.equal((await catalog.status(library.libraryId)).total,primaryCount);
 const base:CatalogQuery={libraryId:library.libraryId,filters:[],sort:{field:'name',direction:'asc'},limit:200};
 const scoped:CatalogQuery={...base,filters:[{kind:'range',field:'fNumber',min:2,max:5.6},{kind:'values',field:'camera',values:['Camera 0','Camera 1']},{kind:'values',field:'captureYear',values:[2024]}]};
 const jobs:{name:string;run:()=>Promise<unknown>}[]=[
  {name:'files-all-first',run:async()=>{const p=await catalog.query(base);assert.equal(p.total,primaryCount);assert.equal(p.rows.length,200);assert.equal(p.rows[0]?.companionCount,1);return p;}},
  {name:'files-combination',run:()=>catalog.query(scoped)},
  {name:'files-numeric-or',run:()=>catalog.query({...base,filters:[{kind:'ranges',field:'fNumber',ranges:[{min:1.4,max:2},{min:5.6,max:8}]}]})},
  {name:'files-numeric-sort',run:()=>catalog.query({...base,sort:{field:'fNumber',direction:'desc'}})},
  {name:'facet-camera-all',run:()=>catalog.facets(base,'camera')},
  {name:'facet-aperture-combination',run:()=>catalog.facets(scoped,'fNumber')},
  {name:'facet-date-month',run:()=>catalog.facets(base,'captureYearMonth')},
  {name:'directories-root',run:()=>catalog.directories({...base,parentPath:''})},
 ];
 const measurements=[];
 for(const job of jobs){
  await catalog.close();catalog=openCatalog(database);let now=performance.now();await job.run();const coldMs=performance.now()-now;
  const warmMs=[];for(let i=0;i<rounds;i++){now=performance.now();await job.run();warmMs.push(performance.now()-now);}
  measurements.push({name:job.name,coldMs,warmP50Ms:percentile(warmMs,.5),warmP95Ms:percentile(warmMs,.95),warmMs});
 }
 const first=await catalog.query(base),second=await catalog.query({...base,cursor:first.nextCursor});assert.ok(first.nextCursor);assert.equal(second.rows.length,200);assert.ok(!first.rows.some(a=>second.rows.some(b=>a.fileId===b.fileId)));
 report.measurements=measurements;
 await catalog.close();catalog=openCatalog(database);
 const sql=new DatabaseSync(database,{readOnly:true});
 const plans=[
  ['first-page',"SELECT fileId FROM files WHERE libraryId=? AND missing=0 AND companionOf IS NULL ORDER BY nameSortKey,fileId LIMIT 201",[library.libraryId]],
  ['combined-filter',"SELECT count(*) FROM files WHERE libraryId=? AND missing=0 AND companionOf IS NULL AND fNumber>=? AND fNumber<=? AND cameraKey IN (?,?) AND captureYear=?",[library.libraryId,2,5.6,'camera 0','camera 1',2024]],
  ['camera-facet',"SELECT cameraKey,count(*) FROM files WHERE libraryId=? AND missing=0 AND companionOf IS NULL AND cameraKey IS NOT NULL GROUP BY cameraKey ORDER BY cameraKey LIMIT 201",[library.libraryId]],
 ] as const;
 report.explain=plans.map(([name,statement,args])=>({name,sql:statement,plan:sql.prepare('EXPLAIN QUERY PLAN '+statement).all(...args)}));sql.close();
 report.databaseBytes=(await fs.stat(database)).size;report.memory=process.memoryUsage();
 const output=process.env.CATALOG_STRESS_REPORT??path.join(root,'report.json');await fs.writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({report:output,ingest:report.ingest,databaseBytes:report.databaseBytes,measurements:measurements.map(({warmMs,...row})=>row),explain:report.explain},null,2));
 assert.ok(measurements.every(m=>m.coldMs<=1000),`Cold request target exceeded; see ${output}`);
 assert.ok(measurements.every(m=>m.warmP95Ms<=200),`Warm p95 target exceeded; see ${output}`);
});
