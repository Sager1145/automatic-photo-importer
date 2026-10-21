import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CapacityBar} from '../renderer/RootApp';
import {I18nProvider,languages,createTranslator} from '../renderer/i18n';
import type {Inventory} from '../shared';
const inventory:Inventory={files:[{path:'/card/a.NEF',relative:'a.NEF',kind:'RAW',size:400,included:true},{path:'/card/a.JPG',relative:'a.JPG',kind:'JPEG',size:100,included:true},{path:'/card/a.XMP',relative:'a.XMP',kind:'Other',size:50,included:true,companionOf:'/card/a.NEF'}],media:2,companions:1,unknown:0,bytes:550,unknownExtensions:{},elapsedMs:0};
const render=(props:Parameters<typeof CapacityBar>[0],language:typeof languages[number]='en')=>renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(CapacityBar,props)}));
test('capacity strip represents media, other used space and free space against physical total',()=>{
 const markup=render({total:1000,free:200,inventory});
 assert.match(markup,/aria-valuenow="80"/);
 for(const [kind,width] of [['NEF',40],['JPG',10],['other',30],['free',20]])assert.match(markup,new RegExp(`data-storage-kind="${kind}"[^>]*style="width:${width}%`));
 assert.ok(!markup.includes('XMP'));assert.ok(!markup.includes('Documents'));assert.ok(!markup.includes('macOS'));
});
test('unscanned destinations show actual used/free capacity without invented media categories in every language',()=>{
 for(const language of languages){const markup=render({total:1000,free:200},language);assert.ok(markup.includes(createTranslator(language)('Used')));assert.ok(!markup.includes('data-storage-kind="NEF"'));assert.match(markup,/data-storage-kind="other"[^>]*style="width:80%/);}
});
test('logical sizes exceeding physical usage are bounded and identified as scanned file estimates',()=>{
 const markup=render({total:1000,free:750,inventory});
 assert.match(markup,/data-storage-kind="NEF"[^>]*style="width:20%/);assert.match(markup,/data-storage-kind="JPG"[^>]*style="width:5%/);assert.match(markup,/data-storage-kind="free"[^>]*style="width:75%/);
 assert.ok(markup.includes('Media categories use scanned file sizes.'));
});
test('empty/full and unavailable drive readings do not create invalid or overflowing strips',()=>{
 assert.match(render({total:1000,free:2000}),/aria-valuenow="0"/);
 assert.match(render({total:1000,free:-5}),/aria-valuenow="100"/);
 for(const props of [{total:0,free:0},{total:1000},{total:NaN,free:5},{total:1000,free:NaN}])assert.ok(!render(props).includes('role="meter"'));
});

test('each picture/video extension has its own color, consistent between cards',()=>{
 const files=['NEF','ARW','JPG','PNG','MP4','MOV'].map((ext,index)=>({path:`/card/a.${ext}`,relative:`a.${ext}`,kind:(index<2?'RAW':index===2?'JPEG':index===3?'Images':'Videos') as Inventory['files'][number]['kind'],size:100,included:true}));
 const make=(list:typeof files)=>render({total:1000,free:200,inventory:{...inventory,files:list}});
 const colors=(markup:string)=>new Map([...markup.matchAll(/data-storage-kind="([^\"]+)"[^>]*style="width:[^;]+;background:([^\"]+)"/g)].filter(match=>!['other','free'].includes(match[1])).map(match=>[match[1],match[2]]));
 const all=colors(make(files));assert.equal(all.size,6);assert.equal(new Set(all.values()).size,6);
 const subset=colors(make(files.slice(2)));for(const [format,color] of subset)assert.equal(color,all.get(format));
});
