import {UNKNOWN_FILES_FOLDER} from './shared';

// Folders the app itself owns (lower case); a name for unknown files may not shadow them.
const RESERVED=new Set(['drive backups','photo importer recovery','.photo-importer-recovery','problem files','conflicts','photo importer data','unknown camera']);
/** True when `name` is one safe folder name for unknown files: no separators, braces or control characters, not dotted, not an app folder. */
export function validNoMetadataFolder(name:unknown,taken:readonly string[]=[]):name is string {
 if(typeof name!=='string'||!name||name.trim()!==name||name.length>120)return false;
 if(/[\\/:\x00-\x1f\x7f<>"|?*{}]/u.test(name)||name==='.'||name==='..'||/[. ]$/u.test(name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))return false;
 // A folder the folder template can produce (a year, month, day, or a month name) would mix up unknown files with dated ones.
 // The templates write English month names whatever the language.
 if(/^\d+$/.test(name)||/^\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)$/i.test(name)||/^\d{4}-\d{1,2}(\s|$)/.test(name))return false;
 // Nor the folders the app files into: the edited folder and the backup folders (a multi-part path counts by its first folder too).
 const lower=name.toLowerCase();
 if(taken.some(item=>{const path=item.trim().replace(/^[\\/]+|[\\/]+$/g,'').toLowerCase();return !!path&&(path===lower||path.split(/[\\/]/)[0]===lower);}))return false;
 return !RESERVED.has(lower);
}
/** The validated folder name, the default when none is set; throws for an unsafe one. */
export function noMetadataFolderName(name:string|undefined,taken:readonly string[]=[]):string {
 if(name===undefined)return UNKNOWN_FILES_FOLDER;
 if(!validNoMetadataFolder(name,taken))throw new Error('Choose a single safe folder name for unknown files.');
 return name;
}
