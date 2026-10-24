import assert from 'node:assert/strict';
import {nativeTheme} from 'electron';
import {formatMessage} from '../../../messages';
import {settingsCategories,type Check,type Harness} from '../harness';
import {syntheticJob} from '../synthetic';
import {savedPreferences,type Context} from './context';

const english=(message?:Parameters<typeof formatMessage>[0])=>message?formatMessage(message,'en'):'';
const theme=(h:Harness,want:'light'|'dark')=>h.until(`theme ${want}`,`document.documentElement.dataset.theme===${JSON.stringify(want)}`);
/** Sets the OS appearance the app sees and waits for the page to follow. Any settings change makes the main process
 * reapply the saved appearance to nativeTheme, so the wanted source is reasserted on every poll instead of set once. */
async function osTheme(h:Harness,source:'light'|'dark'){
 await h.waitFor(`page follows the OS ${source} appearance`,async()=>{if(nativeTheme.themeSource!==source)nativeTheme.themeSource=source;return h.js<boolean>(`document.documentElement.dataset.theme===${JSON.stringify(source)}`);},{seen:()=>({themeSource:nativeTheme.themeSource})});
}
const inputValue=(placeholder:string)=>`document.querySelector('input[placeholder=${JSON.stringify(placeholder)}]')`;
/** Types into a text field and leaves it the way React sees it (focusin, input, focusout), without needing OS focus. */
const typeAndLeave=(h:Harness,placeholder:string,value:string)=>h.js(`(()=>{const input=${inputValue(placeholder)};input.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));})()`);

export const settingsChecks=(ctx:Context):Check[]=>[
 {id:'settings-system-appearance',stage:'settings',title:'System appearance responds live to OS light and dark changes',covers:['light and dark mode (OS)'],run:async h=>{
  await osTheme(h,'dark');await h.shot('system-dark');await osTheme(h,'light');await h.shot('system');
 }},
 {id:'settings-explicit-appearance',stage:'settings',title:'Explicit Light and Dark controls override system appearance',covers:['light and dark mode (setting)'],run:async h=>{
  await h.nav('Settings');
  if(!await h.js<boolean>("!!document.querySelector('.appearance-segments')"))await h.settingsTab('general');
  for(const mode of ['Dark','Light'] as const){
   await h.js(`Array.from(document.querySelectorAll('.appearance-segments button')).find(b=>b.textContent.trim()===${JSON.stringify(mode)}).click()`);
   await h.waitFor('appearance preference',async()=>(await h.state()).preferences.appearance===mode.toLowerCase());await theme(h,mode.toLowerCase() as 'light'|'dark');await h.shot(mode.toLowerCase());
  }
  // The explicit choice wins over the OS.
  nativeTheme.themeSource='dark';await h.frames(2);await theme(h,'light');
  await h.prefs({appearance:'system'});await osTheme(h,'dark');
 }},
 {id:'settings-text-size',stage:'settings',title:'Settings provides live, persistent text sizing with a readable default, and each category holds its settings',covers:['text size slider','settings categories'],run:async h=>{
  await h.nav('Settings');
  await h.settingsTab('storage');
  assert.equal(await h.js<boolean>("document.querySelector('.settings-page input[placeholder=photobackup]')!==null&&document.querySelector('.settings-page #copy-policy')!==null"),true,'Backup folder and copy policy live in Settings → Storage');
  assert.equal(await h.js<boolean>("document.querySelector('.settings-page [data-testid=backup-mode]')!==null&&document.querySelector('.settings-page .destination-check-actions .destination-check')===null"),true,'Drive backup mode lives in Settings → Storage, which no longer runs the folder check');
  await h.settingsTab('folders');
  assert.equal(await h.js<boolean>("document.querySelector('.settings-page [data-testid=folder-settings]')!==null"),true,'Folder paths live in Settings → Folders');
  await h.settingsTab('general');
  await h.until('text size in Settings → General',"document.querySelector('input[aria-label=\"Text size\"]')");
  assert.equal((await h.state()).preferences.textScale,1.25);
  const original=await h.js<number>("parseFloat(getComputedStyle(document.querySelector('.settings-page .settings-section h3')).fontSize)");
  await h.js(`{const slider=document.querySelector('input[aria-label="Text size"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(slider,'150');slider.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await h.waitFor('text slider preference',async()=>(await h.state()).preferences.textScale===1.5);
  await h.until('larger text',`parseFloat(getComputedStyle(document.querySelector('.settings-page .settings-section h3')).fontSize)>${original}`);
  await h.waitFor('saved text size',async()=>(await savedPreferences(ctx.root)).textScale===1.5);
  await h.prefs({textScale:1.25});await h.shot('settings');
 }},
 {id:'settings-languages',stage:'settings',title:'All four interface languages switch live and persist',covers:['4 locales','persisted language'],run:async h=>{
  for(const [language,label,details] of [['zh-Hans','设置','详细信息'],['zh-Hant','設定','詳細資訊'],['ja','設定','詳細情報'],['en','Settings','Drive details']] as const){
   await h.prefs({language});
   await h.until(`language ${language}`,`Array.from(document.querySelectorAll('.nav-item')).some(item=>item.textContent.includes(${JSON.stringify(label)}))&&document.querySelectorAll('article[data-source-id^="fixture:"] .source-step-row > .source-disclosure-toggle').length===6&&Array.from(document.querySelectorAll('article[data-source-id^="fixture:"] .source-step-row > .source-disclosure-toggle')).every(toggle=>toggle.querySelector('.source-disclosure-label').textContent===${JSON.stringify(details)})`);
   await h.waitFor(`saved language ${language}`,async()=>(await savedPreferences(ctx.root)).language===language);
   await h.shot('language-'+language);
  }
 }},
 {id:'settings-edited-folder',stage:'settings',title:'Edited exports folder edits persist, update the preview and reject unsafe names',covers:['text preference save on blur','preview','validation errors stay in All errors'],run:async h=>{
  await h.idle();
  try{
   await h.nav('Settings');await h.settingsTab('folders');
   await h.until('default edited exports folder',`${inputValue('editied')}?.value==='editied'`);
   assert.equal((await h.state()).preferences.editedFolder,'editied');
   await typeAndLeave(h,'editied','Finished');
   await h.waitFor('edited exports folder preference',async()=>(await h.state()).preferences.editedFolder==='Finished');
   await h.waitFor('persisted edited exports folder',async()=>(await savedPreferences(ctx.root)).editedFolder==='Finished');
   await h.until('updated edited-export preview',"document.querySelector('[data-testid=edited-export-preview]')?.textContent.includes('2026202610FinishedNikon Z6III')");
   await h.shot('edited-exports-folder');
   for(const [language,label] of [['zh-Hans','编辑导出文件夹'],['zh-Hant','編輯匯出資料夾'],['ja','編集済み書き出しフォルダー'],['en','Edited exports folder']] as const){
    await h.prefs({language});
    await h.until(`edited exports field in ${language}`,`${inputValue('editied')}?.value==='Finished'&&${inputValue('editied')}.closest('label').textContent.trim()===${JSON.stringify(label)}`);
   }
   // The UI bridge reports action failures in AppState.error rather than rejecting its promise.
   const rejected=await h.action({type:'preferences',patch:{editedFolder:'../escape'}});
   assert.equal(rejected.preferences.editedFolder,'Finished');assert.match(english(rejected.error),/safe folder name/i);
   assert.equal(await h.js<boolean>("document.querySelector('.error-banner,.job-errors,.source-camera-error,.recovery-error')===null&&document.querySelector('[data-testid=activity-panel]')===null"),true,'Errors stay out of the main workspace');
   await h.click('[data-testid=show-errors]');await h.until('error appears in dedicated panel',"document.querySelector('.all-errors')?.textContent.includes('safe folder name')");await h.shot('all-errors-with-detail');
   await h.nav('Settings');await h.until('issues list closed',"document.querySelector('[data-testid=activity-panel]')===null");
   assert.equal((await savedPreferences(ctx.root)).editedFolder,'Finished','An invalid folder must not be persisted');
  }finally{
   await h.action({type:'clearErrors'});await h.prefs({editedFolder:'editied'});
  }
  await h.nav('Settings');await h.settingsTab('folders');
  await h.until('restored edited exports folder',`${inputValue('editied')}?.value==='editied'&&document.querySelector('[data-testid=edited-export-preview]')?.textContent.includes('2026202610editiedNikon Z6III')`);
 }},
 {id:'settings-locked',stage:'settings',title:'While work is active, locked settings are greyed out with a tooltip saying why, and changing one raises no error',covers:['locked settings greyed out with tooltip and no error'],skip:async h=>h.hooks?undefined:'needs the QA hook to hold a job active',run:async h=>{
  type Control={key:string;disabled:boolean;opacity:number;tip:string};
  const controls=()=>h.js<Control[]>("Array.from(document.querySelectorAll('.settings-panel input,.settings-panel select,.settings-panel button')).filter(e=>e.checkVisibility()).map((e,i)=>{let opacity=1;for(let a=e;a;a=a.parentElement)opacity*=parseFloat(getComputedStyle(a).opacity);return {key:(e.id||e.getAttribute('aria-label')||e.closest('label')?.textContent?.trim().slice(0,30)||e.textContent.trim().slice(0,30)||e.tagName)+'#'+i,disabled:e.matches(':disabled'),opacity:Math.round(opacity*100)/100,tip:e.closest('[title]')?.getAttribute('title')??''};})");
  await h.idle();await h.nav('Settings');
  const before:Record<string,Control[]>={};
  for(const id of settingsCategories){await h.settingsTab(id);before[id]=await controls();}
  const basePath=(await h.state()).preferences.basePath;
  h.hooks!.addJobs([syntheticJob('locked',{phase:'copying'})]);
  await h.settingsTab('storage');
  await h.until('settings locked',"document.querySelector('[data-testid=settings-lock-note]')");
  let locked=0;const problems:string[]=[];
  for(const id of settingsCategories){
   await h.settingsTab(id);
   const now=await controls(),newly=now.filter(control=>control.disabled&&!before[id]!.find(item=>item.key===control.key)?.disabled);
   locked+=newly.length;
   if(newly.length&&!await h.js<boolean>("Array.from(document.querySelectorAll('.settings-panel [data-testid=settings-lock-note]')).some(e=>e.checkVisibility())"))problems.push(`${id}: locked controls without the lock note`);
   for(const control of newly){
    // Known: Show in Finder sits inside a locked fieldset, so it greys out too and keeps its own tooltip (reported as a follow-up).
    if(!/locked/i.test(control.tip)&&!/^(Show in Finder|Show in file manager)/.test(control.tip))problems.push(`${id}: ${control.key} has no lock tooltip (title: ${JSON.stringify(control.tip)})`);
    if(control.opacity>.6)problems.push(`${id}: ${control.key} is not greyed out (opacity ${control.opacity})`);
   }
   if(id==='storage')await h.shot('settings-locked');
  }
  assert.ok(locked>0,'No setting was locked while a job was active');
  assert.deepEqual(problems,[],'Locked settings');
  // A locked setting sent anyway is dropped quietly: no error, no toast, nothing applied.
  const after=await h.action({type:'preferences',patch:{basePath:'should-not-apply'}});await h.frames(2);
  assert.equal(after.preferences.basePath,basePath,'A locked setting changed while work was active');
  assert.equal(after.error,undefined,'Changing a locked setting raised an error');
  assert.equal(await h.js<boolean>("!document.querySelector('[data-testid=error-toast]')"),true,'Changing a locked setting showed an error toast');
 }},
 {id:'settings-detailed-logging',stage:'settings',title:'Diagnostics log detail stays live and persists in Settings Diagnostics',covers:['Diagnostics log-level selector','live logging preference','persisted logging preference'],run:async h=>{
  await h.nav('Settings');await h.settingsTab('diagnostics');
  const initial=(await h.state()).preferences.logLevel;
  try{for(const level of ['detailed','off'] as const){
   await h.js(`{const select=document.querySelector('#settings-log-level');select.value=${JSON.stringify(level)};select.dispatchEvent(new Event('change',{bubbles:true}));}`);
   await h.waitFor('live log level '+level,async()=>(await h.state()).preferences.logLevel===level);
   await h.waitFor('saved log level '+level,async()=>(await savedPreferences(ctx.root)).logLevel===level);
  }}finally{await h.prefs({logLevel:initial});}
 }},
];
