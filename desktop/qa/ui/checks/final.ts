import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {Check} from '../harness';
import {digest,type Context} from './context';

export const finalChecks=(ctx:Context):Check[]=>[
 {id:'final-heartbeat',stage:'final',title:'Every long step kept a live counter: no running job, scan, review or check froze its {completed, bytes, file, share} for more than 10 s during the whole run',covers:['every long step shows a live, moving counter'],skip:async h=>h.hooks?undefined:'needs the QA hook to sample the main process',run:async h=>{
  const beat=h.heartbeat;
  await fs.writeFile(path.join(h.report,'heartbeat.json'),JSON.stringify({samples:beat.samples,starvedMs:beat.starved,freezes:beat.freezes},null,2));
  assert.ok(beat.samples>0,'the heartbeat never sampled');
  assert.deepEqual(beat.freezes,[],'frozen counters');
 }},
 {id:'final-originals',stage:'final',title:'Every source original and the existing destination markers retain their exact bytes',covers:['originals are never modified'],run:async()=>{
  for(const [file,hash] of ctx.originals)assert.equal(await digest(file),hash,file);
 }},
];
