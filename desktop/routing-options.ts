import type {NoMetadataHandling,Preferences} from './shared';
import {UNKNOWN_FILES_FOLDER} from './shared';

type Rules=Pick<Preferences,'template'|'mediaLayout'|'videoTemplate'|'editedFolder'|'noMetadataHandling'|'noMetadataFolder'>;
/** The one place the settings that decide which folder a file is filed in (or left out of) become planner options.
 * Planning, the folder check and the "filed under older rules" lookup all take their rules from here, so none can miss one. */
export function ruleOptions(prefs:Rules,useFileDate=false){
 return {
  template:prefs.template,layout:prefs.mediaLayout,videoTemplate:prefs.videoTemplate,editedFolder:prefs.editedFolder,
  noMetadata:(useFileDate?'fileDate':prefs.noMetadataHandling??'keep') as NoMetadataHandling,
  noMetadataFolder:prefs.noMetadataFolder??UNKNOWN_FILES_FOLDER,
 };
}
