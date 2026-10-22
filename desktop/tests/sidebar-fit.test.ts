import test from 'node:test';
import assert from 'node:assert/strict';
import { sidebarFit, shortCapacity } from '../renderer/sidebar-fit';

const bytes=(value:number)=>value>=1e12?`${(value/1e12).toFixed(2)} TB`:`${(value/1e9).toFixed(1)} GB`;

test('the short capacity drops the words and shares the unit when both sizes use it',()=>{
 assert.equal(shortCapacity(342.9e9,2e12,bytes),'342.9 GB/2.00 TB');
 assert.equal(shortCapacity(120.5e9,500.0e9,bytes),'120.5/500.0 GB');
});

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
