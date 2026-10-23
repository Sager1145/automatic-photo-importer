import {app,BrowserWindow,dialog,ipcMain,shell,session,nativeTheme,powerMonitor,powerSaveBlocker} from 'electron';
import {keepAwake} from './keep-awake';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import type {Action,AppState,Preferences,Job,Source,SourceCameraInfo,TransferPlan,DestinationStatus,Inventory,Progress,Review,DestinationSpace,OrganizeOptions,ProblemFile} from './shared';
import {plan,findMisplaced,type PlanProgress,type OrganizationProgress,allocateDestinations,getOrganizationRecovery,resumeOrganization,finalizeOrganization,undoOrganization,deleteOrganizationRecovery,measureOrganizationRecovery,configureOrganizationRecovery,removeOrganizedFolders,RECOVERY_FOLDER,setMoveObserver} from './core';
import {settingsLocked,lockedPreferenceKeys,jobPreferences} from './settings-lock';
import {makeParent,syncParents,within} from './core/paths';
import {rules} from './core/inventory';
import {executeDestinations} from './core/destinations';
import {destinationEntries,destinationParts,destinationSpace,requiredTransferSpace,requiredOrganizationSpace} from './core/allocation';
import {backupDriveIdentity,folderCapacity,getSources,mountedVolumes,volumeInfo,validateDestination,type MountedVolume} from './platform/volumes';
import {driveCameraRecord} from './source-cameras';
import {backupFolders,destinationRoots} from './platform/destination-roots';
import {resolveFolderSources} from './folder-sources';
import {DeviceSelection,deviceId,recordDeviceHistory} from './device-selection';
import {moveToFront,nextQueued,orderSources,queueOrder} from './queue-order';
import {loadScanMemory,saveScanMemory,loadImported,rememberImported} from './platform/scan-memory';
import {loadListingHint,rememberListing} from './platform/listing-memory';
import {listingEstimate,scopeHint,type ListingHint} from './listing-estimate';
import {metadata,closeMetadata,primeRouting,routingEntries,previewFoldersInUse,carryRouting} from './platform/metadata';
import {findResidue,cleanResidue} from './core/residue';
import {prepareCamera,closeCameraBridge} from './platform/camera-bridge';
import {scanSourceInWorker,scansSettled} from './scan-process';
import {terminateHasher} from './core/hasher';
import {runCodexSmoke} from './qa/codex-smoke';
import {runA006HardwareTest,hardwareDestination} from './qa/a006-hardware';
import {createStateChannel} from './state-channel';
import {ErrorLog,clearErrors,gatherErrors} from './error-log';
import {EtaTracker,stampEstimates} from './eta';
import {normalizePreferences} from './preferences';
import {sourcePolicy,freshOrganizeOptions} from './run-policy';
import {measureOriginals,deleteOriginals,type VerifiedOriginal} from './core/originals';
import {filePath,joined,message,MessageError,savedMessage,text,toMessage,type Message} from './messages';
import {deferredRefresh} from './deferred-refresh';

const qa=process.argv.includes('--qa')||process.execPath.includes(' QA.app/');
const hardwareTest=process.argv.includes('--hardware-test-a006');
const qaFixtureRoot=qa?(process.argv.find(arg=>arg.startsWith('--qa-fixture-root='))?.slice('--qa-fixture-root='.length)||path.join(os.tmpdir(),'photo-importer-electron-fixtures')):undefined;

const state:AppState={preferences:normalizePreferences(undefined),sources:[],jobs:[],history:[],platform:process.platform,destinationStatus:[],organizeOptions:freshOrganizeOptions()};
/** The source files each finished folder import copied and verified (by job), for Delete originals already in the backup. Only in memory. */
const importedOriginals=new Map<string,{root:string;files:VerifiedOriginal[]}>();
/** Organizing a folder starts every run with these on; only an explicit choice for the run changes them, and the run uses them up. */
function takeOrganizeOptions():OrganizeOptions{const options={...(state.organizeOptions??freshOrganizeOptions())};state.organizeOptions=freshOrganizeOptions();return options;}
let window:BrowserWindow|undefined;
let timer:NodeJS.Timeout|undefined;
let refreshing=false;
// The recovery listing waits while a review or a job is planning: its file calls would queue ahead of the planner's.
// A file the organization moved keeps its routing metadata under its new path, so the check after the job does not read it again.
setMoveObserver(carryRouting);
const recoveryRefresh=deferredRefresh({planning:()=>!!state.busyReview||state.jobs.some(job=>job.phase==='discovering'||job.phase==='verifying'),run:()=>refreshOrganizations().then(()=>emit()).catch(error=>{state.error=toMessage(error);emit();}).finally(()=>{void releaseIfIdle();})});
let recoveryScope='';
const folders=new Map<string,{source:Source;backup:boolean}>();
const active=new Map<string,AbortController>();
const scanControls=new Map<string,AbortController>();
/** folder: an in-place organization of a chosen folder rather than a backup destination. */
interface OrganizationLocation {root:string;destination:string;volumeId:string;folder?:boolean;}
let organizationLocations:OrganizationLocation[]=[];
const organizationJobIds=new Set<string>();
interface RunRequest {prefs:Preferences;reorganize:boolean;/** Organizing only: this run's choices (default: all on). */options?:OrganizeOptions;sourceFolders?:string[];/** Skip files that fail while planning for this job, whatever the setting. */skipErrors?:boolean;/** Source files the user chose to skip in this job. */exclude?:string[];}
/** Queued jobs the user asked to run again skipping one file (Skip) or every failing file (Skip all). */
const skipRequests=new Map<string,{skipErrors?:boolean;exclude:string[]}>();
const organizationQueue=new Map<string,RunRequest>();
/** What each started organization was asked to do, so a paused one can run again. */
const organizationRuns=new Map<string,RunRequest>();
const resumingOrganizations=new Set<string>();
const automaticallyQueued=new Set<string>();
const seen=new Set<string>();
const approved=new Set<string>();
/** Remaining bytes each job may still write, by destination index. */
const reservations=new Map<string,{volume:string;bytes:number}[]>();
const selection=new DeviceSelection(),pausing=new Set<string>();
// Scans remembered across restarts, per card UUID. Loaded once per connection, verified before reuse.
const rememberedScans=new Map<string,Inventory>(),scanMemoryLoaded=new Set<string>();
const memoryVolume=(source:Source)=>source.transport==='storage'?deviceId(source):undefined;
function rememberScan(source:Source,inventory:Inventory|undefined){
 const volume=memoryVolume(source);if(!volume||!inventory?.listing||qa)return;
 rememberedScans.set(source.id,inventory);
 void saveScanMemory(app.getPath('userData'),volume,source.path,inventory,routingEntries()).catch(()=>{/* Only a cache. */});
}
function loadRememberedScans(){
 const connected=new Set(state.sources.map(source=>source.id));
 for(const id of [...scanMemoryLoaded])if(!connected.has(id)){scanMemoryLoaded.delete(id);rememberedScans.delete(id);}
 for(const source of state.sources){
  const volume=memoryVolume(source);if(!volume||qa||scanMemoryLoaded.has(source.id))continue;
  scanMemoryLoaded.add(source.id);
  void loadScanMemory(app.getPath('userData'),volume,source.path).then(memory=>{
   if(!memory||!state.sources.some(item=>item.id===source.id&&item.path===source.path))return;
   rememberedScans.set(source.id,memory.inventory);primeRouting(memory.routing);
  });
 }
}
/** Remember that a device finished a scan (with the cameras it read) or a verified import, for the reconnection notice and Drives. */
function noteDevice(source:Source,event:'scan'|'import',cameras?:SourceCameraInfo){if(qa)return;const now=new Date().toISOString();recordDeviceHistory(state.preferences.deviceHistory??={},source,event,now,driveCameraRecord(cameras,now));void save().catch(()=>{});}
/** A chosen folder shows the capacity of the volume it lives on. */
async function updateFolderCapacity(source:Source){
 if(source.transport!=='folder')return;
 const capacity=await folderCapacity(source.path),entry=folders.get(source.id);
 if(entry)entry.source={...entry.source,...capacity};
 state.sources=state.sources.map(item=>item.id===source.id?{...item,...capacity}:item);
}
function publishDevices(){state.newDevices=[...selection.newDevices];state.reconnectedDevices=[...selection.reconnectedDevices];}
const reusableScan=(source:Source)=>source.transport==='camera'?undefined:state.sourceInventories?.[source.id]??rememberedScans.get(source.id);
const sessionRules:Preferences['unknownRules']=state.sessionUnknownRules={};
let lastEmit=0;
const livePreferences=new Set(['language','appearance','sourceLayout','showDashboard','textScale','accent','parallel','automatic']);
/** Reserved destination plans for one source. A review holds one until applied. */
interface Prepared {problems:ProblemFile[];review:Review;prefs:Preferences;options:OrganizeOptions;inventory:Inventory;space?:DestinationSpace[];stage?:{path:string;cleanup():Promise<void>};/** Files left out of the plans because of an error; `text` is the English reason for reports. */failures:{path:string;error:Message;text:string}[];skipErrors:boolean;}
let reviewed:Prepared|undefined;
let reviewControl:AbortController|undefined;
const store=()=>path.join(app.getPath('userData'),'settings.json');
const busy=()=>active.size>0;
const stateChannel=createStateChannel(update=>{if(window&&!window.isDestroyed())window.webContents.send('importer:updated',update);});
// Each job carries when it started running and when its current phase began, so elapsed time
// can be shown; both are stamped as the state is published.
const phases=new Map<string,Job['phase']>();
function stampJobs(){
 const now=new Date().toISOString();
 for(const job of state.jobs){
  if(job.phase==='queued'){phases.set(job.id,job.phase);continue;}
  job.startedAt??=now;
  if(phases.get(job.id)!==job.phase){phases.set(job.id,job.phase);job.phaseStartedAt=now;}
 }
 if(phases.size>state.jobs.length*2){const live=new Set(state.jobs.map(job=>job.id));for(const id of phases.keys())if(!live.has(id))phases.delete(id);}
}
// Drives moved to the top (this session): their cards come first and their queued jobs start first.
let sourceOrder:string[]=[];
// When each error appeared and which ones the user cleared; clearing never touches the jobs.
const errorLog=new ErrorLog();
const etaTracker=new EtaTracker();
// A stalled step sends no progress; republish so its time left can grow instead of freezing.
setInterval(()=>{if(state.jobs.some(job=>['discovering','verifying','copying'].includes(job.phase)))emit();},5000).unref();
// Imports and organizations must not stall because the Mac slept or dimmed the display mid-run.
const awake=keepAwake(powerSaveBlocker);
const emit=()=>{stampJobs();awake(state.jobs);stampEstimates(state,etaTracker,Date.now());state.errorLog=errorLog.update(gatherErrors(state));state.sources=orderSources(state.sources,sourceOrder);state.queueOrder=queueOrder(state.jobs,sourceOrder);stateChannel.publish(state);};
function progressEmit(){const now=Date.now();if(now-lastEmit>100){lastEmit=now;emit();}}
let saving:Promise<void>=Promise.resolve();
async function syncDirectory(folder:string){let handle:import('node:fs/promises').FileHandle|undefined;try{handle=await fs.open(folder,'r');await handle.sync();}catch(error){if(!['EINVAL','ENOTSUP','EISDIR','EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code??''))throw error;}finally{await handle?.close();}}
function save():Promise<void>{const data=JSON.stringify({preferences:state.preferences,history:state.history,organizationLocations,organizationFolders:state.organizationFolders},null,2);const write=saving.then(async()=>{await fs.mkdir(app.getPath('userData'),{recursive:true});const temp=store()+'.'+randomUUID()+'.new';const file=await fs.open(temp,'wx',0o600);try{await file.writeFile(data);await file.sync();}finally{await file.close();}await fs.rename(temp,store());await syncDirectory(app.getPath('userData'));});saving=write.catch(()=>{});return write;}
async function initializeRecoveryKey(){
 const directory=app.getPath('userData');await fs.mkdir(directory,{recursive:true});const keyPath=path.join(directory,'organization-recovery.key');
 try{await fs.lstat(keyPath);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const temporary=keyPath+'.'+randomUUID()+'.new';const file=await fs.open(temporary,'wx',0o600);try{await file.writeFile(randomBytes(32));await file.sync();}finally{await file.close();}try{await fs.link(temporary,keyPath);await syncDirectory(directory);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}finally{await fs.unlink(temporary);}}
 const info=await fs.lstat(keyPath);if(!info.isFile()||info.isSymbolicLink())throw new Error('The organization recovery key is unavailable.');const key=await fs.readFile(keyPath);if(key.length!==32)throw new Error('The organization recovery key is invalid.');configureOrganizationRecovery(key);
}
async function load(){try{const data=JSON.parse(await fs.readFile(store(),'utf8'));state.preferences=normalizePreferences(data.preferences);state.organizationFolders=data.organizationFolders&&typeof data.organizationFolders==='object'?data.organizationFolders:{};state.history=Array.isArray(data.history)?data.history.slice(0,50).flatMap((entry:Record<string,unknown>)=>{const title=savedMessage(entry?.title),detail=savedMessage(entry?.detail);return title&&detail&&typeof entry.id==='string'&&typeof entry.date==='string'?[{id:entry.id,date:entry.date,title,detail}]:[];}):[];organizationLocations=Array.isArray(data.organizationLocations)?data.organizationLocations.filter((item:OrganizationLocation)=>typeof item?.root==='string'&&typeof item.destination==='string'&&typeof item.volumeId==='string'&&within(item.root,item.destination)):[];}catch{/* First launch uses explicit setup. */}if(qa)state.preferences=normalizePreferences(undefined);}
function addHistory(title:Message,detail:Message){state.history.unshift({id:randomUUID(),date:new Date().toISOString(),title,detail});state.history=state.history.slice(0,50);void save().catch(()=>{});}
async function allowed(file:string){const real=await fs.realpath(file);for(const root of [...approved,...state.sources.map(s=>s.path),...state.preferences.destinations])if(within(real,await fs.realpath(root).catch(()=>root)))return real;throw new Error('Choose this file or its source folder first.');}
async function refresh(){
 if(refreshing)return;refreshing=true;
 try{
  const volumes=await mountedVolumes();const destinations=await Promise.all(state.preferences.destinations.map(p=>volumeInfo(p,volumes)));const found=qaFixtureRoot?[]:await getSources(volumes,{destinations});releaseMissingVolumes(volumes);
  state.destinationStatus=destinations;
  const detected=found.filter(s=>!destinations.some(d=>(d.volumeId&&d.volumeId===s.id)||within(s.path,d.path)||within(d.path,s.path)));
  for(const source of detected){const selected=Array.from(folders.entries()).find(([,value])=>value.source.path===source.path);if(selected&&selected[0]!==source.id){folders.delete(selected[0]);folders.set(source.id,{source,backup:selected[1].backup});}}
  state.sources=selection.apply([...detected,...Array.from(folders.values(),v=>v.source).filter(source=>source.transport==='folder'&&!detected.some(s=>s.path===source.path))],state.preferences.rememberedDevices??={},state.preferences.ignoredDevices??={},state.preferences.deviceHistory??={});publishDevices();loadRememberedScans();
  const connected=new Set(state.sources.map(s=>s.id));for(const id of Object.keys(state.sourceInventories??{}))if(!connected.has(id)){delete state.sourceInventories![id];delete state.sourceCameraInfo?.[id];scanControls.get(id)?.abort();}for(const id of seen)if(!connected.has(id))seen.delete(id);
  // Automatic imports wait until every destination the copy policy needs is connected;
  // unqueued sources stay unseen and are picked up on a later refresh.
  const required=state.preferences.copyMode==='single'?1:2,ready=destinations.length>=required&&destinations.slice(0,required).every(info=>info.available);
  // Automatic import only takes drives the user selected (now or on a previous connection).
  if(state.preferences.automatic&&ready){for(const source of state.sources.filter(s=>s.selected&&found.some(item=>item.id===s.id)))if(!seen.has(source.id)){seen.add(source.id);enqueue(source,folders.get(source.id)?.backup??false,true);}}
  emit();pump();scheduleMisplacedCheck();scheduleResidueCheck();
  const scope=JSON.stringify([state.preferences.destinations,backupFolders(state.preferences),organizationLocations,destinations.map(info=>[info.path,info.available,info.volumeId])]);
  if(scope!==recoveryScope&&!recoveryRefresh.running){recoveryScope=scope;recoveryRefresh.request();}
  else recoveryRefresh.resume();
 }catch(error){state.error=toMessage(error);emit();}finally{refreshing=false;}
}
async function scanSource(source:Source){
 if(scanControls.has(source.id))return;
 if(source.transport==='camera')throw new MessageError('error.cameraScan');
 const control=new AbortController();cancelAutomaticChecks();scanControls.set(source.id,control);state.scanningSources=[...scanControls.keys()];emit();
 try{await scanSourceInWorker(source,control.signal,result=>{if(state.sources.some(item=>item.id===source.id&&item.path===source.path)){(state.sourceInventories??={})[source.id]=result;emit();}},summary=>{if(state.sources.some(item=>item.id===source.id&&item.path===source.path)){(state.sourceCameraInfo??={})[source.id]=summary;progressEmit();}},{unknownRules:{...state.preferences.unknownRules,...sessionRules},unknownDefault:state.preferences.unknownDefault},(files,bytes,file,top)=>{(state.scanProgress??={})[source.id]={files,bytes,...(file?{file}:{}),...(top?.total?{topShare:listingEstimate(undefined,{files,bytes},top).share}:{})};progressEmit();},primeRouting,{reuse:reusableScan(source),routing:routingEntries().filter(([key])=>key.startsWith(source.path+path.sep))});rememberScan(source,state.sourceInventories?.[source.id]);noteDevice(source,'scan',state.sourceCameraInfo?.[source.id]);await updateFolderCapacity(source);}
 catch(error){const info=state.sourceCameraInfo?.[source.id];if(info)state.sourceCameraInfo![source.id]={...info,status:control.signal.aborted?'stopped':'error',...(!control.signal.aborted?{error:errorText(error)}:{})};if(!control.signal.aborted)throw error;}

 finally{scanControls.delete(source.id);delete state.scanProgress?.[source.id];state.scanningSources=[...scanControls.keys()];emit();void releaseIfIdle();}
}
/** Roughly how much there is to read in a folder's journals: the size of each journal's folder. */
async function journalWeight(root:string):Promise<number>{
 const folder=path.join(root,RECOVERY_FOLDER),names=await fs.readdir(folder).catch(()=>[] as string[]);
 const sizes=await Promise.all(names.filter(name=>/^[0-9a-f-]{36}$/.test(name)).map(name=>fs.lstat(path.join(folder,name)).then(stat=>stat.size,()=>0)));
 return sizes.reduce((sum,size)=>sum+size,0);
}
let organizationListing:Promise<void>|undefined,organizationListingAgain=false;
/** One listing at a time. A request while one runs gets one more listing right after it, so a
 * change made meanwhile (an undo or resume that just finished) is always shown. */
function refreshOrganizations():Promise<void>{
 if(organizationListing){organizationListingAgain=true;return organizationListing;}
 return organizationListing=(async()=>{do{organizationListingAgain=false;await listOrganizations();}while(organizationListingAgain);})().finally(()=>{organizationListing=undefined;});
}
async function listOrganizations(){
 const destinations=state.preferences.destinations;
 const locations=[...organizationLocations];
 const add=(root:string,destination:string,volumeId:string)=>{if(within(root,destination)&&!locations.some(item=>item.root===root))locations.push({root,destination,volumeId});};
 // Every backup folder on each destination, whatever the current layout: a journal may be in either.
 for(let index=0;index<destinations.length;index++){const destination=destinations[index];for(const folder of new Set([...backupFolders(state.preferences),state.preferences.basePath,state.preferences.videoBasePath]))add(path.resolve(destination,folder),destination,state.preferences.destinationIds?.[index]??'');}
 // A large journal from an earlier version can take minutes to read on a USB drive. The previous list
 // stays until each folder is read again, and is replaced folder by folder.
 const byRoot=new Map<string,NonNullable<AppState['organizationRecovery']>>();
 for(const job of state.organizationRecovery??[])byRoot.set(job.root,[...byRoot.get(job.root)??[],job]);
 const publish=()=>{state.organizationRecovery=[...byRoot.values()].flat();emit();};
 const listed=new Set<string>();state.organizationRecoveryLoading=true;emit();
 // Small folders first, so they show at once; a folder holding a large journal from an earlier version
 // (one file per event, slow to read on a USB drive) comes last.
 // Only folders on a connected, unchanged destination are weighed, one at a time.
 const weights=new Map<string,number>();
 for(const location of locations){
  const status=location.folder?undefined:destinations.includes(location.destination)?state.destinationStatus?.find(item=>item.path===location.destination):undefined;
  weights.set(location.root,status?.available&&status.volumeId===location.volumeId?await journalWeight(location.root):0);
 }
 locations.sort((a,b)=>weights.get(a.root)!-weights.get(b.root)!);
 let looked=0;
 try{
  for(let position=0;position<locations.length;position++){
   const location=locations[position]!;
   // A folder organized in place is listed while its own drive is present and unchanged.
   const status=location.folder?await volumeInfo(location.destination):destinations.includes(location.destination)?state.destinationStatus?.find(item=>item.path===location.destination):undefined;
   if(!status?.available||status.volumeId!==location.volumeId)continue;
   listed.add(location.root);
   try{
    const found=await getOrganizationRecovery(location.root,{verifyContents:false,includeEnded:true,onProgress:update=>{state.organizationRecoveryProgress={phase:'planning',step:'scanning',completed:looked+update.looked,total:0,bytes:0,totalBytes:0,share:Math.min(.99,(position+update.share)/locations.length),speed:0,file:update.file||path.basename(location.root)};progressEmit();}});byRoot.set(location.root,found);looked+=found.reduce((sum,job)=>sum+job.files,0);
    // A folder holding journals can be resumed, rechecked or undone from the list: remember it.
    if(found.length&&!organizationLocations.some(item=>item.root===location.root&&item.volumeId===location.volumeId)){organizationLocations.push({root:location.root,destination:location.destination,volumeId:location.volumeId,...(location.folder?{folder:true}:{})});await save();}
    // The sibling backup folders those journals list are read too, on the same drive.
    for(const library of found.flatMap(job=>job.libraries??[]))if(!location.folder)add(library,location.destination,location.volumeId);
   }catch(error){state.error=toMessage(error);}
   publish();
  }
  // Folders not listed this time (drive away, or no longer configured) leave the list.
  for(const root of [...byRoot.keys()])if(!listed.has(root))byRoot.delete(root);
  publish();
 }finally{state.organizationRecoveryLoading=false;delete state.organizationRecoveryProgress;emit();}
}
async function rememberOrganization(root:string,prefs:Preferences){
 const destination=prefs.destinations[0],volumeId=prefs.destinationIds?.[0];if(!destination||!volumeId||!within(root,destination))throw new MessageError('error.organizationDestination');
 const folder=!state.preferences.destinations.includes(destination);
 if(!organizationLocations.some(item=>item.root===root&&item.volumeId===volumeId))organizationLocations.push({root,destination,volumeId,...(folder?{folder:true}:{})});await save();
}
const gigabytes=(bytes:number)=>`${(bytes/1e9).toFixed(1)} GB`;
/** "2592 moved · 2592 originals kept for undo (49.0 GB) · 0 errors"; only true claims are made. */
function organizedText(moved:number,retained:number,retainedBytes:number,errors:number){return [message('job.moved',{count:moved}),retained?message('job.retained',{count:retained,size:gigabytes(retainedBytes)}):undefined,message('job.errors',{count:errors})];}
/** `source`: the card a paused organization continues on, so its resume shows in the same place. */
async function resumeOrganizationJob(root:string,id:string,kind:'resume'|'finalize'|'undo'|'delete'='resume',source?:Source,folders?:string[],full=false){
 const operation=JSON.stringify([root,id]);if(resumingOrganizations.has(operation))return;
 if(busy()||state.review||state.busyReview)throw new MessageError('error.busy');
 if(!state.organizationRecovery?.some(item=>item.root===root&&item.id===id))throw new MessageError('error.recoveryListStale');
 const location=organizationLocations.find(item=>item.root===root&&(item.folder||state.preferences.destinations.some((destination,index)=>destination===item.destination&&state.preferences.destinationIds?.[index]===item.volumeId)));if(!location)throw new MessageError('error.organizationDestination');
 // Claim before disk validation yields: a fast recheck may finish while a
 // second request is still validating, making a later busy() check insufficient.
 resumingOrganizations.add(operation);
 try{
 await stopResidueCheck();
 await validateDestination(location.destination,state.sources,{identity:location.volumeId});
 if(busy()||state.review||state.busyReview)throw new MessageError('error.busyResume');
 if(!location.folder&&!state.preferences.destinations.some((destination,index)=>destination===location.destination&&state.preferences.destinationIds?.[index]===location.volumeId))throw new MessageError('error.organizationDestination');
 const job:Job={id:randomUUID(),source:source??{id:'organization:'+id,name:'Library organization',path:root,transport:'folder'},organization:true,...(folders?{folders}:{}),phase:'verifying',detail:message(kind==='finalize'?'job.recheckFinalize':kind==='undo'?'job.recheckUndo':kind==='delete'?'job.recheckDelete':'job.recheckJournal'),errors:[],backup:false};state.jobs.unshift(job);const control=new AbortController();cancelAutomaticChecks();active.set(job.id,control);organizationJobIds.add(job.id);emit();
 void settle((async()=>{try{
  // Finalize and undo check every entry before changing any, then change them in turn.
  const stepProgress=(progress:OrganizationProgress)=>{job.phase=progress.step==='checking'?'verifying':'copying';job.progress={phase:progress.step==='checking'?'verifying':'copying',step:progress.step,completed:progress.completed,total:progress.total,bytes:0,totalBytes:0,speed:0,file:progress.file};job.detail=message(progress.step==='checking'?'job.stepChecking':progress.step==='releasing'?'job.stepReleasing':progress.step==='deleting'?'job.stepDeleting':'job.stepRestoring',{completed:progress.completed,total:progress.total});progressEmit();};
  if(kind==='finalize'){const released=await finalizeOrganization(root,id,control.signal,stepProgress);job.phase='complete';job.detail=joined(message('job.released',{count:released.removed,size:gigabytes(released.bytes)}),released.handedOff>0&&message('job.handedOff',{count:released.handedOff}));addHistory(message('history.organization'),job.detail);}
  else if(kind==='undo'){const undone=await undoOrganization(root,id,control.signal,stepProgress);job.phase='complete';job.detail=joined(message('job.undone',{restored:undone.restored,removed:undone.removed}),undone.handedOff>0&&message('job.handedOff',{count:undone.handedOff}));addHistory(message('history.organizationUndone'),job.detail);}
  else if(kind==='delete'){const deleted=await deleteOrganizationRecovery(root,id,control.signal,stepProgress);job.phase='complete';job.detail=message('job.recoveryDeleted',{count:deleted.files,size:gigabytes(deleted.bytes)});addHistory(message('history.recoveryDeleted'),job.detail);}
  else{const result=await resumeOrganization(root,id,control.signal,progress=>{job.progress=progress;job.phase=progress.step==='history'?'verifying':'copying';job.detail=progress.step==='history'?message('job.readingHistory',{count:progress.completed,total:progress.total}):message('job.resuming');progressEmit();},{full});job.errors=result.errors.map(text);job.phase=result.errors.length?'error':'complete';job.detail=joined(...organizedText(result.moved,result.retained,result.retainedBytes,result.errors.length));addHistory(message('history.organizationRecovery'),job.detail);}
 }catch(error){if(control.signal.aborted&&pausing.delete(job.id)){job.phase='stopped';job.paused=true;job.detail=message('job.organizationPaused');}else{job.phase=control.signal.aborted?'stopped':'error';job.detail=toMessage(error);if(!control.signal.aborted)job.errors.push(job.detail);}}finally{delete job.stopping;active.delete(job.id);organizationJobIds.delete(job.id);await refreshOrganizations();emit();pump();
  // Undo puts files back where they were, so the backup folder check runs again.
  if(!active.size&&!state.jobs.some(item=>item.phase==='queued'))scheduleAutomaticChecks();}})()).finally(()=>{resumingOrganizations.delete(operation);void releaseIfIdle();});
 }catch(error){resumingOrganizations.delete(operation);throw error;}
}
/** Planning progress as the interface shows it: checking (and, for organization, reading) files before anything is written. */
function planningProgress(count:number,file:string,detail?:Parameters<PlanProgress>[2]):Progress{return {phase:'planning',step:detail?.step??'checking',completed:count,total:detail?.total??0,bytes:detail?.bytes??0,totalBytes:detail?.totalBytes??0,...(detail?.share!==undefined?{share:detail.share}:{}),speed:0,file};}
/** Files staged from a USB camera so far (the camera reports counts, not bytes or names). */
function downloadProgress(done:number,total:number):Progress{return {phase:'planning',step:'downloading',completed:done,total,bytes:0,totalBytes:0,speed:0,file:''};}
/** What to estimate a listing by: the last completed listing of this scope, else (an import) the drive's used bytes. Remembers the new size when the listing ends. */
async function listingOptions(root:string,folders:string[]|undefined,backup:boolean,fallback?:ListingHint):Promise<{listingHint?:ListingHint;onListed:(files:number,bytes:number)=>void}>{
 const store=app.getPath('userData'),remembered=await loadListingHint(store,root,folders,backup).catch(()=>undefined),hint=remembered??fallback;
 return {...(hint?{listingHint:hint}:{}),onListed:(files,bytes)=>{void rememberListing(store,root,folders,backup,files,bytes).catch(()=>{/* Only an estimate. */});}};
}
/** English text of an error, for reports and dialogs outside the renderer. */
function errorText(error:unknown){return error instanceof Error?error.message:String(error);}
function enqueue(source:Source,backup=false,automatic=false){
 const existing=state.jobs.find(j=>j.source.id===source.id&&['queued','discovering','verifying','copying'].includes(j.phase));
 if(existing){if(!automatic)automaticallyQueued.delete(existing.id);return;}
 const job:Job={id:randomUUID(),source,phase:'queued',detail:message('job.waiting'),errors:[],backup};
 for(const previous of state.jobs)if(previous.source.id===source.id&&['complete','stopped','error'].includes(previous.phase))delete previous.inventory;
 state.jobs.unshift(job);if(automatic)automaticallyQueued.add(job.id);seen.add(source.id);
 const finished=state.jobs.filter(j=>['complete','stopped','error'].includes(j.phase));if(finished.length>30){const remove=new Set(finished.slice(30).map(j=>j.id));state.jobs=state.jobs.filter(j=>!remove.has(j.id));}
}
function pump(){if(state.review||state.busyReview||organizationJobIds.size)return;while(active.size<state.preferences.parallel){
 const job=nextQueued(state.jobs,sourceOrder);if(!job)break;
 const organization=organizationQueue.get(job.id);if(organization&&active.size)break;
 organizationQueue.delete(job.id);if(organization)organizationRuns.set(job.id,organization);cancelAutomaticChecks();misplacedControl?.abort();residueControl?.abort();const control=new AbortController();active.set(job.id,control);if(organization)organizationJobIds.add(job.id);
 const skip=skipRequests.get(job.id);skipRequests.delete(job.id);
 void settle(run(job,control,organization??{prefs:snapshotPreferences(),reorganize:false,...skip})).finally(()=>{if(job.phase==='error')job.retryable=true;delete job.stopping;active.delete(job.id);organizationJobIds.delete(job.id);reservations.delete(job.id);automaticallyQueued.delete(job.id);if(!organization&&job.phase==='complete')organizeAfterImport=true;emit();pump();if(!active.size&&!state.jobs.some(item=>item.phase==='queued'))scheduleAutomaticChecks();void releaseIfIdle();});
 if(organization)break;
}}
// Nothing here may touch a drive once the work is done, so macOS can eject it at once. exiftool and the
// hashing threads start again on demand. Closed only while no job, scan, review, organization or check
// could use them; the idle test and the closing calls run in the same turn, so nothing starts in between.
let inspecting=0,releasing:Promise<void>|undefined;
const idle=()=>!hardwareTest&&!active.size&&!scanControls.size&&!misplacedControl&&!misplacedTask&&!residueControl&&!residueTask&&!state.busyReview&&!reviewControl&&!resumingOrganizations.size&&!recoveryRefresh&&!inspecting;
function releaseIfIdle():Promise<void>{
 if(releasing||!idle())return releasing??Promise.resolve();
 if(checksPending){scheduleAutomaticChecks();return Promise.resolve();}
 const work=Promise.allSettled([closeMetadata(),terminateHasher()]).then(()=>{});
 releasing=work.finally(()=>{releasing=undefined;});
 return releasing;
}
// Checks that read the whole library wait a while after the last job, scan or review ends, and
// never start once something new has begun.
const AUTOMATIC_CHECK_DELAY=30000;
let checkTimer:NodeJS.Timeout|undefined,checksPending=false;
function cancelAutomaticChecks(){if(checkTimer){clearTimeout(checkTimer);checksPending=true;}checkTimer=undefined;}
function scheduleAutomaticChecks(){
 if(qa||quitting)return;cancelAutomaticChecks();checksPending=false;
 checkTimer=setTimeout(()=>{checkTimer=undefined;scheduleMisplacedCheck(true);scheduleResidueCheck(true);},AUTOMATIC_CHECK_DELAY);checkTimer.unref();
}
// A check reading a drive that was unplugged stops; mounts in the last refresh are remembered.
let knownMounts=new Set<string>();
function releaseMissingVolumes(volumes:MountedVolume[]){
 const mounts=new Set(volumes.map(volume=>volume.path));
 for(const mount of knownMounts)if(!mounts.has(mount)&&mount!==path.parse(mount).root){
  if(misplacedControl&&misplacedPaths.some(item=>within(item,mount)))misplacedControl.abort();
  if(residueControl&&residuePaths.some(item=>within(item,mount)))residueControl.abort();
 }
 knownMounts=mounts;
}
// Read-only check of each connected destination's backup folder for files outside the folder the
// rules give them. It runs while nothing else does: after imports finish and when a destination connects.
let misplacedControl:AbortController|undefined,misplacedTask:Promise<void>|undefined,misplacedScope='',organizeAfterImport=false,misplacedPaths:string[]=[];
function scheduleMisplacedCheck(force=false){
 if(qa||(!force&&checkTimer)||state.preferences.autoOrganizeBackup==='off'||active.size||state.review||state.busyReview||misplacedControl||residueTask)return;
 const prefs=state.preferences,scope=JSON.stringify([prefs.destinations,prefs.destinationIds,prefs.basePath,prefs.template,prefs.mediaLayout,prefs.videoBasePath,prefs.videoTemplate,prefs.editedFolder,state.destinationStatus?.map(info=>[info.path,info.available,info.volumeId])]);
 if(!force&&scope===misplacedScope)return;
 misplacedScope=scope;const control=new AbortController();misplacedControl=control;misplacedPaths=prefs.destinations.slice(0,2);const organize=organizeAfterImport;organizeAfterImport=false;
 const task:Promise<void>=(async()=>{
  const checked=new Set<string>();
  for(let index=0;index<Math.min(2,state.preferences.destinations.length);index++){
   const snapshot=snapshotPreferences(index),destination=snapshot.destinations[0]!,library=backupLibrary(snapshot);checked.add(destination);
   const status=state.destinationStatus?.find(item=>item.path===destination),folder=(item:string)=>fs.lstat(item).then(stat=>stat.isDirectory()&&!stat.isSymbolicLink(),()=>false);
   // Both backup folders must exist to be compared; the first import creates them.
   if(!status?.available||status.volumeId!==snapshot.destinationIds?.[0]||!within(library.root,destination)||!await folder(library.root)||library.videoRoot&&!await folder(library.videoRoot)){delete state.misplacedFiles?.[destination];continue;}
   const found=await findMisplaced(library.source,library.root,{template:snapshot.template,layout:snapshot.mediaLayout,videoTemplate:snapshot.videoTemplate,...(library.videoRoot?{videoRoots:[library.videoRoot]}:{}),...(library.sourceFolders?{sourceFolders:library.sourceFolders}:{}),editedFolder:snapshot.editedFolder,unknownRules:{},...await listingOptions(library.source,library.sourceFolders,false)},file=>metadata(file,{preview:false,details:false}),control.signal,(count,file,detail)=>{(state.misplacedProgress??={})[destination]=planningProgress(count,file,detail);progressEmit();}).finally(()=>{delete state.misplacedProgress?.[destination];});
   (state.misplacedFiles??={})[destination]={count:found.count,bytes:found.bytes,checkedAt:new Date().toISOString()};emit();
   if(found.count&&organize&&state.preferences.autoOrganizeBackup==='auto')try{queueBackupOrganization(index,true);}catch{/* Another organization or a review comes first; the count stays visible. */}
  }
  for(const destination of Object.keys(state.misplacedFiles??{}))if(!checked.has(destination))delete state.misplacedFiles![destination];
 })().catch(error=>{if(!control.signal.aborted)state.error=message('error.backupFolderCheck',{error:toMessage(error)});}).finally(()=>{if(misplacedControl===control)misplacedControl=undefined;if(misplacedTask===task)misplacedTask=undefined;if(control.signal.aborted)misplacedScope='';emit();scheduleResidueCheck();void releaseIfIdle();});
 misplacedTask=task;
}
// Leftovers of interrupted runs: staging files and receipts beside media, index and organization
// scratch files, and camera and preview folders in the system temporary folder. Looked for while
// nothing runs (after imports and organizations finish and when a destination connects) and
// removed at once; copies a re-import could continue wait for Clean up.
let residueControl:AbortController|undefined,residueTask:Promise<void>|undefined,residueScope='',residuePaths:string[]=[];
/** The backup folders of connected destinations, and folders organized in place on connected drives. */
async function residueRoots():Promise<string[]>{
 const prefs=state.preferences,roots:string[]=[];
 prefs.destinations.forEach((destination,index)=>{const status=state.destinationStatus?.find(item=>item.path===destination);if(status?.available&&status.volumeId===prefs.destinationIds?.[index])for(const folder of backupFolders(prefs)){const root=path.resolve(destination,folder);if(within(root,destination))roots.push(root);}});
 for(const location of organizationLocations){const status=location.folder?await volumeInfo(location.destination).catch(()=>undefined):state.destinationStatus?.find(item=>item.path===location.destination);if(status?.available&&status.volumeId===location.volumeId)roots.push(location.root);}
 // A folder inside another one is looked through with it.
 return [...new Set(roots)].filter((root,_index,all)=>!all.some(other=>other!==root&&within(root,other)));
}
// The automatic check also waits for the backup folder check, which rewrites index files; Clean up does not.
const residueIdle=(manual=false)=>!active.size&&!resumingOrganizations.size&&(manual||!misplacedControl)&&!state.review&&!state.busyReview&&!state.jobs.some(job=>job.phase==='queued');
function scheduleResidueCheck(force=false){
 if(qa||(!force&&checkTimer))return;
 // Something running now: look again once it is idle (any later refresh or finished job).
 if(!residueIdle()||residueTask){residueScope='';return;}
 const scope=JSON.stringify([state.preferences.destinations,state.preferences.destinationIds,backupFolders(state.preferences),organizationLocations,state.destinationStatus?.map(info=>[info.path,info.available,info.volumeId])]);
 if(!force&&scope===residueScope)return;
 residueScope=scope;void checkResidue(false);
}
/** Find leftovers and remove them; `all` also removes copies a re-import could continue. */
function checkResidue(all:boolean):Promise<void>{
 const control=new AbortController();residueControl=control;
 state.residue={...state.residue??{files:0,bytes:0,resumable:{files:0,bytes:0}},checking:true};emit();
 const task:Promise<void>=(async()=>{
  const roots=await residueRoots();residuePaths=roots;
  // Looking is a share of the folders walked; removing counts the leftovers found. Both show in the settings row.
  const show=(progress:Progress)=>{if(state.residue)state.residue.progress=progress;progressEmit();};
  const found=await findResidue(roots,{temporary:os.tmpdir(),inUse:previewFoldersInUse,signal:control.signal,onProgress:scan=>show({phase:'planning',step:'scanning',completed:scan.looked,total:0,bytes:0,totalBytes:0,...(scan.total>0?{share:Math.min(.99,scan.done/scan.total)}:{}),speed:0,file:scan.file})});
  const {removed,left}=found.files>(all?0:found.resumable.files)?await cleanResidue(found,{keepResumable:!all,inUse:previewFoldersInUse,signal:control.signal,onProgress:(done,total,bytes,totalBytes,file)=>show({phase:'copying',step:'deleting',completed:done,total,bytes,totalBytes,speed:0,file})}):{removed:{files:0,bytes:0},left:found};
  const now=new Date().toISOString(),cleaned=removed.files?{...removed,at:now}:state.residue?.cleaned;
  state.residue={files:left.files,bytes:left.bytes,resumable:left.resumable,checkedAt:now,...(cleaned?{cleaned}:{})};
 })().catch(error=>{if(!control.signal.aborted)state.error=message('error.residueCleanup',{error:toMessage(error)});}).finally(()=>{if(residueControl===control)residueControl=undefined;if(residueTask===task)residueTask=undefined;if(control.signal.aborted)residueScope='';if(state.residue){delete state.residue.checking;delete state.residue.progress;}emit();void releaseIfIdle();});
 residueTask=task;return task;
}
/** Anything about to write waits for a running cleanup to stop. */
async function stopResidueCheck(){residueControl?.abort();await residueTask;}
// Jobs still settling; quitting waits for them so a stopped job removes its staging files.
const settling=new Set<Promise<unknown>>();
function settle<T>(work:Promise<T>):Promise<T>{settling.add(work);work.finally(()=>settling.delete(work)).catch(()=>{});return work;}
function assertOrganizationIdle(){
 if(state.review||state.busyReview)throw new MessageError('error.reviewOpen');
 if(state.jobs.some(job=>job.organization&&['queued','discovering','verifying','copying'].includes(job.phase)))throw new MessageError('error.organizationRunning');
}
/** The one way organization is queued: arrange `root`'s files into the folder structure under
 * request.prefs' single destination/basePath with journaled, undoable moves, once imports finish. */
function queueOrganization(root:string,name:string,request:RunRequest){
 assertOrganizationIdle();
 const job:Job={id:randomUUID(),source:{id:'library:'+root,path:root,name,transport:'folder'},organization:true,...(request.sourceFolders?.length?{folders:request.sourceFolders}:{}),phase:'queued',detail:message('job.waitingForImports'),errors:[],backup:false};
 organizationQueue.set(job.id,request);state.jobs.unshift(job);emit();pump();
}
/** One destination's backup as a library: its backup folder, organized in place. In the video-root
 * layout files also move between the photo and video folders, so the library is the destination
 * itself, read only inside those two folders. */
function backupLibrary(prefs:Preferences):{source:string;root:string;videoRoot?:string;sourceFolders?:string[]}{
 const destination=prefs.destinations[0]!,[root,videoRoot]=backupFolders(prefs).map(folder=>path.resolve(destination,folder));
 return videoRoot?{source:destination,root:root!,videoRoot,sourceFolders:backupFolders(prefs)}:{source:root!,root:root!};
}
/** Organize only <destination>/<basePath> (and <videoBasePath>) in place: the Organize backup button, or the automatic follow-up to imports. */
function queueBackupOrganization(index:number,automatic=false){
 const prefs=snapshotPreferences(index),destination=prefs.destinations[0]!,library=backupLibrary(prefs);
 if(!within(library.root,destination))throw new MessageError('error.backupFolderOutside');
 queueOrganization(library.source,automatic?'Backup organization (automatic)':'Backup organization',{prefs,reorganize:true,options:automatic?freshOrganizeOptions():takeOrganizeOptions(),...(library.sourceFolders?{sourceFolders:library.sourceFolders}:{})});
}
/** Preferences frozen for one operation. Organization always targets one chosen destination. */
function snapshotPreferences(organizationDestination?:number):Preferences{
 const prefs=structuredClone(state.preferences);prefs.unknownRules={...prefs.unknownRules,...sessionRules};
 if(organizationDestination===undefined)return prefs;
 if(organizationDestination!==0&&organizationDestination!==1)throw new Error('Invalid organization destination');
 const root=prefs.destinations[organizationDestination];if(!root)throw new MessageError('error.chooseDestination');
 prefs.copyMode='single';prefs.destinations=[root];prefs.destinationIds=[prefs.destinationIds?.[organizationDestination]??''];
 return prefs;
}
/** The single path from a source to reserved destination plans. Reviews and
 * direct imports differ only in when the result is executed. */
/** Free space per destination after other jobs' reservations. */
function availableFor(owner:string,infos:DestinationStatus[]):number[]{
 return infos.map(info=>{let free=info.free??0;for(const [id,held] of reservations)if(id!==owner)for(const item of held)if(item.volume===(info.volumeId??info.path))free-=item.bytes;return Math.max(0,free);});
}
async function prepare(owner:string,source:Source,backup:boolean,request:RunRequest,signal:AbortSignal,onCamera:(done:number,total:number)=>void,onProgress:PlanProgress,onPlanning?:()=>void):Promise<Prepared>{
 const {prefs,reorganize,sourceFolders}=request;
 const {roots,videoRoots,infos,volumes}=await destinationRoots(prefs,state.sources,reorganize?undefined:source);
 const mirror=backup&&prefs.backupMode==='mirror';
 if(mirror&&prefs.copyMode==='sequential')throw new MessageError('error.mirrorSequential');
 const drive=backup?{name:source.name,mirror,...await backupDriveIdentity(source.path,volumes)}:undefined;
 if(drive?.mirror&&!drive.stable)throw new MessageError('error.mirrorNoUuid');
 let stage:Prepared['stage'],sourcePath=source.path;
 try{
  if(source.transport==='camera'){
   stage=await prepareCamera(source,signal,onCamera);sourcePath=stage.path;approved.add(sourcePath);
   // Staging may share a destination's disk; measure free space after it.
   for(const [index,root] of roots.entries()){const info=await volumeInfo(root,volumes);if(!info.available)throw info.detail?new Error(info.detail):new MessageError('error.destinationUnavailable');infos[index]={...infos[index]!,free:info.free};}
  }
  onPlanning?.();
  // Card files copied before and still unchanged are recognised without reading them.
  const volume=reorganize||stage?undefined:memoryVolume(source),sourceDigest=volume&&!qa?await loadImported(app.getPath('userData'),volume,source.path):undefined;
  const skipErrors=request.skipErrors===true||prefs.skipFileErrors!==false;
  // An earlier listing of this scope sizes the estimate; failing that a card's or drive's used space, or the files of its last scan.
  // Selected folders are sized from the files an earlier scan found inside them; the whole drive's used space would overestimate them.
  const previous=reorganize?undefined:reusableScan(source),previousHint=scopeHint(previous?.files,sourceFolders);
  const used=!reorganize&&!sourceFolders?.length&&source.transport!=='camera'&&source.transport!=='folder'&&source.total!==undefined&&source.free!==undefined?source.total-source.free:0;
  const listing=await listingOptions(source.transport==='camera'?'camera:'+source.id:sourcePath,sourceFolders,backup,previousHint??(used>0?{bytes:used}:undefined));
  const {inventory,plans,failures,problems}=await plan(sourcePath,roots,{backup,collectProblems:reorganize&&prefs.collectProblemFiles!==false,sourceDigest,skipErrors,...(request.exclude?.length?{exclude:request.exclude}:{}),drive:drive&&{name:drive.name,identity:drive.identity,mirror:drive.mirror},template:prefs.template,layout:prefs.mediaLayout,videoTemplate:prefs.videoTemplate,...(videoRoots?{videoRoots}:{}),editedFolder:prefs.editedFolder,unknownRules:prefs.unknownRules,unknownDefault:prefs.unknownDefault,reuse:reusableScan(source),reorganize,sourceFolders,...listing},p=>metadata(p,{preview:false,details:false}),signal,onProgress);
  signal.throwIfAborted();
  const available=availableFor(owner,infos);
  // A same-drive organization moves files; it never needs room for a second library.
  const needed=reorganize?plans.map((item,index)=>{const bytes=requiredOrganizationSpace(item);if(bytes>available[index]!)throw new MessageError('error.organizeSpace',{index:index+1,size:gigabytes(bytes)});return bytes;}):allocateDestinations(plans,available,prefs.copyMode);
  reservations.set(owner,infos.map((info,index)=>({volume:info.volumeId??info.path,bytes:needed[index]})));
  // Duplicates already on a destination are skipped, so only the bytes the plan writes are compared with free space.
  const space=reorganize?undefined:plans.map((item,index)=>destinationSpace(item,available[index]!));
  if(!reorganize&&!stage&&!backup)rememberScan(source,inventory);
  const options=request.options?{...request.options}:freshOrganizeOptions(),policy=sourcePolicy(reorganize?'reorganize':'import',options,prefs);
  return {problems,review:{id:owner,source,backup,plans,problems,...(reorganize?{collectProblemFiles:prefs.collectProblemFiles!==false}:{}),kind:reorganize?'reorganize':'import',sourceAction:policy.sourceAction,...(reorganize?{options}:{}),...(sourceFolders?{sourceFolders}:{})},prefs,options,inventory,stage,...(space?{space}:{}),skipErrors,failures:failures.map(item=>({path:item.path,error:toMessage(item.error),text:errorText(item.error)}))};
 }catch(error){await stage?.cleanup().catch(()=>{});throw error;}
}
async function run(job:Job,control:AbortController,input:Prepared|RunRequest){
 let prepared:Prepared|undefined;
 let reportDirectory:string|undefined;
 const saveReport=async(name:string,value:unknown)=>{if(!reportDirectory)return;const file=await fs.open(path.join(reportDirectory,name),'wx',0o600);try{await file.writeFile(JSON.stringify(value,null,2));await file.sync();}finally{await file.close();}};
 const signal=control.signal;
 const request='review' in input?undefined:input;job.excluded=request?.exclude;
 try{
  // A cleanup in progress stops first. The phase changes before this wait, so pump() never takes this job again.
  if('review' in input){
   await stopResidueCheck();
   prepared=input;
   // A review can sit open while other jobs fill the disk; recheck before writing.
   const available=availableFor(job.id,await Promise.all(prepared.review.plans.map(item=>volumeInfo(item.root))));
   const required=prepared.review.kind==='reorganize'?requiredOrganizationSpace:requiredTransferSpace;
   if(prepared.review.plans.some((item,index)=>required(item)>available[index]!))throw new MessageError('error.reviewSpace');
  }
  else{
   job.phase='discovering';job.detail=message(job.source.transport==='camera'?'job.stagingCamera':'job.finding');emit();
   await stopResidueCheck();
   prepared=await prepare(job.id,job.source,job.backup,input,signal,(done,total)=>{job.detail=message('job.cameraDownload',{done,total});job.progress=downloadProgress(done,total);progressEmit();},(count,file,detail)=>{job.phase='verifying';job.detail=detail?.step==='listing'?message('job.listing',{count}):detail?.step==='reading'?message('job.readingToMove',{count,total:detail.total,file:path.basename(file)}):detail?.step==='comparing'?message('job.comparingDestination',{count,total:detail.total,file:path.basename(file)}):detail?message('job.checkingSourceOf',{count,total:detail.total,file:path.basename(file)}):message('job.checkingSource',{count,file:path.basename(file)});if(detail)job.progress={phase:'planning',step:detail.step,completed:count,total:detail.total,bytes:detail.bytes,totalBytes:detail.totalBytes,...(detail.share!==undefined?{share:detail.share}:{}),speed:0,file};progressEmit();},()=>{job.phase='verifying';job.detail=message('job.readingMetadata');emit();});
   // Mirror moves only run from a review the user applied.
   const moving=prepared.review.plans.reduce((sum,plan)=>sum+(plan.removals?.length??0),0);
   if(moving)throw new MessageError('error.mirrorReview',{count:moving});
  }
  const {review:{plans,kind,sourceFolders},prefs,failures}=prepared,reorganize=kind==='reorganize';
  // The one place that decides what happens to the source: imports copy and leave it alone, whatever the saved preferences say.
  const policy=sourcePolicy(kind,prepared.options,prefs);
  job.skipErrors=prepared.skipErrors;
  // Files skipped while planning are listed with the job's errors, so the job never reads as fully passed.
  if(failures.length){job.failedFiles=failures.length;job.errors.push(...failures.map(item=>message('error.fileSkipped',{path:item.path,error:item.error})));}
  job.inventory=prepared.inventory;job.space=prepared.space;if(prepared.problems.length)job.problemFiles=prepared.problems;if(state.sources.some(source=>source.id===job.source.id))(state.sourceInventories??={})[job.source.id]=prepared.inventory;emit();
  if(reorganize)for(const part of destinationParts(plans[0]))await rememberOrganization(part.root,prefs);
  reportDirectory=path.join(app.getPath('userData'),'operation-reports',job.id);await fs.mkdir(reportDirectory,{recursive:true});
  const failed=failures.map(({path,text})=>({path,reason:text}));
  await saveReport('plan.json',{producer:'desktop-app',jobId:job.id,kind,sourceFolders,plans,skipped:job.inventory?.skipped??[],failed,inventory:job.inventory});
  await saveReport('context.json',{producer:'desktop-app',started:new Date().toISOString(),preferences:prefs,source:job.source});
  const reserved=reservations.get(job.id)!;
  job.phase='copying';
  const verified:Record<string,{sha256:string;identity:string}>={};
  const {copied,skipped,moved,retained,retainedBytes,released,releasedBytes,removed,errors,notes}=await executeDestinations(plans,{
   signal,reorganize,strategy:'rename',verify:policy.verifyCopies,keepSourceFolders:!policy.removeEmptySourceFolders,releaseDuplicates:policy.releaseDuplicates,onVerified:(file,sha256,identity)=>{verified[file]={sha256,identity};},
   validate:async index=>{await validateDestination(prefs.destinations[index],state.sources,{identity:prefs.destinationIds?.[index]??''});},
   progress:(index,progress,pending)=>{job.phase=progress.phase==='verifying'||progress.phase==='planning'?'verifying':'copying';job.progress=progress;reserved[index].bytes=pending;job.detail=progress.step==='history'?message('job.readingHistory',{count:progress.completed,total:progress.total}):progress.step==='existing'?message('job.confirmingExisting',{count:progress.completed,total:progress.total,file:path.basename(progress.file)}):(plans.length>1?message('job.destinationLabel',{index:index+1,count:plans.length}):undefined);progressEmit();},
   settled:index=>{reserved[index].bytes=0;}
  });job.errors.push(...errors.map(text));
  await saveReport('execution.json',{copied,skipped,moved,retained,retainedBytes,released,releasedBytes,removed,errors,notes,skipErrors:prepared.skipErrors,failedCount:failed.length,failed});
  const volume=reorganize||prepared.stage?undefined:memoryVolume(job.source);
  if(volume&&!qa&&Object.keys(verified).length)await rememberImported(app.getPath('userData'),volume,job.source.path,verified).catch(()=>{/* Only a cache. */});
  const entries=plans.reduce((sum,item)=>sum+destinationEntries(item).length,0);
  // Folders the organized files came from that now hold only service files (or nothing).
  let foldersRemoved=0;
  if(reorganize&&policy.removeEmptySourceFolders&&errors.length===0&&job.errors.length===0){
   try{foldersRemoved=await removeOrganizedFolders(job.source.path,plans,sourceFolders);
   }catch(error){job.errors.push(message('error.folderCleanup',{error:toMessage(error)}));}
  }
  job.alreadyImported=!reorganize&&entries>0&&copied===0&&!removed&&errors.length===0&&job.errors.length===0;
  await saveReport('summary.json',{producer:'desktop-app',passed:errors.length===0&&failed.length===0,failedCount:failed.length,retainedOriginals:true,jobId:job.id,kind,sourceFolders,finished:new Date().toISOString()});
  job.phase=job.errors.length?'error':'complete';
  // A finished folder import can later offer to delete the originals that are verified in the backup; nothing is removed now.
  // Files that failed or were skipped are simply not in `verified`, so they always stay on the source.
  if(!reorganize&&(job.phase==='complete'||job.phase==='error')&&job.source.transport==='folder'&&!prepared.stage){
   const entries=plans.flatMap(item=>destinationEntries(item)),files:VerifiedOriginal[]=[];
   for(const [file,found] of Object.entries(verified)){const matching=entries.filter(entry=>entry.source===file);if(matching.length)files.push({source:file,size:matching[0]!.size,sha256:found.sha256,destinations:[...new Set(matching.map(entry=>entry.destination))]});}
   if(files.length){importedOriginals.set(job.id,{root:job.source.path,files});job.verifiedOriginals=files.length;await saveReport('verified-originals.json',{root:job.source.path,files});}
  }
  if(!reorganize&&job.phase==='complete'&&(prefs.verifyCopies!==false||job.alreadyImported))noteDevice(job.source,'import');
  job.detail=reorganize?joined(...organizedText(moved,retained,retainedBytes,job.errors.length),failed.length>0&&message('job.skippedErrors',{count:failed.length}),prepared.problems.some(item=>item.collected)&&message('job.problemsCollected',{count:prepared.problems.filter(item=>item.collected).length}),prepared.problems.some(item=>!item.collected)&&message('job.problemsSkipped',{count:prepared.problems.filter(item=>!item.collected).length}),!!released&&message('job.releasedDuplicates',{count:released,size:gigabytes(releasedBytes??0)}),foldersRemoved&&message('job.foldersRemoved',{count:foldersRemoved}),notes.length>0&&text(notes[0]!)):job.alreadyImported?message('job.alreadyImported',{count:entries}):joined(message('job.copied',{copied,skipped}),failed.length>0&&message('job.skippedErrors',{count:failed.length}),prepared.problems.length>0&&message('job.problemsSkipped',{count:prepared.problems.length}),removed&&message('job.mirrorRemoved',{count:removed}),message('job.errors',{count:job.errors.length}),prefs.copyMode==='mirror'&&message(job.errors.length?'job.mirrorIncomplete':'job.mirrorVerified'));addHistory(message(job.backup?'history.driveBackup':'history.import',{name:job.source.name}),job.detail);
 }catch(error){await saveReport('failure.json',{producer:'desktop-app',passed:false,error:errorText(error),aborted:signal.aborted,finished:new Date().toISOString()}).catch(()=>{});if(signal.aborted&&pausing.delete(job.id)){job.phase='stopped';job.paused=true;job.detail=message(job.organization?'job.organizationPaused':'job.paused');}else{job.phase=signal.aborted?'stopped':'error';job.detail=signal.aborted?message('job.stopped'):toMessage(error);if(!signal.aborted)job.errors.push(job.detail);
  // A planning error about one file can be skipped by hand: never for a mirror (the copy would read as removed) or a USB camera (staged anew each time).
  const file=signal.aborted?undefined:filePath(job.detail),prefs=prepared?.prefs??request?.prefs;if(file&&job.source.transport!=='camera'&&!(job.backup&&prefs?.backupMode==='mirror')&&(!job.organization||organizationRuns.has(job.id)))job.skippablePath=file;addHistory(text(job.source.name),job.detail);}}
 if(prepared?.stage)await prepared.stage.cleanup().catch(()=>{});
 if(prepared?.review.kind==='reorganize'||('reorganize' in input&&input.reorganize))recoveryRefresh.request();else recoveryRefresh.resume();emit();
}
async function discardReview(){reviewControl?.abort();reviewControl=undefined;const old=reviewed;reviewed=undefined;state.review=undefined;state.busyReview=false;state.reviewSourceId=undefined;reservations.delete(old?.review.id??'');if(old?.stage)await old.stage.cleanup().catch(()=>{});}
async function previewSource(source:Source,backup:boolean,organizationDestination?:number,collectProblemFiles?:boolean){
 if(busy())throw new MessageError('error.busyReview');
 const reorganize=organizationDestination!==undefined,prefs=snapshotPreferences(organizationDestination);if(reorganize&&collectProblemFiles!==undefined){prefs.collectProblemFiles=collectProblemFiles;if(state.review?.options)state.organizeOptions={...state.review.options};}
 const request:RunRequest={prefs,reorganize,...(reorganize?{options:takeOrganizeOptions()}:{}),sourceFolders:reorganize?state.organizationFolders?.[source.path]?.slice():undefined};
 cancelAutomaticChecks();misplacedControl?.abort();await stopResidueCheck();await discardReview();const control=new AbortController();reviewControl=control;state.busyReview=true;state.reviewSourceId=source.id;emit();
 try{
  reviewed=await prepare(randomUUID(),source,backup,request,control.signal,(done,total)=>{state.reviewProgress=downloadProgress(done,total);progressEmit();},(count,file,detail)=>{state.reviewProgress=planningProgress(count,file,detail);progressEmit();});
  state.review=reviewed.review;if(reorganize)state.review.destinationIndex=organizationDestination;(state.sourceInventories??={})[source.id]=reviewed.inventory;
 }catch(error){if(!control.signal.aborted)throw error;}
 finally{if(reviewControl===control){state.busyReview=false;state.reviewSourceId=undefined;state.reviewProgress=undefined;reviewControl=undefined;}emit();recoveryRefresh.resume();void releaseIfIdle();}
}
async function applyReview(){
 if(!reviewed||busy()||state.busyReview)return;const prepared=reviewed;reviewed=undefined;state.review=undefined;
 const job:Job={id:randomUUID(),source:prepared.review.source,phase:'verifying',detail:message('job.revalidating'),errors:[],backup:prepared.review.backup};state.jobs.unshift(job);const control=new AbortController();cancelAutomaticChecks();active.set(job.id,control);if(prepared.review.kind==='reorganize')organizationJobIds.add(job.id);
 reservations.set(job.id,reservations.get(prepared.review.id)!);reservations.delete(prepared.review.id);
 void settle(run(job,control,prepared)).finally(()=>{if(job.phase==='error'&&prepared.review.kind!=='reorganize')job.retryable=true;delete job.stopping;active.delete(job.id);organizationJobIds.delete(job.id);reservations.delete(job.id);emit();pump();if(!active.size&&!state.jobs.some(item=>item.phase==='queued'))scheduleAutomaticChecks();void releaseIfIdle();});
}
/** Delete originals already in the backup: a separate step after a finished folder import. Only source files whose
 * checksum is confirmed again, now, at every backup copy are removed; anything else stays. Each file is reported. */
async function removeOriginals(jobId:string){
 const job=state.jobs.find(item=>item.id===jobId),kept=importedOriginals.get(jobId);
 if(!job||!kept||(job.phase!=='complete'&&job.phase!=='error')||!job.verifiedOriginals)throw new MessageError('error.originalsStale');
 if(job.deletingOriginals||state.jobs.some(item=>item.source.id===job.source.id&&item.id!==job.id&&(item.phase==='queued'||['discovering','verifying','copying'].includes(item.phase))))throw new MessageError('error.originalsBusy');
 job.deletingOriginals={completed:0,total:kept.files.length};state.originalsSize=undefined;emit();
 const control=new AbortController();
 try{
  const result=await deleteOriginals(kept.root,kept.files,{signal:control.signal,onProgress:(completed,total)=>{job.deletingOriginals={completed,total};progressEmit();}});
  const gone=new Set(result.deleted.map(item=>item.source));
  kept.files=kept.files.filter(file=>!gone.has(file.source));
  job.verifiedOriginals=kept.files.length||undefined;if(!kept.files.length)importedOriginals.delete(jobId);
  job.originalsDeleted={files:result.deleted.length,bytes:result.bytes,kept:result.kept.length};
  const directory=path.join(app.getPath('userData'),'operation-reports',job.id);
  await fs.mkdir(directory,{recursive:true});
  const file=await fs.open(path.join(directory,`originals-deleted-${Date.now()}.json`),'wx',0o600);
  try{await file.writeFile(JSON.stringify({producer:'desktop-app',jobId:job.id,source:job.source.path,finished:new Date().toISOString(),deleted:result.deleted,kept:result.kept,errors:result.errors},null,2));await file.sync();}finally{await file.close();}
  addHistory(text(job.source.name),message('job.originalsDeleted',{count:result.deleted.length,size:gigabytes(result.bytes),kept:result.kept.length}));
  if(result.errors.length)state.error=message('error.originalsDelete',{count:result.errors.length,error:result.errors[0]!});
 }catch(error){state.error=toMessage(error);}
 finally{delete job.deletingOriginals;emit();}
}
async function action(input:Action):Promise<void>{
 if(!input||typeof input.type!=='string')throw new Error('Invalid action');
 switch(input.type){
  case 'preview':{const source=state.sources.find(s=>s.id===input.sourceId);if(!source)throw new MessageError('error.sourceDisconnected');await previewSource(source,folders.get(source.id)?.backup??false);break;}
  case 'scanSource':{if(busy()||state.busyReview||state.review)throw new MessageError('error.busyScan');const source=state.sources.find(item=>item.id===input.sourceId);if(!source)throw new MessageError('error.sourceDisconnected');void scanSource(source).catch(error=>{state.error=toMessage(error);emit();});break;}
  case 'scanSources':{if(busy()||state.busyReview||state.review)throw new MessageError('error.busyScan');for(const source of state.sources.filter(item=>item.transport!=='camera'&&item.selected))void scanSource(source).catch(error=>{state.error=toMessage(error);emit();});break;}
  case 'refreshOrganization':await refreshOrganizations();break;
  case 'cleanResidue':{if(!residueIdle(true))throw new MessageError('error.busy');await stopResidueCheck();if(!residueIdle(true))throw new MessageError('error.busy');await checkResidue(true);break;}
  case 'resumeOrganization':await resumeOrganizationJob(input.root,input.id,'resume',undefined,undefined,input.full===true);break;
  case 'finalizeOrganization':await resumeOrganizationJob(input.root,input.id,'finalize');break;
  case 'undoOrganization':await resumeOrganizationJob(input.root,input.id,'undo');break;
  case 'deleteOrganizationRecovery':await resumeOrganizationJob(input.root,input.id,'delete');break;
  case 'measureOrganizationRecovery':{
   // Read-only: what Delete recovery files would remove, shown in its confirmations.
   const {root,id}=input;if(!state.organizationRecovery?.some(item=>item.root===root&&item.id===id))throw new MessageError('error.recoveryListStale');
   state.recoverySize={root,id};emit();
   try{const size=await measureOrganizationRecovery(root,id);if(state.recoverySize?.root===root&&state.recoverySize.id===id)state.recoverySize={root,id,...size};}
   catch(error){if(state.recoverySize?.root===root&&state.recoverySize.id===id)state.recoverySize={root,id,error:toMessage(error)};}
   break;
  }
  case 'chooseOrganizationFolders':{
   if(busy()||state.review||state.busyReview)throw new MessageError('error.busy');
   const index=input.destinationIndex;if(index!==0&&index!==1)throw new Error('Invalid organization destination');
   const root=state.preferences.destinations[index];if(!root)throw new MessageError('error.chooseDestination');
   const result=await dialog.showOpenDialog(window!,{title:'Choose folders to organize',defaultPath:root,properties:['openDirectory','multiSelections']});
   if(!result.canceled&&result.filePaths.length){const selected:string[]=[];for(const file of result.filePaths){const actual=await fs.realpath(file);if(actual!==path.resolve(file)||!within(actual,root)||actual===root||!(await fs.lstat(actual)).isDirectory())throw new MessageError('error.foldersOutside');selected.push(path.relative(root,actual));}(state.organizationFolders??={})[root]=selected;state.organizeOptions=freshOrganizeOptions();await save();}break;
  }
  case 'organizeOptions':{
   // This run's choices; a run, or choosing folders again, puts them back to on.
   const options=state.organizeOptions??freshOrganizeOptions();
   if(typeof input.removeEmptyFolders==='boolean')options.removeEmptyFolders=input.removeEmptyFolders;
   if(typeof input.releaseDuplicates==='boolean')options.releaseDuplicates=input.releaseDuplicates;
   state.organizeOptions=options;break;
  }
  case 'measureOriginals':{
   const kept=importedOriginals.get(input.jobId);if(!kept||!state.jobs.some(job=>job.id===input.jobId))throw new MessageError('error.originalsStale');
   state.originalsSize={jobId:input.jobId};emit();
   try{const size=await measureOriginals(kept.root,kept.files);if(state.originalsSize?.jobId===input.jobId)state.originalsSize={jobId:input.jobId,...size};}
   catch(error){if(state.originalsSize?.jobId===input.jobId)state.originalsSize={jobId:input.jobId,error:toMessage(error)};}
   break;
  }
  case 'deleteOriginals':await removeOriginals(input.jobId);break;
  case 'resetOrganizationFolders':{if(busy()||state.review||state.busyReview)throw new MessageError('error.busy');state.organizeOptions=freshOrganizeOptions();const root=state.preferences.destinations[input.destinationIndex];if(root&&state.organizationFolders){delete state.organizationFolders[root];await save();}break;}
  case 'organize':{
   const prefs=snapshotPreferences(input.destinationIndex),root=prefs.destinations[0]!;
   queueOrganization(root,'Library organization',{prefs,reorganize:true,options:takeOrganizeOptions(),sourceFolders:state.organizationFolders?.[root]?.slice()});break;
  }
  case 'organizeFolder':{
   // Arrange a chosen folder's files into the folder structure inside that same folder.
   // Camera cards and removable flash are refused.
   assertOrganizationIdle();
   const result=await dialog.showOpenDialog(window!,{title:'Choose a folder to organize in place',properties:['openDirectory']});
   if(result.canceled||!result.filePaths[0])break;
   const root=await fs.realpath(result.filePaths[0]),info=await validateDestination(root,state.sources);
   if(!info.volumeId)throw new MessageError('error.folderUnidentified');
   approved.add(root);
   const prefs=snapshotPreferences();prefs.copyMode='single';prefs.destinations=[root];prefs.destinationIds=[info.volumeId];prefs.basePath='';
   if(prefs.mediaLayout==='video-root')throw new MessageError('error.organizeFolderVideo');
   queueOrganization(root,`Organize ${path.basename(root)}`,{prefs,reorganize:true,options:takeOrganizeOptions()});break;
  }
  case 'organizeBackup':{const index=input.destinationIndex;if(index!==0&&index!==1)throw new Error('Invalid organization destination');queueBackupOrganization(index);break;}
  case 'previewOrganization':{const root=snapshotPreferences(input.destinationIndex).destinations[0];await previewSource({id:'library:'+root,path:root,name:'Existing library',transport:'folder'},false,input.destinationIndex,typeof input.collectProblemFiles==='boolean'?input.collectProblemFiles:undefined);break;}
  case 'applyReview':await applyReview();break;
  case 'discardReview':await discardReview();pump();break;
  case 'window': if(input.command==='minimize')window?.minimize();else if(input.command==='maximize'){if(window?.isMaximized())window.unmaximize();else window?.maximize();}else if(input.command==='close')window?.close();break;
  case 'clearError':if(typeof input.id==='string')clearErrors(errorLog,state,input.id,input.severity==='error'||input.severity==='warning'?input.severity:undefined);else state.error=undefined;break;
  case 'clearErrors':clearErrors(errorLog,state,undefined,input.severity==='error'||input.severity==='warning'?input.severity:undefined);break;
  case 'refresh':await refresh();break;
  case 'preferences':{
   const patch=input.patch;
   if(patch.editedFolder!==undefined&&(typeof patch.editedFolder!=='string'||!patch.editedFolder.trim()||patch.editedFolder!==patch.editedFolder.trim()||/[{}\\/:\x00-\x1f]/.test(patch.editedFolder)||['.','..'].includes(patch.editedFolder)))throw new MessageError('error.editedFolderName');
   // Display and queue settings apply at once. Settings a job reads are refused, not silently dropped,
   // while any job runs, waits in the queue or is paused, or a review is open: stop it completely first.
   const idle=!busy()&&!settingsLocked(state),before=state.preferences;
   if(!idle&&lockedPreferenceKeys(patch).length)throw new MessageError('error.settingsLocked');
   const accepted=Object.fromEntries(Object.entries(patch).filter(([key])=>livePreferences.has(key)||idle&&jobPreferences.has(key)));
   state.preferences=normalizePreferences({...before,...accepted},before);
   nativeTheme.themeSource=state.preferences.appearance;
   if(before.automatic&&!state.preferences.automatic)for(const j of state.jobs)if(j.phase==='queued'&&automaticallyQueued.has(j.id)){j.phase='stopped';j.detail=message('job.automaticDisabled');}
   if(state.preferences.autoOrganizeBackup==='off'){misplacedControl?.abort();state.misplacedFiles={};}else scheduleMisplacedCheck(true);
   await save();pump();break;
  }
  case 'chooseDestination':{if(busy()||state.review||state.busyReview)throw new MessageError('error.busy');if(input.index!==0&&input.index!==1)throw new Error('Invalid destination');const result=await dialog.showOpenDialog(window!,{title:`Choose destination ${input.index+1}`,properties:['openDirectory','createDirectory']});if(!result.canceled&&result.filePaths[0]){const root=await fs.realpath(result.filePaths[0]);const info=await validateDestination(root,state.sources);if(!info.volumeId)throw new MessageError('error.destinationUnidentified');state.preferences.destinations[input.index]=root;(state.preferences.destinationIds??=[])[input.index]=info.volumeId;approved.add(root);await save();await refresh();}break;}
  case 'removeDestination':{if(busy()||state.review||state.busyReview)throw new MessageError('error.busy');state.preferences.destinations.splice(input.index,1);state.preferences.destinationIds?.splice(input.index,1);await save();await refresh();break;}
  case 'chooseSource':{if(!input.backup&&!state.preferences.allowFolderSource)throw new MessageError('error.folderSourcesOff');const result=await dialog.showOpenDialog(window!,{title:input.backup?'Choose drives or folders to back up':'Choose media sources',properties:['openDirectory','multiSelections']});if(result.canceled||!result.filePaths.length)break;const {sources,rejected}=await resolveFolderSources(result.filePaths,{sources:state.sources,registered:folders,destinations:state.preferences.destinations,backupFolders:backupFolders(state.preferences),backup:input.backup});const now=new Date().toISOString();for(const source of sources){approved.add(source.path);folders.set(source.id,{source,backup:input.backup});selection.select(source,true,state.preferences.rememberedDevices??={},now,state.preferences.ignoredDevices??={});state.sources=[...state.sources.filter(s=>s.id!==source.id&&s.path!==source.path),source];}if(sources.length){state.sources=selection.apply(state.sources,state.preferences.rememberedDevices??={},state.preferences.ignoredDevices??={},state.preferences.deviceHistory??={});publishDevices();await save();}const [first]=rejected;if(first)throw new MessageError(first.key,first.params);break;}
  case 'start':{
   if(state.review){await applyReview();break;}
   if(input.sourceId)selection.dismissReconnected(input.sourceId);else for(const source of state.sources)if(source.selected)selection.dismissReconnected(source.id);publishDevices();
   if(input.sourceId&&state.sources.some(s=>s.id===input.sourceId&&!s.selected))throw new MessageError('error.selectDrive');
   for(const source of state.sources.filter(s=>input.sourceId?s.id===input.sourceId:s.selected))enqueue(source,folders.get(source.id)?.backup??false);pump();break;
  }
  case 'retryJob':{
   // Runs a job that ended with errors again, files it skipped included. Verified copies are recognised, not copied again.
   const failed=state.jobs.find(job=>job.id===input.jobId&&job.retryable&&job.phase==='error'&&!active.has(job.id));if(!failed)break;
   if(failed.organization){const request=organizationRuns.get(failed.id);if(!request)throw new MessageError('error.recoveryListStale');queueOrganization(failed.source.path,failed.source.name,{...request,exclude:undefined,skipErrors:undefined});delete failed.retryable;delete failed.skippablePath;break;}
   if(!state.sources.some(source=>source.id===failed.source.id))throw new MessageError('error.sourceDisconnected');
   if(state.jobs.some(job=>job.source.id===failed.source.id&&['queued','discovering','verifying','copying'].includes(job.phase)))throw new MessageError('error.busy');
   enqueue(failed.source,failed.backup);if(state.jobs.some(job=>job.source.id===failed.source.id&&job.phase==='queued')){delete failed.retryable;delete failed.skippablePath;}pump();break;
  }
  case 'skipFile':
  case 'skipAndContinue':{
   // Skip leaves the file that stopped the job out; Skip all also skips every other file that fails. Verified copies are recognised, not copied again.
   const failed=state.jobs.find(job=>job.id===input.jobId&&job.skippablePath&&(job.phase==='error'||job.phase==='stopped')&&!active.has(job.id));if(!failed)break;
   if(input.type==='skipFile'&&input.path!==failed.skippablePath)break;
   const skip={exclude:[...new Set([...(failed.excluded??[]),failed.skippablePath!])],...(input.type==='skipAndContinue'?{skipErrors:true}:{})};
   // The buttons go away only once the rerun is queued; a refusal leaves them to try again.
   if(failed.organization){const request=organizationRuns.get(failed.id);if(!request)throw new MessageError('error.recoveryListStale');queueOrganization(failed.source.path,failed.source.name,{...request,...skip});delete failed.skippablePath;break;}
   if(state.jobs.some(job=>job.source.id===failed.source.id&&['queued','discovering','verifying','copying'].includes(job.phase)))throw new MessageError('error.busy');
   for(const id of skipRequests.keys())if(!state.jobs.some(job=>job.id===id&&job.phase==='queued'))skipRequests.delete(id);
   enqueue(failed.source,failed.backup);const queued=state.jobs.find(job=>job.source.id===failed.source.id&&job.phase==='queued');if(queued){skipRequests.set(queued.id,skip);delete failed.skippablePath;}pump();break;
  }
  case 'pause':{
   // Pause stops at once like Stop; verified copies stay, and Start continues with the rest.
   // An organization pauses only when its own card asks; its journal keeps the moves made so far.
   for(const job of state.jobs)if(job.organization?job.source.id===input.sourceId:(!input.sourceId||job.source.id===input.sourceId)){
    if(job.phase==='queued'){job.phase='stopped';job.paused=true;job.detail=message(job.organization?'job.organizationPaused':'job.pausedQueued');}
    else if(active.has(job.id)){pausing.add(job.id);job.stopping='pause';active.get(job.id)!.abort();}
   }
   break;
  }
  case 'continueOrganization':{
   // A paused organization continues from its journal; one paused before any move was journaled runs again.
   const paused=state.jobs.find(job=>job.id===input.jobId&&job.organization&&job.paused&&job.phase==='stopped');if(!paused)throw new MessageError('error.recoveryListStale');
   if(organizationQueue.has(paused.id)){paused.phase='queued';paused.paused=false;paused.detail=message('job.waitingForImports');pump();break;}
   await refreshOrganizations();
   const journal=(state.organizationRecovery??[]).filter(item=>item.status==='pending'&&within(item.root,paused.source.path)).at(-1);
   paused.paused=false;
   if(journal){await resumeOrganizationJob(journal.root,journal.id,'resume',paused.source,paused.folders);break;}
   const request=organizationRuns.get(paused.id);if(!request)throw new MessageError('error.recoveryListStale');
   queueOrganization(paused.source.path,paused.source.name,request);break;
  }
  case 'moveToTop':{
   const source=state.sources.find(item=>item.id===input.sourceId);if(!source)throw new MessageError('error.sourceDisconnected');
   sourceOrder=moveToFront(sourceOrder,source.id);
   break;
  }
  case 'dismissReconnected':selection.dismissReconnected(input.sourceId);publishDevices();break;
  case 'selectSource':{
   const source=state.sources.find(s=>s.id===input.sourceId);if(!source)throw new MessageError('error.sourceDisconnected');selection.dismissReconnected(source.id);
   selection.select(source,Boolean(input.selected),state.preferences.rememberedDevices??={},new Date().toISOString(),state.preferences.ignoredDevices??={});
   state.sources=selection.apply(state.sources,state.preferences.rememberedDevices,state.preferences.ignoredDevices,state.preferences.deviceHistory??={});publishDevices();await save();break;
  }
  case 'forgetDevice':{
   selection.forget(String(input.deviceId),state.preferences.rememberedDevices??={},state.preferences.ignoredDevices??={});
   state.sources=selection.apply(state.sources,state.preferences.rememberedDevices,state.preferences.ignoredDevices,state.preferences.deviceHistory??={});publishDevices();await save();break;
  }
  case 'stop':{if(!input.jobId){await discardReview();for(const control of scanControls.values())control.abort();}for(const job of state.jobs)if(!input.jobId||job.id===input.jobId){pausing.delete(job.id);if(job.phase==='queued'||job.paused){job.phase='stopped';job.paused=false;job.detail=message('job.removedFromQueue');}if(active.has(job.id))job.stopping='stop';active.get(job.id)?.abort();}for(const s of state.sources)seen.add(s.id);break;}
  case 'unknownRule':{if(state.busyReview)throw new MessageError('error.rulesDuringReview');const ext=input.extension.replace(/^\.+/,'').trim().toLowerCase();const rule=rules({[ext]:input.folder})[ext];sessionRules[ext]=rule;if(input.remember){state.preferences.unknownRules[ext]=rule;await save();}if(reviewed?.review.kind==='import')await discardReview();break;}
  case 'reveal':{
   // A file that is gone (moved, or its drive disconnected) shows the nearest folder that still exists, within the same allowed places.
   let target=input.path;
   for(;;)try{target=await allowed(target);break;}catch(error){const parent=path.dirname(target);if((error as NodeJS.ErrnoException).code!=='ENOENT'||parent===target)throw error;target=parent;}
   shell.showItemInFolder(target);break;
  }
  default:throw new Error('Unknown action');
 }
 emit();
}
async function boot(){
 let hardwareReportRoot:string|undefined;
 if(hardwareTest){const requested=process.argv.find(arg=>arg.startsWith('--hardware-report-root='))?.slice('--hardware-report-root='.length);const temporary=await fs.realpath(os.tmpdir());hardwareReportRoot=await fs.realpath(requested??await fs.mkdtemp(path.join(os.tmpdir(),'photo-importer-a006-release-')));if(!within(hardwareReportRoot,temporary)||hardwareReportRoot===temporary)throw new Error('Hardware reports require a dedicated existing temporary folder.');app.setPath('userData',path.join(hardwareReportRoot,'user-data'));}
 if(qaFixtureRoot){const root=await fs.realpath(qaFixtureRoot);if(!within(root,await fs.realpath(os.tmpdir())))throw new Error('QA fixtures must be in the system temporary directory.');app.setPath('userData',path.join(root,'user-data'));}
 try{await initializeRecoveryKey();}catch(error){state.error=toMessage(error);}
 await load();
 if(hardwareReportRoot)state.preferences=normalizePreferences({destinations:[hardwareDestination.path],destinationIds:[hardwareDestination.volumeId]});
 nativeTheme.themeSource=state.preferences.appearance;
 if(qaFixtureRoot){const root=await fs.realpath(qaFixtureRoot);if(!within(root,await fs.realpath(os.tmpdir())))throw new Error('QA fixtures must be in the system temporary directory.');const destination=path.join(root,'destination');const info=await volumeInfo(destination);state.preferences.destinations=[destination,path.join(root,'destination-2')];state.preferences.destinationIds=[info.volumeId??'',info.volumeId??''];for(let i=1;i<=6;i++){const folder=await fs.realpath(path.join(root,`source-${i}`));const source:Source={id:`fixture:${i}`,name:`Fixture card ${i}`,path:folder,transport:'folder',total:info.total,free:info.free};folders.set(source.id,{source,backup:true});approved.add(folder);}}
 session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
 const renderer=path.join(__dirname,'../renderer/index.html');
 window=new BrowserWindow({frame:process.platform==='darwin',...(process.platform==='darwin'?{titleBarStyle:'hidden' as const,trafficLightPosition:{x:18,y:15}}:{}),title:'Automatic Photo Importer',width:1440,height:940,minWidth:1000,minHeight:720,backgroundColor:'#151c24',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,scrollBounce:true}});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
 function trusted(event:Electron.IpcMainInvokeEvent){if(!window||event.sender!==window.webContents||event.senderFrame?.url!==pathToFileURL(renderer).href)throw new Error('Untrusted request');}
 ipcMain.handle('importer:state',event=>{trusted(event);return stateChannel.snapshot(state);});
 ipcMain.handle('importer:action',async(event,value)=>{trusted(event);try{await action(value);}catch(e){state.error=toMessage(e);emit();}});
 ipcMain.handle('importer:inspect',async(event,file:string)=>{trusted(event);inspecting++;try{return await metadata(await allowed(file));}finally{inspecting--;void releaseIfIdle();}});
 await window.loadFile(renderer);await refresh();timer=setInterval(()=>void refresh(),5000);
 if(hardwareReportRoot){const reports=hardwareReportRoot,owner=window;runA006HardwareTest(()=>state,action,reports,async source=>{const result=await dialog.showOpenDialog(owner,{title:`Authorize read access: ${source.name}`,defaultPath:source.path,properties:['openDirectory']});if(result.canceled||!result.filePaths[0]||await fs.realpath(result.filePaths[0])!==await fs.realpath(source.path))throw new Error(`Select the exact source root: ${source.path}`);}).catch(error=>{state.error=text(`A006 hardware test failed: ${errorText(error)}. Reports: ${reports}`);emit();});}
 if(qa&&qaFixtureRoot&&process.argv.includes('--codex-test')){const passed=await runCodexSmoke(window,qaFixtureRoot,process.argv.includes('--codex-ui-only'),process.argv.includes('--codex-organization-only'));await closeMetadata();app.exit(passed?0:1);}
}
if(!qa&&!hardwareTest&&!app.requestSingleInstanceLock())app.quit();else app.whenReady().then(boot).catch(error=>{dialog.showErrorBox('Unable to start',errorText(error));app.quit();});
app.on('second-instance',()=>{if(window?.isMinimized())window.restore();window?.focus();});
app.on('window-all-closed',()=>app.quit());
let quitting=false,closing:Promise<void>|undefined;
// Holding a system shutdown or logout would cancel it; jobs are then stopped without waiting. The camera
// helper is then only asked to end, and exiftool ends when its input closes with this process.
app.whenReady().then(()=>powerMonitor.on('shutdown',()=>{quitting=true;})).catch(()=>{});
app.on('before-quit',event=>{
 if(timer)clearInterval(timer);cancelAutomaticChecks();
 for(const control of active.values())control.abort();for(const control of scanControls.values())control.abort();misplacedControl?.abort();residueControl?.abort();reviewControl?.abort();
 // A quit the closing step started, or a system shutdown, goes through; another quit meanwhile waits for it.
 if(!quitting&&closing){event.preventDefault();return;}
 if(!quitting){
  // Stopped jobs, scans and an open review remove their staging files and camera downloads first, then
  // everything that holds a drive is closed (all within 10 s).
  event.preventDefault();
  const finish=async()=>{
   await Promise.allSettled([...settling,scansSettled(),misplacedTask,residueTask,...(reviewed||reviewControl?[discardReview()]:[])]);
   await Promise.allSettled([closeMetadata(),closeCameraBridge(),terminateHasher()]);
  };
  closing=Promise.race([finish(),new Promise<void>(resolve=>setTimeout(resolve,10000).unref())]).finally(()=>{quitting=true;app.quit();});
  return;
 }
 void closeMetadata();void closeCameraBridge();
});
