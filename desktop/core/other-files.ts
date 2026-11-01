import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {OTHER_FILES_SUFFIX,OTHER_FOLDERS,PROBLEM_FILE_GROUPS} from '../shared';

/** Everything in a library that is not a camera photo or video lives in the library's other-files folder: beside the
 * library (`I:\photobackup` → `I:\photobackup-otherfiles`), on the same drive, so moving a file there is a rename.
 * Rules and their confidence: docs/other-files.md. */
export {OTHER_FILES_SUFFIX,OTHER_FOLDERS};
export type OtherCategory=keyof typeof OTHER_FOLDERS;
/** Broken files are grouped by why: the same names Problem files used ("Empty files", "Unreadable files"). */
export const BROKEN_FOLDERS=PROBLEM_FILE_GROUPS;

type PathApi=Pick<typeof path,'join'|'dirname'|'basename'|'resolve'>;
/** Where `library`'s other files go, by `paths` (path.win32 or path.posix: each system's own rules): beside it when the folder
 * holding it is on the same drive (`besideOnSameDrive`), else inside it under the same name. A filesystem root (`I:\`, `/`)
 * has nothing beside it: inside, as `library-otherfiles`. */
export function otherFilesPlace(library:string,besideOnSameDrive:boolean,paths:PathApi=path):string {
  const resolved=paths.resolve(library),parent=paths.dirname(resolved);
  return parent!==resolved&&besideOnSameDrive?paths.join(parent,paths.basename(resolved)+OTHER_FILES_SUFFIX):paths.join(resolved,insideOtherFilesName(resolved,paths));
}
/** The other-files folder beside `library` (inside it only for a filesystem root). */
export const siblingOtherFiles=(library:string,paths:PathApi=path):string=>otherFilesPlace(library,true,paths);
/** Its name inside `library`, for a library at the top of its drive. */
export const insideOtherFilesName=(library:string,paths:Pick<typeof path,'basename'>=path):string=>(paths.basename(library)||'library')+OTHER_FILES_SUFFIX;
/** Where `library`'s other files go on this system: beside it, or inside it when the library is the top of its drive (a
 * filesystem root such as `I:\` or `/`, or a mount point such as `/Volumes/A006`, whose parent is another drive). */
export async function otherFilesRoot(library:string):Promise<string> {
  const resolved=path.resolve(library),parent=path.dirname(resolved);
  if(parent===resolved)return otherFilesPlace(resolved,false);
  try {
    const [own,above]=await Promise.all([fs.stat(resolved,{bigint:true}),fs.stat(parent,{bigint:true})]);
    return otherFilesPlace(resolved,own.dev===above.dev);
  } catch { /* A library that cannot be looked at yet is planned for its usual place. */ return otherFilesPlace(resolved,true); }
}
/** Whether a top-level folder name of a library is its own other-files folder (only for a library at the top of a drive). */
export const isOtherFilesFolder=(name:string,library:string):boolean=>name.toLowerCase()===insideOtherFilesName(library).toLowerCase();

/** Where a cameraless file came from. Screenshots and screen recordings file as screenshots, messaging apps as chat images. */
export type Origin='Screenshots'|'Screen Recordings'|'WeChat'|'WhatsApp'|'LINE'|'Telegram'|'Messenger'|'QQ';
const CHAT_APPS=new Set<string>(['WeChat','WhatsApp','LINE','Telegram','Messenger','QQ']);
/** The other-files category of an origin; undefined for none (or an origin this version does not know). */
export function originCategory(origin:string|undefined):OtherCategory|undefined {
  if(origin==='Screenshots'||origin==='Screen Recordings')return 'screenshots';
  if(origin&&CHAT_APPS.has(origin))return 'chat';
  return undefined;
}
/** How sure a rule is: high when the name or tag is written only by that source, medium when an ordinary photo could look so. */
export type Confidence='high'|'medium';
interface NameRule {pattern:RegExp;origin:Origin;confidence:Confidence;}
/** File name patterns, checked only for a file with no camera (a camera photo is never filed by its name). */
const NAME_RULES:NameRule[]=[
  // Screenshots, in the names systems give them: Android, Windows, macOS (English and other languages), iOS/macOS in Chinese and Japanese.
  {pattern:/^(?:Screenshot|Screen ?Shot|Capture d.(?:é|e)cran|Bildschirmfoto|Schermafbeelding|Captura de pantalla|Captura de Tela|Istantanea|Snapshot_\d{8}|Snipaste_|スクリーンショット|画面収録|截屏|截圖|截图|屏幕截图|屏幕快照|螢幕截圖|螢幕快照|螢幕擷取畫面|微信截图|QQ截图|스크린샷)/iu,origin:'Screenshots',confidence:'high'},
  {pattern:/^(?:RPReplay_|ScreenRecording_|Screen ?Recording|Screenrecorder-|录屏|屏幕录制|螢幕錄影|画面収録)/iu,origin:'Screen Recordings',confidence:'high'},
  // WeChat saves pictures as mmexport<ms>, its in-app camera as wx_camera_<ms>, edited videos with _WC-EditVideo_.
  {pattern:/^(?:mmexport|wx_camera_\d|microMsg\.\d{10,})|_WC-EditVideo_/i,origin:'WeChat',confidence:'high'},
  {pattern:/^(?:(?:IMG|VID|PTT|AUD|STK)-\d{8}-WA\d+|WhatsApp (?:Image|Video) \d{4}-\d{2}-\d{2})/i,origin:'WhatsApp',confidence:'high'},
  {pattern:/^(?:photo|video)_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}|^telegram-cloud-(?:photo|document)-/i,origin:'Telegram',confidence:'high'},
  {pattern:/^LINE_(?:P\d{8}|ALBUM_|MOVIE_)/i,origin:'LINE',confidence:'medium'},
  {pattern:/^received_\d{10,}/i,origin:'Messenger',confidence:'medium'},
  {pattern:/^QQ(?:图片|圖片|视频|視頻)\d{8,}/iu,origin:'QQ',confidence:'high'},
  // iOS saves screenshots as IMG_1234.PNG: a PNG under a camera's name that no camera wrote.
  {pattern:/^IMG_\d{4}(?: ?\(\d+\))?\.png$/i,origin:'Screenshots',confidence:'medium'},
];
/** Screen resolutions of phones, tablets and computers (either orientation). */
const SCREENS=new Set([
  '640x1136','750x1334','828x1792','1080x1920','1125x2436','1170x2532','1179x2556','1206x2622','1242x2208','1242x2688','1284x2778','1290x2796','1320x2868',
  '720x1280','720x1600','1080x2340','1080x2400','1080x2412','1440x2560','1440x2960','1440x3040','1440x3088','1440x3120','1440x3200','1220x2712','1260x2800','1280x2856','1344x2992','1080x2460','1176x2480',
  '1536x2048','1620x2160','1640x2360','1668x2224','1668x2388','2048x2732','2064x2752','1488x2266',
  '720x1280','768x1366','900x1440','864x1536','900x1600','1050x1680','1080x1920','1200x1920','1440x2560','1600x2560','1800x2880','1912x2940','1964x3024','2234x3456','2160x3840','1824x2736','1504x2256','1600x2400','1440x3440',
]);
/** Whether width × height is a screen's size, in either orientation. */
export const screenSized=(width?:number,height?:number):boolean=>!!width&&!!height&&SCREENS.has(`${Math.min(width,height)}x${Math.max(width,height)}`);
/** What a cameraless file's name (and, for a PNG or HEIC, its pixel size) says about where it came from. */
export function nameOrigin(name:string,evidence:{width?:number;height?:number}={}):{origin:Origin;confidence:Confidence}|undefined {
  for(const rule of NAME_RULES)if(rule.pattern.test(name))return {origin:rule.origin,confidence:rule.confidence};
  // A PNG or HEIC at exactly a screen's size, with no camera: what a screenshot looks like.
  if(/\.(?:png|heic)$/i.test(name)&&screenSized(evidence.width,evidence.height))return {origin:'Screenshots',confidence:'medium'};
  return undefined;
}
/** Software that writes screenshots: the Software/CreatorTool tag of a file it saved. */
export const SCREENSHOT_SOFTWARE=/^(?:Screenshot|Snipping Tool|Snip & Sketch|Screen Sketch|ShareX|Greenshot|Snagit|Lightshot|Flameshot|Spectacle|gnome-screenshot|Xbox Game Bar|Snipaste|CleanShot|Monosnap)\b/i;

/** The day a file's name records, for files filed by name (a screenshot, a chat image, a broken or unknown file):
 * yyyy-mm-dd, yyyymmdd or yyyy_mm_dd not inside a longer number, or WeChat's millisecond clock (read as UTC). */
export function nameDate(name:string):Date|undefined {
  const stamp=/^(?:mmexport|wx_camera_|microMsg\.)(\d{13})/i.exec(name);
  if(stamp){const date=new Date(Number(stamp[1]));if(date.getUTCFullYear()>=2000&&date.getTime()<=Date.now()+86400000)return new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()));}
  const match=/(?:^|[^\d])((?:19|20)\d{2})([-_.]?)(0[1-9]|1[0-2])\2(0[1-9]|[12]\d|3[01])(?!\d)/.exec(name);
  if(!match)return undefined;
  const year=Number(match[1]),month=Number(match[3]),day=Number(match[4]),date=new Date(Date.UTC(year,month-1,day));
  return date.getUTCDate()===day&&date.getTime()<=Date.now()+86400000?date:undefined;
}
/** A broken file filed flat (no date known) under a name another broken file of this plan also takes: the name with a short
 * digest of where it came from, so neither replaces nor hides the other and the old folder path is not rebuilt. */
export function distinctName(name:string,from:string):string {
  const extension=path.extname(name),digest=createHash('sha256').update(from.split(path.sep).join('/')).digest('hex').slice(0,6);
  return `${name.slice(0,name.length-extension.length)} (${digest})${extension}`;
}
