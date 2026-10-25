import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPreferences,normalizePreferences} from '../preferences';
import {acceptedPreferences,lockedPreferenceKeys} from '../settings-lock';

test('unknown files default to being kept, with a folder named Unknown files, job-locked',()=>{
 assert.equal(defaultPreferences.noMetadataHandling,'folder');assert.equal(defaultPreferences.noMetadataFolder,'Unknown files');
 assert.deepEqual(lockedPreferenceKeys({noMetadataHandling:'folder',noMetadataFolder:'x',language:'ja'}),['noMetadataHandling','noMetadataFolder']);
 assert.deepEqual(acceptedPreferences({noMetadataHandling:'folder'},true),{});
 assert.deepEqual(acceptedPreferences({noMetadataHandling:'folder'},false),{noMetadataHandling:'folder'});
});

test('the handling and folder name are validated',()=>{
 const loaded=normalizePreferences({noMetadataHandling:'delete',noMetadataFolder:'a/b'});
 assert.equal(loaded.noMetadataHandling,'folder');assert.equal(loaded.noMetadataFolder,'Unknown files');
 assert.equal(normalizePreferences({noMetadataHandling:'folder',noMetadataFolder:'Ohne Datum'}).noMetadataFolder,'Ohne Datum');
 assert.equal(normalizePreferences({noMetadataFolder:'2024'}).noMetadataFolder,'Unknown files');
});
