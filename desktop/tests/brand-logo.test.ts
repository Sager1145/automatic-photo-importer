import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {arrowPath,arrowStroke,cardPath,contactStroke,contactXs,contactsPath,foldPath,trayPath} from '../renderer/brand-geometry';
import {BrandLogo} from '../renderer/BrandLogo';

const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','..');
const layer=(name:string)=>fs.readFileSync(path.join(root,'Icon.icon','Assets',name),'utf8');

test('the Icon Composer layers draw the same shapes as the React logo',()=>{
 assert.ok(layer('01-card.svg').includes(`d="${cardPath}"`));
 assert.ok(layer('01-card.svg').includes(`d="${foldPath}"`));
 assert.ok(layer('02-contacts.svg').includes(`d="${contactsPath}"`));
 assert.ok(layer('02-contacts.svg').includes(`stroke-width="${contactStroke}"`));
 assert.ok(layer('03-arrow.svg').includes(`d="${arrowPath}"`));
 assert.ok(layer('04-tray.svg').includes(`d="${trayPath}"`));
 for(const file of ['03-arrow.svg','04-tray.svg'])assert.ok(layer(file).includes(`stroke-width="${arrowStroke}"`));
 for(const file of fs.readdirSync(path.join(root,'Icon.icon','Assets')))assert.equal(fs.readFileSync(path.join(root,'Assets','IconLayers',file),'utf8'),layer(file));
});

test('the contacts are evenly spaced and centred on the card',()=>{
 const gaps=contactXs.slice(1).map((x,i)=>x-contactXs[i]!);
 assert.equal(new Set(gaps).size,1);
 assert.equal((contactXs[0]+contactXs.at(-1)!)/2,512);
});

test('the shared logo has five vector parts: tile, card, four contacts, arrow, tray',()=>{
 const html=renderToStaticMarkup(createElement(BrandLogo,{className:'brand-logo'}));
 assert.match(html,/class="brand-logo"/);
 for(const part of ['logo-tile','logo-card','logo-contacts','logo-arrow','logo-tray'])assert.match(html,new RegExp(`class="${part}"`));
});
