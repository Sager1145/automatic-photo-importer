import {contextBridge,ipcRenderer} from 'electron';
import type {Action,DuplicateGroup,Metadata,Thumbnail} from './shared';
import type {StateUpdate} from './state-channel';

// Keep the bridge transparent: reconstructing AppState here would copy every
// inventory back across the isolated-world bridge on each progress callback.
contextBridge.exposeInMainWorld('importer',{
 state:():Promise<StateUpdate>=>ipcRenderer.invoke('importer:state'),
 action:async(action:Action):Promise<void>=>{await ipcRenderer.invoke('importer:action',action);},
 subscribe:(listener:(update:StateUpdate)=>void)=>{
  const callback=(_event:Electron.IpcRendererEvent,update:StateUpdate)=>listener(update);
  ipcRenderer.on('importer:updated',callback);
  return()=>ipcRenderer.removeListener('importer:updated',callback);
 },
 thumbnail:(path:string):Promise<Thumbnail>=>ipcRenderer.invoke('importer:thumbnail',path),
 exif:(path:string):Promise<Metadata>=>ipcRenderer.invoke('importer:exif',path),
 duplicateGroups:():Promise<DuplicateGroup[]>=>ipcRenderer.invoke('importer:duplicates'),
 errorPaths:(jobId:string,code:string):Promise<string[]>=>ipcRenderer.invoke('importer:errorPaths',jobId,code)
});
