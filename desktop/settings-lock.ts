import type { AppState, Preferences } from './shared';

/** Phases in which a job is reading or writing drives. */
export const activeJobPhases:readonly string[]=['discovering','verifying','copying'];

/** Settings a job reads while it runs or when it continues after a pause; changing one midway
 * could file half a job one way and half another, so they wait until every job has fully stopped. */
export const jobPreferences:ReadonlySet<string>=new Set(['copyMode','backupMode','verifyCopies','skipErrors','removeEmptySourceFolders','releaseDuplicatesAfterOrganizing','autoOrganizeBackup','unknownDefault','basePath','template','mediaLayout','videoBasePath','videoTemplate','allowFolderSource','editedFolder']);

/** True while any job is running, queued or paused, or a review is open or being built, or a source is scanned. */
export function settingsLocked(state:Pick<AppState,'jobs'>&{review?:unknown;busyReview?:unknown;scanningSources?:readonly string[]}):boolean {
 return state.jobs.some(job=>activeJobPhases.includes(job.phase)||job.phase==='queued'||(job.phase==='stopped'&&job.paused===true))
  ||!!state.review||!!state.busyReview||!!state.scanningSources?.length;
}

/** The keys of a settings change that must wait until nothing is running. */
export function lockedPreferenceKeys(patch:Partial<Preferences>):string[] {return Object.keys(patch).filter(key=>jobPreferences.has(key));}
