import fs from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';

const [mode,selected,id] = process.argv.slice(2);
const base = await fs.realpath(selected!);
const temporary = await fs.realpath(os.tmpdir());
const relative = path.relative(temporary,base);
if (!path.basename(base).startsWith('process-crash-') || !relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Crash worker requires its own temporary fixture');
const source = path.join(base,'source');
const destination = path.join(base,'destination');
const library = path.join(base,'library');
const original = path.join(library,'incoming','A.JPG');
const target = path.join(library,'2024','202402','FixtureCamera','JPEG','A.JPG');
const recovery = path.join(library,'.photo-importer-recovery');
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
  for (const slot of await fs.readdir(entry)) {
    const names = await fs.readdir(path.join(entry,slot));
    if (names.length) return path.join(entry,slot,names[0]!);
  }
  throw new Error('No retained original found');
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
  if (mode === 'import-stage' || mode === 'import-exclusive' || mode === 'organization-exclusive') {
    fs.open = async(...args:Parameters<typeof fs.open>)=>{
      const handle = await open(...args), file = String(args[0]);
      if (args[1] === 'wx' && (mode === 'import-stage' ? path.basename(file).startsWith('.import-') && file.endsWith('.partial') : mode==='import-exclusive'?file===path.join(destination,'A.bin'):file === target)) shortWrite(handle,file);
      return handle;
    };
  }
  if (mode === 'organization-exclusive' || mode === 'organization-publish') {
    fs.link = async(from,to)=>{
      if (String(to) === target && mode === 'organization-exclusive') throw Object.assign(new Error('Fixture filesystem has no hard links'),{code:'ENOTSUP'});
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
  core.configureOrganizationRecovery('process-crash-host-authentication-secret-32bytes');
  if (mode === 'import-stage' || mode === 'import-exclusive' || mode === 'retry-import') {
    const {plans:[plan]} = await core.plan(source,[destination],importOptions,metadata);
    const result = await core.execute(plan!,undefined,undefined,{exclusiveCopy:mode === 'import-exclusive'});
    return {result,target:plan!.entries[0]!.destination};
  }
  if (mode === 'undo-organization') return {result:await core.undoOrganization(library,id!),jobs:await core.getOrganizationRecovery(library)};
  if (mode === 'resume-organization') return {result:await core.resumeOrganization(library,id!),jobs:await core.getOrganizationRecovery(library)};
  if (mode === 'finalize-intent' || mode === 'finalize-unlink' || mode === 'retry-finalize') return {result:await core.finalizeOrganization(library,id!),jobs:await core.getOrganizationRecovery(library)};
  const {plans:[plan]} = await core.plan(library,[library],organizationOptions,metadata);
  const strategy = mode.startsWith('organization-rename') ? 'rename' as const : 'copy' as const;
  return {result:await core.executeReorganization(plan!,undefined,undefined,{strategy}),jobs:await core.getOrganizationRecovery(library),target};
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
