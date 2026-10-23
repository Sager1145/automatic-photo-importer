import {savedCpuThreads,uvThreadpoolSize} from './resource-limits';

/** libuv's default pool of 4 threads starves file reads and lstat calls behind fsync; measured: 234 MB/s and 3.4 ms lstat
 * at 4 threads against 10.8 GB/s and 0.05 ms at 16. The pool is created on first use, so this must run before anything
 * touches it, so import it before other app modules. It is evaluated first among the bundled modules but after externals (electron, node built-ins), and the QA thread-pool probe guards against regressions. Packaged macOS builds also set it in Info.plist (LSEnvironment).
 * With a saved CPU thread limit the pool is twice that limit (4 to 16: I/O threads mostly wait); without one, 16, and the
 * Info.plist value stays the fallback. A changed limit applies after a restart. */
export const THREADPOOL_SIZE=16;
export function raiseThreadpool(env:NodeJS.ProcessEnv=process.env,maxCpuThreads?:number):void{
 if(maxCpuThreads!==undefined){env.UV_THREADPOOL_SIZE=String(uvThreadpoolSize(maxCpuThreads));return;}
 if(!(Number(env.UV_THREADPOOL_SIZE)>=THREADPOOL_SIZE))env.UV_THREADPOOL_SIZE=String(THREADPOOL_SIZE);
}
/** The saved limit, read from the app's settings before Electron is ready (undefined when none is saved or this is not the app). */
function saved():number|undefined{
 try{
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const {app}=require('electron') as typeof import('electron');
  return app?.getPath?savedCpuThreads(app.getPath('userData')):undefined;
 }catch{return undefined;}
}
raiseThreadpool(process.env,saved());
