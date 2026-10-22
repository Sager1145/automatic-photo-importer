import test from 'node:test';
import assert from 'node:assert/strict';
import type { BigIntStats } from 'node:fs';
import { sameStat, statKey, unreliableIno } from '../core/paths';

const stat=(over:Partial<Record<'dev'|'ino'|'size'|'mtimeNs'|'ctimeNs'|'birthtimeNs',bigint>>={}):BigIntStats=>({dev:1n,ino:42n,size:10n,mtimeNs:5n,ctimeNs:6n,birthtimeNs:7n,...over}) as BigIntStats;
const synthetic=18446744073709254708n;

test('an empty file with a synthetic inode is the same file when only the inode changed',()=>{
  const a=stat({size:0n,ino:synthetic}),b=stat({size:0n,ino:synthetic-1000n});
  assert.ok(unreliableIno(a));
  assert.ok(sameStat(a,b));
  assert.equal(statKey(a),statKey(b));
});
test('a synthetic inode seen as signed bigint is also unreliable',()=>{
  const a=stat({size:0n,ino:BigInt.asIntN(64,synthetic)}),b=stat({size:0n,ino:BigInt.asIntN(64,synthetic-5n)});
  assert.ok(sameStat(a,b));
  assert.ok(unreliableIno(stat({ino:-5n})));
});
test('without a stable inode, size, times and birth time still have to match',()=>{
  const a=stat({size:0n,ino:synthetic});
  for(const field of ['dev','mtimeNs','ctimeNs','birthtimeNs'] as const) assert.ok(!sameStat(a,stat({size:0n,ino:synthetic-1n,[field]:99n})),field);
  assert.ok(!sameStat(a,stat({size:1n,ino:synthetic})));
});
test('a normal file is still told apart by its inode',()=>{
  assert.ok(!unreliableIno(stat()));
  assert.ok(sameStat(stat(),stat()));
  assert.ok(!sameStat(stat(),stat({ino:43n})));
  assert.notEqual(statKey(stat()),statKey(stat({ino:43n})));
});
