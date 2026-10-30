import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCatalogClient} from '../catalog/process';
import {openCatalog} from '../catalog/store';
import {createCatalogSession} from '../catalog/session';
import type {Catalog} from '../catalog/types';
import {library,record} from './catalog-fixtures';
class LocalChild extends EventEmitter {
 private closing:Promise<void>|undefined;
 killed=0;
 beforeConfigure?:()=>Promise<void>;
 constructor(private store:Catalog){super();}
 postMessage(message:{id:number;method:keyof Catalog;args:unknown[]}){
  const method=this.store[message.method] as (...args:unknown[])=>Promise<unknown>;
  void (async()=>{if(message.method==='configure')await this.beforeConfigure?.();return message.method==='close'?await this.closeStore():await method(...message.args);})().then(result=>this.emit('message',{id:message.id,ok:true,result}),error=>this.emit('message',{id:message.id,ok:false,error:{message:error.message,code:error.code}}));
 }
 closeStore(){return this.closing??=this.store.close();}
 kill(){this.killed++;void this.closeStore();return true;}
 async crash(){await this.closeStore();this.emit('exit',9);}
}
const query={libraryId:library.libraryId,filters:[],sort:{field:'name' as const,direction:'asc' as const},limit:20};
test('a failed worker reopens only on explicit refresh, preserving definitions and the same facade',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'catalog-session-')),database=path.join(dir,'cache.sqlite'),children:LocalChild[]=[],warnings:Error[]=[];
 const session=createCatalogSession(onError=>{const child=new LocalChild(openCatalog(database));children.push(child);return createCatalogClient(child,{onError});},{onError:error=>warnings.push(error)});
 const facade=session.catalog;
 try{
  await facade.configure([library]);const run=await facade.beginScan(library.libraryId,['']);await facade.ingest(run,[record('a','Canon')]);await facade.endScan(run,'complete');assert.equal((await facade.query(query)).total,1);
  await children[0].crash();await assert.rejects(facade.query(query),/exited/);const renamed={...library,name:'Updated while worker unavailable'},added={...library,libraryId:'configured-while-unavailable',relativeRoot:'added'};await assert.rejects(facade.configure([renamed,added]),/exited/);assert.equal(children.length,1);assert.equal(warnings.length,1);assert.equal((await facade.status(library.libraryId)).state,'error');
  await Promise.all([session.reopen(),session.reopen(),session.reopen()]);assert.equal(children.length,2);assert.equal(session.catalog,facade);assert.equal(children[0].killed,1);assert.equal((await facade.query(query)).total,1);assert.equal((await facade.status(library.libraryId)).state,'idle');
  await session.reopen();assert.equal(children.length,2,'Healthy explicit refresh uses the existing process');
  assert.equal((await facade.query({...query,libraryId:added.libraryId})).total,0,'Definitions from rejected configure calls are installed on the replacement');
 }finally{await facade.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('failed explicit reopen remains a stable failure until another explicit attempt and close is terminal',async()=>{
 const children:LocalChild[]=[];const failed=new Error('Replacement could not start');let opens=0;
 const session=createCatalogSession(onError=>{opens++;if(opens>1)throw failed;const child=new LocalChild(openCatalog(':memory:'));children.push(child);return createCatalogClient(child,{onError});});
 await session.catalog.configure([library]);await children[0].crash();await assert.rejects(session.reopen(),error=>error===failed);assert.equal(opens,2);
 await assert.rejects(session.catalog.query(query),error=>error===failed);await assert.rejects(session.catalog.configure([library]),error=>error===failed);assert.equal(opens,2);assert.equal((await session.catalog.status(library.libraryId)).error,failed.message);
 await Promise.all([session.catalog.close(),session.catalog.close()]);await assert.rejects(session.reopen(),/closed/i);await assert.rejects(session.catalog.query(query),/closed/i);assert.equal(opens,2);
});

test('a replacement that fails to configure is closed and does not restart from ordinary requests',async()=>{
 const children:LocalChild[]=[],error=new Error('Catalog definitions unavailable');
 const session=createCatalogSession(onError=>{const child=new LocalChild(openCatalog(':memory:'));children.push(child);const client=createCatalogClient(child,{onError});return children.length===1?client:{...client,configure:async()=>{throw error;}};});
 try{
  await session.catalog.configure([library]);await children[0].crash();await assert.rejects(session.reopen(),reason=>reason===error);assert.equal(children.length,2);assert.equal(children[1].killed,1);
  await assert.rejects(session.catalog.query(query),reason=>reason===error);await assert.rejects(session.catalog.configure([{...library,online:false}]),reason=>reason===error);assert.equal(children.length,2);assert.equal((await session.catalog.status(library.libraryId)).online,false);
 }finally{await session.catalog.close();}
});

test('closing during explicit recovery is terminal and releases the replacement once',async()=>{
 const children:LocalChild[]=[];let unblock:()=>void=()=>{},entered:()=>void=()=>{};
 const release=new Promise<void>(resolve=>{unblock=resolve;}),configuring=new Promise<void>(resolve=>{entered=resolve;});
 const session=createCatalogSession(onError=>{const child=new LocalChild(openCatalog(':memory:'));children.push(child);if(children.length===2)child.beforeConfigure=async()=>{entered();await release;};return createCatalogClient(child,{onError});});
 await session.catalog.configure([library]);await children[0].crash();const recovery=session.reopen();await configuring;
 const closing=session.catalog.close();unblock();await assert.rejects(recovery,/closed/i);await closing;
 await assert.rejects(session.reopen(),/closed/i);await assert.rejects(session.catalog.query(query),/closed/i);assert.equal(children.length,2);assert.equal(children[1].killed,1);
});
