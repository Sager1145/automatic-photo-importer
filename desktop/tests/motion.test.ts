import test from 'node:test';
import assert from 'node:assert/strict';
import {animateInterfaceChange,interfaceChangeKind} from '../renderer/RootApp';
import type {AppState,Job,Preferences} from '../shared';

// A minimal browser: View Transitions record the kind they ran with; reduced motion is switchable.
let reduce=false,sheetOpen=false;
const transitions:(string|undefined)[]=[];
const root={dataset:{} as Record<string,string>};
Object.assign(globalThis,{
 window:{matchMedia:(query:string)=>({matches:query.includes('reduce')&&reduce})},
 document:{documentElement:root,querySelector:(selector:string)=>selector.includes('dialog[open]')&&sheetOpen?{}:null,startViewTransition(update:()=>void){transitions.push(root.dataset.transition);update();return {finished:Promise.resolve(),skipTransition(){}};}},
});

test('an interface change runs as a View Transition of its kind',()=>{
 reduce=false;transitions.length=0;let applied=0;
 animateInterfaceChange(()=>{applied++;},'category-forward');
 animateInterfaceChange(()=>{applied++;},'forward');
 animateInterfaceChange(()=>{applied++;});
 assert.deepEqual(transitions,['category-forward','forward','crossfade']);
 assert.equal(applied,3);
});

test('reduced motion applies the change directly, without a transition',()=>{
 reduce=true;transitions.length=0;let applied=0;
 animateInterfaceChange(()=>{applied++;},'back');
 assert.deepEqual(transitions,[]);assert.equal(applied,1);
 reduce=false;
});

test('under an open sheet or error message the change applies directly, so nothing covers them',()=>{
 sheetOpen=true;transitions.length=0;let applied=0;
 animateInterfaceChange(()=>{applied++;},'layout');
 assert.deepEqual(transitions,[]);assert.equal(applied,1);
 sheetOpen=false;
});

const preferences={language:'en',appearance:'system',accent:'coral',sourceLayout:'list',showDashboard:true,copyMode:'single',destinations:['/backup']} as Preferences;
const state=(extra:Partial<AppState>={},prefs:Partial<Preferences>={}):AppState=>({preferences:{...preferences,...prefs},sources:[{id:'a',name:'A',path:'/a',transport:'folder'}],jobs:[],history:[],...extra} as AppState);
const job=(phase:Job['phase'],completed:number):Job=>({id:'j',source:{id:'a',name:'A',path:'/a',transport:'folder'},phase,errors:[],backup:false,progress:{phase:'copying',completed,total:10,bytes:completed,totalBytes:10,speed:1,file:''}});

test('progress updates render directly; structural changes animate',()=>{
 assert.equal(interfaceChangeKind(state({jobs:[job('copying',1)]}),state({jobs:[job('copying',2)]})),undefined,'a progress tick');
 assert.equal(interfaceChangeKind(state({jobs:[job('copying',9)]}),state({jobs:[job('complete',10)]})),undefined,'a job finishing');
 assert.equal(interfaceChangeKind(state(),state({sources:[]})),'layout','a drive removed');
 assert.equal(interfaceChangeKind(state(),state({jobs:[{...job('queued',0),organization:true,source:{id:'library:/b',name:'',path:'/b',transport:'folder'}}]})),'layout','an organization card appears');
 assert.equal(interfaceChangeKind(state(),state({},{sourceLayout:'grid'})),'layout','grid layout');
 assert.equal(interfaceChangeKind(state(),state({},{showDashboard:false})),'layout','overview hidden');
 assert.equal(interfaceChangeKind(state(),state({},{destinations:['/backup','/second'],copyMode:'mirror'})),'layout','second destination');
 assert.equal(interfaceChangeKind(state(),state({busyReview:true})),'layout','review opens');
 assert.equal(interfaceChangeKind(state(),state({},{language:'ja'})),'crossfade','language');
 assert.equal(interfaceChangeKind(state(),state({},{appearance:'dark'})),'crossfade','appearance');
 assert.equal(interfaceChangeKind(state(),state({},{accent:'ocean'})),'crossfade','accent');
 assert.equal(interfaceChangeKind(state(),state({},{textScale:1.5,parallel:4})),undefined,'slider settings follow the hand');
});
