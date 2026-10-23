/** libuv's default pool of 4 threads starves file reads and lstat calls behind fsync; measured: 234 MB/s and 3.4 ms lstat
 * at 4 threads against 10.8 GB/s and 0.05 ms at 16. The pool is created on first use, so this must run before anything
 * touches it, so import it before other app modules. It is evaluated first among the bundled modules but after externals (electron, node built-ins), and the QA thread-pool probe guards against regressions. Packaged macOS builds also set it in Info.plist (LSEnvironment). */
export const THREADPOOL_SIZE=16;
export function raiseThreadpool(env:NodeJS.ProcessEnv=process.env):void{
 if(!(Number(env.UV_THREADPOOL_SIZE)>=THREADPOOL_SIZE))env.UV_THREADPOOL_SIZE=String(THREADPOOL_SIZE);
}
raiseThreadpool();
