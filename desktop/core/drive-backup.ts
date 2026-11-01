import * as fs from 'node:fs/promises';
import path from 'node:path';

/** The folder earlier versions copied whole drives into, unsorted: `<library>/Drive backups/<drive name>/`, one marker
 * per drive, and files an Additive/Mirror backup set aside under `Removed by mirror/` (`.mirror-removed/` before that).
 * This version never creates it. Files & folders imports file every file into the library instead (ImportRequest
 * `everyFile`), and Library organization files everything already in it (index.ts `everyFileIn`), so it empties and goes. */
export const DRIVE_BACKUPS='Drive backups';
/** The marker those versions wrote at the top of each drive's folder: the drive's identity, app bookkeeping only. */
export const DRIVE_MARKER='photo-importer-drive.json';
const markers=new Set([DRIVE_MARKER,'.'+DRIVE_MARKER]);
/** A marker is a few hundred bytes of JSON; anything else by that name is a user's file and stays. */
const MARKER_MAX_BYTES=16*1024;

/** Why `file` is a retired drive marker that may go with the folder an organization emptied: named so, directly in a
 * drive's folder of a Drive backups folder, small, and one JSON object (sealed or plain: either system's seal, since a
 * marker sealed on another computer cannot be opened here). Undefined for anything else, which keeps the folder. */
export async function retiredDriveMarker(file:string):Promise<string|undefined> {
  if(!markers.has(path.basename(file))||path.basename(path.dirname(path.dirname(file)))!==DRIVE_BACKUPS)return undefined;
  const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.size>MARKER_MAX_BYTES)return undefined;
  try {
    const recorded:unknown=JSON.parse(await fs.readFile(file,'utf8'));
    return recorded&&typeof recorded==='object'&&!Array.isArray(recorded)?'drive marker an earlier version wrote for its Drive backups folder (app bookkeeping, no user content)':undefined;
  } catch { return undefined; }
}
