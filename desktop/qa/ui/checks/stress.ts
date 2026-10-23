import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {groupedCodes} from '../../../error-log';
import {pages,pageTitle,type Check} from '../harness';
import {groupedErrorJobs,LONG_NAME,manyRunningJobs} from '../synthetic';

/** Milliseconds from a navigation click until the new page's title is painted, measured in the renderer. */
const navTime=(page:string)=>`(async()=>{const t0=performance.now();Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent.trim()===${JSON.stringify(page)}).click();while(document.querySelector('.window-titlebar h1')?.textContent!==${JSON.stringify(pageTitle(page as never))})await new Promise(r=>requestAnimationFrame(r));await new Promise(r=>requestAnimationFrame(r));return performance.now()-t0;})()`;

export const stressChecks=():Check[]=>[
 {id:'stress-large-state',stage:'stress',title:'With 50,000 grouped errors, 60 running jobs and long file names the UI stays responsive: a navigation click paints in under 500 ms',covers:['injected large state','responsiveness','grouped errors at scale'],budgetMs:180000,skip:async h=>h.hooks?undefined:'needs the QA injection hook',run:async h=>{
  const errors=groupedErrorJobs(50000),running=manyRunningJobs(60);
  running[0]!.progress!.file=LONG_NAME;
  h.hooks!.addJobs([...running,...errors]);
  await h.until('the large state reached the page',"document.querySelector('.import-dashboard .dashboard-metrics')?.textContent.includes('60 /')");
  await h.settle();
  const timings:{page:string;ms:number}[]=[];
  for(let round=0;round<2;round++)for(const page of [...pages.slice(1),pages[0]!]){timings.push({page,ms:Math.round(await h.js<number>(navTime(page)))});await h.settle();}
  const opened=Date.now();await h.click('[data-testid=show-errors]');await h.until('errors panel with grouped rows',"document.querySelector('.activity-dialog')?.open===true&&document.querySelector('.activity-dialog [data-testid=error-group]')");
  const panelMs=Date.now()-opened;
  const rows=await h.js<{groups:number;nodes:number}>("({groups:document.querySelectorAll('.activity-dialog [data-testid=error-group]').length,nodes:document.querySelector('.activity-dialog').querySelectorAll('*').length})");
  await h.shot('stress-all-errors');
  const sorted=timings.map(item=>item.ms).sort((a,b)=>a-b),median=sorted[Math.floor(sorted.length/2)]!;
  await fs.writeFile(path.join(h.report,'stress.json'),JSON.stringify({timings,median,max:sorted.at(-1),panelMs,rows,errors:50000,jobs:running.length+errors.length},null,2));
  console.log(`QA stress: nav median ${median} ms, max ${sorted.at(-1)} ms; All errors opened in ${panelMs} ms with ${rows.groups} group rows and ${rows.nodes} nodes`);
  assert.ok(median<500,`navigation median ${median} ms: ${JSON.stringify(timings)}`);
  // A single slow frame on a loaded machine is tolerated; a page that is slow every time is not.
  assert.ok(timings.filter(item=>item.ms>=500).length<=2,`navigation clicks over 500 ms: ${JSON.stringify(timings)}`);
  assert.equal(rows.groups,errors.reduce((sum,job)=>sum+job.groups!.filter(group=>groupedCodes.has(group.code)).length,0),'every group has one row');
  assert.ok(rows.nodes<20000,`All errors renders ${rows.nodes} nodes; affected files must load only when expanded`);
 }},
];
