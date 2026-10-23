import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildTemplate,parseTemplate,type FolderPath} from '../folder-template';
import {plan} from '../core/index';

const dateFirst:FolderPath={order:'date',year:true,month:{on:true,full:true,english:false},day:{on:false,full:false}};

test('the builder writes the templates the user listed, date first or camera first',()=>{
 assert.equal(buildTemplate(dateFirst),'{year}/{yyyymm}/{camera}','the default');
 assert.equal(buildTemplate({...dateFirst,month:{...dateFirst.month,on:false}}),'{year}/{camera}');
 assert.equal(buildTemplate({...dateFirst,day:{on:true,full:true}}),'{year}/{yyyymm}/{yyyyMMdd}/{camera}');
 assert.equal(buildTemplate({...dateFirst,month:{on:true,full:false,english:false},day:{on:true,full:false}}),'{year}/{month}/{day}/{camera}');
 assert.equal(buildTemplate({...dateFirst,month:{on:true,full:false,english:true}}),'{year}/{monthName}/{camera}');
 assert.equal(buildTemplate({...dateFirst,month:{on:true,full:true,english:true}}),'{year}/{yearMonthName}/{camera}');
 assert.equal(buildTemplate({...dateFirst,month:{...dateFirst.month,on:false},day:{on:true,full:true}}),'{year}/{yyyyMMdd}/{camera}','day without month');
 assert.equal(buildTemplate({...dateFirst,order:'camera'}),'{camera}/{year}/{yyyymm}');
 assert.equal(buildTemplate({order:'camera',year:false,month:{on:false,full:true,english:false},day:{on:false,full:true}}),'{camera}');
});

test('saved templates the builder can express open in it; others stay custom',()=>{
 for(const template of ['{year}/{yyyymm}/{camera}','{camera}/{year}/{yyyymm}','{year}/{yyyyMMdd}/{camera}','{camera}/{yyyyMMdd}','{year}/{monthName}/{day}/{camera}','{camera}'])assert.equal(buildTemplate(parseTemplate(template)!),template,template);
 for(const template of ['{yyyymm}/{year}/{camera}','{year}/{camera}/{yyyymm}','{year}/{yyyymm}','photos/{year}/{camera}','{year}/{year}/{camera}','{year}-{month}/{camera}'])assert.equal(parseTemplate(template),undefined,template);
});

test('month names are English with the month number first, whatever the app language',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'folder-template-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'card'),backup=path.join(root,'backup');
 await fs.mkdir(source);await fs.mkdir(backup);await fs.writeFile(path.join(source,'DSC_0001.NEF'),'raw');
 const at=async(template:string)=>path.relative(backup,(await plan(source,[backup],{backup:false as const,template,layout:'flat',unknownRules:{}},async()=>({camera:'Nikon Z6III',date:'2026-10-24T09:00:00',fields:{}}))).plans[0]!.entries[0]!.destination);
 assert.equal(await at('{year}/{monthName}/{camera}'),'2026/10 October/Nikon Z6III/DSC_0001.NEF');
 assert.equal(await at('{camera}/{year}/{yearMonthName}/{day}'),'Nikon Z6III/2026/2026-10 October/24/DSC_0001.NEF');
});
