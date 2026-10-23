import {UNKNOWN_FILES_FOLDER} from './shared';

// Folders the app itself owns (lower case); a name for unknown files may not shadow them.
const RESERVED=new Set(['drive backups','photo importer recovery','.photo-importer-recovery','problem files','conflicts','photo importer data','unknown camera']);
/** True when `name` is one safe folder name for unknown files: no separators, braces or control characters, not dotted, not an app folder. */
export function validNoMetadataFolder(name:unknown):name is string {
 if(typeof name!=='string'||!name||name.trim()!==name||name.length>120)return false;
 if(/[\\/:\x00-\x1f\x7f<>"|?*{}]/u.test(name)||name==='.'||name==='..'||/[. ]$/u.test(name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))return false;
 // A folder the folder template can produce (a year, month, day, or a month name) would mix up unknown files with dated ones.
 if(/^\d+$/.test(name)||/^\d{2} (January|February|March|April|May|June|July|August|September|October|November|December)$/i.test(name)||/^\d{4}-\d{2} /.test(name))return false;
 return !RESERVED.has(name.toLowerCase());
}
/** The validated folder name, the default when none is set; throws for an unsafe one. */
export function noMetadataFolderName(name:string|undefined):string {
 if(name===undefined)return UNKNOWN_FILES_FOLDER;
 if(!validNoMetadataFolder(name))throw new Error('Choose a single safe folder name for unknown files.');
 return name;
}
