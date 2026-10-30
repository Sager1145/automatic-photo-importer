/** Which file operations accept the name `readdir` returns, for files whose on-disk name is precomposed (NFC), as
 * written by cameras, Windows and most non-Mac tools. Runs only inside a new sandbox folder it removes again.
 * Usage: node --import tsx Scripts/probe-exfat-names.mts /Volumes/NAME */
import fs from 'node:fs/promises';
import path from 'node:path';

const volume=process.argv[2];
if(!volume||!/^\/Volumes\/[^/]+$/.test(volume))throw new Error('Usage: probe-exfat-names.mts /Volumes/NAME');
const sandbox=path.join(volume,`photo-importer-hw-names-${new Date().toISOString().replace(/[:.]/g,'-')}`);
const names=['Éclair.JPG','でんしゃ.JPG','한글.JPG'];
const result:Record<string,Record<string,string>>={};
const attempt=async(label:string,row:Record<string,string>,work:()=>Promise<unknown>)=>{try{await work();row[label]='ok';}catch(error){row[label]=(error as NodeJS.ErrnoException).code??String(error);}};
// Removal that works whatever form the filesystem expects: the listed name first, then its NFC form.
const removeAll=async(dir:string):Promise<void>=>{for(const entry of await fs.readdir(dir,{withFileTypes:true})){const listed=path.join(dir,entry.name),composed=path.join(dir,entry.name.normalize('NFC'));if(entry.isDirectory()){await removeAll(listed).catch(()=>removeAll(composed));await fs.rmdir(listed).catch(()=>fs.rmdir(composed));}else await fs.unlink(listed).catch(()=>fs.unlink(composed));}};

await fs.mkdir(sandbox);
try {
  for(const operation of ['unlink','rename','renameTo','utimes','open','rmdir']){
    const dir=path.join(sandbox,operation);await fs.mkdir(dir);
    for(const name of names){
      const row=result[`${operation} ${name}`]={} as Record<string,string>;
      const nfc=name.normalize('NFC');
      if(operation==='rmdir')await fs.mkdir(path.join(dir,nfc));else await fs.writeFile(path.join(dir,nfc),'x');
      const listed=(await fs.readdir(dir)).find(entry=>entry.normalize('NFC')===nfc)!;
      row.listedForm=listed===listed.normalize('NFD')&&listed!==nfc?'NFD':'NFC';
      for(const [form,file] of [['listed',path.join(dir,listed)],['nfc',path.join(dir,nfc)]] as const){
        if(operation==='unlink')await attempt(form,row,()=>fs.unlink(file));
        if(operation==='rmdir')await attempt(form,row,()=>fs.rmdir(file));
        if(operation==='rename')await attempt(form,row,async()=>{await fs.rename(file,path.join(dir,`moved-${form}`));await fs.rename(path.join(dir,`moved-${form}`),path.join(dir,nfc));});
        if(operation==='renameTo')await attempt(form,row,async()=>{await fs.rename(path.join(dir,nfc),path.join(dir,'tmp'));await fs.rename(path.join(dir,'tmp'),file);await fs.lstat(path.join(dir,nfc));});
        if(operation==='utimes')await attempt(form,row,()=>fs.utimes(file,new Date(),new Date()));
        if(operation==='open')await attempt(form,row,async()=>{const handle=await fs.open(file,'r');await handle.close();});
        if((operation==='unlink'||operation==='rmdir')&&row[form]==='ok'){if(operation==='rmdir')await fs.mkdir(path.join(dir,nfc));else await fs.writeFile(path.join(dir,nfc),'x');}
      }
    }
  }
  console.log(JSON.stringify(result,null,1));
} finally {
  await removeAll(sandbox).catch(error=>console.error('cleanup:',error));
  await fs.rmdir(sandbox).then(()=>console.error('removed',sandbox),error=>console.error('sandbox left:',error));
}
