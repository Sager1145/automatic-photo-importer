import { formatFolder } from './media-formats';
import { CONFLICTS_FOLDER, DEFAULT_EDITED_FOLDER, templateMatcher } from './folder-template';
import type { DuplicateExif, DuplicateFile, DuplicateGroup, DuplicateLevel, DuplicateStrength } from './shared';

/** Pure duplicate rules, shared by the main process and the renderer (no Node imports). */

const base = (file: string) => file.split('/').at(-1)!;
/** `jpg` and `jpeg`, `tif` and `tiff`, `heic` and `heif`, `mpg` and `mpeg` are one format (the format folder's key). */
export const extensionClass = formatFolder;
/** Files are compared only with the same format and the same edited state, so RAW+JPG pairs, Live Photo
 * HEIC+MOV pairs and an original beside its edited version are never duplicates of each other. */
export function comparable(a: Pick<DuplicateFile, 'path' | 'edited'>, b: Pick<DuplicateFile, 'path' | 'edited'>): boolean {
  return a.edited === b.edited && extensionClass(a.path) === extensionClass(b.path);
}
/** The sub-second digits of a capture time. All zeros is a body that records none (a constant), so it is no discriminator. */
const fraction = (date?: string) => { const digits = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(\d+)/.exec(date ?? '')?.[1]; return digits && !/^0+$/.test(digits) ? digits : undefined; };
/** The EXIF identity of a capture, or undefined when it is not enough to trust: a time, a camera, and
 * something that tells burst frames apart (sub-seconds, a shutter count or an image number). */
export function exifKey(exif?: DuplicateExif): string | undefined {
  if (!exif?.date || !(exif.serial || exif.camera)) return undefined;
  if (!fraction(exif.date) && !exif.shutterCount && !exif.imageNumber) return undefined;
  return [exif.date, exif.serial ?? '', exif.camera ?? '', exif.shutterCount ?? '', exif.imageNumber ?? '', `${exif.width ?? '?'}x${exif.height ?? '?'}`, exif.lens ?? '', exif.exposureTime ?? '', exif.aperture ?? '', exif.iso ?? '', exif.exposureCompensation ?? ''].join('|');
}
/** The folder rules a library is organized by: the template and the edited exports' folder. */
export interface OrganizeRules { template: string; editedFolder?: string; }
const DEFAULT_RULES: OrganizeRules = { template: '{year}/{yyyymm}/{camera}' };
const matchers = new Map<string, (relativeDir: string) => boolean>();
/** Whether a path is in the organized structure: the template's folders directly under the library root or
 * under one base folder, and not in an edited, conflict or drive backup folder. */
export function organizedPath(relative: string, rules: OrganizeRules = DEFAULT_RULES): boolean {
  const key = `${rules.template}\0${rules.editedFolder ?? DEFAULT_EDITED_FOLDER}`;
  let matches = matchers.get(key);
  if (!matches) { matches = templateMatcher(rules.template, rules.editedFolder, [CONFLICTS_FOLDER, 'Drive backups']); matchers.set(key, matches); }
  return matches(relative.split('/').slice(0, -1).join('/'));
}
/** The copy to keep by default: the one in the organized structure, then the earliest imported
 * (oldest birth time, then ctime), then the shortest path. */
export function chooseKeeper<T extends Pick<DuplicateFile, 'path' | 'birth' | 'ctime'>>(files: T[], rules?: OrganizeRules): T {
  const rank = (file: T) => organizedPath(file.path, rules) ? 0 : 1;
  return [...files].sort((a, b) => rank(a) - rank(b) || a.birth - b.birth || a.ctime - b.ctime || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))[0]!;
}
function hash(text: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619) >>> 0; b = Math.imul(b + text.charCodeAt(i), 2654435761) >>> 0; }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
export const groupId = (files: Pick<DuplicateFile, 'path'>[]) => hash(files.map(file => file.path).sort().join('\0'));

/** Candidate files for stage 1: the same name, or the same trusted EXIF key, among comparable files.
 * Only these are hashed right away. */
export function candidates<T extends DuplicateFile>(files: T[]): T[] {
  const picked = new Set<T>();
  for (const members of classes(files)) {
    for (const key of [(file: T) => base(file.path).toLowerCase(), (file: T) => exifKey(file.exif)]) {
      for (const [value, same] of Map.groupBy(members, key)) if (value && same.length > 1) for (const file of same) picked.add(file);
    }
  }
  return [...picked];
}
function classes<T extends DuplicateFile>(files: T[]): T[][] {
  // Empty files all share one SHA and prove nothing.
  return [...Map.groupBy(files.filter(file => file.kind !== 'Other' && file.size > 0), file => `${file.edited ? 1 : 0}|${extensionClass(file.path)}`).values()].filter(members => members.length > 1);
}
/** How sure a set of files linked by SHA-256 or EXIF is. sha: one SHA-256 for all; exif: one trusted EXIF key and
 * one size; exif-size: linked, but the size (or the evidence) differs, so only the user decides. */
export function classify(files: DuplicateFile[]): DuplicateStrength {
  if (files.every(file => file.sha256 && file.sha256 === files[0]!.sha256)) return 'sha';
  const keys = new Set(files.map(file => exifKey(file.exif)));
  if (keys.size === 1 && !keys.has(undefined)) return new Set(files.map(file => file.size)).size === 1 ? 'exif' : 'exif-size';
  return 'exif-size';
}
/** Every group of related files among `files`, using the SHA-256 and EXIF each file carries. A file
 * without a SHA-256 is related only through its EXIF key. */
export function buildGroups(files: DuplicateFile[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  for (const members of classes(files)) {
    const parent = members.map((_, index) => index);
    const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]!));
    const owner = new Map<string, number>();
    members.forEach((file, index) => {
      for (const key of [file.sha256 && 's' + file.sha256, exifKey(file.exif) && 'e' + exifKey(file.exif)]) {
        if (!key) continue;
        const known = owner.get(key);
        if (known === undefined) owner.set(key, index); else parent[find(index)] = find(known);
      }
    });
    const components = Map.groupBy(members, (_, index) => find(index));
    const leftover: DuplicateFile[] = [];
    for (const component of components.values()) {
      if (component.length > 1) groups.push({ id: groupId(component), strength: classify(component), files: component });
      else leftover.push(component[0]!);
    }
    // The same name and capture time alone is only a hint: the user decides.
    const named = Map.groupBy(leftover.filter(file => file.exif?.date), file => `${base(file.path).toLowerCase()}|${file.exif!.date}`);
    for (const same of named.values()) if (same.length > 1) groups.push({ id: groupId(same), strength: 'similar', files: same });
  }
  return groups.sort((a, b) => a.files[0]!.path.localeCompare(b.files[0]!.path));
}

/** Whether a level resolves a group of this strength without asking. Only identical bytes are removed without the
 * user: level 2 resolves SHA groups alone; an EXIF group always waits for a decision. */
export function automatic(strength: DuplicateStrength, level: DuplicateLevel): boolean {
  return level === 2 && strength === 'sha';
}
export interface ResolvedGroup {
  group: DuplicateGroup; auto: boolean; suggested: string;
  /** The file kept: the user's choice, or the suggestion for an automatic group; 'all' keeps everything; undefined awaits a decision. */
  keep?: string | 'all'; remove: DuplicateFile[]; needsDecision: boolean;
  /** The keeper is the user's choice; otherwise the level chose it, and the removal proves every copy by content. */
  decided: boolean;
}
/** Split groups by level into automatic and manual ones. `decisions` are the user's choices by group id
 * (a path of the group, or 'all'); they win over the level. */
export function resolveGroups(groups: DuplicateGroup[], level: DuplicateLevel, decisions: Record<string, string> = {}, rules?: OrganizeRules): ResolvedGroup[] {
  return groups.map(group => {
    const suggested = chooseKeeper(group.files, rules).path, auto = automatic(group.strength, level);
    const chosen = decisions[group.id], valid = chosen === 'all' || group.files.some(file => file.path === chosen);
    const keep = valid ? chosen : auto ? suggested : undefined;
    return { group, auto, suggested, keep, remove: keep === undefined || keep === 'all' ? [] : group.files.filter(file => file.path !== keep), needsDecision: keep === undefined, decided: valid };
  });
}
export interface RemovalSummary { groups: number; files: number; bytes: number; undecided: number; automatic: number; manual: number; /** Files to remove that an earlier organization placed (DuplicateFile.earlier): removing them supersedes it and ends its Undo. */ earlier: number; }
export function summarize(resolved: ResolvedGroup[]): RemovalSummary {
  const removing = resolved.filter(item => item.remove.length);
  return {
    groups: removing.length, files: removing.reduce((sum, item) => sum + item.remove.length, 0), bytes: removing.reduce((sum, item) => sum + item.remove.reduce((n, file) => n + file.size, 0), 0),
    undecided: resolved.filter(item => item.needsDecision).length, automatic: resolved.filter(item => item.auto).length, manual: resolved.filter(item => !item.auto).length,
    earlier: removing.reduce((sum, item) => sum + item.remove.filter(file => file.earlier).length, 0),
  };
}
