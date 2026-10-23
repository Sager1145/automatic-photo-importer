import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Every file the app unlinks in the importing, direct-copy, residue and Delete originals paths must say why
// (logDeletion), so the log can account for each removal. A scan, so a new unlink cannot be added silently.
for(const file of ['core/index.ts','core/residue.ts','core/originals.ts']) {
  test(`every unlink and rmdir in ${file} is followed by a logDeletion`,()=>{
    const source=readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
    const missing:string[]=[];
    for(const match of source.matchAll(/\.(?:unlink|rmdir)\(/g)) {
      const at=match.index!;
      const window=source.slice(at,at+900);
      if(!/logDeletion\(/.test(window)) missing.push(`line ${source.slice(0,at).split('\n').length}`);
    }
    assert.deepEqual(missing,[],`unlogged deletions in ${file}`);
  });
}
