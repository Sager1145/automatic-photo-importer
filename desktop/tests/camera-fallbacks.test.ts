import test from 'node:test';
import assert from 'node:assert/strict';
import {metadataFromTags} from '../platform/metadata';

const camera=(tags:Record<string,unknown>)=>metadataFromTags(tags,{details:false,file:'clip.mov'}).camera;

test('Samsung video uses the Galaxy author so it matches the phone photos',()=>{
 assert.equal(camera({'Samsung:SamsungModel':'SM-S9180','UserData:Author':'Galaxy S23 Ultra'}),'Galaxy S23 Ultra');
});
test('Samsung video with a non-Galaxy author falls back to the Samsung model',()=>{
 assert.equal(camera({'Samsung:SamsungModel':'SM-S9180','UserData:Author':'John'}),'SM-S9180');
});
test('an Author is never a camera without a Samsung trailer',()=>{
 assert.equal(camera({'UserData:Author':'Galaxy X'}),undefined);
});
test('CinemaDNG frames use IFD0 UniqueCameraModel',()=>{
 assert.equal(camera({'IFD0:UniqueCameraModel':'Blackmagic Pocket Cinema Camera 4K'}),'Blackmagic Pocket Cinema Camera 4K');
});
test('UniqueCameraModel never overrides a real Model',()=>{
 assert.equal(camera({'IFD0:Model':'X','IFD0:UniqueCameraModel':'Y'}),'X');
});

const origin=(tags:Record<string,unknown>,file='x.jpg')=>metadataFromTags(tags,{details:false,file}).origin;
test('cameraless files are routed by source',()=>{
 assert.equal(origin({'ExifIFD:UserComment':'screenshot'}),'Screenshots');
 assert.equal(origin({},'/a/Screenshot_2024.png'),'Screenshots');
 assert.equal(origin({},'/a/屏幕截图 2024.png'),'Screenshots');
 assert.equal(origin({'UserData:Author':'ReplayKitRecording'},'a.mov'),'Screen Recordings');
 assert.equal(origin({},'/a/RPReplay_Final1.MP4'),'Screen Recordings');
 assert.equal(origin({'UserData:Copyright':'wxmm_abc'},'a.mp4'),'WeChat');
 assert.equal(origin({'XMP:Description':'{"WXVer":1}'}),'WeChat');
 assert.equal(origin({},'/a/mmexport1700.jpg'),'WeChat');
});
test('a real camera wins over the source rules, and no match stays unknown',()=>{
 assert.equal(origin({'IFD0:Model':'X','ExifIFD:UserComment':'Screenshot'}),undefined);
 assert.equal(origin({'ExifIFD:UserComment':'hello'},'/a/IMG_1.jpg'),undefined);
});
