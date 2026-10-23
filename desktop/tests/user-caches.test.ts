import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {gzipSync} from 'node:zlib';
import {cacheRecord,readCache} from '../platform/user-caches';
import {loadListingHint,listingScope} from '../platform/listing-memory';
import {loadPlacement} from '../platform/placement-memory';

test('this Mac\'s caches are read in the v5 shape only; the earlier shape is ignored, not converted',async t=>{
 const store=await fs.mkdtemp(path.join(os.tmpdir(),'user-caches-'));t.after(()=>fs.rm(store,{recursive:true,force:true}));
 const scope=listingScope('/Volumes/CARD',undefined,false);
 await fs.writeFile(path.join(store,'listing-memory.json'),JSON.stringify(cacheRecord('listing',{scopes:{[scope]:{files:12,bytes:3400,at:'2026-01-01T00:00:00Z'}}})));
 assert.deepEqual(await loadListingHint(store,'/Volumes/CARD',undefined,false),{files:12,bytes:3400});
 await fs.writeFile(path.join(store,'listing-memory.json'),JSON.stringify({version:1,scopes:{[scope]:{files:12,bytes:3400,at:'2026-01-01T00:00:00Z'}}}));
 assert.equal(await loadListingHint(store,'/Volumes/CARD',undefined,false),undefined);
 await fs.mkdir(path.join(store,'placement-memory'));
 const placement=path.join(store,'placement-memory','0123456789abcdef0123456789abcdef.json.gz');
 await fs.writeFile(placement,gzipSync(JSON.stringify({version:1,scope:'s',dirs:[''],d:[0],n:['A.JPG'],s:[5],m:['1'],i:['2']})));
 assert.equal(await loadPlacement(store,'0123456789abcdef0123456789abcdef','s'),undefined);
 assert.equal(readCache({version:1},'eta',1),undefined);
 assert.deepEqual(await fs.readdir(store),['listing-memory.json','placement-memory'],'nothing was rewritten');
});
