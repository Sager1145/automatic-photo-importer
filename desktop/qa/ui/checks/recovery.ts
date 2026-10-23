import assert from 'node:assert/strict';
import {formatMessage} from '../../../messages';
import {settingsCategories,pages,SkipCheck,type Check} from '../harness';
import {assertLive} from './rules';

const english=(message?:Parameters<typeof formatMessage>[0])=>message?formatMessage(message,'en'):'';
const running=['queued','discovering','verifying','copying'];

export const recoveryChecks=():Check[]=>[
 {id:'recovery-journal-recheck',stage:'recovery',suite:'organization',title:'A finished organization can recheck its recovery journal, once even when Resume is clicked twice',covers:['organization recovery','double-click safety'],budgetMs:120000,run:async h=>{
  await h.action({type:'refreshOrganization'});
  await h.waitFor('recovery list loaded',async()=>!(await h.state()).organizationRecoveryLoading);
  const recovery=(await h.state()).organizationRecovery?.find(job=>job.status==='complete');
  if(!recovery)throw new SkipCheck('no finished organization in this run');
  await h.nav('Organization');await h.until('recovery list on the Organization page',"document.querySelector('.organization-recovery')");
  const before=new Set((await h.state()).jobs.map(job=>job.id));
  const resume=JSON.stringify({type:'resumeOrganization',id:recovery.id,root:recovery.root});
  await h.js(`Promise.all([window.importer.action(${resume}),window.importer.action(${resume})])`);
  await h.waitFor('recheck finish',async()=>!(await h.state()).jobs.some(job=>running.includes(job.phase)),{timeoutMs:60000});
  const created=(await h.state()).jobs.filter(job=>!before.has(job.id));
  assert.equal(created.length,1,'Double Resume must create only one recovery job');
  assert.equal(created[0]!.phase,'complete',english(created[0]!.detail));
  await h.action({type:'clearErrors'});
 }},
 {id:'recovery-leftovers-counter',stage:'recovery',title:'Looking for leftover files shows a counter that keeps moving',covers:['live progress counters','leftover files'],skip:async h=>h.hooks?undefined:'needs the QA injection hook',run:async h=>{
  await h.nav('Settings');
  let found=false;for(const id of settingsCategories){await h.settingsTab(id);if(await h.js<boolean>("!!document.querySelector('[data-testid=residue-cleanup]')?.checkVisibility()")){found=true;break;}}
  assert.ok(found,'Leftover files section in Settings');
  let completed=0;
  const tick=()=>h.hooks!.set('residue',{files:3,bytes:9e6,resumable:{files:0,bytes:0},checking:true,progress:{phase:'planning',step:'scanning',completed:++completed*37,total:4000,bytes:0,totalBytes:0,speed:0,file:`.importer-staging/part-${completed}.tmp`,fileRate:180}});
  tick();await h.until('leftover files progress',"document.querySelector('[data-testid=residue-progress]')");
  await assertLive(h,{'leftover files counter':'[data-testid=residue-progress] [data-testid=progress-count]'},tick);
 }},
 {id:'recovery-renderer-reload',stage:'recovery',title:'After the window reloads, the app boots again to the same state and every page still opens',covers:['renderer recovery','boot splash data-boot=done'],run:async h=>{
  const before=await h.state();
  h.window.webContents.reload();
  await h.waitFor('boot finished after reload',async()=>{try{return await h.js<boolean>("document.documentElement.dataset.boot==='done'&&!!document.querySelector('.window-titlebar h1')");}catch{return false;}},{timeoutMs:40000});
  const after=await h.state();
  assert.deepEqual(after.sources.map(source=>source.id),before.sources.map(source=>source.id));
  assert.deepEqual(after.jobs.map(job=>[job.id,job.phase]),before.jobs.map(job=>[job.id,job.phase]));
  assert.equal(after.preferences.language,before.preferences.language);
  for(const page of [...pages.slice(1),pages[0]!])await h.nav(page);
  assert.equal(await h.js<boolean>("document.querySelectorAll('.boot,[data-boot-splash]').length===0"),true,'the splash is gone again');
 }},
];
