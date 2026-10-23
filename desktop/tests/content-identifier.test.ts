import test from 'node:test';
import assert from 'node:assert/strict';
import {metadataFromTags} from '../platform/metadata';

test('Make and the Live Photo ContentIdentifier are read from the routing tags, even without details',()=>{
 const still=metadataFromTags({'IFD0:Make':'Apple','Apple:ContentIdentifier':' ABC-1 '},{details:false});
 assert.equal(still.make,'Apple');assert.equal(still.contentId,'ABC-1');
 const mov=metadataFromTags({'Keys:ContentIdentifier':'ABC-1'},{details:false});
 assert.equal(mov.contentId,'ABC-1');assert.equal(mov.make,undefined);
});
