import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../logger';

/** Whether a folder is on a camera's own storage or a camera card (a card in a reader, or removable flash). */
export type CameraCheck = (folder: string) => Promise<boolean>;

/** Nothing on a camera or a camera card is ever deleted, whatever the settings: every core call that removes a file
 * from where it was found (Delete originals, the removal of confirmed duplicates after an import or an organization,
 * releasing set-aside duplicates, Clean up) asks this first and refuses before touching anything. The app installs
 * the platform's card test (`onCameraCard`, which also answers yes for a volume it cannot identify) at startup;
 * tests install their own. A check that fails counts as a camera. */
let check: CameraCheck | undefined;
export function useCameraCheck(next: CameraCheck | undefined): () => void {
  const previous = check; check = next;
  return () => { check = previous; };
}

export class CameraDeleteRefused extends Error {
  constructor(readonly folder: string, readonly area: string) {
    super(`Nothing on a camera or camera card is deleted: ${folder}`);
    this.name = 'CameraDeleteRefused';
  }
}

/** Whether `folder` is on a camera or a camera card, by the installed check: asked for the path as given and for where its
 * folder links lead (a symbolic link, or a junction on Windows), so a link into a card is a card. */
export async function onCamera(folder: string): Promise<boolean> {
  if (!check) return false;
  const given = path.resolve(folder), real = await realpath(given).catch(() => given);
  try { return await check(given) || (real !== given && await check(real)); } catch { return true; }
}

/** Throws CameraDeleteRefused when any of `folders` is on a camera or camera card; `area` names the deleting path in the log. */
export async function refuseOnCamera(area: string, ...folders: (string | undefined)[]): Promise<void> {
  for (const folder of new Set(folders.filter((item): item is string => !!item))) {
    if (await onCamera(folder)) {
      log('normal', area, 'camera-delete-refused', { path: folder });
      throw new CameraDeleteRefused(folder, area);
    }
  }
}
