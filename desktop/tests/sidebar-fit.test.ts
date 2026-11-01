import test from 'node:test';
import assert from 'node:assert/strict';
import { sidebarFit } from '../renderer/sidebar-fit';

test('a sidebar too narrow for the full text uses the short text, and only for the lines that overflow',()=>{
 const fit=sidebarFit({lines:[{natural:180,available:150},{natural:120,available:150}],chrome:90,minimum:190,maximum:240});
 assert.deepEqual(fit.compact,[true,false]);
});

test('the sidebar grows to fit the longest full text, within its limits',()=>{
 assert.equal(sidebarFit({lines:[{natural:180,available:150}],chrome:90,minimum:190,maximum:320}).width,270);
 assert.equal(sidebarFit({lines:[{natural:300,available:150}],chrome:90,minimum:190,maximum:320}).width,320);
 assert.equal(sidebarFit({lines:[{natural:40,available:150}],chrome:90,minimum:190,maximum:320}).width,190);
});

test('once the sidebar has grown, a line that now fits shows the full text',()=>{
 // available is measured at the current width; growth adds the difference to every line.
 const fit=sidebarFit({lines:[{natural:180,available:150}],chrome:90,minimum:190,maximum:320,current:240});
 assert.equal(fit.width,270);assert.deepEqual(fit.compact,[false]);
});

test('with no drives the sidebar keeps its minimum width',()=>{
 assert.deepEqual(sidebarFit({lines:[],chrome:90,minimum:190,maximum:320}),{width:190,compact:[],grown:false});
});

test('each line can bring its own chrome: a name beside its buttons needs more room around it than a capacity line',()=>{
 // A 100 px name in a row with 160 px of icon and buttons needs 260; a 180 px capacity line with 60 px of margins needs 240.
 const fit=sidebarFit({lines:[{natural:180,available:190,chrome:60},{natural:100,available:90,chrome:160}],chrome:60,minimum:190,maximum:360,current:250});
 assert.equal(fit.width,260);
 assert.deepEqual(fit.compact,[false,false]);
});

test('fractional measurements round the width up, so the line that set it fits',()=>{
 const fit=sidebarFit({lines:[{natural:120.3,available:100,chrome:80}],chrome:60,minimum:190,maximum:360,current:180});
 assert.equal(fit.width,201);assert.deepEqual(fit.compact,[false]);
});

test('while the same drives are listed the sidebar holds its width: it never creeps while lines fit, and grows once for a line that does not',()=>{
 // Real case on Windows: one line's room did not track the sidebar's width, and re-deriving the width each
 // progress tick grew it a pixel at a time from 285 to the 360 limit. Holding, a fitting line changes nothing.
 let hold={width:285,grown:false};
 for(let tick=0;tick<100;tick++){
  const fit=sidebarFit({lines:[{natural:180,available:184,chrome:110},{natural:120,available:119.6,chrome:166}],chrome:90,minimum:190,maximum:360,current:hold.width,hold});
  hold={width:fit.width,grown:fit.grown};
 }
 assert.equal(hold.width,285);
 // A line that really does not fit grows it by its shortfall, once; if it still does not fit it uses the short text.
 const first=sidebarFit({lines:[{natural:200,available:184}],chrome:90,minimum:190,maximum:360,current:285,hold:{width:285,grown:false}});
 assert.deepEqual([first.width,first.grown],[301,true]);
 const again=sidebarFit({lines:[{natural:200,available:190}],chrome:90,minimum:190,maximum:360,current:301,hold:{width:301,grown:true}});
 assert.deepEqual([again.width,again.compact],[301,[true]]);
 // The hold never exceeds the window's limit.
 assert.equal(sidebarFit({lines:[{natural:100,available:180}],chrome:90,minimum:190,maximum:240,current:270,hold:{width:270,grown:false}}).width,240);
});
