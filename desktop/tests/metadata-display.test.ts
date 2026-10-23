import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCaptureDateTime, formatExposure, shutterNoteText } from '../renderer/metadata-display';

test('capture display preserves recorded wall-clock time across an offset date boundary',()=>{
  assert.deepEqual(formatCaptureDateTime('2026-07-01T00:30:02+08:00','en'),{
    date:'Jul 1, 2026',time:'00:30:02',timezone:'UTC+08:00',
  });
  assert.deepEqual(formatCaptureDateTime('2026-06-30T23:59:58.0045-04:00','en'),{
    date:'Jun 30, 2026',time:'23:59:58.0045',timezone:'UTC-04:00',
  });
});

test('a missing capture timezone stays unknown and never borrows the host timezone',()=>{
  assert.deepEqual(formatCaptureDateTime('2026-08-02T13:50:35.13','en'),{date:'Aug 2, 2026',time:'13:50:35.13'});
  assert.deepEqual(formatCaptureDateTime('2026-08-02T13:50:35Z','en'),{date:'Aug 2, 2026',time:'13:50:35',timezone:'UTC'});
  assert.deepEqual(formatCaptureDateTime(undefined,'en'),{});
  assert.deepEqual(formatCaptureDateTime('2026-02-30T12:00:00+08:00','en'),{});
  assert.deepEqual(formatCaptureDateTime('2026-08-02T13:50:35+25:00','en'),{});
});

test('exposure display uses recorded units and readable shutter fractions',()=>{
  assert.deepEqual(formatExposure({lens:' NIKKOR Z 24-70mm f/2.8 S ',aperture:2.8,iso:6400,exposureTime:0.008,focalLength:50,exposureCompensation:-1/3},'en'),{
    lens:'NIKKOR Z 24-70mm f/2.8 S',aperture:'f/2.8',iso:'6400',shutterSpeed:'1/125 s',focalLength:'50 mm',exposureCompensation:'-0.33 EV',
  });
  assert.equal(formatExposure({exposureTime:1/3},'en').shutterSpeed,'1/3 s');
  assert.equal(formatExposure({exposureTime:0.3},'en').shutterSpeed,'0.3 s');
  assert.equal(formatExposure({exposureTime:2.5},'en').shutterSpeed,'2.5 s');
  assert.equal(formatExposure({exposureCompensation:0},'en').exposureCompensation,'0 EV');
  assert.equal(formatExposure({exposureCompensation:1},'en').exposureCompensation,'+1 EV');
  assert.deepEqual(formatExposure({iso:Infinity,aperture:0,exposureTime:-1,focalLength:NaN},'en'),{});
});

test('photo and video summaries keep full metadata collapsed while omitting video shutter counts in every language',async()=>{
  const {createElement} = await import('react');
  const {renderToStaticMarkup} = await import('react-dom/server');
  const {MetadataDialog} = await import('../renderer/RootApp');
  const {I18nProvider,languages,createTranslator,formatNumber} = await import('../renderer/i18n');
  const metadata = {camera:'NIKON Z f',date:'2026-08-02T13:50:35+08:00',exposure:{lens:'NIKKOR Z 40mm f/2',aperture:2,iso:400,exposureTime:1/125,focalLength:40,exposureCompensation:0},shutterCount:9059,shutterNote:'mechanical' as const,fields:{}};
  // The summary is the routing read; All metadata lists the full read's fields.
  const fields = {RawCameraTag:'Original raw value',NestedTag:{a:1}};
  for (const language of languages) for (const path of ['/card/photo.NEF','C:\\card\\clip.MXF']) {
    const video = path.endsWith('.MXF');
    const markup = renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(MetadataDialog,{preview:{path,metadata,fields,loading:false},onClose:()=>{},act:()=>{}})}));
    const t = createTranslator(language), note = t(shutterNoteText('mechanical'));
    if (language !== 'en') assert.notEqual(note, shutterNoteText('mechanical'), `the shutter note is translated into ${language}`);
    assert.ok(markup.includes('data-testid="metadata-capture-time">13:50:35</dd>'));
    assert.ok(markup.includes('data-testid="metadata-timezone">UTC+08:00</dd>'));
    assert.ok(markup.includes(t('Exposure settings')));
    assert.ok(markup.includes('NIKKOR Z 40mm f/2'));
    assert.ok(markup.includes('1/125 s'));
    assert.ok(markup.includes('0 EV'));
    assert.equal(markup.includes(`data-testid="metadata-shutter-count">${formatNumber(9059,language)}</dd>`),!video);
    const disclosureStart = markup.indexOf('<details');
    const disclosureMarkup = markup.slice(disclosureStart,markup.indexOf('</details>')+'</details>'.length);
    assert.equal(disclosureMarkup.includes(note),!video);
    assert.ok(!markup.slice(0,disclosureStart).includes(note));
    const details = markup.match(/<details\b[^>]*>/)?.[0];
    assert.ok(details?.includes('data-testid="metadata-details"'));
    assert.ok(!details?.match(/\bopen(?:=|\s|>)/));
    assert.ok(markup.includes('Original raw value'));
    assert.ok(markup.includes('Nested Tag'));
  }
});
