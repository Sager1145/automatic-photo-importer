import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement,isValidElement} from 'react';
import type {ReactElement,ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createTranslator,I18nProvider,languages} from '../renderer/i18n';
import type {Action,AppState,Language,Progress} from '../shared';

const preferences:AppState['preferences']={language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:['/Volumes/A006'],copyMode:'single',basePath:'photobackup',template:'{year}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',unknownRules:{}};
const online=[{path:'/Volumes/A006',available:true,volumeId:'a',total:2e12,free:1e12}];
const progress:Progress={phase:'planning',step:'checking',completed:10,total:100,bytes:0,totalBytes:0,speed:0,file:'a.jpg'};
const result={count:3,bytes:2e6,checkedAt:'2026-10-23T10:00:00Z'};
const stateOf=(extra:Partial<AppState>={}):AppState=>({preferences,sources:[],jobs:[],history:[],platform:'darwin',destinationStatus:online,...extra});
const html=(language:Language,child:ReactElement)=>renderToStaticMarkup(createElement(I18nProvider,{language,children:child}));
/** Calls a component inside a render and returns the element tree it produced, so a click handler can be run. */
function tree(language:Language,component:(props:any)=>ReactElement,props:object):ReactNode{
  let out:ReactNode;const Probe=()=>{out=component(props);return null;};
  html(language,createElement(Probe));return out;
}
type Props={'data-testid'?:string;children?:ReactNode;onClick:()=>void};
function find(node:ReactNode,testId:string):ReactElement<Props>|undefined{
  if(Array.isArray(node))for(const item of node){const hit=find(item,testId);if(hit)return hit;}
  if(!isValidElement<Props>(node))return undefined;
  if(node.props['data-testid']===testId)return node;
  return find(node.props.children,testId);
}
const card=(markup:string)=>markup.match(/data-testid="backup-check"[\s\S]*?<\/section>/)?.[0]??'';
const button=(markup:string,testId:string)=>markup.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>[\\s\\S]*?</button>`))?.[0]??'';

test('with no result the backup card prompts for the check and the button dispatches it',async()=>{
  const {Organization,BackupCheck}=await import('../renderer/RootApp');
  for(const language of languages){
    const t=createTranslator(language),actions:Action[]=[];
    const page=card(html(language,createElement(Organization,{state:stateOf(),act:()=>{},busy:false})));
    assert.ok(page.includes('data-testid="backup-check-prompt"')&&page.includes(t('Check whether every file in this backup is in the folder your rules give it.')),`${language}: prompt`);
    const check=button(page,'check-backup-folder');
    assert.ok(/button-primary/.test(check)&&check.includes(t('Check folder layout'))&&!/disabled/.test(check),`${language}: primary, enabled`);
    assert.ok(!page.includes('segmented')&&!page.includes('aria-pressed')&&page.includes(t('The folder layout is checked only when you click Check folder layout.')),`${language}: no mode control`);
    const node=find(tree(language,BackupCheck,{state:stateOf(),act:(action:Action)=>actions.push(action),busy:false,organizeBusy:false,destinationIndex:0}),'check-backup-folder');
    assert.ok(node,`${language}: button found`);node!.props.onClick();
    assert.deepEqual(actions,[{type:'checkBackupFolder',destinationIndex:0}]);
  }
});

test('while checking the button is disabled and reads Checking, and the live label and progress stay',async()=>{
  const {Organization}=await import('../renderer/RootApp');
  for(const language of languages){
    const t=createTranslator(language);
    const page=card(html(language,createElement(Organization,{state:stateOf({misplacedProgress:{'/Volumes/A006':progress}}),act:()=>{},busy:false})));
    const check=button(page,'check-backup-folder');
    assert.ok(/disabled/.test(check)&&check.includes(t('Checking…')),`${language}: disabled Checking…`);
    assert.ok(page.includes('data-testid="folder-check-label"')&&page.includes('data-testid="misplaced-progress"'),`${language}: label and progress`);
    assert.ok(!page.includes('data-testid="backup-check-prompt"'),`${language}: no prompt while running`);
  }
});

test('a result with misplaced files makes Organize primary and Check again secondary; a clean one only offers Check again',async()=>{
  const {Organization}=await import('../renderer/RootApp');
  for(const language of languages){
    const t=createTranslator(language);
    const found=card(html(language,createElement(Organization,{state:stateOf({misplacedFiles:{'/Volumes/A006':result}}),act:()=>{},busy:false})));
    assert.ok(/<button[^>]*button-primary[^>]*>(?:(?!<\/button>)[\s\S])*?Organize backup|<button[^>]*button-primary[^>]*>(?:(?!<\/button>)[\s\S])*?/.test(found)&&found.includes('data-testid="misplaced-files"'),`${language}: misplaced`);
    const organize=found.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*?<\/button>/g)?.find(item=>item.includes(t('Organize backup')))??'';
    assert.ok(/button-primary/.test(organize),`${language}: Organize backup primary`);
    const again=button(found,'check-backup-folder');
    assert.ok(/button-secondary/.test(again)&&again.includes(t('Check again')),`${language}: Check again secondary`);
    assert.ok(!found.includes('data-testid="backup-check-prompt"'),`${language}: no prompt with a result`);
    const clean=card(html(language,createElement(Organization,{state:stateOf({misplacedFiles:{'/Volumes/A006':{...result,count:0,bytes:0}}}),act:()=>{},busy:false})));
    assert.ok(clean.includes(t('Backup folder is in order.'))&&/button-secondary/.test(button(clean,'check-backup-folder'))&&button(clean,'check-backup-folder').includes(t('Check again')),`${language}: clean`);
    assert.ok(!/button-primary/.test(clean),`${language}: nothing emphasized when in order`);
  }
});

test('the check button is disabled while busy, organizing or offline, and says why when the drive is away',async()=>{
  const {Organization}=await import('../renderer/RootApp');
  const t=createTranslator('en');
  const disabled=(state:AppState,busy=false)=>/disabled/.test(button(card(html('en',createElement(Organization,{state,act:()=>{},busy}))),'check-backup-folder'));
  assert.ok(disabled(stateOf(),true));
  assert.ok(disabled(stateOf({jobs:[{id:'o',source:{id:'l',name:'Backup organization',path:'/Volumes/A006',transport:'folder'},phase:'copying',organization:true,errors:[],backup:false}] as AppState['jobs']})));
  const offline=stateOf({destinationStatus:[{...online[0]!,available:false}]});
  assert.ok(disabled(offline));
  for(const language of languages){
    const markup=card(html(language,createElement(Organization,{state:offline,act:()=>{},busy:false})));
    assert.ok(markup.includes(createTranslator(language)('Reconnect this drive to check its folder layout.')),`${language}: reason`);
  }
  assert.ok(!card(html('en',createElement(Organization,{state:stateOf(),act:()=>{},busy:false}))).includes(t('Reconnect this drive to check its folder layout.')));
});

test('Settings no longer has the Off, Ask, Automatic check control',async()=>{
  const {SettingsPage}=await import('../renderer/RootApp');
  for(const language of languages){
    const markup=html(language,createElement(SettingsPage,{state:stateOf(),act:()=>{},busy:false}));
    const panel=markup.match(/<section[^>]*data-testid="settings-panel-files"[\s\S]*?(?=<section[^>]*data-testid="settings-panel-|$)/)?.[0]??'';
    assert.ok(panel.length>0&&!panel.includes('Auto-organize backup')&&!panel.includes('Automatic folder check'),`${language}: no mode control`);
    assert.ok(!markup.includes('Check the backup folder'),`${language}: no label`);
  }
});

test('the Import desk destination slot prompts with an emphasized button, keeps Organize for misplaced files, and is quiet when clean',async()=>{
  const {DestinationBay}=await import('../renderer/RootApp');
  const slot=(language:Language,state:AppState)=>html(language,createElement(DestinationBay,{state,act:()=>{}}));
  for(const language of languages){
    const t=createTranslator(language),actions:Action[]=[];
    const none=slot(language,stateOf()),check=button(none,'destination-check-backup-folder-0');
    assert.ok(/button-primary/.test(check)&&check.includes(t('Check folder layout'))&&!/disabled/.test(check),`${language}: emphasized`);
    find(tree(language,DestinationBay,{state:stateOf(),act:(action:Action)=>actions.push(action)}),'destination-check-backup-folder-0')!.props.onClick();
    assert.deepEqual(actions,[{type:'checkBackupFolder',destinationIndex:0}]);
    const found=slot(language,stateOf({misplacedFiles:{'/Volumes/A006':result}}));
    assert.ok(found.includes('data-testid="destination-misplaced"')&&!found.includes('destination-check-backup-folder-0'),`${language}: Organize stays`);
    const clean=slot(language,stateOf({misplacedFiles:{'/Volumes/A006':{...result,count:0}}}));
    assert.ok(!clean.includes('destination-check-backup-folder-0')&&!clean.includes('data-testid="destination-misplaced"'),`${language}: nothing when clean`);
    const running=slot(language,stateOf({misplacedProgress:{'/Volumes/A006':progress}}));
    assert.ok(!running.includes('destination-check-backup-folder-0'),`${language}: not while running`);
    const offline=slot(language,stateOf({destinationStatus:[{...online[0]!,available:false}]}));
    assert.ok(!offline.includes('destination-check-backup-folder-0'),`${language}: not when offline`);
  }
});

test('the prompt emphasis is static: no animation, transition or layering of its own',async()=>{
  const fs=await import('node:fs'),path=await import('node:path');
  const css=fs.readFileSync(path.join(__dirname,'../renderer/styles.css'),'utf8');
  const rule=/\.backup-check-prompt\{([^}]*)\}/.exec(css)?.[1]??'';
  assert.ok(rule.includes('var(--accent-soft)')&&rule.includes('var(--accent-border)'),rule);
  assert.ok(!/animation|keyframes|z-index|transform|translate|will-change|position/.test(rule),rule);
});

test('the destination-slot Check folder layout button keeps its natural width instead of stretching',async()=>{
  const fs=await import('node:fs'),path=await import('node:path');
  const css=fs.readFileSync(path.join(__dirname,'../renderer/styles.css'),'utf8');
  const rule=/\.destination-check\{([^}]*)\}/.exec(css)?.[1]??'';
  assert.ok(rule.includes('align-self:flex-start')&&rule.includes('justify-self:start'),rule);
});

const missing={count:0,bytes:0,checkedAt:'2026-10-23T10:00:00Z',missing:true as const};
const runningJob=[{id:'j',source:{id:'s',name:'Card',path:'/Volumes/CARD',transport:'folder'},phase:'copying',errors:[],backup:false}] as unknown as AppState['jobs'];

test('a missing backup folder shows a quiet note and no prompt or check button, in the card and in the destination slot',async()=>{
  const {Organization,DestinationBay}=await import('../renderer/RootApp');
  for(const language of languages){
    const t=createTranslator(language),note=t('No backup folder yet. The first import creates it.');
    const state=stateOf({misplacedFiles:{'/Volumes/A006':missing}});
    const page=card(html(language,createElement(Organization,{state,act:()=>{},busy:false})));
    assert.ok(page.includes(note)&&!page.includes('backup-check-prompt')&&!page.includes('data-testid="check-backup-folder"')&&!page.includes('Backup folder is in order')&&!page.includes('data-testid="misplaced-files"'),`${language}: card`);
    const slot=html(language,createElement(DestinationBay,{state,act:()=>{}}));
    assert.ok(slot.includes(note)&&!slot.includes('destination-check-backup-folder-0')&&!slot.includes('data-testid="destination-misplaced"'),`${language}: slot`);
  }
});

test('while checking a Stop button dispatches stopBackupCheck, in the card and in the destination slot',async()=>{
  const {BackupCheck,DestinationBay}=await import('../renderer/RootApp');
  const state=stateOf({misplacedProgress:{'/Volumes/A006':progress}});
  for(const language of languages){
    const t=createTranslator(language);
    for(const [component,props,id] of [[BackupCheck,{busy:false,organizeBusy:false,destinationIndex:0},'stop-backup-check'],[DestinationBay,{},'destination-stop-backup-check-0']] as const){
      const actions:Action[]=[];
      const node=find(tree(language,component as any,{...props,state,act:(action:Action)=>actions.push(action)}),id);
      assert.ok(node,`${language}: ${id}`);node!.props.onClick();
      assert.deepEqual(actions,[{type:'stopBackupCheck'}]);
    }
    const slot=html(language,createElement(DestinationBay,{state,act:()=>{}}));
    assert.ok(slot.includes(t('Stop')),`${language}: label`);
    const running=card(html(language,createElement(BackupCheck,{state,act:()=>{},busy:false,organizeBusy:false,destinationIndex:0})));
    assert.ok(button(running,'check-backup-folder').includes(t('Checking…'))&&/disabled/.test(button(running,'check-backup-folder')),`${language}: Checking…`);
  }
});

test('the check is disabled with a one-line reason while an import runs or another destination is checking',async()=>{
  const {BackupCheck,DestinationBay}=await import('../renderer/RootApp');
  const two={...preferences,destinations:['/Volumes/A006','/Volumes/B'],copyMode:'mirror' as const};
  const status=[...online,{path:'/Volumes/B',available:true,volumeId:'b',total:1,free:1}];
  for(const language of languages){
    const t=createTranslator(language);
    const importing=stateOf({jobs:runningJob});
    const a=card(html(language,createElement(BackupCheck,{state:importing,act:()=>{},busy:false,organizeBusy:false,destinationIndex:0})));
    assert.ok(/disabled/.test(button(a,'check-backup-folder'))&&a.includes(t('Wait for the current work to finish before checking.')),`${language}: import reason`);
    const slot=html(language,createElement(DestinationBay,{state:importing,act:()=>{}}));
    assert.ok(/disabled/.test(button(slot,'destination-check-backup-folder-0'))&&slot.includes(t('Wait for the current work to finish before checking.')),`${language}: slot import`);
    const other=stateOf({preferences:two,destinationStatus:status,misplacedProgress:{'/Volumes/B':progress}});
    const b=card(html(language,createElement(BackupCheck,{state:other,act:()=>{},busy:false,organizeBusy:false,destinationIndex:0})));
    assert.ok(/disabled/.test(button(b,'check-backup-folder'))&&b.includes(t('Another backup folder check is running.')),`${language}: other reason`);
    const dup=stateOf({duplicates:{status:'scanning'} as AppState['duplicates']});
    assert.ok(/disabled/.test(button(card(html(language,createElement(BackupCheck,{state:dup,act:()=>{},busy:false,organizeBusy:false,destinationIndex:0}))),'check-backup-folder')),`${language}: duplicates`);
    const idle=card(html(language,createElement(BackupCheck,{state:stateOf(),act:()=>{},busy:false,organizeBusy:false,destinationIndex:0})));
    assert.ok(!idle.includes(t('Wait for the current work to finish before checking.')),`${language}: no reason when idle`);
  }
});

test('a result shows when it was checked',async()=>{
  const {Organization,formatWhen}=await import('../renderer/RootApp');
  for(const language of languages){
    const t=createTranslator(language);
    const page=card(html(language,createElement(Organization,{state:stateOf({misplacedFiles:{'/Volumes/A006':result}}),act:()=>{},busy:false})));
    assert.ok(page.includes(t('Checked {time}',{time:formatWhen(result.checkedAt,language)})),`${language}: checked`);
  }
});
