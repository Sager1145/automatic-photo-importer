import type { StorageMedia } from './core/storage-media';

/** The card each slot of a camera body takes, in slot order, for its slot's icon and name: a camera over USB (PTP/MTP)
 * reports its slots but not their card type. Matched on the name the camera gives (ImageCaptureCore's or WPD's:
 * "Z f", "Canon EOS R5", "ILCE-1", "X-H2S"). Sony's combined CFexpress Type A / SD slots take either, so they show as
 * a memory card; a body not listed shows its slots as memory cards. From each maker's specifications. */
const bodies: readonly [RegExp, readonly StorageMedia[]][] = [
  // Nikon
  [/^(nikon\s*)?z\s*f$/i, ['sd', 'microsd']],
  [/^(nikon\s*)?z\s*9$/i, ['cfexpress-b', 'cfexpress-b']],
  [/^(nikon\s*)?z\s*(8|6\s*(iii|_?3)|6\s*(ii|_?2)|7\s*(ii|_?2))$/i, ['cfexpress-b', 'sd']],
  [/^(nikon\s*)?z\s*[67]$/i, ['cfexpress-b']],
  [/^(nikon\s*)?z\s*5(\s*(ii|_?2))?$/i, ['sd', 'sd']],
  [/^(nikon\s*)?z\s*(fc|50(\s*(ii|_?2))?|30)$/i, ['sd']],
  [/^(nikon\s*)?d\s*(850|500)$/i, ['xqd', 'sd']],
  [/^(nikon\s*)?d\s*(780|750|7500|7200)$/i, ['sd', 'sd']],
  // Canon
  [/^(canon\s*)?eos\s*r(1|3)$/i, ['cfexpress-b', 'cfexpress-b']],
  [/^(canon\s*)?eos\s*r5(\s*(mark\s*ii|m2|ii))?(\s*c)?$/i, ['cfexpress-b', 'sd']],
  [/^(canon\s*)?eos\s*r(6(\s*(mark\s*(ii|iii)|m[23]|ii|iii))?|7)$/i, ['sd', 'sd']],
  [/^(canon\s*)?eos\s*(r8|r10|r50|r100|rp|r)$/i, ['sd']],
  // Sony (ILCE model numbers): combined CFexpress Type A / SD slots
  [/^ilce-(1(m2)?|7sm3|7m4|7rm5|9m3|7m5)$/i, ['card', 'card']],
  [/^ilce-(7cm2|7cr|6700|7c)$/i, ['sd']],
  // Fujifilm
  [/^x-h2s?$/i, ['cfexpress-b', 'sd']],
  [/^gfx\s*100\s*ii$/i, ['cfexpress-b', 'sd']],
  [/^(x-t[45]|x-pro3|x-h1|gfx\s*100s(\s*ii)?|gfx\s*50s\s*ii)$/i, ['sd', 'sd']],
  [/^(x100v?i?|x-s20|x-t50|x-e[45]|x-m5|x-t30(\s*ii)?)$/i, ['sd']],
  // Panasonic
  [/^dc-(gh7|s1rm2|s1m2)$/i, ['cfexpress-b', 'sd']],
  [/^dc-(s5m2x?|s5|s1h|s1r?|g9m2|gh6)$/i, ['sd', 'sd']],
];

/** The card types of a camera's slots, or none when the body is not known. */
export function cameraSlots(cameraName: string): readonly StorageMedia[] | undefined {
  const name = cameraName.trim();
  return bodies.find(([pattern]) => pattern.test(name))?.[1];
}

/** The card type of one slot: by the slot number in its name ("Slot 2") or its place. */
export function slotMedia(cameraName: string, slotName: string | undefined, index: number): StorageMedia | undefined {
  const slots = cameraSlots(cameraName);
  if (!slots) return undefined;
  const number = Number(/(\d+)\s*$/.exec(slotName ?? '')?.[1]);
  return slots[Number.isInteger(number) && number >= 1 && number <= slots.length ? number - 1 : index] ?? slots[0];
}
