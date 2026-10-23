import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Every file the app unlinks in the importing, direct-copy, residue and Delete originals paths, the records store and
// its cleanup, and the converter of earlier records must say why (logDeletion, or the converter's `deleted`), so the
// log can account for each removal. A scan, so a new unlink cannot be added silently. Not deletions: the old name of a
// hard-link move (link, then unlink), and removeTree's own files (its callers log the tree).
const files=['core/index.ts','core/residue.ts','core/originals.ts','core/import-recovery.ts','core/app-store.ts','core/recovery.ts',
  'core/migrate/journals.ts','core/migrate/receipts.ts','core/migrate/caches.ts','core/migrate/folders.ts','core/migrate/pointers.ts'];
for(const file of files) {
  test(`every unlink and rmdir in ${file} is followed by a logDeletion`,()=>{
    const source=readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
    const missing:string[]=[];
    const tree=source.indexOf('export async function removeTree'),treeEnd=tree<0?-1:source.indexOf('\n}\n',tree);
    for(const match of source.matchAll(/\.(?:unlink|rmdir|rm)\(/g)) {
      const at=match.index!;
      if(tree>=0&&at>tree&&at<treeEnd) continue;
      if(/fs\.link\(/.test(source.slice(Math.max(0,at-400),at))) continue;
      const window=source.slice(at,at+900);
      if(!/logDeletion\(|deleted\(/.test(window)) missing.push(`line ${source.slice(0,at).split('\n').length}`);
    }
    assert.deepEqual(missing,[],`unlogged deletions in ${file}`);
  });
}
