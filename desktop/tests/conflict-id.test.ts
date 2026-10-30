import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {plan,execute,configureOrganizationRecovery} from '../core';
import {put,temporary} from './fixtures/edge';

configureOrganizationRecovery('conflict-id-host-recovery-secret-32bytes');
const camera='2024/202402/Fixture Camera';
const metadata=async()=>({camera:'Fixture Camera',date:'2024-02-03',fields:{}});
const rules={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const sha=(content:string)=>createHash('sha256').update(content).digest('hex');
const idOf=(members:Record<string,string>,compare:(a:string,b:string)=>number)=>createHash('sha256').update(JSON.stringify(Object.entries(members).map(([name,content])=>[name,sha(content)]).sort((a,b)=>compare(a[0]!,b[0]!)||compare(a[1]!,b[1]!)))).digest('hex').slice(0,16);
const codepoint=(a:string,b:string)=>a<b?-1:a>b?1:0,locale=(a:string,b:string)=>a.localeCompare(b);
const family={'DSC_0001.xmp':'xmp','dsc_0001.NEF':'raw'};
async function fixture(t:test.TestContext){
 const base=await temporary(t,'conflict-id-'),source=path.join(base,'card'),root=path.join(base,'backup');
 await fs.mkdir(source);await fs.mkdir(root);
 for(const [name,content] of Object.entries(family))await put(path.join(source,name),content);
 await put(path.join(root,camera,'DSC_0001.xmp'),'a different sidecar already filed');
 return {source,root,prepare:async()=>(await plan(source,[root],rules,metadata)).plans[0]!};
}

test('the Conflicts folder id is the codepoint-order digest, not the process locale order',async t=>{
 assert.notEqual(idOf(family,codepoint),idOf(family,locale),'the fixture orders differently under the two');
 const f=await fixture(t),transfer=await f.prepare();
 assert.equal(transfer.entries.length,2);
 for(const entry of transfer.entries)assert.equal(path.relative(path.join(f.root,camera),entry.destination).split(path.sep).slice(0,2).join('/'),`Conflicts/${idOf(family,codepoint)}`);
});

test('a Conflicts folder named by the locale order in an older library is kept and counts as already backed up',async t=>{
 const f=await fixture(t),legacy=idOf(family,locale);
 for(const [name,content] of Object.entries(family))await put(path.join(f.root,camera,'Conflicts',legacy,name),content);
 const transfer=await f.prepare();
 for(const entry of transfer.entries){assert.equal(path.relative(path.join(f.root,camera),entry.destination).split(path.sep).slice(0,2).join('/'),`Conflicts/${legacy}`);assert.equal(entry.skip,true);}
 assert.deepEqual(await execute(transfer),{copied:0,skipped:2,errors:[]});
 assert.deepEqual(await fs.readdir(path.join(f.root,camera,'Conflicts')),[legacy]);
});
