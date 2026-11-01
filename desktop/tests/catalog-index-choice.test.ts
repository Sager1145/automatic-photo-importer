import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openCatalog} from '../catalog/store';
import {library,record} from './catalog-fixtures';
import type {CatalogQuery,CatalogRecord,Filter} from '../catalog/types';

// Filtered pages and counts read their matches through an index holding the filtered columns (and the RAW + JPEG pairing
// test's columns) and walk the sorted index when matches are many. These choices must only change speed, never results.
const q=(filters:Filter[],extra:Partial<CatalogQuery>={}):CatalogQuery=>({libraryId:library.libraryId,filters,sort:{field:'name',direction:'asc'},limit:7,...extra});
function shot(i:number):CatalogRecord{
 const raw=i%3===0,ext=raw?'nef':['jpg','heic'][i%2]!,captureRaw=`2024:0${1+i%4}:0${1+i%7} 10:00:${String(i%60).padStart(2,'0')}`;
 return record(`f${i}`,`${2023+i%2}/${String(Math.floor(i/2)).padStart(3,'0')}.${ext.toUpperCase()}`,{mediaKind:raw?'RAW':ext==='jpg'?'JPEG':'HEIF',extension:ext,values:i%11===0?{metadataStatus:'ready'}:{metadataStatus:'ready',camera:`Camera ${i%3}`,cameraKey:`camera ${i%3}`,captureRaw,captureYear:2023+i%2,captureMonth:1+i%4,captureDay:`${2023+i%2}-0${1+i%4}-0${1+i%7}`,fNumber:[1.4,2,2.8,4,5.6,8][i%6],iso:[100,400,1600][i%3]}});
}
async function all(c:ReturnType<typeof openCatalog>,query:CatalogQuery){const ids:string[]=[];let cursor:string|undefined,total=0;do{const page=await c.query({...query,...(cursor?{cursor}:{})});total=page.total;ids.push(...page.rows.map(r=>r.fileId));cursor=page.nextCursor;}while(cursor);return {ids,total};}

test('filtered pages and counts give the same files whichever index reads them',async()=>{
 const records=Array.from({length:240},(_,i)=>shot(i));
 const c=openCatalog(':memory:');await c.configure([library]);
 try{
  await c.apply(records.map(r=>({kind:'upsert' as const,libraryId:library.libraryId,record:r,mutationRevision:1})));
  const shapes:Filter[][]=[
   [{kind:'range',field:'fNumber',min:2,max:5.6},{kind:'values',field:'camera',values:['Camera 0','Camera 1']},{kind:'values',field:'captureYear',values:[2024]}],
   [{kind:'ranges',field:'fNumber',ranges:[{min:1.4,max:2},{min:5.6,max:8}]}],
   [{kind:'values',field:'captureYear',values:[2024]},{kind:'values',field:'captureYearMonth',values:['2024-01','2024-02']},{kind:'values',field:'camera',values:['Camera 1']}],
   [{kind:'values',field:'camera',values:['Camera 2'],orMissing:true},{kind:'values',field:'format',values:['jpg','nef']}],
   [{kind:'values',field:'iso',values:[100,1600]}],
   [{kind:'missing',field:'camera'}],
   [{kind:'ranges',field:'fNumber',ranges:[]}],
  ];
  // The expected files, worked out here from the records themselves.
  const value=(r:CatalogRecord,field:string):unknown=>field==='captureYearMonth'?(r.values.captureYear?`${r.values.captureYear}-${String(r.values.captureMonth).padStart(2,'0')}`:undefined):field==='format'?r.extension:field==='camera'?r.values.cameraKey:(r.values as unknown as Record<string,unknown>)[field];
  const matches=(r:CatalogRecord,f:Filter)=>{if(f.kind==='placement')return true;const v=value(r,f.field);if(f.kind==='missing')return v===undefined;if(f.kind==='values')return f.values.map(x=>typeof x==='string'?x.toLowerCase():x).includes(v as string)||!!f.orMissing&&v===undefined;const ranges=f.kind==='range'?[f]:f.ranges;return typeof v==='number'&&ranges.some(range=>(range.min===undefined||v>=range.min)&&(range.max===undefined||v<=range.max));};
  for(const filters of shapes)for(const sort of [{field:'name',direction:'asc'},{field:'fNumber',direction:'desc'},{field:'captured',direction:'asc'}] as const){
   const expected=records.filter(r=>filters.every(f=>matches(r,f))).map(r=>r.fileId).sort();
   const found=await all(c,q(filters,{sort}));
   assert.equal(found.total,expected.length,JSON.stringify(filters));assert.deepEqual([...found.ids].sort(),expected,JSON.stringify(filters));assert.equal(new Set(found.ids).size,found.ids.length,'no file twice across pages');
   const paired=await all(c,q(filters,{sort,combinePairs:true}));assert.equal(paired.total,paired.ids.length);assert.ok(paired.ids.every(id=>expected.includes(id)));
  }
 }finally{await c.close();}
});

test('a catalog from before keeps working: its filter indexes are rebuilt once with the pairing columns',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'catalog-indexes-'));const file=path.join(dir,'library.sqlite');
 try{
  let c=openCatalog(file);await c.configure([library]);await c.apply(Array.from({length:30},(_,i)=>({kind:'upsert' as const,libraryId:library.libraryId,record:shot(i),mutationRevision:1})));
  const query=q([{kind:'values',field:'camera',values:['Camera 1']},{kind:'values',field:'captureYear',values:[2024]}]);const before=await all(c,query);await c.close();
  const sql=new DatabaseSync(file);sql.exec('DROP INDEX files_facet_cameraKey;CREATE INDEX files_facet_cameraKey ON files(libraryId,cameraKey,metadataStatus,camera,fileId) WHERE missing=0 AND companionOf IS NULL');sql.close();
  c=openCatalog(file);assert.deepEqual(await all(c,query),before);await c.close();
  const read=new DatabaseSync(file,{readOnly:true});
  const schema=read.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='files' AND sql IS NOT NULL").all() as {type:string;name:string;sql:string}[];read.close();
  const indexes=schema.filter(entry=>entry.type==='index'&&(entry.name.startsWith('files_facet_')||entry.name==='files_photo_context'));
  assert.ok(indexes.length>=15);for(const index of indexes)assert.match(index.sql,/captureKey,?(fileId)?\) WHERE missing=0 AND companionOf IS NULL$/,index.name);
  // The stress test's slow shapes seek the index that holds every column they test (no table row is read for a match). (Planned on a copy of the schema:
  // on Windows a file connection that ran EXPLAIN keeps the database's -wal file open past close.)
  const check=new DatabaseSync(':memory:');for(const entry of [...schema].sort((a,b)=>a.type===b.type?0:a.type==='table'?-1:1))check.exec(entry.sql);
  const plan=(statement:string,...args:(string|number)[])=>(check.prepare('EXPLAIN QUERY PLAN '+statement).all(...args) as {detail:string}[]).map(row=>row.detail).join(' | ');
  assert.match(plan("SELECT count(*) FROM files INDEXED BY files_photo_context WHERE libraryId=? AND missing=0 AND companionOf IS NULL AND fNumber>=? AND fNumber<=? AND cameraKey IN (?,?) AND captureYear=?",library.libraryId,2,5.6,'camera 0','camera 1',2024),/USING (COVERING )?INDEX files_photo_context \(libraryId=\? AND cameraKey=\? AND captureYear=\?\)/);
  assert.match(plan("SELECT count(*) FROM files INDEXED BY files_facet_fNumber WHERE libraryId=? AND missing=0 AND companionOf IS NULL AND ((fNumber>=? AND fNumber<=?) OR (fNumber>=? AND fNumber<=?)) AND NOT (files.mediaKind='RAW' AND files.captureKey IS NOT NULL)",library.libraryId,1.4,2,5.6,8),/USING (COVERING )?INDEX files_facet_fNumber/);
  check.close();
 }finally{await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});
