import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {seedBrowserFixtures} from './catalog-qa-fixtures.mjs';
const repo=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const {values:flags}=parseArgs({strict:false,options:{interactive:{type:'boolean'},large:{type:'string'},only:{type:'string',multiple:true},'no-build':{type:'boolean'},'ui-only':{type:'boolean'},'organization-only':{type:'boolean'},'reduced-motion':{type:'boolean'},'browser-fixtures':{type:'boolean'},app:{type:'string'},'reuse-fixtures':{type:'string'}}});
const interactive=flags.interactive===true;
// An explicit packaged executable uses the same fixture checks; --reuse-fixtures preserves its profile on restart.
const packagedExecutable=typeof flags.app==='string'?flags.app:undefined;
const reusedFixtureRoot=typeof flags['reuse-fixtures']==='string'?flags['reuse-fixtures']:undefined;
// --only=<regex> runs only the checks whose id matches (the final checks always run), for working on one area.
// --large=N seeds N misplaced media files into the first destination, so both organization checks
// review and move them through the app (UI under load). It lengthens the deadline accordingly.
const large=Number(flags.large??0);
const run=(bin,args,timeoutMs=0)=>new Promise((resolve,reject)=>{
 const child=spawn(bin,args,{cwd:repo,stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
 let expired=false;
 const deadline=timeoutMs?setTimeout(()=>{expired=true;child.kill('SIGKILL');},timeoutMs):undefined;
 child.on('error',error=>{clearTimeout(deadline);reject(error);});
 child.on('exit',(code,signal)=>{clearTimeout(deadline);if(expired)reject(new Error('Automated Electron QA exceeded its 7-minute deadline'));else if(code===0)resolve();else reject(new Error(`${bin} exited ${code??signal}`));});
});
if(flags['no-build']!==true)await run(process.platform==='win32'?'npm.cmd':'npm',['run','build']);
const root=reusedFixtureRoot?await fs.realpath(reusedFixtureRoot):await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'photo-importer-codex-'));
if(!reusedFixtureRoot){
for(let i=1;i<=6;i++){
 const source=path.join(root,`source-${i}`);await fs.mkdir(source);const payload=Buffer.alloc(8*1024*1024,i);await fs.writeFile(path.join(source,'payload.bin'),payload);await fs.writeFile(path.join(source,'.hidden-note'),`Fixture ${i}\n`);
 if(i===1){await fs.writeFile(path.join(source,'photo.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6XHgAAAAASUVORK5CYII=','base64'));await fs.writeFile(path.join(source,'clip.mp4'),Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,49]));}
}
await fs.mkdir(path.join(root,'destination','photobackup'),{recursive:true});await fs.writeFile(path.join(root,'destination','photobackup','existing-marker.txt'),'Keep existing destination data\n');
for(let i=0;i<large;i++){const folder=path.join(root,'destination','large-unsorted',`${100+Math.floor(i/200)}MEDIA`);if(i%200===0)await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,`DSC_${String(i).padStart(5,'0')}.${['JPG','NEF','MP4','HEIC'][i%4]}`),`large fixture ${i}\n`);}
await fs.mkdir(path.join(root,'destination-2'));await fs.writeFile(path.join(root,'destination-2','existing-marker.txt'),'Keep second destination data\n');
if(flags['browser-fixtures']===true||(flags.only??[]).some(value=>String(value).includes('browser')))await seedBrowserFixtures(root,repo);
}
console.log(`Codex QA fixtures and results: ${root}`);
const require=createRequire(import.meta.url);const electron=require('electron');
const deadlineMs=420000+large*300;
// The app writes its report by 45 s before the kill: enough to close and exit on a loaded machine.
try{await run(packagedExecutable??electron,[...(packagedExecutable?[]:['.']), '--qa',`--qa-fixture-root=${root}`,`--codex-deadline=${Date.now()+deadlineMs-45000}`,...(flags['reduced-motion']===true?['--force-prefers-reduced-motion']:[]),...(interactive?[]:['--codex-test']),...((flags['ui-only']===true||flags['organization-only']===true)?['--codex-ui-only']:[]),...(flags['organization-only']===true?['--codex-organization-only']:[]),...(flags.only??[]).map(value=>`--codex-only=${value}`)],interactive?0:deadlineMs);}
catch(error){console.error(String(error));process.exitCode=1;}
if(!interactive){const reportPath=path.join(root,'artifacts','report.json');try{const report=JSON.parse(await fs.readFile(reportPath,'utf8'));for(const check of report.checks)console.log(`${{passed:'PASS',failed:'FAIL',skipped:'SKIP'}[check.status]??(check.passed?'PASS':'FAIL')} ${check.id??''} ${check.title??check.name}${check.reason?` (${check.reason})`:''}${check.error?`\n     ${check.error.split('\n')[0]}`:''}`);console.log(`${report.passed?'PASSED':'FAILED'} ${report.suite} suite in ${Math.round(report.seconds??0)} s${report.error?`: ${report.error}`:''}`);console.log(`Checks and coverage: ${path.join(root,'artifacts','report.md')}`);if(!report.passed)process.exitCode=1;}catch{console.error('No QA report produced: app failed before the integration checks finished.');process.exitCode=1;}console.log(`Report: ${reportPath}`);}
