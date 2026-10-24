import test from 'node:test';
import assert from 'node:assert/strict';
import {publishSourceModes} from '../source-modes';
import type {Source} from '../shared';
const folder:Source={id:'folder:/photos',name:'Photos',path:'/photos',transport:'folder',selected:true,free:100};
test('chosen source mode is published before a job exists and can change without changing identity or selection',()=>{
 const registered=new Map([[folder.id,{backup:true}]]);
 const backup=publishSourceModes([folder],registered)[0];assert.deepEqual(backup,{...folder,backup:true});
 registered.set(folder.id,{backup:false});const media=publishSourceModes([backup],registered)[0];assert.deepEqual(media,{...folder,backup:false});
 assert.equal(folder.backup,undefined);
});
test('discovered storage replacement keeps its explicit mode; unknown storage/camera sources are not reinterpreted',()=>{
 const drive:Source={...folder,id:'volume-id',transport:'storage'},camera:Source={id:'camera',name:'USB',path:'camera:',transport:'camera'};
 const result=publishSourceModes([drive,camera],new Map([['volume-id',{backup:true}]]));
 assert.deepEqual(result[0],{...drive,backup:true});assert.equal(result[1],camera);assert.equal(result[1].backup,undefined);
 const unknown=publishSourceModes([drive],new Map());assert.equal(unknown[0],drive);assert.equal(unknown[0].backup,undefined);
});
