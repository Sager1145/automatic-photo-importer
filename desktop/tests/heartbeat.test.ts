import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHmac,randomUUID} from 'node:crypto';
import * as core from '../core/index';
import {findResidue} from '../core/residue';
import {heartbeat,slowFileSystem} from './fixtures/slow-fs';
import type {Metadata} from '../shared';

// "No phase may show a frozen counter": with every file-system call taking 20 ms (a slow USB drive), each of these
// operations still reports progress at least every three seconds (two plus a margin for a loaded machine).
const secret='fixture-only-host-recovery-secret-32bytes';
core.configureOrganizationRecovery(secret);
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2026-10-03T12:00:00',fields:{}});
const base={backup:false,template:'{year}/{yyyymm}/{camera}',unknownRules:{}};
const LIMIT=3;

async function organized(t:test.TestContext,count=24){
 core.setConversionGate(()=>false);
 const drive=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'heartbeat-')));
 t.after(()=>fs.rm(drive,{recursive:true,force:true}));
 const photos=path.join(drive,'photobackup'),card=path.join(drive,'2025');
 for(const folder of [photos,card])await fs.mkdir(folder,{recursive:true});
 for(let index=0;index<count;index++)await fs.writeFile(path.join(card,`IMG_${String(index).padStart(4,'0')}.JPG`),'bytes of '+index);
 const plan=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['2025']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(plan,undefined,undefined,{strategy:'copy'})).errors,[]);
 const [journal]=await core.getOrganizationRecovery(photos);const id=journal!.id;
 const folder=path.join(photos,'Photo Importer Recovery',id),log=path.join(folder,'event-log.jsonl');
 return {drive,photos,card,id,folder,log};
}
/** The journal's events rewritten one file each, as versions before the event log kept them, plus `extra` more. */
async function legacy(t:test.TestContext,extra:number){
 const f=await organized(t,6);
 const lines=(await fs.readFile(f.log,'utf8')).split('\n').filter(Boolean);
 for(let index=0;index<extra;index++){const record={id:f.id,root:f.photos,event:'checked',index:0,at:new Date(Date.UTC(2026,9,21,0,0,0,index)).toISOString()};lines.push(JSON.stringify({...record,seal:createHmac('sha256',secret).update(JSON.stringify(record)).digest('hex')}));}
 for(const line of lines)await fs.writeFile(path.join(f.folder,`event-${randomUUID()}.json`),line);
 await fs.rm(f.log);
 return f;
}
/** Runs `work` with the slow file system, hearing its progress through the `beat` it is given. */
async function measured(work:(beat:(...args:unknown[])=>void)=>Promise<unknown>){
 const pulse=heartbeat(),restore=slowFileSystem(20);
 try{await work(pulse.beat);}finally{restore();pulse.finish();}
 return pulse;
}
const within=(name:string,pulse:ReturnType<typeof heartbeat>)=>assert.ok(pulse.longest()<=LIMIT&&pulse.beats>=3,`${name}: ${pulse.beats} reports, longest silence ${pulse.longest().toFixed(2)} s (${pulse.where()})`);

test('planning reports at least every 3 s',async t=>{
 const drive=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'heartbeat-plan-')));
 t.after(()=>fs.rm(drive,{recursive:true,force:true}));
 const photos=path.join(drive,'photobackup'),card=path.join(drive,'2025');
 for(const folder of [photos,card])await fs.mkdir(folder,{recursive:true});
 for(let index=0;index<30;index++)await fs.writeFile(path.join(card,`IMG_${String(index).padStart(4,'0')}.JPG`),'bytes of '+index);
 const pulse=await measured(beat=>core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['2025']},metadata,undefined,beat));
 within('plan',pulse);
});

test('reading a legacy journal (readEvents) reports at least every 3 s',async t=>{
 const {photos}=await legacy(t,200);
 const pulse=await measured(beat=>core.getOrganizationRecovery(photos,{verifyContents:false,onProgress:beat}));
 within('readEvents',pulse);
});

test('converting a legacy journal (compaction) reports at least every 3 s',async t=>{
 const {photos,folder}=await legacy(t,200);
 core.setConversionGate(()=>true);
 const steps=new Set<string>();
 const pulse=await measured(beat=>core.getOrganizationRecovery(photos,{verifyContents:false,onProgress:update=>{if(update.convert)steps.add(update.convert.step);beat(update);}}));
 assert.deepEqual([...steps].sort(),['cleaning','converting']);
 assert.deepEqual((await fs.readdir(folder)).filter(name=>/^event-.*\.json$/.test(name)),[]);
 within('compaction',pulse);
});

test('placedByEarlierJournals reports at least every 3 s',async t=>{
 const {photos}=await legacy(t,200);
 const pulse=await measured(beat=>core.placedByEarlierJournals(photos,undefined,beat));
 within('placedByEarlierJournals',pulse);
});

test('the organization listing reports at least every 3 s',async t=>{
 const {photos}=await organized(t,12);
 const pulse=await measured(beat=>core.getOrganizationRecovery(photos,{verifyContents:false,onProgress:beat}));
 within('getOrganizationRecovery',pulse);
});

test('finalize reports at least every 3 s',async t=>{
 const {photos,id}=await organized(t,12);
 const pulse=await measured(beat=>core.finalizeOrganization(photos,id,undefined,beat));
 within('finalize',pulse);
});

test('undo reports at least every 3 s',async t=>{
 const {photos,id}=await organized(t,12);
 const pulse=await measured(beat=>core.undoOrganization(photos,id,undefined,beat));
 within('undo',pulse);
});

test('deleting the recovery files reports at least every 3 s',async t=>{
 const {photos,id}=await legacy(t,150);
 const pulse=await measured(beat=>core.deleteOrganizationRecovery(photos,id,undefined,beat));
 within('delete',pulse);
});

test('the leftovers look reports at least every 3 s',async t=>{
 const {photos}=await legacy(t,150);
 const pulse=await measured(beat=>findResidue([photos],{onProgress:beat}));
 within('residue',pulse);
});
