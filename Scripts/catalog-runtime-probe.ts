// Explicit manual integration probe: bundle then run with Electron, never with host Node.
import {app,utilityProcess} from 'electron';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startCatalog,createCatalogClient} from '../desktop/catalog/process';
import type {CatalogLibrary,CatalogRecord,CatalogQuery} from '../desktop/catalog/types';

const timeout=setTimeout(()=>{console.error('Catalog runtime probe timed out');app.exit(2);},20000);
app.whenReady().then(async()=>{
 const temporary=await mkdtemp(path.join(os.tmpdir(),'catalog-runtime-'));
 try{
  const workerPath=process.argv[2];
  assert.ok(workerPath,'Pass the bundled catalog-worker.cjs path');
  const databasePath=path.join(temporary,'catalog.sqlite');
  const library:CatalogLibrary={libraryId:'runtime',volumeId:'runtime-volume',trustedVolumeId:true,relativeRoot:'photos',name:'Runtime',role:'photos',online:true,rulesScope:'rules',revision:0};
  const record:CatalogRecord={fileId:'photo',libraryId:'runtime',relativePath:'相机/测试.NEF',parentPath:'相机',name:'测试.NEF',nameSortKey:'测试.nef',nameInitial:'其他',stat:{size:'9007199254740993',mtimeNs:'1793250000123456789',ctimeNs:'1793250000123456788',ino:'99'},mediaKind:'RAW',extension:'nef',values:{metadataStatus:'ready',captureRaw:'2024:01:31 23:59:59-05:00',captureDay:'2024-01-31',captureYear:2024,captureMonth:1,iso:800,focalLengthMm:35},metadataVersion:1,placement:{status:'unchecked',actualRelativePath:'相机/测试.NEF',rulesScope:'rules'},routingMetadata:{fields:{},date:'2024:01:31 23:59:59-05:00',contentId:'live-photo'}};
  const query:CatalogQuery={libraryId:'runtime',filters:[{kind:'range',field:'iso',max:800}],sort:{field:'name',direction:'asc'},limit:1};
  let catalog=startCatalog(databasePath,{workerPath});
  await catalog.configure([library]);
  const run=await catalog.beginScan('runtime',['']);
  await catalog.ingest(run,[record]);
  await catalog.endScan(run,'complete');
  assert.equal((await catalog.query(query)).rows[0].name,'测试.NEF');
  assert.equal((await catalog.facets(query,'captureYearMonth')).rows[0].value,'2024-01');
  assert.equal((await catalog.query({...query,filters:[{kind:'ranges',field:'iso',ranges:[{max:200,maxInclusive:false},{min:800,max:1600,maxInclusive:false}],blockId:'iso'}]})).total,1);
  assert.equal((await catalog.directories({...query,filters:[]})).rows[0].relativePath,'相机');
  await assert.rejects(catalog.query({...query,limit:0}),{code:'invalidQuery'});
  await catalog.close();
  catalog=startCatalog(databasePath,{workerPath});
  assert.deepEqual(await catalog.records('runtime',['相机/测试.NEF']),[record]);
  assert.equal((await catalog.status('runtime')).dirty,true);
  await catalog.close();
  const child=utilityProcess.fork(workerPath,[databasePath],{stdio:'ignore'});
  const crashed=createCatalogClient(child);
  await crashed.configure([library]);
  await crashed.beginScan('runtime',['']);
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  child.kill();await exited;
  assert.equal((await crashed.status('runtime')).state,'error');
  await assert.rejects(crashed.records('runtime',['相机/测试.NEF']),/exited/);
  await crashed.close();
  catalog=startCatalog(databasePath,{workerPath});
  assert.equal((await catalog.status('runtime')).dirty,true);
  assert.equal((await catalog.status('runtime')).state,'idle');
  assert.equal((await catalog.file('runtime','photo'))?.stat.mtimeNs,'1793250000123456789');
  await catalog.close();
  console.log(JSON.stringify({ok:true,electron:process.versions.electron,node:process.versions.node,sqlite:process.versions.sqlite,checks:['bundled worker CRUD','Unicode/stat/raw routing metadata roundtrip','SQL facets/directories/range OR','invalid query code','restart persistence','crash dirty recovery']}));
 }finally{clearTimeout(timeout);await rm(temporary,{recursive:true,force:true});}
}).then(()=>app.exit(0),error=>{console.error(error);clearTimeout(timeout);app.exit(1);});
