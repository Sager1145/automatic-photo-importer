import type { Preferences, Source } from './shared';

type Remembered=NonNullable<Preferences['rememberedDevices']>;
type Ignored=NonNullable<Preferences['ignoredDevices']>;

/** A device id that names the same card or camera across connections: the volume
 * UUID or the camera's id. Mount paths are reused by other disks ("Untitled"), and
 * folders are chosen explicitly, so neither is remembered. */
export function deviceId(source:Source):string|undefined {
  if(source.transport==='folder' || !source.id || source.id.startsWith('/') || source.id.startsWith('folder:')) return undefined;
  return source.id;
}

/** Which connected sources the user wants imported. Drives the user has not
 * decided on start deselected and are announced once per connection; ignored
 * drives start deselected silently until the user stops ignoring them. */
export class DeviceSelection {
  private selected=new Map<string,boolean>();
  newDevices:string[]=[];
  apply(sources:Source[],remembered:Remembered,ignored:Ignored={}):Source[] {
    const connected=new Set(sources.map(source=>source.id));
    for(const id of [...this.selected.keys()]) if(!connected.has(id)) this.selected.delete(id);
    this.newDevices=this.newDevices.filter(id=>connected.has(id));
    return sources.map(source=>{
      if(!this.selected.has(source.id)) {
        const device=deviceId(source);
        // A folder exists only because the user picked it.
        const known=source.transport==='folder' || (device!==undefined && device in remembered);
        this.selected.set(source.id,known);
        if(!known && !(device!==undefined && device in ignored)) this.newDevices.push(source.id);
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
  /** Revoke any decision: the device is treated as new on its next connection. */
  forget(device:string,remembered:Remembered,ignored:Ignored={}):void {
    delete remembered[device];delete ignored[device];
    if(this.selected.has(device)) this.selected.set(device,false);
  }
}
