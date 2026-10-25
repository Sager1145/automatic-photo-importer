import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {getSystemErrorName} from 'node:util';
import {nativeCameraHelperPath} from './camera-bridge';

const failure=(message:string,code='ENOTSUP')=>Object.assign(new Error(message),{code});
/** Rename without ever replacing a destination. The helper receives only basenames and inherited
 * parent/source descriptors: parent replacement cannot redirect it, and it checks the named source
 * against the open source before renameatx_np(RENAME_EXCL). Refusal never becomes a replacing rename. */
export async function exclusiveRename(source:string,destination:string):Promise<void>{
 const executable=await nativeCameraHelperPath();
 if(process.platform!=='darwin'||!executable)throw failure('Exclusive filesystem rename requires the macOS native helper');
 const handles:fs.FileHandle[]=[];
 try{
  for(const folder of [path.dirname(source),path.dirname(destination)]){
   const handle=await fs.open(folder,constants.O_RDONLY|constants.O_DIRECTORY|(constants.O_NOFOLLOW??0));handles.push(handle);
   const own=await handle.stat({bigint:true}),named=await fs.lstat(folder,{bigint:true});
   if(!own.isDirectory()||!named.isDirectory()||own.dev!==named.dev||own.ino!==named.ino)throw failure('Rename parent changed','ESTALE');
  }
  const input=await fs.open(source,constants.O_RDONLY|(constants.O_NOFOLLOW??0));handles.push(input);
  if(!(await input.stat()).isFile())throw failure('Exclusive rename requires a regular source','EINVAL');
  await new Promise<void>((resolve,reject)=>{
   const child=spawn(executable,['--rename-exclusive',path.basename(source),path.basename(destination)],{stdio:['ignore','pipe','pipe',...handles.map(handle=>handle.fd)],windowsHide:true,timeout:10000});
   let stdout='',stderr='';
   child.stdout!.on('data',data=>{stdout=(stdout+data.toString()).slice(-4096);});
   child.stderr!.on('data',data=>{stderr=(stderr+data.toString()).slice(-4096);});
   child.on('error',reject);
   child.on('close',status=>{
    if(status===0){
     try{if(JSON.parse(stdout).renamed===true){resolve();return;}}catch{}
     reject(failure('The native helper does not support exclusive rename'));return;
    }
    let code='EIO';try{const {errno}=JSON.parse(stdout);if(Number.isInteger(errno)&&errno>0)code=getSystemErrorName(-errno);}catch{}
    reject(failure(stderr.trim()||'Exclusive filesystem rename failed',code));
   });
  });
 }finally{await Promise.all(handles.map(handle=>handle.close()));}
}
