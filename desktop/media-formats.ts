import type { MediaKind } from './shared';

const extensions: Record<string, MediaKind> = {};
for (const [kind, names] of Object.entries({
  RAW: 'nef nrw arw arq srf sr2 crw cr2 cr3 raf orf ori rw2 rwl dng gpr pef ptx 3fr fff iiq mos mrw mef erf kdc dcr raw x3f srw',
  JPEG: 'jpg jpeg jpe',
  HEIF: 'heic heif hif',
  Images: 'tif tiff png bmp gif jxl avif insp mpo',
  Videos: 'mov mp4 m4v mts m2ts m2t mod tod 3gp avi mxf mpg mpeg insv osv 360 r3d braw crm nev lrf',
})) {
  for (const extension of names.split(' ')) extensions[extension] = kind as MediaKind;
}

/** Shared by disk inventory and preview presentation, without a Node dependency. */
export function mediaKindForPath(file: string): MediaKind {
  const name = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? extensions[name.slice(dot + 1).toLowerCase()] ?? 'Other' : 'Other';
}
