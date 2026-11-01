import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { unlinkEntry, rmdirEntry, alternateName, sameEntryAlternate, type EntryOps } from '../core/paths';

const NFC='Éclair でんしゃ 한글.JPG'.normalize('NFC'),NFD=NFC.normalize('NFD');
/** Fake volume paths in this system's spelling: alternateName joins with path.sep. */
const V=path.sep+'v'+path.sep,D=V+'d'+path.sep;
const enoent=()=>Object.assign(new Error('ENOENT'),{code:'ENOENT'});
/** A volume that, like exFAT under macOS, removes only the NFC spelling: `present` maps a path to its dev:ino and kind. */
function fake(present:Record<string,{ino:bigint;dir?:boolean}>,removable:(p:string)=>boolean=p=>p===p.normalize('NFC')){
  const calls:string[]=[];
  const ops:EntryOps={
    lstat:async p=>{const e=present[p];if(!e)throw enoent();return {dev:1n,ino:e.ino,isDirectory:()=>!!e.dir};},
    unlink:async p=>{calls.push('unlink '+p);if(!present[p]||!removable(p))throw enoent();delete present[p];},
    rmdir:async p=>{calls.push('rmdir '+p);if(!present[p]||!removable(p))throw enoent();delete present[p];},
  };
  return {ops,calls,present};
}

test('plain unlink and rmdir succeed on a real folder',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'entry-removal-'));
  try{
    await fs.mkdir(path.join(dir,'sub'));await fs.writeFile(path.join(dir,'sub','a.txt'),'x');
    await unlinkEntry(path.join(dir,'sub','a.txt'));await rmdirEntry(path.join(dir,'sub'));
    assert.deepEqual(await fs.readdir(dir),[]);
    await assert.rejects(unlinkEntry(path.join(dir,'none.txt')),{code:'ENOENT'});
    await assert.rejects(rmdirEntry(path.join(dir,'none')),{code:'ENOENT'});
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('other error codes are never retried',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'entry-removal-'));
  try{
    await fs.mkdir(path.join(dir,'full'));await fs.writeFile(path.join(dir,'full','a'),'x');
    await assert.rejects(rmdirEntry(path.join(dir,'full')),(e:NodeJS.ErrnoException)=>e.code==='ENOTEMPTY'||e.code==='EEXIST');
    await assert.rejects(unlinkEntry(path.join(dir,'full')),(e:NodeJS.ErrnoException)=>e.code!=='ENOENT');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('the alternate is the other normalization form of the last component only',()=>{
  assert.equal(alternateName(D+NFD),D+NFC);
  assert.equal(alternateName(D+NFC),D+NFD);
  assert.equal(alternateName(D+'plain.jpg'),undefined);
  assert.equal(alternateName(V+NFD+path.sep+'plain.jpg'),undefined);
});
test('ENOENT on the listed (NFD) name removes the same entry under its NFC name',async()=>{
  // Both spellings are one entry, as on exFAT: same inode.
  const g=fake({[V+NFD]:{ino:7n},[V+NFC]:{ino:7n}});
  await unlinkEntry(V+NFD,g.ops);
  assert.deepEqual(g.calls,['unlink '+V+NFD,'unlink '+V+NFC]);
  assert.equal(g.present[V+NFC],undefined);
});
test('folders take the same path through rmdir, and kind must match',async()=>{
  const g=fake({[V+NFD]:{ino:9n,dir:true},[V+NFC]:{ino:9n,dir:true}});
  await rmdirEntry(V+NFD,g.ops);
  assert.deepEqual(g.calls,['rmdir '+V+NFD,'rmdir '+V+NFC]);
  const k=fake({[V+NFD]:{ino:9n,dir:true},[V+NFC]:{ino:9n,dir:true}});
  await assert.rejects(unlinkEntry(V+NFD,k.ops),{code:'ENOENT'});
  assert.deepEqual(k.calls,['unlink '+V+NFD],'a directory is never unlinked through the alternate');
});
test('ENOENT with no alternate rethrows the original error',async()=>{
  const g=fake({});
  const error=await unlinkEntry(V+NFD,g.ops).then(()=>undefined,e=>e);
  assert.equal(error?.code,'ENOENT');
  assert.deepEqual(g.calls,['unlink '+V+NFD]);
});
test('an alternate that is a different file is not touched and the original error is thrown',async()=>{
  const g=fake({[V+NFD]:{ino:1n},[V+NFC]:{ino:2n}});
  let original:unknown;
  const ops:EntryOps={...g.ops,unlink:async p=>{g.calls.push('unlink '+p);if(!original)original=enoent();throw original;}};
  const error=await unlinkEntry(V+NFD,ops).then(()=>undefined,e=>e);
  assert.equal(error,original,'the original error object');
  assert.deepEqual(g.calls,['unlink '+V+NFD]);
  assert.ok(g.present[V+NFC]&&g.present[V+NFD],'nothing removed');
});
test('a missing alternate is no alternate',async()=>{
  assert.equal(await sameEntryAlternate(V+NFD,false,fake({[V+NFD]:{ino:1n}}).ops),undefined);
  assert.equal(await sameEntryAlternate(V+NFD,false,fake({[V+NFC]:{ino:1n}}).ops),undefined,'the listed name itself must exist');
});
