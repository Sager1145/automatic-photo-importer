import {createHmac,randomBytes} from 'node:crypto';
import {keyId} from '../../core/app-store';

/** Another computer using the same drive: its own key, and records sealed with it the way the app seals them. */
export function otherComputer(platform:NodeJS.Platform=process.platform,key=randomBytes(32)){
 const seal=(kind:string,value:Record<string,unknown>)=>{
  const unsigned={v:5,kind,...value};
  return {...unsigned,seal:createHmac('sha256',key).update(`photo-importer:v5:${kind}\n${JSON.stringify(unsigned)}`).digest('hex')};
 };
 const listed={id:keyId(key),platform,key:key.toString('base64')};
 return {key,platform,id:listed.id,seal,
  line:(kind:string,value:Record<string,unknown>)=>JSON.stringify(seal(kind,value)),
  /** store.json as this version writes it on that computer, which sees the base at `base` with `identity`. */
  storeRecord:(base:string,identity:string)=>seal('store',{base,minVersion:'0.3.0',computers:[listed],identities:{[platform]:identity}}),
  /** store.json as an earlier version wrote it there (`baseIdentity` is `dev:ino` as that computer saw the base). */
  legacyStoreRecord:(base:string,baseIdentity:string)=>seal('store',{base,baseIdentity,minVersion:'0.3.0'}),
 };
}
