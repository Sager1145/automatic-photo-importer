import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Every file the app unlinks in the importing, direct-copy, residue and Delete originals paths, the records store and
// its cleanup, and the converter of earlier records must say why (logDeletion, or the converter's `deleted`), so the
// log can account for each removal. A scan, so a new unlink cannot be added silently. Not deletions: the old name of a
// hard-link move (link, then unlink), and removeTree's own files (its callers log the tree).
const files=['core/index.ts','core/residue.ts','core/originals.ts','core/import-recovery.ts','core/app-store.ts','core/recovery.ts'];
const LOG=/logDeletion\(|deleted\(|deletedDetail\(/g;
/** Whether a log call follows the deletion at `at` in the same block: braces never close between them (so not after
 * a pool's callback, a loop or an if has ended), within one statement's reach. The one block that may end is the
 * deletion's own `try`, whose `catch` (a failed deletion) is stepped over: a deletion that succeeded reaches the log. */
function loggedRightAfter(source:string,at:number):boolean {
  let depth=0;
  for(let i=at;i<Math.min(source.length,at+400);i++){
    const c=source[i];
    if(c==='{')depth++;
    else if(c==='}'&&--depth<0){
      const handler=source.slice(i+1).match(/^\s*catch\s*\([^)]*\)\s*\{/);if(!handler)return false;
      let inner=0,j=i+1+handler[0].length-1;
      for(;j<source.length;j++){if(source[j]==='{')inner++;else if(source[j]==='}'&&--inner===0)break;}
      i=j;depth=0;continue;
    }
    LOG.lastIndex=i;const found=LOG.exec(source);if(found&&found.index===i)return true;
  }
  return false;
}
/** Whether a `try` around the deletion has a `finally` that logs (a count of what was actually removed). */
function loggedInFinally(source:string,at:number):boolean {
  for(let start=source.lastIndexOf('try{',at);start>=0;start=source.lastIndexOf('try{',start-1)){
    let depth=0,end=-1;
    for(let i=start+3;i<source.length;i++){if(source[i]==='{')depth++;else if(source[i]==='}'&&--depth===0){end=i;break;}}
    if(end<at)continue;
    const rest=source.slice(end+1).match(/^\s*finally\s*\{/);if(!rest)continue;
    let inner=0;const from=end+1+rest[0].length-1;
    for(let i=from;i<source.length;i++){if(source[i]==='{')inner++;else if(source[i]==='}'&&--inner===0){LOG.lastIndex=0;return LOG.test(source.slice(from,i));}}
  }
  return false;
}
for(const file of files) {
  test(`every unlink and rmdir in ${file} is logged right after it, or in the finally of a try around it`,()=>{
    const source=readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
    const missing:string[]=[];
    const tree=source.indexOf('export async function removeTree'),treeEnd=tree<0?-1:source.indexOf('\n}\n',tree);
    for(const match of source.matchAll(/\.(?:unlink|rmdir|rm)\(/g)) {
      const at=match.index!;
      if(tree>=0&&at>tree&&at<treeEnd) continue;
      if(/fs\.link\(/.test(source.slice(Math.max(0,at-400),at))) continue;
      if(!loggedRightAfter(source,at)&&!loggedInFinally(source,at)) missing.push(`line ${source.slice(0,at).split('\n').length}`);
    }
    assert.deepEqual(missing,[],`unlogged deletions in ${file}`);
  });
}

test('the rule catches a pool that logs only after it has finished',()=>{
  const pooled="await pool(names,8,async name=>{\n await fs.unlink(name);\n done++;\n});\nlogDeletion('x',folder,'r','p');";
  assert.equal(loggedRightAfter(pooled,pooled.indexOf('.unlink(')),false);
  assert.equal(loggedInFinally(pooled,pooled.indexOf('.unlink(')),false);
  const counted="try{\n await pool(names,8,async name=>{await fs.unlink(name);removed++;});\n}finally{\n if(removed)deleted(folder,'r','p');\n}";
  assert.equal(loggedInFinally(counted,counted.indexOf('.unlink(')),true);
  const guarded="try { await fs.rmdir(folder); } catch(error) { continue; }\nlogDeletion('x',folder,'r','p');";
  assert.equal(loggedRightAfter(guarded,guarded.indexOf('.rmdir(')),true);
});
