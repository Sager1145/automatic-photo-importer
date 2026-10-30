// READ-ONLY QA of the real UI against mounted external drives (npm run codex:test -- --real-drives=/Volumes/X:folder).
// It browses the Library page, opens previews and EXIF of real files and compares them with the metadata read in the
// main process. Nothing is imported, organized, deleted or written on the drives: a witness (stat of the volume root
// entries, of every entry under "Photo Importer Data" and sha256 + stat of sampled media) is taken first and re-checked
// at the end, also when the check failed; any difference fails the check. The catalog database lives in app userData.
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {APP_DATA_FOLDER} from '../../../core/legacy-names';
import {mediaKindForPath} from '../../../media-formats';
import {metadata} from '../../../platform/metadata';
import {mountedVolumes,volumeInfo,volumeOf} from '../../../platform/volumes';
import {formatCaptureDateTime} from '../../../renderer/metadata-display';
import type {CatalogLibrary,CatalogPage,CatalogQuery,CatalogStatus,FacetResult} from '../../../catalog/types';
import type {Action,Metadata,Preferences} from '../../../shared';
import type {Check,Harness} from '../harness';
import type {Context} from './context';

export interface RealDrive {destination:string;basePath:string}
export function parseRealDrives(text:string|undefined):RealDrive[]|undefined{
 if(!text)return undefined;
 const list=JSON.parse(text) as RealDrive[];
 if(!Array.isArray(list)||!list.length||list.some(item=>typeof item?.destination!=='string'||typeof item.basePath!=='string'))throw new Error('--codex-real-drives needs a JSON list of {destination,basePath}');
 return list;
}

const say=(message:string)=>console.log(`[real-drives] ${message}`);
const nfc=(text:string)=>text.normalize('NFC');
const nonAscii=/[^\x00-\x7f]/;
/** The macOS volume-root housekeeping the OS itself may touch while a drive is mounted; reported but not a failure. */
const systemNoise=/^\.(Spotlight-V100|fseventsd|Trashes|TemporaryItems|DocumentRevisions-V100|DS_Store|PKInstallSandboxManager.*|apdisk|VolumeIcon\.icns|com\.apple\..*)$/;

/* ---------------------------------------------------------------- safety: the witness */
interface Stamp {type:string;size:string;mtimeNs:string;ctimeNs:string;ino:string}
interface Witness {root:Record<string,Stamp>;data:Record<string,Stamp>|'absent';samples:Record<string,{stamp:Stamp;sha256:string}>}
async function stamp(file:string):Promise<Stamp>{
 const s=await fs.lstat(file,{bigint:true});
 // exFAT names an empty file by a temporary negative inode that macOS reassigns on its own (measured on A006), so such an
 // entry is identified by its birth time instead, as the app's own identity rule does; every other entry keeps its exact inode.
 return {type:s.isDirectory()?'dir':s.isSymbolicLink()?'link':s.isFile()?'file':'other',size:String(s.size),mtimeNs:String(s.mtimeNs),ctimeNs:String(s.ctimeNs),ino:s.ino<0n?`birth ${s.birthtimeNs}`:String(s.ino)};
}
const sha256=(file:string)=>new Promise<string>((resolve,reject)=>{const hash=createHash('sha256');createReadStream(file).on('data',chunk=>hash.update(chunk)).on('end',()=>resolve(hash.digest('hex'))).on('error',reject);});
async function treeStamps(dir:string):Promise<Record<string,Stamp>|'absent'>{
 try{await fs.lstat(dir);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 'absent';throw error;}
 const out:Record<string,Stamp>={};
 const walk=async(current:string):Promise<void>=>{out[current]=await stamp(current);for(const entry of await fs.readdir(current,{withFileTypes:true})){const file=path.join(current,entry.name);if(entry.isDirectory())await walk(file);else out[file]=await stamp(file);}};
 await walk(dir);return out;
}
async function takeWitness(volume:string,samples:string[]):Promise<Witness>{
 const root:Record<string,Stamp>={};
 for(const name of await fs.readdir(volume))root[name]=await stamp(path.join(volume,name));
 const data=await treeStamps(path.join(volume,APP_DATA_FOLDER));
 const sampled:Witness['samples']={};
 for(const file of samples)sampled[file]={stamp:await stamp(file),sha256:await sha256(file)};
 return {root,data,samples:sampled};
}
function differences(before:Witness,after:Witness):{failures:string[];ignored:string[]}{
 const failures:string[]=[],ignored:string[]=[];
 const compare=(label:string,a:Record<string,unknown>,b:Record<string,unknown>,tolerate=(_key:string)=>false)=>{
  for(const key of new Set([...Object.keys(a),...Object.keys(b)])){
   if(JSON.stringify(a[key])===JSON.stringify(b[key]))continue;
   const what=!a[key]?'appeared':!b[key]?'disappeared':'changed';
   (tolerate(key)?ignored:failures).push(`${label}: ${key} ${what}${a[key]&&b[key]?` ${JSON.stringify(a[key])} -> ${JSON.stringify(b[key])}`:''}`);
  }
 };
 compare('volume root entry',before.root,after.root,key=>systemNoise.test(key));
 if(before.data==='absent'||after.data==='absent'){if(before.data!==after.data)failures.push(`"${APP_DATA_FOLDER}" ${before.data==='absent'?'appeared':'disappeared'}`);}
 else compare(APP_DATA_FOLDER,before.data,after.data);
 compare('sampled media',before.samples,after.samples);
 return {failures,ignored};
}

/* ---------------------------------------------------------------- the library on disk */
interface MediaFile {rel:string;kind:string}
interface Listing {media:MediaFile[];files:number}
/** Every file below the library root as the catalog would see it (no hidden/AppleDouble names, no "Drive backups"). Read-only. */
async function list(root:string):Promise<Listing>{
 const media:MediaFile[]=[];let files=0,last=Date.now();const stack=[root];
 while(stack.length){
  const dir=stack.pop()!;
  for(const entry of await fs.readdir(dir,{withFileTypes:true})){
   if(entry.name.startsWith('.'))continue;
   const file=path.join(dir,entry.name);
   if(entry.isDirectory()){if(entry.name!=='Drive backups')stack.push(file);}
   else if(entry.isFile()){files++;const kind=mediaKindForPath(entry.name);if(kind!=='Other')media.push({rel:path.relative(root,file).split(path.sep).join('/'),kind});}
  }
  if(Date.now()-last>=30000){last=Date.now();say(`listing ${root}: ${files} files, ${media.length} media so far`);}
 }
 media.sort((a,b)=>a.rel<b.rel?-1:1);
 return {media,files};
}
/** Candidates spread over the list (golden-ratio stepping), each at most `limit` bytes. */
async function pick(root:string,items:MediaFile[],count:number,exclude:Set<string>,limit=200*1024*1024):Promise<MediaFile[]>{
 const out:MediaFile[]=[],seen=new Set<number>();
 for(let step=0;step<Math.min(items.length*2,400)&&out.length<count&&seen.size<items.length;step++){
  const index=Math.floor((((step+.5)*.6180339887)%1)*items.length);
  if(seen.has(index))continue;seen.add(index);
  const item=items[index]!;if(exclude.has(item.rel))continue;
  const size=(await fs.lstat(path.join(root,item.rel)).catch(()=>undefined))?.size;if(size===undefined||size>limit||size===0)continue;
  out.push(item);exclude.add(item.rel);
 }
 return out;
}
async function chooseFiles(root:string,media:MediaFile[]){
 const used=new Set<string>(),opened:{file:MediaFile;why:string}[]=[];
 const add=async(why:string,items:MediaFile[],count=1)=>{for(const file of await pick(root,items,count,used))opened.push({file,why});};
 const of=(kind:string)=>media.filter(m=>m.kind===kind);
 await add('JPEG',of('JPEG'));await add('HEIC',of('HEIF'));await add('RAW',of('RAW'));await add('video',of('Videos'),1);
 await add('non-ASCII path',media.filter(m=>nonAscii.test(m.rel)),2);
 const tops=[...new Set(of('JPEG').map(m=>m.rel.split('/')[0]!))];
 for(const top of tops.slice(0,6))if(opened.length<9)await add(`JPEG in ${top}`,of('JPEG').filter(m=>m.rel.split('/')[0]===top));
 if(opened.length<6)await add('any media',media,6-opened.length);
 // Witness sample: everything opened, plus a spread of the library, about 20 files in all.
 const sample=new Set(opened.map(item=>item.file.rel));
 for(const file of await pick(root,media,Math.max(0,20-sample.size),used))sample.add(file.rel);
 return {opened,sample:[...sample]};
}

/* ---------------------------------------------------------------- UI helpers */
const ipc=<T>(h:Harness,method:string,...args:unknown[])=>h.js<T>(`window.importer.${method}(...${JSON.stringify(args)})`);
const forbiddenClick=/start|organi[sz]|check|remove|delete|clean|eject|import|apply|file manager|refresh index|stop indexing|retry/i;
const setValue=(h:Harness,selector:string,value:string)=>h.js<boolean>(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;const proto=e instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}));return true;})()`);
const buttonByText=(h:Harness,text:string)=>h.js<boolean>(`(()=>{const e=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)});e?.click();return !!e;})()`);
interface Row {key:string;label:string;count:number|null}
const rowsOf=(h:Harness,column:string)=>h.js<Row[]>(`Array.from(document.querySelectorAll(${JSON.stringify(column+' [role=option]')})).map(e=>({key:e.getAttribute('data-row-key'),label:e.querySelector('span')?.textContent?.trim()??'',count:e.querySelector('small')?Number(e.querySelector('small').textContent.replace(/[^0-9]/g,'')):null}))`);
const clickRow=(h:Harness,column:string,key:string)=>h.js<boolean>(`(()=>{const e=Array.from(document.querySelectorAll(${JSON.stringify(column+' [role=option]')})).find(e=>e.getAttribute('data-row-key')===${JSON.stringify(key)});e?.click();return !!e;})()`);
const filesColumn='[data-testid=browser-files]';
const filesTotal=(h:Harness)=>h.js<number>(`Number(document.querySelector('${filesColumn} header small')?.textContent.replace(/[^0-9]/g,'')??-1)`);
const filesBusy=(h:Harness)=>h.js<boolean>(`document.querySelector('${filesColumn} [role=listbox]')?.getAttribute('aria-busy')!=='false'`);

interface Timings {[name:string]:unknown}

async function enterBrowser(h:Harness,library:CatalogLibrary){
 if(!await h.click('.nav-item[data-page="browser"]'))throw new Error('No Library browser navigation item');
 await h.until('Library browser page',"document.querySelector('[data-testid=library-browser]')");await h.settle();
 await h.js(`(()=>{if(!window.__realClickRecorder){window.__realClickRecorder=true;document.addEventListener('click',e=>{const b=e.target?.closest?.('button,[role=button],a');if(b&&!b.closest('.nav-item'))(window.__realClicks??=[]).push((b.getAttribute('aria-label')||b.textContent||'').trim().slice(0,80));},true);}document.querySelector('[data-testid=browser-presets]').open=true;})()`);
 h.notes.__realClicks=1;h.notes.__realClickRecorder=1;
 await h.waitFor('library selected in the browser',async()=>{await setValue(h,'.browser-toolbar select[aria-label=Library]',library.libraryId);return h.js<boolean>(`document.querySelector('.browser-toolbar select[aria-label=Library]')?.value===${JSON.stringify(library.libraryId)}`);},{interval:200});
 await h.settle();
}

/** One facet column: choose its preset, time until its rows show, select the biggest row and check the Files count equals the row's. */
async function facetStep(h:Harness,shot:(name:string)=>Promise<void>,library:CatalogLibrary,kind:'camera'|'date'|'format',field:'camera'|'captureYear'|'format',out:Timings){
 const column='[data-testid=facet-column][data-column-index="0"]';
 if(await h.js<boolean>("!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Clear all')"))await buttonByText(h,'Clear all');
 await h.js<void>("document.querySelector('[data-testid=browser-presets]').open=true");
 const started=performance.now();
 if(!await h.click(`[data-preset-id="builtin-${kind}"]`))throw new Error(`No preset builtin-${kind}`);
 await h.waitFor(`${kind} facet rows`,async()=>(await h.js<boolean>(`(()=>{const c=document.querySelector('${column}');return !!c&&c.querySelector('h3')?.textContent.toLowerCase().includes(${JSON.stringify(kind)})&&c.querySelector('[role=listbox]')?.getAttribute('aria-busy')==='false'&&!!c.querySelector('[role=option]');})()`)),{timeoutMs:60000,interval:25,seen:()=>rowsOf(h,column)});
 const uiMs=Math.round(performance.now()-started);
 const rows=(await rowsOf(h,column)).filter(r=>r.key!=='missing');
 const query:CatalogQuery={libraryId:library.libraryId,filters:[],sort:{field:'name',direction:'asc'},limit:200};
 const ipcStart=performance.now();const facets=await ipc<FacetResult>(h,'catalogFacets',query,field);const ipcMs=Math.round(performance.now()-ipcStart);
 await shot(`facet-${kind}`);
 // A library with no value for this field (screenshots and graphics have no camera) shows no rows; that is right only when
 // the catalog itself knows no value and counts every file as missing one.
 if(!rows.length){
  if(facets.total!==0||!facets.missingCount)throw new Error(`${kind} facet shows no rows but the catalog reports ${facets.total} values (${facets.knownCount} known, ${facets.missingCount} missing)`);
  out[`facet-${kind}`]={uiRowsMs:uiMs,catalogFacetsIpcMs:ipcMs,distinctValues:0,known:facets.knownCount,missing:facets.missingCount,renderedRows:0};
  say(`facet ${kind}: no values in this library (${facets.missingCount} files without one), as the catalog reports`);return;
 }
 const best=rows.filter(r=>r.count!==null).sort((a,b)=>b.count!-a.count!)[0];
 if(!best)throw new Error(`${kind} facet rows carry no counts: ${JSON.stringify(rows.slice(0,5))}`);
 if(!await clickRow(h,column,best.key))throw new Error(`Could not click ${kind} row ${best.label}`);
 await h.waitFor(`Files count equals the ${kind} row "${best.label}" (${best.count})`,async()=>!(await filesBusy(h))&&await filesTotal(h)===best.count,{timeoutMs:90000,interval:100,seen:async()=>({files:await filesTotal(h),row:best})});
 await shot(`facet-${kind}-selected`);
 out[`facet-${kind}`]={uiRowsMs:uiMs,catalogFacetsIpcMs:ipcMs,distinctValues:facets.total,known:facets.knownCount,missing:facets.missingCount,renderedRows:rows.length,selected:best,filesAfterSelection:best.count};
 say(`facet ${kind}: rows after ${uiMs} ms (IPC ${ipcMs} ms), ${facets.total} values; "${best.label}" -> ${best.count} files`);
}

interface Target {rel:string;name:string;why:string}
/** Compares the preview panel's text with the metadata read in main. */
function mismatches(truth:Metadata,seen:{details:Record<string,string>},language='en'):string[]{
 const bad:string[]=[],d=seen.details;
 if(truth.camera&&d.Camera!==truth.camera)bad.push(`Camera "${d.Camera??'(none)'}" != "${truth.camera}"`);
 if(truth.date){const f=formatCaptureDateTime(truth.date,language as 'en'),text=[f.date,f.time,f.timezone].filter(Boolean).join(' ');if(d.Date!==text)bad.push(`Date "${d.Date??'(none)'}" != "${text}" (${truth.date})`);}
 const number=(text?:string)=>{if(!text)return NaN;const m=text.match(/^1\/(\d+(?:\.\d+)?)/);if(m)return 1/Number(m[1]);const n=text.match(/-?\d+(?:\.\d+)?/);return n?Number(n[0]):NaN;};
 const near=(shown:string|undefined,wanted:number|undefined,label:string)=>{if(wanted===undefined||!(wanted>0))return;const n=number(shown);if(!(Math.abs(n-wanted)/wanted<=.01))bad.push(`${label} "${shown??'(none)'}" != ${wanted}`);};
 near(d.Aperture,truth.exposure?.aperture,'Aperture');near(d.ISO,truth.exposure?.iso,'ISO');near(d['Shutter speed'],truth.exposure?.exposureTime,'Shutter');near(d['Focal length'],truth.exposure?.focalLength,'Focal length');
 if(truth.exposure?.lens?.trim()&&d.Lens!==truth.exposure.lens.trim())bad.push(`Lens "${d.Lens??'(none)'}" != "${truth.exposure.lens.trim()}"`);
 return bad;
}
const previewSnapshot=(h:Harness)=>h.js<{title:string;img:{complete:boolean;width:number;height:number}|null;details:Record<string,string>;alert:string;placeholder:string}>(`(()=>{const p=document.querySelector('[data-testid=browser-preview]');if(!p)return {title:'',img:null,details:{},alert:'',placeholder:''};const i=p.querySelector('.browser-photo img');const details={};for(const row of p.querySelectorAll('.browser-file-details > div'))details[row.querySelector('dt')?.textContent??'']=row.querySelector('dd')?.textContent??'';return {title:p.querySelector('h3')?.textContent??'',img:i?{complete:i.complete,width:i.naturalWidth,height:i.naturalHeight}:null,details,alert:p.querySelector('[role=alert]')?.textContent??'',placeholder:p.querySelector('.browser-photo p')?.textContent??''};})()`);

async function openFile(h:Harness,shot:(name:string)=>Promise<void>,library:CatalogLibrary,root:string,target:Target,index:number,out:Timings[]){
 const abs=path.join(root,target.rel),kind=mediaKindForPath(target.name);
 const record:Timings={file:target.rel,why:target.why,kind};out.push(record);
 const truth=await metadata(abs);record.truth={camera:truth.camera,date:truth.date,exposure:truth.exposure};
 // Find the row exactly as the browser lists it: search by the full name, sorted by name.
 const query:CatalogQuery={libraryId:library.libraryId,filters:[],nameContains:target.name,sort:{field:'name',direction:'asc'},limit:200};
 const page=await ipc<CatalogPage>(h,'catalogQuery',query);
 const position=page.rows.findIndex(row=>nfc(row.relativePath)===nfc(target.rel));
 if(position<0)throw new Error(`${target.rel} is not in the catalog (search "${target.name}" found ${page.total} files: ${page.rows.slice(0,5).map(r=>r.relativePath).join(', ')})`);
 const row=page.rows[position]!;record.catalogRow={fileId:row.fileId,metadataStatus:row.metadataStatus,values:row.values};
 await setValue(h,'.browser-search input',target.name);
 await h.waitFor(`Files list shows ${page.total} match(es) of "${target.name}"`,async()=>!(await filesBusy(h))&&await filesTotal(h)===page.total,{timeoutMs:60000,interval:100,seen:async()=>({files:await filesTotal(h),wanted:page.total})});
 if(index===0)await shot('search');
 await h.js<void>(`document.querySelector('${filesColumn} .browser-virtual-list').scrollTop=${Math.max(0,position*48-96)}`);
 const rowSelector=`${filesColumn} [role=option]`;
 await h.waitFor(`row of ${target.rel} rendered`,()=>clickable(h,rowSelector,row.fileId),{timeoutMs:20000,interval:50});
 const started=performance.now();
 await h.waitFor(`preview panel of ${target.name}`,async()=>(await previewSnapshot(h)).title===row.name,{timeoutMs:30000,interval:25});
 const expectImage=['JPEG','HEIF','RAW'].includes(kind);let last=await previewSnapshot(h),imageMs:number|undefined,metaMs:number|undefined;
 await h.waitFor(`preview and EXIF of ${target.rel}`,async()=>{
  last=await previewSnapshot(h);
  if(imageMs===undefined&&last.img?.complete&&last.img.width>0)imageMs=Math.round(performance.now()-started);
  const bad=mismatches(truth,last);
  if(metaMs===undefined&&!bad.length&&last.details.Format)metaMs=Math.round(performance.now()-started);
  return (!expectImage||imageMs!==undefined)&&metaMs!==undefined;
 },{timeoutMs:90000,interval:50,seen:async()=>({snapshot:last,mismatches:mismatches(truth,last),expectImage})});
 // Decoding really succeeds, not only complete: img.decode() resolves.
 const decoded=last.img?await h.js<boolean>("(()=>{const i=document.querySelector('[data-testid=browser-preview] .browser-photo img');return i?i.decode().then(()=>i.naturalWidth>0,()=>false):false;})()"):false;
 if(expectImage&&!decoded)throw new Error(`${target.rel}: the preview <img> did not decode`);
 record.preview={imageRendered:!!last.img,decoded,naturalWidth:last.img?.width,naturalHeight:last.img?.height,imageMs,placeholder:last.placeholder||undefined,expectedImage:expectImage};
 record.exif={shown:last.details,metaMs,mismatches:mismatches(truth,last)};
 // The EXIF dialog: Full EXIF reads every tag of the file in main and lists them; the camera must agree with the truth.
 await h.waitFor('Full EXIF enabled',()=>h.js<boolean>("(()=>{const b=Array.from(document.querySelectorAll('[data-testid=browser-preview] button')).find(b=>b.textContent.trim()==='Full EXIF');return !!b&&!b.disabled;})()"),{timeoutMs:30000});
 const exifStart=performance.now();
 await buttonByText(h,'Full EXIF');
 await h.waitFor('full EXIF list',()=>h.js<boolean>("!!document.querySelector('[data-testid=browser-preview] .browser-full-exif dl div')"),{timeoutMs:60000,interval:50});
 const full=await ipc<{fields?:Record<string,unknown>;camera?:string}>(h,'exif',abs);
 const fieldCount=Object.keys(full.fields??{}).length;
 if(!fieldCount)throw new Error(`${target.rel}: Full EXIF lists no tags`);
 if(truth.camera&&full.camera!==truth.camera)throw new Error(`${target.rel}: Full EXIF camera "${full.camera}" != "${truth.camera}"`);
 record.fullExif={fieldCount,camera:full.camera,ms:Math.round(performance.now()-exifStart)};
 await shot(`file-${String(index+1).padStart(2,'0')}-${kind.toLowerCase()}`);
 if(last.details.Format===undefined)throw new Error(`${target.rel}: no Format row in the preview panel`);
 const bad=mismatches(truth,last);if(bad.length)throw new Error(`${target.rel}: preview EXIF differs from metadata(): ${bad.join('; ')}`);
 say(`opened ${target.rel} (${target.why}): image ${decoded?`${last.img!.width}x${last.img!.height} in ${imageMs} ms`:'none'}, EXIF ok in ${metaMs} ms, camera "${truth.camera??'-'}"`);
 await h.js<void>("document.querySelector('[data-testid=browser-preview] button[aria-label=\"Close preview\"]')?.click()");
}
const clickable=(h:Harness,selector:string,key:string)=>h.js<boolean>(`(()=>{const e=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e=>e.getAttribute('data-row-key')===${JSON.stringify(key)});if(!e)return false;e.click();return true;})()`);

/* ---------------------------------------------------------------- the check */
async function realDriveRun(h:Harness,drive:RealDrive,ordinal:number){
 // 1. Safety first: nothing below runs for a path that is not a plain mounted volume.
 const volume=drive.destination;
 if(!/^\/Volumes\/[^/]+$/.test(volume))throw new Error(`Refusing ${volume}: only ^/Volumes/[^/]+$ is accepted`);
 if(!drive.basePath||path.isAbsolute(drive.basePath)||drive.basePath.split(/[\\/]/).includes('..')||drive.basePath==='.')throw new Error(`Refusing base path "${drive.basePath}": it must be a folder name inside the volume`);
 const link=await fs.lstat(volume);
 if(!link.isDirectory()||link.isSymbolicLink()||await fs.realpath(volume)!==volume)throw new Error(`Refusing ${volume}: it is a symlink, not a mounted volume`);
 const mounts=await mountedVolumes();if(volumeOf(mounts,volume)?.path!==volume)throw new Error(`Refusing ${volume}: not a mount point`);
 const entries=await fs.readdir(volume);const base=entries.find(name=>name===drive.basePath)??entries.find(name=>nfc(name)===nfc(drive.basePath));
 if(!base)throw new Error(`${volume} has no folder "${drive.basePath}"`);
 if(base===APP_DATA_FOLDER)throw new Error(`Refusing ${APP_DATA_FOLDER} as a library`);
 const root=path.join(volume,base);if(!(await fs.lstat(root)).isDirectory())throw new Error(`${root} is not a folder`);
 const label=path.basename(volume).replace(/[^A-Za-z0-9._-]/g,'_')||`drive${ordinal}`;
 const outDir=path.join(h.report,'real-drives',label);await fs.mkdir(outDir,{recursive:true});
 let step=0;const shot=async(name:string)=>{step++;await h.settle();await h.capture(path.join(outDir,`${String(step).padStart(2,'0')}-${name.replace(/[^A-Za-z0-9._-]/g,'_')}.png`));};
 const results:Record<string,unknown>={volume,basePath:base,startedAt:new Date().toISOString()};
 const timings:Timings={};results.timings=timings;
 const save=()=>fs.writeFile(path.join(outDir,'results.json'),JSON.stringify(results,null,2));

 // 2. What is on the drive, then the witness over everything this run will read.
 say(`${label}: listing ${root}`);const listStarted=Date.now();
 const listing=await list(root);timings.nodeListMs=Date.now()-listStarted;
 say(`${label}: ${listing.media.length} media files of ${listing.files} files in ${((Date.now()-listStarted)/1000).toFixed(0)} s`);
 results.node={mediaFiles:listing.media.length,allFiles:listing.files,byKind:Object.fromEntries([...new Set(listing.media.map(m=>m.kind))].map(k=>[k,listing.media.filter(m=>m.kind===k).length]))};
 if(listing.media.length<5)throw new Error(`${root} holds only ${listing.media.length} media files; at least 5 are needed to open`);
 const chosen=await chooseFiles(root,listing.media);
 if(chosen.opened.length<5)throw new Error(`Only ${chosen.opened.length} readable media files found to open`);
 const witnessFiles=chosen.sample.map(rel=>path.join(root,rel));
 const before=await takeWitness(volume,witnessFiles);
 await fs.writeFile(path.join(outDir,'witness-before.json'),JSON.stringify(before,null,1));
 say(`${label}: witness taken (${Object.keys(before.root).length} root entries, ${before.data==='absent'?'no':Object.keys(before.data).length} "${APP_DATA_FOLDER}" entries, ${witnessFiles.length} sampled files)`);

 // 3. From here on the drive is in use: whatever happens, the witness is checked again.
 const hooks=h.hooks!;
 const original=structuredClone(h.hooks!.peek().preferences);
 const blocked:string[]=[];let failure:unknown;
 try{
  const allowedTypes=new Set<Action['type']>(['preferences','catalogRefresh','catalogStop','refresh','stop','discardReview']);
  const harmless=new Set(['language','textScale','sourceLayout','appearance','showDashboard']);
  hooks.beforeAction=action=>{
   if(action.type==='preferences'&&Object.keys(action.patch).every(key=>harmless.has(key)))return;
   if(action.type!=='preferences'&&allowedTypes.has(action.type))return;
   blocked.push(action.type);return false;
  };
  const info=await volumeInfo(volume);if(!info.available||!info.volumeId)throw new Error(`${volume} cannot be identified: ${info.detail}`);
  hooks.mutate(state=>{state.preferences={...state.preferences,destinations:[volume],destinationIds:[info.volumeId!],basePath:base,copyMode:'single',automatic:false,mediaLayout:'flat'} as Preferences;});
  results.configured={destination:volume,volumeId:info.volumeId,basePath:base,copyMode:'single',automatic:false,mediaLayout:'flat'};
  await h.action({type:'refresh'});
  let library!:CatalogLibrary;const registered=Date.now();
  await h.waitFor(`library ${base} registered and online`,async()=>{
   const s=await h.state();
   library=s.catalogLibraries?.find(l=>l.role==='photos'&&l.online&&l.volumeId===info.volumeId&&nfc(l.relativeRoot)===nfc(base))!;
   return !!library;
  },{timeoutMs:60000,interval:500,seen:async()=>(await h.state()).catalogLibraries});
  results.library=library;
  // The index builds itself once the library is configured (catalogRefresh only if it did not start).
  let sawScanning=false,nudged=false,lastLog=0,status!:CatalogStatus;
  await h.waitFor(`catalog index of ${base} complete`,async()=>{
   status=await ipc<CatalogStatus>(h,'catalogStatus',library.libraryId);
   if(status.state==='scanning')sawScanning=true;
   if(status.state==='error'||status.error)throw new Error(`The catalog index failed: ${status.error}`);
   if(Date.now()-lastLog>=30000){lastLog=Date.now();say(`${label}: index ${status.state}, read ${status.progress.read}, found ${status.progress.discovered}, total ${status.total}, ${((Date.now()-registered)/1000).toFixed(0)} s`);}
   if(!sawScanning&&!status.lastCompletedAt&&!nudged&&Date.now()-registered>45000){nudged=true;await h.action({type:'catalogRefresh',libraryId:library.libraryId});}
   return status.state==='idle'&&!!status.lastCompletedAt;
  },{timeoutMs:30*60000,interval:1000,seen:async()=>status});
  timings.indexMs=Date.now()-registered;
  say(`${label}: index complete in ${(timings.indexMs as number/1000).toFixed(1)} s, ${status.total} files`);
  await enterBrowser(h,library);await shot('open');
  await h.until('indexed-files status',"/indexed files/.test(document.querySelector('.browser-status')?.textContent??'')",120000);
  await h.waitFor('Files column shows the whole library',async()=>!(await filesBusy(h)),{timeoutMs:120000,interval:100});
  await shot('indexed');

  // 4. Plausible total.
  const everything=await ipc<CatalogPage>(h,'catalogQuery',{libraryId:library.libraryId,filters:[],sort:{field:'name',direction:'asc'},limit:1} satisfies CatalogQuery);
  const shownTotal=await filesTotal(h);
  results.counts={browserTotal:everything.total,browserFilesColumn:shownTotal,statusTotal:status.total,nodeMedia:listing.media.length,nodeAllFiles:listing.files};
  say(`${label}: browser shows ${everything.total} files (Files column ${shownTotal}); Node counted ${listing.media.length} media of ${listing.files} files`);
  if(everything.total===0)throw new Error('The browser shows 0 files');
  if(everything.total<listing.media.length*.8)throw new Error(`The browser shows ${everything.total} files but ${listing.media.length} media files are on the drive`);
  if(shownTotal!==everything.total)throw new Error(`The Files column says ${shownTotal} but the catalog total is ${everything.total}`);
  await save();

  // 5. Facets: camera, date, format.
  await facetStep(h,shot,library,'camera','camera',timings);
  await facetStep(h,shot,library,'date','captureYear',timings);
  await facetStep(h,shot,library,'format','format',timings);
  if(await h.js<boolean>("!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Clear all')"))await buttonByText(h,'Clear all');
  await save();

  // 6. Real folders: descend three levels through the largest folder, checking the Files count against the catalog.
  const folderStart=performance.now();
  await buttonByText(h,'Real folders');
  await h.until('first folder column',"document.querySelector('[data-testid=directory-column] [role=option]')",60000);
  const trail:{depth:number;folder:string;count:number|null;filesShown:number;filesExpected:number}[]=[];
  for(let depth=0;depth<3;depth++){
   const column=`[data-testid=directory-column][data-column-index="${depth}"]`;
   await h.waitFor(`folder column ${depth} rows`,async()=>(await rowsOf(h,column)).length>0&&await h.js<boolean>(`document.querySelector('${column} [role=listbox]')?.getAttribute('aria-busy')==='false'`),{timeoutMs:60000,interval:50}).catch(error=>{if(depth===0)throw error;});
   const rows=await rowsOf(h,column);if(!rows.length)break;
   const largest=[...rows].sort((a,b)=>(b.count??0)-(a.count??0))[0]!;
   if(depth===0)timings.folderColumnMs=Math.round(performance.now()-folderStart);
   await clickRow(h,column,largest.key);
   const expected=(await ipc<CatalogPage>(h,'catalogQuery',{libraryId:library.libraryId,filters:[],parentPath:largest.key,sort:{field:'name',direction:'asc'},limit:1} satisfies CatalogQuery)).total;
   await h.waitFor(`Files of folder ${largest.key} = ${expected}`,async()=>!(await filesBusy(h))&&await filesTotal(h)===expected,{timeoutMs:60000,interval:100,seen:async()=>({files:await filesTotal(h),expected})});
   trail.push({depth,folder:largest.key,count:largest.count,filesShown:await filesTotal(h),filesExpected:expected});
   await shot(`folders-level-${depth+1}`);
   say(`${label}: folder ${largest.key} (${largest.count} below, ${expected} direct)`);
  }
  if(!trail.length)throw new Error('Real folders mode showed no folders');
  results.folders=trail;
  await buttonByText(h,'Clear all');await buttonByText(h,'Categories');
  await h.until('categories mode',"document.querySelector('[data-testid=facet-column]')",30000);
  await save();

  // 7. Search and open files (JPEG, HEIC, RAW, video, a non-ASCII path).
  const opened:Timings[]=[];results.opened=opened;
  const targets:Target[]=chosen.opened.map(item=>({rel:item.file.rel,name:item.file.rel.split('/').at(-1)!,why:item.why}));
  const searchStart=performance.now();
  for(const [index,target] of targets.entries()){
   if(index===0)timings.searchFirstMs=Math.round(performance.now()-searchStart);
   await openFile(h,shot,library,root,target,index,opened);
   await save();
  }
  // A Chinese/Japanese file name, when the library has one, found through the search box.
  const wide=listing.media.find(m=>nonAscii.test(m.rel.split('/').at(-1)!));
  if(wide){
   const name=nfc(wide.rel.split('/').at(-1)!),needle=[...name].filter(c=>nonAscii.test(c)).slice(0,2).join('');
   const expected=(await ipc<CatalogPage>(h,'catalogQuery',{libraryId:library.libraryId,filters:[],nameContains:needle,sort:{field:'name',direction:'asc'},limit:1} satisfies CatalogQuery)).total;
   if(expected<1)throw new Error(`Searching "${needle}" finds nothing though "${name}" exists`);
   await setValue(h,'.browser-search input',needle);
   await h.waitFor(`non-ASCII search "${needle}" shows ${expected}`,async()=>!(await filesBusy(h))&&await filesTotal(h)===expected,{timeoutMs:60000,interval:100});
   await shot('search-non-ascii');results.nonAsciiSearch={needle,total:expected};
  }
  await setValue(h,'.browser-search input','');

  // 8. The read-only promises of this run.
  const clicks=await h.js<string[]>('window.__realClicks??[]');
  results.clicked=clicks;
  const bad=clicks.filter(text=>forbiddenClick.test(text));
  if(bad.length)throw new Error(`The run clicked buttons that must never be used here: ${bad.join(', ')}`);
  const s=await h.state();
  if(s.jobs.some(job=>!job.id.startsWith('qa:')))throw new Error(`Jobs exist: ${s.jobs.map(job=>job.id+':'+job.phase).join(', ')}`);
  results.passed=true;
 }catch(error){failure=error;results.passed=false;results.error=error instanceof Error?error.message:String(error);}
 finally{
  results.blockedActions=blocked;
  // Restore the fixture configuration so no later check could touch the drive.
  try{hooks.mutate(state=>{state.preferences={...state.preferences,destinations:original.destinations,destinationIds:original.destinationIds,basePath:original.basePath,copyMode:original.copyMode,automatic:original.automatic,mediaLayout:original.mediaLayout};});await h.action({type:'refresh'});}catch(error){say(`could not restore the fixture configuration: ${String(error)}`);}
  hooks.beforeAction=undefined;
 }
 // 9. The witness again, success or failure.
 const after=await takeWitness(volume,witnessFiles);
 await fs.writeFile(path.join(outDir,'witness-after.json'),JSON.stringify(after,null,1));
 const diff=differences(before,after);
 results.witness={failures:diff.failures,ignoredSystemNoise:diff.ignored};
 await save();
 if(blocked.length)say(`${label}: ${blocked.length} UI action(s) were refused by the read-only guard: ${[...new Set(blocked)].join(', ')}`);
 if(diff.ignored.length)say(`${label}: macOS housekeeping on the volume root (ignored): ${diff.ignored.join('; ')}`);
 if(diff.failures.length){
  const message=`THE DRIVE CHANGED during the read-only run (${diff.failures.length}): ${diff.failures.slice(0,20).join(' | ')}`;
  say(`${label}: FAIL ${message}`);
  throw new Error(message+(failure?` — and the run failed: ${failure instanceof Error?failure.message:String(failure)}`:''));
 }
 say(`${label}: witness unchanged (${witnessFiles.length} files hashed, ${Object.keys(after.root).length} root entries, ${after.data==='absent'?'no data folder':Object.keys(after.data).length+' data entries'})`);
 if(failure)throw failure;
 say(`${label}: PASS in ${((Date.now()-Date.parse(results.startedAt as string))/1000).toFixed(0)} s; screenshots in ${outDir}`);
}

export const realDriveChecks=(ctx:Context):Check[]=>{
 const drives=ctx.realDrives;
 if(!drives?.length)return [{id:'real-drives',stage:'navigation',title:'Real drives: Library browser, previews and EXIF, read-only',covers:['read-only browsing of real exFAT libraries','thumbnail decode','EXIF against metadata()'],skip:async()=>'needs --real-drives=/Volumes/NAME:folder',run:async()=>{}}];
 return drives.map((drive,index)=>({
  id:`real-drives-${index+1}`,stage:'navigation' as const,title:`Real drive ${drive.destination} (${drive.basePath}): Library browser, previews and EXIF, read-only`,
  covers:['read-only browsing of real exFAT libraries','witness: drive unchanged','catalog index of a real library','facets, folders, search','thumbnail decode','EXIF against metadata()'],budgetMs:3*3600000,
  skip:async h=>h.hooks?undefined:'needs the QA hook (unpackaged --codex-test launch)',
  run:h=>realDriveRun(h,drive,index+1),
 }));
};
