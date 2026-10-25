import type { DriveCameraRecord, Preferences, Source } from './shared';

type Remembered=NonNullable<Preferences['rememberedDevices']>;
type Ignored=NonNullable<Preferences['ignoredDevices']>;
type History=NonNullable<Preferences['deviceHistory']>;

/** A device id that names the same card or camera across connections: the volume UUID
 * (a volume without one has its mount path as its id) or `camera:<id>`. Mount paths are
 * reused by other disks ("Untitled"), and folders are chosen explicitly, so neither is
 * remembered. */
export function deviceId(source:Source):string|undefined {
  if(source.transport==='camera') return source.id;
  return source.transport==='storage' && source.id && source.id!==source.path ? source.id : undefined;
}
/** Keys saved before device ids were UUIDs only: a mount path, drive letter, /dev node or diskN
 * identifier. They are dropped when settings are read rather than matched against forever. */
const savedByPath=/^(?:\/|[a-z]:[\\/]?$|disk\d|folder:|filesystem:)/i;
export function stableDevices<T>(records:Record<string,T>):Record<string,T> {
  return Object.fromEntries(Object.entries(records).filter(([key])=>!savedByPath.test(key)));
}

/** Which connected sources the user wants imported. Drives the user has not
 * decided on start deselected and are announced once per connection; ignored
 * drives start deselected silently until the user stops ignoring them. */
export class DeviceSelection {
  private selected=new Map<string,boolean>();
  newDevices:string[]=[];
  /** Connected devices seen before (remembered, or with a finished scan or import), announced once per connection. */
  reconnectedDevices:string[]=[];
  apply(sources:Source[],remembered:Remembered,ignored:Ignored={},history:History={}):Source[] {
    const connected=new Set(sources.map(source=>source.id));
    for(const id of [...this.selected.keys()]) if(!connected.has(id)) this.selected.delete(id);
    this.newDevices=this.newDevices.filter(id=>connected.has(id));
    this.reconnectedDevices=this.reconnectedDevices.filter(id=>connected.has(id));
    return sources.map(source=>{
      if(!this.selected.has(source.id)) {
        const device=deviceId(source);
        // A folder exists only because the user picked it.
        const known=source.transport==='folder' || (device!==undefined && device in remembered);
        this.selected.set(source.id,known);
        if(!known && !(device!==undefined && device in ignored)) this.newDevices.push(source.id);
        if(device!==undefined && (device in remembered || device in history)) this.reconnectedDevices.push(source.id);
      }
      return {...source,selected:this.selected.get(source.id)!};
    });
  }
  select(source:Source,selected:boolean,remembered:Remembered,now:string,ignored:Ignored={}):void {
    this.selected.set(source.id,selected);
    this.newDevices=this.newDevices.filter(id=>id!==source.id);
    const device=deviceId(source);
    if(device===undefined) return;
    if(selected) {remembered[device]={name:source.name,lastSelected:now};delete ignored[device];}
    else {delete remembered[device];ignored[device]={name:source.name,ignoredAt:now};}
  }
  /** A chosen folder the system now detects as a volume at the same path keeps the user's choice under the volume's id. */
  replace(from:string,to:string):void {
    const selected=this.selected.get(from);
    if(selected===undefined) return;
    this.selected.delete(from);this.selected.set(to,selected);
  }
  /** A source removed from the app (a folder, or an ejected drive) leaves every list at once. */
  drop(id:string):void {
    this.selected.delete(id);
    this.newDevices=this.newDevices.filter(item=>item!==id);
    this.reconnectedDevices=this.reconnectedDevices.filter(item=>item!==id);
  }
  /** The user saw the reconnection notice for one device, or for all of them. */
  dismissReconnected(id?:string):void {this.reconnectedDevices=id===undefined?[]:this.reconnectedDevices.filter(item=>item!==id);}
  /** Revoke any decision: the device is treated as new on its next connection. */
  forget(device:string,remembered:Remembered,ignored:Ignored={}):void {
    delete remembered[device];delete ignored[device];
    if(this.selected.has(device)) this.selected.set(device,false);
  }
}

/** Note a finished read-only scan or a verified import (including one that found everything
 * already imported) for a device that can be recognised again, with the cameras a scan read.
 * Folders are not recorded. */
export function recordDeviceHistory(history:History,source:Source,event:'scan'|'import',now:string,cameras?:DriveCameraRecord):void {
  const device=deviceId(source);
  if(device===undefined) return;
  const entry=history[device]={...history[device],name:source.name};
  if(event==='import') {entry.lastImportVerified=now;return;}
  // A scan replaces the remembered cameras, so an older scan's cameras are never shown as current.
  entry.lastScanCompleted=now;
  if(cameras) entry.cameras=cameras; else delete entry.cameras;
}
