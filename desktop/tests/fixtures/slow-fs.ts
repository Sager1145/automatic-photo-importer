import filesystem from 'node:fs/promises';

/** Every file-system call waits `ms` first, as on a slow USB drive. Returns the restore function. */
export function slowFileSystem(ms=20):()=>void{
 const target=filesystem as unknown as Record<string,unknown>,restore:(()=>void)[]=[];
 const delay=()=>new Promise<void>(resolve=>setTimeout(resolve,ms));
 const handleMethods=['read','write','writeFile','readFile','stat','sync','close','utimes','truncate','appendFile'];
 for(const name of ['open','readdir','lstat','stat','readFile','realpath','rename','unlink','mkdir','link','rmdir','rm','readlink','writeFile','copyFile','utimes','appendFile','symlink','chmod','access']){
  const original=target[name] as ((...args:unknown[])=>Promise<unknown>)|undefined;if(!original)continue;
  target[name]=async(...args:unknown[])=>{
   await delay();const result=await original.apply(filesystem,args);
   if(name==='open'&&result&&typeof result==='object'){
    // The calls on an open file wait too.
    for(const method of handleMethods){
     const inner=(result as Record<string,unknown>)[method] as ((...args:unknown[])=>Promise<unknown>)|undefined;if(typeof inner!=='function')continue;
     (result as Record<string,unknown>)[method]=async(...rest:unknown[])=>{await delay();return inner.apply(result,rest);};
    }
   }
   return result;
  };
  restore.push(()=>{target[name]=original;});
 }
 return ()=>{for(const undo of restore)undo();};
}

/** Records when a progress callback is heard; `longest()` is the longest wait between two, from the start to the end of the run. */
export function heartbeat(){
 const times:number[]=[performance.now()],labels:string[]=['start'];
 const note=(args:unknown[])=>args.slice(0,3).map(item=>{try{return JSON.stringify(item)?.slice(0,90)??'';}catch{return '';}}).join(' ');
 return {
  beat:(...args:unknown[])=>{times.push(performance.now());labels.push(note(args));},
  finish:()=>{times.push(performance.now());labels.push('end');},
  get beats(){return times.length-2;},
  /** The longest time in seconds with no callback. */
  longest:()=>{let longest=0;for(let index=1;index<times.length;index++)longest=Math.max(longest,(times[index]!-times[index-1]!)/1000);return longest;},
  /** Between which two reports the longest silence was. */
  where:()=>{let at=1;for(let index=1;index<times.length;index++)if(times[index]!-times[index-1]!>times[at]!-times[at-1]!)at=index;return `${labels[at-1]} -> ${labels[at]}`;},
 };
}
