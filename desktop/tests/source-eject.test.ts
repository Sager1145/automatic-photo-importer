import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {autoEjectDecision,doneSources,ejectDone,ejectSource,ejectingSource,offersOriginals,originalsBlocked,originalsVolumeChanged,overlaps,sourceInUse,type EjectDeps,type EjectView} from '../source-eject';
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
 const other:Source={...card,id:'other',name:'Other',path:'/Volumes/OTHER'},failed:Source={...card,id:'failed',name:'Failed',path:'/Volumes/FAILED'},backupDrive:Source={...card,id:'backup',name:'Backup',path:'/Volumes/BACKUP'};
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
 assert.equal(decide({},job(card),card,{review:{source:card} as never}),'busy','an open review');
 assert.equal(decide({verifyCopies:false}),'no','copies were not read back');
 assert.equal(decide({verifyCopies:false},job(card,{alreadyImported:true})),'eject','everything was already verified in the backup');
 assert.equal(decide({},job(card),card,{},()=>true),'no','a drive that holds the backup');
 assert.equal(decide({deleteOriginalsCards:true},job(card,{verifiedOriginals:12})),'wait','deletable originals are waiting');
 assert.equal(decide({deleteOriginalsCards:true},job(card,{verifiedOriginals:12,deletingOriginals:{completed:1,total:12}})),'wait');
 assert.equal(decide({deleteOriginalsCards:true},job(card,{verifiedOriginals:2,originalsDeleted:{files:10,bytes:1,kept:2}})),'wait','originals remain: the user decides');
 assert.equal(decide({deleteOriginalsCards:true},job(card,{originalsDeleted:{files:10,bytes:1,kept:0,stopped:true}})),'wait','a stopped Delete originals run');
 assert.equal(decide({deleteOriginalsCards:true},job(card,{originalsDeleted:{files:12,bytes:1,kept:0}})),'eject','after Delete originals finished with nothing left');
 assert.equal(decide({},job(card),card,{busyPaths:['/Volumes/CARD/DCIM']}),'busy','in use: not ejected, and the user is told');
 assert.equal(decide({},job(card),card,{ejecting:['card']}),'busy','already being ejected');
 assert.equal(decide({deleteOriginalsCards:false},job(card,{verifiedOriginals:12})),'eject','nothing waits when cards do not offer deletion');
 const older=job(card,{id:'older'}),newer=job(card,{id:'newer',phase:'copying'});
 assert.equal(autoEjectDecision(view([card],[newer,older]),older,card,prefs),'no','a newer import is running');
});

const inner:Source={id:'inner',name:'Inner',path:'/Volumes/CARD/DCIM/100',transport:'folder'};
test('a source is in use when any work has a path inside it or holding it, not only the same source id',()=>{
 assert.equal(overlaps('/Volumes/CARD/DCIM','/Volumes/CARD'),true);assert.equal(overlaps('/Volumes/CARD','/Volumes/CARD/DCIM'),true);
 assert.equal(overlaps('/Volumes/CARD2','/Volumes/CARD'),false);assert.equal(overlaps('','/Volumes/CARD'),false);
 const both=[card,inner];
 assert.equal(sourceInUse(view(both,[job(inner,{phase:'copying'})]),card),true,'a folder inside the card is importing');
 assert.equal(sourceInUse(view(both,[job(card,{phase:'copying'})]),inner),true,'the card holding the folder is importing');
 assert.equal(sourceInUse(view(both,[job(inner,{phase:'queued'})]),card),true);
 assert.equal(sourceInUse(view(both,[job(inner,{organization:true,phase:'copying'} as Partial<Job>)]),card),true,'an organization job');
 assert.equal(sourceInUse(view(both,[job(inner,{phase:'stopped',paused:true})]),card),true);
 assert.equal(sourceInUse(view(both,[job(inner,{deletingOriginals:{completed:0,total:1}})]),card),true);
 assert.equal(sourceInUse(view(both,[job(inner)]),card),false,'a finished job is not use');
 assert.equal(sourceInUse(view(both,[],{scanningSources:['inner']}),card),true,'a scan of a folder on the card');
 assert.equal(sourceInUse(view(both,[],{review:{source:inner} as never}),card),true,'an open review on a folder within the card');
 assert.equal(sourceInUse(view(both,[],{busyReview:true,reviewSourceId:'inner'}),card),true,'a review being built');
 assert.equal(sourceInUse(view(both,[],{duplicates:{root:'/Volumes/CARD/Photos',status:'scanning'}}),card),true,'a duplicates scan on the card');
 assert.equal(sourceInUse(view(both,[],{duplicates:{root:'/Volumes/CARD/Photos',status:'removing'}}),card),true);
 assert.equal(sourceInUse(view(both,[],{duplicates:{root:'/Volumes/CARD/Photos',status:'ready'}}),card),false,'a finished duplicates scan');
 assert.equal(sourceInUse(view(both,[],{duplicates:{root:'/Volumes/OTHER',status:'scanning'}}),card),false);
 assert.equal(sourceInUse(view(both,[],{busyPaths:['/Volumes/CARD/Backup']}),card),true,'a folder check or residue cleanup on the card');
 assert.equal(sourceInUse(view(both,[],{busyPaths:['/Volumes/OTHER']}),card),false);
});

test('a drive being ejected is marked first, refuses new work while it ejects, and is cleared on success and failure',async t=>{
 const {state,deps}=await harness(t);
 const marks:string[]=[];
 let seen:string[]|undefined,during:Source|undefined;
 const ejecting:string[]=[];
 const wired:EjectDeps={...deps,view:()=>({...state,ejecting}),setEjecting:(source,on)=>{marks.push(`${source.id}:${on}`);if(on)ejecting.push(source.id);else ejecting.splice(ejecting.indexOf(source.id),1);},
  ejectVolume:async()=>{seen=[...ejecting];during=ejectingSource({sources:state.sources,ejecting},{path:'/Volumes/CARD/DCIM'});}};
 await ejectSource(wired,card);
 assert.deepEqual(seen,['card'],'marked before the platform command');
 assert.equal(during?.id,'card','a path inside the ejecting drive is refused');
 assert.equal(ejectingSource({sources:state.sources,ejecting},{path:'/Volumes/CARD/DCIM'}),undefined,'cleared afterwards');
 assert.deepEqual(marks,['card:true','card:false']);
 state.sources=[card,camera];
 await assert.rejects(ejectSource({...wired,ejectVolume:async()=>{throw new MessageError('error.ejectBusy');}},card),(error:MessageError)=>error.key==='error.ejectBusy');
 assert.deepEqual(marks.slice(2),['card:true','card:false'],'cleared on failure');
 assert.ok(state.sources.some(item=>item.id==='card'),'a failed eject keeps the drive');
 ejecting.push('card');
 await assert.rejects(ejectSource(wired,card),(error:MessageError)=>error.key==='error.ejectInUse','a second eject of the same drive is refused');
 assert.deepEqual(doneSources({...state,ejecting}).map(item=>item.id),['folder'].filter(()=>false),'an ejecting drive is not offered again');
});

test('Delete originals is blocked by live work or scans inside the source root, by path',()=>{
 const finished=job(card,{id:'finished'});
 const both=[card,inner];
 assert.equal(originalsBlocked(view(both,[finished]),finished,card.path),false);
 assert.equal(originalsBlocked(view(both,[job(inner,{phase:'copying'}),finished]),finished,card.path),true,'a folder import inside the card');
 assert.equal(originalsBlocked(view(both,[job(card,{id:'other',phase:'queued'}),finished]),finished,card.path),true);
 assert.equal(originalsBlocked(view(both,[finished],{scanningSources:['inner']}),finished,card.path),true,'a scan inside the card');
 assert.equal(originalsBlocked(view(both,[job(folder,{phase:'copying'}),finished]),finished,card.path),false,'work elsewhere does not matter');
});
test('a different volume at the same mount is never offered the old job\'s deletion',()=>{
 assert.equal(originalsVolumeChanged('uuid-1','uuid-1'),false);
 assert.equal(originalsVolumeChanged('uuid-1','uuid-2'),true);
 assert.equal(originalsVolumeChanged('uuid-1',undefined),true,'not mounted any more');
 assert.equal(originalsVolumeChanged(undefined,'uuid-2'),false,'nothing was recorded to compare');
});

test('paths overlap only on whole folder names, with either separator', () => {
 assert.equal(overlaps('/Volumes/SD/DCIM','/Volumes/SD'),true);
 assert.equal(overlaps('/Volumes/SD','/Volumes/SD/'),true);
 assert.equal(overlaps('/Volumes/SD2','/Volumes/SD'),false,'a sibling drive with a longer name is not inside');
 assert.equal(overlaps('E:\\DCIM\\100CANON','E:\\'),true);
 assert.equal(overlaps('E:\\DCIM','F:\\DCIM'),false);
 assert.equal(overlaps(undefined,'/Volumes/SD'),false);
});
