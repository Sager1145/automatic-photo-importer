import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {autoEjectDecision,doneSources,ejectDone,ejectSource,offersOriginals,sourceInUse,type EjectDeps,type EjectView} from '../source-eject';
import {deleteOriginals,type VerifiedOriginal} from '../core/originals';
import {defaultPreferences} from '../preferences';
import {MessageError} from '../messages';
import type {Job,Source} from '../shared';

const card:Source={id:'card',name:'Card',path:'/Volumes/CARD',transport:'storage'};
const folder:Source={id:'folder',name:'Shoot',path:'/tmp/shoot',transport:'folder'};
const camera:Source={id:'cam',name:'Camera',path:'',transport:'camera'};
const job=(source:Source,extra:Partial<Job>={}):Job=>({id:'job-'+source.id,source,phase:'complete',backup:false,errors:[],...extra} as Job);
const view=(sources:Source[],jobs:Job[],extra:Partial<EjectView>={}):EjectView=>({sources,jobs,...extra});

test('a source in use is a live, queued or paused job, a scan, a review or a running delete',()=>{
 assert.equal(sourceInUse(view([card],[job(card)]),card),false);
 for(const phase of ['queued','copying','verifying'] as const)assert.equal(sourceInUse(view([card],[job(card,{phase})]),card),true,phase);
 assert.equal(sourceInUse(view([card],[job(card,{phase:'stopped',paused:true})]),card),true);
 assert.equal(sourceInUse(view([card],[job(card,{deletingOriginals:{completed:0,total:3}})]),card),true);
 assert.equal(sourceInUse(view([card],[],{scanningSources:['card']}),card),true);
 assert.equal(sourceInUse(view([card],[],{busyReview:true,reviewSourceId:'card'}),card),true);
 assert.equal(sourceInUse(view([card,folder],[job(folder,{phase:'copying'})]),card),false,'another source being busy does not matter');
});

test('Eject all done picks clean finished drives and folders that nothing uses',()=>{
 const other:Source={...card,id:'other',name:'Other'},failed:Source={...card,id:'failed',name:'Failed'},backupDrive:Source={...card,id:'backup',name:'Backup',path:'/Volumes/BACKUP'};
 const jobs=[job(card),job(folder),job(camera),job(other,{phase:'copying'}),job(failed,{phase:'error'}),job(backupDrive)];
 const found=doneSources(view([card,folder,camera,other,failed,backupDrive],jobs),source=>source.id==='backup');
 assert.deepEqual(found.map(item=>item.id),['card','folder'],'no camera, no running, no failed, no drive holding the backup');
 assert.deepEqual(doneSources(view([card],[job(card,{failedFiles:2} as Partial<Job>)])).length,0);
 assert.deepEqual(doneSources(view([card],[job(card)],{review:{source:card} as never})).length,0,'a pending review is not done');
 assert.deepEqual(doneSources(view([card],[])).length,0,'never imported is not done');
});

/** Dependencies with a temp-directory folder and an injected eject that records instead of ejecting. */
async function harness(t:test.TestContext) {
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'source-eject-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const root=path.join(base,'shoot');await fs.mkdir(root);await fs.writeFile(path.join(root,'IMG_1.JPG'),'photo');
 const shoot:Source={...folder,path:root};
 const state={sources:[card,shoot,camera],jobs:[job(card),job(shoot)]} as EjectView;
 const ejected:string[]=[];
 const deps:EjectDeps={view:()=>state,holdsBackup:()=>false,ejectVolume:async mount=>{ejected.push(mount);},forget:source=>{state.sources=state.sources.filter(item=>item.id!==source.id);state.jobs=state.jobs.filter(item=>item.source.id!==source.id);}};
 return {base,root,shoot,state,ejected,deps};
}

test('ejecting a drive calls the volume eject and forgets the drive; a camera is refused',async t=>{
 const {state,ejected,deps}=await harness(t);
 assert.equal(await ejectSource(deps,card),'ejected');
 assert.deepEqual(ejected,['/Volumes/CARD']);
 assert.ok(!state.sources.some(item=>item.id==='card'));assert.ok(!state.jobs.some(item=>item.source.id==='card'));
 await assert.rejects(ejectSource(deps,camera),(error:MessageError)=>error.key==='error.ejectUnsupported');
 assert.deepEqual(ejected,['/Volumes/CARD']);
});

test('removing a folder never touches the file system',async t=>{
 const {state,root,shoot,ejected,deps}=await harness(t);
 assert.equal(await ejectSource(deps,shoot),'removed');
 assert.deepEqual(ejected,[],'no eject command for a folder');
 assert.ok(!state.sources.some(item=>item.id==='folder'));
 assert.equal(await fs.readFile(path.join(root,'IMG_1.JPG'),'utf8'),'photo','the folder and its files stay');
});

test('a busy source is refused for eject and removal, and a drive holding the backup is refused',async t=>{
 const {state,shoot,ejected,deps}=await harness(t);
 state.jobs=[job(card,{phase:'copying'}),job(shoot,{deletingOriginals:{completed:1,total:2}})];
 await assert.rejects(ejectSource(deps,card),(error:MessageError)=>error.key==='error.ejectInUse');
 await assert.rejects(ejectSource(deps,shoot),(error:MessageError)=>error.key==='error.ejectInUse');
 state.jobs=[job(card)];
 await assert.rejects(ejectSource({...deps,holdsBackup:()=>true},card),(error:MessageError)=>error.key==='error.ejectHoldsBackup');
 assert.deepEqual(ejected,[]);assert.equal(state.sources.length,3);
});

test('Eject all done ejects drives, removes folders, skips busy ones and reports failures',async t=>{
 const {state,root,shoot,ejected,deps}=await harness(t);
 const busyCard:Source={...card,id:'busy',name:'Busy',path:'/Volumes/BUSY'},stuck:Source={...card,id:'stuck',name:'Stuck',path:'/Volumes/STUCK'},broken:Source={...card,id:'broken',name:'Broken',path:'/Volumes/BROKEN'};
 state.sources=[card,shoot,camera,busyCard,stuck,broken];
 state.jobs=[job(card),job(shoot),job(busyCard,{phase:'verifying'}),job(stuck),job(broken)];
 const result=await ejectDone({...deps,ejectVolume:async mount=>{
  if(mount.endsWith('STUCK'))throw new MessageError('error.ejectBusy');
  if(mount.endsWith('BROKEN'))throw new MessageError('error.ejectFailed',{error:'boom'});
  ejected.push(mount);
 }});
 assert.deepEqual(ejected,['/Volumes/CARD']);
 assert.equal(result.ejected,1);assert.equal(result.removed,1);assert.equal(result.skipped,1,'a drive that turns out busy is skipped, not failed');
 assert.deepEqual(result.failed.map(item=>item.name),['Broken']);
 assert.deepEqual(state.sources.map(item=>item.id).sort(),['broken','busy','cam','stuck']);
 assert.equal(await fs.readFile(path.join(root,'IMG_1.JPG'),'utf8'),'photo');
});

test('Delete originals is offered for folders by default and for cards only when allowed, never for cameras',()=>{
 const defaults=defaultPreferences;
 assert.equal(offersOriginals(folder,defaults),true);assert.equal(offersOriginals(card,defaults),false);assert.equal(offersOriginals(camera,defaults),false);
 assert.equal(offersOriginals(card,{...defaults,deleteOriginalsCards:true}),true);
 assert.equal(offersOriginals(folder,{...defaults,deleteOriginalsFolders:false}),false);
 assert.equal(offersOriginals(camera,{deleteOriginalsFolders:true,deleteOriginalsCards:true}),false);
});

test('Delete originals on a card only removes verified files beneath the card root',async t=>{
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'card-originals-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const cardRoot=path.join(base,'CARD'),outside=path.join(base,'OTHER'),backup=path.join(base,'backup');
 for(const dir of [path.join(cardRoot,'DCIM'),outside,backup])await fs.mkdir(dir,{recursive:true});
 const sum=(body:string)=>createHash('sha256').update(body).digest('hex');
 const make=async(file:string,body:string,copy:string):Promise<VerifiedOriginal>=>{await fs.writeFile(file,body);await fs.writeFile(copy,body);return {source:file,size:Buffer.byteLength(body),sha256:sum(body),destinations:[copy]};};
 const inside=await make(path.join(cardRoot,'DCIM','A.JPG'),'aaa',path.join(backup,'a.jpg'));
 const stranger=await make(path.join(outside,'B.JPG'),'bbb',path.join(backup,'b.jpg'));
 const result=await deleteOriginals(cardRoot,[inside,stranger]);
 assert.deepEqual(result.deleted.map(item=>item.source),[inside.source]);
 assert.deepEqual(result.kept,[{source:stranger.source,reason:'unsafe'}]);
 assert.equal(await fs.readFile(stranger.source,'utf8'),'bbb','a file outside the card root is never removed');
 assert.equal(await fs.stat(cardRoot).then(()=>true,()=>false),true,'the card root itself stays');
});

test('auto-eject decision: only clean, verified card imports, and it waits for Delete originals',()=>{
 const prefs={...defaultPreferences,autoEject:true};
 const decide=(overrides:Partial<typeof prefs>={},finished:Job=job(card),source:Source|undefined=card,extra:Partial<EjectView>={},holds=()=>false)=>autoEjectDecision(view([card,folder],[finished],extra),finished,source,{...prefs,...overrides},holds);
 assert.equal(decide(),'eject');
 assert.equal(decide({autoEject:false}),'no','off by default');
 assert.equal(decide({},job(folder),folder),'no','never for a folder');
 assert.equal(decide({},job(camera),camera),'no','never for a camera');
 assert.equal(decide({},job(card,{phase:'error'})),'no');
 assert.equal(decide({},job(card,{failedFiles:1} as Partial<Job>)),'no');
 assert.equal(autoEjectDecision(view([folder],[job(card)]),job(card),undefined,prefs),'no','a drive already unplugged');
 assert.equal(decide({},job(card),card,{review:{source:card} as never}),'no','an open review');
 assert.equal(decide({verifyCopies:false}),'no','copies were not read back');
 assert.equal(decide({verifyCopies:false},job(card,{alreadyImported:true})),'eject','everything was already verified in the backup');
 assert.equal(decide({},job(card),card,{},()=>true),'no','a drive that holds the backup');
 assert.equal(decide({deleteOriginalsCards:true},job(card,{verifiedOriginals:12})),'wait','deletable originals are waiting');
 assert.equal(decide({deleteOriginalsCards:true},job(card,{verifiedOriginals:12,deletingOriginals:{completed:1,total:12}})),'wait');
 assert.equal(decide({deleteOriginalsCards:true},job(card,{verifiedOriginals:2,originalsDeleted:{files:10,bytes:1,kept:2}})),'eject','after Delete originals finished');
 assert.equal(decide({deleteOriginalsCards:false},job(card,{verifiedOriginals:12})),'eject','nothing waits when cards do not offer deletion');
 const older=job(card,{id:'older'}),newer=job(card,{id:'newer',phase:'copying'});
 assert.equal(autoEjectDecision(view([card],[newer,older]),older,card,prefs),'no','a newer import is running');
});
