import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider} from '../renderer/i18n';
import {EjectButton} from '../renderer/RootApp';
import type {Source} from '../shared';

const card:Source={id:'volume:SD',name:'SD',path:'/Volumes/SD',transport:'storage'} as Source;
const render=(props:{busy?:boolean;ejecting?:boolean})=>renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(EjectButton,{source:card,act:()=>{},...props})}));
const button=(markup:string)=>markup.match(/<button[^>]*data-testid="eject-source"[^>]*>/)?.[0]??'';

test('an idle drive offers Eject', () => {
  const tag=button(render({}));
  assert.match(tag,/aria-label="Eject: SD"/);
  assert.doesNotMatch(tag,/disabled/);
});

test('a drive being ejected says so and cannot be ejected again', () => {
  const tag=button(render({ejecting:true}));
  assert.match(tag,/aria-label="Ejecting… SD"/);
  assert.match(tag,/aria-busy="true"/);
  assert.match(tag,/title="Ejecting…"/);
  assert.match(tag,/disabled/);
});

test('a drive in use waits with its reason', () => {
  const tag=button(render({busy:true}));
  assert.match(tag,/title="In use. Wait for it to finish first."/);
  assert.match(tag,/disabled/);
});
