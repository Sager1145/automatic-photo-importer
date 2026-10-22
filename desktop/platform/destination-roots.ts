import * as fs from 'node:fs/promises';
import path from 'node:path';
import type {DestinationStatus,Preferences,Source} from '../shared';
import {makeParent,syncParents,within} from '../core/paths';
import {mountedVolumes,validateDestination,type MountedVolume} from './volumes';

/** The backup folders on each destination: the photo one, and in the video-root layout the video one. */
export function backupFolders(prefs:Pick<Preferences,'basePath'|'mediaLayout'|'videoBasePath'>):string[] {
 return prefs.mediaLayout==='video-root'?[prefs.basePath,prefs.videoBasePath]:[prefs.basePath];
}
const unsafeFolder=(folder:string)=>{const parts=folder.split('/');return path.isAbsolute(folder)||parts.some(p=>!p||p==='.'||p==='..'||/[\\\0:]/.test(p));};

/** Validate the destinations a copy policy needs and create their backup folders. `sources`
 * are every connected source (none may hold a destination); `importing`, when given, is the one
 * source being copied, refused before any folder is created if it already lies in the backup.
 * `videoRoots` (video-root layout only) are the video backup folders, by position. */
export async function destinationRoots(prefs:Preferences,sources:Source[],importing?:Source):Promise<{roots:string[];videoRoots?:string[];infos:DestinationStatus[];volumes:MountedVolume[]}>{
 const chosen=prefs.copyMode==='single'?prefs.destinations.slice(0,1):prefs.destinations.slice(0,2);
 if(chosen.length!==(prefs.copyMode==='single'?1:2))throw new Error('Choose the required backup destinations first.');
 if(prefs.basePath&&unsafeFolder(prefs.basePath))throw new Error('Use a relative backup folder without . or .. components.');
 const folders=backupFolders(prefs),video=folders.length>1;
 // Neither backup folder may hold the other: each is organized and checked as its own library.
 if(video&&(unsafeFolder(prefs.videoBasePath)||!prefs.basePath||within(prefs.videoBasePath,prefs.basePath)||within(prefs.basePath,prefs.videoBasePath)))throw new Error('Use a separate video backup folder beside the photo backup folder, without . or .. components.');
 const volumes=await mountedVolumes(),infos=[],roots=[],videoRoots=[];
 for(const [index,chosenPath] of chosen.entries()){const info=await validateDestination(chosenPath,sources,{identity:prefs.destinationIds?.[index]??'',volumes});infos.push(info);const chosenRoot=await fs.realpath(chosenPath);
  // A backup folder inside a source is fine: planning leaves it out of that source.
  const inside=importing&&sourceInsideBackup(importing.path,[chosenRoot],folders);if(inside)throw new Error(inside);
  const [root,videoRoot]=folders.map(folder=>path.join(chosenRoot,folder));
  for(const folder of [root!,...(video?[videoRoot!]:[])]){await makeParent(path.join(folder,'.backup-folder-check'),chosenRoot);if(folder!==chosenRoot)await syncParents(folder,chosenRoot);}
  roots.push(root!);if(video)videoRoots.push(videoRoot!);}
 if(infos.length===2){if(!infos[0].physicalId||!infos[1].physicalId)throw new Error('Could not verify that destinations are on separate physical disks.');if(infos[0].physicalId===infos[1].physicalId||infos[0].volumeId===infos[1].volumeId)throw new Error('Choose two separate physical backup disks.');}
 return {roots,...(video?{videoRoots}:{}),infos,volumes};
}
/** A source inside a backup folder has nothing to import: its files are already in the
 * backup. A source that contains a backup folder is fine; planning leaves that folder out. */
export function sourceInsideBackup(source:string,destinations:string[],folders:string[]):string|undefined {
 for(const destination of destinations)for(const folder of folders){
  const root=path.join(destination,folder);
  if(within(source,root))return `${source} is already in your backup (${root}); there is nothing to import from it.`;
 }
}
