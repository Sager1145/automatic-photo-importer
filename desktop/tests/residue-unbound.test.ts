import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {plan, execute, configureOrganizationRecovery} from '../core/index';
import {recordPartial, recordCreation} from '../core/import-recovery';
import {findResidue, cleanResidue, removeUnboundReceipt} from '../core/residue';
import type {Metadata} from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00Z',fields:{}});

/** A whole file at its final name (the card's bytes) beside a direct-copy receipt that does not bind it: its creation date is far from every date the receipt allows. */
async function fixture(t:test.TestContext,bind:'none'|'exact'|'creating'='none') {
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'residue-unbound-')));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const card=path.join(base,'card'),root=path.join(base,'backup');
  await fs.mkdir(card);await fs.mkdir(root);
  await fs.writeFile(path.join(card,'DSC_0001.NEF'),Buffer.alloc(50_000,3));
  const reviewed=(await plan(card,[root],options,metadata)).plans[0]!,entry=reviewed.entries[0]!;
  await fs.mkdir(path.dirname(entry.destination),{recursive:true});
  await fs.copyFile(path.join(card,'DSC_0001.NEF'),entry.destination);
  const stat=await fs.lstat(entry.destination,{bigint:true}),index=new Map();
  const direct={size:entry.size,finalBirth:[1_000_000_000n]};
  if(bind==='creating') await recordCreation(entry.destination,entry,reviewed,index,direct);
  else await recordPartial('publication',entry.destination,bind==='exact'?stat:{...stat,birthtimeNs:stat.birthtimeNs+9_000_000_000n} as typeof stat,entry,reviewed,index,direct);
  return {base,card,root,reviewed,entry,file:entry.destination};
}
const receipts=async(root:string)=>(await fs.readdir(root,{recursive:true})).filter(name=>/photo-importer-intent-.*\.json$/.test(name));

test('a direct receipt that no longer matches its whole file is listed as receipt-only, with the file kept',async t=>{
  const f=await fixture(t);
  const found=await findResidue([f.root]);
  const item=found.items.find(entry=>entry.kind==='unbound');
  assert.ok(item,'listed');
  assert.equal(item!.file,f.file);
  assert.deepEqual(found.unbound,{files:1,paths:[f.file]});
  assert.equal(found.files,1);
});

test('a receipt that binds its file, or the one written before the name existed, is not listed',async t=>{
  for(const bind of ['exact','creating'] as const) {
    const f=await fixture(t,bind);
    const found=await findResidue([f.root]);
    assert.equal(found.items.some(entry=>entry.kind==='unbound'),false,bind);
    assert.equal(found.unbound!.files,0);
  }
});

test('automatic cleanup never removes it; Clean up removes only the receipt and never touches the file',async t=>{
  const f=await fixture(t),before=await fs.lstat(f.file,{bigint:true});
  const automatic=await cleanResidue(await findResidue([f.root]),{keepResumable:true});
  assert.equal(automatic.removed.files,0);assert.equal((await receipts(f.root)).length,1);
  assert.equal(automatic.left.unbound!.files,1);
  const manual=await cleanResidue(await findResidue([f.root]));
  assert.equal(manual.removed.files,1);assert.deepEqual(await receipts(f.root),[]);
  const after=await fs.lstat(f.file,{bigint:true});
  assert.equal(after.ino,before.ino);assert.equal(after.size,before.size);assert.equal(after.mtimeNs,before.mtimeNs);
  assert.deepEqual(await fs.readFile(f.file),Buffer.alloc(50_000,3));
});

test('clicking the item removes just that receipt, and only while the file is untouched and the receipt still unbound',async t=>{
  const f=await fixture(t),found=await findResidue([f.root]),item=found.items.find(entry=>entry.kind==='unbound')!;
  // The file changed since it was listed: nothing is removed.
  await fs.appendFile(f.file,'x');
  assert.equal(await removeUnboundReceipt(item),false);assert.equal((await receipts(f.root)).length,1);
  // Back as listed and unbound again.
  const g=await fixture(t),listed=(await findResidue([g.root])).items.find(entry=>entry.kind==='unbound')!;
  assert.equal(await removeUnboundReceipt(listed),true);assert.deepEqual(await receipts(g.root),[]);
  assert.ok(await fs.lstat(g.file));
});

test('the import stops on it with a message that names the file and points to Clean up, and releases nothing',async t=>{
  const f=await fixture(t);
  const result=await execute((await plan(f.card,[f.root],options,metadata)).plans[0]!);
  const error=result.errors.find(line=>line.includes('DSC_0001.NEF'))??'';
  assert.ok(error.includes(f.file),error);
  assert.match(error,/Settings > Clean up/);
  assert.equal((await receipts(f.root)).length,1);
  // After the receipt is removed the same import goes through (the file is whole and equal, so it is simply present).
  const item=(await findResidue([f.root])).items.find(entry=>entry.kind==='unbound')!;
  assert.equal(await removeUnboundReceipt(item),true);
  assert.deepEqual((await execute((await plan(f.card,[f.root],options,metadata)).plans[0]!)).errors,[]);
});
