import {contextBridge,ipcRenderer} from 'electron';
import type {Action,Metadata} from './shared';
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
 inspect:(path:string):Promise<Metadata>=>ipcRenderer.invoke('importer:inspect',path)
});
