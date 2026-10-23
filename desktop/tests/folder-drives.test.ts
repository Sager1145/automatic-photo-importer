import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile,execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {resolveFolderSources} from '../folder-sources';
import {driveContext} from '../drive-groups';
import {DeviceStreams,deviceHasRoom} from '../core/devices';
import {nextRunnable} from '../queue-order';
import {destinationSpace,freeAfterReservations} from '../core/allocation';
import {I18nProvider,languages,createTranslator} from '../renderer/i18n';
import {DriveLabel,SameDriveNotice,SharedCapacityNote,SourceSpace} from '../renderer/RootApp';
import type {Source,TransferPlan} from '../shared';

const run=promisify(execFile);
const hasHdiutil=process.platform==='darwin'&&(()=>{try{execFileSync('which',['hdiutil']);return true;}catch{return false;}})();

/** Small HFS+ images mounted under /Volumes; each is detached afterwards. */
async function volumes(t:test.TestContext,names:string[]):Promise<string[]> {
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'folder-drives-')));
 const unique=`${process.pid}${Date.now().toString(36)}`;
 const mounts:string[]=[];
 t.after(async()=>{for(const mount of mounts)await run('hdiutil',['detach','-quiet','-force',mount]).catch(()=>{});await fs.rm(base,{recursive:true,force:true});});
 for(const name of names) {
  const image=path.join(base,`${name}.dmg`),volname=`${name}${unique}`;
  await run('hdiutil',['create','-quiet','-size','8m','-fs','HFS+','-volname',volname,image]);
  await run('hdiutil',['attach','-quiet','-nobrowse',image]);
  mounts.push(await fs.realpath(`/Volumes/${volname}`));
 }
 return mounts;
}
const folder=async(root:string,relative:string)=>{const target=path.join(root,relative);await fs.mkdir(target,{recursive:true});return target;};
const hdd=async()=>'hdd' as const;

test('folders chosen together are grouped by the drive they are on, and flagged when on the destination drive',{skip:!hasHdiutil&&'needs hdiutil on macOS',timeout:600000},async t=>{
 const [one,two,dest]=await volumes(t,['DRVONE','DRVTWO','DRVDEST']);
 const a1=await folder(one!,'Trip A'),a2=await folder(one!,'Trip B'),b1=await folder(two!,'Wedding'),d1=await folder(dest!,'Loose photos');
 const backup=await folder(dest!,'Backups');
 const {sources,rejected}=await resolveFolderSources([a1,a2,b1,d1],{sources:[],registered:new Map(),destinations:[backup],backupFolders:['photobackup'],backup:false,kindOf:hdd});
 assert.deepEqual(rejected,[]);
 const by=new Map(sources.map(source=>[source.path,source]));
 const [sa1,sa2,sb1,sd1]=[a1,a2,b1,d1].map(file=>by.get(file)!);
 // Grouping metadata: volume id, name and mount path, and the physical device.
 assert.equal(sa1.drive!.volumeId,sa2.drive!.volumeId);
 assert.equal(sa1.drive!.device,sa2.drive!.device);
 assert.equal(sa1.drive!.mount,one);assert.equal(sa1.drive!.name,path.basename(one!));
 assert.equal(sb1.drive!.mount,two);
 assert.notEqual(sa1.drive!.volumeId,sb1.drive!.volumeId);assert.notEqual(sa1.drive!.volumeId,sd1.drive!.volumeId);
 assert.ok(!sa1.drive!.volumeId.startsWith('filesystem:'),'the volume is identified by its volume id');
 assert.equal(sa1.drive!.kind,'hdd');
 // Only the folder on the destination's own drive is flagged.
 assert.deepEqual([sa1,sa2,sb1,sd1].map(source=>source.drive!.sameAsDestination),[false,false,false,true]);
 // Folders on one drive read its capacity once; each drive keeps its own.
 assert.equal(sa1.total,sa2.total);assert.equal(sa1.free,sa2.free);
 const first=driveContext(sa1,sources),second=driveContext(sa2,sources),other=driveContext(sb1,sources);
 assert.deepEqual([first!.shared,first!.showsCapacity,second!.shared,second!.showsCapacity,second!.leader.id],[1,true,1,false,sa1.id]);
 assert.deepEqual([other!.shared,other!.showsCapacity],[0,true]);
 // Live destination state decides the notice once destinations are known.
 assert.equal(driveContext(sd1,sources,[{volumeId:sd1.drive!.volumeId,available:true}])!.onDestination,true);
 assert.equal(driveContext(sd1,sources,[{volumeId:sa1.drive!.volumeId,available:true}])!.onDestination,false);
});

test('a folder inside the backup on the destination drive is still rejected, not treated as the destination',{skip:!hasHdiutil&&'needs hdiutil on macOS',timeout:600000},async t=>{
 const [dest]=await volumes(t,['DRVBACKUP']);
 const backup=await folder(dest!,'Backups'),inside=await folder(dest!,'Backups/photobackup/2024'),beside=await folder(dest!,'Camera dump');
 const {sources,rejected}=await resolveFolderSources([inside,beside],{sources:[],registered:new Map(),destinations:[backup],backupFolders:['photobackup'],backup:false,kindOf:hdd});
 assert.deepEqual(rejected.map(item=>item.key),['error.alreadyInBackup']);
 assert.deepEqual(sources.map(source=>[source.path,source.drive!.sameAsDestination]),[[beside,true]]);
});

const folderSource=(name:string,volumeId:string,device:string,kind:'hdd'|'ssd'='hdd'):Source=>({id:`folder:/${name}`,name,path:`/${name}`,transport:'folder',drive:{volumeId,name:volumeId,mount:`/${volumeId}`,device,kind,sameAsDestination:false}});

test('two jobs on one physical device share its limit; jobs on other devices run in parallel',()=>{
 const a=folderSource('a','vol1','disk1'),b=folderSource('b','vol2','disk1'),c=folderSource('c','vol3','disk2');
 // Different volumes of one disk still count as one device.
 assert.equal(deviceHasRoom(b.drive,[a.drive]),false);
 assert.equal(deviceHasRoom(c.drive,[a.drive]),true);
 assert.equal(deviceHasRoom(b.drive,[]),true);
 assert.equal(deviceHasRoom(undefined,[a.drive,a.drive]),true,'cards and cameras are never held back');
 const fast=folderSource('d','vol4','disk3','ssd');
 assert.deepEqual([1,2,3,4].map(count=>deviceHasRoom(fast.drive,Array(count).fill(fast.drive))),[true,true,true,false]);
 // The queue skips a held-back job rather than stalling behind it.
 const jobs=[c,b,a].map((source,index)=>({id:`j${index}`,phase:'queued',source}));
 const running=[a.drive];
 assert.equal(nextRunnable(jobs,[],job=>deviceHasRoom(job.source.drive,running))?.source.name,'c');
 const sameOnly=jobs.filter(job=>job.source.name!=='c');
 assert.equal(nextRunnable(sameOnly,[],job=>deviceHasRoom(job.source.drive,running)),undefined);
 assert.equal(nextRunnable(sameOnly,[],job=>deviceHasRoom(job.source.drive,[]))?.source.name,'a');
});

test('the device limit applies across jobs: two jobs on one HDD never read in parallel',async t=>{
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'job-streams-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const streams=new DeviceStreams(hdd),files=['a','b','c','d'].map(name=>path.join(base,name));
 await streams.kind(base);
 let active=0,most=0;
 const job=(mine:string[])=>Promise.all(mine.map(file=>streams.run([file],async()=>{active++;most=Math.max(most,active);await new Promise(resolve=>setTimeout(resolve,10));active--;})));
 await Promise.all([job(files.slice(0,2)),job(files.slice(2))]);
 assert.equal(most,1);
});

test('a source sharing the destination drive draws on the free space every other job on it shares',()=>{
 const plan={entries:[{id:'1',source:'/s/a',destination:'/d/a',size:600,kind:'RAW',skip:false,family:'a'},{id:'2',source:'/s/b',destination:'/d/b',size:300,kind:'RAW',skip:true,family:'b'}],root:'/d',source:'/s',rootIdentity:''} as unknown as TransferPlan;
 const space=destinationSpace(plan,1000,true);
 assert.equal(space.sameDrive,true);assert.equal(space.needed,1200);assert.equal(space.existing,300);
 assert.equal(destinationSpace(plan,1000).sameDrive,undefined);
 // Another job already claimed 500 of the shared volume; a different volume is untouched.
 const held=new Map([['other',[{volume:'vol-dest',bytes:500}]]]);
 assert.deepEqual(freeAfterReservations('me',[{path:'/d',volumeId:'vol-dest',free:1000},{path:'/e',volumeId:'vol-else',free:1000}],held),[500,1000]);
 assert.deepEqual(freeAfterReservations('other',[{path:'/d',volumeId:'vol-dest',free:1000}],held),[1000]);
 assert.deepEqual(freeAfterReservations('me',[{path:'/d',volumeId:'vol-dest',free:100}],held),[0]);
});

const render=(node:unknown,props:object,language:typeof languages[number]='en')=>renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(node as never,props)}));
const context=(name:string,shared:number,showsCapacity:boolean,onDestination=false)=>({name,shared,showsCapacity,onDestination,leader:folderSource('Trip A','v','d')});

test('cards name the drive, tag folders that share it and show its capacity once',()=>{
 const single=render(DriveLabel,{drive:context('Photos SSD',0,true)});
 assert.ok(single.includes('Photos SSD'));assert.ok(!single.includes('same-drive-tag'));
 const grouped=render(DriveLabel,{drive:context('Photos SSD',1,true)});
 assert.ok(grouped.includes('data-testid="same-drive-tag"'));assert.ok(grouped.includes('Same drive'));
 const note=render(SharedCapacityNote,{drive:context('Photos SSD',1,false)});
 assert.ok(note.includes('data-testid="shared-capacity"'));assert.ok(note.includes('Same drive as Trip A'));
 for(const language of languages) {
  const translate=createTranslator(language);
  assert.ok(render(DriveLabel,{drive:context('X',1,true)},language).includes(translate('Same drive')));
  assert.ok(render(SharedCapacityNote,{drive:context('X',1,false)},language).includes(translate('Same drive as {name}. Its capacity is shown there.',{name:'Trip A'})));
 }
});

test('a folder on the backup drive explains the cost of copying and offers Organize instead, in every language',()=>{
 const acts:unknown[]=[];
 const markup=render(SameDriveNotice,{sourceId:'folder:/x',act:(action:unknown)=>acts.push(action)});
 assert.ok(markup.includes('data-testid="same-drive-destination"'));
 assert.ok(markup.includes('Importing copies the files, which uses space on this drive.'));
 assert.ok(markup.includes('Organize instead (move, no extra space)'));
 assert.ok(render(SameDriveNotice,{sourceId:'x',act:()=>{},disabled:true}).includes('disabled'));
 for(const language of languages) {
  const translate=createTranslator(language),text=render(SameDriveNotice,{sourceId:'x',act:()=>{}},language);
  for(const key of ['This folder is on the same drive as your backup. Importing copies the files, which uses space on this drive.','Organize instead (move, no extra space)']) {
   assert.ok(text.includes(translate(key)));
   if(language!=='en')assert.notEqual(translate(key),key);
  }
 }
});

test('the space line says when the copy comes out of the source folder\'s own drive',()=>{
 const space={needed:2e9,free:5e9,existing:0,existingFiles:0,newFiles:3,sameDrive:true};
 assert.match(render(SourceSpace,{space:[space]}),/Needs .* of .* free on this same drive/);
 assert.ok(!/same drive/.test(render(SourceSpace,{space:[{...space,sameDrive:undefined}]})));
 for(const language of languages.filter(item=>item!=='en')) {
  const plain=render(SourceSpace,{space:[{...space,sameDrive:undefined}]},language),same=render(SourceSpace,{space:[space]},language);
  assert.notEqual(same,plain);assert.ok(same.includes(createTranslator(language)('Needs {needed} of {free} free on this same drive',{needed:'x',free:'y'}).split('x')[0]!));
 }
});
