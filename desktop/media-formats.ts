import type { MediaKind, MediaLayout } from './shared';

const extensions: Record<string, MediaKind> = {};
for (const [kind, names] of Object.entries({
  RAW: 'nef nrw arw arq srf sr2 crw cr2 cr3 raf orf ori rw2 rwl dng gpr pef ptx 3fr fff iiq mos mrw mef erf kdc dcr raw x3f srw cap eip k25 rwz cs1',
  JPEG: 'jpg jpeg jpe',
  HEIF: 'heic heif hif',
  Images: 'tif tiff png bmp gif jxl avif insp mpo webp jps psd psb jfif',
  Videos: 'mov mp4 m4v mts m2ts m2t mod tod 3gp avi mxf mpg mpeg insv osv 360 r3d braw crm nev lrf lrv 3g2 mqv vob dv',
})) {
  for (const extension of names.split(' ')) extensions[extension] = kind as MediaKind;
}

/** Shared by disk inventory and preview presentation, without a Node dependency. */
export function mediaKindForPath(file: string): MediaKind {
  const name = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? extensions[name.slice(dot + 1).toLowerCase()] ?? 'Other' : 'Other';
}

/** The folders a media layout puts inside the camera folder, for planning and the Settings preview alike. */
export function layoutFolders(layout: MediaLayout, video: boolean, format: string): string[] {
  if (layout === 'format') return [format];
  if (layout === 'type-format') return [video ? 'Videos' : 'Photos', format];
  if (layout === 'photos-flat') return video ? ['Videos'] : [];
  if (layout === 'videos-flat') return video ? [] : ['Photos'];
  return [];
}

/** Spellings of one format that share a format folder. */
const formatNames: Record<string, string> = {jpg: 'JPEG', jpe: 'JPEG', heic: 'HEIF', hif: 'HEIF', tif: 'TIFF', mpg: 'MPEG'};

/** Spellings that name one file format, for showing formats (the Library browser): a superset of the folder names
 * above, which also decide where imports go and so stay as they are. Extensions are compared in lowercase. */
const sameFormat: Record<string, string> = {...formatNames, jpeg: 'JPEG', jfif: 'JPEG', jif: 'JPEG', heif: 'HEIF', tiff: 'TIFF', mpeg: 'MPEG', mts: 'MTS', m2ts: 'MTS'};

/** How a format is shown: its extension in capitals, with `mergeSpellings` its format's one name (JPG, JPEG and JPE are
 * JPEG), and with `rawAsOne` every camera RAW format (ARW, NEF, RAF, CR3, DNG…) as RAW. */
export function formatGroup(extension: string, options: {mergeSpellings?: boolean; rawAsOne?: boolean} = {}): string {
  const lower = extension.toLowerCase();
  if (options.rawAsOne && extensions[lower] === 'RAW') return 'RAW';
  return (options.mergeSpellings !== false && sameFormat[lower]) || lower.toUpperCase();
}

/** The format folder of a media file: its uppercase extension, spelling variants merged. */
export function formatFolder(file: string): string {
  const name = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.'), extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return formatNames[extension] ?? extension.toUpperCase();
}
