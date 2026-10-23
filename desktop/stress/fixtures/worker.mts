// A child process the stress suite kills with SIGKILL at random points of an import or an
// organization, then starts again to resume. It only works inside its own temporary fixture.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const [mode,selected] = process.argv.slice(2);
const base = await fs.realpath(selected!);
const relative = path.relative(await fs.realpath(os.tmpdir()),base);
if (!path.basename(base).startsWith('stress-') || !relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Stress worker requires its own temporary fixture');
const core = await import('../../core/index.ts');
core.configureOrganizationRecovery('stress-fixture-host-recovery-secret-32bytes');
const {metadata} = await import('./metadata.ts');
const library = path.join(base,'library');
const organization = {backup:false,reorganize:true,template:'{year}/{yyyymm}/{camera}',layout:'type-format' as const,unknownRules:{}};
// Progress reaches the parent, which decides when to kill.
process.on('message',()=>{});
const progress = (completed:number)=>process.send!({type:'progress',completed});
async function run() {
  if (mode === 'import') {
    const {plans:[transfer]} = await core.plan(path.join(base,'card'),[path.join(base,'drive')],{backup:false,template:'{year}/{camera}',layout:'format',unknownRules:{}},metadata);
    return core.execute(transfer!,undefined,value=>progress(value.completed));
  }
  if (mode === 'organize') {
    const pending = (await core.getOrganizationRecovery(library,{verifyContents:false})).filter(job=>job.status==='pending');
    if (pending.length) return core.resumeOrganization(library,pending[0]!.id,undefined,value=>progress(value.completed));
    const {plans:[transfer]} = await core.plan(library,[library],organization,metadata);
    return core.executeReorganization(transfer!,undefined,value=>progress(value.completed));
  }
  if (mode === 'undo') {
    let restored = 0;
    for (const job of await core.getOrganizationRecovery(library,{verifyContents:false}))restored += (await core.undoOrganization(library,job.id,undefined,value=>progress(value.completed))).restored;
    return {restored};
  }
  if (mode === 'jobs') return {jobs:await core.getOrganizationRecovery(library)};
  throw new Error(`Unknown mode ${mode}`);
}
try {
  const result = await run();
  process.send!({type:'result',result},()=>process.disconnect?.());
} catch(error) {
  console.error(error);
  process.exitCode = 1;
  process.disconnect?.();
}
