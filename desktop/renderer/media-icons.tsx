import { createLucideIcon, type LucideIcon, Camera, Disc3, Folder, HardDrive, Save } from 'lucide-react';
import type { Source } from '../shared';
import type { StorageMedia } from '../core/storage-media';

// Memory cards and a USB stick drawn in Lucide's style (24 × 24, 2 px strokes, round joins), so they sit beside its icons.
// Each card has its own outline: an SD card's cut corner, a microSD's step, a CompactFlash's pin row, a CFexpress
// card's letter, an XQD's rounded body.
const SdCard = createLucideIcon('sd-card-media', [
  ['path', { d: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6z', key: 'outline' }],
  ['path', { d: 'M9 6v3M12 6v3M15 6v3', key: 'contacts' }],
]);
const MicroSdCard = createLucideIcon('microsd-card-media', [
  ['path', { d: 'M7 4h9a2 2 0 0 1 2 2v4l-1 1v1l1 1v5a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5z', key: 'outline' }],
  ['path', { d: 'M9 7v2M11.5 7v2M14 7v2', key: 'contacts' }],
]);
const CompactFlashCard = createLucideIcon('compactflash-card-media', [
  ['rect', { x: '4', y: '3', width: '16', height: '18', rx: '2', key: 'outline' }],
  ['path', { d: 'M7 6h.01M10 6h.01M13 6h.01M16 6h.01', key: 'pins' }],
  ['path', { d: 'M8 11h8', key: 'label' }],
]);
const lettered = (name: string, letter: 'A' | 'B' | '') => createLucideIcon(name, [
  ['path', { d: letter === 'A' ? 'M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z' : 'M5 3h12l2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', key: 'outline' }],
  ['path', { d: 'M8 17h8', key: 'contacts' }],
  ['path', { d: letter === 'A' ? 'M9.5 13l2.5-6 2.5 6M10.3 11h3.4' : letter === 'B' ? 'M9.5 7h3a1.5 1.5 0 0 1 0 3h-3zM9.5 10h3.5a1.5 1.5 0 0 1 0 3H9.5z' : 'M9 9h6M9 12h6', key: 'letter' }],
]);
const CfexpressA = lettered('cfexpress-a-media', 'A');
const CfexpressB = lettered('cfexpress-b-media', 'B');
const Cfexpress = lettered('cfexpress-media', '');
const XqdCard = createLucideIcon('xqd-card-media', [
  ['rect', { x: '4', y: '3', width: '16', height: '18', rx: '4', key: 'outline' }],
  ['path', { d: 'M8 17h8M9 8h6', key: 'marks' }],
]);
const MemoryCard = createLucideIcon('memory-card-media', [
  ['path', { d: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6z', key: 'outline' }],
  ['path', { d: 'M9 14h6', key: 'label' }],
]);
const UsbStick = createLucideIcon('usb-stick-media', [
  ['rect', { x: '7', y: '9', width: '10', height: '13', rx: '2', key: 'body' }],
  ['path', { d: 'M9 9V3h6v6M11 5.5h.01M13 5.5h.01', key: 'plug' }],
]);

const mediaIcons: Record<StorageMedia, LucideIcon> = {
  camera: Camera, sd: SdCard, microsd: MicroSdCard, cf: CompactFlashCard, cfast: CompactFlashCard, 'cfexpress-a': CfexpressA, 'cfexpress-b': CfexpressB,
  cfexpress: Cfexpress, xqd: XqdCard, card: MemoryCard, 'usb-drive': UsbStick, 'external-disk': HardDrive, optical: Disc3, floppy: Save,
};
/** What each medium is called (i18n keys). */
export const mediaLabels: Record<StorageMedia, string> = {
  camera: 'Camera (USB drive)', sd: 'SD card', microsd: 'microSD card', cf: 'CompactFlash card', cfast: 'CFast card', 'cfexpress-a': 'CFexpress Type A card',
  'cfexpress-b': 'CFexpress Type B card', cfexpress: 'CFexpress card', xqd: 'XQD card', card: 'Memory card', 'usb-drive': 'USB flash drive',
  'external-disk': 'External drive', optical: 'CD or DVD', floppy: 'Floppy disk',
};

/** A card slot's icon: its card type, or a memory card when the camera body's slots are not known. */
export function mediaIcon(media: StorageMedia | undefined): LucideIcon { return media ? mediaIcons[media] : MemoryCard; }

/** A source's icon: a camera over USB, a folder, or its drive's medium (a drive of unknown medium is an external drive). */
export function sourceIcon(source: Pick<Source, 'transport' | 'media' | 'camera'>): LucideIcon {
  if (source.transport === 'camera') return Camera;
  if (source.transport === 'folder') return Folder;
  return source.media ? mediaIcons[source.media] : source.camera ? MemoryCard : HardDrive;
}
/** How a source is described: "USB camera", or its medium; undefined for a folder. */
export function sourceKind(source: Pick<Source, 'transport' | 'media' | 'camera'>): string | undefined {
  if (source.transport === 'camera') return 'USB camera';
  if (source.transport === 'folder') return undefined;
  return source.media ? mediaLabels[source.media] : source.camera ? 'Memory card' : 'External drive';
}
