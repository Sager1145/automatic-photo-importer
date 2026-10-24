import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement,isValidElement} from 'react';
import type {ReactElement,ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createTranslator,I18nProvider,languages} from '../renderer/i18n';
import {normalizePreferences} from '../preferences';
import type {Action,AppState,Language} from '../shared';

const stateOf=(prefs:object={},extra:Partial<AppState>={}):AppState=>({preferences:normalizePreferences({destinations:['/backup'],basePath:'photobackup',...prefs}),sources:[],jobs:[],history:[],platform:'darwin',destinationStatus:[{path:'/backup',available:true,volumeId:'a',total:2e12,free:1e12}],...extra});
const html=(language:Language,child:ReactElement)=>renderToStaticMarkup(createElement(I18nProvider,{language,children:child}));
function tree(component:(props:any)=>ReactElement,props:object):ReactNode{let out:ReactNode;const Probe=()=>{out=component(props);return null;};html('en',createElement(Probe));return out;}
type Props={'data-testid'?:string;children?:ReactNode;onClick:()=>void;disabled?:boolean};
function find(node:ReactNode,testId:string):ReactElement<Props>|undefined{
  if(Array.isArray(node))for(const item of node){const hit=find(item,testId);if(hit)return hit;}
  if(!isValidElement<Props>(node))return undefined;
  if(node.props['data-testid']===testId)return node;
  return find(node.props.children,testId);
}
const reviewButton=(markup:string)=>markup.match(/<button[^>]*data-testid="review-changes"[^>]*>/)?.[0]??'';

test('the backup folder is the default organize scope: Organize now runs organizeBackup and Review stays inside the backup folder, in every language',async()=>{
  const {Organization}=await import('../renderer/RootApp');
  for(const language of languages){
    const t=createTranslator(language),markup=html(language,createElement(Organization,{state:stateOf(),act:()=>{},busy:false}));
    const radios=markup.match(/<input[^>]*type="radio"[^>]*>/g)??[];
    assert.deepEqual(radios.map(radio=>/checked/.test(radio)),[true,false,false],`${language}: backup radio checked`);
    assert.ok(markup.includes(t('Organize scope'))&&markup.includes(t('Whole destination'))&&markup.includes(t('Chosen folders')),`${language}: scope options`);
    assert.ok(!markup.includes('backup-review-note')&&reviewButton(markup)!==''&&!/disabled/.test(reviewButton(markup)),`${language}: backup folder can be reviewed`);
    assert.ok(markup.includes('data-testid="backup-check"')&&markup.includes('data-testid="check-backup-folder"'),`${language}: the layout check lives in the same card`);
  }
  const markup=html('en',createElement(Organization,{state:stateOf(),act:()=>{},busy:false}));
  const actions:Action[]=[];
  find(tree(Organization,{state:stateOf(),act:(action:Action)=>actions.push(action),busy:false}),'review-changes')!.props.onClick();
  assert.deepEqual(actions.splice(0),[{type:'previewOrganization',destinationIndex:0,scope:'backup'}]);
  find(tree(Organization,{state:stateOf(),act:(action:Action)=>actions.push(action),busy:false}),'organize-now')!.props.onClick();
  assert.deepEqual(actions,[{type:'organizeBackup',destinationIndex:0}]);
});

test('chosen folders and a destination without a backup folder use the organize action and can be reviewed',async()=>{
  const {Organization}=await import('../renderer/RootApp');
  for(const [state,label] of [[stateOf({},{organizationFolders:{'/backup':['2024']}}),'chosen'],[stateOf({basePath:''}),'no backup folder']] as const){
    const markup=html('en',createElement(Organization,{state,act:()=>{},busy:false}));
    assert.ok(reviewButton(markup)!==''&&!/disabled/.test(reviewButton(markup))&&!markup.includes('backup-review-note'),label);
    const actions:Action[]=[];
    find(tree(Organization,{state,act:(action:Action)=>actions.push(action),busy:false}),'organize-now')!.props.onClick();
    assert.deepEqual(actions,[{type:'organize',destinationIndex:0}],label);
    actions.length=0;find(tree(Organization,{state,act:(action:Action)=>actions.push(action),busy:false}),'review-changes')!.props.onClick();
    assert.deepEqual(actions,[{type:'previewOrganization',destinationIndex:0}],label);
  }
});

test('Recovery & cleanup is a Library tab and Activity no longer has a Recovery tab',async()=>{
  const fs=await import('node:fs'),path=await import('node:path');
  const source=fs.readFileSync(path.join(__dirname,'../renderer/RootApp.tsx'),'utf8');
  assert.match(source,/testId:'library-recovery'/);
  assert.doesNotMatch(source,/activity-recovery/);
  assert.match(source,/openRecovery = \(\) => navigate\('library'/);
});
