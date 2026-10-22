import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { plan, configureOrganizationRecovery } from '../core/index';
import { sameStat, statKey } from '../core/paths';
import type { Metadata } from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2024-02-03T12:00:00Z',fields:{}});
async function fixture(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'exfat-empty-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 await fs.mkdir(path.join(base,'library'));
 const put=async(relative:string,contents:string)=>{const file=path.join(base,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,contents);return file;};
 return {base,put};
}
const stat=(values:{ino:bigint;size:bigint})=>({dev:1n,mtimeNs:5n,ctimeNs:6n,...values}) as unknown as import('node:fs').BigIntStats;

// macOS exFAT gives a zero-length file (no start cluster) a fileID that changes whenever its vnode is recreated.
test('an empty file keeps its identity when only its inode number changes',()=>{
 assert.ok(sameStat(stat({ino:18446744073709254708n,size:0n}),stat({ino:18446744073709254702n,size:0n})));
 assert.equal(statKey(stat({ino:1n,size:0n})),statKey(stat({ino:2n,size:0n})));
});

test('a non-empty file with a different inode is still a different file',()=>{
 assert.ok(!sameStat(stat({ino:1n,size:10n}),stat({ino:2n,size:10n})));
 assert.notEqual(statKey(stat({ino:1n,size:10n})),statKey(stat({ino:2n,size:10n})));
});

test('0-byte photos and videos are left out as empty, not imported',async t=>{
 const f=await fixture(t);
 await f.put('card/DCIM/EMPTY.CR3','');await f.put('card/DCIM/CLIP.MP4','');await f.put('card/DCIM/REAL.JPG','real bytes');
 const result=await plan(path.join(f.base,'card'),[path.join(f.base,'library')],options,metadata);
 assert.deepEqual(result.plans[0]!.entries.map(entry=>path.basename(entry.source)),['REAL.JPG']);
 assert.deepEqual(result.inventory.skipped!.filter(item=>item.reason==='empty').map(item=>path.basename(item.path)).sort(),['CLIP.MP4','EMPTY.CR3']);
 assert.deepEqual(result.failures,[]);
});

test('a drive backup still copies empty files, keeping the drive as it is',async t=>{
 const f=await fixture(t);
 await f.put('drive/notes/EMPTY.CR3','');
 const result=await plan(path.join(f.base,'drive'),[path.join(f.base,'library')],{...options,backup:true},metadata);
 assert.deepEqual(result.plans[0]!.entries.map(entry=>path.basename(entry.source)),['EMPTY.CR3']);
});

test('one file changing during an organization review leaves only that file out',async t=>{
 const f=await fixture(t);
 const library=path.join(f.base,'photobackup');
 await f.put('photobackup/old/A.JPG','a bytes');
 const changing=await f.put('photobackup/old/B.JPG','b bytes');
 const changeOnce=async(file:string):Promise<Metadata>=>{if(file===changing)await fs.appendFile(changing,' and more');return metadata();};
 const result=await plan(library,[library],{...options,reorganize:true},changeOnce);
 assert.deepEqual(result.plans[0]!.entries.map(entry=>path.basename(entry.source)),['A.JPG']);
 assert.deepEqual(result.failures.map(item=>path.basename(item.path)),['B.JPG']);
 assert.equal(await fs.readFile(changing,'utf8'),'b bytes and more','the changed file stays where it is');
});
