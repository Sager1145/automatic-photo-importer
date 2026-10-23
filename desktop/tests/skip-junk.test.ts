import test from 'node:test';
import assert from 'node:assert/strict';
import fsDefault from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { inventory, ignoredName } from '../core/inventory';
import { AppleDoubleCleaner } from '../core/appledouble';

async function fixture(t:test.TestContext){
 const base=await fsDefault.realpath(await fsDefault.mkdtemp(path.join(os.tmpdir(),'skip-junk-')));
 t.after(()=>fsDefault.rm(base,{recursive:true,force:true}));
 const folder=path.join(base,'DCIM');await fsDefault.mkdir(folder);
 for(let i=0;i<10;i++)await fsDefault.writeFile(path.join(folder,`IMG_${i}.JPG`),'x'+i);
 await fsDefault.writeFile(path.join(folder,'.DS_Store'),'junk');
 for(let i=0;i<999;i++)await fsDefault.writeFile(path.join(folder,`._IMG_${i}.JPG`),'junk');
 for(const name of ['.Spotlight-V100','.fseventsd','.Trashes','.TemporaryItems','.DocumentRevisions-V100','$RECYCLE.BIN','System Volume Information'])await fsDefault.mkdir(path.join(base,name));
 await fsDefault.writeFile(path.join(base,'.Trashes','inside.JPG'),'x');
 await fsDefault.writeFile(path.join(base,'Thumbs.db'),'j');await fsDefault.writeFile(path.join(base,'desktop.ini'),'j');
 return {base,folder};
}
const junkPath=(file:unknown)=>/(^|[\\/])(\._[^\\/]*|\.DS_Store|Thumbs\.db|desktop\.ini|\.Spotlight-V100|\.fseventsd|\.Trashes|\.TemporaryItems|\.DocumentRevisions-V100|\$RECYCLE\.BIN|System Volume Information)([\\/]|$)/.test(String(file));

for(const backup of [false,true])test(`listing never stats OS junk by name (backup ${backup})`,async t=>{
 const {base}=await fixture(t);
 const seen:string[]=[];
 for(const method of ['lstat','stat','realpath'] as const){
  const real=(fsDefault[method] as (...a:any[])=>Promise<unknown>).bind(fsDefault);
  t.mock.method(fsDefault,method,((file:unknown,...rest:unknown[])=>{seen.push(String(file));return real(file,...rest);}) as any);
 }
 syncBuiltinESMExports();
 try{
  const scan=await inventory(base,{backup});
  assert.ok(seen.length>0,'the spy is active');
  assert.deepEqual(seen.filter(junkPath),[],'no metadata call on junk');
  assert.equal(scan.files.length,10);
  assert.ok(scan.files.every(file=>!junkPath(file.path)&&!file.system));
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('every junk name is ignored by name',()=>{
 for(const name of ['.DS_Store','._a','.Spotlight-V100','.fseventsd','.Trashes','.TemporaryItems','.DocumentRevisions-V100','Thumbs.db','desktop.ini','$RECYCLE.BIN','System Volume Information'])assert.ok(ignoredName(name),name);
 assert.ok(!ignoredName('IMG_1.JPG'));
});

test('the AppleDouble cleaner still sees ._ files',async t=>{
 const {base,folder}=await fixture(t);
 const cleaner=new AppleDoubleCleaner();
 await cleaner.sweep(base,[folder]);
 // The fixture's ._ files are not real AppleDouble data, so each is looked at and kept.
 assert.equal(cleaner.report.kept,999);
});
