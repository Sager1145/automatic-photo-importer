import test from 'node:test';
import assert from 'node:assert/strict';
import {migrationGate,MIGRATION_START_DELAY} from '../migration-gate';

test('the converter waits 30 s after launch, and 30 s again after the drive was last busy',()=>{
 let clock=1000;const gate=migrationGate(()=>clock);
 assert.equal(MIGRATION_START_DELAY,30000);
 assert.equal(gate.wait(),30000,'not on the first refresh');
 clock+=29000;assert.equal(gate.wait(),1000);
 gate.busy();assert.equal(gate.wait(),30000,'a job restarts the wait');
 clock+=30000;assert.equal(gate.wait(),0,'idle long enough');
});

test('paused, it never starts; resumed, it starts at the next idle moment',()=>{
 let clock=0;const gate=migrationGate(()=>clock);
 clock+=60000;assert.equal(gate.wait(),0);
 gate.pause();assert.equal(gate.paused,true);assert.equal(gate.wait(),Infinity);
 clock+=600000;assert.equal(gate.wait(),Infinity,'stays paused');
 gate.resume();assert.equal(gate.paused,false);assert.equal(gate.wait(),0,'no second wait after the user resumes');
 gate.busy();assert.equal(gate.wait(),30000,'but a job still comes first');
});
