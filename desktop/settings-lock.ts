import { isLive, type AppState, type Preferences } from './shared';

/** Settings a job reads while it runs or when it continues after a pause; changing one midway
 * could file half a job one way and half another, so they wait until every job has fully stopped. */
export const jobPreferences:ReadonlySet<string>=new Set(['copyMode','backupMode','verifyCopies','skipFileErrors','collectProblemFiles','removeAppleDouble','autoOrganizeBackup','unknownDefault','noMetadataHandling','noMetadataFolder','conflictNaming','basePath','template','mediaLayout','videoBasePath','videoTemplate','editedFolder','maxCpuThreads','memoryLimitMB']);

/** True while any job is running, queued or paused, a review is open or being built, a source is scanned, or Remove duplicates scans or removes. */
export function settingsLocked(state:Pick<AppState,'jobs'>&{review?:unknown;busyReview?:unknown;scanningSources?:readonly string[];duplicates?:{status:string}}):boolean {
 return state.jobs.some(job=>isLive(job)||(job.phase==='stopped'&&job.paused===true))
  ||!!state.review||!!state.busyReview||!!state.scanningSources?.length||state.duplicates?.status==='scanning'||state.duplicates?.status==='removing';
}

/** The keys of a settings change that must wait until nothing is running. */
export function lockedPreferenceKeys(patch:Partial<Preferences>):string[] {return Object.keys(patch).filter(key=>jobPreferences.has(key));}

/** Display and queue settings that apply at once, even while work is active. */
export const livePreferences:ReadonlySet<string>=new Set(['language','appearance','sourceLayout','showDashboard','textScale','accent','parallel','automatic','logLevel']);

/** The part of a settings change to apply: live keys always, job keys only when nothing locks them; the rest is dropped silently. */
export function acceptedPreferences(patch:Partial<Preferences>,locked:boolean):Partial<Preferences> {
 return Object.fromEntries(Object.entries(patch).filter(([key])=>livePreferences.has(key)||!locked&&jobPreferences.has(key))) as Partial<Preferences>;
}
