import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inventory} from '../core';

test('a JVC/Panasonic .MOI travels with its .MOD video, and an unpaired one does not',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'companions-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const folder=path.join(root,'SD_VIDEO','PRG001');await fs.mkdir(folder,{recursive:true});
 for(const name of ['MOV001.MOD','MOV001.MOI','MOV002.MOI'])await fs.writeFile(path.join(folder,name),name);
 const found=await inventory(root,{});
 const file=(name:string)=>found.files.find(item=>path.basename(item.path)===name)!;
 assert.equal(file('MOV001.MOD').kind,'Videos');
 assert.equal(file('MOV001.MOI').companionOf,file('MOV001.MOD').path);
 assert.equal(file('MOV002.MOI').included,false);
});
