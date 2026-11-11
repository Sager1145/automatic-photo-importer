import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Aperture, CodeXml, Factory, MapPin, Timer} from 'lucide-react';
import {categories} from '../renderer/exif-categories';
import {DEFAULT_EXIF_ICON, DETAIL_LABELS, categoryIcon, exifIcon, labelIcon} from '../renderer/exif-icons';
import {I18nProvider} from '../renderer/i18n';
import {FullExif,PreviewPanel} from '../renderer/browser/PreviewPanel';
import type {BrowserAPI} from '../renderer/browser/api';
import type {CatalogRow} from '../catalog/types';

test('every field of the preview details has its own icon, never the default',()=>{
 for(const label of DETAIL_LABELS){const icon=labelIcon(label);assert.ok(icon,label);assert.notEqual(icon,DEFAULT_EXIF_ICON,label);}
});
test('every curated EXIF row resolves to an icon by its label and by its tag, and every category has one',()=>{
 for(const category of categories){
  assert.ok(categoryIcon(category.id),category.id);
  for(const {tag,label} of category.tags){
   assert.ok(labelIcon(label),`label ${label}`);
   assert.equal(exifIcon(tag),labelIcon(label),`tag ${tag} takes the icon of ${label}`);
   assert.equal(exifIcon(`ExifIFD:${tag}`),labelIcon(label),`-G1 key of ${tag}`);
  }
 }
});
test('raw -G1 keys fall back to the tag name, then the group, then the default',()=>{
 assert.equal(exifIcon('ExifIFD:ExposureTime'),Timer);
 assert.equal(exifIcon('ExifIFD:SomethingNew'),Aperture);
 assert.equal(exifIcon('GPS:GPSVersionID'),MapPin);
 assert.equal(exifIcon('Nikon:WhoKnows'),Factory);
 assert.equal(exifIcon('MakerNotes:Copy1:Unknown'),Factory);
 assert.equal(exifIcon('XMP-dc:Subject'),CodeXml);
 assert.equal(exifIcon('Unheard:Zzz'),DEFAULT_EXIF_ICON);
 assert.equal(exifIcon('Zzz'),DEFAULT_EXIF_ICON);
 assert.equal(exifIcon('',undefined),DEFAULT_EXIF_ICON);
});
test('the preview details draw one aria-hidden icon before each label; the dt holds the label alone',()=>{
 const row={fileId:'f',libraryId:'l',relativePath:'2026/a.jpg',parentPath:'2026',name:'a.jpg',mediaKind:'JPEG',extension:'jpg',size:'10',metadataStatus:'ready',values:{metadataStatus:'ready',camera:'Nikon Z6',lens:'NIKKOR',fNumber:2.8,focalLengthMm:35,exposureSeconds:.008,iso:200},placement:{status:'inPlace',actualRelativePath:'2026/a.jpg',rulesScope:'r'},companionCount:2} as CatalogRow;
 const api={exif:async()=>({fields:{}})} as unknown as BrowserAPI;
 const html=renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(PreviewPanel,{row,online:false,api,onOrganization:()=>{},onReveal:()=>{},onClose:()=>{}})}));
 const list=html.match(/<dl class="browser-file-details">([^]*?)<\/dl>/)![1]!;
 const rows=[...list.matchAll(/<div><svg([^>]*)>[^]*?<\/svg><dt>([^<]*)<\/dt><dd>/g)];
 assert.ok(rows.length>=10,`${rows.length} rows with icons`);
 assert.equal(rows.length,(list.match(/<dt>/g)??[]).length,'every row has an icon');
 for(const [,attributes] of rows){assert.match(attributes!,/aria-hidden="true"/);assert.match(attributes!,/browser-field-icon/);}
 assert.deepEqual(rows.map(match=>match[2]),['Camera','Lens','Date','Aperture','Focal length','Shutter speed','ISO','Format','Size','Companion files','Current path']);
});
test('the browser Full EXIF shows the curated categories with icons, then every raw tag under All tags, each with an icon',()=>{
 const fields:Record<string,unknown>={'ExifIFD:FNumber':2.8,'ExifIFD:ExposureTime':.004,'IFD0:Model':'Nikon Z6','GPS:GPSLatitude':48.1,'XMP-dc:Subject':'cat','Odd:Thing':1};
 const html=renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(FullExif,{metadata:{camera:'Nikon Z6',exposure:{aperture:2.8,exposureTime:.004},fields}})}));
 assert.match(html,/<section class="browser-exif-category" data-category="exposure"><h4><svg[^]*?<\/svg>Exposure<\/h4>/);
 assert.match(html,/<div><svg[^>]*browser-field-icon[^>]*>(?:(?!<\/svg>)[^])*<\/svg><dt>Aperture<\/dt><dd>f\/2\.8<\/dd><\/div>/);
 assert.match(html,/<details class="browser-exif-all"><summary>All tags <small>6<\/small><\/summary><div class="browser-exif-scroll"/);
 const raw=html.slice(html.indexOf('browser-exif-scroll'));
 assert.equal((raw.match(/<dt>/g)??[]).length,6);assert.equal((raw.match(/<div style="height:72px"><svg/g)??[]).length,6,'every raw tag has an icon');
 assert.match(renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(FullExif,{metadata:{fields:{}}})})),/No EXIF found/);
});
