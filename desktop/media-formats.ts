import type { MediaKind } from './shared';

const extensions: Record<string, MediaKind> = {};
for (const [kind, names] of Object.entries({
  RAW: 'nef nrw arw srf sr2 crw cr2 cr3 raf orf ori rw2 rwl dng pef ptx 3fr fff iiq mos mrw raw x3f srw',
  JPEG: 'jpg jpeg jpe',
  HEIF: 'heic heif hif',
  Images: 'tif tiff png bmp gif jxl avif',
  Videos: 'mov mp4 m4v mts m2ts avi mxf mpg mpeg insv 360 r3d braw crm nraw nev lrf',
})) {
  for (const extension of names.split(' ')) extensions[extension] = kind as MediaKind;
}

/** Shared by disk inventory and preview presentation, without a Node dependency. */
export function mediaKindForPath(file: string): MediaKind {
  const name = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? extensions[name.slice(dot + 1).toLowerCase()] ?? 'Other' : 'Other';
}
