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
 assert.deepEqual(sidebarFit({lines:[],chrome:90,minimum:190,maximum:320}),{width:190,compact:[]});
});
