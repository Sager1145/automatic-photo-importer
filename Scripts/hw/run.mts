/**
 * Entry point of the hardware exFAT end-to-end test.
 *
 *   node --import tsx Scripts/hw/run.mts --source=/Volumes/A006 --library=/Volumes/Untitled [--keep] [--files=N] [--host-key=<path>] [--only=<group,...>]
 *
 * Runs every group module in Scripts/hw/groups/ (sorted by file name) or only those named by --only, each in its own
 * sub-folder of the sandboxes. See harness.mts for the safety rules.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs,createHarness,type Context,type GroupStats} from './harness.mts';

const options=parseArgs(process.argv.slice(2));
const groupsDir=path.join(path.dirname(fileURLToPath(import.meta.url)),'groups');
const available=(await fs.readdir(groupsDir)).filter(f=>f.endsWith('.mts')).sort().map(f=>f.slice(0,-4));
if(options.only){
 const unknown=options.only.filter(name=>!available.includes(name));
 if(unknown.length){console.error(`Unknown group(s): ${unknown.join(', ')}. Available: ${available.join(', ')}`);process.exit(2);}
}
const selected=available.filter(name=>!options.only||options.only.includes(name));
console.log('groups:',selected.join(', '));

const harness=await createHarness(options);
const results:GroupStats[]=[];
let harnessFailures=0;
try{
 for(const name of selected){
  const mod=await import(pathToFileURL(path.join(groupsDir,name+'.mts')).href).catch(error=>error as Error);
  const title=mod instanceof Error?name:(mod.title as string|undefined)??name;
  console.log(`\n######## ${name}: ${title}`);
  const {ctx,stats}=await harness.group(name,title);
  const start=Date.now();
  try{
   if(mod instanceof Error)throw mod;
   if(typeof mod.default!=='function')throw new Error(`group ${name} has no default export function`);
   await (mod.default as (ctx:Context)=>Promise<void>)(ctx);
  }catch(error){stats.fail++;console.log(`FAIL  group ${name} threw: ${error instanceof Error?error.stack??error.message:String(error)}`);}
  console.log(`\n== timings (${name}, ${((Date.now()-start)/1000).toFixed(1)} s)`);
  for(const [scenarioName,ms] of stats.timings)console.log(`${(ms/1000).toFixed(1).padStart(7)} s  ${scenarioName}`);
  results.push(stats);
 }
}catch(error){
 harnessFailures++;console.error('FATAL: '+(error instanceof Error?error.stack:String(error)));
}finally{
 harnessFailures+=await harness.finish();
}
console.log('\n== summary');
for(const r of results)console.log(`${r.fail?'FAIL':'ok  '}  ${r.name.padEnd(24)} pass ${r.pass}  fail ${r.fail}  skip ${r.skip}  ${r.title}`);
const failed=results.reduce((sum,r)=>sum+r.fail,0)+harnessFailures;
console.log(failed?`\nFAILED: ${failed} failure(s)`:'\nALL CHECKS PASSED');
process.exit(failed||process.exitCode?1:0);
