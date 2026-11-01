// Packages the Windows release for each architecture released in release-targets.json: a branded MSI installer and a
// single-file portable exe for each.
// WiX runs light.exe from a temporary stage folder, so the artwork and wording paths must be absolute;
// that is why this lives in a script rather than package.json's "build" field.
import {Arch, build, Platform} from 'electron-builder';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const art = file => path.join(root, 'Assets', 'Installer', file);
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const arches = JSON.parse(await readFile(path.join(root, 'release-targets.json'), 'utf8')).win32.release.map(name => Arch[name]);

await build({
 targets: Platform.WINDOWS.createTarget(['msi', 'portable'], ...arches),
 config: {
  ...pkg.build,
  msi: {
   oneClick: false,
   perMachine: false,
   runAfterFinish: true,
   createDesktopShortcut: true,
   createStartMenuShortcut: true,
   shortcutName: pkg.build.productName,
   artifactName: 'Automatic-Photo-Importer-${version}-${arch}.${ext}',
   // WixUI variables swap in the branded dialog/banner art; the .wxl replaces the stock wording.
   additionalLightArgs: [
    `-dWixUIDialogBmp=${art('dialog.bmp')}`,
    `-dWixUIBannerBmp=${art('banner.bmp')}`,
    '-loc', art('strings.wxl'),
    '-cultures:en-us',
   ],
  },
  portable: {artifactName: 'Automatic-Photo-Importer-${version}-${arch}-portable.${ext}'},
 },
});
