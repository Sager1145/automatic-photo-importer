import assert from 'node:assert/strict';
import type {Action,ResidueStatus} from '../../../shared';
import type {Check,Harness} from '../harness';
import {syntheticJob} from '../synthetic';

const sheet='[data-testid=cleanup-confirmation]';
const confirm='[data-testid=cleanup-confirm]';
const maintenance='[data-testid=residue-cleanup] .settings-row button';
const fixture=():ResidueStatus=>({files:15,bytes:10000,resumable:{files:3,bytes:1200},kept:{files:2,bytes:2300},unbound:{files:4,paths:['/Volumes/QA synthetic/kept.nef']},recoverable:{files:1,bytes:5000,folder:'/Volumes/QA synthetic/recoverable'},checkedAt:'2026-10-23T12:00:00Z'});
const needsGuard=async(h:Harness)=>h.hooks&&'beforeAction' in h.hooks?undefined:'needs the QA injection hook with the cleanup action guard';
const cancel=async(h:Harness)=>{
 if(await h.js<boolean>(`!!document.querySelector('${sheet}')`)){
  assert.equal(await h.click(`${sheet} [data-autofocus]`),true,'Cancel remains available');
  await h.until('cleanup sheet cancelled',`!document.querySelector('${sheet}')`);
 }
};
const open=async(h:Harness,selector=maintenance)=>{
 await h.until('cleanup entry available',`document.querySelector(${JSON.stringify(selector)})?.disabled===false`);
 assert.equal(await h.click(selector),true);
 await h.until('cleanup confirmation open',`document.querySelector('${sheet}')?.open===true`);
 await h.settle();
};
/** Catch every raw cleanup call before it can scan or remove any file. Even a regression
 * that skips the sheet is recorded and blocked rather than touching fixture storage. */
async function guarded(h:Harness,run:(cleanups:Action[])=>Promise<void>){
 const hooks=h.hooks!,previousGuard=hooks.beforeAction,initial=hooks.peek(),residue=initial.residue,jobs=[...initial.jobs],cleanups:Action[]=[];
 hooks.beforeAction=action=>{if(action.type==='cleanResidue'){cleanups.push(action);return false;}return previousGuard?.(action);};
 try{await run(cleanups);}finally{
  try{await cancel(h);}finally{hooks.set('residue',residue);hooks.set('jobs',jobs);hooks.beforeAction=previousGuard;}
 }
}
// Recovery and Issues are task routes supplied by the integrated workspace harness.
const nav=(h:Harness,page:'Recovery'|'Issues')=>h.nav(page as Parameters<Harness['nav']>[0]);

export const workspaceSafetyChecks=():Check[]=>[
 {id:'recovery-cleanup-confirmation',stage:'recovery',title:'Library maintenance previews cleanup consequences; opening or cancelling never dispatches cleanup',covers:['cleanup consequence preview','manual cleanup confirmation','receipt-only cleanup keeps named files','recoverable copies retained','Cancel focused'],skip:needsGuard,run:async h=>{
  await h.idle();
  await guarded(h,async cleanups=>{
   h.hooks!.set('residue',fixture());await nav(h,'Recovery');
   await open(h);
   assert.deepEqual(cleanups,[],'Opening maintenance must not dispatch raw cleanup');
   assert.equal(await h.js<boolean>(`document.querySelector('${sheet} [data-autofocus]')===document.activeElement`),true,'Cancel gets initial focus');
   const text=await h.js<string>(`document.querySelector('${sheet}').textContent`);
   for(const value of ['Estimated removable files: 10 (5 KB).','Other leftover files and folders','Resumable staging copies','Kept staging copies','Old copy receipts','4 receipts cleared; named files kept','Recoverable complete copies','1 retained (5 KB)','Manual cleanup also deletes resumable and kept staging copies.','The files named by old copy receipts are kept.','Recoverable complete copies are retained.'])assert.ok(text.includes(value),value);
   assert.equal(await h.js<boolean>(`document.querySelector('${confirm}').disabled`),false);
   await h.shot('activity-cleanup-confirmation');await cancel(h);
   assert.deepEqual(cleanups,[],'Cancelling maintenance must not dispatch raw cleanup');
   assert.deepEqual((await h.state()).residue,fixture(),'Opening/cancelling leaves residue untouched');

   // The staging-left issue used to call cleanResidue directly; it must share the global sheet.
   const warning={...syntheticJob('cleanup-warning',{phase:'complete'}),groups:[{code:'staging-left',severity:'warning' as const,count:3,items:[{path:'/Volumes/QA synthetic/stage.tmp'}]}]};
   h.hooks!.addJobs([warning]);await nav(h,'Issues');
   await open(h,'[data-testid=error-group-cleanup]');
   assert.deepEqual(cleanups,[],'Staging-left cleanup must open the sheet instead of dispatching');
   await cancel(h);assert.deepEqual(cleanups,[]);
   assert.equal((await h.state()).jobs.find(job=>job.id===warning.id)?.groups?.[0]?.count,3,'Cancel keeps the staging warning');
  });
 }},
 {id:'recovery-cleanup-locks',stage:'recovery',title:'Cleanup confirmation tracks active/paused work, checking and unknown counts while Cancel remains available',covers:['cleanup busy/checking locks','paused jobs lock cleanup','unknown cleanup preview cannot confirm','no destructive fixture cleanup'],skip:needsGuard,run:async h=>{
  await h.idle();
  await guarded(h,async cleanups=>{
   const jobs=[...h.hooks!.peek().jobs];h.hooks!.set('residue',fixture());await nav(h,'Recovery');
   for(const paused of [false,true]){
    await open(h);
    const busy=syntheticJob(paused?'cleanup-paused':'cleanup-busy',paused?{phase:'stopped',paused:true}:{phase:'copying'});
    h.hooks!.set('jobs',[busy,...jobs]);
    await h.until('cleanup disabled while work is active or paused',`document.querySelector('${confirm}')?.disabled===true`);
    await h.click(confirm);assert.deepEqual(cleanups,[],'A disabled busy confirmation must not dispatch');
    await cancel(h);
    assert.equal(await h.js<boolean>(`document.querySelector('${maintenance}').disabled`),true,'Maintenance entry also locks during work');
    h.hooks!.set('jobs',jobs);
   }
   await open(h);h.hooks!.set('residue',{...fixture(),checking:true});
   await h.until('cleanup disabled during residue check',`document.querySelector('${confirm}')?.disabled===true`);
   await h.click(confirm);assert.deepEqual(cleanups,[],'Checking confirmation must not dispatch');await cancel(h);
   assert.equal(await h.js<boolean>(`document.querySelector('${maintenance}').disabled`),true,'Checking also locks maintenance entry');

   h.hooks!.set('residue',undefined);await open(h);
   assert.equal(await h.js<boolean>(`document.querySelector('${confirm}').disabled`),true,'Unknown residue cannot confirm');
   assert.ok((await h.js<string>(`document.querySelector('${sheet}').textContent`)).includes('Not checked yet.'));
   await h.click(confirm);await cancel(h);assert.deepEqual(cleanups,[],'Unknown preview can only be cancelled');
  });
 }},
];
