import * as fs from 'node:fs/promises';
import path from 'node:path';
import type {DestinationStatus,Preferences,Source} from '../shared';
import {makeParent,syncParents,within} from '../core/paths';
import {mountedVolumes,validateDestination,type MountedVolume} from './volumes';
import {message,MessageError,type Message} from '../messages';

/** Validate the destinations a copy policy needs and create their backup folders. `sources`
 * are every connected source (none may hold a destination); `importing`, when given, is the one
 * source being copied, refused before any folder is created if it already lies in the backup. */
export async function destinationRoots(prefs:Preferences,sources:Source[],importing?:Source):Promise<{roots:string[];infos:DestinationStatus[];volumes:MountedVolume[]}>{
 const chosen=prefs.copyMode==='single'?prefs.destinations.slice(0,1):prefs.destinations.slice(0,2);
 if(chosen.length!==(prefs.copyMode==='single'?1:2))throw new MessageError('error.chooseDestinations');
 const parts=prefs.basePath.split('/');if(prefs.basePath&&(path.isAbsolute(prefs.basePath)||parts.some(p=>!p||p==='.'||p==='..'||/[\\\0:]/.test(p))))throw new MessageError('error.backupFolderPath');
 const volumes=await mountedVolumes(),infos=[],roots=[];
 for(const [index,chosenPath] of chosen.entries()){const info=await validateDestination(chosenPath,sources,{identity:prefs.destinationIds?.[index]??'',volumes});infos.push(info);const chosenRoot=await fs.realpath(chosenPath),root=path.join(chosenRoot,prefs.basePath);
  // A backup folder inside a source is fine: planning leaves it out of that source.
  const inside=importing&&sourceInsideBackup(importing.path,[chosenRoot],prefs.basePath);if(inside)throw new MessageError(inside.key,inside.params);
  await makeParent(path.join(root,'.backup-folder-check'),chosenRoot);if(root!==chosenRoot)await syncParents(root,chosenRoot);roots.push(root);}
 if(infos.length===2){if(!infos[0].physicalId||!infos[1].physicalId)throw new MessageError('error.separateDisksUnverified');if(infos[0].physicalId===infos[1].physicalId||infos[0].volumeId===infos[1].volumeId)throw new MessageError('error.separateDisks');}
 return {roots,infos,volumes};
}
/** A source inside a backup folder has nothing to import: its files are already in the
 * backup. A source that contains a backup folder is fine; planning leaves that folder out. */
export function sourceInsideBackup(source:string,destinations:string[],basePath:string):Message|undefined {
 for(const destination of destinations){
  const root=path.join(destination,basePath);
  if(within(source,root))return message('error.alreadyInBackup',{source,root});
 }
}
