// Bounded integration runner: enabled only by an explicit fixture QA launch. The checks live in qa/ui/checks and run
// in stages: boot, navigation, imports, organization, duplicates, settings, errors, recovery, rules, stress, final.
// See qa/ui/README.md.
import {nativeTheme,type BrowserWindow} from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {QaHooks} from './hooks';
import {Harness,markdownReport,stages,type Check} from './ui/harness';
import {digest,type Context} from './ui/checks/context';
import {bootChecks} from './ui/checks/boot';
import {navigationChecks} from './ui/checks/navigation';
import {browserChecks} from './ui/checks/browser';
import {realDriveChecks,parseRealDrives} from './ui/checks/real-drives';
import {importChecks} from './ui/checks/imports';
import {organizationChecks} from './ui/checks/organization';
import {duplicateChecks} from './ui/checks/duplicates';
import {settingsChecks} from './ui/checks/settings';
import {errorChecks} from './ui/checks/errors';
import {workspaceFlowChecks} from './ui/checks/workspace-flows';
import {workspaceSafetyChecks} from './ui/checks/workspace-safety';
import {recoveryChecks} from './ui/checks/recovery';
import {ruleChecks} from './ui/checks/rules';
import {stressChecks} from './ui/checks/stress';
import {finalChecks} from './ui/checks/final';

export interface SmokeOptions {uiOnly:boolean;organizationOnly:boolean;/** Runs only checks whose id matches this pattern (final checks always run). */only?:string;/** When the run must have written its report (epoch ms). */deadline?:number;/** JSON list of {destination,basePath}: a read-only browser/preview/EXIF run against real drives. */realDrives?:string}

export function allChecks(ctx:Context):Check[]{
 const checks=[...bootChecks(ctx),...navigationChecks(),...browserChecks(),...realDriveChecks(ctx),...workspaceFlowChecks(),...importChecks(ctx),...organizationChecks(ctx),...duplicateChecks(ctx),...settingsChecks(ctx),...errorChecks(),...recoveryChecks(),...workspaceSafetyChecks(),...ruleChecks(),...stressChecks(),...finalChecks(ctx)];
 // Stable sort: the stages run in their order, checks within a stage in the order written.
 return checks.sort((a,b)=>stages.indexOf(a.stage)-stages.indexOf(b.stage));
}

export async function runCodexSmoke(window:BrowserWindow,root:string,options:SmokeOptions,hooks?:QaHooks):Promise<boolean>{
 const started=Date.now(),suite=options.organizationOnly?'organization':options.uiOnly?'ui':'full';
 const h=new Harness(window,root,hooks);if(options.deadline)h.deadline=options.deadline;
 const originals=new Map<string,string>();
 for(let i=1;i<=6;i++)for(const name of await fs.readdir(path.join(root,`source-${i}`))){const file=path.join(root,`source-${i}`,name);originals.set(file,await digest(file));}
 const marker=path.join(root,'destination','photobackup','existing-marker.txt');originals.set(marker,await digest(marker));
 const second=path.join(root,'destination-2','existing-marker.txt');originals.set(second,await digest(second));
 const previousTheme=nativeTheme.themeSource;
 const stopHeartbeat=h.startHeartbeat();
 let fatal:unknown;let results:Awaited<ReturnType<Harness['run']>>=[];
 try{
  // The start-up splash covers the app; every check (and screenshot) starts once it has been removed.
  await h.waitFor('boot splash removed',()=>h.js<boolean>("document.documentElement.dataset.boot==='done'"),{timeoutMs:60000});
  await h.start();
  const ctx:Context={root,originals,marker,organizationOnly:options.organizationOnly,realDrives:parseRealDrives(options.realDrives),firstState:await h.state(),firstBanner:await h.js<string>("document.querySelector('.dashboard-next-step')?.textContent??''")};
  const only=options.only?new RegExp(options.only):undefined;
  results=await h.run(allChecks(ctx),check=>{
   if(check.suite==='import'&&options.uiOnly)return `not in the ${suite} suite`;
   if(check.suite==='organization'&&options.uiOnly&&!options.organizationOnly)return `not in the ${suite} suite`;
   if(only&&check.stage!=='final'&&!only.test(check.id))return 'not selected';
   return undefined;
  });
 }catch(error){fatal=error;console.error('QA could not start:',error);}
 finally{
  stopHeartbeat();nativeTheme.themeSource=previousTheme;
  const failed=results.filter(result=>result.status==='failed');
  const passed=!fatal&&results.length>0&&failed.length===0;
  try{await fs.writeFile(path.join(h.report,'state.json'),JSON.stringify(await h.state(),null,2));}catch{}
  const seconds=(Date.now()-started)/1000,load=os.loadavg()[0]!;
  const heartbeat={samples:h.heartbeat.samples,starvedMs:h.heartbeat.starved,freezes:h.heartbeat.freezes.length};
  console.log(`QA finished ${results.length} checks in ${seconds.toFixed(0)} s, ${process.uptime().toFixed(0)} s after launch`);
  await fs.writeFile(path.join(h.report,'report.json'),JSON.stringify({suite,passed,seconds,uptime:process.uptime(),load,scale:h.scale,heartbeat,error:fatal?String(fatal):failed.length?`${failed.length} failed: ${failed.map(result=>result.id).join(', ')}`:undefined,
   checks:results.map(result=>({name:result.title,passed:result.status!=='failed',...result}))},null,2));
  await fs.writeFile(path.join(h.report,'report.md'),markdownReport(suite,results,{seconds,load,heartbeat}));
 }
 return !fatal&&results.length>0&&results.every(result=>result.status!=='failed');
}
