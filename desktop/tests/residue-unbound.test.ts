import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import fsPatchable from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {plan, execute, configureOrganizationRecovery} from '../core/index';
import {recordPartial, recordCreation} from '../core/import-recovery';
import {findResidue, cleanResidue, removeUnboundReceipt} from '../core/residue';
import type {Metadata} from '../shared';
import {openReceiptsFor,stagePathFor} from './fixtures/receipts';

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
/** Open publication receipts in the store's receipt log (records v5). */
const receipts=async(root:string)=>[...(await openReceiptsFor(root)).values()].filter(record=>record.kind==='publication');

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

test('a receipt that still binds its file is never refused because the source or its folder moved on: the file is finished',async t=>{
  const f=await fixture(t,'exact');
  // The card file is touched after the receipt was written: its recorded stat no longer matches.
  await fs.utimes(path.join(f.card,'DSC_0001.NEF'),new Date(1_700_000_000_000),new Date(1_700_000_000_000));
  assert.equal((await findResidue([f.root])).items.some(item=>item.kind==='unbound'),false,'Clean up has nothing to list');
  const result=await execute((await plan(f.card,[f.root],options,metadata)).plans[0]!);
  assert.deepEqual(result.errors,[]);
  assert.deepEqual(await receipts(f.root),[],'finished, so its receipt is released');
  assert.ok(Math.abs((await fs.stat(f.file)).mtimeMs-Date.parse('2024-02-03T12:00:00Z'))<2000,'the capture date was applied');
});

test('a receipt that binds its file still lets it be finished after the destination folder or the card folder was replaced by another folder',async t=>{
  for(const change of ['destination folder','card folder'] as const) {
    const f=await fixture(t,'exact');
    if(change==='destination folder') {
      const folder=path.dirname(f.file),aside=folder+'.aside';
      await fs.rename(folder,aside);await fs.mkdir(folder);
      for(const name of await fs.readdir(aside)) await fs.rename(path.join(aside,name),path.join(folder,name));
      await fs.rmdir(aside);
    } else {
      const aside=f.card+'.aside';
      await fs.rename(f.card,aside);await fs.mkdir(f.card);
      for(const name of await fs.readdir(aside)) await fs.copyFile(path.join(aside,name),path.join(f.card,name));
      await fs.rm(aside,{recursive:true});
    }
    assert.equal((await findResidue([f.root])).items.some(item=>item.kind==='unbound'),false,change);
    const result=await execute((await plan(f.card,[f.root],options,metadata)).plans[0]!);
    assert.deepEqual(result.errors,[],change);
    assert.deepEqual(await receipts(f.root),[],`${change}: finished, so its receipt is released`);
    assert.ok(Math.abs((await fs.stat(f.file)).mtimeMs-Date.parse('2024-02-03T12:00:00Z'))<2000,`${change}: the capture date was applied`);
  }
});

test('a receipt the finish could not confirm just now, though it is not unbound, is kept and the family is told to try again - no dates are skipped',async t=>{
  const f=await fixture(t,'exact');
  // Once, the file seems to change between the two looks the finish takes at it (a race with another writer).
  const lstat=fsPatchable.lstat.bind(fsPatchable);let looks=0;
  t.mock.method(fsPatchable,'lstat',async(...args:Parameters<typeof fsPatchable.lstat>)=>{
    const result=await lstat(...args);
    if(String(args[0])===f.file&&new Error().stack?.includes('import-recovery')&&++looks===2) return {...result,mtimeNs:(result as import('node:fs').BigIntStats).mtimeNs+1n} as typeof result;
    return result;
  });
  syncBuiltinESMExports();
  const reviewed=(await plan(f.card,[f.root],options,metadata)).plans[0]!;
  looks=0;
  const first=await execute(reviewed);
  t.mock.restoreAll();syncBuiltinESMExports();
  assert.ok(first.errors.some(error=>/try again/i.test(error)&&error.includes(f.file)),first.errors.join(' | '));
  assert.equal((await receipts(f.root)).length,1,'its receipt is kept');
  const second=await execute((await plan(f.card,[f.root],options,metadata)).plans[0]!);
  assert.deepEqual(second.errors,[]);
  assert.deepEqual(await receipts(f.root),[]);
  assert.ok(Math.abs((await fs.stat(f.file)).mtimeMs-Date.parse('2024-02-03T12:00:00Z'))<2000,'dated by the retry');
});

test('finishing a file on the staged path also releases a stale staged copy of it',async t=>{
  const f=await fixture(t,'exact');
  const partial=await stagePathFor(f.root,'6f1c9a3e-1b2d-4c5e-8f70-123456789abc');
  await fs.writeFile(partial,Buffer.alloc(20_000,3));
  await recordPartial('stage',partial,await fs.lstat(partial,{bigint:true}),f.entry,f.reviewed,new Map());
  const result=await execute((await plan(f.card,[f.root],options,metadata)).plans[0]!);
  assert.deepEqual(result.errors,[]);
  assert.equal(await fs.lstat(partial).then(()=>true,()=>false),false,'the stale stage is gone');
  assert.deepEqual([...(await openReceiptsFor(f.root)).values()],[],'and its receipts are closed');
});

test('the import refuses a receipt exactly when Clean up lists it',async t=>{
  for(const [bind,touched] of [['none',false],['none',true],['exact',false],['exact',true],['creating',false]] as const) {
    const f=await fixture(t,bind);
    if(touched) await fs.utimes(path.join(f.card,'DSC_0001.NEF'),new Date(1_700_000_000_000),new Date(1_700_000_000_000));
    const listed=(await findResidue([f.root])).items.some(item=>item.kind==='unbound');
    const result=await execute((await plan(f.card,[f.root],options,metadata)).plans[0]!);
    const refused=result.errors.some(error=>/Remove the receipt in Settings/.test(error));
    assert.equal(refused,listed,`${bind}${touched?' with the source touched':''}: listed ${listed}, refused ${refused}`);
    assert.equal(listed,bind==='none');
  }
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
