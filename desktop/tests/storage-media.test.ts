import test from 'node:test';
import assert from 'node:assert/strict';
import { storageMedia, isMemoryCard } from '../core/storage-media';
import { sourceIcon, sourceKind, mediaLabels } from '../renderer/media-icons';
import { createTranslator } from '../renderer/i18n';
import { Camera, Folder, HardDrive } from 'lucide-react';

const usb = { bus: 'USB', removable: true, external: true };
test('a drive is told by what the system names it: card type, reader slot, stick, disk, disc or floppy', () => {
  const cases: [Parameters<typeof storageMedia>[0], ReturnType<typeof storageMedia>][] = [
    [{ model: 'APPLE SD Card Reader Media', bus: 'Secure Digital', removable: true, external: true }, 'sd'],
    [{ ...usb, model: 'ProGrade Digital CFexpress Type B Card Reader Media' }, 'cfexpress-b'],
    [{ ...usb, model: 'Lexar CFexpress Type A Reader' }, 'cfexpress-a'],
    [{ ...usb, model: 'Lexar CFexpress Reader' }, 'cfexpress'],
    [{ ...usb, model: 'Sony MRW-G1 XQD' }, 'xqd'],
    [{ ...usb, model: 'Lexar CFast 2.0 Reader' }, 'cfast'],
    // A multi-slot reader names each slot's unit.
    [{ ...usb, model: 'Generic- USB3.0 CRW -SD Media' }, 'sd'],
    [{ ...usb, model: 'Generic- USB3.0 CRW -CF Media' }, 'cf'],
    [{ ...usb, model: 'Generic- Micro SD/M2 Media' }, 'microsd'],
    [{ ...usb, model: 'Multiple Card Reader Media' }, 'card'],
    [{ ...usb, model: 'SanDisk Ultra Fit Media' }, 'usb-drive'],
    [{ ...usb, model: 'Samsung PSSD T7 Media', removable: false }, 'external-disk'],
    [{ ...usb, model: 'Sony DSC USB Device' }, 'camera'],
    [{ ...usb, model: 'HL-DT-ST DVDRW GX50N', fsType: 'udf' }, 'optical'],
    [{ ...usb, model: 'TEAC FD-05PUW', fsType: 'msdos', total: 1474560 }, 'floppy'],
    [{ bus: 'mmc', cardSlot: true, removable: true }, 'sd'],
    [{ model: 'APPLE SSD AP1024Z', bus: 'Apple Fabric', external: false }, undefined],
  ];
  for (const [evidence, expected] of cases) assert.equal(storageMedia(evidence), expected, JSON.stringify(evidence));
  // A big FAT drive is no floppy.
  assert.equal(storageMedia({ ...usb, model: 'Kingston DataTraveler', fsType: 'msdos', total: 32e9 }), 'usb-drive');
  assert.ok(isMemoryCard('cfexpress-b') && !isMemoryCard('usb-drive') && !isMemoryCard('camera'));
});

test('a source shows a camera, its medium or a folder, named in every language', () => {
  assert.equal(sourceIcon({ transport: 'camera' }), Camera);
  assert.equal(sourceIcon({ transport: 'folder' }), Folder);
  assert.equal(sourceIcon({ transport: 'storage' }), HardDrive);
  assert.notEqual(sourceIcon({ transport: 'storage', media: 'sd' }), sourceIcon({ transport: 'storage', media: 'cfexpress-b' }));
  assert.equal(sourceKind({ transport: 'camera' }), 'USB camera');
  assert.equal(sourceKind({ transport: 'storage', media: 'microsd' }), 'microSD card');
  assert.equal(sourceKind({ transport: 'folder' }), undefined);
  for (const language of ['zh-Hans', 'zh-Hant', 'ja'] as const) for (const label of [...Object.values(mediaLabels), 'USB camera'])
    assert.notEqual(createTranslator(language)(label), label, `${language}: ${label}`);
});
