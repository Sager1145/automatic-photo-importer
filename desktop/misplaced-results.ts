import {within} from './core/paths';
import type {DestinationStatus,MisplacedFiles,Preferences} from './shared';

/** What a folder-check result depends on for one destination: the folder, the rules that place files, and the drive behind it. */
export function misplacedScope(prefs:Preferences,index:number,statuses:DestinationStatus[]|undefined):string{
 const destination=prefs.destinations[index],status=statuses?.find(info=>info.path===destination);
 return JSON.stringify([destination,prefs.destinationIds?.[index],prefs.basePath,prefs.template,prefs.mediaLayout,prefs.videoBasePath,prefs.videoTemplate,prefs.editedFolder,prefs.noMetadataHandling,prefs.noMetadataFolder,status&&[status.path,status.available,status.volumeId]]);
}
/** Destinations whose result was computed for something else now. They are dropped, never re-checked; the prompt returns. */
export function staleMisplaced(results:Record<string,MisplacedFiles>|undefined,prefs:Preferences,statuses:DestinationStatus[]|undefined):string[]{
 return Object.entries(results??{}).filter(([destination,result])=>{
  const index=prefs.destinations.slice(0,2).indexOf(destination);
  return index<0||result.scope!==misplacedScope(prefs,index,statuses);
 }).map(([destination])=>destination);
}
/** Destinations holding any of the library folders a finished job wrote to or organized. */
export function touchedMisplaced(results:Record<string,MisplacedFiles>|undefined,roots:string[]):string[]{
 return Object.keys(results??{}).filter(destination=>roots.some(root=>within(root,destination)));
}
