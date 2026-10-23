import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator, formatBytes, formatNumber, I18nProvider, languages, localeNames, translationCatalogs, useTranslation } from '../renderer/i18n';
import type {AppState, Inventory, Job, SourceCameraInfo} from '../shared';
import { message, text } from '../messages';

test('all four languages have readable names and translate primary UI', () => {
  assert.deepEqual(languages, ['en', 'zh-Hans', 'zh-Hant', 'ja']);
  assert.deepEqual(languages.map(language => createTranslator(language)('Settings')), ['Settings', '设置', '設定', '設定']);
  assert.equal(localeNames['zh-Hant'], '繁體中文');
  for (const catalog of Object.values(translationCatalogs)) {
    assert.ok(Object.keys(catalog).length > 200);
    for (const [key, value] of Object.entries(catalog)) {
      assert.ok(value, `Missing translation for ${key}`);
      assert.deepEqual([...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort(), [...key.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort(), `Placeholders differ for ${key}`);
    }
  }
});
test('fallback and interpolation preserve filenames, EXIF tokens and unmatched placeholders', () => {
  const t = createTranslator('ja');
  assert.equal(t('Unknown technical message: {name}', { name: 'DSC_0001.NEF' }), 'Unknown technical message: DSC_0001.NEF');
  assert.equal(t('Preview of {name}', { name: 'Nikon Z6III <RAW>' }), 'Nikon Z6III <RAW> のプレビュー');
  assert.equal(t('{count} files', { count: 0 }), '0 ファイル');
  assert.equal(t('{count} files'), '{count} ファイル');
  assert.equal(t('toString'), 'toString');
  assert.equal(t('__proto__'), '__proto__');
  assert.equal(t('Available tokens: {year}, {yyyymm}, {month}, {monthName}, {yearMonthName}, {day}, {yyyyMMdd}, {camera}'), '使用可能なトークン：{year}、{yyyymm}、{month}、{monthName}、{yearMonthName}、{day}、{yyyyMMdd}、{camera}');
});
test('provider selects the persisted language and escapes user data through React', () => {
  function Label() { const { t } = useTranslation(); return createElement('span', null, t('Preview of {name}', { name: '<camera>' })); }
  assert.equal(renderToStaticMarkup(createElement(I18nProvider, { language: 'zh-Hant', children: createElement(Label) })), '<span>&lt;camera&gt; 的預覽</span>');
});
test('byte formatting uses consistent decimal units and safe empty values', () => {
  assert.equal(formatBytes(1_500_000, 'ja'), '1.5 MB');
  assert.equal(formatBytes(Infinity, 'en'), '0 B');
  assert.equal(formatBytes(0, 'zh-Hans'), '0 B');
});

test('copy and discovery labels describe destinations, media types and mounted storage in every language', () => {
  const labels = [
    ['Copy to both destinations','复制到两个目标','複製到兩個目的地','両方の保存先にコピー'],
    ['Folder backup','文件夹备份','資料夾備份','フォルダーバックアップ'],
    ['Media layout','媒体文件布局','媒體檔案配置','メディアの配置'],
    ['A separate video backup folder','单独的视频备份文件夹','獨立的影片備份資料夾','動画用の別のバックアップフォルダー'],
  ];
  for (const values of labels) for (const [index,language] of languages.entries()) assert.equal(createTranslator(language)(values[0]),values[index]);
});

test('every literal UI translation key has translations in all supported languages', () => {
  const source = readFileSync(new URL('../renderer/RootApp.tsx', import.meta.url), 'utf8');
  const keys = [...source.matchAll(/\bt\("([^"\n]+)"/g)].map(match => match[1]);
  for (const key of keys) for (const [language, catalog] of Object.entries(translationCatalogs)) {
    assert.ok(Object.hasOwn(catalog, key), `${language}: ${key}`);
  }
});

test('camera information renders multiple EXIF models separately from unconfirmed hints in every language', async () => {
  const { SourceCameraInformation } = await import('../renderer/RootApp');
  const info = {
    status: 'reading' as const,
    hints: [{ name: 'NIKON Z6III card', evidence: 'drive-name' as const }, { name: 'Canon', evidence: 'file-type' as const }],
    models: [{ name: 'NIKON Z6III', files: 2, bytes: 1_500_000 }, { name: 'Canon EOS R5', files: 1, bytes: 900_000 }],
    checked: 4, total: 7, unknown: 1,
  };
  for (const language of languages) {
    const t = createTranslator(language);
    const markup = renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(SourceCameraInformation, { sourceId: 'test-card', info }) }));
    assert.ok(markup.includes('data-testid="source-camera-info"'));
    assert.ok(markup.includes('data-source-id="test-card"'));
    assert.ok(markup.includes(t('Camera hints — unconfirmed')));
    assert.ok(markup.includes(t('Drive name')));
    assert.ok(markup.includes(t('Confirmed by EXIF metadata')));
    assert.ok(markup.includes('<li>NIKON Z6III</li>'));
    assert.ok(markup.includes('<li>Canon EOS R5</li>'));
    assert.ok(markup.includes(t('Reading camera metadata: {checked}/{total}', { checked: 4, total: 7 })));
    assert.ok(!markup.includes('1.5 MB') && !markup.includes(t('{count} files', { count: 2 })), 'Only names are shown, no counts');
  }
});

test('camera information reports partial, stopped and empty results accurately', async () => {
  const { SourceCameraInformation } = await import('../renderer/RootApp');
  for (const status of ['complete', 'stopped', 'error'] as const) {
    const markup = renderToStaticMarkup(createElement(I18nProvider, { language: 'en', children: createElement(SourceCameraInformation, { sourceId: 'empty-card', info: { status, hints: [], models: [], checked: 0, total: 2, unknown: 0, ...(status === 'error' ? { error: 'Read failure' } : {}) } }) }));
    assert.ok(markup.includes('No camera models confirmed in checked files.'));
    assert.ok(!markup.includes('Camera hints — unconfirmed'));
    assert.ok(markup.includes(status === 'complete' ? 'Camera metadata checked: 0/2' : status === 'stopped' ? 'Camera metadata scan stopped: 0/2' : 'Camera metadata scan incomplete: 0/2'));
    if (status === 'error') assert.ok(!markup.includes('Read failure'), 'Error details belong in All errors');
  }
});

test('edited-export folder settings localize the default and custom preview without changing the regular template', async () => {
  const {SettingsPage}=await import('../renderer/RootApp');
  const labels=['Edited exports folder','编辑导出文件夹','編輯匯出資料夾','編集済み書き出しフォルダー'];
  for(const folder of [undefined,'finished'])for(const [index,language] of languages.entries()){
    const state:AppState={preferences:{language,appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:[],copyMode:'single',basePath:'photobackup',template:'{camera}/{year}/{yyyymm}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',allowFolderSource:false,unknownRules:{},...(folder===undefined?{}:{editedFolder:folder})},sources:[],jobs:[],history:[],platform:'darwin'};
    const markup=renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(SettingsPage,{state,act:()=>{},busy:false})}));
    assert.ok(markup.includes(labels[index]));
    assert.ok(markup.includes(`placeholder="editied" value="${folder??'editied'}"`));
    const previewStart=markup.indexOf('data-testid="edited-export-preview"');assert.ok(previewStart>=0);
    const regular=markup.slice(0,previewStart).replace(/<[^>]+>/g,'');
    const edited=markup.slice(previewStart).replace(/<[^>]+>/g,'');
    assert.ok(regular.includes('photobackupNikon Z6III2026202610DSC_0001.NEF'),'The regular template must retain its configured camera/year/month order');
    assert.ok(edited.includes(`photobackup2026202610${folder??'editied'}Nikon Z6IIIDSC_0001.jpg`),'Only the edited-export example uses the year/month/export-folder/camera order');
    assert.ok(markup.includes(createTranslator(language)('Edited exports go here, inside each month folder.')));
  }
});

test('organization shows the exact selected folder scope and retains an explicit whole-destination option', async () => {
  const { Organization } = await import('../renderer/RootApp');
  for (const language of languages) {
    const state: AppState = { preferences: { language, appearance:'system', textScale:1.25, accent:'coral', automatic:true, parallel:2, destinations:['/Volumes/A006'], copyMode:'single', basePath:'photobackup', template:'{year}/{yyyymm}/{camera}', mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'', allowFolderSource:false, unknownRules:{} }, sources:[], jobs:[], history:[], platform:'darwin', organizationFolders:{'/Volumes/A006':['2024','2025','2026']} };
    const t = createTranslator(language);
    const render = () => renderToStaticMarkup(createElement(I18nProvider, {language, children:createElement(Organization, {state, act:()=>{}, busy:false})}));
    const selected = render();
    assert.ok(selected.includes(t('Choose folders…')));
    assert.ok(selected.includes(t('Use whole destination')));
    assert.ok(selected.includes(t('Only the selected folders will be scanned.')));
    assert.ok(selected.includes('<li>2024</li><li>2025</li><li>2026</li>'));
    assert.ok(selected.includes('/Volumes/A006/photobackup'));
    assert.ok(!selected.includes('settings-fieldset'),'Organization must not duplicate the Settings configurator');
    state.organizationFolders = {};
    const whole = render();
    assert.ok(whole.includes(t('All folders on this destination will be scanned.')));
    assert.ok(!whole.includes(t('Use whole destination')));
    state.busyReview = true; state.reviewProgress = {phase:'planning', step:'checking', completed:123, total:400, bytes:0, totalBytes:0, speed:0, file:'/Volumes/A006/2024/photo.JPG'};
    const checking = render();
    assert.ok(checking.includes(t('Checking organization files: {count} · {file}', {count:(123).toLocaleString(language), file:'/Volumes/A006/2024/photo.JPG'})));
    assert.ok(checking.includes('aria-valuenow="31"') && checking.includes(t('{completed} of {total} files checked', {completed:(123).toLocaleString(language), total:(400).toLocaleString(language)})), `${language}: organization review shows a determinate bar`);
  }
});

test('unknown formats prompt is visible before opening rules and keeps imports available', async () => {
  const { UnknownFilesPrompt } = await import('../renderer/RootApp');
  const inventory: Inventory = {files:[{path:'/card/NOTES.DAT',relative:'NOTES.DAT',kind:'Other' as const,size:3,included:false}],media:0,companions:0,unknown:1,bytes:0,unknownExtensions:{dat:1},elapsedMs:0};
  for (const language of languages) {
    const t = createTranslator(language);
    const render = (scan=inventory) => renderToStaticMarkup(createElement(I18nProvider, {language,children:createElement(UnknownFilesPrompt, {sourceName:'Test card',inventory:scan,act:()=>{}})}));
    const markup = render();
    assert.ok(markup.includes('data-testid="unknown-files-prompt"'));
    assert.ok(markup.includes(t('Keep unknown files excluded')));
    assert.ok(markup.includes(t('Copy to camera folders')));
    assert.ok(markup.includes(t('Remember for these extensions')));
    assert.ok(markup.includes('type="checkbox" checked=""'));
    assert.ok(!markup.includes('unknown-explanation'), 'The prompt stays short: no explanation block');
    assert.ok(markup.includes(t('{name}: {count} unknown files skipped.', {name:'Test card',count:1})));
    assert.ok(!markup.includes('<select'));
    assert.ok(!markup.includes('disabled=""'));
    assert.equal(render({...inventory,unknown:0,unknownExtensions:{}}),'');
    assert.equal(renderToStaticMarkup(createElement(I18nProvider, {language, children:createElement(UnknownFilesPrompt, {sourceName:'Test card', inventory, knownRules:{dat:null}, act:()=>{}})})), '', 'Remembered exclusions should not prompt again');
  }
});


test('saved camera rules render as camera mode while custom folders and Ignore remain supported', async () => {
  const { SettingsPage } = await import('../renderer/RootApp');
  for (const language of languages) {
    const state: AppState = { preferences: { language, appearance:'system', textScale:1.25, accent:'coral', automatic:true, parallel:2, destinations:[], copyMode:'single', basePath:'photobackup', template:'{year}/{yyyymm}/{camera}', mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'', allowFolderSource:false, unknownRules:{dat:{action:'camera'},pdf:'Documents',txt:null} }, sources:[], jobs:[], history:[], platform:'darwin' };
    const t = createTranslator(language);
    const markup = renderToStaticMarkup(createElement(I18nProvider, {language,children:createElement(SettingsPage,{state,act:()=>{},busy:false})}));
    assert.ok(markup.includes(`<span class="extension-name">.dat</span><span>${t('Copy to camera folders')}</span>`));
    assert.ok(markup.includes(`<span class="extension-name">.pdf</span><span>${t('Copy to {folder}',{folder:'Documents'})}</span>`));
    assert.ok(markup.includes(`<span class="extension-name">.txt</span><span>${t('Ignore')}</span>`));
    assert.ok(markup.includes(`<option value="camera">${t('Copy to camera folders')}</option>`));
    assert.ok(markup.includes(`<option value="ignore" selected="">${t('Ignore')}</option>`));
    assert.ok(!markup.includes('[object Object]'));
  }
});


test('global controls stay independent of pages and source error details are isolated in the errors panel', async () => {
  const {TitlebarControls, ImportDesk, ActivityPanel, collectErrors} = await import('../renderer/RootApp');
  const state: AppState = {preferences:{language:'en',appearance:'system',textScale:1.5,accent:'coral',automatic:true,parallel:2,destinations:['/backup'],copyMode:'single',basePath:'photobackup',template:'{year}/{yyyymm}/{camera}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',allowFolderSource:false,unknownRules:{}},sources:[{id:'one',name:'Card one',path:'/one',transport:'storage'},{id:'two',name:'Card two',path:'/two',transport:'storage'}],jobs:[{id:'failed',source:{id:'one',name:'Card one',path:'/one',transport:'storage'},phase:'error',detail:text('copy failure detail'),errors:[text('copy failure detail')],backup:false}],history:[],platform:'darwin',error:text('application failure detail'),sourceCameraInfo:{two:{status:'error',hints:[],models:[],checked:0,total:1,unknown:0,error:'camera failure detail'}},organizationRecovery:[{id:'r',root:'/backup',status:'pending',files:1,completed:0,error:'recovery failure detail'}]};
  const errors=collectErrors(state,['connection failure detail']);assert.equal(errors.length,5);
  for(const language of languages){
    const t=createTranslator(language);
    const render=(child:ReturnType<typeof createElement>)=>renderToStaticMarkup(createElement(I18nProvider,{language,children:child}));
    const controls=render(createElement(TitlebarControls,{state,act:()=>{},errorCount:errors.length,onErrors:()=>{}}));
    for(const label of ['Start imports','Stop','Automatic','All errors'])assert.ok(controls.includes(t(label)));
    assert.ok(!controls.includes('show-progress'));
    assert.ok(!controls.includes('Preview photo'));
    const desk=render(createElement(ImportDesk,{state,act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}}));
    assert.equal((desk.match(/<article data-source-id=/g)??[]).length,2);
    assert.ok(desk.includes(`aria-label="${t('Import dashboard')}"`),'The dashboard lives on the Import desk');
    for(const error of errors)assert.ok(!desk.includes(t(error.message)));
    const panel=render(createElement(ActivityPanel,{state,errors,act:()=>{},onClose:()=>{}}));
    for(const error of errors)assert.ok(panel.includes(t(error.message)));
    assert.ok(panel.includes('Card one'));
  }
});

test('Organize now can queue behind imports and the desk dashboard lists organization jobs', async () => {
  const {Organization, ImportDashboard}=await import('../renderer/RootApp');
  const source={id:'card',name:'Card',path:'/card',transport:'storage' as const};
  const state: AppState={preferences:{language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:true,parallel:2,destinations:['/backup'],copyMode:'single',basePath:'photobackup',template:'{year}/{yyyymm}/{camera}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',allowFolderSource:false,unknownRules:{}},sources:[source],jobs:[{id:'import',source,phase:'copying',detail:text('Copying photos'),errors:[],backup:false}],history:[],platform:'darwin',organizationFolders:{'/backup':['2024','2025','2026']}};
  for(const language of languages){
    const t=createTranslator(language),render=(child:ReturnType<typeof createElement>)=>renderToStaticMarkup(createElement(I18nProvider,{language,children:child}));
    const markup=render(createElement(Organization,{state,act:()=>{},busy:true}));
    const primary=markup.match(/<button[^>]*class="button button-primary[^>]*>[\s\S]*?<\/button>/)?.[0];assert.ok(primary?.includes(t('Organize now')));assert.ok(!primary?.includes('disabled'));
    const job={id:'organize',source:{id:'library',name:'Existing library',path:'/backup',transport:'folder' as const},phase:'queued' as const,detail:message('job.waitingForImports'),errors:[],backup:false,organization:true};state.jobs.push(job);
    const progress=render(createElement(ImportDashboard,{state,act:()=>{}}));assert.ok(progress.includes(t('Library organization')));assert.ok(progress.includes(t('Queued')));assert.ok(progress.includes(t(job.detail)));
    const queued=render(createElement(Organization,{state,act:()=>{},busy:true}));assert.ok(queued.match(/<button[^>]*class="button button-primary[^>]*disabled/));state.jobs.pop();
  }
});

test('format problems and metadata read issues are isolated in All errors; acknowledged exclusions disappear',async()=>{
 const {collectErrors,ActivityPanel,ImportDesk}=await import('../renderer/RootApp');
 const state:AppState={preferences:{language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:[],copyMode:'single',basePath:'photobackup',template:'{year}/{yyyymm}/{camera}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',allowFolderSource:false,unknownRules:{},unknownDefault:'ask'},sources:[{id:'card',name:'Card',path:'/card',transport:'storage'}],jobs:[],history:[],platform:'darwin',sourceInventories:{card:{files:[{path:'/card/NOTE.DAT',relative:'NOTE.DAT',size:10,kind:'Other',included:false}],media:0,companions:0,unknown:1,unknownExtensions:{dat:1},bytes:0,elapsedMs:0,issues:[{path:'/card/BROKEN.NEF',message:'Invalid file format'}]}}};
 const errors=collectErrors(state);assert.equal(errors.length,2);
 const render=(child:ReturnType<typeof createElement>)=>renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:child}));
 const desk=render(createElement(ImportDesk,{state,act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}}));
 assert.ok(!desk.includes('unknown-files-prompt'));assert.ok(!desk.includes('Invalid file format'));
 const panel=render(createElement(ActivityPanel,{state,errors,act:()=>{},onClose:()=>{}}));
 assert.ok(panel.includes('unknown-files-prompt'));assert.ok(panel.includes('Invalid file format'));assert.ok(panel.includes('BROKEN.NEF'));
 state.sessionUnknownRules={dat:null};assert.equal(collectErrors(state).length,1);assert.equal(state.preferences.unknownRules.dat,undefined,'Session choices must not become persistent rules');
 state.preferences.unknownRules.dat=null;assert.equal(collectErrors(state).length,1);
});

test('metadata disclosure does not repeat parser error messages outside the error panel',async()=>{
 const {MetadataDialog}=await import('../renderer/RootApp');
 const markup=renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(MetadataDialog,{preview:{path:'/card/broken.NEF',loading:false,metadata:{fields:{'ExifTool:Error':'Invalid media payload','EXIF:Model':'Camera'}}},act:()=>{},onClose:()=>{}})}));
 assert.ok(!markup.includes('Invalid media payload'));assert.ok(markup.includes('EXIF:Model'));
});

test('mirror reviews list files moved to Removed by mirror with reasons, per destination, in every language', async () => {
  const { MirrorRemovals } = await import('../renderer/RootApp');
  const plan = (root: string, removals: {path:string;size:number;reason:'missing'|'changed'}[]) => ({ source: '/Volumes/CARD', root, entries: [], rootIdentity: root, drive: { folder: 'CARD', identity: 'id', name: 'CARD' }, removals });
  const review = { id: 'r', kind: 'import', backup: true, source: { id: 's', name: 'CARD', path: '/Volumes/CARD', transport: 'removable' }, plans: [plan('/A', [{ path: 'DCIM/old.NEF', size: 2_000_000, reason: 'missing' }]), plan('/B', [{ path: 'notes.txt', size: 1_000, reason: 'changed' }])] } as unknown as NonNullable<AppState['review']>;
  const expected = { en: ['2 files will be moved to Removed by mirror', 'No longer on the drive', 'Replaced by a newer version', 'Destination 2: '], ja: ['2 件のファイルが Removed by mirror へ移動されます', 'ドライブにもう存在しません', '新しいバージョンに置き換えられました'] } as const;
  for (const [language, labels] of Object.entries(expected)) {
    const markup = renderToStaticMarkup(createElement(I18nProvider, { language: language as 'en' | 'ja', children: createElement(MirrorRemovals, { review }) }));
    for (const label of labels) assert.ok(markup.includes(label), `${language}: ${label}`);
    assert.ok(markup.includes('DCIM/old.NEF') && markup.includes('notes.txt'));
  }
  const additive = { ...review, plans: review.plans.map(item => ({ ...item, removals: undefined })) };
  assert.equal(renderToStaticMarkup(createElement(I18nProvider, { language: 'en', children: createElement(MirrorRemovals, { review: additive }) })), '');
});

test('unknown files are skipped quietly by default and only become errors when the user chose Ask', async () => {
  const {collectErrors, SkippedFilesNotice, SettingsPage}=await import('../renderer/RootApp');
  const inventory={files:[
    {path:'/card/PRIVATE/SONY/SONYCARD.IND',relative:'PRIVATE/SONY/SONYCARD.IND',size:10,kind:'Other',included:false,system:{id:'sony-card-index',vendor:'Sony',label:'Card index'}},
    {path:'/card/AVF_INFO/AVIN0001.BNP',relative:'AVF_INFO/AVIN0001.BNP',size:10,kind:'Other',included:false,system:{id:'sony-avf',vendor:'Sony',label:'AVF info'}},
    {path:'/card/NOTE.XYZ',relative:'NOTE.XYZ',size:10,kind:'Other',included:false},
  ],media:0,companions:0,unknown:1,unknownExtensions:{xyz:1},system:2,systemKinds:{'sony-card-index':1,'sony-avf':1},bytes:0,elapsedMs:0} as Inventory;
  const preferences={language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:['/backup'],copyMode:'single',basePath:'photobackup',template:'{year}/{yyyymm}/{camera}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',allowFolderSource:false,unknownRules:{}} as AppState['preferences'];
  const state:AppState={preferences,sources:[{id:'card',name:'Card',path:'/card',transport:'storage'}],jobs:[],history:[],platform:'darwin',sourceInventories:{card:inventory}};
  assert.equal(collectErrors(state).length,0,'Skip is the default and raises no error');
  state.preferences={...preferences,unknownDefault:'other'};assert.equal(collectErrors(state).length,0);
  state.preferences={...preferences,unknownDefault:'ask'};assert.equal(collectErrors(state).length,1);
  for(const language of languages){
    const t=createTranslator(language),render=(child:ReturnType<typeof createElement>)=>renderToStaticMarkup(createElement(I18nProvider,{language,children:child}));
    const notice=render(createElement(SkippedFilesNotice,{inventory}));
    assert.ok(notice.includes(t('Skipped {count} camera system files ({names})',{count:2,names:'Sony Card index, Sony AVF info'})));
    assert.ok(notice.includes(t('{count} unknown files skipped',{count:1})));
    assert.ok(notice.includes('.xyz')&&notice.includes('Card index'));
    assert.ok(!notice.includes('unknown-files-prompt'),'The notice is informational, not the error prompt');
    for(const unknownDefault of ['skip','other','ask'] as const){
      const settings=render(createElement(SettingsPage,{state:{...state,preferences:{...preferences,unknownDefault}},act:()=>{},busy:false}));
      assert.ok(settings.includes('data-testid="unknown-default"'));
      for(const label of ['Skip automatically','Copy to Other files folder','Ask me'])assert.ok(settings.includes(t(label)));
      const pressed=settings.match(/data-testid="unknown-default"[\s\S]*?aria-pressed="true"[^>]*>([^<]*)</)?.[1];
      assert.equal(pressed,t({skip:'Skip automatically',other:'Copy to Other files folder',ask:'Ask me'}[unknownDefault]));
    }
  }
  assert.equal(renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(SkippedFilesNotice,{inventory:{...inventory,files:[],unknown:0,unknownExtensions:{},system:0,systemKinds:{}}})})),'');
});

test('companions of empty primary files are listed with a localized skipped summary', async () => {
  const { SkippedFilesNotice } = await import('../renderer/RootApp');
  const inventory = { files: [], media: 0, companions: 0, unknown: 0, unknownExtensions: {}, bytes: 0, elapsedMs: 0,
    skipped: [{ path: '/card/DCIM/100NIKON/DSC_0001.XMP', reason: 'emptyPrimary' }] } as Inventory;
  const summaries = {
    en: '1 skipped: companion to an empty file',
    'zh-Hans': '已跳过 1 个：空文件的伴随文件',
    'zh-Hant': '已略過 1 個：空檔案的隨附檔案',
    ja: '1 件をスキップ：空のファイルの関連ファイル',
  } as const;
  for (const language of languages) {
    const markup = renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(SkippedFilesNotice, { inventory }) }));
    assert.ok(markup.includes(summaries[language]), `${language}: localized empty-primary summary`);
    assert.ok(markup.includes('DSC_0001.XMP'), `${language}: companion filename`);
    if (language !== 'en') assert.ok(!markup.includes(summaries.en), `${language}: no English fallback`);
  }
});

test('drive details list camera and lens names from EXIF without counts in every language', async () => {
  const { SourceCameraInformation } = await import('../renderer/RootApp');
  const info = { status: 'complete', hints: [], checked: 4, total: 4, unknown: 0,
    models: [{ name: 'Nikon Z6III', files: 3, bytes: 90_000_000 }, { name: 'Sony ILCE-7M4', files: 1, bytes: 30_000_000 }],
    lenses: [{ name: 'NIKKOR Z 24-70mm f/4 S', files: 2, bytes: 60_000_000 }, { name: 'FE 35mm F1.8', files: 1, bytes: 30_000_000 }], noLens: 1 } satisfies SourceCameraInfo;
  for (const language of languages) {
    const t = createTranslator(language);
    const markup = renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(SourceCameraInformation, { sourceId: 'card', info }) }));
    assert.ok(markup.includes('<li>Nikon Z6III</li>') && markup.includes('<li>Sony ILCE-7M4</li>'));
    assert.ok(markup.includes('NIKKOR Z 24-70mm f/4 S') && markup.includes('FE 35mm F1.8'));
    assert.ok(!markup.includes('90 MB') && !markup.includes('60 MB') && !markup.includes('source-camera-counts'), `${language}: no counts or sizes`);
  }
  const empty = renderToStaticMarkup(createElement(I18nProvider, { language: 'en', children: createElement(SourceCameraInformation, { sourceId: 'card', info: { ...info, lenses: [], noLens: 0 } as typeof info }) }));
  assert.ok(empty.includes('No lens information in checked files.'));
});

test('source scans show listing progress, then determinate camera-metadata progress, in every language', async () => {
  const { ScanProgress } = await import('../renderer/RootApp');
  for (const language of languages) {
    const t = createTranslator(language), render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, { language, children: child }));
    const listing = render(createElement(ScanProgress, { sourceName: 'Card', listing: { files: 1200, bytes: 3_000_000_000 } }));
    assert.ok(listing.includes(t('Listing files…')) && listing.includes('progress-discovering'), `${language}: listing is indeterminate`);
    assert.ok(listing.includes(t('{count} files found · {size}', { count: (1200).toLocaleString(language), size: formatBytes(3_000_000_000, language) })));
    const reading = render(createElement(ScanProgress, { sourceName: 'Card', cameraInfo: { status: 'reading', hints: [], models: [], checked: 30, total: 120, unknown: 0 } }));
    assert.ok(reading.includes(t('Reading camera metadata: {checked}/{total}', { checked: 30, total: 120 })));
    assert.ok(reading.includes('aria-valuenow="25"') && !reading.includes('progress-discovering'), `${language}: metadata phase is determinate`);
  }
});

test('new drives prompt for a choice, unselected drives are excluded on their cards, and remembered drives can be forgotten', async () => {
  const { NewDrivePrompt, ImportDesk, TitlebarControls, RememberedDrives } = await import('../renderer/RootApp');
  const preferences = { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/backup'], copyMode: 'single', basePath: 'photobackup', template: '{year}/{yyyymm}/{camera}', mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'', allowFolderSource: false, unknownRules: {},
    rememberedDevices: { 'uuid-card': { name: 'NIKON Z6III', lastSelected: '2026-10-20T08:00:00.000Z' } } };
  const sources = [
    { id: 'card', name: 'NIKON Z6III', path: '/Volumes/NIKON', transport: 'storage', camera: true, total: 128_000_000_000, selected: true },
    { id: 'usb', name: 'Work stick', path: '/Volumes/WORK', transport: 'storage', camera: false, total: 64_000_000_000, selected: false },
  ];
  const state = { preferences, sources, jobs: [], history: [], platform: 'darwin', newDevices: ['usb'] } as unknown as AppState;
  const actions: unknown[] = [];
  const act = (action: unknown) => { actions.push(action); };
  const html = (text: string) => text.replaceAll("'", '&#x27;');
  for (const language of languages) {
    const t = createTranslator(language), render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, { language, children: child }));
    const prompt = render(createElement(NewDrivePrompt, { state, act }));
    assert.ok(prompt.includes('data-testid="new-drive-prompt"') && prompt.includes(html(t('Import from {name}?', { name: 'Work stick' }))) && !prompt.includes('NIKON Z6III'), `${language}: only unanswered new drives`);
    assert.ok(prompt.includes(t('No camera folders (DCIM) found.')));
    assert.ok(prompt.includes(t('Import from this drive')) && prompt.includes(html(t("Don't import"))));
    const desk = render(createElement(ImportDesk, { state, act, inspect: () => {}, onOrganization: () => {}, onSettings: () => {} }));
    const usbCard = desk.match(/<article data-source-id="usb"[\s\S]*?<\/article>/)?.[0] ?? '';
    const cardCard = desk.match(/<article data-source-id="card"[\s\S]*?<\/article>/)?.[0] ?? '';
    assert.ok(usbCard.includes('source-unselected') && usbCard.includes(html(t("Not selected · won't be imported"))), `${language}: excluded card is marked`);
    assert.ok(/data-testid="source-select" aria-pressed="false"/.test(usbCard) && usbCard.includes(t('Select')), `${language}: unselected drive offers Select`);
    assert.ok(/data-testid="source-select" aria-pressed="true"/.test(cardCard) && cardCard.includes(t('Selected')) && cardCard.includes('source-included'), `${language}: selected drive is marked`);
    assert.ok(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*?<\/svg>[^<]*<\/button>/.test(usbCard) && (usbCard.match(/<button[^>]*disabled/g) ?? []).length >= 3, `${language}: scan, review and import are disabled`);
    const controls = render(createElement(TitlebarControls, { state, act, errorCount: 0, onErrors: () => {} }));
    assert.ok(controls.includes(t('Start imports ({count})', { count: 1 })), `${language}: Start counts only selected drives`);
    const settings = render(createElement(RememberedDrives, { preferences: state.preferences, act }));
    assert.ok(settings.includes('data-testid="remembered-devices"') && settings.includes('NIKON Z6III') && settings.includes(t('Forget')));
  }
  const empty = renderToStaticMarkup(createElement(I18nProvider, { language: 'en', children: createElement(RememberedDrives, { preferences: { ...state.preferences, rememberedDevices: {} } as AppState['preferences'], act }) }));
  assert.ok(empty.includes('No remembered drives.'));
});

test('the import overview shows total progress and sizes keep their decimals', async () => {
  const { ImportDashboard } = await import('../renderer/RootApp');
  assert.equal(formatBytes(1_000_000_000_000, 'en'), '1.00 TB');
  assert.equal(formatBytes(994_700_000_000, 'en'), '994.7 GB');
  assert.equal(formatBytes(2_000_000_000, 'ja'), '2.0 GB');
  const source = { id: 'card', name: 'Card', path: '/card', transport: 'storage' as const };
  const state: AppState = { preferences: { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/backup'], copyMode: 'single', basePath: 'photobackup', template: '{year}/{yyyymm}/{camera}', mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'', allowFolderSource: false, unknownRules: {} }, sources: [source],
    jobs: [{ id: 'job', source, phase: 'copying', errors: [], backup: false, progress: { phase: 'copying', completed: 10, total: 40, bytes: 1_250_000_000, totalBytes: 5_000_000_000, speed: 100_000_000, file: 'a.NEF' } }], history: [], platform: 'darwin' };
  for (const language of languages) {
    const t = createTranslator(language);
    const markup = renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(ImportDashboard, { state, act: () => {} }) }));
    assert.ok(markup.includes('data-testid="total-progress"') && markup.includes(t('Total progress')) && markup.includes('37%'), `${language}: total progress`);
    assert.ok(markup.includes(t('of {size} planned', { size: formatBytes(5_000_000_000, language) })) && markup.includes('aria-valuenow="38"'));
  }
});

test('drives pause and continue individually, Start becomes Pause while importing, and ignored drives can be restored', async () => {
  const { ImportDesk, TitlebarControls, DrivesPage } = await import('../renderer/RootApp');
  const card = { id: 'card', name: 'Card', path: '/Volumes/CARD', transport: 'storage' as const, selected: true };
  const usb = { id: 'usb', name: 'Work stick', path: '/Volumes/WORK', transport: 'storage' as const, selected: false };
  const base: AppState = { preferences: { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/backup'], copyMode: 'single', basePath: 'photobackup', template: '{year}/{yyyymm}/{camera}', mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'', allowFolderSource: false, unknownRules: {},
    ignoredDevices: { usb: { name: 'Work stick', ignoredAt: '2026-10-21T08:00:00.000Z' } }, rememberedDevices: { card: { name: 'Card', lastSelected: '2026-10-21T08:00:00.000Z' } } }, sources: [card, usb], jobs: [], history: [], platform: 'darwin' };
  const running: AppState = { ...base, jobs: [{ id: 'j', source: card, phase: 'copying', errors: [], backup: false }] };
  const paused: AppState = { ...base, jobs: [{ id: 'j', source: card, phase: 'stopped', paused: true, errors: [], backup: false }] };
  for (const language of languages) {
    const t = createTranslator(language), render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, { language, children: child }));
    const desk = (state: AppState) => render(createElement(ImportDesk, { state, act: () => {}, inspect: () => {}, onOrganization: () => {}, onSettings: () => {} })).match(/<article data-source-id="card"[\s\S]*?<\/article>/)?.[0] ?? '';
    assert.ok(desk(running).includes(t('Pause {name}', { name: 'Card' })), `${language}: running drive offers Pause`);
    assert.ok(desk(paused).includes(t('Paused')) && desk(paused).includes(t('Continue')), `${language}: paused drive offers Continue`);
    const controls = render(createElement(TitlebarControls, { state: running, act: () => {}, errorCount: 0, onErrors: () => {} }));
    assert.ok(controls.includes(t('Pause')) && !controls.includes(t('Start imports')), `${language}: Start becomes Pause`);
    const drives = render(createElement(DrivesPage, { state: base, act: () => {} }));
    assert.ok(drives.includes('data-testid="ignored-devices"') && drives.includes(t('Stop ignoring')) && drives.includes('data-testid="remembered-devices"') && drives.includes(t('Connected drives')));
  }
});

test('completed organizations explain retained originals and confirm before releasing them', async () => {
  const { RetainedOriginals, ReleaseConfirm } = await import('../renderer/RootApp');
  type Recovery = NonNullable<AppState['organizationRecovery']>[number];
  const job: Recovery = { id: 'o1', root: '/backup/photobackup', status: 'complete', files: 2592, completed: 2592, retainedFiles: 2592, retainedBytes: 49_000_000_000, finalizable: true, undoable: true };
  for (const language of languages) {
    const t = createTranslator(language), render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, { language, children: child }));
    const html = (text: string) => text.replaceAll("'", '&#x27;');
    const size = formatBytes(49_000_000_000, language);
    const card = render(createElement(RetainedOriginals, { job, act: () => {}, busy: false }));
    assert.ok(card.includes('data-testid="organization-retained"') && card.includes(t('{count} originals ({size}) kept for undo.', { count: (2592).toLocaleString(language), size })), `${language}: retained explanation`);
    assert.ok(card.includes(t('Undo organization')) && card.includes(t('Release {size}', { size })));
    const confirm = render(createElement(ReleaseConfirm, { size, root: job.root, onCancel: () => {}, onConfirm: () => {} }));
    assert.ok(confirm.includes('data-testid="release-confirm"') && confirm.includes(html(t("This deletes the kept originals. Undo won't be possible."))) && confirm.includes(t('Cancel')));
  }
  const renamed = renderToStaticMarkup(createElement(I18nProvider, { language: 'en', children: createElement(RetainedOriginals, { job: { ...job, retainedFiles: 0, retainedBytes: 0, finalizable: false }, act: () => {}, busy: false }) }));
  assert.ok(renamed.includes('Undo organization') && !renamed.includes('Release') && !renamed.includes('kept for undo'), 'Same-volume renames keep nothing but can be undone');
  const none = renderToStaticMarkup(createElement(I18nProvider, { language: 'en', children: createElement(RetainedOriginals, { job: { ...job, retainedFiles: 0, undoable: false }, act: () => {}, busy: false }) }));
  assert.ok(none.includes('Delete recovery files') && !none.includes('Undo organization') && !none.includes('Release'), 'Nothing kept and nothing to undo leaves only Delete recovery files');
  const pendingNone = renderToStaticMarkup(createElement(I18nProvider, { language: 'en', children: createElement(RetainedOriginals, { job: { ...job, status: 'pending', retainedFiles: 0, undoable: false }, act: () => {}, busy: false }) }));
  assert.equal(pendingNone, '', 'An unfinished organization with nothing kept and nothing to undo shows no card');
  const interrupted = renderToStaticMarkup(createElement(I18nProvider, { language: 'en', children: createElement(RetainedOriginals, { job: { ...job, status: 'pending', completed: 900, retainedFiles: 0, finalizable: false }, act: () => {}, busy: false }) }));
  assert.ok(interrupted.includes('Undo organization'), 'A partly moved or interrupted undo can always be finished');
  const noUndo = renderToStaticMarkup(createElement(I18nProvider, { language: 'en', children: createElement(RetainedOriginals, { job: { ...job, undoable: false }, act: () => {}, busy: false }) }));
  assert.ok(!noUndo.includes('Undo organization'));
});

test('copy verification is a Settings toggle that defaults on, with a dashboard notice when off', async () => {
  const { SettingsPage, ImportDashboard } = await import('../renderer/RootApp');
  const preferences: AppState['preferences'] = { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/backup'], copyMode: 'single', basePath: 'photobackup', template: '{year}/{yyyymm}/{camera}', mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'', allowFolderSource: false, unknownRules: {} };
  const state: AppState = { preferences, sources: [], jobs: [], history: [], platform: 'darwin' };
  for (const language of languages) {
    const t = createTranslator(language), render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, { language, children: child }));
    const toggle = (markup: string) => markup.split('<label class="switch-row').map(chunk => chunk.slice(0, chunk.indexOf('</label>'))).find(row => row.includes(t('Verify each copy after copying'))) ?? '';
    const on = render(createElement(SettingsPage, { state, act: () => {}, busy: false }));
    assert.ok(on.includes(t('Verify each copy after copying')) && /checked=""/.test(toggle(on)), `${language}: defaults on`);
    const offState = { ...state, preferences: { ...preferences, verifyCopies: false } };
    assert.ok(!/checked=""/.test(toggle(render(createElement(SettingsPage, { state: offState, act: () => {}, busy: false })))), `${language}: can be off`);
    assert.ok(render(createElement(ImportDashboard, { state: offState, act: () => {} })).includes(t('Verification after copy is off')));
    assert.ok(!render(createElement(ImportDashboard, { state, act: () => {} })).includes('verification-off'));
  }
});

test('the per-drive file counter names its phase', async () => {
  const { ImportDesk } = await import('../renderer/RootApp');
  const source = { id: 'card', name: 'Card', path: '/card', transport: 'storage' as const, selected: true };
  const job = (phase: 'copying' | 'verifying', completed: number, failed = 0) => ({ id: 'j', source, phase, errors: [], backup: false, progress: { phase, completed, total: 40, bytes: 1, totalBytes: 2, speed: 1, file: 'a', failed } });
  for (const language of languages) {
    const t = createTranslator(language);
    const render = (phase: 'copying' | 'verifying', completed: number, failed = 0) => renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(ImportDesk, { state: { preferences: { language, appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/b'], copyMode: 'single', basePath: 'p', template: '{year}', mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'', allowFolderSource: false, unknownRules: {} }, sources: [source], jobs: [job(phase, completed, failed)], history: [], platform: 'darwin' }, act: () => {}, inspect: () => {}, onOrganization: () => {}, onSettings: () => {} }) }));
    assert.ok(render('copying', 12).includes(t('{completed} of {total} files copied', { completed: 12, total: 40 })), `${language}: copying`);
    assert.ok(render('verifying', 5).includes(t('{completed} of {total} files verified', { completed: 5, total: 40 })), `${language}: verifying`);
    assert.ok(!render('copying', 12).includes('progress-failed'), `${language}: no failed note without failures`);
    assert.ok(render('verifying', 30, 2).includes(t('{count} failed', { count: 2 })), `${language}: failures are shown`);
  }
});

test('every card shows Scanning, Copying and Verifying with a checkmark after each finished step', async () => {
  const { sourceStepStates, SourceSteps } = await import('../renderer/RootApp');
  const source = { id: 'card', name: 'Card', path: '/card', transport: 'storage' as const };
  const job = (phase: Job['phase'], progressPhase?: 'copying' | 'verifying', paused = false): Job => ({ id: 'j', source, phase, paused, errors: [], backup: false, ...(progressPhase ? { progress: { phase: progressPhase, completed: 1, total: 2, bytes: 1, totalBytes: 2, speed: 1, file: 'a' } } : {}) });
  const inventory = { files: [], media: 0, companions: 0, unknown: 0, bytes: 0, unknownExtensions: {}, elapsedMs: 0 } as unknown as Inventory;
  assert.deepEqual(sourceStepStates(undefined, undefined, false, false), ['pending', 'pending', 'pending']);
  assert.deepEqual(sourceStepStates(undefined, undefined, true, false), ['active', 'pending', 'pending']);
  assert.deepEqual(sourceStepStates(undefined, inventory, false, false), ['done', 'pending', 'pending']);
  assert.deepEqual(sourceStepStates(job('discovering'), undefined, false, false), ['active', 'pending', 'pending']);
  assert.deepEqual(sourceStepStates(job('copying', 'copying'), inventory, false, false), ['done', 'active', 'pending']);
  assert.deepEqual(sourceStepStates(job('verifying', 'verifying'), inventory, false, false), ['done', 'done', 'active']);
  assert.deepEqual(sourceStepStates(job('complete', 'verifying'), inventory, false, false), ['done', 'done', 'done']);
  assert.deepEqual(sourceStepStates(job('stopped', 'copying', true), inventory, false, false), ['done', 'paused', 'pending']);
  assert.deepEqual(sourceStepStates(job('error', 'verifying'), inventory, false, false), ['done', 'done', 'error']);
  assert.deepEqual(sourceStepStates(job('complete', 'copying'), inventory, false, true), ['done', 'done', 'skipped'], 'Verification turned off is shown as skipped');
  for (const language of languages) {
    const t = createTranslator(language);
    const markup = renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(SourceSteps, { job: job('verifying', 'verifying'), inventory, scanning: false, verifyOff: false }) }));
    for (const label of ['Scanning', 'Copying', 'Verifying']) assert.ok(markup.includes(t(label)), `${language}: ${label}`);
    assert.equal((markup.match(/data-state="done"/g) ?? []).length, 2);
    assert.equal((markup.match(/lucide-check\b/g) ?? []).length, 2, `${language}: a checkmark after each finished step`);
    assert.ok(markup.includes('aria-current="step"'));
  }
});

test('a card with nothing new finishes as Already imported, and a backup inside the source is noted', async () => {
  const { ImportDesk } = await import('../renderer/RootApp');
  const source = { id: 'a006', name: 'A006', path: '/Volumes/A006', transport: 'storage' as const, selected: true };
  const preferences: AppState['preferences'] = { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/Volumes/A006'], copyMode: 'single', basePath: 'photobackup', template: '{year}', mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'', allowFolderSource: false, unknownRules: {} };
  const job: Job = { id: 'j', source, phase: 'complete', alreadyImported: true, detail: message('job.alreadyImported', { count: 12 }), errors: [], backup: false, progress: { phase: 'verifying', completed: 12, total: 12, bytes: 0, totalBytes: 0, speed: 0, file: '' } };
  for (const language of languages) {
    const t = createTranslator(language);
    const markup = renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(ImportDesk, { state: { preferences: { ...preferences, language }, sources: [source], jobs: [job], history: [], platform: 'darwin' }, act: () => {}, inspect: () => {}, onOrganization: () => {}, onSettings: () => {} }) }));
    assert.ok(markup.includes(t('Already imported')) && markup.includes('data-testid="already-imported"') && markup.includes('aria-valuenow="100"'), `${language}: calm completed state`);
    assert.ok(markup.includes(t('All {count} files are in the backup and verified', { count: 12 })));
    assert.ok(markup.includes(t("The backup folder {folder} isn't scanned as a source", { folder: 'photobackup' }).replaceAll("'", '&#x27;')), `${language}: backup exclusion note`);
  }
  const other = renderToStaticMarkup(createElement(I18nProvider, { language: 'en', children: createElement(ImportDesk, { state: { preferences: { ...preferences, destinations: ['/Volumes/A0060'] }, sources: [source], jobs: [], history: [], platform: 'darwin' }, act: () => {}, inspect: () => {}, onOrganization: () => {}, onSettings: () => {} }) }));
  assert.ok(!other.includes('backup-excluded'), 'A sibling path with the same prefix is not inside the source');
});

test('one drive can be continued or started while another drive is importing; an open review still blocks it', async () => {
  const { ImportDesk } = await import('../renderer/RootApp');
  const busy = { id: 'busy', name: 'Busy', path: '/Volumes/BUSY', transport: 'storage' as const, selected: true };
  const paused = { id: 'paused', name: 'Paused', path: '/Volumes/PAUSED', transport: 'storage' as const, selected: true };
  const idle = { id: 'idle', name: 'Idle', path: '/Volumes/IDLE', transport: 'storage' as const, selected: true };
  const preferences: AppState['preferences'] = { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/backup'], copyMode: 'single', basePath: 'p', template: '{year}', mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'', allowFolderSource: false, unknownRules: {} };
  const jobs: Job[] = [
    { id: 'b', source: busy, phase: 'copying', errors: [], backup: false, progress: { phase: 'copying', completed: 1, total: 9, bytes: 1, totalBytes: 9, speed: 1, file: 'a' } },
    { id: 'p', source: paused, phase: 'stopped', paused: true, errors: [], backup: false },
  ];
  const card = (markup: string, id: string) => markup.match(new RegExp(`<article data-source-id="${id}"[\\s\\S]*?</article>`))?.[0] ?? '';
  const startButton = (html: string, label: string) => html.match(new RegExp(`<button[^>]*>(?:(?!</button>)[\\s\\S])*?${label}</button>`))?.[0] ?? '';
  const render = (state: AppState) => renderToStaticMarkup(createElement(I18nProvider, { language: 'en', children: createElement(ImportDesk, { state, act: () => {}, inspect: () => {}, onOrganization: () => {}, onSettings: () => {} }) }));
  const running = render({ preferences, sources: [busy, paused, idle], jobs, history: [], platform: 'darwin' });
  assert.ok(startButton(card(running, 'paused'), 'Continue') && !/disabled/.test(startButton(card(running, 'paused'), 'Continue')), 'Continue stays available while another drive imports');
  assert.ok(startButton(card(running, 'idle'), 'Import') && !/disabled/.test(startButton(card(running, 'idle'), 'Import')), 'Import stays available while another drive imports');
  const reviewing = render({ preferences, sources: [busy, paused, idle], jobs, history: [], platform: 'darwin', busyReview: true });
  assert.ok(/disabled/.test(startButton(card(reviewing, 'idle'), 'Import')), 'An open review still blocks starting');
});

test('any folder can be organized in place from the Organization page', async () => {
  const { Organization } = await import('../renderer/RootApp');
  const preferences: AppState['preferences'] = { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/backup'], copyMode: 'single', basePath: 'p', template: '{year}', mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'', allowFolderSource: false, unknownRules: {} };
  for (const language of languages) {
    const t = createTranslator(language), html = (text: string) => text.replaceAll("'", '&#x27;');
    const idle = renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(Organization, { state: { preferences, sources: [], jobs: [], history: [], platform: 'darwin' }, act: () => {}, busy: false }) }));
    const card = idle.match(/data-testid="organize-folder"[\s\S]*?<\/section>/)?.[0] ?? '';
    assert.ok(card.includes(t('Organize a folder')) && card.includes(html(t("Sorts a folder's files into your folder structure, inside that folder."))), `${language}: card text`);
    assert.ok(/<button[^>]*>(?:(?!<\/button>)[\s\S])*?Choose folder|<button(?![^>]*disabled)[^>]*>/.test(card) && !/<button[^>]*disabled/.test(card), `${language}: enabled when idle`);
    const busy = renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(Organization, { state: { preferences, sources: [], jobs: [{ id: 'o', source: { id: 'l', name: 'Library organization', path: '/backup', transport: 'folder' }, phase: 'copying', organization: true, errors: [], backup: false }], history: [], platform: 'darwin' }, act: () => {}, busy: true }) }));
    assert.ok(/<button[^>]*disabled/.test(busy.match(/data-testid="organize-folder"[\s\S]*?<\/section>/)?.[0] ?? ''), `${language}: disabled while another organization runs`);
  }
});

test('sidebar drives show capacity, free space and a 1·2·3 status; destinations show a green or red dot', async () => {
  const { SidebarSources, SidebarDestinations } = await import('../renderer/RootApp');
  const GB = 1e9;
  const card = { id: 'card', name: 'Card', path: '/Volumes/CARD', transport: 'storage' as const, selected: true, total: 128 * GB, free: 40 * GB };
  const usb = { id: 'usb', name: 'USB camera', path: '', transport: 'camera' as const, selected: true };
  const preferences: AppState['preferences'] = { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/Volumes/BACKUP', '/Volumes/SECOND'], copyMode: 'mirror', basePath: 'p', template: '{year}', mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'', allowFolderSource: false, unknownRules: {} };
  const state: AppState = { preferences, sources: [card, usb], history: [], platform: 'darwin',
    jobs: [{ id: 'j', source: card, phase: 'copying', errors: [], backup: false, progress: { phase: 'copying', completed: 1, total: 4, bytes: 1, totalBytes: 4, speed: 1, file: 'a' } }],
    destinationStatus: [{ path: '/Volumes/BACKUP', available: true, total: 2000 * GB, free: 812.4 * GB }, { path: '/Volumes/SECOND', available: false }] };
  for (const language of languages) {
    const t = createTranslator(language), render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, { language, children: child }));
    const sources = render(createElement(SidebarSources, { state, onOpen: () => {} }));
    assert.ok(sources.includes(t('{free} free of {total}', { free: formatBytes(40 * GB, language), total: formatBytes(128 * GB, language) })), `${language}: free of total`);
    assert.ok(sources.includes('aria-valuenow="69"'), `${language}: capacity meter`);
    assert.ok(sources.includes(t('Capacity unavailable over USB')), `${language}: camera without capacity`);
    const cardSteps = sources.match(/<li[^>]*data-testid="sidebar-source"[\s\S]*?<\/li>/)?.[0] ?? '';
    assert.deepEqual([...cardSteps.matchAll(/<i data-state="(\w+)"/g)].map(match => match[1]), ['done', 'active', 'pending'], `${language}: 1·2·3 status`);
    assert.ok(cardSteps.includes(t('In progress')), `${language}: localized status label`);
    const destinations = render(createElement(SidebarDestinations, { state }));
    assert.ok(destinations.includes('status-dot is-online') && destinations.includes('status-dot is-offline'), `${language}: green and red dots`);
    assert.ok(destinations.includes(t('{free} free of {total}', { free: formatBytes(812.4 * GB, language), total: formatBytes(2000 * GB, language) })) && destinations.includes(t('Drive offline')));
  }
});

test('organizing removes emptied source folders by default, saved preferences cannot turn it off, and a run can', async () => {
  const { Organization } = await import('../renderer/RootApp');
  const preferences: AppState['preferences'] = { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/Volumes/A006'], copyMode: 'single', basePath: 'photobackup', template: '{year}', mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'', allowFolderSource: false, unknownRules: {} };
  const toggle = (markup: string, id = 'remove-empty-folders') => markup.match(new RegExp(`data-testid="${id}"[\\s\\S]*?</label>`))?.[0] ?? '';
  for (const language of languages) {
    const t = createTranslator(language), render = (organizeOptions?: AppState['organizeOptions'], saved = true) => renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(Organization, { state: { preferences: { ...preferences, removeEmptySourceFolders: saved, releaseDuplicatesAfterOrganizing: saved }, ...(organizeOptions ? { organizeOptions } : {}), sources: [], jobs: [], history: [], platform: 'darwin' }, act: () => {}, busy: false }) }));
    assert.ok(toggle(render()).includes(t('Remove emptied source folders')) && /checked=""/.test(toggle(render())), `${language}: on by default`);
    assert.ok(/checked=""/.test(toggle(render(undefined, false))) && /checked=""/.test(toggle(render(undefined, false), 'release-duplicates')), `${language}: saved preferences cannot turn it off`);
    assert.ok(!/checked=""/.test(toggle(render({ removeEmptyFolders: false, releaseDuplicates: true }))), `${language}: this run can turn it off`);
    assert.ok(render().includes(t('Organize: move, source removed')), `${language}: mode label`);
  }
});

test('scans show a percentage of used space, organizations show n of x with %, and unanswered new drives are marked', async () => {
  const { ScanProgress, OrganizationProgress, ImportDesk } = await import('../renderer/RootApp');
  const source = { id: 'stick', name: 'Work stick', path: '/Volumes/WORK', transport: 'storage' as const, selected: false, total: 100e9, free: 60e9 };
  const preferences: AppState['preferences'] = { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/b'], copyMode: 'single', basePath: 'p', template: '{year}', mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'', allowFolderSource: false, unknownRules: {} };
  const org = (progress?: Job['progress']): Job => ({ id: 'o', source: { id: 'library:/b', name: 'Library organization', path: '/b', transport: 'folder' }, organization: true, phase: 'copying', errors: [], backup: false, ...(progress ? { progress } : {}) });
  for (const language of languages) {
    const t = createTranslator(language), render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, { language, children: child }));
    const scan = render(createElement(ScanProgress, { sourceName: 'Card', listing: { files: 500, bytes: 10e9 }, usedBytes: 40e9 }));
    assert.ok(scan.includes('25%') && scan.includes('aria-valuenow="25"'), `${language}: listing % of used space`);
    const planning = render(createElement(OrganizationProgress, { job: org() }));
    assert.ok(planning.includes(t('Starting…')), `${language}: planning label`);
    const moving = render(createElement(OrganizationProgress, { job: org({ phase: 'copying', completed: 30, total: 120, bytes: 1, totalBytes: 4, speed: 0, file: '' }) }));
    assert.ok(moving.includes(t('{completed} of {total} files organized', { completed: 30, total: 120 })) && moving.includes('25%'), `${language}: n of x and %`);
    const desk = render(createElement(ImportDesk, { state: { preferences: { ...preferences, language }, sources: [source], jobs: [], history: [], platform: 'darwin', newDevices: ['stick'] }, act: () => {}, needsChoice: ['stick'], inspect: () => {}, onOrganization: () => {}, onSettings: () => {} }));
    assert.ok(desk.includes('source-needs-choice') && desk.includes('data-testid="needs-choice"') && desk.includes(t('Choose whether to import this drive.')), `${language}: red card after dismissing`);
  }
});

test('errors are explained in plain language, grouped by drive, and keep the technical details', async () => {
  const { explainError, collectErrors, ActivityPanel } = await import('../renderer/RootApp');
  assert.equal(explainError(text('ENOSPC: no space left on device, write')).title, 'Not enough space on the destination.');
  assert.equal(explainError(text('EIO: i/o error, read')).severity, 'error');
  assert.equal(explainError(text('Source changed; scan again: /card/A.NEF')).title, 'Files on the drive changed during the import.');
  assert.equal(explainError(text('/card/A.NEF: Bad format'), 'metadata').severity, 'warning');
  assert.equal(explainError(text('Something odd happened. More text.')).title, 'Something odd happened.');
  const card = { id: 'card', name: 'Card one', path: '/card', transport: 'storage' as const };
  const state: AppState = { preferences: { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/b'], copyMode: 'single', basePath: 'p', template: '{year}', mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'', allowFolderSource: false, unknownRules: {} }, sources: [card], history: [], platform: 'darwin',
    jobs: [{ id: 'j', source: card, phase: 'error', errors: [text('EIO: i/o error, read /card/DSC_1.NEF'), text('ENOSPC: no space left on device')], backup: false }] };
  const errors = collectErrors(state);
  assert.ok(errors.every(error => error.kind === 'source' && error.sourceId === 'card'));
  for (const language of languages) {
    const t = createTranslator(language);
    const panel = renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(ActivityPanel, { state, errors, act: () => {}, onClose: () => {}, onOpenSource: () => {} }) }));
    assert.ok(panel.includes(t('The drive reported a read or write error.')) && panel.includes(t('Free up space or choose another destination.')), `${language}: plain explanations`);
    assert.ok(panel.includes(t('{count} issues', { count: 2 })) && panel.includes(t('Show drive')), `${language}: grouped with a jump to the drive`);
    assert.ok(panel.includes('EIO: i/o error, read /card/DSC_1.NEF') && panel.includes(t('Copy all details')), `${language}: technical details kept`);
  }
});

test('the backup folder can be organized by button, shows misplaced files, and the check can be Off, Ask or Automatic', async () => {
  const { Organization, ImportDesk } = await import('../renderer/RootApp');
  const preferences: AppState['preferences'] = { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/Volumes/A006'], copyMode: 'single', basePath: 'photobackup', template: '{year}', mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'', allowFolderSource: false, unknownRules: {} };
  const misplaced = { '/Volumes/A006': { count: 1234, bytes: 5.6e9, checkedAt: '2026-10-21T10:00:00Z' } };
  const card = (markup: string) => markup.match(/data-testid="backup-check"[\s\S]*?<\/section>/)?.[0] ?? '';
  for (const language of languages) {
    const t = createTranslator(language), render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, { language, children: child }));
    const actions: unknown[] = [];
    const page = (state: Partial<AppState>, busy = false) => card(render(createElement(Organization, { state: { preferences, sources: [], jobs: [], history: [], platform: 'darwin', ...state }, act: action => actions.push(action), busy })));
    const clean = page({ misplacedFiles: { '/Volumes/A006': { count: 0, bytes: 0, checkedAt: '2026-10-21T10:00:00Z' } } });
    assert.ok(clean.includes(t('Organize backup')) && !/<button[^>]*button-primary[^>]*>(?:(?!<\/button>)[\s\S])*?Organize backup/.test(clean), `${language}: button is available, not emphasized, when in order`);
    assert.ok(clean.includes(t('Backup folder is in order.')), `${language}: in order`);
    assert.ok(/aria-pressed="true"[^>]*>(?:(?!<\/button>)[\s\S])*?/.test(clean) && clean.includes(t('Ask')) && clean.includes(t('Off')) && clean.includes(t('Automatic')), `${language}: three modes`);
    assert.ok(clean.match(/<button[^>]*aria-pressed="true"[^>]*>([\s\S]*?)<\/button>/)?.[1].includes(t('Ask')), `${language}: Ask is the default`);
    const found = page({ misplacedFiles: misplaced });
    assert.ok(found.includes(t('{count} files outside your folder structure', { count: formatNumber(1234, language) })) && found.includes(formatBytes(5.6e9, language)), `${language}: count and size`);
    assert.ok(/<button[^>]*button-primary/.test(found), `${language}: primary when files are misplaced`);
    const auto = page({ preferences: { ...preferences, autoOrganizeBackup: 'auto' }, misplacedFiles: misplaced });
    assert.ok(auto.match(/<button[^>]*aria-pressed="true"[^>]*>([\s\S]*?)<\/button>/)?.[1].includes(t('Automatic')), `${language}: auto selected`);
    const off = page({ preferences: { ...preferences, autoOrganizeBackup: 'off' }, misplacedFiles: misplaced });
    assert.ok(!off.includes(t('Backup folder is in order.')) && !/data-testid="misplaced-files"/.test(off) && off.includes(t('Organize backup')), `${language}: off hides findings but keeps the button`);
    const running = page({ jobs: [{ id: 'o', source: { id: 'l', name: 'Backup organization', path: '/Volumes/A006', transport: 'folder' }, phase: 'copying', organization: true, errors: [], backup: false }] }, true);
    assert.ok(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*?Organize backup|<button[^>]*disabled/.test(running), `${language}: disabled while organizing`);
    const desk = render(createElement(ImportDesk, { state: { preferences, sources: [], jobs: [], history: [], platform: 'darwin', misplacedFiles: misplaced }, act: () => {}, inspect: () => {}, onOrganization: () => {}, onSettings: () => {} }));
    assert.ok(/data-testid="destination-misplaced"/.test(desk), `${language}: destination shows misplaced files on the desk`);
  }
});

test('planning shows files checked or read with a percentage, and jobs show elapsed time while running and when finished', async () => {
  const { ImportDesk, OrganizationProgress, formatDuration } = await import('../renderer/RootApp');
  const card = { id: 'card', name: 'Card', path: '/Volumes/CARD', transport: 'storage' as const, selected: true, total: 128e9, free: 40e9 };
  const preferences: AppState['preferences'] = { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/b'], copyMode: 'single', basePath: 'p', template: '{year}', mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'', allowFolderSource: false, unknownRules: {} };
  const start = '2026-10-21T10:00:00.000Z', end = '2026-10-21T11:02:05.000Z';
  assert.equal(formatDuration(3725000), '1:02:05'); assert.equal(formatDuration(65000), '1:05'); assert.equal(formatDuration(4000), '0:04');
  for (const language of languages) {
    const t = createTranslator(language), render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, { language, children: child }));
    const desk = (job: Job) => render(createElement(ImportDesk, { state: { preferences, sources: [card], jobs: [job], history: [], platform: 'darwin' }, act: () => {}, inspect: () => {}, onOrganization: () => {}, onSettings: () => {} }));
    const planning = desk({ id: 'j', source: card, phase: 'verifying', errors: [], backup: false, startedAt: new Date(Date.now() - 65000).toISOString(), progress: { phase: 'planning', step: 'checking', completed: 50, total: 200, bytes: 1, totalBytes: 4, speed: 0, file: 'a' } });
    assert.ok(planning.includes(t('{completed} of {total} files checked', { completed: '50', total: '200' })), `${language}: files checked`);
    assert.ok(planning.includes('aria-valuenow="25"'), `${language}: planning bar follows files checked`);
    assert.match(planning, /data-testid="elapsed"/, `${language}: elapsed while running`);
    const done = desk({ id: 'j', source: card, phase: 'complete', errors: [], backup: false, startedAt: start, phaseStartedAt: end, progress: { phase: 'verifying', completed: 4, total: 4, bytes: 4, totalBytes: 4, speed: 0, file: '' } });
    assert.ok(done.includes(t('Took {time}', { time: '1:02:05' })), `${language}: total time when finished`);
    const organizing: Job = { id: 'o', source: { id: 'l', name: 'Backup organization', path: '/b', transport: 'folder' }, phase: 'verifying', organization: true, errors: [], backup: false, startedAt: start, progress: { phase: 'planning', step: 'reading', completed: 3, total: 10, bytes: 30, totalBytes: 40, speed: 0, file: 'x' } };
    const reading = render(createElement(OrganizationProgress, { job: organizing }));
    assert.ok(reading.includes(t('{completed} of {total} files read · {size} of {totalSize}', { completed: '3', total: '10', size: formatBytes(30, language), totalSize: formatBytes(40, language) })) && reading.includes('75%'), `${language}: reading shows bytes and uses them for %`);
    const checking = render(createElement(OrganizationProgress, { job: { ...organizing, progress: { ...organizing.progress!, step: 'checking' } } }));
    assert.ok(checking.includes(t('{completed} of {total} files checked', { completed: '3', total: '10' })) && checking.includes('30%'), `${language}: checking uses files for %`);
  }
});

test('the drive popup shows when a reconnected drive last finished a scan or a verified import', async () => {
  const { NewDrivePrompt, formatWhen } = await import('../renderer/RootApp');
  const preferences: AppState['preferences'] = { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/b'], copyMode: 'single', basePath: 'p', template: '{year}', mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'', allowFolderSource: false, unknownRules: {},
    deviceHistory: { known: { name: 'Known', lastScanCompleted: '2026-10-19T08:30:00Z', lastImportVerified: '2026-10-20T21:15:00Z' }, fresh: { name: 'Fresh', lastScanCompleted: '2026-10-18T09:00:00Z' } } };
  const known = { id: 'known', name: 'Known', path: '/Volumes/KNOWN', transport: 'storage' as const, selected: true };
  const fresh = { id: 'fresh', name: 'Fresh', path: '/Volumes/FRESH', transport: 'storage' as const, selected: false };
  for (const language of languages) {
    const t = createTranslator(language), render = (state: Partial<AppState>) => renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(NewDrivePrompt, { state: { preferences, sources: [known, fresh], jobs: [], history: [], platform: 'darwin', ...state }, act: () => {} }) }));
    const back = render({ reconnectedDevices: ['known'] });
    const row = back.match(/<li[^>]*data-source-id="known"[\s\S]*$/)?.[0] ?? '';
    assert.ok(row.includes(t('Last import verified {date}', { date: formatWhen('2026-10-20T21:15:00Z', language) })) && row.includes(t('Last scan finished {date}', { date: formatWhen('2026-10-19T08:30:00Z', language) })), `${language}: both times`);
    assert.ok(back.includes(t('Drive reconnected')), `${language}: reconnected heading`);
    assert.ok(row.includes(t('Import now')) && row.includes(t('OK')), `${language}: remembered drive offers Import now and OK`);
    const both = render({ newDevices: ['fresh'], reconnectedDevices: ['fresh'] });
    const freshRow = both.match(/<li[^>]*data-source-id="fresh"[\s\S]*$/)?.[0] ?? '';
    assert.ok(freshRow.includes(t('Last scan finished {date}', { date: formatWhen('2026-10-18T09:00:00Z', language) })) && !freshRow.includes(t('Last import verified {date}', { date: '@@' }).split('@@')[0]), `${language}: new drive with history shows its scan`);
    assert.ok(freshRow.includes(t('Import from this drive')) && freshRow.includes(t("Don't import").replaceAll("'", '&#x27;')), `${language}: still needs a choice`);
  }
});

test('a drive card can be moved to the top of the queue, and cards follow the source order', async () => {
  const { ImportDesk } = await import('../renderer/RootApp');
  const preferences: AppState['preferences'] = { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 1, destinations: ['/b'], copyMode: 'single', basePath: 'p', template: '{year}', mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'', allowFolderSource: false, unknownRules: {} };
  const a = { id: 'a', name: 'Alpha', path: '/Volumes/A', transport: 'storage' as const, selected: true };
  const b = { id: 'b', name: 'Bravo', path: '/Volumes/B', transport: 'storage' as const, selected: true };
  const c = { id: 'c', name: 'Charlie', path: '/Volumes/C', transport: 'storage' as const, selected: true };
  for (const language of languages) {
    const t = createTranslator(language);
    const markup = renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(ImportDesk, { state: { preferences, sources: [c, a, b], history: [], platform: 'darwin',
      jobs: [{ id: 'ja', source: a, phase: 'copying', errors: [], backup: false }, { id: 'jb', source: b, phase: 'queued', errors: [], backup: false }] }, act: () => {}, inspect: () => {}, onOrganization: () => {}, onSettings: () => {} }) }));
    assert.deepEqual([...markup.matchAll(/<article data-source-id="(\w)"/g)].map(m => m[1]), ['c', 'a', 'b'], `${language}: source order`);
    const cardOf = (id: string) => markup.match(new RegExp(`<article data-source-id="${id}"[\\s\\S]*?</article>`))?.[0] ?? '';
    assert.ok(cardOf('b').includes(`aria-label="${t('Move {name} to the top', { name: 'Bravo' })}"`), `${language}: queued card can move up`);
    assert.ok(!cardOf('c').includes('data-testid="move-to-top"'), `${language}: first card has no move button`);
    assert.ok(!cardOf('a').includes('data-testid="move-to-top"'), `${language}: active card has no move button`);
  }
});

test('every media layout option is translated in all supported languages', () => {
  const source = readFileSync(new URL('../renderer/RootApp.tsx', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('const mediaLayouts'), source.indexOf('];', source.indexOf('const mediaLayouts')));
  const keys = [...block.matchAll(/(?:title|detail): '([^']+)'/g)].map(match => match[1]);
  assert.equal(keys.length, 12);
  for (const key of keys) for (const [language, catalog] of Object.entries(translationCatalogs)) assert.ok(Object.hasOwn(catalog, key), `${language}: ${key}`);
});

test('folder settings preview where the next photo and video land for each media layout', async () => {
  const {SettingsPage}=await import('../renderer/RootApp');
  const expected:Record<string,[string,string]>={
    'type-format':['photobackup2026202610Nikon Z6IIIPhotosNEFDSC_0001.NEF','photobackup2026202610Nikon Z6IIIVideosMOVDSC_0002.MOV'],
    'format':['photobackup2026202610Nikon Z6IIINEFDSC_0001.NEF','photobackup2026202610Nikon Z6IIIMOVDSC_0002.MOV'],
    'photos-flat':['photobackup2026202610Nikon Z6IIIDSC_0001.NEF','photobackup2026202610Nikon Z6IIIVideosDSC_0002.MOV'],
    'videos-flat':['photobackup2026202610Nikon Z6IIIPhotosDSC_0001.NEF','photobackup2026202610Nikon Z6IIIDSC_0002.MOV'],
    'flat':['photobackup2026202610Nikon Z6IIIDSC_0001.NEF','photobackup2026202610Nikon Z6IIIDSC_0002.MOV'],
    'video-root':['photobackup2026202610Nikon Z6IIIDSC_0001.NEF','videobackupNikon Z6III20261020DSC_0002.MOV'],
  };
  for(const [layout,[photo,video]] of Object.entries(expected)){
    const state:AppState={preferences:{language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:[],copyMode:'single',basePath:'photobackup',template:'{year}/{yyyymm}/{camera}',mediaLayout:layout as AppState['preferences']['mediaLayout'],videoBasePath:'videobackup',videoTemplate:'{camera}/{yyyyMMdd}',allowFolderSource:false,unknownRules:{}},sources:[],jobs:[],history:[],platform:'darwin'};
    const markup=renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(SettingsPage,{state,act:()=>{},busy:false})}));
    const text=(id:string)=>{const start=markup.indexOf(`data-testid="${id}"`);return markup.slice(start,markup.indexOf('</div></div>',start)).replace(/<[^>]+>/g,'').replace(/^[^>]*>/,'');};
    assert.ok(text('photo-preview').endsWith(photo),`${layout} photo: ${text('photo-preview')}`);
    assert.ok(text('video-preview').endsWith(video),`${layout} video: ${text('video-preview')}`);
    assert.equal(markup.includes('Video backup folder'),layout==='video-root');
  }
});

test('the folder builder shows the saved path, and a hand-written template opens as custom', async () => {
  const {SettingsPage}=await import('../renderer/RootApp');
  const render=(template:string,mediaLayout:AppState['preferences']['mediaLayout']='flat',videoTemplate='')=>renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(SettingsPage,{state:{preferences:{language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:[],copyMode:'single',basePath:'photobackup',template,mediaLayout,videoBasePath:'videobackup',videoTemplate,allowFolderSource:false,unknownRules:{}},sources:[],jobs:[],history:[],platform:'darwin'},act:()=>{},busy:false})}));
  const preview=(markup:string,id:string)=>{const start=markup.indexOf(`data-testid="${id}"`);return markup.slice(start,markup.indexOf('</div></div>',start)).replace(/<[^>]+>/g,'').replace(/^[^>]*>/,'');};
  const english=render('{camera}/{year}/{monthName}/{day}');
  assert.ok(english.includes('aria-pressed="true">Camera, then date'));
  assert.ok(english.includes('aria-pressed="true">English'));
  assert.ok(preview(english,'photo-preview').endsWith('photobackupNikon Z6III202610 October20DSC_0001.NEF'));
  const custom=render('shoots/{year}/{camera}');
  assert.ok(custom.includes('This folder path is a custom template.'));
  assert.ok(preview(custom,'photo-preview').endsWith('photobackupshoots2026Nikon Z6IIIDSC_0001.NEF'));
  const video=render('{year}/{yyyymm}/{camera}','video-root','{camera}/{year}');
  assert.ok(video.includes('data-testid="video-path-builder"'));
  assert.ok(preview(video,'video-preview').endsWith('videobackupNikon Z6III2026DSC_0002.MOV'));
  assert.ok(!render('{year}/{yyyymm}/{camera}','video-root').includes('data-testid="video-path-builder"'),'videos use the photo path until set apart');
});

test('scans, reviews and the backup folder check show a progress bar', async () => {
  const { PlanningProgress, scanTotalBytes, ScanProgress } = await import('../renderer/RootApp');
  const render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, { language: 'en', children: child }));
  const checking = render(createElement(PlanningProgress, { label: 'Review progress', progress: { phase: 'planning', step: 'checking', completed: 50, total: 200, bytes: 0, totalBytes: 0, speed: 0, file: '/card/DCIM/DSC_0050.NEF' } }));
  assert.ok(checking.includes('aria-valuenow="25"') && checking.includes('50 of 200 files checked') && checking.includes('DSC_0050.NEF'));
  const listing = render(createElement(PlanningProgress, { label: 'Checking the backup folder', progress: { phase: 'planning', step: 'checking', completed: 0, total: 0, bytes: 0, totalBytes: 0, speed: 0, file: '' } }));
  assert.ok(listing.includes('progress-discovering'), 'no total yet: indeterminate');
  const folder = { id: 'folder:/Users/me/Pictures', name: 'Pictures', path: '/Users/me/Pictures', transport: 'folder' as const, total: 1e12, free: 4e11 };
  const previous: Inventory = { files: [{ path: '/Users/me/Pictures/a.JPG', relative: 'a.JPG', size: 3e9, kind: 'JPEG', included: true }, { path: '/Users/me/Pictures/b.txt', relative: 'b.txt', size: 1e9, kind: 'Other', included: false }], media: 1, companions: 0, unknown: 1, bytes: 3e9, unknownExtensions: {}, elapsedMs: 0 };
  assert.equal(scanTotalBytes(folder, previous), 4e9, 'a folder is measured against its last listing, not the whole volume');
  assert.equal(scanTotalBytes(folder), undefined);
  assert.equal(scanTotalBytes({ ...folder, id: 'card', transport: 'storage' }), 6e11, 'a drive is measured against its used space');
  const scan = render(createElement(ScanProgress, { sourceName: 'Pictures', listing: { files: 10, bytes: 2e9 }, usedBytes: scanTotalBytes(folder, previous) }));
  assert.ok(scan.includes('aria-valuenow="50"'));
});

test('Settings is organized into categories with live summaries, one open panel, and every setting in its place', async () => {
  const { SettingsPage } = await import('../renderer/RootApp');
  const preferences: AppState['preferences'] = { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: true, parallel: 2, destinations: ['/Volumes/A006'], copyMode: 'single', basePath: 'photobackup', template: '{year}/{yyyymm}', mediaLayout: 'flat', videoBasePath: '', videoTemplate: '', allowFolderSource: false, unknownRules: {},
    rememberedDevices: { card: { name: 'Card', lastSelected: '2026-10-20T10:00:00Z' } } };
  const state: AppState = { preferences, sources: [], jobs: [], history: [], platform: 'darwin', destinationStatus: [{ path: '/Volumes/A006', available: true, total: 2e12, free: 8e11 }] };
  const order = ['importing', 'destinations', 'folders', 'organization', 'drives', 'general'];
  for (const language of languages) {
    const t = createTranslator(language), render = (s: AppState, busy = false) => renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(SettingsPage, { state: s, act: () => {}, busy }) }));
    const markup = render(state);
    assert.deepEqual([...markup.matchAll(/data-testid="settings-tab-(\w+)"/g)].map(m => m[1]), order, `${language}: categories in task order`);
    assert.equal((markup.match(/role="tab"[^>]*aria-selected="true"|aria-selected="true"[^>]*role="tab"/g) ?? []).length, 1, `${language}: one selected category`);
    const tab = (id: string) => markup.match(new RegExp(`<button[^>]*data-testid="settings-tab-${id}"[\\s\\S]*?</button>`))?.[0] ?? '';
    const panel = (id: string) => markup.match(new RegExp(`<section[^>]*data-testid="settings-panel-${id}"[\\s\\S]*?(?=<section[^>]*data-testid="settings-panel-|$)`))?.[0] ?? '';
    assert.ok(tab('importing').includes(t('Automatic')) && tab('importing').includes(t('{count} at once', { count: '2' })), `${language}: importing summary`);
    assert.ok(tab('destinations').includes('A006'), `${language}: destinations summary`);
    assert.ok(tab('folders').includes('2026') && tab('folders').includes('202610'), `${language}: folders summary`);
    assert.ok(tab('organization').includes(t('Ask')), `${language}: organization summary`);
    assert.ok(tab('drives').includes(t('{count} remembered', { count: '1' })), `${language}: drives summary`);
    assert.ok(tab('general').includes('125%'), `${language}: general summary`);
    assert.ok(!/<section[^>]*data-testid="settings-panel-importing"[^>]*hidden/.test(markup) && /<section[^>]*data-testid="settings-panel-general"[^>]*hidden/.test(markup), `${language}: only the open panel is shown`);
    assert.ok(panel('importing').includes(t('Automatic import')) && panel('importing').includes('id="settings-parallel"') && panel('importing').includes(t('Verify each copy after copying')) && panel('importing').includes(t('Enable media folder selection')), `${language}: importing controls`);
    assert.ok(panel('destinations').includes('destination-slot') && panel('destinations').includes(t('Backup folder')), `${language}: destination controls`);
    assert.ok(panel('folders').includes('data-testid="photo-path-builder"') && panel('folders').includes(t('Edited exports folder')), `${language}: folder controls`);
    assert.ok(!panel('organization').includes(t('Remove emptied source folders')) && panel('organization').includes(t('Check the backup folder')), `${language}: organization controls`);
    assert.ok(panel('drives').includes('data-testid="remembered-devices"') && panel('drives').includes('data-testid="ignored-devices"'), `${language}: drive memory`);
    assert.ok(panel('general').includes('id="app-language"') && panel('general').includes('id="text-size"'), `${language}: general controls`);
    const busy = render(state, true);
    const busyPanel = (id: string) => busy.match(new RegExp(`<section[^>]*data-testid="settings-panel-${id}"[\\s\\S]*?(?=<section[^>]*data-testid="settings-panel-|$)`))?.[0] ?? '';
    assert.ok(/<fieldset[^>]*disabled/.test(busyPanel('destinations')) && /<fieldset[^>]*disabled/.test(busyPanel('folders')), `${language}: pipeline settings lock while importing`);
    assert.ok(!/<fieldset[^>]*disabled/.test(busyPanel('general')) && !/<input[^>]*id="settings-parallel"[^>]*disabled/.test(busyPanel('importing')), `${language}: general and live controls stay usable`);
  }
});

test('queue positions follow the published start order, so a drive moved to the top says it starts next', async () => {
  const { ImportDesk } = await import('../renderer/RootApp');
  const preferences: AppState['preferences'] = { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 1, destinations: ['/b'], copyMode: 'single', basePath: 'p', template: '{year}', mediaLayout: 'flat', videoBasePath: '', videoTemplate: '', allowFolderSource: false, unknownRules: {} };
  const b = { id: 'b', name: 'Bravo', path: '/Volumes/B', transport: 'storage' as const, selected: true };
  const c = { id: 'c', name: 'Charlie', path: '/Volumes/C', transport: 'storage' as const, selected: true };
  // state.jobs is newest first: B was queued before C.
  const jobs: Job[] = [{ id: 'jc', source: c, phase: 'queued', errors: [], backup: false }, { id: 'jb', source: b, phase: 'queued', errors: [], backup: false }];
  for (const language of languages) {
    const t = createTranslator(language);
    const position = (state: Partial<AppState>, id: string) => { const markup = renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(ImportDesk, { state: { preferences, sources: [c, b], jobs, history: [], platform: 'darwin', ...state }, act: () => {}, inspect: () => {}, onOrganization: () => {}, onSettings: () => {} }) })); return markup.match(new RegExp(`<article data-source-id="${id}"[\\s\\S]*?</article>`))?.[0] ?? ''; };
    assert.ok(position({ queueOrder: ['jc', 'jb'] }, 'c').includes(t('Queue position {count}', { count: 1 })), `${language}: moved drive starts next`);
    assert.ok(position({ queueOrder: ['jc', 'jb'] }, 'b').includes(t('Queue position {count}', { count: 2 })), `${language}: the other waits`);
    assert.ok(position({}, 'b').includes(t('Queue position {count}', { count: 1 })), `${language}: without a published order, longest waiting first`);
  }
});

test('the Import overview can be hidden from the desk and turned back on in Settings', async () => {
  const { ImportDesk, SettingsPage } = await import('../renderer/RootApp');
  const preferences: AppState['preferences'] = { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/b'], copyMode: 'single', basePath: 'p', template: '{year}', mediaLayout: 'flat', videoBasePath: '', videoTemplate: '', allowFolderSource: false, unknownRules: {} };
  for (const language of languages) {
    const t = createTranslator(language), render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, { language, children: child }));
    const desk = (showDashboard?: boolean) => render(createElement(ImportDesk, { state: { preferences: { ...preferences, showDashboard }, sources: [], jobs: [], history: [], platform: 'darwin' }, act: () => {}, inspect: () => {}, onOrganization: () => {}, onSettings: () => {} }));
    assert.ok(desk().includes('class="import-dashboard"') && desk().includes(`aria-label="${t('Hide the import overview')}"`), `${language}: shown by default with a hide button`);
    assert.ok(!desk(false).includes('class="import-dashboard"'), `${language}: can be hidden`);
    assert.ok(desk(false).includes(`aria-label="${t('Show the import overview')}"`) && !desk().includes('data-testid="show-dashboard-desk"'), `${language}: the desk offers to show it again only while hidden`);
    const settings = (showDashboard?: boolean) => render(createElement(SettingsPage, { state: { preferences: { ...preferences, showDashboard }, sources: [], jobs: [], history: [], platform: 'darwin' }, act: () => {}, busy: true })).match(/data-testid="show-dashboard"[\s\S]*?<\/label>/)?.[0] ?? '';
    assert.ok(settings().includes(t('Show the import overview')) && /checked=""/.test(settings()) && !/disabled/.test(settings()), `${language}: Settings switch, on by default, usable while importing`);
    assert.ok(!/checked=""/.test(settings(false)), `${language}: off when hidden`);
  }
});

test('the parallel drives slider runs from 1 to 10', async () => {
  const { ImportDesk } = await import('../renderer/RootApp');
  const preferences: AppState['preferences'] = { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 5, destinations: ['/b'], copyMode: 'single', basePath: 'p', template: '{year}', mediaLayout: 'flat', videoBasePath: '', videoTemplate: '', allowFolderSource: false, unknownRules: {} };
  for (const language of languages) {
    const t = createTranslator(language);
    const markup = renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(ImportDesk, { state: { preferences, sources: [], jobs: [], history: [], platform: 'darwin' }, act: () => {}, inspect: () => {}, onOrganization: () => {}, onSettings: () => {} }) }));
    const slider = markup.match(/<input id="parallel-source-limit"[^>]*>/)?.[0] ?? '';
    assert.ok(/min="1"/.test(slider) && /max="10"/.test(slider) && /value="5"/.test(slider), `${language}: 1–10, showing 5`);
    assert.ok(markup.includes(t('{count} of 10', { count: 5 })), `${language}: label out of 10`);
  }
});

test('a finished organization shows 100%, and one misplaced file is counted in the singular', async () => {
  const { OrganizationProgress, Organization, ImportDesk } = await import('../renderer/RootApp');
  const preferences: AppState['preferences'] = { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 5, destinations: ['/Volumes/A006'], copyMode: 'single', basePath: 'photobackup', template: '{year}', mediaLayout: 'flat', videoBasePath: '', videoTemplate: '', allowFolderSource: false, unknownRules: {} };
  const source = { id: 'l', name: 'Backup organization', path: '/Volumes/A006', transport: 'folder' as const };
  for (const language of languages) {
    const t = createTranslator(language), render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, { language, children: child }));
    // Moves are renames: no bytes are copied even though the planned size is known.
    const done = render(createElement(OrganizationProgress, { job: { id: 'o', source, phase: 'complete', organization: true, errors: [], backup: false, progress: { phase: 'copying', completed: 1, total: 1, bytes: 0, totalBytes: 5e6, speed: 0, file: '' } } }));
    assert.ok(done.includes('100%') && !done.includes('>0%'), `${language}: complete reads 100%`);
    const moving = render(createElement(OrganizationProgress, { job: { id: 'o', source, phase: 'copying', organization: true, errors: [], backup: false, progress: { phase: 'copying', completed: 3, total: 4, bytes: 0, totalBytes: 5e6, speed: 0, file: 'x' } } }));
    assert.ok(moving.includes('75%'), `${language}: moves count files, not bytes`);
    const misplaced = { '/Volumes/A006': { count: 1, bytes: 2e6, checkedAt: '2026-10-21T10:00:00Z' } };
    const page = render(createElement(Organization, { state: { preferences, sources: [], jobs: [], history: [], platform: 'darwin', misplacedFiles: misplaced }, act: () => {}, busy: false }));
    const desk = render(createElement(ImportDesk, { state: { preferences, sources: [], jobs: [], history: [], platform: 'darwin', misplacedFiles: misplaced }, act: () => {}, inspect: () => {}, onOrganization: () => {}, onSettings: () => {} }));
    const singular = t('1 file outside your folder structure'), plural = t('{count} files outside your folder structure', { count: '1' });
    // Chinese and Japanese do not inflect, so both forms read the same there.
    for (const markup of [page, desk]) assert.ok(markup.includes(singular) && (singular === plural || !markup.includes(plural)), `${language}: singular`);
    if (language === 'en') assert.notEqual(t('1 file outside your folder structure'), t('{count} files outside your folder structure', { count: '1' }));
  }
});

test('Settings › Organization shows leftover temporary files with a Clean up button in every language', async () => {
  const { SettingsPage } = await import('../renderer/RootApp');
  const preferences: AppState['preferences'] = { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/Volumes/A006'], copyMode: 'single', basePath: 'photobackup', template: '{year}', mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'', allowFolderSource: false, unknownRules: {} };
  for (const language of languages) {
    const t = createTranslator(language);
    const row = (residue?: AppState['residue'], busy = false) => renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(SettingsPage, { state: { preferences, sources: [], jobs: [], history: [], platform: 'darwin', residue }, act: () => {}, busy }) })).match(/data-testid="residue-cleanup"[\s\S]*?<\/section>/)?.[0] ?? '';
    const cleanUp = (markup: string) => markup.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*?<\/button>/g)?.find(button => button.includes(t('Clean up'))) ?? '';
    assert.ok(row().includes(t('Not checked yet.')) && cleanUp(row()) && !/disabled/.test(cleanUp(row())), `${language}: unchecked, Clean up available`);
    const found = row({ files: 37, bytes: 2.5e9, resumable: { files: 2, bytes: 1e8 }, checkedAt: '2026-10-22T10:00:00Z' });
    assert.ok(found.includes(t('{count} leftover files', { count: formatNumber(37, language) })) && found.includes(formatBytes(2.5e9, language)), `${language}: count and size`);
    assert.ok(found.includes(t('{count} can continue when that card is imported again ({size}). Automatic cleanup keeps them; Clean up removes them too.', { count: formatNumber(2, language), size: formatBytes(1e8, language) })), `${language}: resumable copies reported apart`);
    assert.ok(row({ files: 1, bytes: 10, resumable: { files: 0, bytes: 0 }, checkedAt: '2026-10-22T10:00:00Z' }).includes(t('1 leftover file')), `${language}: singular`);
    const clean = row({ files: 0, bytes: 0, resumable: { files: 0, bytes: 0 }, checkedAt: '2026-10-22T10:00:00Z', cleaned: { files: 5, bytes: 1e6, at: '2026-10-22T10:00:00Z' } });
    assert.ok(clean.includes(t('No leftover files.')) && clean.includes(t('Last cleanup removed {files} ({size}).', { files: t('{count} leftover files', { count: formatNumber(5, language) }), size: formatBytes(1e6, language) })), `${language}: clean, with the last cleanup`);
    assert.ok(row({ files: 0, bytes: 0, resumable: { files: 0, bytes: 0 }, checking: true }).includes(t('Looking for leftover files…')) && /disabled/.test(cleanUp(row({ files: 0, bytes: 0, resumable: { files: 0, bytes: 0 }, checking: true }))), `${language}: disabled while checking`);
    assert.ok(/disabled/.test(cleanUp(row(undefined, true))), `${language}: disabled while importing or reviewing`);
  }
});
test('locked settings use a hover explanation in every language, never an error', () => {
  const key = 'Locked while an import, organization or review is active, including paused or queued ones. Finish or stop them to change this.';
  for (const language of languages) assert.ok(language === 'en' || createTranslator(language)(key) !== key, language);
  assert.ok(!readFileSync(new URL('../main.ts', import.meta.url), 'utf8').includes('error.settingsLocked'));
  assert.ok(!readFileSync(new URL('../messages.ts', import.meta.url), 'utf8').includes('error.settingsLocked'));
});

test('time-left ranges and the verifying byte count read naturally in every language', async () => {
  const { formatEstimate, progressCount } = await import('../renderer/RootApp');
  const expected = { en: ['about 2–4 h', 'about 20–40 min'], 'zh-Hans': ['约 2–4 小时', '约 20–40 分钟'], 'zh-Hant': ['約 2–4 小時', '約 20–40 分鐘'], ja: ['約 2～4 時間', '約 20～40 分'] } as const;
  for (const language of languages) {
    const t = createTranslator(language);
    assert.equal(formatEstimate(3 * 3600, t, { low: 2 * 3600, high: 4 * 3600 }), expected[language][0], language);
    assert.equal(formatEstimate(30 * 60, t, { low: 20 * 60, high: 40 * 60 }), expected[language][1], language);
    assert.equal(formatEstimate(3 * 3600, t, { low: 2.8 * 3600, high: 3.2 * 3600 }), formatEstimate(3 * 3600, t), 'a narrow range is one value');
    const verifying = progressCount({ phase: 'verifying', completed: 34863, total: 43539, bytes: 0, totalBytes: 167e9, speed: 0, file: '', work: { files: 34863, bytes: 24e9, totalFiles: 43539, totalBytes: 167e9 } }, t, value => formatNumber(value, language), false, value => formatBytes(value, language));
    assert.match(verifying, /34,863/);
    assert.match(verifying, /24(\.0)? GB/, language);
    assert.match(verifying, /167(\.0)? GB/, language);
    assert.ok(!progressCount({ phase: 'verifying', completed: 1, total: 2, bytes: 0, totalBytes: 0, speed: 0, file: '' }, t, String).includes('GB'));
  }
});
