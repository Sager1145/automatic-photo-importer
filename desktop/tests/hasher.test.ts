import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {hasher} from '../core/hasher';

const reference=(chunks:Buffer[])=>{const hash=createHash('sha256');for(const chunk of chunks)hash.update(chunk);return hash.digest('hex');};

test('worker hashing matches SHA-256 for empty, small and many-chunk inputs',async()=>{
 for(const chunks of [[],[Buffer.from('a')],Array.from({length:40},()=>randomBytes(64*1024))]) {
  const hash=hasher();for(const chunk of chunks)await hash.update(chunk);
  assert.equal(await hash.digest(),reference(chunks));
 }
});

test('a chunk is copied when queued, so the caller may reuse its buffer at once',async()=>{
 const buffer=Buffer.alloc(1024),hash=hasher(),seen:Buffer[]=[];
 for(let round=0;round<10;round++){buffer.fill(round);seen.push(Buffer.from(buffer));await hash.update(buffer);}
 assert.equal(await hash.digest(),reference(seen));
});

test('many hashes at once stay separate and in order',async()=>{
 const inputs=Array.from({length:12},()=>Array.from({length:6},()=>randomBytes(32*1024)));
 const results=await Promise.all(inputs.map(async chunks=>{const hash=hasher();for(const chunk of chunks)await hash.update(chunk);return hash.digest();}));
 assert.deepEqual(results,inputs.map(reference));
});

test('a dropped hash leaves the next one on the same worker unaffected',async()=>{
 const dropped=hasher();await dropped.update(Buffer.from('partial'));dropped.drop();
 const hash=hasher();await hash.update(Buffer.from('whole'));
 assert.equal(await hash.digest(),reference([Buffer.from('whole')]));
});
