// Mount the production inventory in Electron. Instrument only its memo render function
// inside this disposable fixture; application bundles contain no test counters.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
const repo=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory=await fs.mkdtemp(path.join(repo,'build','inventory-render-'));
const component=path.join(repo,'desktop/renderer/RootApp.tsx'),i18n=path.join(repo,'desktop/renderer/i18n.tsx');
await fs.writeFile(path.join(directory,'index.html'),'<div id="root"></div><script type="module" src="./fixture.tsx"></script>');
await fs.writeFile(path.join(directory,'fixture.tsx'),`
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {InventoryPanel} from ${JSON.stringify(component)};import {I18nProvider} from ${JSON.stringify(i18n)};
let renders=0;const render=InventoryPanel.type;InventoryPanel.type=props=>{renders++;return render(props);};
const root=createRoot(document.getElementById('root'));const noop=()=>{};
let inventory={files:Array.from({length:500},(_,i)=>({path:'/fixture/'+i+'.JPG',relative:i+'.JPG',kind:'JPEG',size:100,included:true})),media:500,companions:0,unknown:0,bytes:50000,unknownExtensions:{},elapsedMs:0};
function draw(progress,language='en'){flushSync(()=>root.render(<I18nProvider language={language}><span>{progress}</span><InventoryPanel inventory={inventory} sourceName="Fixture" backup={false} inspect={noop} act={noop}/></I18nProvider>));}
function expect(value,message){if(!value)throw Error(message);}
window.run=async()=>{draw(0);const initial=renders;expect(initial===1,'initial render');
 for(let i=1;i<=10;i++)draw(i);expect(renders===initial,'progress-only updates rendered inventory');
 expect(document.querySelectorAll('.file-table tbody tr').length===500,'500 initial rows');
 draw(11,'ja');expect(renders===initial+1,'language change did not render');expect(document.querySelector('.inventory-panel h2').textContent!=='Source inventory','translation did not change');
 inventory={...inventory,files:inventory.files.slice(0,3),media:3,bytes:300};draw(12,'ja');expect(renders===initial+2,'replacement inventory did not render');expect(document.querySelectorAll('.file-table tbody tr').length===3,'replacement rows');
 const input=document.querySelector('input[type=search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'1.JPG');input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,50));
 expect(renders>initial+2,'search did not render');expect(document.querySelectorAll('.file-table tbody tr').length===1,'search results');
 return {passed:true,initialRows:500,progressUpdates:10,progressRenders:0,languageRenders:1,replacementRenders:1,searchRows:1};};
`);
await build({configFile:false,root:directory,base:'./',plugins:[react()],build:{outDir:path.join(directory,'dist'),emptyOutDir:true},logLevel:'error'});
await fs.writeFile(path.join(directory,'main.cjs'),`
const {app,BrowserWindow}=require('electron');const fs=require('node:fs/promises');
app.setPath('userData',${JSON.stringify(path.join(directory,'user-data'))});
app.whenReady().then(async()=>{const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});try{
 await window.loadFile(${JSON.stringify(path.join(directory,'dist/index.html'))});
 const result=await window.webContents.executeJavaScript('window.run()');await fs.writeFile(${JSON.stringify(path.join(directory,'report.json'))},JSON.stringify(result,null,2));console.log(JSON.stringify(result));app.exit(0);
}catch(error){console.error(error);app.exit(1);}});
`);
const electron=createRequire(import.meta.url)('electron');
await new Promise((resolve,reject)=>{const child=spawn(electron,[path.join(directory,'main.cjs')],{cwd:repo,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined},stdio:'inherit'});const deadline=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Inventory render fixture timed out'));},30000);child.on('error',reject);child.on('exit',code=>{clearTimeout(deadline);code===0?resolve():reject(Error('Inventory fixture exited '+code));});});
console.log('Inventory render report: '+path.join(directory,'report.json'));
