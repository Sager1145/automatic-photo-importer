// Disposable media only. EXIF writes happen before the app starts and before immutability snapshots.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ExifTool} from 'exiftool-vendored';
export async function seedBrowserFixtures(root,repo){
 const folder=path.join(root,'destination','photobackup','browser-fixtures');await fs.mkdir(folder,{recursive:true});
 const jpeg=path.join(root,'fixture-source.jpg');
 await promisify(execFile)('/usr/bin/sips',['-s','format','jpeg',path.join(repo,'Assets','AppIcon-preview.png'),'--out',jpeg]);
 const exiftool=new ExifTool();const files=[];
 try{for(let i=0;i<24;i++){
  const ext=i%2?'jpg':'png',name=`BROWSER_${String(i).padStart(3,'0')}.${ext}`,file=path.join(folder,name);
  await fs.copyFile(ext==='jpg'?jpeg:path.join(repo,'Assets','AppIcon-preview.png'),file);
  await exiftool.write(file,{DateTimeOriginal:`${2023+Math.floor(i/12)}:${String(1+Math.floor(i/4)%3).padStart(2,'0')}:15 12:00:00`,Make:'QA Fixture',Model:i%3?'QA Camera Alpha':'QA Camera Beta',LensModel:'QA Lens 24-70mm',FNumber:i===23?1.8:[2,2.8,4,8][i%4],FocalLength:[24,35,50,70][i%4],ExposureTime:i===23?'1/60':'1/125',ISO:i===23?125:[100,200,400][i%3]},['-overwrite_original']);files.push(file);
 }}finally{await exiftool.end();}
 await fs.writeFile(path.join(root,'browser-fixtures.json'),JSON.stringify({files,fixtureWritesCompletedAt:new Date().toISOString()},null,2));
 await fs.rm(jpeg);
}
