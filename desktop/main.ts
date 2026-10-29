import './threadpool';
import {startCatalog} from './catalog/process';
import {createCatalogSession,type CatalogSession} from './catalog/session';
import {CatalogCoordinator,bindLibrary,catalogStat,type LibraryBinding} from './catalog/coordinator';
import {resolveCatalogFile} from './catalog/access';
import {configuredRefreshIds,createCatalogRefreshScheduler} from './catalog/refresh-scheduler';
import type {Catalog,CatalogQuery,CategoryField} from './catalog/types';
import {stopOperations} from './stop-scope';
import {publishSourceModes} from './source-modes';
import {app,BrowserWindow,clipboard,dialog,ipcMain,shell,session,nativeTheme,powerMonitor,powerSaveBlocker} from 'electron';
import {keepAwake} from './keep-awake';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import type {ResourceUse,DuplicateGroup,DuplicateScope,DuplicatesState,Action,AppState,Preferences,Job,Source,SourceCameraInfo,TransferPlan,DestinationStatus,Inventory,Listing,Progress,Review,DestinationSpace,OrganizeOptions,ProblemFile,NoMetadataSummary} from './shared';
import {NO_METADATA_LIST_LIMIT,UNKNOWN_FILES_FOLDER,isLive,isRunning} from './shared';
import {misplacedScope,staleMisplaced,touchedMisplaced} from './misplaced-results';
import {checkFolderSettings,ruleOptions,rulesScope} from './routing-options';
import {unknownDecision} from './unknown-confirm';
import {noMetadataFolderName} from './no-metadata';
import {plan,findMisplaced,placedByEarlierJournals,type PlanProgress,type PlanRequest,type OrganizationProgress,getOrganizationRecovery,resumeOrganization,finalizeOrganization,undoOrganization,deleteOrganizationRecovery,measureOrganizationRecovery,configureOrganizationRecovery,RECOVERY_FOLDER,setMoveObserver} from './core';
import {settingsLocked,acceptedPreferences} from './settings-lock';
import {within,isAbort} from './core/paths';
import {rules} from './core/inventory';
import {executeDestinations,type DestinationOutcome} from './core/destinations';
import {routingChanged,rememberRouting} from './platform/routing-memory';
import {allocateDestinations,fillFirst,destinationEntries,olderRulesPaths,destinationParts,destinationSpace,freeAfterReservations,reservationVolume,requiredTransferSpace,requiredOrganizationSpace} from './core/allocation';
import {activityTargets,createDriveSampler,runIoreg,startActivityLoop} from './platform/drive-activity';
import {backupDriveIdentity,folderCapacity,getSources,mountedVolumes,volumeInfo,volumeOf,validateDestination,type MountedVolume} from './platform/volumes';
import {driveCameraRecord} from './source-cameras';
import {backupFolders,destinationRoots,libraryRoots} from './platform/destination-roots';
import {resolveFolderSources} from './folder-sources';
import {DeviceSelection,deviceId,recordDeviceHistory} from './device-selection';
import {moveToFront,nextRunnable,orderSources,queueOrder} from './queue-order';
import {deviceHasRoom} from './core/devices';
import {loadScanMemory,saveScanMemory,loadImported,rememberImported} from './platform/scan-memory';
import {loadListingHint,rememberListing} from './platform/listing-memory';
import {loadPlacement,placedMatches,placedOutcomes,placementId,rememberEntries,replacePlacement} from './platform/placement-memory';
import {listingEstimate,scopeHint,type ListingHint} from './listing-estimate';
import {metadata,closeMetadata,primeRouting,routingEntriesUnder,cachedRouting,previewFoldersInUse,carryRouting,embeddedPreview} from './platform/metadata';
import {thumbnail,systemDecoders} from './platform/thumbnails';
import {removeDuplicates,afterRemoval,type RemovalResult} from './core/duplicate-removal';
import {resolveGroups,summarize} from './duplicate-rules';
import {findResidue,cleanResidue,removeUnboundReceipt,type ResidueItem} from './core/residue';
import {orphanedJournals} from './core/recovery';
import {registerDestinations} from './core/app-store';
import {OldRecordsNotice,onOldRecordsFound,type DriveRoots} from './core/old-records';
import {recordPlanDuplicates,scanDuplicates,overlappingLibraries,type PlanDuplicates} from './core/duplicates';
import {destinationIndex} from './core/destination-index';
import {identity} from './core/paths';
import {prepareCamera,closeCameraBridge} from './platform/camera-bridge';
import {startScan,scansSettled} from './scan-process';
import {terminateHasher} from './core/hasher';
import {defaultCpuThreads,defaultMemoryLimitMB,setResourceLimits,resourceLimits,governor,setChildMemory,setMainMemory,privateOrRss,childProcessMemory,limiter,cpuWorkers,hostNow,memoryRange,MB} from './resource-limits';
import {runCodexSmoke} from './qa/codex-smoke';
import {createQaHooks,type QaHooks} from './qa/hooks';
import {runA006HardwareTest,hardwareDestination} from './qa/a006-hardware';
import {createStateChannel} from './state-channel';
import {ErrorLog,clearErrors,createErrorLogCache} from './error-log';
import {acknowledgeJob,acknowledgeSummary} from './acknowledge';
import {addErrors,appleDoubleIssues,noMetadataIssues,errorTotal,issuePaths,recordIssues,reportSummary,throttled} from './job-issues';
import {EtaTracker,stampEstimates} from './eta';
import {PriorStore,type DriveInfo} from './eta-priors';
import {normalizePreferences} from './preferences';
import {sourcePolicy,freshOrganizeOptions} from './run-policy';
import {measureOriginals,deleteOriginals,verifiedOriginals,type VerifiedOriginal} from './core/originals';
import {filePath,joined,message,MessageError,savedMessage,text,toMessage,type Message} from './messages';
import {deferredRefresh} from './deferred-refresh';
import {configureLogger,activeLogger,log,setLogLevel,withJob} from './logger';
import {PhaseLog,TopologyLog,ActivityLog,logProgress} from './job-log';
import {exportLogs} from './log-export';

const qa=process.argv.includes('--qa')||process.execPath.includes(' QA.app/');
/** Synthetic state and the import gate for the automated QA; only an unpackaged --codex-test launch has them. */
let qaHooks:QaHooks|undefined;
const hardwareTest=process.argv.includes('--hardware-test-a006');
const qaFixtureRoot=qa?(process.argv.find(arg=>arg.startsWith('--qa-fixture-root='))?.slice('--qa-fixture-root='.length)||path.join(os.tmpdir(),'photo-importer-electron-fixtures')):undefined;

const state:AppState={preferences:normalizePreferences(undefined),sources:[],jobs:[],history:[],platform:process.platform,destinationStatus:[],organizeOptions:freshOrganizeOptions()};
let catalog:Catalog|undefined,catalogCoordinator:CatalogCoordinator|undefined,catalogSession:CatalogSession|undefined;
let catalogPublishTimer:NodeJS.Timeout|undefined,catalogClosing=false;
const catalogFallbacks=new Map<string,string>(),catalogConnected=new Set<string>(),catalogStopped=new Set<string>();
let rememberedCatalogLibraries:LibraryBinding[]=[];
const catalogManifest=()=>path.join(app.getPath('userData'),'catalog','libraries.json');
function catalogAvailable():CatalogCoordinator{if(!catalogCoordinator)throw new Error('Catalog is unavailable.');return catalogCoordinator;}
function catalogMember(id:unknown):CatalogCoordinator{const coordinator=catalogAvailable();if(typeof id!=='string'||!coordinator.binding(id))throw new Error('Unknown library.');return coordinator;}
async function catalogVolumeValid(binding:LibraryBinding,fresh=false):Promise<boolean>{
 const volumes=fresh?await mountedVolumes():mounts,volume=volumeOf(volumes,binding.root);
 return binding.library.trustedVolumeId?volume?.volumeId===binding.library.volumeId:!!volume&&volume.path===binding.library.mountPath;
}
function publishCatalog(){
 if(catalogPublishTimer||catalogClosing)return;
 catalogPublishTimer=setTimeout(()=>{catalogPublishTimer=undefined;const coordinator=catalogCoordinator;if(!coordinator)return;void Promise.all(coordinator.libraries.map(async library=>[library.libraryId,await coordinator.status(library.libraryId)] as const)).then(entries=>{state.catalogLibraries=coordinator.libraries;state.catalogStatuses=Object.fromEntries(entries);emit();}).catch(error=>log('normal','catalog','status-failed',{error}));},250);
}
function requestCatalogRefresh(){catalogRefreshScheduler.request();}
function pauseCatalog(){if(catalogCoordinator?.running){catalogRefreshScheduler.request();catalogCoordinator.stop();}}
function catalogIdle():boolean{return !active.size&&!scanControls.size&&!state.busyReview&&!state.review&&!reviewControl&&!resumingOrganizations.size&&!duplicateControl&&!misplacedControl&&!residueControl&&!recoveryRefresh.running&&!originalsControls.size;}
const catalogRefreshScheduler=createCatalogRefreshScheduler({
 idle:()=>!catalogClosing&&!!catalogCoordinator&&catalogIdle(),
 error:error=>log('normal','catalog','refresh-warning',{error}),
 run:async()=>{
  const coordinator=catalogCoordinator;if(!coordinator)return;
  const ids=coordinator.needsRefresh().filter(id=>!catalogStopped.has(id));if(!ids.length)return;
  inspecting++;
  try{if(releasing)await releasing;for(const id of ids){if(catalogClosing||!catalogIdle()){requestCatalogRefresh();break;}if(catalogStopped.has(id))continue;await coordinator.refresh(id,new AbortController().signal);}}
  finally{inspecting--;publishCatalog();void releaseIfIdle();}
 }
});
function scheduleCatalogRefresh(){catalogRefreshScheduler.resume();}
async function configureCatalog(){
 const coordinator=catalogCoordinator;if(!coordinator)return;
 const bindings:LibraryBinding[]=[],previous=coordinator.libraries.length?coordinator.libraries.map(library=>coordinator.binding(library.libraryId)!):rememberedCatalogLibraries;
 const wanted=coordinator.needsRefresh();
 for(const [index,destination] of state.preferences.destinations.entries()){
  const status=state.destinationStatus?.[index],volume=volumeOf(mounts,destination),expected=state.preferences.destinationIds?.[index],online=!!status?.available&&(!expected||status.volumeId===expected);
  const prior=previous.find(binding=>binding.library.destinationIndex===index&&(!expected||binding.library.volumeId===expected)&&within(binding.root,path.resolve(destination)));
  const mountPath=online?volume?.path??destination:prior?.library.mountPath??destination;
  if(online&&!catalogConnected.has(destination))catalogFallbacks.set(destination,randomUUID());if(!catalogFallbacks.has(destination))catalogFallbacks.set(destination,randomUUID());if(online)catalogConnected.add(destination);else catalogConnected.delete(destination);
  for(const [position,root] of libraryRoots(destination,state.preferences).entries())bindings.push(await bindLibrary({root,mountPath,volumeId:expected||(online?volume?.volumeId:prior?.library.trustedVolumeId?prior.library.volumeId:undefined),fallbackId:catalogFallbacks.get(destination),name:`${path.basename(destination)} · ${position?'Videos':'Photos'}`,role:position?'videos':'photos',rulesScope:rulesScope(ruleOptions(state.preferences)),online,destinationIndex:index}));
 }
 for(const location of organizationLocations.filter(item=>item.folder)){
  if(bindings.some(binding=>binding.root===location.root))continue;const volume=volumeOf(mounts,location.root);
  bindings.push(await bindLibrary({root:location.root,mountPath:volume?.path??location.destination,volumeId:location.volumeId,name:path.basename(location.root),role:'photos',rulesScope:rulesScope(ruleOptions(state.preferences)),online:!!volume&&volume.volumeId===location.volumeId}));
 }
 for(const binding of previous)if(!bindings.some(current=>current.library.libraryId===binding.library.libraryId))bindings.push({...binding,rootIdentity:undefined,library:{...binding.library,online:false}});
 const changed=await coordinator.configure(bindings);state.catalogLibraries=coordinator.libraries;publishCatalog();const added=configuredRefreshIds(wanted,coordinator.needsRefresh(),changed);for(const id of added)catalogStopped.delete(id);if(added.length)requestCatalogRefresh();
 const persisted=coordinator.libraries.filter(library=>library.trustedVolumeId).map(library=>({library:{...library,online:false},root:coordinator.binding(library.libraryId)!.root}));
 const manifest=JSON.stringify(persisted);if(manifest!==JSON.stringify(rememberedCatalogLibraries)){rememberedCatalogLibraries=persisted;void fs.mkdir(path.dirname(catalogManifest()),{recursive:true}).then(()=>fs.writeFile(catalogManifest(),manifest)).catch(error=>log('normal','catalog','manifest-warning',{error}));}
}
/** The source files each finished folder import copied and verified (by job), for Delete originals already in the backup. Only in memory. */
const importedOriginals=new Map<string,{root:string;files:VerifiedOriginal[]}>();
/** Organizing a folder starts every run with these on; only an explicit choice for the run changes them, and the run uses them up. */
function takeOrganizeOptions():OrganizeOptions{const options={...(state.organizeOptions??freshOrganizeOptions())};state.organizeOptions=freshOrganizeOptions();return options;}
let window:BrowserWindow|undefined;
let timer:NodeJS.Timeout|undefined;
// Live drive utilization (macOS IOKit statistics): every second while the window is visible or work runs; stopped while hidden and idle.
let activityLoop:ReturnType<typeof startActivityLoop>|undefined;
const driveSampler=createDriveSampler({run:runIoreg});
let refreshing=false;
/** The mounted volumes as the last refresh described them; paths resolve to drives against this, not a new sweep. */
let mounts:MountedVolume[]=[];
/** Where the diagnostic log is and how large; size rounded so the state does not change with every line. */
function logInfo():AppState['logInfo']{const stats=activeLogger()?.stats();return stats?{dir:stats.dir,...(stats.latest?{latest:stats.latest}:{}),bytes:Math.ceil(stats.bytes/1024)*1024}:undefined;}
// The recovery listing waits while a review or a job is planning: its file calls would queue ahead of the planner's.
// A file the organization moved keeps its routing metadata under its new path, so the check after the job does not read it again.
setMoveObserver((from,reviewed,to,now,action)=>{
 try{carryRouting(from,reviewed,to,now);}catch(error){log('normal','catalog','routing-carry-warning',{error});}
 const coordinator=catalogCoordinator;if(!coordinator)return;
 const old=coordinator.libraries.map(library=>coordinator.binding(library.libraryId)!).filter(binding=>within(from,binding.root)).sort((a,b)=>b.root.length-a.root.length)[0];
 return coordinator.observeMove({action:action??'organize',libraryId:old?.library.libraryId??'',oldRoot:path.dirname(from),oldRelativePath:path.basename(from),newRoot:path.dirname(to),newRelativePath:path.basename(to),stat:catalogStat(now),reviewedStat:{dev:reviewed.dev,ino:reviewed.ino,size:reviewed.size,mtimeNs:reviewed.mtime,ctimeNs:reviewed.ctime},metadata:cachedRouting(from,`${reviewed.dev}:${reviewed.ino}:${reviewed.size}:${reviewed.mtime}:${reviewed.ctime}`)}).then(()=>{requestCatalogRefresh();publishCatalog();});
});
/** A job planning, copying or verifying (or a review being built) needs the drive's file calls: the organization listing gives way to it. */
const drivesInUse=()=>!!state.busyReview||state.jobs.some(isRunning);
/** Any job at all on a drive: converting earlier records waits for none to be running. */
const jobsActive=()=>drivesInUse()||active.size>0||resumingOrganizations.size>0||!!duplicateControl||!!residueControl||!!residueTask;
let listingControl:AbortController|undefined;
const recoveryRefresh=deferredRefresh({planning:drivesInUse,run:()=>refreshOrganizations().then(()=>emit()).catch(error=>{state.error=toMessage(error);emit();}).finally(()=>{void releaseIfIdle();})});
let recoveryScope='';
const folders=new Map<string,{source:Source;backup:boolean}>();
const active=new Map<string,AbortController>();
/** Delete originals runs on a finished job, so it is not in `active`; Stop, quitting and the idle test still see it here. */
const originalsControls=new Map<string,AbortController>();
const scanControls=new Map<string,AbortController>();
/** folder: an in-place organization of a chosen folder rather than a backup destination. */
interface OrganizationLocation {root:string;destination:string;volumeId:string;folder?:boolean;}
let organizationLocations:OrganizationLocation[]=[];
const organizationJobIds=new Set<string>();
interface RunRequest {prefs:Preferences;reorganize:boolean;/** Queued by an automatic import: it never waits for confirmation, it records a warning. */automatic?:boolean;/** The user already confirmed this job's unknown files. */confirmed?:boolean;/** This job only: file unknown files by file time instead of the saved choice. */useFileDate?:boolean;/** Organizing only: this run's choices (default: all on). */options?:OrganizeOptions;sourceFolders?:string[];/** Skip files that fail while planning for this job, whatever the setting. */skipErrors?:boolean;/** Source files the user chose to skip in this job. */exclude?:string[];}
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
// The last whole-source listing of each connected source, for the next listing to reuse: this session's, or for a card
// the one remembered across restarts under its UUID (loaded once per connection, verified folder by folder before reuse).
const listings=new Map<string,Listing>(),scanMemoryLoaded=new Set<string>();
const memoryVolume=(source:Source)=>source.transport==='storage'?deviceId(source):undefined;
/** `save`: also remember it across restarts (a card's import listing). */
function keepListing(source:Source,listing:Listing|undefined,save=true){
 if(!listing)return;
 listings.set(source.id,listing);
 const volume=memoryVolume(source);if(!save||!volume||qa)return;
 void saveScanMemory(app.getPath('userData'),volume,source.path,listing,routingEntriesUnder(source.path)).catch(()=>{/* Only a cache. */});
}
function loadRememberedScans(){
 const connected=new Set(state.sources.map(source=>source.id));
 for(const id of [...listings.keys()])if(!connected.has(id))listings.delete(id);
 for(const id of [...scanMemoryLoaded])if(!connected.has(id))scanMemoryLoaded.delete(id);
 for(const source of state.sources){
  const volume=memoryVolume(source);if(!volume||qa||scanMemoryLoaded.has(source.id))continue;
  scanMemoryLoaded.add(source.id);
  void loadScanMemory(app.getPath('userData'),volume,source.path).then(memory=>{
   if(!memory||!state.sources.some(item=>item.id===source.id&&item.path===source.path))return;
   // A listing made since connecting is newer.
   if(!listings.has(source.id))listings.set(source.id,memory.listing);
   primeRouting(memory.routing);
  });
 }
}
/** Remember that a device finished a scan (with the cameras it read) or a verified import, for the reconnection notice and Drives. */
function noteDevice(source:Source,event:'scan'|'import',cameras?:SourceCameraInfo){if(qa)return;const now=new Date().toISOString();recordDeviceHistory(state.preferences.deviceHistory??={},source,event,now,driveCameraRecord(cameras,now));void save().catch(()=>{});}
/** A chosen folder shows the capacity of the volume it lives on. */
/** A chosen folder shows the capacity of the volume it lives on: re-read it for that folder, every other folder on the
 * same drive and the jobs reading them (a finished job's card shows its own copy of the source). */
async function updateFolderCapacity(source:Source){
 if(source.transport!=='folder')return;
 const capacity=await folderCapacity(source.path);if(capacity.total===undefined)return;
 const same=(item:Source)=>item.id===source.id||(item.transport==='folder'&&!!source.drive&&item.drive?.volumeId===source.drive.volumeId);
 for(const [id,entry] of folders)if(same(entry.source))folders.set(id,{...entry,source:{...entry.source,...capacity}});
 state.sources=state.sources.map(item=>same(item)?{...item,...capacity}:item);
 for(const job of state.jobs)if(same(job.source))job.source={...job.source,...capacity};
}
function publishDevices(){state.newDevices=[...selection.newDevices];state.reconnectedDevices=[...selection.reconnectedDevices];}
const reusableScan=(source:Source)=>source.transport==='camera'?undefined:listings.get(source.id);
/** The used bytes of a whole drive (not a folder or a camera), which a listing of it is measured against when nothing better is known. */
const usedBytes=(source:Source)=>source.transport!=='camera'&&source.transport!=='folder'&&source.total!==undefined&&source.free!==undefined?source.total-source.free:0;
const sessionRules:Preferences['unknownRules']=state.sessionUnknownRules={};
/** Reserved destination plans for one source. A review holds one until applied. */
interface Prepared {/** The job this plan was parked from: its id (log lines), and whether it was an organization, so Continue keeps it one. */origin?:{jobId:string;organization?:boolean;folders?:string[]};/** What this was planned from, to plan again with file dates. */request:RunRequest;useFileDate?:boolean;/** Unknown files planning left or filed apart (all of them; the review carries a capped list). */noMetadata?:NoMetadataSummary;/** The drives read and written, for the time-left model. */eta:{source:DriveInfo;destinations:DriveInfo[]};problems:ProblemFile[];review:Review;prefs:Preferences;options:OrganizeOptions;inventory:Inventory;space?:DestinationSpace[];stage?:{path:string;cleanup():Promise<void>};/** Files left out of the plans because of an error; `text` is the English reason for reports. */failures:{path:string;error:Message;text:string}[];skipErrors:boolean;/** Duplicate detection stage 1 findings, recorded in each library after the job. */duplicates?:PlanDuplicates;/** An import: files already in the backup under older folder rules (skipped there) and families copied whole because only some members were. */elsewhere?:{files:number;partialFamilies:number;skipped:{size:number;candidates:number}[]};}
let reviewed:Prepared|undefined;
let reviewControl:AbortController|undefined;
const store=()=>path.join(app.getPath('userData'),'settings.json');
// A Duplicates scan holds the library's drive: imports and organizations wait for it (they are refused while it runs, queued jobs start after it).
/** Library roots a running job writes to; a Duplicates scan of one of them is stale afterwards. */
const touchedLibraries=new Map<string,string[]>();
const busy=()=>active.size>0||!!duplicateControl;
/** Refuses an operation while a job, a Remove duplicates scan or a review holds the drives. */
function assertIdle(key:'error.busy'|'error.busyResume'|'error.busyScan'='error.busy'){if(busy()||state.review||state.busyReview)throw new MessageError(key);}
// CPU and memory limits (Settings > Performance): applied to the next job; pools restart when idle (releaseIfIdle).
const applyLimits=()=>{setResourceLimits({maxCpuThreads:state.preferences.maxCpuThreads,memoryLimitMB:state.preferences.memoryLimitMB});log('detailed','resources','limits',{threads:state.preferences.maxCpuThreads,memoryMB:state.preferences.memoryLimitMB});};
let lastUsageMB=0,overLimit=false;
const resourceUse=():ResourceUse=>{const host=hostNow(),limits=resourceLimits();return {threads:limits.maxCpuThreads,memoryMB:Math.round(lastUsageMB),limitMB:limits.memoryLimitMB,cores:host.cores,totalMemMB:Math.round(host.totalMemBytes/MB),memoryMaxMB:memoryRange(host).max,defaultThreads:defaultCpuThreads(host),defaultMemoryMB:defaultMemoryLimitMB(host),...(overLimit?{warning:true}:{})};};
const thumbnailSlots=limiter(()=>cpuWorkers(4));
const stateChannel=createStateChannel(update=>{if(window&&!window.isDestroyed())window.webContents.send('importer:updated',update);});
// Each job carries when it started running and when its current phase began, so elapsed time
// can be shown; both are stamped as the state is published.
const phases=new Map<string,Job['phase']>();
const phaseLog=new PhaseLog(),topologyLog=new TopologyLog(),activityLog=new ActivityLog();
function stampJobs(){
 const now=new Date().toISOString();phaseLog.observe(state.jobs,Date.now());
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
const errorCache=createErrorLogCache(errorLog);
const etaTracker=new EtaTracker();
/** The drive a path is on, as the time-left model remembers drives: the volume id (hashed before it is saved), kind, file system and whether it is external. */
function etaDrive(volumes:MountedVolume[],target:string,transport:string):DriveInfo{
 const volume=volumeOf(volumes,target);
 return {...(volume?.volumeId?{id:volume.volumeId}:{}),transport,fsType:volume?.fsType,external:volume?.external===true};
}
/** What a plan will do, as the time-left model counts it: files and bytes to copy, and files to verify and publish. */
function etaTotals(plans:TransferPlan[]){
 const entries=plans.flatMap(item=>destinationEntries(item)),copy=entries.filter(entry=>!entry.skip),bytes=copy.reduce((sum,entry)=>sum+entry.size,0);
 return {copying:{files:copy.length,bytes},verifying:{files:entries.length,bytes}};
}
// A stalled step sends no progress; republish so its time left can grow instead of freezing.
setInterval(()=>{if(state.jobs.some(isRunning)){logProgress(state.jobs);emit();}},5000).unref();
// Imports and organizations must not stall because the Mac slept or dimmed the display mid-run.
const awake=keepAwake(powerSaveBlocker);
let lastEmit=0;
const emit=()=>{lastEmit=Date.now();yieldListing();activityLoop?.wake();state.resources=resourceUse();state.logInfo=logInfo();state.duplicates={...dup,scopes:duplicateScopes()};stampJobs();awake(state.jobs);stampEstimates(state,etaTracker,Date.now());state.errorLog=errorCache.refresh(state);state.sources=orderSources(publishSourceModes(state.sources,folders),sourceOrder);state.queueOrder=queueOrder(state.jobs,sourceOrder);stateChannel.publish(state);};
// Progress republishes at most 4 times a second while a job copies or verifies (the renderer is busy then), 10 otherwise. Phase changes and the final emit call emit() directly and are never dropped.
const progressEmit=throttled(()=>emit(),()=>state.jobs.some(job=>job.phase==='copying'||job.phase==='verifying')?250:100);
let saving:Promise<void>=Promise.resolve();
async function syncDirectory(folder:string){let handle:import('node:fs/promises').FileHandle|undefined;try{handle=await fs.open(folder,'r');await handle.sync();}catch(error){if(!['EINVAL','ENOTSUP','EISDIR','EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code??''))throw error;}finally{await handle?.close();}}
function save():Promise<void>{const data=JSON.stringify({preferences:state.preferences,history:state.history,organizationLocations,organizationFolders:state.organizationFolders},null,2);const write=saving.then(async()=>{await fs.mkdir(app.getPath('userData'),{recursive:true});const temp=store()+'.'+randomUUID()+'.new';const file=await fs.open(temp,'wx',0o600);try{await file.writeFile(data);await file.sync();}finally{await file.close();}await fs.rename(temp,store());await syncDirectory(app.getPath('userData'));});saving=write.catch(()=>{});return write;}
/** Writes one operation report as a new file (never replacing one) and syncs it: userData/operation-reports/<job>/<name>. */
async function writeReport(jobId:string,name:string,value:unknown){
 const directory=path.join(app.getPath('userData'),'operation-reports',jobId);await fs.mkdir(directory,{recursive:true});
 const file=await fs.open(path.join(directory,name),'wx',0o600);try{await file.writeFile(JSON.stringify(value,null,2));await file.sync();}finally{await file.close();}
}
async function initializeRecoveryKey(){
 const directory=app.getPath('userData');await fs.mkdir(directory,{recursive:true});const keyPath=path.join(directory,'organization-recovery.key');
 try{await fs.lstat(keyPath);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const temporary=keyPath+'.'+randomUUID()+'.new';const file=await fs.open(temporary,'wx',0o600);try{await file.writeFile(randomBytes(32));await file.sync();}finally{await file.close();}try{await fs.link(temporary,keyPath);await syncDirectory(directory);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}finally{await fs.unlink(temporary);}}
 const info=await fs.lstat(keyPath);if(!info.isFile()||info.isSymbolicLink())throw new Error('The organization recovery key is unavailable.');const key=await fs.readFile(keyPath);if(key.length!==32)throw new Error('The organization recovery key is invalid.');configureOrganizationRecovery(key);
}
async function load(){try{const data=JSON.parse(await fs.readFile(store(),'utf8'));state.preferences=normalizePreferences(data.preferences);applyLimits();state.organizationFolders=data.organizationFolders&&typeof data.organizationFolders==='object'?data.organizationFolders:{};state.history=Array.isArray(data.history)?data.history.slice(0,50).flatMap((entry:Record<string,unknown>)=>{const title=savedMessage(entry?.title),detail=savedMessage(entry?.detail);return title&&detail&&typeof entry.id==='string'&&typeof entry.date==='string'?[{id:entry.id,date:entry.date,title,detail}]:[];}):[];organizationLocations=Array.isArray(data.organizationLocations)?data.organizationLocations.filter((item:OrganizationLocation)=>typeof item?.root==='string'&&typeof item.destination==='string'&&typeof item.volumeId==='string'&&within(item.root,item.destination)):[];}catch{/* First launch uses explicit setup. */}if(qa)state.preferences=normalizePreferences(undefined);}
function addHistory(title:Message,detail:Message){state.history.unshift({id:randomUUID(),date:new Date().toISOString(),title,detail});state.history=state.history.slice(0,50);void save().catch(()=>{});}
async function allowed(file:string){const real=await fs.realpath(file);for(const root of [...approved,...state.sources.map(s=>s.path),...state.preferences.destinations,...(catalogCoordinator?.libraries.filter(library=>library.online).map(library=>catalogCoordinator!.binding(library.libraryId)!.root)??[])])if(within(real,await fs.realpath(root).catch(()=>root)))return real;throw new Error('Choose this file or its source folder first.');}
async function refresh(){
 if(refreshing)return;refreshing=true;
 try{
  const volumes=mounts=await mountedVolumes();const destinations=await Promise.all(state.preferences.destinations.map(p=>volumeInfo(p,volumes)));const found=qaFixtureRoot?[]:await getSources(volumes,{destinations});releaseMissingVolumes(volumes);
  state.destinationStatus=destinations;await configureCatalog().catch(error=>log('normal','catalog','configure-warning',{error}));
  // Records go to the store at the configured destination a library lies beneath (or at a folder organized in place).
  registerDestinations([...state.preferences.destinations,...organizationLocations.filter(location=>location.folder).map(location=>location.destination)]);
  // getSources leaves out the destinations, so every detected drive is a source.
  const detected=found;
  // A chosen folder the system now detects as a volume at the same path becomes that volume, still chosen.
  for(const source of detected){const selected=Array.from(folders.entries()).find(([,value])=>value.source.path===source.path);if(selected&&selected[0]!==source.id){folders.delete(selected[0]);folders.set(source.id,{source,backup:selected[1].backup});selection.replace(selected[0],source.id);}}
  state.sources=selection.apply([...detected,...Array.from(folders.values(),v=>v.source).filter(source=>source.transport==='folder'&&!detected.some(s=>s.path===source.path))],state.preferences.rememberedDevices??={},state.preferences.ignoredDevices??={},state.preferences.deviceHistory??={});publishDevices();loadRememberedScans();
  const connected=new Set(state.sources.map(s=>s.id));for(const id of Object.keys(state.sourceInventories??{}))if(!connected.has(id)){delete state.sourceInventories![id];delete state.sourceCameraInfo?.[id];scanControls.get(id)?.abort();}for(const id of seen)if(!connected.has(id))seen.delete(id);
  // Automatic imports wait until every destination the copy policy needs is connected;
  // unqueued sources stay unseen and are picked up on a later refresh.
  const required=state.preferences.copyMode==='single'?1:2,ready=destinations.length>=required&&destinations.slice(0,required).every(info=>info.available);
  // Automatic import only takes drives the user selected (now or on a previous connection).
  if(state.preferences.automatic&&ready){for(const source of state.sources.filter(s=>s.selected&&found.some(item=>item.id===s.id)))if(!seen.has(source.id)){seen.add(source.id);enqueue(source,folders.get(source.id)?.backup??false,true);}}
  // Folders' free space is re-read like a card's, so a capacity bar follows copies and deletions; so is a library's while a job runs on it.
  const shown=new Map([...state.sources,...state.jobs.map(job=>job.source)].map(source=>[source.id,source]));
  for(const source of shown.values())if(source.transport==='folder')await updateFolderCapacity(source);
  driveSampler.setTargets(activityTargets(volumes,state.sources,destinations));topologyLog.observe(volumes,state.sources,destinations);
  dropStaleMisplaced();emit();pump();scheduleOldRecordsCheck();scheduleResidueCheck();
  const scope=JSON.stringify([state.preferences.destinations,backupFolders(state.preferences),organizationLocations,destinations.map(info=>[info.path,info.available,info.volumeId])]);
  if(scope!==recoveryScope&&!recoveryRefresh.running){recoveryScope=scope;recoveryRefresh.request();}
  else recoveryRefresh.resume();
 }catch(error){state.error=toMessage(error);emit();}finally{refreshing=false;}
}
async function scanSource(source:Source){
 pauseCatalog();
 if(scanControls.has(source.id))return;
 if(source.transport==='camera')throw new MessageError('error.cameraScan');
 const control=new AbortController();cancelAutomaticChecks();scanControls.set(source.id,control);state.scanningSources=[...scanControls.keys()];emit();
 try{
  const previous=reusableScan(source),hint=await listingHint(source.path,undefined,false,scopeHint(previous?.files),usedBytes(source));let listing:Listing|undefined;
  await startScan(source,control.signal,(result,found)=>{listing=found;if(state.sources.some(item=>item.id===source.id&&item.path===source.path)){(state.sourceInventories??={})[source.id]=result;emit();}},summary=>{if(state.sources.some(item=>item.id===source.id&&item.path===source.path)){(state.sourceCameraInfo??={})[source.id]=summary;progressEmit();}},{unknownRules:{...state.preferences.unknownRules,...sessionRules},unknownDefault:state.preferences.unknownDefault},(files,bytes,file,top)=>{const {share}=listingEstimate(hint,{files,bytes},top);(state.scanProgress??={})[source.id]={files,bytes,...(file?{file}:{}),...(share!==undefined?{share}:{})};progressEmit();},primeRouting,{reuse:previous,routing:routingEntriesUnder(source.path),volume:volumeOf(mounts,source.path)});
  keepListing(source,listing);noteDevice(source,'scan',state.sourceCameraInfo?.[source.id]);await updateFolderCapacity(source);
 }
 catch(error){const info=state.sourceCameraInfo?.[source.id];if(info)state.sourceCameraInfo![source.id]={...info,status:control.signal.aborted?'stopped':'error',...(!control.signal.aborted?{error:errorText(error)}:{})};if(!control.signal.aborted)throw error;}

 finally{scanControls.delete(source.id);delete state.scanProgress?.[source.id];state.scanningSources=[...scanControls.keys()];emit();void releaseIfIdle();}
}
let organizationListing:Promise<void>|undefined,organizationListingAgain=false;
/** One listing at a time. A request while one runs gets one more listing right after it, so a
 * change made meanwhile (an undo or resume that just finished) is always shown. */
function refreshOrganizations():Promise<void>{
 if(organizationListing){organizationListingAgain=true;return organizationListing;}
 const control=listingControl=new AbortController();
 return organizationListing=(async()=>{
  try{do{organizationListingAgain=false;await listOrganizations(control.signal);}while(organizationListingAgain&&!control.signal.aborted);}
  catch(error){
   if(!isAbort(error))throw error;
   // A job took the drive: what was read is kept, and the listing goes on once no job is using it.
   organizationListingAgain=false;state.organizationRecoveryPaused=true;recoveryRefresh.defer();
  }
 })().finally(()=>{organizationListing=undefined;if(listingControl===control)listingControl=undefined;});
}
/** Called on every state change: stops a listing a job now needs the drive for, and starts a deferred one when none does. */
function yieldListing(){
 // The converter gives way to any job at once; each step finishes from what is on disk, so it picks up later.
 if(listingControl){if(!listingControl.signal.aborted&&drivesInUse()){log('detailed','listing','yield',{reason:'a job needs the drive; what was read is kept'});listingControl.abort();}}
 else if(!drivesInUse()){if(state.organizationRecoveryPaused)log('detailed','listing','resume',{reason:'no job is using the drive'});recoveryRefresh.resume();}
}
async function listOrganizations(signal:AbortSignal){
 const destinations=state.preferences.destinations;
 const locations=[...organizationLocations];
 const add=(root:string,destination:string,volumeId:string)=>{if(within(root,destination)&&!locations.some(item=>item.root===root))locations.push({root,destination,volumeId});};
 // Both backup folder settings on each destination, whatever the current layout: a journal may be in either.
 for(let index=0;index<destinations.length;index++){const destination=destinations[index];for(const folder of [state.preferences.basePath,state.preferences.videoBasePath])add(path.resolve(destination,folder),destination,state.preferences.destinationIds?.[index]??'');}
 // The previous list stays until each folder is read again, and is replaced folder by folder.
 const byRoot=new Map<string,NonNullable<AppState['organizationRecovery']>>();
 for(const job of state.organizationRecovery??[])byRoot.set(job.root,[...byRoot.get(job.root)??[],job]);
 const publish=()=>{state.organizationRecovery=[...byRoot.values()].flat();emit();};
 const listed=new Set<string>();state.organizationRecoveryLoading=true;state.organizationRecoveryPaused=false;emit();
 let looked=0;
 try{
  for(let position=0;position<locations.length;position++){
   signal.throwIfAborted();const location=locations[position]!;
   // A folder organized in place is listed while its own drive is present and unchanged.
   const status=location.folder?await volumeInfo(location.destination):destinations.includes(location.destination)?state.destinationStatus?.find(item=>item.path===location.destination):undefined;
   if(!status?.available||status.volumeId!==location.volumeId)continue;
   listed.add(location.root);
   try{
    const found=await getOrganizationRecovery(location.root,{verifyContents:false,includeEnded:true,signal,onProgress:update=>{
     const share=Math.min(.99,(position+update.share)/locations.length),file=update.file||path.basename(location.root);
     // What the listing is doing now: converting a finished journal, reading a journal's events, or checking its entries.
     state.organizationRecoveryProgress=update.later?{phase:'planning',step:'later',completed:update.later.done,total:update.later.total,bytes:0,totalBytes:0,share,speed:0,file}
      :update.read!==undefined?{phase:'planning',step:'records',completed:update.read,total:update.total??0,bytes:0,totalBytes:0,share,speed:0,file}
      :{phase:'planning',step:'scanning',completed:looked+update.looked,total:0,bytes:0,totalBytes:0,share,speed:0,file};progressEmit();}});byRoot.set(location.root,found);looked+=found.reduce((sum,job)=>sum+job.files,0);
    // A folder holding journals can be resumed, rechecked or undone from the list: remember it.
    if(found.length&&!organizationLocations.some(item=>item.root===location.root&&item.volumeId===location.volumeId)){organizationLocations.push({root:location.root,destination:location.destination,volumeId:location.volumeId,...(location.folder?{folder:true}:{})});await save();}
    // The sibling backup folders those journals list are read too, on the same drive.
    for(const library of found.flatMap(job=>job.libraries??[]))if(!location.folder)add(library,location.destination,location.volumeId);
   }catch(error){if(isAbort(error))throw error;state.error=toMessage(error);}
   publish();
  }
  // Journals whose library folder is gone stay listed, flagged, while their destination is connected.
  for(let index=0;index<destinations.length;index++){
   const destination=destinations[index]!,status=state.destinationStatus?.find(item=>item.path===destination);
   if(!status?.available||status.volumeId!==state.preferences.destinationIds?.[index])continue;
   for(const orphan of await orphanedJournals(destination).catch(()=>[])){if(!listed.has(orphan.root))byRoot.set(orphan.root,[]);listed.add(orphan.root);byRoot.get(orphan.root)!.push(orphan);}
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
 assertIdle();
 if(!state.organizationRecovery?.some(item=>item.root===root&&item.id===id))throw new MessageError('error.recoveryListStale');
 const location=organizationLocations.find(item=>item.root===root&&(item.folder||state.preferences.destinations.some((destination,index)=>destination===item.destination&&state.preferences.destinationIds?.[index]===item.volumeId)));if(!location)throw new MessageError('error.organizationDestination');
 // Claim before disk validation yields: a fast recheck may finish while a
 // second request is still validating, making a later busy() check insufficient.
 resumingOrganizations.add(operation);
 try{
 await stopResidueCheck();
 await validateDestination(location.destination,state.sources,{identity:location.volumeId});
 assertIdle('error.busyResume');
 if(!location.folder&&!state.preferences.destinations.some((destination,index)=>destination===location.destination&&state.preferences.destinationIds?.[index]===location.volumeId))throw new MessageError('error.organizationDestination');
 const job:Job={id:randomUUID(),source:source??{id:'organization:'+id,name:'Library organization',path:root,transport:'folder'},organization:true,...(folders?{folders}:{}),phase:'verifying',detail:message(kind==='finalize'?'job.recheckFinalize':kind==='undo'?'job.recheckUndo':kind==='delete'?'job.recheckDelete':'job.recheckJournal'),errors:[],backup:false};state.jobs.unshift(job);const control=startJob(job);emit();
 if(kind!=='delete')etaTracker.plan(job.id,{kind:kind==='finalize'?'finalize':kind==='undo'?'undo':'organization',destinations:[etaDrive(mounts,root,'storage')]});
 void settle(withJob(job.id,async()=>{try{
  // Finalize and undo check every entry before changing any, then change them in turn.
  const stepProgress=(progress:OrganizationProgress)=>{const verifying=progress.step==='checking'||recordSteps.includes(progress.step);job.phase=verifying?'verifying':'copying';job.progress={phase:verifying?'verifying':'copying',step:progress.step,completed:progress.completed,total:progress.total,bytes:0,totalBytes:0,speed:0,file:progress.file};job.detail=recordsDetail(progress)??message(progress.step==='checking'?'job.stepChecking':progress.step==='releasing'?'job.stepReleasing':progress.step==='deleting'?'job.stepDeleting':'job.stepRestoring',{completed:progress.completed,total:progress.total});progressEmit();};
  const duplicates=state.organizationRecovery?.find(item=>item.root===root&&item.id===id)?.kind==='duplicates';
  if(kind==='finalize'){const released=await finalizeOrganization(root,id,control.signal,stepProgress);job.phase='complete';job.detail=duplicates?message('job.duplicatesReleased',{count:released.removed,size:gigabytes(released.bytes)}):joined(message('job.released',{count:released.removed,size:gigabytes(released.bytes)}),released.handedOff>0&&message('job.handedOff',{count:released.handedOff}));addHistory(message(duplicates?'history.duplicatesReleased':'history.organization'),job.detail);}
  else if(kind==='undo'){const undone=await undoOrganization(root,id,control.signal,stepProgress);job.phase='complete';job.detail=duplicates?message('job.duplicatesUndone',{restored:undone.restored}):joined(message('job.undone',{restored:undone.restored,removed:undone.removed}),undone.handedOff>0&&message('job.handedOff',{count:undone.handedOff}));addHistory(message(duplicates?'history.duplicatesUndone':'history.organizationUndone'),job.detail);}
  else if(kind==='delete'){const deleted=await deleteOrganizationRecovery(root,id,control.signal,stepProgress);job.phase='complete';job.detail=message('job.recoveryDeleted',{count:deleted.files,size:gigabytes(deleted.bytes)});addHistory(message('history.recoveryDeleted'),job.detail);}
  else{const result=await resumeOrganization(root,id,control.signal,progress=>{job.progress=progress;job.phase=recordSteps.includes(progress.step??'')?'verifying':'copying';job.detail=recordsDetail(progress)??message('job.resuming');progressEmit();},{full});job.errors=result.errors.map(text);job.phase=result.errors.length?'error':'complete';job.detail=joined(...organizedText(result.moved,result.retained,result.retainedBytes,result.errors.length));addHistory(message('history.organizationRecovery'),job.detail);}
 }catch(error){if(control.signal.aborted&&pausing.delete(job.id)){job.phase='stopped';job.paused=true;job.detail=message('job.organizationPaused');}else{job.phase=control.signal.aborted?'stopped':'error';job.detail=toMessage(error);if(!control.signal.aborted)addErrors(job,job.detail);}}finally{if(kind!=='finalize'&&kind!=='delete')touchedLibraries.set(job.id,[root]);
  // The job no longer holds the drives while the (possibly slow) recovery list is read again.
  catalogStopped.clear();catalogCoordinator?.markDirty();requestCatalogRefresh();delete job.stopping;active.delete(job.id);organizationJobIds.delete(job.id);await refreshOrganizations();
  // Undo puts files back where they were, so a backup folder check result for this library is dropped; click Check folder layout to run it again.
  finishJob(job);}})).finally(()=>{resumingOrganizations.delete(operation);void releaseIfIdle();});
 }catch(error){resumingOrganizations.delete(operation);throw error;}
}
/** The job line for the steps that read or convert organization records; undefined for any other step. */
function recordsDetail(progress:{step?:string;completed:number;total:number}):Message|undefined{
 const counts={count:progress.completed,total:progress.total};
 switch(progress.step){
  case 'history':return message('job.readingHistory',counts);
  case 'later':return message('job.readingLater',counts);
  case 'earlier':return message('job.readingEarlier',counts);
  case 'cleaning':return message('job.cleaning',counts);
  case 'measuring':return message('job.measuring',counts);
 }
}
/** Steps that read or check records before anything changes: the job is verifying while they run. */
const recordSteps=['history','later','earlier','cleaning','measuring'];
/** Planning progress as the interface shows it: checking (and, for organization, reading) files before anything is written. */
function planningProgress(count:number,file:string,detail?:Parameters<PlanProgress>[2]):Progress{return {phase:'planning',step:detail?.step??'checking',completed:count,total:detail?.total??0,bytes:detail?.bytes??0,totalBytes:detail?.totalBytes??0,...(detail?.share!==undefined?{share:detail.share}:{}),speed:0,file};}
/** Files staged from a USB camera so far (the camera reports counts, not bytes or names). */
function downloadProgress(done:number,total:number):Progress{return {phase:'planning',step:'downloading',completed:done,total,bytes:0,totalBytes:0,speed:0,file:''};}
/** What a listing is measured against, in this order: what this source's last listing found in the scope (`known`), else the
 * remembered size of the last listing of the scope, else the used bytes of the drive (`used`, a whole drive only). */
async function listingHint(root:string,folders:string[]|undefined,backup:boolean,known?:ListingHint,used=0):Promise<ListingHint|undefined>{
 return known??await loadListingHint(app.getPath('userData'),root,folders,backup).catch(()=>undefined)??(used>0?{bytes:used}:undefined);
}
/** The listing hint (see listingHint), and remembering the new size when the listing ends. */
async function listingOptions(root:string,folders:string[]|undefined,backup:boolean,known?:ListingHint,used?:number):Promise<{listingHint?:ListingHint;onListed:(files:number,bytes:number)=>void}>{
 const store=app.getPath('userData'),hint=await listingHint(root,folders,backup,known,used);
 return {...(hint?{listingHint:hint}:{}),onListed:(files,bytes)=>{void rememberListing(store,root,folders,backup,files,bytes).catch(()=>{/* Only an estimate. */});}};
}
/** English text of an error, for reports and dialogs outside the renderer. */
function errorText(error:unknown){return error instanceof Error?error.message:String(error);}
function enqueue(source:Source,backup=false,automatic=false){
 const existing=state.jobs.find(j=>j.source.id===source.id&&isLive(j));
 if(existing){if(!automatic)automaticallyQueued.delete(existing.id);return;}
 const job:Job={id:randomUUID(),source,phase:'queued',detail:message('job.waiting'),errors:[],backup};
 for(const previous of state.jobs)if(previous.source.id===source.id&&['complete','stopped','error'].includes(previous.phase))delete previous.inventory;
 state.jobs.unshift(job);if(automatic)automaticallyQueued.add(job.id);seen.add(source.id);
 const finished=state.jobs.filter(j=>['complete','stopped','error'].includes(j.phase));if(finished.length>30){const remove=new Set(finished.slice(30).map(j=>j.id));state.jobs=state.jobs.filter(j=>!remove.has(j.id));}
}
/** The one way a job starts running: it can be stopped, and it holds the queue and the automatic checks. */
function startJob(job:Job):AbortController{
 const control=new AbortController();pauseCatalog();cancelAutomaticChecks();active.set(job.id,control);if(job.organization)organizationJobIds.add(job.id);return control;
}
/** The one way a running job ends: its libraries' duplicate scan goes stale, its holds are released and the queue moves on. */
function finishJob(job:Job){
 void duplicatesStale(touchedLibraries.get(job.id)??[]);forgetMisplaced(touchedMisplaced(state.misplacedFiles,touchedLibraries.get(job.id)??[]));touchedLibraries.delete(job.id);
 catalogStopped.clear();catalogCoordinator?.markDirty();requestCatalogRefresh();delete job.stopping;active.delete(job.id);organizationJobIds.delete(job.id);reservations.delete(job.id);automaticallyQueued.delete(job.id);
 emit();pump();if(!active.size&&!state.jobs.some(item=>item.phase==='queued'))scheduleAutomaticChecks();void releaseIfIdle();
}
function pump(){if(state.review||state.busyReview||organizationJobIds.size||duplicateControl)return;while(active.size<state.preferences.parallel){
 const running=state.jobs.filter(item=>active.has(item.id)).map(item=>item.source.drive);
 // Folders on one physical device share its stream limit; jobs on other devices still run in parallel.
 const job=nextRunnable(state.jobs,sourceOrder,item=>deviceHasRoom(item.source.drive,running)&&!(item.awaitingConfirmation&&(!!state.review||state.busyReview||active.size>0||!!duplicateControl)));if(!job)break;delete job.awaitingConfirmation;
 const organization=organizationQueue.get(job.id);if(organization&&active.size)break;
 organizationQueue.delete(job.id);if(organization)organizationRuns.set(job.id,organization);misplacedControl?.abort();residueControl?.abort();const control=startJob(job);
 const skip=skipRequests.get(job.id);skipRequests.delete(job.id);
 void settle(withJob(job.id,()=>run(job,control,organization??{prefs:snapshotPreferences(),reorganize:false,...(job.useFileDate?{useFileDate:true}:{}),...(job.unknownConfirmed?{confirmed:true}:{}),...skip}))).finally(()=>{if(job.phase==='error')job.retryable=true;finishJob(job);});
 if(organization)break;
}}
// Nothing here may touch a drive once the work is done, so macOS can eject it at once. exiftool and the
// hashing threads start again on demand. Closed only while no job, scan, review, organization or check
// could use them; the idle test and the closing calls run in the same turn, so nothing starts in between.
let inspecting=0,releasing:Promise<void>|undefined;
const idle=()=>!hardwareTest&&!active.size&&!scanControls.size&&!misplacedControl&&!misplacedTask&&!residueControl&&!residueTask&&!state.busyReview&&!reviewControl&&!resumingOrganizations.size&&!recoveryRefresh.running&&!inspecting&&!duplicateControl&&!originalsControls.size;
function releaseIfIdle():Promise<void>{
 scheduleCatalogRefresh();if(releasing||!idle())return releasing??Promise.resolve();
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
 checkTimer=setTimeout(()=>{checkTimer=undefined;scheduleOldRecordsCheck();scheduleResidueCheck(true);},AUTOMATIC_CHECK_DELAY);checkTimer.unref();
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
// rules give them. It runs only when the user clicks Check folder layout, and only while nothing else runs.
let misplacedControl:AbortController|undefined,misplacedTask:Promise<void>|undefined,misplacedPaths:string[]=[];
/** Where a destination's saved placement memory lives: one per volume and library, valid for the folder rules it was made under. */
function placementOf(prefs:Preferences,index:number,useFileDate=false){
 const single={...prefs,destinations:[prefs.destinations[index]!],destinationIds:[prefs.destinationIds?.[index]??'']},library=backupLibrary(single);
 return {library,id:placementId(single.destinationIds[0]!,library.root,library.videoRoot),scope:rulesScope(ruleOptions(single,useFileDate))};
}
// Files an import or organization placed are remembered as in place, so the next folder check does not read them
// again. This runs after the job is done, never holds it up, and the next check waits for it.
let placementWork:Promise<void>=Promise.resolve();
/** The folder rules an import or organization files under; a library filled under other rules may hold files elsewhere. */
const routingOf=(prefs:Preferences,useFileDate=false)=>rulesScope(ruleOptions(prefs,useFileDate));
function rememberRouted(plans:TransferPlan[],prefs:Preferences,useFileDate=false){
 if(qa||plans.some(plan=>plan.drive))return;
 void rememberRouting(app.getPath('userData'),plans.flatMap(plan=>destinationParts(plan).map(part=>part.rootIdentity)),routingOf(prefs,useFileDate)).catch(()=>{/* Only a cache: the next import looks. */});
}
/** Outcomes of one job, by source: what each file actually came to at each destination. */
type Outcomes=Map<string,DestinationOutcome[]>;
/** Remembers where an import's files actually are as in place; an organization's memory is dropped instead (its
 * plan is not where files ended up), and the next folder check reads that library again. */
function rememberPlaced(plans:TransferPlan[],prefs:Preferences,outcomes:Outcomes|undefined,useFileDate=false){
 if(qa)return;
 inspecting++;
 const work=placementWork.then(async()=>{
  try{
   for(const [index,plan] of plans.entries()){
    if(plan.drive||!prefs.destinations[index])continue;
    const {library,id,scope}=placementOf(prefs,index,useFileDate);
    if(!outcomes){await replacePlacement(app.getPath('userData'),id,scope,[]);continue;}
    await rememberEntries(app.getPath('userData'),id,scope,library.source,[library.root,...(library.videoRoot?[library.videoRoot]:[])],placedOutcomes(outcomes.values(),index));
   }
  }finally{inspecting--;void releaseIfIdle();}
 }).catch(()=>{/* Only a cache: the next check reads everything. */});
 placementWork=work;
}
/** A result is never refreshed by itself: one a job touched, or computed for other rules or another drive, is dropped and the prompt returns. */
function forgetMisplaced(destinations:string[]){for(const destination of destinations)delete state.misplacedFiles?.[destination];}
function dropStaleMisplaced(){forgetMisplaced(staleMisplaced(state.misplacedFiles,state.preferences,state.destinationStatus,sessionRules));}
/** A click on Check folder layout wins over the automatic leftover-files check, which is stopped; other work makes it refuse. */
function checkBackupFolder(index:number){
 if(active.size||state.review||state.busyReview||misplacedControl||duplicateControl||resumingOrganizations.size||state.jobs.some(job=>job.phase==='queued'))throw new MessageError('error.busyBackupCheck');
 if(!state.preferences.destinations[index])throw new MessageError('error.chooseDestination');
 const prefs=state.preferences,control=new AbortController(),path0=prefs.destinations[index]!;
 const info=state.destinationStatus?.find(item=>item.path===path0);
 if(!info?.available||info.volumeId!==prefs.destinationIds?.[index])throw new MessageError('error.backupCheckDrive');
 misplacedControl=control;misplacedPaths=[path0];(state.misplacedProgress??={})[path0]=planningProgress(0,'',{step:'listing',total:0,bytes:0,totalBytes:0});
 const task:Promise<void>=(async()=>{
  await stopResidueCheck();
  const snapshot=snapshotPreferences(index),destination=snapshot.destinations[0]!,library=backupLibrary(snapshot),scope=misplacedScope(prefs,index,state.destinationStatus,sessionRules);
  const status=state.destinationStatus?.find(item=>item.path===destination),folder=(item:string)=>fs.lstat(item).then(stat=>stat.isDirectory()&&!stat.isSymbolicLink(),()=>false);
  if(!status?.available||status.volumeId!==snapshot.destinationIds?.[0])throw new MessageError('error.backupCheckDrive');
  if(!within(library.root,destination))throw new MessageError('error.backupFolderOutside');
  // Both backup folders must exist to be compared; the first import creates them. Say so instead of doing nothing.
  if(!await folder(library.root)||library.videoRoot&&!await folder(library.videoRoot)){(state.misplacedFiles??={})[destination]={count:0,bytes:0,checkedAt:new Date().toISOString(),scope,missing:true};return;}
  await placementWork;
  const place=placementOf(snapshot,0),memory=qa?undefined:await loadPlacement(app.getPath('userData'),place.id,place.scope);
  const found=await findMisplaced(library.source,library.root,{...(memory?{inPlace:(relative:string,size:number,mtimeNs:bigint,ino:bigint)=>placedMatches(memory,relative,size,mtimeNs,ino)}:{}),...ruleOptions(snapshot),...(library.videoRoot?{videoRoots:[library.videoRoot]}:{}),...(library.sourceFolders?{sourceFolders:library.sourceFolders}:{}),...await listingOptions(library.source,library.sourceFolders,false)},file=>metadata(file,{details:false}),control.signal,(count,file,detail)=>{(state.misplacedProgress??={})[destination]=planningProgress(count,file,detail);progressEmit();});
  if(control.signal.aborted)return;
  if(!qa)await replacePlacement(app.getPath('userData'),place.id,place.scope,found.placed).catch(()=>{/* Only a cache. */});
  (state.misplacedFiles??={})[destination]={count:found.count,bytes:found.bytes,checkedAt:new Date().toISOString(),scope};dropStaleMisplaced();emit();
 })().catch(error=>{if(!control.signal.aborted)state.error=message('error.backupFolderCheck',{error:toMessage(error)});}).finally(()=>{delete state.misplacedProgress?.[path0];if(misplacedControl===control)misplacedControl=undefined;if(misplacedTask===task)misplacedTask=undefined;emit();scheduleResidueCheck();void releaseIfIdle();});
 misplacedTask=task;emit();
}
// Leftovers of interrupted runs: staging files and receipts beside media, index and organization
// scratch files, and camera and preview folders in the system temporary folder. Looked for while
// nothing runs (after imports and organizations finish and when a destination connects) and
// removed at once; copies a re-import could continue wait for Clean up.
let residueItems:ResidueItem[]=[];
let residueControl:AbortController|undefined,residueTask:Promise<void>|undefined,residueScope='',residuePaths:string[]=[];
/** The backup folders of connected destinations, and folders organized in place on connected drives. */
async function residueRoots():Promise<string[]>{
 const prefs=state.preferences,roots:string[]=[];
 prefs.destinations.forEach((destination,index)=>{const status=state.destinationStatus?.find(item=>item.path===destination);if(status?.available&&status.volumeId===prefs.destinationIds?.[index])for(const root of libraryRoots(destination,prefs))if(within(root,destination))roots.push(root);});
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
  // Cleaned when something can go: files beyond the copies kept (automatic cleanup keeps resumable and kept copies, every cleanup recoverable ones), or receipts to close.
  const work=found.files>(all?0:found.resumable.files+found.kept.files)+found.recoverable.files||found.items.some(item=>item.kind==='receipt'&&!!item.rid);
  const {removed,left}=work?await cleanResidue(found,{keepResumable:!all,inUse:previewFoldersInUse,signal:control.signal,onProgress:(done,total,bytes,totalBytes,file)=>show({phase:'copying',step:'deleting',completed:done,total,bytes,totalBytes,speed:0,file})}):{removed:{files:0,bytes:0},left:found};
  const now=new Date().toISOString(),cleaned=removed.files?{...removed,at:now}:state.residue?.cleaned;
  residueItems=left.items;
  state.residue={files:left.files,bytes:left.bytes,resumable:left.resumable,...(left.kept.files?{kept:left.kept}:{}),recoverable:left.recoverable,...(left.unbound?.files?{unbound:left.unbound}:{}),checkedAt:now,...(cleaned?{cleaned}:{})};
  // Ended organizations the cleanup deleted leave the list.
  if(removed.files)void refreshOrganizations();
 })().catch(error=>{if(!control.signal.aborted)state.error=message('error.residueCleanup',{error:toMessage(error)});}).finally(()=>{if(residueControl===control)residueControl=undefined;if(residueTask===task)residueTask=undefined;if(control.signal.aborted)residueScope='';if(state.residue){delete state.residue.checking;delete state.residue.progress;}emit();void releaseIfIdle();});
 residueTask=task;return task;
}
/** Anything about to write waits for a running cleanup to stop. */
async function stopResidueCheck(){residueControl?.abort();await residueTask;}
// Records v5: what an earlier version wrote on a connected destination is never read beyond telling whether this
// Mac wrote it, never changed and never deleted. A notice names the drive; Acknowledge stops it for those items.
/** Per connected, unchanged destination: the folders to look at (the destination, its backup folders, folders organized there). */
async function configuredOldRecordsDrives():Promise<DriveRoots[]>{
 const prefs=state.preferences,drives=new Map<string,{key:string;roots:string[]}>();
 const add=(drive:string,root:string,volumeId:string)=>{const entry=drives.get(drive)??{key:`${drive}\0${volumeId}`,roots:[]};if(!entry.roots.includes(root))entry.roots.push(root);drives.set(drive,entry);};
 prefs.destinations.forEach((destination,index)=>{
  const status=state.destinationStatus?.find(item=>item.path===destination);if(!status?.available||status.volumeId!==prefs.destinationIds?.[index])return;
  add(destination,destination,status.volumeId??"");
  for(const root of libraryRoots(destination,prefs))if(within(root,destination))add(destination,root,status.volumeId??"");
 });
 for(const location of organizationLocations){
  const status=location.folder?await volumeInfo(location.destination).catch(()=>undefined):state.destinationStatus?.find(item=>item.path===location.destination);
  if(status?.available&&status.volumeId===location.volumeId)add(location.destination,location.root,status.volumeId??location.volumeId);
 }
 return [...drives].map(([drive,entry])=>({drive,...entry}));
}
// The notice keeps the folders a refusal or an inventory named (an unconfigured sibling beside a library) with the configured ones.
const oldRecords=new OldRecordsNotice(configuredOldRecordsDrives);
let oldRecordsTask:Promise<void>|undefined;
/** Cheap: two folder checks per root, then one small file per old journal. Nothing is organized, converted or deleted. */
let oldRecordsPending=false;
function scheduleOldRecordsCheck(force=false){
 if(qa||hardwareTest||quitting)return;
 // One at a time; a forced request made meanwhile runs again right after.
 if(oldRecordsTask){if(force)oldRecordsPending=true;return;}
 const task:Promise<void>=(async()=>{
  const changed=await oldRecords.scan(force);
  if(!changed)return;
  if(oldRecords.drives.length)state.oldRecords=[...oldRecords.drives];else delete state.oldRecords;
  log('normal','records','old-records-found',{drives:oldRecords.drives.length});emit();
 })().catch(error=>{log('normal','records','old-records-check-failed',{error:toMessage(error)});}).finally(()=>{if(oldRecordsTask===task)oldRecordsTask=undefined;if(oldRecordsPending){oldRecordsPending=false;scheduleOldRecordsCheck(true);}});
 oldRecordsTask=task;
}
/** A receipt met while listing (the configured folders are looked at again), or a folder refused for old records (it is looked at too): once a second at most. */
let oldRecordsAgain:NodeJS.Timeout|undefined;
onOldRecordsFound(folder=>{if(folder)oldRecords.note(folder);if(oldRecordsAgain)return;oldRecordsAgain=setTimeout(()=>{oldRecordsAgain=undefined;scheduleOldRecordsCheck(true);},1000);oldRecordsAgain.unref();});
/** The user acknowledged the notice of a drive: its items, exactly as they are now, are written to the reviewed list. */
async function acknowledgeDrive(drive:string){
 // No scan may start again meanwhile and race the acknowledgement.
 oldRecordsPending=false;
 while(oldRecordsTask)await oldRecordsTask;
 const count=await oldRecords.acknowledge(drive);
 log('normal','records','old-records-acknowledged',{drive,items:count});
 if(oldRecords.drives.length)state.oldRecords=[...oldRecords.drives];else delete state.oldRecords;
 emit();
}
// Jobs still settling; quitting waits for them so a stopped job removes its staging files.
const settling=new Set<Promise<unknown>>();
function settle<T>(work:Promise<T>):Promise<T>{settling.add(work);work.finally(()=>settling.delete(work)).catch(()=>{});return work;}
function assertOrganizationIdle(){
 if(state.review||state.busyReview)throw new MessageError('error.reviewOpen');
 if(state.jobs.some(job=>job.organization&&isLive(job)))throw new MessageError('error.organizationRunning');
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
 const destination=prefs.destinations[0]!,[root,videoRoot]=libraryRoots(destination,prefs);
 return videoRoot?{source:destination,root:root!,videoRoot,sourceFolders:backupFolders(prefs)}:{source:root!,root:root!};
}
/** Organize only <destination>/<basePath> (and <videoBasePath>) in place: the Organize backup button. */
function queueBackupOrganization(index:number){
 const prefs=snapshotPreferences(index),destination=prefs.destinations[0]!,library=backupLibrary(prefs);
 if(!within(library.root,destination))throw new MessageError('error.backupFolderOutside');
 queueOrganization(library.source,'Backup organization',{prefs,reorganize:true,options:takeOrganizeOptions(),...(library.sourceFolders?{sourceFolders:library.sourceFolders}:{})});
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
function availableFor(owner:string,infos:DestinationStatus[],volumes:MountedVolume[]):number[]{
 return freeAfterReservations(owner,infos,volumes,reservations);
}
async function prepare(owner:string,source:Source,backup:boolean,request:RunRequest,signal:AbortSignal,onCamera:(done:number,total:number)=>void,onProgress:PlanProgress,onPlanning?:()=>void):Promise<Prepared>{
 const {prefs,reorganize,sourceFolders}=request;
 const {roots,videoRoots,infos,volumes}=await destinationRoots(prefs,state.sources,reorganize?undefined:source);
 const eta={source:etaDrive(volumes,source.path,source.transport),destinations:infos.map(info=>etaDrive(volumes,info.path,'storage'))};
 etaTracker.plan(owner,{kind:reorganize?'organization':'import',...eta});
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
  // The folder for unknown files must not be one the app files into.
  if(!backup&&!request.useFileDate&&prefs.noMetadataHandling==='folder')noMetadataFolderName(prefs.noMetadataFolder,[prefs.editedFolder??'',prefs.basePath,prefs.videoBasePath??'']);
  onPlanning?.();
  // Card files copied before and still unchanged are recognised without reading them.
  const volume=reorganize||stage?undefined:memoryVolume(source),sourceDigest=volume&&!qa?await loadImported(app.getPath('userData'),volume,source.path):undefined;
  const skipErrors=request.skipErrors===true||prefs.skipFileErrors!==false;
  // An earlier listing of this scope sizes the estimate; failing that a card's or drive's used space, or the files of its last scan.
  // Selected folders are sized from the files an earlier scan found inside them; the whole drive's used space would overestimate them.
  const previous=reorganize?undefined:reusableScan(source);
  const listing=await listingOptions(source.transport==='camera'?source.id:sourcePath,sourceFolders,backup,scopeHint(previous?.files,sourceFolders),reorganize||sourceFolders?.length?0:usedBytes(source));
  // One request per intent: an organization files by the rules and keeps unknown files where they are; a drive backup keeps the drive's layout.
  const listed={...listing,reuse:reusableScan(source),sourceFolders,conflictNaming:prefs.conflictNaming,...(request.exclude?.length?{exclude:request.exclude}:{})};
  const {unknownRules,unknownDefault,...folderRules}=ruleOptions(prefs,request.useFileDate),filed={...folderRules,...(videoRoots?{videoRoots}:{})};
  const copy={...listed,unknownRules,unknownDefault,sourceDigest,skipErrors,...(prefs.copyMode==='sequential'?{fillFirst:(first:TransferPlan)=>{
   // Disk 1's share is reserved as soon as it is chosen, so a job planning meanwhile does not count on the same space.
   const {kept,bytes}=fillFirst(first,availableFor(owner,infos,volumes)[0]!);reservations.set(owner,[{volume:reservationVolume(volumes,infos[0]!.path),bytes}]);return kept;
  }}:{})};
  const planning:PlanRequest=reorganize?{...filed,...listed,backup:false,reorganize:true,collectProblems:prefs.collectProblemFiles!==false}
   :drive?{...copy,backup:true,drive:{name:drive.name,identity:drive.identity,mirror:drive.mirror}}
   :{...filed,...copy,backup:false,duplicates:true,lookElsewhere:identities=>qa?true:routingChanged(app.getPath('userData'),identities,routingOf(prefs,request.useFileDate))};
  const {inventory,listing:record,plans,failures,problems,duplicates,elsewhere,noMetadata}=await plan(sourcePath,roots,planning,p=>metadata(p,{details:false}),signal,onProgress);
  signal.throwIfAborted();
  const available=availableFor(owner,infos,volumes);
  // A same-drive organization moves files; it never needs room for a second library.
  const needed=reorganize?plans.map((item,index)=>{const bytes=requiredOrganizationSpace(item);if(bytes>available[index]!)throw new MessageError('error.organizeSpace',{index:index+1,size:gigabytes(bytes)});return bytes;}):allocateDestinations(plans,available,prefs.copyMode);
  reservations.set(owner,infos.map((info,index)=>({volume:reservationVolume(volumes,info.path),bytes:needed[index]})));
  log('detailed','plan','space-check',{destinations:infos.map((info,index)=>({path:info.path,freeBytes:info.free,availableAfterReservations:available[index],neededBytes:needed[index]})),reorganize});
  // Duplicates already on a destination are skipped, so only the bytes the plan writes are compared with free space.
  const space=reorganize?undefined:plans.map((item,index)=>destinationSpace(item,available[index]!,!!source.drive&&infos[index]?.volumeId===source.drive.volumeId));
  if(!stage)keepListing(source,record,!reorganize&&!backup);
  const options=request.options?{...request.options}:freshOrganizeOptions(),policy=sourcePolicy(reorganize?'reorganize':'import',options,prefs);
  return {eta,problems,request,...(request.useFileDate?{useFileDate:true}:{}),...(noMetadata?{noMetadata}:{}),review:{id:owner,source,backup,plans,problems,...(noMetadata?{noMetadata:{...noMetadata,files:noMetadata.files.slice(0,NO_METADATA_LIST_LIMIT)}}:{}),...(reorganize?{collectProblemFiles:prefs.collectProblemFiles!==false}:{}),kind:reorganize?'reorganize':'import',sourceAction:policy.sourceAction,...(reorganize?{options}:{}),...(sourceFolders?{sourceFolders}:{})},prefs,options,inventory,stage,...(space?{space}:{}),skipErrors,failures:failures.map(item=>({path:item.path,error:toMessage(item.error),text:errorText(item.error)})),...(duplicates?{duplicates}:{}),...(elsewhere?{elsewhere}:{})};
 }catch(error){reservations.delete(owner);await stage?.cleanup().catch(()=>{});throw error;}
}
/** Hands a planned job over to the review screen, so unknown files are confirmed before anything runs. The job itself is dropped; Continue starts a new one from this plan. */
function parkForConfirmation(job:Job,prepared:Prepared){
 const id=randomUUID(),held=reservations.get(job.id);
 prepared.review={...prepared.review,id};
 if(held)reservations.set(id,held);
 reservations.delete(job.id);
 prepared.origin={jobId:job.id,...(job.organization?{organization:true,...(job.folders?{folders:job.folders}:{})}:{})};
 if(prepared.review.kind==='reorganize'){const index=state.preferences.destinations.indexOf(prepared.prefs.destinations[0]!);if(index>=0)prepared.review.destinationIndex=index;}
 reviewed=prepared;state.review=prepared.review;(state.sourceInventories??={})[job.source.id]=prepared.inventory;
 state.jobs=state.jobs.filter(item=>item!==job);
 log('normal','job','unknown-files-confirm',{jobId:job.id,reviewId:id,count:prepared.noMetadata!.count,handling:prepared.noMetadata!.handling});
 emit();
}
/** Another review is open or work is running: give the plan up (space, camera staging) and queue the job again to plan once that is over. */
async function deferForConfirmation(job:Job,prepared:Prepared,request:RunRequest){
 reservations.delete(job.id);
 await prepared.stage?.cleanup().catch(()=>{});
 job.phase='queued';job.detail=message('job.waiting');job.awaitingConfirmation=true;job.progress=undefined;
 if(job.organization)organizationQueue.set(job.id,request);
 log('normal','job','unknown-files-deferred',{jobId:job.id,count:prepared.noMetadata!.count},job.id);
 emit();
}
async function run(job:Job,control:AbortController,input:Prepared|RunRequest){
 let prepared:Prepared|undefined;
 let reporting=false;
 const saveReport=async(name:string,value:unknown)=>{if(reporting)await writeReport(job.id,name,value);};
 const signal=control.signal;
 const request='review' in input?undefined:input;job.excluded=request?.exclude;
 try{
  // A cleanup in progress stops first. The phase changes before this wait, so pump() never takes this job again.
  if('review' in input){
   await stopResidueCheck();
   prepared=input;
   // A review can sit open while other jobs fill the disk; recheck before writing.
   const volumes=await mountedVolumes(),available=availableFor(job.id,await Promise.all(prepared.review.plans.map(item=>volumeInfo(item.root,volumes))),volumes);
   const required=prepared.review.kind==='reorganize'?requiredOrganizationSpace:requiredTransferSpace;
   if(prepared.review.plans.some((item,index)=>required(item)>available[index]!))throw new MessageError('error.reviewSpace');
  }
  else{
   job.phase='discovering';job.progress=undefined;job.detail=message(job.source.transport==='camera'?'job.stagingCamera':'job.finding');emit();
   await stopResidueCheck();
   if(qaHooks)await qaHooks.gate(job.id,signal);
   prepared=await prepare(job.id,job.source,job.backup,input,signal,(done,total)=>{job.detail=message('job.cameraDownload',{done,total});job.progress=downloadProgress(done,total);progressEmit();},(count,file,detail)=>{job.phase='verifying';job.detail=detail?.step==='listing'?message('job.listing',{count}):detail?.step==='locating'?(detail.total?message('job.lookingElsewhere',{count,total:detail.total,file:path.basename(file)}):message('job.listing',{count})):detail?.step==='candidates'?message('job.confirmingCandidates',{count,total:detail.total,file:path.basename(file)}):detail?.step==='reading'?message('job.readingToMove',{count,total:detail.total,file:path.basename(file)}):detail?.step==='comparing'?message('job.comparingDestination',{count,total:detail.total,file:path.basename(file)}):detail?message('job.checkingSourceOf',{count,total:detail.total,file:path.basename(file)}):message('job.checkingSource',{count,file:path.basename(file)});if(detail)job.progress={phase:'planning',step:detail.step,completed:count,total:detail.total,bytes:detail.bytes,totalBytes:detail.totalBytes,...(detail.share!==undefined?{share:detail.share}:{}),...(detail.matched!==undefined?{matched:detail.matched,matchedBytes:detail.matchedBytes??0}:{}),speed:0,file};progressEmit();},()=>{job.phase='verifying';job.detail=message('job.readingMetadata');emit();});
   // Mirror moves only run from a review the user applied.
   const moving=prepared.review.plans.reduce((sum,plan)=>sum+(plan.removals?.length??0),0);
   if(moving)throw new MessageError('error.mirrorReview',{count:moving});
  }
  // A job someone started (not an automatic one) that found unknown files stops at the review's confirmation first; nothing has been written.
  if(request&&prepared.noMetadata){
   const decision=unknownDecision({found:true,automatic:request.automatic===true,confirmed:request.confirmed===true,queuedAutomatically:automaticallyQueued.has(job.id),reviewOpen:!!reviewed||!!state.review||!!state.busyReview,othersRunning:active.size>1||!!duplicateControl});
   if(decision==='park'){const parked=prepared;prepared=undefined;parkForConfirmation(job,parked);return;}
   if(decision==='defer'){const held=prepared;prepared=undefined;await deferForConfirmation(job,held,request);return;}
  }
  const {review:{plans,kind,sourceFolders},prefs,failures}=prepared,reorganize=kind==='reorganize';
  // The one place that decides what happens to the source: imports copy and leave it alone, whatever the saved preferences say.
  const policy=sourcePolicy(kind,prepared.options,prefs);
  job.skipErrors=prepared.skipErrors;
  // Files skipped while planning are listed with the job's errors, so the job never reads as fully passed.
  for(const item of failures)log('normal','plan','file-skipped',{path:item.path,reason:item.text});
  if(failures.length){job.failedFiles=failures.length;addErrors(job,...failures.map(item=>message('error.fileSkipped',{path:item.path,error:item.error})));}
  // Unknown files are left or filed apart on purpose; they are listed as a warning (never a failure), also after an automatic job.
  if(prepared.noMetadata){const issues=noMetadataIssues(prepared.noMetadata);recordIssues(job,issues);log('normal','job','warning',{code:issues[0]?.code,count:prepared.noMetadata.count,counts:prepared.noMetadata.counts,handling:prepared.noMetadata.handling});}
  job.inventory=prepared.inventory;job.space=prepared.space;if(prepared.problems.length)job.problemFiles=prepared.problems;if(state.sources.some(source=>source.id===job.source.id))(state.sourceInventories??={})[job.source.id]=prepared.inventory;emit();
  if(reorganize)for(const part of destinationParts(plans[0]))await rememberOrganization(part.root,prefs);
  reporting=true;
  const failed=failures.map(({path,text})=>({path,reason:text}));
  await saveReport('plan.json',{producer:'desktop-app',jobId:job.id,kind,sourceFolders,plans,skipped:job.inventory?.skipped??[],failed,inventory:job.inventory});
  await saveReport('context.json',{producer:'desktop-app',started:new Date().toISOString(),preferences:prefs,source:job.source});
  const reserved=reservations.get(job.id)!;
  touchedLibraries.set(job.id,plans.flatMap(item=>[item.root,...(item.videos?[item.videos.root]:[])]));
  etaTracker.plan(job.id,{kind:reorganize?'organization':'import',verify:policy.verifyCopies,...prepared.eta,publish:etaTracker.predictPublish(prepared.eta.destinations),...(reorganize?{}:{totals:etaTotals(plans)})});
  job.phase='copying';
  // What each file actually came to at each destination: the one record duplicates, placement, the source checksums and Delete originals use.
  const outcomes:Outcomes=new Map(),volume=reorganize||prepared.stage?undefined:memoryVolume(job.source);
  let executed;
  // Formal planning may have just created a previously absent backup folder. Bind its read-only catalog now.
  await configureCatalog().catch(error=>log('normal','catalog','configure-warning',{error}));
  try{executed=await executeDestinations(plans,{
   signal,reorganize,removeAppleDouble:prefs.removeAppleDouble!==false,verify:policy.verifyCopies,keepSourceFolders:!policy.removeEmptySourceFolders,releaseDuplicates:policy.releaseDuplicates,onFileOutcome:outcome=>{void catalogCoordinator?.observeOutcome(outcome);const list=outcomes.get(outcome.source);if(list)list.push(outcome);else outcomes.set(outcome.source,[outcome]);},
   validate:async index=>{await validateDestination(prefs.destinations[index],state.sources,{identity:prefs.destinationIds?.[index]??''});},
   progress:(index,progress,pending)=>{job.phase=progress.phase==='verifying'||progress.phase==='planning'?'verifying':'copying';job.progress=progress;reserved[index].bytes=pending;job.detail=recordsDetail(progress)??(progress.step==='existing'?message('job.confirmingExisting',{count:progress.completed,total:progress.total,file:path.basename(progress.file)}):(plans.length>1?message('job.destinationLabel',{index:index+1,count:plans.length}):undefined));progressEmit();},
   settled:index=>{reserved[index].bytes=0;}
  });}finally{
   // Checksums of the source files this job verified, remembered for the next plan even when it stops or fails. Only a cache.
   const sums=importedSums(outcomes);
   if(volume&&!qa&&Object.keys(sums).length)await rememberImported(app.getPath('userData'),volume,job.source.path,sums).catch(()=>{});
  }
  const {copied,skipped,routed,moved,retained,retainedBytes,released,releasedBytes,foldersRemoved=0,removed,errors,warnings=[],notes,appleDouble}=executed;
  addErrors(job,...errors.map(text));recordIssues(job,warnings);
  for(const error of errors)log('normal','job','error',{message:text(error)});for(const issue of warnings)log('normal','job',issue.severity==='error'?'error':'warning',{...issue});
  // "._" files kept or not checked are warnings too; recorded here so both reports below carry them.
  const sidecarIssues=appleDoubleIssues(appleDouble),reported=[...warnings,...sidecarIssues];
  if(appleDouble)log('normal','appledouble','summary',{removed:appleDouble.removed,kept:appleDouble.kept,orphans:appleDouble.orphans,warnings:appleDouble.warnings,folderWarnings:appleDouble.folderWarnings,failures:appleDouble.failures.slice(0,50),keptFiles:appleDouble.keptFiles.slice(0,50)});recordIssues(job,sidecarIssues);
  await recordDuplicates(plans,prepared.duplicates,outcomes);
  rememberPlaced(plans,prefs,reorganize?undefined:outcomes,prepared.useFileDate);
  if(errors.length===0)rememberRouted(plans,prefs,prepared.useFileDate);
  // Files actually verified where an older rule filed them (a family that failed is not counted).
  const olderRules=routed??0;
  await saveReport('execution.json',{copied,skipped,moved,retained,retainedBytes,released,releasedBytes,removed,errors,warnings:reported,notes,appleDouble,...(prepared.elsewhere?{olderRules:{files:olderRules,partialFamilies:prepared.elsewhere.partialFamilies,skippedSizeGroups:prepared.elsewhere.skipped.map(item=>({...item,reason:'skipped: too many same-size files'})),paths:olderRulesPaths(plans)}}:{}),skipErrors:prepared.skipErrors,failedCount:failed.length,failed});
  const entries=plans.reduce((sum,item)=>sum+destinationEntries(item).length,0);
  // Informational (a warning, never an error): a "._" file that could not be judged or removed is simply kept.
  const appleDoubleLine=!!appleDouble&&(appleDouble.removed+appleDouble.kept+appleDouble.orphans+appleDouble.warnings.length+appleDouble.folderWarnings.length>0)&&message('job.appleDouble',{removed:appleDouble.removed,kept:appleDouble.kept,orphans:appleDouble.orphans,failed:appleDouble.warnings.length,folders:appleDouble.folderWarnings.length});
  job.alreadyImported=!reorganize&&entries>0&&copied===0&&!removed&&errors.length===0&&errorTotal(job)===0;
  await saveReport('summary.json',{producer:'desktop-app',...reportSummary(errors,reported,failed.length),retainedOriginals:true,jobId:job.id,kind,sourceFolders,finished:new Date().toISOString()});
  job.phase=errorTotal(job)?'error':'complete';
  // A finished folder import can later offer to delete the originals that are verified in the backup; nothing is removed now.
  // Files that failed or were skipped are simply not in `verified`, so they always stay on the source.
  if(!reorganize&&(job.phase==='complete'||job.phase==='error')&&job.source.transport==='folder'&&!prepared.stage){
   const {files,withheld}=verifiedOriginals(outcomes,plans);
   for(const item of withheld)log('detailed','originals','withheld',{path:item.source,reason:item.reason},job.id);
   if(files.length){importedOriginals.set(job.id,{root:job.source.path,files});job.verifiedOriginals=files.length;}
   if(files.length||withheld.length)await saveReport('verified-originals.json',{root:job.source.path,files,withheld});
  }
  if(!reorganize&&job.phase==='complete'&&(prefs.verifyCopies!==false||job.alreadyImported))noteDevice(job.source,'import');
  job.detail=reorganize?joined(...organizedText(moved,retained,retainedBytes,errorTotal(job)),failed.length>0&&message('job.skippedErrors',{count:failed.length}),prepared.problems.some(item=>item.collected)&&message('job.problemsCollected',{count:prepared.problems.filter(item=>item.collected).length}),prepared.problems.some(item=>!item.collected)&&message('job.problemsSkipped',{count:prepared.problems.filter(item=>!item.collected).length}),!!released&&message('job.releasedDuplicates',{count:released,size:gigabytes(releasedBytes??0)}),foldersRemoved&&message('job.foldersRemoved',{count:foldersRemoved}),appleDoubleLine,notes.length>0&&text(notes[0]!)):job.alreadyImported?joined(message('job.alreadyImported',{count:entries}),olderRules>0&&message('job.olderRules',{count:olderRules})):joined(message('job.copied',{copied,skipped}),olderRules>0&&message('job.olderRules',{count:olderRules}),failed.length>0&&message('job.skippedErrors',{count:failed.length}),prepared.problems.length>0&&message('job.problemsSkipped',{count:prepared.problems.length}),removed&&message('job.mirrorRemoved',{count:removed}),appleDoubleLine,message('job.errors',{count:errorTotal(job)}),prefs.copyMode==='mirror'&&message(errorTotal(job)?'job.mirrorIncomplete':'job.mirrorVerified'));addHistory(message(job.backup?'history.driveBackup':'history.import',{name:job.source.name}),job.detail);
 }catch(error){await saveReport('failure.json',{producer:'desktop-app',passed:false,error:errorText(error),aborted:signal.aborted,finished:new Date().toISOString()}).catch(()=>{});if(signal.aborted&&pausing.delete(job.id)){job.phase='stopped';job.paused=true;job.detail=message(job.organization?'job.organizationPaused':'job.paused');}else{job.phase=signal.aborted?'stopped':'error';job.detail=signal.aborted?message('job.stopped'):toMessage(error);if(!signal.aborted)addErrors(job,job.detail);
  // A planning error about one file can be skipped by hand: never for a mirror (the copy would read as removed) or a USB camera (staged anew each time).
  const file=signal.aborted?undefined:filePath(job.detail),prefs=prepared?.prefs??request?.prefs;if(file&&job.source.transport!=='camera'&&!(job.backup&&prefs?.backupMode==='mirror')&&(!job.organization||organizationRuns.has(job.id)))job.skippablePath=file;addHistory(text(job.source.name),job.detail);}}
 if(prepared?.stage)await prepared.stage.cleanup().catch(()=>{});
 await writeExcerpt(job,reporting?path.join(app.getPath('userData'),'operation-reports',job.id):undefined,[prepared?.review.id,prepared?.origin?.jobId]);
 if(prepared?.review.kind==='reorganize'||('reorganize' in input&&input.reorganize))recoveryRefresh.request();else recoveryRefresh.resume();emit();
}
/** The job's own lines of the diagnostic log, at the level now set, saved with its operation report. Never fails the job. */
async function writeExcerpt(job:Job,directory:string|undefined,alsoIds:(string|undefined)[]=[]){
 if(!directory)return;const logger=activeLogger();if(!logger)return;
 try{phaseLog.observe(state.jobs,Date.now());await logger.excerpt(job.id,path.join(directory,'log-excerpt.jsonl'),{...(job.startedAt?{since:Date.parse(job.startedAt)-60000}:{}),...(alsoIds.some(Boolean)?{alsoIds:alsoIds.filter((id):id is string=>!!id)}:{})});}catch{/* Logging never changes a job. */}
}
/** The source checksums this job verified, for the next plan to recognise unchanged sources: never a copy it did not read back. */
function importedSums(outcomes:Outcomes):Record<string,{sha256:string;identity:string}>{
 const sums:Record<string,{sha256:string;identity:string}>={};
 for(const [source,list] of outcomes){const found=list.find(item=>item.verification==='content-verified'&&item.sourceIdentity!==undefined);if(found)sums[source]={sha256:found.sha256,identity:found.sourceIdentity!};}
 return sums;
}
/** Duplicate detection, recorded only: the stage 1 findings of the plan, for the files this job verified where they
 * actually are. It never scans the library (stage 2 runs only from the Remove duplicates page), so the drive is not held
 * after the copy. Best effort; it never fails or changes a job and never deletes a file. */
async function recordDuplicates(plans:TransferPlan[],found:PlanDuplicates|undefined,outcomes:Outcomes){
 if(!found)return;
 try{
  for(const part of plans.flatMap(item=>destinationParts(item))){
   const placed=new Map<string,{destination:string;identity:string}>();
   for(const [source,list] of outcomes){const item=list.find(outcome=>outcome.root===part.root&&outcome.finalIdentity!==undefined);if(item)placed.set(source,{destination:item.destination,identity:item.finalIdentity!});}
   await recordPlanDuplicates(part.root,found,source=>placed.get(source));
  }
 }catch{/* Only a record. */}
}
async function discardReview(){reviewControl?.abort();reviewControl=undefined;const old=reviewed;reviewed=undefined;state.review=undefined;state.busyReview=false;state.reviewSourceId=undefined;reservations.delete(old?.review.id??'');if(old?.stage)await old.stage.cleanup().catch(()=>{});}
/** Queue an in-place organization of `folder`; `known` are the sources it must not overlap. */
async function organizeFolderInPlace(folder:string,known:Source[]){
 const root=await fs.realpath(folder),info=await validateDestination(root,known);
 if(!info.volumeId)throw new MessageError('error.folderUnidentified');
 approved.add(root);
 const prefs=snapshotPreferences();prefs.copyMode='single';prefs.destinations=[root];prefs.destinationIds=[info.volumeId];prefs.basePath='';
 if(prefs.mediaLayout==='video-root')throw new MessageError('error.organizeFolderVideo');
 queueOrganization(root,`Organize ${path.basename(root)}`,{prefs,reorganize:true,options:takeOrganizeOptions()});
}
async function previewSource(source:Source,backup:boolean,organizationDestination?:number,collectProblemFiles?:boolean){
 if(busy())throw new MessageError('error.busyReview');
 const reorganize=organizationDestination!==undefined,prefs=snapshotPreferences(organizationDestination);if(reorganize&&collectProblemFiles!==undefined){prefs.collectProblemFiles=collectProblemFiles;if(state.review?.options)state.organizeOptions={...state.review.options};}
 const request:RunRequest={prefs,reorganize,...(reorganize?{options:takeOrganizeOptions()}:{}),sourceFolders:reorganize?state.organizationFolders?.[source.path]?.slice():undefined};
 return openReview(source,backup,request,organizationDestination);
}
/** Plans `request` into a review and opens it; also how a review is planned again (with file dates). */
async function openReview(source:Source,backup:boolean,request:RunRequest,organizationDestination?:number){
 const reorganize=request.reorganize;
 pauseCatalog();cancelAutomaticChecks();misplacedControl?.abort();await stopResidueCheck();await discardReview();const control=new AbortController();reviewControl=control;state.busyReview=true;state.reviewSourceId=source.id;emit();
 try{
  const reviewId=randomUUID();log('normal','job','review-start',{source:source.name,path:source.path,reorganize},reviewId);reviewed=await withJob(reviewId,()=>prepare(reviewId,source,backup,request,control.signal,(done,total)=>{state.reviewProgress=downloadProgress(done,total);progressEmit();},(count,file,detail)=>{state.reviewProgress=planningProgress(count,file,detail);progressEmit();}));
  state.review=reviewed.review;if(reorganize)state.review.destinationIndex=organizationDestination;(state.sourceInventories??={})[source.id]=reviewed.inventory;
 }catch(error){if(!control.signal.aborted)throw error;}
 finally{if(reviewControl===control){state.busyReview=false;state.reviewSourceId=undefined;state.reviewProgress=undefined;reviewControl=undefined;}emit();recoveryRefresh.resume();void releaseIfIdle();}
}
async function applyReview(){
 if(!reviewed)return;
 if(busy()||state.busyReview)throw new MessageError('error.busy');
 const prepared=reviewed;reviewed=undefined;state.review=undefined;
 const job:Job={id:randomUUID(),source:prepared.review.source,phase:'verifying',detail:message('job.revalidating'),errors:[],backup:prepared.review.backup,unknownConfirmed:true,...(prepared.useFileDate?{useFileDate:true}:{}),...(prepared.origin?.organization?{organization:true,...(prepared.origin.folders?{folders:prepared.origin.folders}:{})}:{})};state.jobs.unshift(job);if(prepared.origin?.organization)organizationRuns.set(job.id,{...prepared.request,confirmed:true});const control=startJob(job);if(prepared.review.kind==='reorganize')organizationJobIds.add(job.id);
 reservations.set(job.id,reservations.get(prepared.review.id)!);reservations.delete(prepared.review.id);
 log('normal','job','review-applied',{reviewId:prepared.review.id,...(prepared.origin?{plannedBy:prepared.origin.jobId}:{})},job.id);void settle(withJob(job.id,()=>run(job,control,prepared))).finally(()=>{if(job.phase==='error'&&(prepared.review.kind!=='reorganize'||organizationRuns.has(job.id)))job.retryable=true;finishJob(job);});
}
// ---- Remove duplicates: scan one library, review, set the chosen copies aside (recovery store, with undo).
let duplicateGroups:DuplicateGroup[]=[],duplicateCompanions=new Map<string,string[]>(),duplicateControl:AbortController|undefined;
const dup:Omit<DuplicatesState,'scopes'>={status:'idle',revision:0,groups:0,files:0};
/** Unread files a scan names in the state (all are counted). */
const UNREAD_SAMPLE=20;
const chosenScopes=new Map<string,DuplicateScope>();
function duplicateScopes():DuplicateScope[]{
 const result:DuplicateScope[]=[];
 for(const destination of state.preferences.destinations)for(const root of libraryRoots(destination,state.preferences)){const folder=path.relative(destination,root);if(!result.some(item=>item.root===root))result.push({root,name:folder?`${path.basename(destination)} · ${folder}`:path.basename(destination),destination});}
 for(const scope of chosenScopes.values())if(!result.some(item=>item.root===scope.root))result.push(scope);
 return result;
}
const duplicateScope=(root:string)=>duplicateScopes().find(item=>item.root===root);
/** Make a library's journals findable by Undo and Release (the organization recovery list). */
async function rememberLibrary(scope:DuplicateScope){
 const index=state.preferences.destinations.indexOf(scope.destination??''),volumeId=index>=0?state.preferences.destinationIds?.[index]:(await volumeInfo(scope.root)).volumeId;
 if(!volumeId)throw new MessageError('error.destinationUnidentified');
 if(!organizationLocations.some(item=>item.root===scope.root&&item.volumeId===volumeId))organizationLocations.push({root:scope.root,destination:index>=0?scope.destination!:scope.root,volumeId,...(index>=0?{}:{folder:true})});
 await save();
}
async function scanDuplicatesAction(){
 const root=dup.root,scope=root?duplicateScope(root):undefined;
 if(!root||!scope)throw new MessageError('error.duplicatesScope');
 assertIdle();
 pauseCatalog();const control=new AbortController();duplicateControl=control;cancelAutomaticChecks();misplacedControl?.abort();
 dup.status='scanning';dup.result=undefined;dup.unread=undefined;dup.progress=undefined;emit();
 try{
  await stopResidueCheck();
  const real=await fs.realpath(root).catch(()=>{throw new MessageError('error.duplicatesUnavailable');});
  const result=await scanDuplicates(real,{metadata:file=>metadata(file,{details:false}),index:await destinationIndex(real,await identity(real))},{editedFolder:state.preferences.editedFolder,signal:control.signal,onProgress:progress=>{dup.progress=progress;progressEmit();}});
  duplicateGroups=result.groups;duplicateCompanions=result.companions;
  if(result.failures.length){dup.unread={count:result.failures.length,sample:result.failures.slice(0,UNREAD_SAMPLE)};}
  dup.earlier=[...await placedByEarlierJournals(real,control.signal,update=>{dup.progress={phase:'planning',step:'journals',completed:update.read,total:update.total,bytes:0,totalBytes:0,speed:0,file:update.file,journal:{index:update.journal,count:update.journals}};progressEmit();}).catch(()=>new Set<string>())];
  Object.assign(dup,{files:result.files,groups:result.groups.length,scannedAt:new Date().toISOString(),revision:dup.revision+1,status:'ready' as const});
 }catch(error){
  duplicateGroups=[];Object.assign(dup,{groups:0,files:0,revision:dup.revision+1,status:'idle' as const});
  if(!control.signal.aborted)throw error;
 }finally{dup.progress=undefined;if(duplicateControl===control)duplicateControl=undefined;emit();pump();void releaseIfIdle();}
}
/** After a removal that ran cleanly: drop the removed files from the groups, and move carried companions, in memory. */
function applyRemoval(removal:RemovalResult){
 const next=afterRemoval(duplicateGroups,duplicateCompanions,removal);
 const gone=removal.report.filter(line=>line.role==='primary'&&line.result==='removed').length,removed=new Set(removal.report.filter(line=>line.role==='primary'&&line.result==='removed').map(line=>line.file));
 duplicateGroups=next.groups;duplicateCompanions=next.companions;
 dup.earlier=dup.earlier?.filter(item=>!removed.has(item));
 Object.assign(dup,{files:Math.max(0,dup.files-gone),groups:duplicateGroups.length,revision:dup.revision+1});
}
/** A job changed this library: the scan no longer describes it, so it must be run again before anything is removed. */
async function duplicatesStale(roots:string[]){
 if(!dup.root||dup.status!=='ready')return;
 const own=dup.root,mine=[own,await fs.realpath(own).catch(()=>own)];
 for(const root of roots){
  const real=await fs.realpath(root).catch(()=>root);
  if(mine.some(item=>within(item,real)||within(real,item))){duplicateGroups=[];Object.assign(dup,{status:'idle' as const,groups:0,files:0,earlier:undefined,unread:undefined,revision:dup.revision+1});emit();return;}
 }
}
async function removeDuplicatesAction(level:1|2,decisions:Record<string,string>){
 const root=dup.root,scope=root?duplicateScope(root):undefined;
 if(!root||!scope||dup.status!=='ready')throw new MessageError('error.duplicatesStale');
 assertIdle();
 if(![1,2].includes(level)||!decisions||typeof decisions!=='object')throw new Error('Invalid request');
 const resolved=resolveGroups(duplicateGroups,level,Object.fromEntries(Object.entries(decisions).filter(([,value])=>typeof value==='string')),state.preferences.editedFolder);
 if(!summarize(resolved).files)throw new MessageError('error.duplicatesNothing');
 const real=await fs.realpath(root);
 await rememberLibrary(scope);
 const job:Job={id:randomUUID(),source:{id:'duplicates:'+root,name:scope.name,path:root,transport:'folder'},organization:true,phase:'verifying',detail:message('job.removingDuplicates'),errors:[],backup:false};
 etaTracker.plan(job.id,{kind:'duplicates',destinations:[etaDrive(mounts,real,'storage')]});
 state.jobs.unshift(job);const control=startJob(job);dup.status='removing';emit();
 void settle(withJob(job.id,async()=>{
  const reports=path.join(app.getPath('userData'),'operation-reports',job.id);
  let removal:RemovalResult|undefined;
  try{
   await stopResidueCheck();
   const result=removal=await removeDuplicates(real,resolved,duplicateCompanions,{signal:control.signal,index:await destinationIndex(real,await identity(real)),onProgress:progress=>{job.phase=progress.phase==='verifying'?'verifying':'copying';job.progress=progress;job.detail=progress.step==='history'?message('job.readingHistory',{count:progress.completed,total:progress.total}):(recordsDetail(progress)??message('job.removingDuplicates'));progressEmit();}});
   addErrors(job,...(result.result?.errors??[]).map(text));
   await writeReport(job.id,'duplicates.json',{producer:'desktop-app',jobId:job.id,root:real,journal:result.id,groups:result.groups,removed:result.removed,carried:result.carried,left:result.left,bytes:result.bytes,errors:result.result?.errors??[],files:result.report});
   await writeReport(job.id,'summary.json',{producer:'desktop-app',passed:!job.errors.length,jobId:job.id,kind:'duplicates',retainedOriginals:true,finished:new Date().toISOString()});
   job.phase=job.errors.length?'error':'complete';await writeExcerpt(job,reports);
   job.detail=joined(message('job.duplicatesRemoved',{count:result.removed,size:gigabytes(result.bytes)}),result.carried>0&&message('job.duplicatesCarried',{count:result.carried}),result.left>0&&message('job.duplicatesLeft',{count:result.left}),message('job.errors',{count:job.errors.length}));
   addHistory(message('history.duplicatesRemoved',{name:scope.name}),job.detail);
   dup.result={removed:result.removed,bytes:result.bytes,carried:result.carried,left:result.left,errors:job.errors.length,...(result.id?{id:result.id}:{})};
  }catch(error){job.phase=control.signal.aborted?'stopped':'error';job.detail=control.signal.aborted?message('job.stopped'):toMessage(error);if(!control.signal.aborted)addErrors(job,job.detail);}
  finally{catalogStopped.clear();catalogCoordinator?.markDirty();requestCatalogRefresh();delete job.stopping;active.delete(job.id);organizationJobIds.delete(job.id);await refreshOrganizations().catch(()=>{});
   // Changed only by this clean removal, the library's groups are updated in memory; after a failure it is looked through again.
   const result=dup.result,clean=dup.root===root&&!!removal&&!removal.result?.errors.length;
   if(clean){applyRemoval(removal!);dup.status='ready';}else dup.status='idle';
   if(dup.root===root&&!clean&&!active.size){await scanDuplicatesAction().catch(error=>{state.error=toMessage(error);});dup.result=result;}
   forgetMisplaced(touchedMisplaced(state.misplacedFiles,[root]));
   finishJob(job);}
 }));
}
/** Delete originals already in the backup: a separate step after a finished folder import. Only source files whose
 * checksum is confirmed again, now, at every backup copy are removed; anything else stays. Each file is reported. */
async function removeOriginals(jobId:string){
 const job=state.jobs.find(item=>item.id===jobId),kept=importedOriginals.get(jobId);
 if(!job||!kept||(job.phase!=='complete'&&job.phase!=='error')||!job.verifiedOriginals)throw new MessageError('error.originalsStale');
 if(job.deletingOriginals||state.jobs.some(item=>item.source.id===job.source.id&&item.id!==job.id&&isLive(item)))throw new MessageError('error.originalsBusy');
 job.deletingOriginals={completed:0,total:kept.files.length};state.originalsSize=undefined;
 // Each file is read at the source and at every backup copy.
 etaTracker.plan('originals:'+job.id,{kind:'originals',backups:Math.max(1,Math.round(kept.files.reduce((sum,file)=>sum+file.destinations.length,0)/Math.max(1,kept.files.length)))});
 emit();
 const control=new AbortController();originalsControls.set(job.id,control);
 try{
  // Only APFS and HFS+ keep change times that prove an unchanged source; on any other volume every source is read.
  const changeTimes=['apfs','hfs'].includes(volumeOf(await mountedVolumes(),kept.root)?.fsType??'');
  // The drive's capacity bar follows the files as they go, re-read about once a second.
  let capacityRead=0;
  const result=await withJob(jobId,()=>deleteOriginals(kept.root,kept.files,{signal:control.signal,changeTimes,protect:state.sources.map(item=>item.path),onFolders:(completed,total)=>{job.deletingOriginals={...job.deletingOriginals!,folders:{completed,total}};progressEmit();},onProgress:(completed,total,_file,bytes,totalBytes)=>{job.deletingOriginals={completed,total,bytes,totalBytes};const now=Date.now();if(now-capacityRead>=1000){capacityRead=now;void updateFolderCapacity(job.source).then(progressEmit,()=>{});}progressEmit();}}));
  const gone=new Set(result.deleted.map(item=>item.source));
  kept.files=kept.files.filter(file=>!gone.has(file.source));
  job.verifiedOriginals=kept.files.length||undefined;if(!kept.files.length)importedOriginals.delete(jobId);
  job.originalsDeleted={files:result.deleted.length,bytes:result.bytes,kept:result.kept.length,folders:result.folders,...(result.stopped?{stopped:true}:{})};
  await writeReport(job.id,`originals-deleted-${Date.now()}.json`,{producer:'desktop-app',jobId:job.id,source:job.source.path,finished:new Date().toISOString(),deleted:result.deleted,kept:result.kept,foldersRemoved:result.folders,stopped:result.stopped===true,errors:result.errors});
  addHistory(text(job.source.name),result.stopped?message('job.originalsStopped',{count:result.deleted.length,size:gigabytes(result.bytes),kept:result.kept.length}):message('job.originalsDeleted',{count:result.deleted.length,size:gigabytes(result.bytes),kept:result.kept.length,folders:result.folders}));
  if(result.errors.length)state.error=message('error.originalsDelete',{count:result.errors.length,error:result.errors[0]!});
 }catch(error){if(!control.signal.aborted)state.error=toMessage(error);}
 finally{originalsControls.delete(job.id);delete job.deletingOriginals;await updateFolderCapacity(job.source).catch(()=>{});emit();void releaseIfIdle();}
}
const scalar=(value:unknown)=>value===null||['string','number','boolean'].includes(typeof value);
/** Settings changes at normal: each key with its old and new value (structured values only by name), and keys the running jobs refused. */
function logSettings(before:Preferences,after:Preferences,patch:Partial<Preferences>,accepted:Partial<Preferences>){
 const changes:Record<string,unknown>={};
 for(const key of Object.keys(accepted) as (keyof Preferences)[]){const a=before[key],b=after[key];if(JSON.stringify(a)===JSON.stringify(b))continue;changes[key]=scalar(b)||Array.isArray(b)?{from:a,to:b}:'changed';}
 const refused=Object.keys(patch).filter(key=>!(key in accepted));
 if(Object.keys(changes).length)log('normal','settings','changed',{changes});
 if(refused.length)log('normal','settings','refused',{keys:refused,reason:'a job is running, queued, paused or under review'});
}
async function action(input:Action):Promise<void>{
 if(!input||typeof input.type!=='string')throw new Error('Invalid action');
 log('detailed','app','action',{type:input.type,...('jobId' in input&&typeof input.jobId==='string'?{target:input.jobId}:{})},'jobId' in input&&typeof input.jobId==='string'?input.jobId:undefined);
 switch(input.type){
  case 'catalogRefresh':{const coordinator=catalogAvailable();if(!coordinator.binding(input.libraryId))throw new Error('Unknown library.');await catalogSession?.reopen();catalogStopped.delete(input.libraryId);coordinator.markDirty(input.libraryId);requestCatalogRefresh();break;}
  case 'catalogStop':{for(const library of catalogCoordinator?.libraries??[])if(!input.libraryId||input.libraryId===library.libraryId)catalogStopped.add(library.libraryId);catalogCoordinator?.stop(input.libraryId);break;}
  case 'preview':{const source=state.sources.find(s=>s.id===input.sourceId);if(!source)throw new MessageError('error.sourceDisconnected');await previewSource(source,folders.get(source.id)?.backup??false);break;}
  case 'scan':{
   assertIdle('error.busyScan');
   const sources=input.sourceId===undefined?state.sources.filter(item=>item.transport!=='camera'&&item.selected):state.sources.filter(item=>item.id===input.sourceId);
   if(input.sourceId!==undefined&&!sources.length)throw new MessageError('error.sourceDisconnected');
   for(const source of sources)void scanSource(source).catch(error=>{state.error=toMessage(error);emit();});break;
  }
  case 'duplicatesScope':{if(!duplicateScope(input.root))throw new MessageError('error.duplicatesScope');if(duplicateControl||dup.status==='removing')throw new MessageError('error.busy');if(dup.root!==input.root){duplicateGroups=[];Object.assign(dup,{root:input.root,name:duplicateScope(input.root)!.name,status:'idle' as const,groups:0,files:0,scannedAt:undefined,result:undefined,unread:undefined,revision:dup.revision+1});}break;}
  case 'duplicatesChooseFolder':{if(duplicateControl||dup.status==='removing')throw new MessageError('error.busy');const result=await dialog.showOpenDialog(window!,{title:'Choose a library to look through for duplicates',properties:['openDirectory']});if(!result.canceled&&result.filePaths[0]){const root=await fs.realpath(result.filePaths[0]);const libraries=await Promise.all(duplicateScopes().filter(item=>item.destination).map(item=>fs.realpath(item.root).catch(()=>item.root)));if(overlappingLibraries(root,libraries).length>1)throw new MessageError('error.duplicatesLibraries');approved.add(root);chosenScopes.set(root,{root,name:path.basename(root)});duplicateGroups=[];Object.assign(dup,{root,name:path.basename(root),status:'idle' as const,groups:0,files:0,scannedAt:undefined,result:undefined,unread:undefined,revision:dup.revision+1});}break;}
  case 'duplicatesScan':await scanDuplicatesAction();break;
  case 'duplicatesStop':duplicateControl?.abort();break;
  case 'duplicatesRemove':await removeDuplicatesAction(input.level,input.decisions);break;
  case 'refreshOrganization':await refreshOrganizations();break;
  case 'removeReceipt':{
   if(!residueIdle(true))throw new MessageError('error.busy');await stopResidueCheck();if(!residueIdle(true))throw new MessageError('error.busy');
   // Only a receipt the last check listed; removeUnboundReceipt checks it again, and never touches the file.
   const item=residueItems.find(entry=>entry.kind==='unbound'&&entry.file===input.file);
   if(item)await removeUnboundReceipt(item);
   await checkResidue(false);break;
  }
  case 'cleanResidue':{if(!residueIdle(true))throw new MessageError('error.busy');await stopResidueCheck();if(!residueIdle(true))throw new MessageError('error.busy');await checkResidue(true);break;}
  case 'recovery':{if(!['resume','finalize','undo','delete'].includes(input.op))throw new Error('Invalid recovery operation');await resumeOrganizationJob(input.root,input.id,input.op,undefined,undefined,input.op==='resume'&&input.full===true);break;}
  case 'measureOrganizationRecovery':{
   // Read-only: what Delete recovery files would remove, shown in its confirmations.
   const {root,id}=input;if(!state.organizationRecovery?.some(item=>item.root===root&&item.id===id))throw new MessageError('error.recoveryListStale');
   state.recoverySize={root,id};emit();
   try{const size=await measureOrganizationRecovery(root,id,undefined,(files,estimate)=>{if(state.recoverySize?.root===root&&state.recoverySize.id===id){state.recoverySize={root,id,progress:{phase:'planning',step:'measuring',completed:files,total:estimate,share:Math.min(.99,files/Math.max(1,estimate)),bytes:0,totalBytes:0,speed:0,file:''}};progressEmit();}});if(state.recoverySize?.root===root&&state.recoverySize.id===id)state.recoverySize={root,id,...size};}
   catch(error){if(state.recoverySize?.root===root&&state.recoverySize.id===id)state.recoverySize={root,id,error:toMessage(error)};}
   break;
  }
  case 'chooseOrganizationFolders':{
   assertIdle();
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
  case 'deleteOriginals':await settle(removeOriginals(input.jobId));break;
  case 'resetOrganizationFolders':{assertIdle();state.organizeOptions=freshOrganizeOptions();const root=state.preferences.destinations[input.destinationIndex];if(root&&state.organizationFolders){delete state.organizationFolders[root];await save();}break;}
  case 'organize':{
   const prefs=snapshotPreferences(input.destinationIndex),root=prefs.destinations[0]!;
   queueOrganization(root,'Library organization',{prefs,reorganize:true,options:takeOrganizeOptions(),sourceFolders:state.organizationFolders?.[root]?.slice()});break;
  }
  case 'organizeFolder':{
   // Arrange a folder's files into the folder structure inside that same folder: a folder source instead of copying it
   // onto its own drive, or a folder chosen here. Camera cards and removable flash are refused.
   assertOrganizationIdle();
   if(input.sourceId!==undefined){
    const source=state.sources.find(item=>item.id===input.sourceId&&item.transport==='folder');if(!source)throw new MessageError('error.selectDrive');
    if(state.jobs.some(job=>!job.organization&&job.source.id===source.id&&isLive(job)))throw new MessageError('error.busy');
    if(state.review?.source.id===source.id)await discardReview();else if(state.review||state.busyReview)throw new MessageError('error.busy');
    await organizeFolderInPlace(source.path,state.sources.filter(item=>item.id!==source.id));pump();break;
   }
   const result=await dialog.showOpenDialog(window!,{title:'Choose a folder to organize in place',properties:['openDirectory']});
   if(result.canceled||!result.filePaths[0])break;
   await organizeFolderInPlace(result.filePaths[0],state.sources);break;
  }
  case 'checkBackupFolder':{const index=input.destinationIndex;if(index!==0&&index!==1)throw new Error('Invalid destination');checkBackupFolder(index);break;}
  case 'organizeBackup':{const index=input.destinationIndex;if(index!==0&&index!==1)throw new Error('Invalid organization destination');queueBackupOrganization(index);break;}
  case 'previewOrganization':{const root=snapshotPreferences(input.destinationIndex).destinations[0];await previewSource({id:'library:'+root,path:root,name:'Existing library',transport:'folder'},false,input.destinationIndex,typeof input.collectProblemFiles==='boolean'?input.collectProblemFiles:undefined);break;}
  case 'reviewFileDate':{
   // Plan the open review again with file dates for unknown files, for this job only.
   if(!reviewed||busy()||state.busyReview)break;
   const {request,review:{source,backup,destinationIndex}}=reviewed;
   await openReview(source,backup,{...request,useFileDate:true,confirmed:true},destinationIndex);break;
  }
  case 'applyReview':await applyReview();break;
  case 'discardReview':await discardReview();pump();break;
  case 'window': if(input.command==='minimize')window?.minimize();else if(input.command==='maximize'){if(window?.isMaximized())window.unmaximize();else window?.maximize();}else if(input.command==='close')window?.close();break;
  case 'acknowledgeErrors':{
   // Skipping only changes status: nothing is deleted, the reports keep every error, and Delete originals still uses only the verified list.
   const job=typeof input.jobId==='string'?state.jobs.find(item=>item.id===input.jobId):undefined;
   if(!job||active.has(job.id))throw new MessageError('error.acknowledgeInvalid');
   const codes=Array.isArray(input.codes)?input.codes.filter((code:unknown):code is string=>typeof code==='string'):undefined;
   let record;try{record=acknowledgeJob(job,codes);}catch{throw new MessageError('error.acknowledgeInvalid');}
   await acknowledgeSummary(path.join(app.getPath('userData'),'operation-reports',job.id),record).catch(()=>{});
   addHistory(message('history.issuesSkipped',{name:job.source.name,count:record.errorCount}),text(record.groups.map(group=>`${group.code}: ${group.count}`).join(', ')));
   break;
  }
  case 'clearErrors':clearErrors(errorLog,state,{...(Array.isArray(input.ids)?{ids:input.ids.filter((id:unknown):id is string=>typeof id==='string')}:{}),...(input.severity==='error'||input.severity==='warning'?{severity:input.severity}:{})});break;
  case 'refresh':await refresh();break;
  case 'logOpenFolder':{const logger=activeLogger();if(!logger)break;const target=await logger.latest();if(target)shell.showItemInFolder(target);else await shell.openPath(logger.directory);break;}
  case 'acknowledgeOldRecords':{await acknowledgeDrive(input.drive);break;}
  case 'logCopyPath':{const latest=await activeLogger()?.latest();if(latest)clipboard.writeText(latest);break;}
  case 'logExport':{
   const logger=activeLogger();if(!logger)break;await logger.flush();
   const stamp=new Date().toISOString().replace(/[-:]/g,'').slice(0,15).replace('T','-');
   const result=await dialog.showSaveDialog(window!,{title:'Export logs',defaultPath:path.join(app.getPath('documents'),`importer-logs-${stamp}.zip`),filters:[{name:'Zip archive',extensions:['zip']}]});
   if(result.canceled||!result.filePath)break;
   const done=await exportLogs(logger.directory,result.filePath);log('normal','app','logs-exported',{to:done.path,files:done.files,bytes:done.bytes});
   shell.showItemInFolder(done.path);break;
  }
  case 'preferences':{
   const patch=input.patch;
   // A folder name that saves can be planned.
   if(['basePath','mediaLayout','videoBasePath','editedFolder','noMetadataFolder'].some(key=>Object.hasOwn(patch,key)))checkFolderSettings({...state.preferences,...patch});
   // Display and queue settings apply at once. Settings a job reads are ignored without an error (the UI greys them out),
   // while any job runs, waits in the queue or is paused, or a review is open: stop it completely first.
   const before=state.preferences;
   const accepted=acceptedPreferences(patch,settingsLocked(state));
   state.preferences=normalizePreferences({...before,...accepted},before);applyLimits();
   logSettings(before,state.preferences,patch,accepted);setLogLevel(state.preferences.logLevel??'normal');
   nativeTheme.themeSource=state.preferences.appearance;
   if(before.automatic&&!state.preferences.automatic)for(const j of state.jobs)if(j.phase==='queued'&&automaticallyQueued.has(j.id)){j.phase='stopped';j.detail=message('job.automaticDisabled');}
   dropStaleMisplaced();
   await save();pump();break;
  }
  case 'chooseDestination':{assertIdle();if(input.index!==0&&input.index!==1)throw new Error('Invalid destination');const result=await dialog.showOpenDialog(window!,{title:`Choose destination ${input.index+1}`,properties:['openDirectory','createDirectory']});if(!result.canceled&&result.filePaths[0]){const root=await fs.realpath(result.filePaths[0]);const info=await validateDestination(root,state.sources);if(!info.volumeId)throw new MessageError('error.destinationUnidentified');state.preferences.destinations[input.index]=root;(state.preferences.destinationIds??=[])[input.index]=info.volumeId;approved.add(root);await save();await refresh();}break;}
  case 'removeDestination':{assertIdle();state.preferences.destinations.splice(input.index,1);state.preferences.destinationIds?.splice(input.index,1);await save();await refresh();break;}
  case 'chooseSource':{const result=await dialog.showOpenDialog(window!,{title:input.backup?'Choose drives or folders to back up':'Choose media sources',properties:['openDirectory','multiSelections']});if(result.canceled||!result.filePaths.length)break;const {sources,rejected}=await resolveFolderSources(result.filePaths,{sources:state.sources,registered:folders,destinations:state.preferences.destinations,backupFolders:backupFolders(state.preferences),backup:input.backup});const now=new Date().toISOString();for(const source of sources){approved.add(source.path);folders.set(source.id,{source,backup:input.backup});selection.select(source,true,state.preferences.rememberedDevices??={},now,state.preferences.ignoredDevices??={});state.sources=[...state.sources.filter(s=>s.id!==source.id&&s.path!==source.path),source];}if(sources.length){state.sources=selection.apply(state.sources,state.preferences.rememberedDevices??={},state.preferences.ignoredDevices??={},state.preferences.deviceHistory??={});publishDevices();await save();}const [first]=rejected;if(first)throw new MessageError(first.key,first.params);break;}
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
   if(state.jobs.some(job=>job.source.id===failed.source.id&&isLive(job)))throw new MessageError('error.busy');
   enqueue(failed.source,failed.backup);{const queued=state.jobs.find(job=>job.source.id===failed.source.id&&job.phase==='queued');if(queued){queued.useFileDate=failed.useFileDate;queued.unknownConfirmed=failed.unknownConfirmed;delete failed.retryable;delete failed.skippablePath;}}pump();break;
  }
  case 'skip':{
   // Skip leaves the file that stopped the job out; Skip all also skips every other file that fails. Verified copies are recognised, not copied again.
   const failed=state.jobs.find(job=>job.id===input.jobId&&job.skippablePath&&(job.phase==='error'||job.phase==='stopped')&&!active.has(job.id));if(!failed)break;
   if(input.path!==undefined&&input.path!==failed.skippablePath)break;
   const skip={exclude:[...new Set([...(failed.excluded??[]),failed.skippablePath!])],...(input.all===true?{skipErrors:true}:{})};
   // The buttons go away only once the rerun is queued; a refusal leaves them to try again.
   if(failed.organization){const request=organizationRuns.get(failed.id);if(!request)throw new MessageError('error.recoveryListStale');queueOrganization(failed.source.path,failed.source.name,{...request,...skip});delete failed.skippablePath;break;}
   if(state.jobs.some(job=>job.source.id===failed.source.id&&isLive(job)))throw new MessageError('error.busy');
   for(const id of skipRequests.keys())if(!state.jobs.some(job=>job.id===id&&job.phase==='queued'))skipRequests.delete(id);
   enqueue(failed.source,failed.backup);const queued=state.jobs.find(job=>job.source.id===failed.source.id&&job.phase==='queued');if(queued){queued.useFileDate=failed.useFileDate;queued.unknownConfirmed=failed.unknownConfirmed;skipRequests.set(queued.id,skip);delete failed.skippablePath;}pump();break;
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
  case 'stopBackupCheck':misplacedControl?.abort();break;
  case 'unknownRule':{if(state.busyReview)throw new MessageError('error.rulesDuringReview');const ext=input.extension.replace(/^\.+/,'').trim().toLowerCase();const rule=rules({[ext]:input.folder})[ext];sessionRules[ext]=rule;if(input.remember){state.preferences.unknownRules[ext]=rule;await save();}dropStaleMisplaced();emit();if(reviewed?.review.kind==='import')await discardReview();break;}
  case 'stop':{if(input.jobId===undefined&&input.scope===undefined)misplacedControl?.abort();await stopOperations(input,{jobs:state.jobs,sources:state.sources,active,originalsControls,scanControls,pausing,seen,discardReview,organizationJobIds});break;}
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
 // Soft memory governor: main plus the scan worker against the limit; above 90% new files wait, above 100% a warning shows.
 // The main process counts by private memory (refreshed each reading, so a value is at most one tick old); the child is the scan worker.
 let mainPrivate:{private?:number}|undefined;
 const refreshMainMemory=()=>{try{void (process as unknown as {getProcessMemoryInfo?:()=>Promise<{private?:number}>}).getProcessMemoryInfo?.().then(info=>{mainPrivate=info;},()=>{});}catch{/* RSS stays the fallback */}};
 setMainMemory(()=>{refreshMainMemory();return privateOrRss(mainPrivate,process.memoryUsage().rss);});
 setChildMemory(()=>childProcessMemory(app.getAppMetrics()));
 governor.observe({
  onChange:(usage,limit)=>{log('detailed','resources','memory',{usageMB:Math.round(usage),limitMB:limit,busy:busy()});const moved=Math.round(usage/16)!==Math.round(lastUsageMB/16);lastUsageMB=usage;const cleared=overLimit&&usage<limit*0.9;if(cleared)overLimit=false;if(busy()&&(moved||cleared))emit();},
  onWarn:(usage,limit)=>{overLimit=true;log('normal','resources','memory-over-limit',{usageMB:Math.round(usage),limitMB:limit});console.warn(`Memory use ${usage} MB is above the ${limit} MB limit; new files wait until it drops.`);if(busy())emit();},
 });
 governor.start();
 let hardwareReportRoot:string|undefined;
 if(hardwareTest){const requested=process.argv.find(arg=>arg.startsWith('--hardware-report-root='))?.slice('--hardware-report-root='.length);const temporary=await fs.realpath(os.tmpdir());hardwareReportRoot=await fs.realpath(requested??await fs.mkdtemp(path.join(os.tmpdir(),'photo-importer-a006-release-')));if(!within(hardwareReportRoot,temporary)||hardwareReportRoot===temporary)throw new Error('Hardware reports require a dedicated existing temporary folder.');app.setPath('userData',path.join(hardwareReportRoot,'user-data'));}
 if(qaFixtureRoot){const root=await fs.realpath(qaFixtureRoot);if(!within(root,await fs.realpath(os.tmpdir())))throw new Error('QA fixtures must be in the system temporary directory.');app.setPath('userData',path.join(root,'user-data'));}
 try{await initializeRecoveryKey();}catch(error){state.error=toMessage(error);}
 await load();
 {const logger=configureLogger({dir:path.join(app.getPath('userData'),'logs'),level:state.preferences.logLevel??'normal'});log('normal','app','start',{version:app.getVersion(),electron:process.versions.electron,node:process.versions.node,chrome:process.versions.chrome,platform:process.platform,arch:process.arch,osRelease:os.release(),cpus:os.cpus().length,totalMemMB:Math.round(os.totalmem()/MB),level:logger.getLevel(),qa,pid:process.pid});}
 {const priors=new PriorStore(path.join(app.getPath('userData'),'eta-priors.json'),()=>randomBytes(16).toString('base64url'));await priors.load();etaTracker.attach(priors);}
 if(hardwareReportRoot)state.preferences=normalizePreferences({destinations:[hardwareDestination.path],destinationIds:[hardwareDestination.volumeId]});
 nativeTheme.themeSource=state.preferences.appearance;
 try{try{const stored=JSON.parse(await fs.readFile(catalogManifest(),'utf8'));if(Array.isArray(stored))rememberedCatalogLibraries=stored.filter((entry:LibraryBinding)=>typeof entry?.root==='string'&&path.isAbsolute(entry.root)&&typeof entry.library?.libraryId==='string'&&typeof entry.library.relativeRoot==='string'&&typeof entry.library.mountPath==='string'&&entry.library.trustedVolumeId===true&&within(entry.root,entry.library.mountPath)).map((entry:LibraryBinding)=>({...entry,rootIdentity:undefined,library:{...entry.library,online:false}}));}catch{/* First local index. */}catalogSession=createCatalogSession(onError=>startCatalog(path.join(app.getPath('userData'),'catalog','library.sqlite'),{onError}),{onError:error=>{log('normal','catalog','worker-failed',{error});publishCatalog();}});catalog=catalogSession.catalog;catalogCoordinator=new CatalogCoordinator(catalog,{metadata:file=>metadata(file,{details:false}),cachedMetadata:cachedRouting,options:()=>ruleOptions(state.preferences),validate:binding=>catalogVolumeValid(binding),changed:()=>publishCatalog(),warning:(error,libraryId)=>log('normal','catalog','index-warning',{error,libraryId})});}catch(error){log('normal','catalog','open-failed',{error});}
 if(qaFixtureRoot){const root=await fs.realpath(qaFixtureRoot);if(!within(root,await fs.realpath(os.tmpdir())))throw new Error('QA fixtures must be in the system temporary directory.');const destination=path.join(root,'destination');const info=await volumeInfo(destination);state.preferences.destinations=[destination,path.join(root,'destination-2')];state.preferences.destinationIds=[info.volumeId??'',info.volumeId??''];for(let i=1;i<=6;i++){const folder=await fs.realpath(path.join(root,`source-${i}`));const source:Source={id:`fixture:${i}`,name:`Fixture card ${i}`,path:folder,transport:'folder',total:info.total,free:info.free};folders.set(source.id,{source,backup:true});approved.add(folder);}}
 session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
 const renderer=path.join(__dirname,'../renderer/index.html');
 window=new BrowserWindow({frame:process.platform==='darwin',...(process.platform==='darwin'?{titleBarStyle:'hidden' as const,trafficLightPosition:{x:18,y:15}}:{}),title:'Automatic Photo Importer',width:1440,height:940,minWidth:1000,minHeight:720,backgroundColor:'#151c24',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,scrollBounce:true}});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
 function trusted(event:Electron.IpcMainInvokeEvent){if(!window||event.sender!==window.webContents||event.senderFrame?.url!==pathToFileURL(renderer).href)throw new Error('Untrusted request');}
 ipcMain.handle('importer:state',event=>{trusted(event);return stateChannel.snapshot(state);});
 ipcMain.handle('importer:action',async(event,value)=>{trusted(event);try{if(qaHooks?.beforeAction?.(value)===false)return;await action(value);}catch(e){state.error=toMessage(e);emit();}});
 ipcMain.handle('importer:catalogQuery',(event,query:CatalogQuery)=>{trusted(event);return catalogMember(query?.libraryId).catalog.query(query);});
 ipcMain.handle('importer:catalogDirectories',(event,query:CatalogQuery)=>{trusted(event);return catalogMember(query?.libraryId).catalog.directories(query);});
 ipcMain.handle('importer:catalogFacets',(event,query:CatalogQuery,field:CategoryField)=>{trusted(event);return catalogMember(query?.libraryId).catalog.facets(query,field);});
 ipcMain.handle('importer:catalogStatus',(event,libraryId:string)=>{trusted(event);return catalogMember(libraryId).status(libraryId);});
 ipcMain.handle('importer:catalogResolve',(event,libraryId:string,fileId:string)=>{trusted(event);const coordinator=catalogAvailable();return resolveCatalogFile(coordinator.catalog,coordinator.binding(libraryId),fileId,binding=>catalogVolumeValid(binding,true));});
 ipcMain.handle('importer:summary',async(event,file:string)=>{trusted(event);if(qaHooks?.inspect)return qaHooks.inspect(file);inspecting++;try{return await metadata(await allowed(file),{details:false});}finally{inspecting--;void releaseIfIdle();}});
 ipcMain.handle('importer:exif',async(event,file:string)=>{trusted(event);if(qaHooks?.inspect)return qaHooks.inspect(file);inspecting++;try{return await metadata(await allowed(file));}finally{inspecting--;void releaseIfIdle();}});
 ipcMain.handle('importer:thumbnail',async(event,file:string)=>{trusted(event);inspecting++;try{const allowedFile=await allowed(file);return await thumbnailSlots(()=>thumbnail(allowedFile,{cache:path.join(app.getPath('userData'),'thumbnails'),decoders:systemDecoders(embeddedPreview)}));}finally{inspecting--;void releaseIfIdle();}});
 ipcMain.handle('importer:errorPaths',(event,jobId:unknown,code:unknown)=>{trusted(event);const job=typeof jobId==='string'?state.jobs.find(item=>item.id===jobId):undefined;return job&&typeof code==='string'?issuePaths(job,code):[];});
 ipcMain.handle('importer:duplicates',event=>{trusted(event);return duplicateGroups;});
 await window.loadFile(renderer);await refresh();timer=setInterval(()=>void refresh(),5000);
 // A new sample rides along with the next publish; it forces one only when nothing else published for a second.
 if(process.platform==='darwin'&&!hardwareTest){activityLoop=startActivityLoop({sampler:driveSampler,wanted:()=>!!window&&!window.isDestroyed()&&window.isVisible()&&!window.isMinimized()||busy()||scanControls.size>0||!!state.review||!!state.busyReview,publish:activity=>{state.driveActivity=activity;activityLog.observe(activity,Date.now());if(Date.now()-lastEmit>=1000)emit();}});window.on('show',()=>activityLoop?.wake());window.on('restore',()=>activityLoop?.wake());window.on('focus',()=>activityLoop?.wake());}
 if(hardwareReportRoot){const reports=hardwareReportRoot,owner=window;runA006HardwareTest(()=>state,action,reports,async source=>{const result=await dialog.showOpenDialog(owner,{title:`Authorize read access: ${source.name}`,defaultPath:source.path,properties:['openDirectory']});if(result.canceled||!result.filePaths[0]||await fs.realpath(result.filePaths[0])!==await fs.realpath(source.path))throw new Error(`Select the exact source root: ${source.path}`);}).catch(error=>{state.error=text(`A006 hardware test failed: ${errorText(error)}. Reports: ${reports}`);emit();});}
 if(qa&&qaFixtureRoot&&process.argv.includes('--codex-test')){if(!app.isPackaged)qaHooks=createQaHooks(state,emit);const passed=await runCodexSmoke(window,qaFixtureRoot,{uiOnly:process.argv.includes('--codex-ui-only'),organizationOnly:process.argv.includes('--codex-organization-only'),only:process.argv.find(arg=>arg.startsWith('--codex-only='))?.slice('--codex-only='.length),deadline:Number(process.argv.find(arg=>arg.startsWith('--codex-deadline='))?.slice('--codex-deadline='.length))||undefined},qaHooks);
  // exiftool can take minutes to end on a loaded machine; the QA result is already written, so its exit waits at most 15 s.
  const closing=Date.now();await Promise.race([closeMetadata(),new Promise(resolve=>setTimeout(resolve,15000))]);console.log(`QA exit: metadata reader closed in ${((Date.now()-closing)/1000).toFixed(1)} s`);app.exit(passed?0:1);}
}
if(!qa&&!hardwareTest&&!app.requestSingleInstanceLock())app.quit();else app.whenReady().then(boot).catch(error=>{dialog.showErrorBox('Unable to start',errorText(error));app.quit();});
app.on('second-instance',()=>{if(window?.isMinimized())window.restore();window?.focus();});
app.on('window-all-closed',()=>app.quit());
let quitting=false,closing:Promise<void>|undefined;
// Holding a system shutdown or logout would cancel it; jobs are then stopped without waiting. The camera
// helper is then only asked to end, and exiftool ends when its input closes with this process.
app.whenReady().then(()=>powerMonitor.on('shutdown',()=>{quitting=true;})).catch(()=>{});
app.on('before-quit',event=>{
 if(!quitting&&!closing)log('normal','app','quit',{runningJobs:active.size});
 catalogClosing=true;catalogCoordinator?.stop();catalogRefreshScheduler.close();if(catalogPublishTimer)clearTimeout(catalogPublishTimer);if(timer)clearInterval(timer);cancelAutomaticChecks();
 for(const control of [...active.values(),...originalsControls.values(),...scanControls.values()])control.abort();misplacedControl?.abort();residueControl?.abort();reviewControl?.abort();duplicateControl?.abort();
 // A quit the closing step started, or a system shutdown, goes through; another quit meanwhile waits for it.
 if(!quitting&&closing){event.preventDefault();return;}
 if(!quitting){
  // Stopped jobs, scans and an open review remove their staging files and camera downloads first, then
  // everything that holds a drive is closed (all within 10 s).
  event.preventDefault();
  const finish=async()=>{
   await Promise.allSettled([...settling,scansSettled(),misplacedTask,residueTask,oldRecordsTask,...(reviewed||reviewControl?[discardReview()]:[])]);
   await catalogCoordinator?.settled();await catalog?.close();
   await Promise.allSettled([closeMetadata(),closeCameraBridge(),terminateHasher()]);
   await activeLogger()?.close();
  };
  closing=Promise.race([finish(),new Promise<void>(resolve=>setTimeout(resolve,10000).unref())]).finally(()=>{quitting=true;app.quit();});
  return;
 }
 void closeMetadata();void closeCameraBridge();activeLogger()?.flushSync();
});
process.on('exit',()=>activeLogger()?.flushSync());
