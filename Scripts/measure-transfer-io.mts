/** Byte-count experiment on one generated 16 MiB file; never a device speed benchmark. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import type * as Core from '../desktop/core/index.ts';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.some(value=>!value.startsWith('--core=')&&!value.startsWith('--label=')))throw new Error('Usage: node --import tsx Scripts/measure-transfer-io.mts [--core=/absolute/index.ts] [--label=before|after]');
const moduleFile=path.resolve(args.find(value=>value.startsWith('--core='))?.slice(7)??path.join(repository,'desktop/core/index.ts'));
if(moduleFile.startsWith('/Volumes/'))throw new Error('This experiment must never load a module from a physical test volume.');
const label=args.find(value=>value.startsWith('--label='))?.slice(8)??'after';
if(!['before','after'].includes(label))throw new Error('Label must be before or after.');
const {plan,execute}=await import(pathToFileURL(moduleFile).href) as typeof Core;
const fixture=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'photo-importer-io-count-')));
const source=path.join(fixture,'source'),root=path.join(fixture,'destination'),original=path.join(source,'original.bin');
await fs.mkdir(source);await fs.mkdir(root);
const data=Buffer.alloc(16*1024*1024);for(let index=0;index<data.length;index++)data[index]=(index*31+Math.floor(index/4093)*17)%251;
await fs.writeFile(original,data);
const counts={plan:{source:0,stage:0,target:0},execute:{source:0,stage:0,target:0}};
let phase:'plan'|'execute'='plan';
const open=fs.open;
fs.open=async(...args:Parameters<typeof fs.open>)=>{
 const handle=await open(...args),file=String(args[0]);
 const kind=file===original?'source':file.startsWith(root+path.sep)?path.basename(file).endsWith('.partial')?'stage':'target':undefined;
 if(kind){const read=handle.read.bind(handle);handle.read=(async(...arguments_:Parameters<typeof handle.read>)=>{const result=await read(...arguments_);counts[phase][kind]+=result.bytesRead;return result;}) as typeof handle.read;}
 return handle;
};
syncBuiltinESMExports();
try{
 const {plans:[prepared]}=await plan(source,[root],{backup:true,template:'{year}/{camera}',layout:'flat' as const,unknownRules:{}},async()=>{throw new Error('Backup must not read metadata');});
 phase='execute';const result=await execute(prepared);assert.deepEqual(result,{copied:1,skipped:0,errors:[]});
 fs.open=open;syncBuiltinESMExports();
 const copied=await fs.readFile(path.join(root,'original.bin'));
 assert.equal(createHash('sha256').update(copied).digest('hex'),createHash('sha256').update(data).digest('hex'));
 assert.deepEqual(await fs.readFile(original),data);
 const total={source:counts.plan.source+counts.execute.source,stage:counts.plan.stage+counts.execute.stage,target:counts.plan.target+counts.execute.target};
 const report={label,moduleFile,fixtureBytes:data.length,counts,total,totalReadBytes:total.source+total.stage+total.target,copyVerified:true,note:'Generated temporary file, one target with hard-link publication. Read byte counters include planning and execution. Not a physical device speed measurement.'};
 await fs.mkdir(path.join(repository,'build'),{recursive:true});
 const reportFile=path.join(repository,'build',`transfer-io-${label}.json`);await fs.writeFile(reportFile,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,reportFile},null,2));
}finally{fs.open=open;syncBuiltinESMExports();await fs.rm(fixture,{recursive:true,force:true});}
