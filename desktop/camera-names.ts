import {cameraNameRows} from './camera-names-data';

/** EXIF model strings vary in case and spacing between files and firmware ("NIKON Z 6_2", "Nikon Z 6_2"). */
const key=(model:string)=>model.trim().replace(/\s+/g,' ').toLowerCase();
let names:Map<string,string>|undefined;

/** The name a camera or phone is sold under ("ILCE-7M4" → "Sony α7 IV"), or the recorded model when it is not known.
 * For display only: folder names and catalog values keep the recorded model. */
export function cameraDisplayName(model:string):string;
export function cameraDisplayName(model:string|undefined):string|undefined;
export function cameraDisplayName(model:string|undefined):string|undefined{
 if(!model)return model;
 names??=new Map(cameraNameRows.map(([,recorded,name])=>[key(recorded),name]));
 return names.get(key(model))??model;
}
