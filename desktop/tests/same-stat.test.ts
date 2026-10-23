import test from 'node:test';
import assert from 'node:assert/strict';
import {sameStat} from '../core/paths';

type Stat=import('node:fs').BigIntStats;
const stat=(over:Partial<Record<keyof Stat,bigint>>):Stat=>({dev:1n,ino:100n,size:4096n,mtimeNs:5n,ctimeNs:5n,birthtimeNs:7n,...over} as unknown as Stat);

test('an inode that changes from a synthetic exFAT number to a real one is the same file when everything else is equal',()=>{
  const synthetic=2n**63n+5n;
  assert.equal(sameStat(stat({ino:synthetic}),stat({ino:300n})),true);
  assert.equal(sameStat(stat({ino:300n}),stat({ino:-12n})),true);
});
test('that tolerance needs the same size, times and birth time',()=>{
  const synthetic=2n**63n+5n;
  assert.equal(sameStat(stat({ino:synthetic}),stat({ino:300n,birthtimeNs:8n})),false);
  assert.equal(sameStat(stat({ino:synthetic}),stat({ino:300n,mtimeNs:6n})),false);
  assert.equal(sameStat(stat({ino:synthetic}),stat({ino:300n,size:4097n})),false);
  assert.equal(sameStat(stat({ino:synthetic}),stat({ino:300n,dev:2n})),false);
});
test('two real inodes that differ are different files',()=>{
  assert.equal(sameStat(stat({ino:100n}),stat({ino:101n})),false);
  assert.equal(sameStat(stat({ino:100n}),stat({ino:100n})),true);
});
