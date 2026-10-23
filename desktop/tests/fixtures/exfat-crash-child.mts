import * as fs from 'node:fs/promises';
import fsPatchable from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {plan,execute,configureOrganizationRecovery} from '../../core/index';
// Killed with SIGKILL while copying (after N MB), as soon as a published file has data, or ('create')
// right after a published name is created and before a byte is written to it.
const [source,root,mode,megabytes]=process.argv.slice(2);
configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
if(mode==='create'){
  const open=fsPatchable.open.bind(fsPatchable);
  fsPatchable.open=async(...args:Parameters<typeof fs.open>)=>{const handle=await open(...args);if(args[1]==='wx'&&/^DSC_/.test(path.basename(String(args[0]))))process.kill(process.pid,'SIGKILL');return handle;};
  syncBuiltinESMExports();
}
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const reviewed=(await plan(source!,[root!],options,async()=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00Z',fields:{}}))).plans[0]!;
if(mode==='publish')setInterval(async()=>{for(const e of await fs.readdir(root!,{recursive:true,withFileTypes:true}))if(e.isFile()&&/^DSC_/.test(e.name)&&(await fs.stat(path.join(e.parentPath,e.name))).size>0)process.kill(process.pid,'SIGKILL');},2);
await execute(reviewed,undefined,progress=>{if(mode==='copy'&&progress.phase==='copying'&&progress.bytes>Number(megabytes??20)*1048576)process.kill(process.pid,'SIGKILL');},mode==='create'?{exclusiveCopy:true}:{});
console.log('finished without crash');
process.exit(0);
