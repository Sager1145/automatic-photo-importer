import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {identity,makeParent} from '../core/paths';

async function setup(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'make-parent-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const root=path.join(base,'photobackup'),deep=path.join(root,'2024','202402','Nikon Z f','RAW');
 await fs.mkdir(deep,{recursive:true});
 return {base,root,deep};
}
function count(t:test.TestContext){
 const calls={realpath:0,mkdir:0},resolve=fs.realpath.bind(fs),make=fs.mkdir.bind(fs);
 t.mock.method(fs,'realpath',async(...args:Parameters<typeof fs.realpath>)=>{calls.realpath++;return resolve(...args);});
 t.mock.method(fs,'mkdir',async(...args:Parameters<typeof fs.mkdir>)=>{calls.mkdir++;return make(...args);});
 syncBuiltinESMExports();
 return {calls,restore(){t.mock.restoreAll();syncBuiltinESMExports();}};
}

test('an existing folder is accepted with one root check, no mkdir and few path resolutions',async t=>{
 const {root,deep}=await setup(t),id=await identity(root);
 const probe=count(t);
 await makeParent(path.join(deep,'DSC_0001.NEF'),root,id);
 probe.restore();
 assert.equal(probe.calls.mkdir,0);
 // Two containment checks and one root-identity check; the per-part loop used to add two root checks per folder.
 assert.ok(probe.calls.realpath<=3,`realpath called ${probe.calls.realpath} times`);
});

test('a missing folder still goes through the creating loop and is created',async t=>{
 const {root,deep}=await setup(t),id=await identity(root);
 const file=path.join(deep,'Sub','DSC_0002.NEF');
 await makeParent(file,root,id);
 assert.ok((await fs.stat(path.dirname(file))).isDirectory());
});

test('a symbolic link as the parent is refused on every path and nothing is created',async t=>{
 const {base,root}=await setup(t),id=await identity(root);
 await fs.mkdir(path.join(base,'elsewhere'));
 await fs.symlink(path.join(base,'elsewhere'),path.join(root,'2024','link'));
 await assert.rejects(makeParent(path.join(root,'2024','link','DSC.NEF'),root,id),/symbolic link|Unsafe/);
 assert.deepEqual(await fs.readdir(path.join(base,'elsewhere')),[]);
});

test('a root replaced since the plan is refused even when the folder exists',async t=>{
 const {base,root,deep}=await setup(t),id=await identity(root);
 await fs.rename(root,path.join(base,'old'));
 await fs.mkdir(deep,{recursive:true});
 await assert.rejects(makeParent(path.join(deep,'DSC.NEF'),root,id),/identity changed/);
});
