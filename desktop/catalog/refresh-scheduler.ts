/** Configuration changes must be considered separately from the already-dirty work list. */
export function configuredRefreshIds(previousDirty:readonly string[],currentDirty:readonly string[],changed:readonly string[]):string[]{
 const previous=new Set(previousDirty),changedIds=new Set(changed);return currentDirty.filter(id=>!previous.has(id)||changedIds.has(id));
}
interface Options {idle():boolean;run():Promise<void>;error?(error:unknown):void;schedule?(callback:()=>void):()=>void;}
/** Retains requests received during a running pass; errors and explicit stops do not create requests. */
export function createCatalogRefreshScheduler(options:Options){
 let pending=false,closed=false,cancel:(()=>void)|undefined,task:Promise<void>|undefined;
 const schedule=options.schedule??(callback=>{const timer=setTimeout(callback,1000);return()=>clearTimeout(timer);});
 function resume(){if(closed||!pending||cancel||task)return;cancel=schedule(()=>{cancel=undefined;if(closed||!options.idle())return;pending=false;task=Promise.resolve().then(options.run).catch(error=>options.error?.(error)).finally(()=>{task=undefined;resume();});});}
 return {request(){if(closed)return;pending=true;resume();},resume,settled:()=>task??Promise.resolve(),close(){closed=true;pending=false;cancel?.();cancel=undefined;}};
}
