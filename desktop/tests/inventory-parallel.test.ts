import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {inventory,listingOf} from '../core/inventory';

const mod=createRequire(import.meta.url)('node:fs/promises') as {lstat:typeof fs.lstat};

async function tree(t:test.TestContext){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'inventory-parallel-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(let index=0;index<60;index++)await fs.writeFile(path.join(root,`IMG_${String(index).padStart(3,'0')}.JPG`),'x'.repeat(index+1));
 await fs.mkdir(path.join(root,'DCIM'));
 for(let index=0;index<20;index++)await fs.writeFile(path.join(root,'DCIM',`V${index}.MOV`),'y'.repeat(index+1));
 await fs.writeFile(path.join(root,'half.JPG.partial'),'p');
 await fs.symlink(path.join(root,'IMG_000.JPG'),path.join(root,'link.JPG'));
 await fs.mkdir(path.join(root,'ZZ'));await fs.writeFile(path.join(root,'ZZ','last.JPG'),'z');
 return root;
}

test('entries of a folder are looked at several at a time, in name order, with the same result',async t=>{
 const root=await tree(t);
 const serial=await inventory(root);
 const real=mod.lstat;let running=0,peak=0;
 mod.lstat=((...args:Parameters<typeof fs.lstat>)=>{running++;peak=Math.max(peak,running);return (real as (...a:unknown[])=>Promise<unknown>)(...args).finally(()=>{running--;});}) as typeof fs.lstat;
 let listed;
 try{listed=await inventory(root);}finally{mod.lstat=real;}
 assert.ok(peak>1&&peak<=8+1,'lstat calls at once: '+peak);
 assert.deepEqual(listed.files.map(file=>file.relative),serial.files.map(file=>file.relative));
 const names=listed.files.map(file=>file.relative);
 assert.equal(names.length,81);
 assert.ok(!names.some(name=>name.endsWith('.partial')||name==='link.JPG'),'partials and links are still left out');
 assert.deepEqual(names.slice(0,3),['DCIM/V0.MOV','DCIM/V1.MOV','DCIM/V10.MOV'],'folders keep their name order');
});

test('an lstat error is raised at its own entry, after the entries before it were listed',async t=>{
 const root=await tree(t);
 const real=mod.lstat;
 mod.lstat=((file:string,...rest:unknown[])=>file.endsWith('IMG_030.JPG')?Promise.reject(Object.assign(new Error('boom'),{code:'EIO'})):(real as (...a:unknown[])=>Promise<unknown>)(file,...rest)) as typeof fs.lstat;
 try{await assert.rejects(inventory(root),{message:'boom'});}finally{mod.lstat=real;}
});

test('listingOf builds exactly the listing an inventory reports',async t=>{
 const root=await tree(t),found=await inventory(root,{backup:true});
 assert.ok(found.listing);
 assert.deepEqual(listingOf(found,true,found.listing.folders),found.listing);
 assert.deepEqual(listingOf({files:[{relative:'a.JPG',size:3,path:'/x/a.JPG'} as never]},false,[]),{backup:false,folders:[],files:[{relative:'a.JPG',size:3}]});
});
