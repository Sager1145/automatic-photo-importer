import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider} from '../renderer/i18n';
import {OrganizationCard,organizationPlace,shownPercent} from '../renderer/RootApp';
import type {Job} from '../shared';

const job=(extra:Partial<Job>):Job=>({id:'o',source:{id:'library:/Volumes/A006',name:'Backup organization',path:'/Volumes/A006',transport:'folder'},organization:true,folders:['photobackup','videobackup'],phase:'verifying',errors:[],backup:false,...extra});
const render=(value:Job)=>renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(OrganizationCard,{job:value,act:()=>{}})}));

test('an organization card names the drive and folders it reads',()=>{
 assert.equal(organizationPlace(job({})),'A006 › photobackup + videobackup');
 assert.equal(organizationPlace(job({}),true),'/Volumes/A006 › photobackup + videobackup');
 assert.equal(organizationPlace(job({folders:undefined,source:{id:'library:/x/photobackup',name:'',path:'/x/photobackup',transport:'folder'}})),'photobackup');
});

test('while listing, the card counts files and data found so far',()=>{
 const markup=render(job({phase:'verifying',progress:{phase:'planning',step:'listing',completed:1234,total:0,bytes:5e9,totalBytes:0,speed:0,file:''}}));
 assert.ok(markup.includes('data-testid="organization-card"'));assert.ok(markup.includes('Listing files'));
 assert.ok(markup.includes('1,234 files found'));assert.ok(markup.includes('/Volumes/A006 › photobackup + videobackup'));
});

test('a running organization can be paused, and a paused one resumed',()=>{
 const running=render(job({phase:'copying',progress:{phase:'copying',completed:5,total:10,bytes:0,totalBytes:0,speed:0,file:'A.NEF'}}));
 assert.ok(running.includes('aria-label="Pause"'));assert.ok(!running.includes('aria-label="Resume"'));assert.ok(running.includes('Organizing'));
 const paused=render(job({phase:'stopped',paused:true,progress:{phase:'copying',completed:5,total:10,bytes:0,totalBytes:0,speed:0,file:'A.NEF'}}));
 assert.ok(paused.includes('aria-label="Resume"'));assert.ok(!paused.includes('aria-label="Pause"'));assert.ok(paused.includes('Paused'));
});

test('progress never shows 100% before the work is finished',()=>{
 assert.equal(shownPercent(1,false),99);assert.equal(shownPercent(0.999,false),99);assert.equal(shownPercent(0.5,false),50);assert.equal(shownPercent(1,true),100);
 // All 212 files read, but the organization has not finished: the last steps still run.
 const markup=render(job({phase:'verifying',fraction:1,progress:{phase:'planning',step:'reading',completed:212,total:212,bytes:206.5e9,totalBytes:206.5e9,speed:0,file:'NZF_6383.MOV'}}));
 assert.ok(markup.includes('99%'));assert.ok(!markup.includes('100%'));
 assert.ok(markup.includes('212 of 212 files read · '),markup);assert.ok(markup.includes('Reading files'));
});

test('each step before the moves says what it is checking',()=>{
 const earlier=render(job({phase:'verifying',progress:{phase:'verifying',step:'earlier',completed:40,total:200,bytes:0,totalBytes:0,speed:0,file:'cdeaa0ba'}}));
 assert.ok(earlier.includes('Checking the earlier organization: 40 of 200 records'));assert.ok(earlier.includes('Confirming'));
 const confirming=render(job({phase:'verifying',progress:{phase:'verifying',step:'confirming',completed:7,total:212,bytes:0,totalBytes:0,speed:0,file:'A.MOV'}}));
 assert.ok(confirming.includes('Confirming files before moving: 7 of 212'));
});
