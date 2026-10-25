import {createHash} from 'node:crypto';
import type {NoMetadataHandling,Preferences} from './shared';
import {UNKNOWN_FILES_FOLDER} from './shared';
import {validateRelative,validFolderName} from './folder-template';
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
/** Bumped when the app itself changes which folder a file is filed in. */
const RULES_VERSION=4;
/** The scope the routing and placement memories are valid for: every rule in `ruleOptions`. A record made under
 * another scope (or another RULES_VERSION) is not trusted. */
export function rulesScope(rules:ReturnType<typeof ruleOptions>):string {
 const unknown=Object.entries(rules.unknownRules??{}).sort(([a],[b])=>a.localeCompare(b));
 return createHash('sha256').update(JSON.stringify([RULES_VERSION,rules.template,rules.layout,rules.videoTemplate??'',rules.editedFolder??'',rules.noMetadata,rules.noMetadataFolder,unknown,rules.unknownDefault??''])).digest('hex').slice(0,32);
}
/** A backup folder (relative to its destination) the planner accepts: `validateRelative`, and not one of the app's record folders. */
export function validFolderPath(folder:unknown):folder is string {
 if(typeof folder!=='string')return false;
 try { validateRelative(folder); } catch { return false; }
 return !folder.split('/').some(isRecordFolderName);
}
/** The backup folders the planner accepts: a valid photo folder (empty is the destination itself) and, in the video-root
 * layout only, a valid video folder that neither holds nor sits inside a non-empty photo folder. Throws the message to show. */
export function checkBackupFolders(prefs:Pick<Preferences,'basePath'|'mediaLayout'|'videoBasePath'>):void {
 if(prefs.basePath!==''&&!validFolderPath(prefs.basePath))throw new MessageError('error.backupFolderPath');
 if(prefs.mediaLayout==='video-root'&&(!validFolderPath(prefs.videoBasePath)||!prefs.basePath||within(prefs.videoBasePath,prefs.basePath)||within(prefs.basePath,prefs.videoBasePath)))throw new MessageError('error.videoFolderPath');
}
/** Throws for the first folder name the planner would refuse, so a name that saves can be planned. An empty backup
 * folder is the destination itself. */
export function checkFolderSettings(prefs:Pick<Preferences,'basePath'|'mediaLayout'|'videoBasePath'|'editedFolder'|'noMetadataFolder'>):void {
 checkBackupFolders(prefs);
 if(prefs.editedFolder!==undefined&&!validFolderName(prefs.editedFolder))throw new MessageError('error.editedFolderName');
 if(prefs.noMetadataFolder!==undefined&&!validNoMetadataFolder(prefs.noMetadataFolder,[prefs.editedFolder??'',prefs.basePath,prefs.videoBasePath??'']))throw new MessageError('error.noMetadataFolderName');
}
