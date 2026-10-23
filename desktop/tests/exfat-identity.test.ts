import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import fsPatchable from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {plan,execute,cleanStage,configureOrganizationRecovery} from '../core/index';
import {sealImportRecord} from '../core/recovery';
import {recordPartial,recordCreation,releaseCreations,findPartial,leftoverReceipt,rebaseMount} from '../core/import-recovery';
import type {Metadata} from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00Z',fields:{}});

async function fixture(t:test.TestContext) {
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'exfat-identity-')));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const card=path.join(base,'card'),root=path.join(base,'backup');
  await fs.mkdir(card);await fs.mkdir(root);
  await fs.writeFile(path.join(card,'DSC_0001.NEF'),Buffer.alloc(4000,1));
  await fs.writeFile(path.join(card,'DSC_0002.NEF'),Buffer.alloc(5000,2));
  const reviewed=(await plan(card,[root],options,metadata)).plans[0]!,entry=reviewed.entries[0]!;
  await fs.mkdir(path.dirname(entry.destination),{recursive:true});
  const copy=path.join(path.dirname(entry.destination),`photo-importer-${randomUUID()}.partial`);
  await fs.writeFile(copy,Buffer.alloc(1000,1));
  const sha=(file:string)=>fs.readFile(path.join(card,file)).then(data=>createHash('sha256').update(data).digest('hex'));
  const second=reviewed.entries[1]!;
  return {base,card,root,reviewed,entry,second,copy,digest:await sha(path.basename(entry.source)),secondDigest:await sha(path.basename(second.source))};
}

test('a receipt with a temporary inode binds by device and birth time, and not when the birth time differs',async t=>{
  const f=await fixture(t),stat=await fs.lstat(f.copy,{bigint:true});
  const same=await recordPartial('stage',f.copy,{...stat,ino:-5n} as typeof stat,f.entry,f.reviewed,new Map());
  assert.equal((await leftoverReceipt(same.journal,f.root)).bound,true,'the same birth time is bound');
  const other=await recordPartial('stage',f.copy,{...stat,ino:-5n,birthtimeNs:stat.birthtimeNs+1n} as typeof stat,f.entry,f.reviewed,new Map());
  assert.equal((await leftoverReceipt(other.journal,f.root)).bound,false,'a different birth time is not bound');
});

test('a receipt whose root inode differs is not rebased, one with only another device number is',async t=>{
  const f=await fixture(t),root=await fs.lstat(f.root,{bigint:true});
  const record=(rootIdentity:string)=>({root:f.root,rootIdentity,parentIdentity:`${root.dev}:1`,fileIdentity:`${root.dev}:2:3`,sourceRoot:path.join(f.base,'missing'),sourceIdentity:'1:2',sourceStat:undefined}) as unknown as Parameters<typeof rebaseMount>[0];
  const foreign=record(`${root.dev+1n}:${root.ino+1n}`);
  assert.equal((await rebaseMount(foreign)).rootIdentity,foreign.rootIdentity,'another root inode keeps its identity');
  assert.equal((await rebaseMount(foreign)).fileIdentity,foreign.fileIdentity);
  const moved=record(`${root.dev+1n}:${root.ino}`),rebased=await rebaseMount(moved);
  assert.equal(rebased.rootIdentity,`${root.dev}:${root.ino}`);
  assert.equal(rebased.fileIdentity,`${root.dev}:2:3`);
});

test('cleanStage leaves a file with a different birth time in place and says its identity differs',async t=>{
  const f=await fixture(t),stat=await fs.lstat(f.copy,{bigint:true}),notes:string[]=[],issues:{code:string;severity:string;path:string}[]=[];
  await cleanStage({file:f.copy,dev:stat.dev,ino:stat.ino,birthtime:stat.birthtimeNs+1n,recovery:new Map()},f.root,true,(text,issue)=>{notes.push(text);if(issue)issues.push(issue);});
  assert.deepEqual(issues.map(issue=>[issue.code,issue.severity,issue.path]),[['staging-left','warning',f.copy]],'also reported as a structured warning');
  assert.ok(await fs.lstat(f.copy).then(()=>true,()=>false),'the file is still there');
  assert.equal(notes.length,1);assert.match(notes[0]!,/identity differs/);
  // A temporary inode with a different birth time is no better.
  await cleanStage({file:f.copy,dev:stat.dev,ino:-3n,birthtime:stat.birthtimeNs+1n,recovery:new Map()},f.root,true,text=>notes.push(text));
  assert.ok(await fs.lstat(f.copy).then(()=>true,()=>false));assert.equal(notes.length,2);
  // The matching identity does remove it.
  await cleanStage({file:f.copy,dev:stat.dev,ino:stat.ino,birthtime:stat.birthtimeNs,recovery:new Map()},f.root,true,text=>notes.push(text));
  assert.equal(await fs.lstat(f.copy).then(()=>true,()=>false),false);
});

const exists=(file:string)=>fs.lstat(file).then(()=>true,()=>false);
const receipts=async(folder:string)=>(await fs.readdir(folder)).filter(name=>name.startsWith('photo-importer-intent-'));

test('a creation receipt with no file yet: the next run creates the file in place and leaves no receipt',async t=>{
  const f=await fixture(t),folder=path.dirname(f.entry.destination);
  await recordCreation(f.entry.destination,{...f.entry,digest:f.digest},f.reviewed,new Map());
  assert.equal(await exists(f.entry.destination),false);assert.equal((await receipts(folder)).length,1);
  const again=(await plan(f.card,[f.root],options,metadata)).plans[0]!;
  assert.equal(again.entries[0]!.destination,f.entry.destination,'planned at the real name');
  assert.deepEqual(await execute(again,undefined,undefined,{exclusiveCopy:true}),{copied:2,skipped:0,errors:[]});
  assert.deepEqual(await fs.readFile(f.entry.destination),await fs.readFile(f.entry.source));
  assert.deepEqual(await receipts(folder),[]);assert.equal(await exists(path.join(folder,'Conflicts')),false);
});

test('a creation receipt owns only an empty file with one link',async t=>{
  const f=await fixture(t),entry={...f.entry,digest:f.digest},find=()=>findPartial('publication',entry,f.root,new Map());
  await recordCreation(f.entry.destination,entry,f.reviewed,new Map());
  assert.equal((await find())?.absent,true,'no file yet: absent');
  await fs.writeFile(f.entry.destination,'');
  const empty=await find();assert.ok(empty&&!empty.absent,'an empty file is owned');
  await fs.link(f.entry.destination,path.join(f.base,'other-name'));
  assert.equal(await find(),undefined,'a second link is not owned');
  await fs.unlink(path.join(f.base,'other-name'));
  await fs.writeFile(f.entry.destination,'x');
  assert.equal(await find(),undefined,'a non-empty file is not owned');
});

test('an exclusive create that finds the name taken clears its receipt and leaves the file alone',async t=>{
  const f=await fixture(t),folder=path.dirname(f.entry.destination);
  // The name is taken between the plan and the publication.
  const reviewed=(await plan(f.card,[f.root],options,metadata)).plans[0]!,open=fsPatchable.open.bind(fsPatchable),write=fsPatchable.writeFile.bind(fsPatchable);
  let raced=false;
  t.mock.method(fsPatchable,'open',async(...args:Parameters<typeof fsPatchable.open>)=>{
    if(String(args[0])===f.entry.destination&&args[1]==='wx'&&!raced){raced=true;await write(f.entry.destination,'precious user data');}
    return open(...args);
  });
  syncBuiltinESMExports();
  let result;
  try { result=await execute(reviewed,undefined,undefined,{exclusiveCopy:true}); } finally { t.mock.restoreAll();syncBuiltinESMExports(); }
  assert.equal(raced,true);
  assert.equal(await fs.readFile(f.entry.destination,'utf8'),'precious user data');
  assert.deepEqual(await receipts(folder),[]);
  // The import itself moves on to a conflict folder rather than touching the file that took the name.
  assert.deepEqual(result.errors,[]);assert.equal(result.copied,2);
  const found=(await fs.readdir(folder,{recursive:true})).filter(name=>name.endsWith('DSC_0001.NEF'));
  assert.ok(found.some(name=>name.includes('Conflicts')),'the incoming copy went to Conflicts');
});

test('releaseCreations leaves receipts for other destinations and other roots in place',async t=>{
  const f=await fixture(t),folder=path.dirname(f.entry.destination),index=new Map();
  const mine={...f.entry,digest:f.digest},other={...f.second,digest:f.secondDigest};
  await recordCreation(mine.destination,mine,f.reviewed,index);await recordCreation(other.destination,other,f.reviewed,index);
  assert.equal((await receipts(folder)).length,2);
  await releaseCreations(mine,path.join(f.base,'elsewhere'),new Map());
  assert.equal((await receipts(folder)).length,2,'another root releases nothing');
  await releaseCreations(mine,f.root,index);
  const left=await receipts(folder);assert.equal(left.length,1);
  assert.equal(JSON.parse(await fs.readFile(path.join(folder,left[0]!),'utf8')).destination,other.destination);
});

test('a stage receipt written under another device number still binds, through the same rebase',async t=>{
  const f=await fixture(t),stat=await fs.lstat(f.copy,{bigint:true});
  const {journal}=await recordPartial('stage',f.copy,stat,f.entry,f.reviewed,new Map());
  const fake=String(stat.dev+11n),swap=(value:unknown)=>String(value).replace(/^\d+:/,fake+':');
  const record=JSON.parse(await fs.readFile(journal,'utf8')) as Record<string,any>;
  const {seal:_seal,...data}=record;void _seal;
  await fs.writeFile(journal,JSON.stringify(sealImportRecord({...data,rootIdentity:swap(data.rootIdentity),parentIdentity:swap(data.parentIdentity),fileIdentity:swap(data.fileIdentity),sourceIdentity:swap(data.sourceIdentity),sourceStat:{...data.sourceStat,dev:fake}})));
  assert.equal((await leftoverReceipt(journal,f.root)).bound,true);
  assert.ok(await findPartial('stage',f.entry,f.root,new Map()),'the copy is found and can resume');
});
