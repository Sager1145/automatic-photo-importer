/** Names this app used before records moved into one "Photo Importer Data" folder (records v5). They stay
 * excluded from listings, organizing, cleanup and "._" removal for good: a drive can still hold them. */
export const RECOVERY_FOLDER='Photo Importer Recovery';
/** Where versions before RECOVERY_FOLDER kept their journals and originals. */
export const LEGACY_RECOVERY_FOLDER='.photo-importer-recovery';
/** The one folder (at the configured destination, or the library itself) that holds every record this app writes on a drive. */
export const APP_DATA_FOLDER='Photo Importer Data';
/** Folders holding this app's records, current and earlier, compared without case. */
export const RECORD_FOLDERS=[APP_DATA_FOLDER,RECOVERY_FOLDER,LEGACY_RECOVERY_FOLDER];
export const isRecordFolderName=(name:string)=>RECORD_FOLDERS.some(item=>item.toLowerCase()===name.toLowerCase());
