/** Bodies for the Settings path examples, a different one each time they are shown. Only cameras whose every example file
 * is documented: the EXIF Model they record (the camera folder name; darktable rawspeed cameras.xml, ExifTool Nikon.pm) and,
 * from each body's Nikon online manual, its file naming (DSC_nnnn, or _DSCnnnn in Adobe RGB, for NEF, JPG, MOV and MP4)
 * and voice memos (DSC_nnnn.WAV, numbered like the photo). Phones, drones and other devices are left out on purpose. */
export const sampleCameras = ['NIKON Z 9', 'NIKON Z 8', 'NIKON Z6_3', 'NIKON Z f', 'NIKON Z5_2', 'NIKON Z50_2', 'NIKON ZR', 'NIKON D6'] as const;

export interface SampleShot { camera: string; raw: string; jpeg: string; voiceMemo: string; video: string }

/** One capture as the camera names it: a RAW and JPEG pair with its voice memo, then the next number as a clip. */
export function sampleShot(random: () => number = Math.random): SampleShot {
  const camera = sampleCameras[Math.floor(random() * sampleCameras.length)] ?? sampleCameras[0];
  const prefix = random() < .75 ? 'DSC_' : '_DSC', number = 1 + Math.floor(random() * 9998);
  const name = (n: number) => `${prefix}${String(n).padStart(4, '0')}`;
  return { camera, raw: `${name(number)}.NEF`, jpeg: `${name(number)}.JPG`, voiceMemo: `${name(number)}.WAV`, video: `${name(number + 1)}.${random() < .5 ? 'MOV' : 'MP4'}` };
}
