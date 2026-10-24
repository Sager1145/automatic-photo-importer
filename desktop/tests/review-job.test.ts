import test from 'node:test';
import assert from 'node:assert/strict';
import {appliedReviewJob} from '../review-job';
import type {Review} from '../shared';

const prefs={};
type RunRequest={prefs:object;reorganize:boolean;options?:{removeEmptyFolders:boolean;releaseDuplicates:boolean};sourceFolders?:string[]};
const source={id:'library:/Volumes/A006',path:'/Volumes/A006',name:'Existing library',transport:'folder' as const};
const review=(kind:Review['kind'],extra:Partial<Review>={}):Review=>({id:'r1',kind,source,plans:[],backup:false,...extra});

test('an organize review opened from Library › Organize becomes an organization job when applied, with its run kept for Retry',()=>{
 const request:RunRequest={prefs,reorganize:true,options:{removeEmptyFolders:false,releaseDuplicates:false},sourceFolders:['photobackup','videobackup']};
 const {job,organization}=appliedReviewJob('j1',{review:review('reorganize',{sourceFolders:['photobackup','videobackup']}),request});
 assert.equal(job.organization,true,'no origin is needed: the review kind decides');
 assert.deepEqual(job.folders,['photobackup','videobackup']);
 assert.equal(job.phase,'verifying');
 assert.equal(job.unknownConfirmed,true);
 assert.deepEqual(organization,{...request,confirmed:true},'Retry re-runs with the reviewed options, without asking about unknown files again');
});

test('a parked organization keeps the folders of the job it was parked from',()=>{
 const request:RunRequest={prefs,reorganize:true,options:{removeEmptyFolders:true,releaseDuplicates:true}};
 const {job,organization}=appliedReviewJob('j2',{review:review('reorganize'),request,origin:{jobId:'old',organization:true,folders:['2024']}});
 assert.equal(job.organization,true);
 assert.deepEqual(job.folders,['2024']);
 assert.ok(organization);
});

test('an import review stays an import job: no organization flag and no organization run',()=>{
 const request:RunRequest={prefs,reorganize:false};
 const {job,organization}=appliedReviewJob('j3',{review:review('import',{backup:true}),request,useFileDate:true,handling:'keep'});
 assert.equal(job.organization,undefined);
 assert.equal(job.folders,undefined);
 assert.equal(job.backup,true);
 assert.equal(job.useFileDate,true);
 assert.equal(job.noMetadataHandling,'keep');
 assert.equal(organization,undefined);
});
