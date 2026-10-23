import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {plan,execute,findMisplaced,configureOrganizationRecovery} from '../core/index';
import {findResidue} from '../core/residue';
import {terminateHasher} from '../core/hasher';
import {diskImage,executeAll,put,run,temporary} from './fixtures/edge';
import type {Metadata} from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const options={backup:false as const,template:'{year}/{camera}',layout:'format' as const,unknownRules:{}};
const darwin={skip:process.platform!=='darwin'};
const metadata=async():Promise<Metadata>=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00',fields:{}});

/** The whole-disk device behind a mount, so an image whose volume was unmounted can still be detached. */
async function device(mount:string){
 const {stdout}=await run('df',[mount]);
 const node=stdout.split('\n')[1]?.split(/\s+/)[0]??'';
 return node.replace(/s\d+$/,'');
}
/** Nothing has a file open on the volume, and macOS can unmount it right away. */
async function assertReleased(t:test.TestContext,mount:string,label:string){
 const dev=await device(mount);
 t.after(async()=>{if(dev.startsWith('/dev/'))await run('hdiutil',['detach','-quiet','-force',dev]).catch(()=>{});});
 const open=await run('lsof',['-n',mount]).then(result=>result.stdout.trim(),(error:{code?:number;stdout?:string})=>{if(error.code===1)return (error.stdout??'').trim();throw error;});
 assert.equal(open,'',`${label}: files still open on ${mount}`);
 await run('diskutil',['unmount',mount]);
}
async function pair(t:test.TestContext,name:string){
 const root=await temporary(t,`release-${name}-`);
 const from=await diskImage(root,'16m','HFS+',`${name}SRC`),to=await diskImage(root,'16m','HFS+',`${name}DST`);
 return from&&to?{root,from,to}:undefined;
}
async function card(source:string){
 for(let index=0;index<4;index++)await put(path.join(source,'DCIM','100NIKON',`DSC_000${index}.JPG`),Buffer.alloc(200_000+index,index+1));
}
/** The checks the app runs after a job, on the destination. */
async function checks(destination:string,temporaryFolder:string){
 await findMisplaced(destination,destination,{template:options.template,layout:options.layout},metadata);
 await findResidue([destination],{temporary:temporaryFolder});
}

test('drives can be unmounted at once after a successful import and the library checks',darwin,async t=>{
 const volumes=await pair(t,'OK');
 if(!volumes){t.skip('hdiutil unavailable');return;}
 await card(volumes.from);
 const {plans:[transfer]}=await plan(volumes.from,[volumes.to],options,metadata);
 assert.deepEqual((await executeAll(transfer!)).errors,[]);
 await checks(volumes.to,path.join(volumes.root,'scratch'));
 await terminateHasher();
 await assertReleased(t,volumes.from,'source');
 await assertReleased(t,volumes.to,'destination');
});

test('drives can be unmounted at once after Stop',darwin,async t=>{
 const volumes=await pair(t,'STOP');
 if(!volumes){t.skip('hdiutil unavailable');return;}
 await card(volumes.from);
 const {plans:[transfer]}=await plan(volumes.from,[volumes.to],options,metadata);
 const stop=new AbortController();
 await execute(transfer!,stop.signal,progress=>{if(progress.completed>=1||progress.bytes>0)stop.abort();}).catch(()=>{});
 assert.ok(stop.signal.aborted);
 await checks(volumes.to,path.join(volumes.root,'scratch'));
 await assertReleased(t,volumes.from,'source');
 await assertReleased(t,volumes.to,'destination');
});

test('drives can be unmounted at once after an error while comparing files',darwin,async t=>{
 const volumes=await pair(t,'ERR');
 if(!volumes){t.skip('hdiutil unavailable');return;}
 await card(volumes.from);
 // A same-size file already at the destination that cannot be read, so the comparison fails.
 const clash=path.join(volumes.to,'2024','Nikon Z f','DSC_0001.JPG');
 await put(clash,Buffer.alloc(200_001,9));await fs.chmod(clash,0o000);
 try{
  const {plans:[transfer]}=await plan(volumes.from,[volumes.to],options,metadata);
  await executeAll(transfer!).catch(()=>{});
 }catch{/* The failure itself is not what is checked. */}
 await fs.chmod(clash,0o644).catch(()=>{});
 await checks(volumes.to,path.join(volumes.root,'scratch'));
 await assertReleased(t,volumes.from,'source');
 await assertReleased(t,volumes.to,'destination');
});
