import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {Check} from '../harness';
import type {Context} from './context';

export const duplicateChecks=(ctx:Context):Check[]=>[
 {id:'duplicates-scan',stage:'duplicates',title:'Remove duplicates opens on the destination, scans a copied fixture photo and shows its group with previews',covers:['duplicates flow','levels','previews','SHA badge'],run:async h=>{
  await h.prefs({basePath:'photobackup'});
  const library=path.join(ctx.root,'destination','photobackup'),folder=path.join(library,'qa-duplicates');await fs.mkdir(folder,{recursive:true});
  await fs.copyFile(path.join(ctx.root,'source-1','photo.png'),path.join(folder,'photo.png'));await fs.copyFile(path.join(ctx.root,'source-1','photo.png'),path.join(folder,'photo copy.png'));
  try{
   await h.nav('Duplicates');
   await h.until('duplicates page',"document.querySelector('[data-testid=duplicates-scope-select]')");
   const scopes=(await h.state()).duplicates!.scopes;const scope=scopes.find(item=>item.root===library);assert.ok(scope,'The destination library is offered: '+JSON.stringify(scopes));
   await h.action({type:'duplicatesScope',root:scope.root});
   await h.until('scope selected',`document.querySelector('[data-testid=duplicates-scope-select]').value===${JSON.stringify(scope.root)}`);
   for(const level of [1,2,3]){await h.click(`[data-testid=duplicate-level-${level}]`);await h.until(`level ${level}`,`document.querySelector('[data-testid=duplicate-level-${level}]').getAttribute('aria-checked')==='true'`);}
   await h.click('[data-testid=duplicate-level-2]');
   await h.click('[data-testid=duplicates-scan]');
   await h.waitFor('duplicate scan',async()=>(await h.state()).duplicates?.status==='ready',{timeoutMs:60000});
   await h.until('a duplicate group',"document.querySelector('[data-testid=duplicate-group]')");
   assert.equal(await h.js<boolean>("document.querySelectorAll('[data-testid=duplicate-group] [data-testid=keep-file]').length>=2&&document.querySelector('[data-testid=keep-all]')!==null&&document.querySelector('[data-badge=sha]')!==null"),true,'Group shows keep radios and a SHA badge');
   await h.until('a preview',"document.querySelector('[data-testid=duplicate-group] img[src^=\"data:image\"]')");
   assert.equal(await h.js<boolean>("document.querySelector('[data-testid=duplicates-summary]')!==null"),true);
   await h.shot('remove-duplicates');
   // Leave the page first, so its previews stop loading files that are about to go.
   await h.nav('Import desk');
  }finally{await fs.rm(folder,{recursive:true,force:true});await fs.rm(path.join(library,'photo-importer-duplicates.json'),{force:true});}
 }},
];
