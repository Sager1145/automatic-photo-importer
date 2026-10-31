import path from 'node:path';
import type {DestinationStatus,Preferences,Source} from '../shared';
import {requiredDestinations} from '../shared';
import {makeParent,syncParents,within} from '../core/paths';
import {checkBackupFolders} from '../routing-options';
import {existingAncestor,mountedVolumes,validateDestination,type MountedVolume} from './volumes';
import {message,MessageError,type Message} from '../messages';
import * as fs from 'node:fs/promises';

type Folders=Pick<Preferences,'destinations'|'destinationIds'|'mediaLayout'|'videoDestinations'|'videoDestinationIds'>;
/** One backup folder the user chose and the volume it was on when chosen. */
export interface ChosenFolder {path:string;volumeId:string;role:'photos'|'videos';index:number;}
/** A destination's libraries: its photo folder, and in the video-root layout its video folder. */
export function libraryRoots(prefs:Folders,index:number):string[] {
 const photo=prefs.destinations[index],video=prefs.mediaLayout==='video-root'?prefs.videoDestinations?.[index]:undefined;
 return [...(photo?[photo]:[]),...(photo&&video?[video]:[])];
}
/** Every chosen backup folder with its saved volume, photo folders first. `all` also lists video folders kept while
 * another layout is chosen: a journal may still be in one. */
export function chosenFolders(prefs:Folders,all=false):ChosenFolder[] {
 const photos=prefs.destinations.flatMap((folder,index)=>folder?[{path:folder,volumeId:prefs.destinationIds?.[index]??'',role:'photos' as const,index}]:[]);
 const videos=all||prefs.mediaLayout==='video-root'?(prefs.videoDestinations??[]).flatMap((folder,index)=>folder&&prefs.destinations[index]?[{path:folder,volumeId:prefs.videoDestinationIds?.[index]??'',role:'videos' as const,index}]:[]):[];
 return [...photos,...videos];
}
/** Where a destination's backup is read and organized as one library: its photo folder, or in the video-root layout
 * the nearest folder holding both its photo and video folders. Undefined when the two are on different volumes:
 * files cannot be moved between them. */
export function libraryAnchor(prefs:Folders,index:number):string|undefined {
 const [photo,video]=libraryRoots(prefs,index);
 if(!photo)return undefined;if(!video)return photo;
 if((prefs.destinationIds?.[index]??'')!==(prefs.videoDestinationIds?.[index]??''))return undefined;
 let anchor=path.dirname(path.resolve(photo));
 while(!within(path.resolve(video),anchor)){const parent=path.dirname(anchor);if(parent===anchor)return undefined;anchor=parent;}
 return anchor;
}

/** Validate the destinations a copy policy needs and create their backup folders. `sources`
 * are every connected source (none may hold a destination); `importing`, when given, is the one
 * source being copied, refused before any folder is created if it already lies in the backup.
 * `videoRoots` (video-root layout only) are the video backup folders, by position, each checked
 * against the volume it was chosen on: it may be the photo folder's drive or another. */
export async function destinationRoots(prefs:Preferences,sources:Source[],importing?:Source):Promise<{roots:string[];videoRoots?:string[];infos:DestinationStatus[];videoInfos?:DestinationStatus[];volumes:MountedVolume[]}>{
 const count=requiredDestinations(prefs),chosen=prefs.destinations.slice(0,count);
 if(chosen.length!==count||chosen.some(folder=>!folder))throw new MessageError('error.chooseDestinations');
 checkBackupFolders(prefs,count);
 const video=prefs.mediaLayout==='video-root';
 const volumes=await mountedVolumes(),infos:DestinationStatus[]=[],videoInfos:DestinationStatus[]=[],roots:string[]=[],videoRoots:string[]=[];
 const prepareFolder=async(folder:string,identity:string)=>{
  const info=await validateDestination(folder,sources,{identity,volumes});
  // A folder named by earlier settings may not exist yet: it is made inside the part of it that does.
  const ancestor=await existingAncestor(folder),base=await fs.realpath(ancestor),root=path.resolve(base,path.relative(ancestor,path.resolve(folder)));
  // A backup folder inside a source is fine: planning leaves it out of that source.
  const inside=importing&&sourceInsideBackup(importing.path,[root]);if(inside)throw new MessageError(inside.key,inside.params);
  await makeParent(path.join(root,'.backup-folder-check'),base);if(root!==base)await syncParents(root,base);
  return {info,root};
 };
 for(const [index,folder] of chosen.entries()){
  const photos=await prepareFolder(folder,prefs.destinationIds?.[index]??'');infos.push(photos.info);roots.push(photos.root);
  if(video){const videos=await prepareFolder(prefs.videoDestinations[index]!,prefs.videoDestinationIds?.[index]??'');videoInfos.push(videos.info);videoRoots.push(videos.root);}
 }
 // Two copies of each file: the photo folders, and the video folders, each on two separate disks.
 if(count===2)for(const [first,second] of [infos,...(video?[videoInfos]:[])]){if(!first!.physicalId||!second!.physicalId)throw new MessageError('error.separateDisksUnverified');if(first!.physicalId===second!.physicalId||first!.volumeId===second!.volumeId)throw new MessageError('error.separateDisks');}
 return {roots,...(video?{videoRoots,videoInfos}:{}),infos,volumes};
}
/** A source inside a backup folder has nothing to import: its files are already in the
 * backup. A source that contains a backup folder is fine; planning leaves that folder out. */
export function sourceInsideBackup(source:string,roots:string[]):Message|undefined {
 for(const root of roots)if(within(source,root))return message('error.alreadyInBackup',{source,root});
}
