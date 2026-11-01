// Everything that is not a camera photo or video goes to the library's other-files folder beside it: screenshots, chat
// images, broken files, unknown media and non-media, each in its category folder with date folders when a date is known.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {plan,execute,executeReorganization,getOrganizationRecovery,undoOrganization,configureOrganizationRecovery} from '../core/index';
import {destinationParts} from '../core/allocation';
import {evaluateRoutes} from '../core/folder-rules';
import {distinctName,nameDate,nameOrigin,otherFilesPlace,otherFilesRoot,originCategory,screenSized} from '../core/other-files';
import {dateFromFolders,datePath} from '../folder-template';
import {metadataFromTags} from '../platform/metadata';
import type {InventoryFile,MediaKind,Metadata,TransferPlan} from '../shared';
import {slash} from './fixtures/os';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const rules={template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,editedFolder:'editied',noMetadata:'folder' as const};
const when=new Date('2026-10-20T12:00:00Z');

test('screenshots and chat images by name, in several languages; a PNG at a screen size; nothing else',()=>{
  for(const name of ['Screenshot_20260115-093000.png','Screenshot 2026-01-15 at 09.30.00.png','Screen Shot 2019-03-01 at 1.00.00 PM.png','截圖 2026-01-15 上午9.30.00.png','屏幕截图 2026-01-15 093000.png','スクリーンショット 2026-01-15 9.30.00.png','IMG_0004.PNG','微信截图_20260115093000.png'])
    assert.equal(nameOrigin(name)?.origin,'Screenshots',name);
  assert.equal(nameOrigin('RPReplay_Final1700000000.MP4')?.origin,'Screen Recordings');
  for(const [name,origin] of [['mmexport1700000000000.jpg','WeChat'],['wx_camera_1700000000000.jpg','WeChat'],['IMG-20250102-WA0001.jpg','WhatsApp'],['VID-20250102-WA0003.mp4','WhatsApp'],['photo_2025-01-02_10-11-12.jpg','Telegram'],['LINE_P20250102_101112345.jpg','LINE'],['received_1234567890123.jpeg','Messenger']] as const)
    assert.equal(nameOrigin(name)?.origin,origin,name);
  assert.equal(nameOrigin('IMG_0004.PNG')?.confidence,'medium','IMG_*.PNG could be anything: medium');
  assert.equal(nameOrigin('Screenshot_1.png')?.confidence,'high');
  for(const name of ['DSC_0001.NEF','IMG_0004.JPG','IMG_0004.HEIC','_R6_1149.png','DJI_0001.JPG','photo.jpg']) assert.equal(nameOrigin(name),undefined,name);
  assert.equal(nameOrigin('anything.png',{width:1179,height:2556})?.origin,'Screenshots','an iPhone screen');
  assert.equal(nameOrigin('anything.png',{width:2556,height:1179})?.origin,'Screenshots','either orientation');
  assert.equal(nameOrigin('anything.jpg',{width:1179,height:2556}),undefined,'only a PNG or HEIC');
  assert.equal(nameOrigin('anything.png',{width:6000,height:4000}),undefined);
  assert.ok(screenSized(1920,1080)&&!screenSized(6048,4024));
  assert.equal(originCategory('Screenshots'),'screenshots');assert.equal(originCategory('Screen Recordings'),'screenshots');
  assert.equal(originCategory('WeChat'),'chat');assert.equal(originCategory('WhatsApp'),'chat');assert.equal(originCategory(undefined),undefined);
});

test('a date in a name, and date folders read and written by the folder template',()=>{
  assert.equal(nameDate('Screenshot_20260115-093000.png')?.toISOString().slice(0,10),'2026-01-15');
  assert.equal(nameDate('IMG-20250102-WA0001.jpg')?.toISOString().slice(0,10),'2025-01-02');
  assert.equal(nameDate('mmexport1700000000000.jpg')?.toISOString().slice(0,10),'2023-11-14');
  assert.equal(nameDate('IMG_0004.PNG'),undefined);assert.equal(nameDate('DSC_20261399.JPG'),undefined,'month 13 is no date');
  assert.equal(nameDate('a1202601151.png'),undefined,'not inside a longer number');
  assert.equal(datePath('{year}/{yyyymm}/{camera}',new Date(Date.UTC(2026,0,15))),'2026/202601');
  assert.equal(datePath('{camera}/{year}/{monthName}',new Date(Date.UTC(2026,0,15))),'2026/01 January');
  assert.equal(datePath('{camera}',new Date(Date.UTC(2026,0,15))),'');
  assert.equal(dateFromFolders('{year}/{yyyymm}/{camera}',['2022','202203','Unknown files'])?.toISOString().slice(0,10),'2022-03-01');
  assert.equal(dateFromFolders('{year}/{yyyymm}/{camera}',['Unknown files','2019','201908'])?.toISOString().slice(0,10),'2019-08-01');
  assert.equal(dateFromFolders('{year}/{yyyymm}/{camera}',['2022','202303']),undefined,'the folders disagree');
  assert.equal(dateFromFolders('{year}/{yyyymm}/{camera}',['Problem files','Empty files','photobackup','Drive backups','DCIM 2']),undefined);
});

test('the other-files folder sits beside the library, or inside one at the top of its drive, on every system',()=>{
  assert.equal(otherFilesPlace('I:\\photobackup',true,path.win32),'I:\\photobackup-otherfiles');
  assert.equal(otherFilesPlace('I:\\',true,path.win32),'I:\\library-otherfiles');
  assert.equal(otherFilesPlace('/Volumes/A006/photobackup',true,path.posix),'/Volumes/A006/photobackup-otherfiles');
  assert.equal(otherFilesPlace('/Volumes/A006',false,path.posix),'/Volumes/A006/A006-otherfiles','a mount point: nothing beside it is on the drive');
});

test('metadata first: Apple\'s Screenshot comment, a screenshot tool, a screen-sized PNG; a camera photo is never a screenshot',()=>{
  assert.equal(metadataFromTags({'ExifIFD:UserComment':'Screenshot'},{file:'IMG_0001.HEIC'}).origin,'Screenshots');
  assert.equal(metadataFromTags({'IFD0:Software':'Snipping Tool'},{file:'image.png'}).origin,'Screenshots');
  assert.equal(metadataFromTags({'PNG:ImageWidth':1290,'PNG:ImageHeight':2796},{file:'export.png'}).origin,'Screenshots');
  const camera=metadataFromTags({'IFD0:Make':'NIKON CORPORATION','IFD0:Model':'NIKON Z f','ExifIFD:DateTimeOriginal':'2026:01:15 09:30:00'},{file:'Screenshot_20260115.png'});
  assert.equal(camera.camera,'NIKON Z f');assert.equal(camera.origin,undefined,'a camera wrote it: a photo, whatever its name');
});

test('editors are recognized from Software, CreatorTool and History; camera firmware is not an editor',()=>{
  for(const software of ['Snapseed 2.0','NX Studio 1.5.0 W','Adobe Lightroom 7.1','Capture One 23 Macintosh','Adobe Photoshop 25.0 (Windows)','VSCO','Polarr','Digital Photo Professional 4.18'])
    assert.equal(metadataFromTags({'IFD0:Software':software,'IFD0:Model':'NIKON Z f'}).edited,true,software);
  assert.equal(metadataFromTags({'XMP-xmp:CreatorTool':'Pixelmator Pro 3.5'}).edited,true);
  assert.equal(metadataFromTags({'XMP-xmpMM:HistorySoftwareAgent':['Adobe Photoshop Lightroom Classic 13.0']}).edited,true);
  for(const software of ['Ver.01.10','NIKON Z f Ver.01.10','ILCE-7M4 v2.00','17.1','Digital Camera X-T5 Ver2.00','G998BXXU7DWL1'])
    assert.notEqual(metadataFromTags({'IFD0:Software':software,'IFD0:Model':'NIKON Z f'}).edited,true,software);
});

const file=(root:string,relative:string,kind:MediaKind,extra:Partial<InventoryFile>={}):InventoryFile=>({path:path.join(root,relative),relative:path.join(...relative.split('/')),size:10,kind,included:true,...extra});
function route(root:string,files:InventoryFile[],metadata:Record<string,Partial<Metadata>>,options:Record<string,unknown>={},unreadable:string[]=[]) {
  const infos=new Map(files.filter(item=>item.kind!=='Other').map(item=>[item.path,{fields:{},...metadata[path.basename(item.path)]} as Metadata]));
  const decisions=evaluateRoutes({sourceRoot:root,files,scanned:files,metadata:infos,mtimes:new Map(files.map(item=>[item.path,when])),unreadableMetadata:new Set(unreadable.map(name=>files.find(item=>path.basename(item.path)===name)!.path)),roots:[{root,role:'photos'}],options:{...rules,unknownRules:{},...options}});
  return Object.fromEntries(decisions.map(decision=>[path.basename(decision.file.path),decision.reason==='route'?`${decision.root}:${slash(decision.relative!)}`:decision.reason]));
}

test('routing: camera originals and edited exports stay in the library; screenshots, chat images, broken, unknown and other files go out',()=>{
  const root=path.resolve('/library'),files=[
    file(root,'card/DSC_0001.NEF','RAW'),file(root,'card/DSC_0001.JPG','JPEG'),
    file(root,'exports/DSC_0002.jpg','JPEG'),file(root,'exports/phone-edit.jpg','JPEG'),
    file(root,'phone/Screenshot_20260115-093000.png','Images'),file(root,'phone/IMG_0004.PNG','Images'),file(root,'phone/apple.HEIC','HEIF'),
    file(root,'chats/IMG-20250102-WA0001.jpg','JPEG'),file(root,'chats/mmexport1700000000000.jpg','JPEG'),
    file(root,'odd/broken.jpg','JPEG'),file(root,'odd/nothing.jpg','JPEG'),file(root,'odd/dated.jpg','JPEG'),
    file(root,'odd/archive.zip','Other'),file(root,'odd/NC_FLLST.DAT','Other'),
    file(root,'phone/Screenshot_from_camera.png','Images'),
  ];
  const routes=route(root,files,{
    'DSC_0001.NEF':{camera:'NIKON Z f',date:'2026-10-05T10:00:00'},'DSC_0001.JPG':{camera:'NIKON Z f',date:'2026-10-05T10:00:00'},
    'DSC_0002.jpg':{camera:'NIKON Z f',date:'2026-10-06T10:00:00',edited:true},'phone-edit.jpg':{edited:true},
    'apple.HEIC':{origin:'Screenshots',date:'2026-02-03T08:00:00'},'dated.jpg':{date:'2024-04-05T10:00:00'},
    'Screenshot_from_camera.png':{camera:'NIKON Z f',date:'2026-03-01T10:00:00'},
  },{reorganize:true},['broken.jpg']);
  assert.deepEqual(routes,{
    'DSC_0001.NEF':'photos:2026/202610/NIKON Z f/DSC_0001.NEF','DSC_0001.JPG':'photos:2026/202610/NIKON Z f/DSC_0001.JPG',
    'DSC_0002.jpg':'photos:2026/202610/editied/NIKON Z f/DSC_0002.jpg',
    'phone-edit.jpg':'photos:2026/202610/editied/phone-edit.jpg',
    'Screenshot_20260115-093000.png':'other:Screenshots/2026/202601/Screenshot_20260115-093000.png',
    'IMG_0004.PNG':'other:Screenshots/IMG_0004.PNG',
    'apple.HEIC':'other:Screenshots/2026/202602/apple.HEIC',
    'IMG-20250102-WA0001.jpg':'other:Chat images/2025/202501/IMG-20250102-WA0001.jpg',
    'mmexport1700000000000.jpg':'other:Chat images/2023/202311/mmexport1700000000000.jpg',
    'broken.jpg':'other:Broken files/Unreadable files/broken.jpg',
    'nothing.jpg':'other:Unknown files/nothing.jpg','dated.jpg':'other:Unknown files/2024/202404/dated.jpg',
    // A file that is not media has no date but its modified time, so that one dates it.
    'archive.zip':'other:Other files/2026/202610/archive.zip','NC_FLLST.DAT':'other:Other files/2026/202610/NC_FLLST.DAT',
    'Screenshot_from_camera.png':'photos:2026/202603/NIKON Z f/Screenshot_from_camera.png',
  });
});

test('routing: a family goes together; the user\'s own rule for a type keeps its folder; keep and file-date choices still apply',()=>{
  const root=path.resolve('/library'),files=[
    file(root,'phone/Screenshot_20260115-093000.png','Images'),file(root,'phone/Screenshot_20260115-093000.png.xmp','Other',{companionOf:path.join(root,'phone/Screenshot_20260115-093000.png')}),
    file(root,'docs/notes.pdf','Other'),file(root,'odd/nothing.jpg','JPEG'),
  ];
  const own=route(root,files,{},{unknownRules:{pdf:'Documents'},reorganize:false});
  assert.equal(own['Screenshot_20260115-093000.png.xmp'],'other:Screenshots/2026/202601/Screenshot_20260115-093000.png.xmp');
  assert.equal(own['notes.pdf'],'photos:Documents/notes.pdf');
  assert.equal(route(root,files,{},{noMetadata:'keep'})['nothing.jpg'],'keep');
  assert.equal(route(root,files,{},{noMetadata:'fileDate'})['nothing.jpg'],'photos:2026/202610/Unknown files/nothing.jpg');
  assert.equal(route(root,files,{},{noMetadata:'keep'})['Screenshot_20260115-093000.png'],'other:Screenshots/2026/202601/Screenshot_20260115-093000.png','a screenshot is identified, never kept as unknown');
  assert.equal(route(root,files,{},{noMetadataFolder:'Not dated'})['nothing.jpg'],'other:Not dated/nothing.jpg','the chosen name for unknown files');
});

test('routing: a file already in an Unknown files folder is not nested in it again (2022/202203/Unknown files)',()=>{
  const root=path.resolve('/library'),files=[file(root,'2022/202203/Unknown files/_R6_1149.png','Images'),file(root,'Unknown files/2019/201908/1acac40a.jpg','JPEG'),file(root,'Unknown files/2015/201502/Unknown files/x.jpg','JPEG')];
  assert.deepEqual(route(root,files,{},{reorganize:true}),{
    '_R6_1149.png':'other:Unknown files/2022/202203/_R6_1149.png','1acac40a.jpg':'other:Unknown files/2019/201908/1acac40a.jpg','x.jpg':'other:Unknown files/2015/201502/x.jpg'});
});

async function library(t:test.TestContext) {
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'other-files-')));t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const root=path.join(base,'photobackup');await fs.mkdir(root);
  const put=async(relative:string,contents:string)=>{const target=path.join(root,...relative.split('/'));await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,contents);await fs.utimes(target,when,when);return target;};
  return {base,root,other:path.join(base,'photobackup-otherfiles'),put};
}
const tree=async(root:string)=>Object.fromEntries((await Promise.all((await fs.readdir(root,{recursive:true,withFileTypes:true})).filter(entry=>entry.isFile()&&!/Photo Importer|photo-importer/i.test(path.join(entry.parentPath,entry.name))).map(async entry=>[slash(path.relative(root,path.join(entry.parentPath,entry.name))),await fs.readFile(path.join(entry.parentPath,entry.name),'utf8')] as const))).sort(([a],[b])=>a.localeCompare(b)));
const byName:Record<string,Metadata>={
  'DSC_0001.NEF':{fields:{},camera:'NIKON Z f',date:'2026-10-05T10:00:00'},'DSC_0002.jpg':{fields:{},camera:'NIKON Z f',date:'2026-10-06T10:00:00',edited:true},
};
const metadata=async(file:string):Promise<Metadata>=>byName[path.basename(file)]??{fields:{}};
async function organize(root:string) {
  const found=await plan(root,[root],{...rules,backup:false,reorganize:true,collectProblems:true},metadata);
  for(const part of destinationParts(found.plans[0]!)) assert.deepEqual((await executeReorganization(part)).errors,[]);
  return found.plans[0]!;
}

test('organization moves what earlier versions kept in the library to the other-files folder, journaled and undoable',async t=>{
  const f=await library(t);
  await f.put('2026/202610/NIKON Z f/DSC_0001.NEF','raw');
  await f.put('2026/202610/editied/NIKON Z f/DSC_0002.jpg','edit');
  await f.put('2026/202601/Screenshots/Screenshot_20260115-093000.png','shot');
  await f.put('2022/202203/Unknown files/_R6_1149.png','unknown png');
  await f.put('Unknown files/2019/201908/1acac40a.jpg','old unknown');
  // An earlier version's Problem files, holding what it collected from a Drive backups folder.
  await f.put('Problem files/Empty files/photobackup/Drive backups/photobackup/DCIM 2/EMPTY.JPG','');
  await f.put('Problem files/Empty files/elsewhere/EMPTY.JPG','');
  await f.put('Drive backups/photobackup/DCIM/NC_FLLST.DAT','index');
  await f.put('Drive backups/photobackup/files.zip','zip');
  const before=await tree(f.root);
  const planned=await organize(f.root);
  assert.equal(planned.other?.root,f.other,'the other-files folder is a part of the plan of its own');
  assert.equal(planned.other?.source,f.base,'its journal reads from the folder holding the library and it');
  assert.deepEqual(await tree(f.root),{
    '2026/202610/NIKON Z f/DSC_0001.NEF':'raw','2026/202610/editied/NIKON Z f/DSC_0002.jpg':'edit'});
  const moved=await tree(f.other),empties=Object.keys(moved).filter(name=>name.startsWith('Broken files/'));
  assert.deepEqual(Object.fromEntries(Object.entries(moved).filter(([name])=>!name.startsWith('Broken files/'))),{
    'Other files/2026/202610/NC_FLLST.DAT':'index','Other files/2026/202610/files.zip':'zip',
    'Screenshots/2026/202601/Screenshot_20260115-093000.png':'shot',
    'Unknown files/2019/201908/1acac40a.jpg':'old unknown','Unknown files/2022/202203/_R6_1149.png':'unknown png'});
  // Both empty files are kept flat, never under the old Drive backups path, the second under a name of its own.
  assert.equal(empties.length,2,empties.join(', '));
  assert.ok(empties.every(name=>/^Broken files\/Empty files\/EMPTY( \([0-9a-f]{6}\))?\.JPG$/.test(name)),empties.join(', '));
  assert.ok(!Object.keys(moved).some(name=>name.includes('Drive backups')||name.includes('Problem files')));
  // The moves are listed under the other-files folder, and undo puts every file back.
  const [job]=await getOrganizationRecovery(f.other);
  assert.ok(job?.undoable,'the other-files journal can be undone');
  await undoOrganization(f.other,job!.id);
  for(const recovery of await getOrganizationRecovery(f.root))await undoOrganization(f.root,recovery.id);
  assert.deepEqual(await tree(f.root),before);
});

test('a second organization leaves the other-files folder and the library as they are',async t=>{
  const f=await library(t);
  await f.put('2026/202610/NIKON Z f/DSC_0001.NEF','raw');
  await f.put('phone/IMG-20250102-WA0001.jpg','chat');
  await organize(f.root);
  const kept=await tree(f.root),other=await tree(f.other);
  assert.deepEqual(other,{'Chat images/2025/202501/IMG-20250102-WA0001.jpg':'chat'});
  const again=await plan(f.root,[f.root],{...rules,backup:false,reorganize:true,collectProblems:true},metadata);
  assert.equal(destinationParts(again.plans[0]!).reduce((sum,part)=>sum+part.entries.length,0),0);
  assert.deepEqual(await tree(f.root),kept);assert.deepEqual(await tree(f.other),other);
});

test('an import files new screenshots, chat images and other files straight into the other-files folder',async t=>{
  const f=await library(t),card=path.join(f.base,'card');
  const put=async(relative:string,contents:string)=>{const target=path.join(card,relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,contents);await fs.utimes(target,when,when);};
  await put('DCIM/DSC_0001.NEF','raw');await put('DCIM/Screenshot_20260115-093000.png','shot');await put('WhatsApp/IMG-20250102-WA0001.jpg','chat');await put('notes.zip','zip');
  const {plans}=await plan(card,[f.root],{...rules,backup:false,everyFile:true,unknownRules:{}},metadata);
  const parts:TransferPlan[]=destinationParts(plans[0]!);
  for(const part of parts) assert.deepEqual((await execute(part)).errors,[]);
  assert.deepEqual(await tree(f.root),{'2026/202610/NIKON Z f/DSC_0001.NEF':'raw'});
  assert.deepEqual(await tree(f.other),{'Chat images/2025/202501/IMG-20250102-WA0001.jpg':'chat','Other files/2026/202610/notes.zip':'zip','Screenshots/2026/202601/Screenshot_20260115-093000.png':'shot'});
  assert.equal(await otherFilesRoot(f.root),f.other);
});

test('distinct names for broken files filed flat say where each came from, never the folder path itself',()=>{
  const name=distinctName('EMPTY.JPG',path.join('Problem files','Empty files','a','EMPTY.JPG'));
  assert.match(name,/^EMPTY \([0-9a-f]{6}\)\.JPG$/);
  assert.equal(distinctName('EMPTY.JPG','Problem files/Empty files/a/EMPTY.JPG'),name,'the same on every system');
});
