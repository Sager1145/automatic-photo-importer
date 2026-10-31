import assert from 'node:assert/strict';
import test from 'node:test';
import {cameraDisplayName} from '../camera-names';
import {cameraNameRows} from '../camera-names-data';

test('model codes show the names cameras and phones are sold under',()=>{
 assert.equal(cameraDisplayName('ILCE-7M4'),'Sony α7 IV');
 assert.equal(cameraDisplayName('NIKON Z 6_2'),'Nikon Z6 II');
 assert.equal(cameraDisplayName('SM-N975U1'),'Samsung Galaxy Note10+');
 assert.equal(cameraDisplayName('EVA-AL10'),'Huawei P9');
 assert.equal(cameraDisplayName('FC3582'),'DJI Mini 3 Pro');
});
test('lookups ignore case and spacing; unknown and readable models are unchanged',()=>{
 assert.equal(cameraDisplayName(' ilce-7m4 '),'Sony α7 IV');
 assert.equal(cameraDisplayName('Nikon  Z 6_2'),'Nikon Z6 II');
 assert.equal(cameraDisplayName('iPhone 14 Pro'),'iPhone 14 Pro');
 assert.equal(cameraDisplayName('QA Camera Alpha'),'QA Camera Alpha');
 assert.equal(cameraDisplayName(undefined),undefined);
});
test('no model code maps to two names, and no name still shows a Sony ILCE code',()=>{
 const seen=new Map<string,string>();
 for(const [,model,name] of cameraNameRows){const key=model.toLowerCase().replace(/\s+/g,' ').trim();assert.ok(!seen.has(key)||seen.get(key)===name,`${model}: ${seen.get(key)} / ${name}`);seen.set(key,name);assert.ok(!/\bILCE\b|\bILCA\b/.test(name),name);}
});
