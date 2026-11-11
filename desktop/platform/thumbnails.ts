import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, copyFile, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PREVIEW_SIZES, previewSize, type Thumbnail } from '../shared';
import { mediaKindForPath } from '../media-formats';

/** How a picture is turned into a small JPEG. The defaults are macOS's own decoders, which read the RAW formats of
 * every camera the installed system knows; tests replace them. */
export interface ThumbnailDecoders {
  /** Decode `file` into a JPEG of at most `size` pixels at `output`. Resolves false when the system cannot. */
  decode(file: string, output: string, size: number): Promise<boolean>;
  /** A video's poster frame. */
  poster(file: string, output: string, size: number): Promise<boolean>;
  /** The JPEG embedded in the file, if it has one. */
  embedded(file: string): Promise<Buffer | undefined>;
}
const exec = promisify(execFile);
const run = (command: string, args: string[], timeout = 30000) => exec(command, args, { timeout }).then(() => true, () => false);
/** The app's own picture decoder (Electron's nativeImage), passed in so this module stays free of Electron. `shell`: the
 * system thumbnailer, a JPEG of at most `size` pixels (Windows Explorer's: pictures, the RAW formats whose codecs are
 * installed, and video poster frames). `image`: a JPEG of a JPEG/PNG decoded by Chromium. Each resolves undefined when it cannot. */
export interface NativeDecoder {
  shell(file: string, size: number): Promise<Buffer | undefined>;
  image(file: string, size: number): Promise<Buffer | undefined>;
}
const written = async (output: string, jpeg: Buffer | undefined) => { if (!jpeg?.length) return false; await writeFile(output, jpeg); return true; };
/** The size a decoded `width`×`height` picture is scaled down to so its longer side is at most `size`, or undefined when it
 * already fits: a picture is never enlarged, on any system. */
export const fitWithin = (width: number, height: number, size: number) => {
  const scale = Math.min(1, size / Math.max(width, height, 1));
  return scale < 1 ? { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) } : undefined;
};
/** The longer side `sips -g pixelWidth -g pixelHeight` prints for a picture, or undefined when it printed none. */
export const sipsLongerSide = (output: string) => {
  const width = Number(/pixelWidth:\s*(\d+)/.exec(output)?.[1]), height = Number(/pixelHeight:\s*(\d+)/.exec(output)?.[1]);
  return width > 0 && height > 0 ? Math.max(width, height) : undefined;
};
/** macOS: sips decodes through ImageIO, including camera RAW, and Quick Look makes video posters; both are built in.
 * Windows: the shell thumbnailer, as Explorer shows it. Linux: Chromium's decoder for JPEG and PNG only (no RAW, no posters yet). */
export const systemDecoders = (embedded: ThumbnailDecoders['embedded'], native?: NativeDecoder): ThumbnailDecoders => ({
  async decode(file, output, size) {
    if (process.platform === 'win32') return !!native && await written(output, await native.shell(file, size).catch(() => undefined));
    if (process.platform === 'linux') return !!native && await written(output, await native.image(file, size).catch(() => undefined));
    if (process.platform !== 'darwin') return false;
    // sips -Z also enlarges: a picture smaller than the size asked for keeps its own (its header is read first).
    const longer = await exec('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { timeout: 30000 }).then(result => sipsLongerSide(String(result.stdout)), () => undefined);
    return await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '75', '-Z', String(Math.min(size, longer ?? size)), file, '--out', output]) && await stat(output).then(info => info.size > 0, () => false);
  },
  async poster(file, output, size) {
    if (process.platform === 'win32') return !!native && await written(output, await native.shell(file, size).catch(() => undefined));
    // Linux has no poster frames yet (see Known gaps in docs/cross-platform.md).
    if (process.platform !== 'darwin') return false;
    // Quick Look writes <name>.png into a folder.
    const folder = await mkdtemp(path.join(tmpdir(), 'photo-importer-poster-'));
    try {
      if (!await run('/usr/bin/qlmanage', ['-t', '-s', String(size), '-o', folder, file])) return false;
      const made = (await readdir(folder)).find(name => name.endsWith('.png'));
      if (!made) return false;
      return await run('/usr/bin/sips', ['-s', 'format', 'jpeg', path.join(folder, made), '--out', output]) && await stat(output).then(info => info.size > 0, () => false);
    } finally { await rm(folder, { recursive: true, force: true }); }
  },
  embedded,
});
/** The cache is a convenience, never an archive: it stays under this size. */
export const THUMBNAIL_CACHE_BYTES = 2 * 1024 ** 3;
/** Delete the least recently used cached pictures (oldest modified/touched first) until the folder fits `maxBytes`. */
export async function pruneThumbnails(cache: string, maxBytes = THUMBNAIL_CACHE_BYTES): Promise<{ removed: number; bytes: number }> {
  const found: { file: string; size: number; used: number }[] = [];
  for (const name of await readdir(cache).catch(() => [] as string[])) {
    if (!name.endsWith('.jpg')) continue;
    const file = path.join(cache, name), info = await stat(file).catch(() => undefined);
    if (info?.isFile()) found.push({ file, size: info.size, used: info.mtimeMs });
  }
  let total = found.reduce((sum, item) => sum + item.size, 0), removed = 0, bytes = 0;
  for (const item of found.sort((a, b) => a.used - b.used)) {
    if (total <= maxBytes) break;
    if (await rm(item.file, { force: true }).then(() => true, () => false)) { total -= item.size; removed++; bytes += item.size; }
  }
  return { removed, bytes };
}
let writes = 0;
/** Pruning reads the whole folder, so it runs on the first new picture of a session and then every 25th. */
const pruneSometimes = async (cache: string, maxBytes: number) => { if (writes++ % 25 === 0) await pruneThumbnails(cache, maxBytes).catch(() => {}); };
const dataUrl = (buffer: Buffer) => `data:image/jpeg;base64,${buffer.toString('base64')}`;

/** A preview picture of a file, cached in `cache`. If the system cannot decode a RAW (a camera newer than the
 * installed macOS), the embedded preview is used and `problem` says why the decoded picture is missing. The embedded
 * preview is the camera's one picture whatever size is asked for, so it is cached once, apart from the size. */
export async function thumbnail(file: string, options: { cache: string; decoders: ThumbnailDecoders; size?: number; maxCacheBytes?: number }): Promise<Thumbnail> {
  const size = options.size ?? PREVIEW_SIZES.normal, kind = mediaKindForPath(file), info = await stat(file), identity = `${file}\0${info.size}\0${info.mtimeMs}`;
  const key = createHash('sha1').update(`${identity}\0${size}`).digest('hex'), embeddedKey = createHash('sha1').update(identity).digest('hex');
  const cached = path.join(options.cache, `${key}.jpg`), embeddedCached = path.join(options.cache, `${embeddedKey}.embedded.jpg`);
  await mkdir(options.cache, { recursive: true });
  for (const [name, via] of [[cached, 'system'], [embeddedCached, 'embedded']] as const) {
    const buffer = await readFile(name).catch(() => undefined);
    if (buffer?.length) { const now = new Date(); void utimes(name, now, now).catch(() => {}); }
    if (buffer?.length) return { src: dataUrl(buffer), via, ...(via === 'embedded' ? { problem: kind === 'RAW' ? 'raw-unsupported' as const : 'unreadable' as const } : {}) };
  }
  const scratch = await mkdtemp(path.join(tmpdir(), 'photo-importer-thumb-')), cap = options.maxCacheBytes ?? THUMBNAIL_CACHE_BYTES;
  try {
    const output = path.join(scratch, 'out.jpg');
    if (kind === 'Videos') {
      if (await options.decoders.poster(file, output, size)) { await copyFile(output, cached); await pruneSometimes(options.cache, cap); return { src: dataUrl(await readFile(output)), via: 'system' }; }
      return { via: 'none', problem: 'video' };
    }
    if (await options.decoders.decode(file, output, size)) { await copyFile(output, cached); await pruneSometimes(options.cache, cap); return { src: dataUrl(await readFile(output)), via: 'system' }; }
    // The system could not read it: for a RAW this is usually a camera newer than macOS.
    const embedded = await options.decoders.embedded(file).catch(() => undefined);
    const problem = kind === 'RAW' ? 'raw-unsupported' as const : 'unreadable' as const;
    if (embedded?.length) { await writeFile(embeddedCached, embedded); await pruneSometimes(options.cache, cap); return { src: dataUrl(embedded), via: 'embedded', problem }; }
    return { via: 'none', problem };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
/** The picture the renderer asks for over IPC (`importer:thumbnail`): any `size` it sends becomes one of PREVIEW_SIZES. */
export const previewThumbnail = (file: string, size: unknown, options: { cache: string; decoders: ThumbnailDecoders; maxCacheBytes?: number }) => thumbnail(file, { ...options, size: previewSize(size) });
