import {createHash} from 'node:crypto';
import type {NoMetadataHandling,Preferences} from './shared';
import {UNKNOWN_FILES_FOLDER} from './shared';
import {validFolderName} from './folder-template';
import {validNoMetadataFolder} from './no-metadata';
import {isRecordFolderName} from './core/legacy-names';
import {MessageError} from './messages';
import {within} from './core/paths';

type Rules=Pick<Preferences,'template'|'mediaLayout'|'videoTemplate'|'editedFolder'|'noMetadataHandling'|'noMetadataFolder'|'unknownRules'|'unknownDefault'>;
/** The one place the settings that decide which folder a file is filed in (or left out of) become planner options.
 * Planning, the folder check and the "filed under older rules" lookup all take their rules from here, so none can miss one. */
export function ruleOptions(prefs:Rules,useFileDate=false){
 return {
  template:prefs.template,layout:prefs.mediaLayout,videoTemplate:prefs.videoTemplate,editedFolder:prefs.editedFolder,
  noMetadata:(useFileDate?'fileDate':prefs.noMetadataHandling??'folder') as NoMetadataHandling,
  noMetadataFolder:prefs.noMetadataFolder??UNKNOWN_FILES_FOLDER,
  unknownRules:prefs.unknownRules,unknownDefault:prefs.unknownDefault,
 };
}
/** Bumped when the app itself changes which folder a file is filed in. 3 and 4 were each used by one of two merged branches. */
const RULES_VERSION=5;
/** The scope the routing and placement memories are valid for: every rule in `ruleOptions`. A record made under
 * another scope (or another RULES_VERSION) is not trusted. */
export function rulesScope(rules:ReturnType<typeof ruleOptions>):string {
 const unknown=Object.entries(rules.unknownRules??{}).sort(([a],[b])=>a.localeCompare(b));
 return createHash('sha256').update(JSON.stringify([RULES_VERSION,rules.template,rules.layout,rules.videoTemplate??'',rules.editedFolder??'',rules.noMetadata,rules.noMetadataFolder,unknown,rules.unknownDefault??''])).digest('hex').slice(0,32);
}
/** The backup folders a job uses: none inside one of the app's record folders, and in the video-root layout a video
 * folder for each destination that neither holds nor sits inside its photo folder. The two may be on one drive or on
 * two. Throws the message to show. */
export function checkBackupFolders(prefs:Pick<Preferences,'mediaLayout'|'destinations'|'videoDestinations'>,count=prefs.destinations.length):void {
 for(let index=0;index<count;index++){
  const photo=prefs.destinations[index],video=prefs.mediaLayout==='video-root'?prefs.videoDestinations?.[index]:undefined;
  if(prefs.mediaLayout==='video-root'&&!video)throw new MessageError('error.videoFolderMissing');
  checkFolderPair(photo,video);
 }
}
/** One destination's photo and video folders, either of them not chosen yet: neither inside a record folder, neither holding the other. */
export function checkFolderPair(photo:string|undefined,video:string|undefined):void {
 for(const folder of [photo,video])if(folder&&folder.split(/[\\/]/).some(isRecordFolderName))throw new MessageError('error.backupFolderPath');
 if(photo&&video&&(within(video,photo)||within(photo,video)))throw new MessageError('error.videoFolderNested');
}
/** Throws for the first folder name the planner would refuse, so a name that saves can be planned. */
export function checkFolderSettings(prefs:Pick<Preferences,'editedFolder'|'noMetadataFolder'>):void {
 if(prefs.editedFolder!==undefined&&!validFolderName(prefs.editedFolder))throw new MessageError('error.editedFolderName');
 if(prefs.noMetadataFolder!==undefined&&!validNoMetadataFolder(prefs.noMetadataFolder,[prefs.editedFolder??'']))throw new MessageError('error.noMetadataFolderName');
}
