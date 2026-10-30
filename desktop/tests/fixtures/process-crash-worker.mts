import fs from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';

const [mode,selected,id] = process.argv.slice(2);
const base = await fs.realpath(selected!);
const temporary = await fs.realpath(os.tmpdir());
const relative = path.relative(temporary,base);
// Opt-in: the hardware test (Scripts/hw/groups/05-crash.mts) runs this worker inside its sandbox on a mounted volume.
const hardwareSandbox = /^\/Volumes\/[^/]+\/photo-importer-hw-test-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\/.+/.test(base);
if (!path.basename(base).startsWith('process-crash-') || (!hardwareSandbox && (!relative || relative.startsWith('..') || path.isAbsolute(relative)))) throw new Error('Crash worker requires its own temporary fixture');
const source = path.join(base,'source');
const destination = path.join(base,'destination');
const library = path.join(base,'library');
const original = path.join(library,'incoming','A.JPG');
const target = path.join(library,'2024','202402','FixtureCamera','JPEG','A.JPG');
const recovery = path.join(library,'Photo Importer Data','Organizations');
const finallyMarker = path.join(base,`finally-${mode}`);
const metadata = async()=>({camera:'FixtureCamera',date:'2024-02-03',fields:{}});
const importOptions = {backup:true,template:'{year}/{camera}',layout:'flat' as const,unknownRules:{}};
const organizationOptions = {...importOptions,backup:false,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,reorganize:true};

// An IPC listener keeps a blocked worker alive until its parent sends SIGKILL.
process.on('message',()=>{});
async function checkpoint(details:Record<string,unknown>):Promise<never> {
  process.send!({type:'checkpoint',mode,...details});
  return new Promise<never>(()=>{});
}
async function retained(operation:string):Promise<string> {
  const entry = path.join(recovery,operation,'originals','0');
  for (const slot of (await fs.readdir(entry)).filter(name=>!name.startsWith('._'))) {
    const names = (await fs.readdir(path.join(entry,slot))).filter(name=>!name.startsWith('._'));
    if (names.length) return path.join(entry,slot,names[0]!);
  }
  throw new Error('No retained original found');
}
// Hardware-test only (organization-exclusive-synced): write in 4093-byte pieces without stopping, then stop at a later sync,
// after the first data sync and the second 'exclusive-created' checkpoint of exclusivePublication.
function syncedStop(handle:FileHandle,file:string) {
  const write = handle.write.bind(handle), sync = handle.sync.bind(handle);let syncs = 0;
  Object.defineProperty(handle,'write',{value:(buffer:Buffer,offset:number,length:number,position:number|null)=>write(buffer,offset,Math.min(length,4093),position)});
  Object.defineProperty(handle,'sync',{value:async()=>{if (++syncs === 3) await checkpoint({file,syncs});return sync();}});
}
function shortWrite(handle:FileHandle,file:string) {
  const write = handle.write.bind(handle);
  Object.defineProperty(handle,'write',{value:async(buffer:Buffer,offset:number,length:number,position:number|null)=>{
    const result = await write(buffer,offset,Math.min(length,4093),position);
    await checkpoint({file,bytesWritten:result.bytesWritten});
  }});
}
async function run() {
  const open = fs.open.bind(fs), link = fs.link.bind(fs), rename = fs.rename.bind(fs), unlink = fs.unlink.bind(fs);
  if (mode === 'import-stage' || mode === 'import-exclusive' || mode === 'organization-exclusive' || mode === 'organization-exclusive-synced') {
    fs.open = async(...args:Parameters<typeof fs.open>)=>{
      const handle = await open(...args), file = String(args[0]);
      if (args[1] === 'wx' && (mode === 'import-stage' ? file.includes(`${path.sep}Photo Importer Data${path.sep}Imports${path.sep}Staging${path.sep}`) && file.endsWith('.partial') : mode==='import-exclusive'?file===path.join(destination,'A.bin'):file === target)) (mode === 'organization-exclusive-synced' ? syncedStop : shortWrite)(handle,file);
      return handle;
    };
  }
  if (mode === 'organization-exclusive' || mode === 'organization-exclusive-synced' || mode === 'organization-publish') {
    fs.link = async(from,to)=>{
      if (String(to) === target && (mode === 'organization-exclusive' || mode === 'organization-exclusive-synced')) throw Object.assign(new Error('Fixture filesystem has no hard links'),{code:'ENOTSUP'});
      const result = await link(from,to);
      if (String(to) === target && mode === 'organization-publish') await checkpoint({file:target});
      return result;
    };
  }
  if (mode === 'organization-rename-link') {
    fs.link = async(from,to)=>{
      const result = await link(from,to);
      if (String(to) === target) await checkpoint({file:target});
      return result;
    };
  }
  if (mode === 'organization-rename-unlink') {
    fs.unlink = async(file)=>{
      const result = await unlink(file);
      if (String(file) === original) await checkpoint({file:target});
      return result;
    };
  }
  if (mode === 'organization-stash') {
    fs.rename = async(from,to)=>{
      const result = await rename(from,to);
      if (String(from) === original) await checkpoint({file:String(to)});
      return result;
    };
  }
  if (mode === 'finalize-intent' || mode === 'finalize-unlink') {
    const saved = await retained(id!);
    fs.unlink = async(file)=>{
      if (String(file) !== saved) return unlink(file);
      if (mode === 'finalize-intent') await checkpoint({file:saved});
      const result = await unlink(file);
      await checkpoint({file:saved});
      return result;
    };
  }
  syncBuiltinESMExports();
  const core = await import('../../core/index.ts');
  const {organizeAs} = await import('./records.ts');
  // A hardware run on a volume whose records folder this Mac wrote needs this Mac's key (the harness's --host-key);
  // every other run keeps the fixed test key.
  const hostKey = hardwareSandbox && process.env.HW_HOST_KEY_FILE ? await fs.readFile(process.env.HW_HOST_KEY_FILE) : undefined;
  if (hostKey && hostKey.length !== 32) throw new Error('HW_HOST_KEY_FILE must name a 32-byte key file');
  core.configureOrganizationRecovery(hostKey ?? 'process-crash-host-authentication-secret-32bytes');
  if (mode === 'import-stage' || mode === 'import-exclusive' || mode === 'retry-import') {
    const {plans:[plan]} = await core.plan(source,[destination],importOptions,metadata);
    const result = await core.execute(plan!,undefined,undefined,{exclusiveCopy:mode === 'import-exclusive',...(process.env.CRASH_STAGED_IMPORT ? {direct:false} : {})});
    return {result,target:plan!.entries[0]!.destination};
  }
  if (mode === 'undo-organization') return {result:await core.undoOrganization(library,id!),jobs:await core.getOrganizationRecovery(library)};
  if (mode === 'resume-organization') return {result:await core.resumeOrganization(library,id!),jobs:await core.getOrganizationRecovery(library)};
  if (mode === 'finalize-intent' || mode === 'finalize-unlink' || mode === 'retry-finalize') return {result:await core.finalizeOrganization(library,id!),jobs:await core.getOrganizationRecovery(library)};
  const {plans:[plan]} = await core.plan(library,[library],organizationOptions,metadata);
  return {result:await organizeAs(mode.startsWith('organization-rename') ? 'rename' : 'copy',plan!),jobs:await core.getOrganizationRecovery(library),target};
}
try {
  let result;
  try {result = await run();}
  finally {await fs.writeFile(finallyMarker,'Worker completed its finally block');}
  process.send!({type:'result',...result},()=>process.disconnect?.());
} catch(error) {
  console.error(error);
  process.exitCode = 1;
  process.disconnect?.();
}
