import test from 'node:test';
import assert from 'node:assert/strict';
import {metadataFromTags} from '../platform/metadata';

test('explicit photo editor software identifies editor provenance',()=>{
  for(const software of ['Adobe Photoshop 27.0 (Macintosh)','Adobe Photoshop Lightroom Classic 15.0','Adobe Lightroom 8.5','Capture One 16.6','darktable 5.2.1','RawTherapee 5.12','Affinity Photo 2 2.6','DxO PhotoLab 9','DxO PureRAW 5','DxO OpticsPro 11','GIMP 3.0.4']){
    for(const tag of ['IFD0:Software','IFD0:Copy1:Software','EXIF:ProcessingSoftware','XMP-xmp:CreatorTool','XMP-exifEX:ImageEditingSoftware','XMP-exifEX:RAWDevelopingSoftware']){
      assert.equal(metadataFromTags({[tag]:software}).edited,true,`${tag}: ${software}`);
    }
  }
});

test('ExifTool flattened and structured XMP history identifies editor software',()=>{
  for(const history of [
    {'XMP-xmpMM:HistorySoftwareAgent':'Adobe Photoshop 26.1'},
    {'XMP-xmpMM:HistorySoftwareAgent':['ExifTool 13.59','darktable 5.2']},
    {'XMP-xmpMM:History':[{Action:'saved',SoftwareAgent:'Adobe Photoshop Lightroom Classic 14.0'}]},
    {'XMP-xmpMM:History':[{action:'saved',softwareAgent:'Capture One 16.5'}]},
  ])assert.equal(metadataFromTags(history).edited,true);
});

test('camera firmware, metadata utilities, unknown software and adjustment settings are not editor provenance',()=>{
  for(const tags of [
    {'IFD0:Software':'ILCE-7M5 v1.00'},
    {'IFD0:Software':'Nikon Z 8 Ver.03.10'},
    {'IFD0:Software':'ExifTool 13.59'},
    {'XMP-xmp:CreatorTool':'Adobe Acrobat Pro'},
    {'IFD0:Software':'Unknown editor 1.0'},
    {'XMP-crs:HasSettings':true},
    {'XMP-crs:HasSettings':'True','XMP-crs:Version':'17.0'},
    {'XMP-exifEX:MetadataEditingSoftware':'Adobe Photoshop 26.1'},
    {'File:FileName':'Lightroom-export.jpg'},
    {'XMP-xmpMM:History':[{Action:'Adobe Photoshop',Parameters:'darktable'}]},
    {'XMP-xmpMM:HistorySoftwareAgent':[{name:'Adobe Photoshop'}]},
    {'XMP-xmp:CreatorTool':'NotPhotoshop'},
  ])assert.equal(metadataFromTags(tags).edited,undefined,JSON.stringify(tags));
});

test('routing metadata retains the same editor provenance as detailed inspection',()=>{
  for(const software of ['Adobe Photoshop Lightroom Classic 15.0','Nikon Z 8 Ver.03.10']){
    const tags={'IFD0:Model':'NIKON Z 8','ExifIFD:DateTimeOriginal':'2025:04:03 02:01:00','XMP-xmpMM:HistorySoftwareAgent':['ExifTool 13.59',software]};
    const detailed=metadataFromTags(tags),routing=metadataFromTags(tags,{details:false});
    assert.equal(routing.edited,detailed.edited);
    assert.equal(routing.camera,detailed.camera);
    assert.equal(routing.date,detailed.date);
    assert.deepEqual(routing.fields,{});
  }
});

test('lightweight metadata retains parser errors without copying full EXIF fields',()=>{
 const info=metadataFromTags({'ExifTool:Error':'Invalid file format','EXIF:Model':'Camera','EXIF:ISO':400},{details:false});
 assert.equal(info.fields['ExifTool:Error'],'Invalid file format');assert.equal(info.fields['EXIF:ISO'],undefined);
});
