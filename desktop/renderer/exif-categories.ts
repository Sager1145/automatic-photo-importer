/** A curated, readable view of a file's full EXIF. Tags are ExifTool's documented names (exiftool.org/TagNames) read
 * with -G1 groups and -n (numbers, not print conversions); only the tags below are shown, under friendly labels and
 * units. Binary data, thumbnails, internal bookkeeping and repeated copies of a tag are never shown. Labels and
 * titles are English catalog keys: the caller translates them. Exposure and capture time are the interpreter's
 * values (Metadata.exposure and .date) in the summary card's format, so the two views never disagree. */
import type { Language, Metadata } from '../shared';
import { formatCaptureDateTime, formatExposure, type ExposureDisplay } from './metadata-display';

export type ExifCategoryId = 'exposure' | 'camera' | 'datetime' | 'location' | 'image' | 'maker' | 'file';
export interface ExifRow { label: string; value: string; tag: string; }
export interface ExifCategory { id: ExifCategoryId; title: string; rows: ExifRow[]; }
type Formatter = (value: unknown) => string | undefined;
/** The interpreted values: the summary card's exposure and capture time. */
interface Interpreted { exposure: ExposureDisplay; captured?: string }

const text: Formatter = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() || undefined : undefined;
const number = (value: unknown) => { const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN; return Number.isFinite(n) ? n : undefined; };
const trim = (n: number, digits = 2) => String(Number(n.toFixed(digits)));
const unit = (suffix: string, digits = 1): Formatter => value => { const n = number(value); return n === undefined ? undefined : `${trim(n, digits)} ${suffix}`; };
const lookup = (names: Record<number, string>): Formatter => value => { const n = number(value); return n === undefined ? undefined : names[n] ?? String(n); };
const flash: Formatter = value => { const n = number(value); return n === undefined ? undefined : n & 1 ? 'Flash fired' : 'No flash'; };
const degrees: Formatter = value => { const n = number(value); return n === undefined ? undefined : `${n.toFixed(5)}°`; };
const meters: Formatter = value => { const n = number(value); return n === undefined ? undefined : `${trim(n, 1)} m`; };
/** ExifTool prints other dates as 2024:05:06 07:08:09 (with optional fraction and zone); show them as ISO-like text. */
const date: Formatter = value => typeof value === 'string' && value.trim() ? value.trim().replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3') : undefined;
const pixels: Formatter = value => { const n = number(value); return n === undefined ? undefined : `${Math.round(n)} px`; };
const megapixels: Formatter = value => { const n = number(value); return n === undefined ? undefined : `${trim(n, 1)} MP`; };

interface Spec { tag: string; label: string; format?: Formatter; /** Shown from the interpreted values instead of the tag's own. */ interpreted?: (values: Interpreted) => string | undefined; }
const spec = (tag: string, label: string, format: Formatter = text): Spec => ({ tag, label, format });
const interpreted = (tag: string, label: string, value: (values: Interpreted) => string | undefined): Spec => ({ tag, label, interpreted: value });

export const categories: { id: ExifCategoryId; title: string; tags: Spec[] }[] = [
  { id: 'exposure', title: 'Exposure', tags: [
    interpreted('ExposureTime', 'Shutter speed', values => values.exposure.shutterSpeed), interpreted('FNumber', 'Aperture', values => values.exposure.aperture),
    interpreted('ISO', 'ISO', values => values.exposure.iso), interpreted('ExposureCompensation', 'Exposure compensation', values => values.exposure.exposureCompensation),
    spec('ExposureProgram', 'Exposure program', lookup({ 0: 'Not defined', 1: 'Manual', 2: 'Program', 3: 'Aperture priority', 4: 'Shutter priority', 5: 'Creative', 6: 'Action', 7: 'Portrait', 8: 'Landscape' })),
    spec('ExposureMode', 'Exposure mode', lookup({ 0: 'Auto', 1: 'Manual', 2: 'Auto bracket' })),
    spec('MeteringMode', 'Metering mode', lookup({ 0: 'Unknown', 1: 'Average', 2: 'Center-weighted', 3: 'Spot', 4: 'Multi-spot', 5: 'Multi-segment', 6: 'Partial', 255: 'Other' })),
    spec('WhiteBalance', 'White balance', lookup({ 0: 'Auto', 1: 'Manual' })), spec('Flash', 'Flash', flash),
    interpreted('FocalLength', 'Focal length', values => values.exposure.focalLength), spec('FocalLengthIn35mmFormat', '35 mm equivalent', unit('mm')),
    spec('SubjectDistance', 'Subject distance', meters), spec('DigitalZoomRatio', 'Digital zoom', text), spec('SceneCaptureType', 'Scene type', lookup({ 0: 'Standard', 1: 'Landscape', 2: 'Portrait', 3: 'Night' })),
  ] },
  { id: 'camera', title: 'Camera & Lens', tags: [
    spec('Make', 'Camera make'), spec('Model', 'Camera model'), spec('SerialNumber', 'Camera serial number'), spec('InternalSerialNumber', 'Internal serial number'),
    spec('LensMake', 'Lens make'), spec('LensModel', 'Lens'), spec('LensID', 'Lens ID'), spec('LensSerialNumber', 'Lens serial number'),
    spec('Software', 'Software'), spec('FirmwareVersion', 'Firmware'), spec('Artist', 'Photographer'), spec('Copyright', 'Copyright'),
  ] },
  { id: 'datetime', title: 'Date & Time', tags: [
    interpreted('DateTimeOriginal', 'Captured', values => values.captured), spec('SubSecTimeOriginal', 'Sub-seconds'), spec('OffsetTimeOriginal', 'Time zone offset'),
    spec('CreateDate', 'Created', date), spec('ModifyDate', 'Modified', date), spec('CreationDate', 'Creation date', date), spec('TimeZone', 'Time zone'),
  ] },
  { id: 'location', title: 'Location', tags: [
    spec('GPSLatitude', 'Latitude', degrees), spec('GPSLongitude', 'Longitude', degrees), spec('GPSAltitude', 'Altitude', meters),
    spec('City', 'City'), spec('State', 'State or province'), spec('Country', 'Country'),
  ] },
  { id: 'image', title: 'Image', tags: [
    spec('ExifImageWidth', 'Width', pixels), spec('ExifImageHeight', 'Height', pixels), spec('ImageWidth', 'Width', pixels), spec('ImageHeight', 'Height', pixels),
    spec('Megapixels', 'Resolution', megapixels),
    spec('Orientation', 'Orientation', lookup({ 1: 'Normal', 2: 'Mirrored', 3: 'Rotated 180°', 4: 'Mirrored vertically', 5: 'Mirrored, rotated 90° left', 6: 'Rotated 90° right', 7: 'Mirrored, rotated 90° right', 8: 'Rotated 90° left' })),
    spec('ColorSpace', 'Color space', lookup({ 1: 'sRGB', 2: 'Adobe RGB', 65535: 'Uncalibrated' })), spec('BitsPerSample', 'Bits per sample'),
    spec('Compression', 'Compression', lookup({ 1: 'Uncompressed', 6: 'JPEG', 7: 'JPEG', 34892: 'Lossy JPEG (DNG)' })),
  ] },
  { id: 'maker', title: 'Maker Notes', tags: [
    spec('ShutterCount', 'Shutter count'), spec('MechanicalShutterCount', 'Mechanical shutter count'), spec('ImageCount', 'Image count'), spec('FileNumber', 'File number'),
    spec('FocusMode', 'Focus mode'), spec('AFAreaMode', 'Autofocus area'), spec('VibrationReduction', 'Vibration reduction'), spec('PictureControlName', 'Picture style'),
    spec('Quality', 'Quality'), spec('NoiseReduction', 'Noise reduction'), spec('ActiveDLighting', 'Active D-Lighting'), spec('DriveMode', 'Drive mode'), spec('ReleaseMode', 'Release mode'),
  ] },
  { id: 'file', title: 'File', tags: [
    spec('FileName', 'File name'), spec('FileType', 'File type'), spec('MIMEType', 'MIME type'), spec('FileSize', 'File size'), spec('FileModifyDate', 'File modified', date),
  ] },
];
const makerGroups = /^(?:MakerNotes|Nikon|Canon|Sony|Fujifilm|FujiFilm|Olympus|Panasonic|Pentax|Samsung|Leica|Ricoh|Sigma|Minolta|DJI|Apple|GoPro|Kodak|Casio)\w*$/;
/** Groups whose copy of a tag wins when the same tag appears in several (the camera's own EXIF first). */
const preferred = ['ExifIFD', 'EXIF', 'IFD0', 'Composite', 'File', 'System', 'XMP-exif', 'XMP-tiff', 'MakerNotes'];
/** Names never shown, whatever the category: binary and thumbnail data, offsets, checksums, internal bookkeeping. */
const hidden = /(?:Thumbnail|Preview|Binary|Offset|ByteCount|Checksum|Padding|Table|Directory|SourceFile|ExifToolVersion|ComponentsConfiguration|FlashpixVersion|ExifVersion|Interop|Warning|Error|Stripe|Tile|ProfileData|ICC_Profile|MakerNote(?:s)?$|Data$)/i;
const binary = (value: unknown) => typeof value === 'string' && /^\(Binary data|^base64:/i.test(value);
const groupOf = (key: string) => key.split(':').filter(part => !/^Copy\d+$/.test(part)).slice(0, -1).join(':');
const nameOf = (key: string) => key.split(':').at(-1)!;
const rank = (key: string) => { const index = preferred.indexOf(groupOf(key)); return index < 0 ? preferred.length : index; };

/** `metadata` is the full read: `fields` holds flattened -G1 keys such as `ExifIFD:FNumber`. `formatBytes` formats FileSize. */
export function categorize(metadata: Pick<Metadata, 'fields' | 'exposure' | 'date'>, language: Language, formatBytes: (bytes: number) => string = bytes => `${bytes} B`): ExifCategory[] {
  const { fields } = metadata, when = formatCaptureDateTime(metadata.date, language);
  const values: Interpreted = { exposure: formatExposure(metadata.exposure, language), captured: when.time ? [when.date, when.time, when.timezone].filter(Boolean).join(' ') : when.date };
  // One value per tag name: the preferred group's, first copy.
  const byName = new Map<string, { key: string; value: unknown }[]>();
  for (const [key, value] of Object.entries(fields)) {
    const name = nameOf(key);
    if (hidden.test(name) || binary(value) || value === undefined || value === null || value === '') continue;
    byName.set(name, [...byName.get(name) ?? [], { key, value }]);
  }
  const best = new Map<string, unknown>();
  for (const [name, found] of byName) best.set(name, [...found].sort((a, b) => rank(a.key) - rank(b.key))[0]!.value);
  const result: ExifCategory[] = [];
  for (const category of categories) {
    const rows: ExifRow[] = [], shownLabels = new Set<string>();
    for (const { tag, label, format, interpreted } of category.tags) {
      if (shownLabels.has(label)) continue;
      if (interpreted) { const shown = interpreted(values); if (shown !== undefined) { shownLabels.add(label); rows.push({ label, value: shown, tag }); } continue; }
      const value = best.get(tag);
      if (value === undefined) continue;
      // A maker tag is shown only when it came from a maker group (or a documented standard group).
      if (category.id === 'maker' && !(byName.get(tag) ?? []).some(item => makerGroups.test(groupOf(item.key)) || groupOf(item.key) === 'Composite')) continue;
      const shown = tag === 'FileSize' ? (number(value) === undefined ? undefined : formatBytes(number(value)!)) : format!(value);
      if (shown === undefined) continue;
      shownLabels.add(label);
      rows.push({ label, value: shown, tag });
    }
    if (rows.length) result.push({ id: category.id, title: category.title, rows });
  }
  return result;
}
