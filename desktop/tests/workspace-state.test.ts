import { freshOrganizeOptions } from '../run-policy';
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewWorkspace, sourceImportMode } from '../renderer/workspace-state';
import type { AppState, Review, Source } from '../shared';
const source:Source={id:'folder:/card',name:'Card',path:'/card',transport:'folder'};
const state=(extra:Partial<AppState>={}):AppState=>({preferences:{} as AppState['preferences'],sources:[source],jobs:[],history:[],platform:'darwin',organizeOptions:freshOrganizeOptions(),...extra});
const review=(extra:Partial<Review>={}):Review=>({id:'r',kind:'import',source,backup:false,plans:[],...extra});
test('a prepared review belongs to its immutable operation, regardless of the selected mode',()=>{
 assert.deepEqual(reviewWorkspace(state({review:review({backup:true})})),{page:'desk',mode:'files'});
 assert.deepEqual(reviewWorkspace(state({review:review()})),{page:'desk',mode:'media'});
 assert.deepEqual(reviewWorkspace(state({review:review({kind:'reorganize'})})),{page:'library',tool:'organize'});
 assert.equal(reviewWorkspace(state()),undefined);
});
test('new sources default to media; published folder mode wins over old job mode',()=>{
 assert.equal(sourceImportMode(source), 'media');
 assert.equal(sourceImportMode({...source,backup:true}), 'files');
 assert.deepEqual(reviewWorkspace(state({busyReview:true,reviewSourceId:source.id,sources:[Object.assign({},source,{backup:true})]})),{page:'desk',mode:'files'});
 assert.deepEqual(reviewWorkspace(state({busyReview:true,reviewSourceId:'library:/a'})),{page:'library',tool:'organize'});
});
