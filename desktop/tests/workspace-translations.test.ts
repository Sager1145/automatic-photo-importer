import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceTranslationRows} from '../renderer/workspace-translations';
test('workspace translation rows cover all four locales and retain placeholder names',()=>{
 const keys=new Set<string>();
 for(const line of workspaceTranslationRows.trim().split('\n')) {
  const cells=line.split('|');assert.equal(cells.length,4,line);assert.ok(cells.every(cell=>cell.trim().length>0),line);
  assert.equal(keys.has(cells[0]!),false,line);keys.add(cells[0]!);
  const placeholders=(value:string)=>[...value.matchAll(/\{(.*?)\}/g)].map(match=>match[1]).sort();
  for(const translated of cells.slice(1))assert.deepEqual(placeholders(translated),placeholders(cells[0]!),line);
 }
 for(const key of ['Library tools','Files & folders','Recovery','Space held for undo','Open pending review'])assert.ok(keys.has(key),key);
});
