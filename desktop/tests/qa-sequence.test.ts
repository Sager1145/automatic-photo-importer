import test from 'node:test';
import assert from 'node:assert/strict';
import {allChecks} from '../qa/codex-smoke';
import {markdownReport,stages} from '../qa/ui/harness';
import type {Context} from '../qa/ui/checks/context';

const checks=allChecks({root:'/tmp/qa',originals:new Map(),marker:'',firstState:{} as Context['firstState'],firstBanner:'',organizationOnly:false});

test('checks have unique ids, run stage by stage in the documented order, and say what they cover',()=>{
 assert.equal(new Set(checks.map(check=>check.id)).size,checks.length);
 assert.deepEqual([...new Set(checks.map(check=>check.stage))],stages);
 assert.ok(checks.every(check=>check.covers.length>0&&check.title.length>0));
});

test('every standing user rule has a check',()=>{
 const covered=checks.flatMap(check=>check.covers).join('\n');
 for(const rule of ['no super-wide buttons','bars shrink and never clip','animation layering','error toasts always on top','every long step shows a live, moving counter','everything must update','no file name in the overall dashboard','file-name row never moves the stats','locked settings greyed out with tooltip and no error','paused bars turn yellow','stage-coloured layered bars','light and dark mode','reduced motion','4 locales','no missing keys','UI scale 1, 1.25, 1.5, 1.6, 1.75, 2','screenshot set per page and theme','injected large state'])
  assert.ok(covered.includes(rule),`no check covers: ${rule}`);
});

test('the report lists every check with its outcome and coverage, by stage',()=>{
 const report=markdownReport('ui',[{id:'a',stage:'boot',title:'Boots | fast',covers:['x'],status:'passed',ms:1200},{id:'b',stage:'rules',title:'Bars',covers:['y'],status:'skipped',ms:0,reason:'not on this build yet'}],{seconds:61,load:3,heartbeat:{samples:9,starvedMs:0,freezes:0}});
 assert.match(report,/## Boot\n/);assert.match(report,/\| PASS \| Boots \\\| fast \| x \| 1\.2 s \|/);
 assert.match(report,/\| SKIP \| Bars _\(not on this build yet\)_ \| y \|  \|/);
 assert.match(report,/1 passed, 0 failed, 1 skipped/);
});
