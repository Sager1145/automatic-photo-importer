// Does a file moved to another folder keep its inode on FSKit exFAT, right after and after a remount?
import fs from 'node:fs/promises';import path from 'node:path';import {execFileSync} from 'node:child_process';
const base=process.argv[2],image=path.join(base,'probe.sparseimage'),mount=path.join(base,'mnt');
const sh=(...a)=>execFileSync(a[0],a.slice(1),{stdio:'pipe'}).toString();
await fs.mkdir(mount,{recursive:true});
sh('hdiutil','create','-quiet','-size','64m','-fs','ExFAT','-type','SPARSE','-volname','INODEPROBE',path.join(base,'probe'));
const attach=()=>sh('hdiutil','attach','-quiet','-nobrowse','-mountpoint',mount,image);
const detach=()=>sh('hdiutil','detach','-quiet','-force',mount);
attach();
const results=[];
try{
 console.log(sh('diskutil','info',mount).split('\n').filter(l=>/Personality|Type \(Bundle\)/.test(l)).join('\n'));
 for(const [label,size] of [['small',4096],['large',3*1024*1024],['empty',0]]){
  const a=path.join(mount,label,'a'),b=path.join(mount,label,'b','deep');await fs.mkdir(a,{recursive:true});await fs.mkdir(b,{recursive:true});
  for(let i=0;i<5;i++){const f=path.join(a,`f${i}.bin`);const h=await fs.open(f,'w');await h.write(Buffer.alloc(size,i+1));await h.sync();await h.close();}
  const before={},after={};
  for(let i=0;i<5;i++){const s=await fs.lstat(path.join(a,`f${i}.bin`),{bigint:true});before[i]={ino:String(s.ino),birth:String(s.birthtimeNs),mtime:String(s.mtimeNs),size:String(s.size)};}
  for(let i=0;i<5;i++){await fs.rename(path.join(a,`f${i}.bin`),path.join(b,`f${i}.bin`));const s=await fs.lstat(path.join(b,`f${i}.bin`),{bigint:true});after[i]={ino:String(s.ino),birth:String(s.birthtimeNs),mtime:String(s.mtimeNs),size:String(s.size)};}
  results.push({label,size,before,after});
 }
}finally{detach();}
attach();
try{
 for(const r of results){r.remount={};for(let i=0;i<5;i++){const s=await fs.lstat(path.join(mount,r.label,'b','deep',`f${i}.bin`),{bigint:true});r.remount[i]={ino:String(s.ino),birth:String(s.birthtimeNs),mtime:String(s.mtimeNs),size:String(s.size)};}
  r.inoSameAfterMove=Object.keys(r.before).every(i=>r.before[i].ino===r.after[i].ino);
  r.inoSameAfterRemount=Object.keys(r.before).every(i=>r.before[i].ino===r.remount[i].ino);
  r.birthMtimeSizeSameAfterRemount=Object.keys(r.before).every(i=>['birth','mtime','size'].every(k=>r.before[i][k]===r.remount[i][k]));
  console.log(r.label,'ino same after move:',r.inoSameAfterMove,'after remount:',r.inoSameAfterRemount,'birth/mtime/size same after remount:',r.birthMtimeSizeSameAfterRemount);}
}finally{detach();}
await fs.writeFile(path.join(base,'results.json'),JSON.stringify(results,null,1));
