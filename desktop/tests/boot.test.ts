import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {bootTiming,createBootController,type BootPhase} from '../renderer/boot-controller';

const run=(reduced:boolean)=>{
 mock.timers.enable({apis:['setTimeout']});
 const phases:BootPhase[]=[];
 const controller=createBootController({reduced,onPhase:phase=>phases.push(phase)});
 return {controller,phases};
};
test.afterEach(()=>mock.timers.reset());

test('the splash plays the intro, then glides as soon as the first state has arrived, in 1.2 s at most',()=>{
 const {controller,phases}=run(false);
 controller.ready();
 mock.timers.tick(bootTiming.intro);
 assert.deepEqual(phases,['hold','fly']);
 mock.timers.tick(bootTiming.fly);
 assert.equal(controller.phase,'done');
 assert.ok(bootTiming.intro+bootTiming.fly<=1200);
});

test('a slow first state never delays readiness: the splash holds, then finishes the moment the state arrives',()=>{
 const {controller,phases}=run(false);
 mock.timers.tick(1500);
 assert.deepEqual(phases,['hold']);
 controller.ready();
 assert.deepEqual(phases,['hold','fly']);
 mock.timers.tick(bootTiming.fly);
 assert.equal(controller.phase,'done');
});

test('the splash is removed by the hard cap even when no state ever arrives',()=>{
 const {controller}=run(false);
 mock.timers.tick(bootTiming.cap-1);
 assert.notEqual(controller.phase,'done');
 mock.timers.tick(1);
 assert.equal(controller.phase,'done');
 assert.equal(bootTiming.cap,2500);
});

test('skipping removes the splash at once and nothing fires afterwards',()=>{
 const {controller,phases}=run(false);
 mock.timers.tick(100);
 controller.skip();
 assert.deepEqual(phases,['done']);
 controller.ready();
 mock.timers.tick(bootTiming.cap);
 assert.deepEqual(phases,['done']);
});

test('reduced motion waits for the first state and then only crossfades for 150 ms',()=>{
 const {controller,phases}=run(true);
 mock.timers.tick(bootTiming.intro+bootTiming.fly);
 assert.deepEqual(phases,[]);
 controller.ready();
 assert.deepEqual(phases,['fade']);
 mock.timers.tick(150);
 assert.deepEqual(phases,['fade','done']);
});

test('the splash renders the logo parts, and reduced motion switches it to the crossfade',async()=>{
 const {Boot,resetBootForTests}=await import('../renderer/Boot');
 const reduced={value:false};
 Object.assign(globalThis,{window:{matchMedia:(query:string)=>({matches:query.includes('reduce')&&reduced.value})}});
 resetBootForTests();
 const full=renderToStaticMarkup(createElement(Boot));
 assert.match(full,/data-boot-splash/);
 assert.match(full,/data-mode="full"/);
 for(const part of ['logo-tile','logo-card','logo-arrow','logo-tray'])assert.match(full,new RegExp(`class="${part}"`));
 assert.equal(full.match(/class="logo-contact"/g)?.length,4);
 reduced.value=true;
 assert.match(renderToStaticMarkup(createElement(Boot)),/data-mode="crossfade"/);
});
