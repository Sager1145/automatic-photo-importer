import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { DuplicateGroup, DuplicateStrength, Progress } from '../shared';
import type { ResolvedGroup } from '../duplicate-rules';
import { beginDuplicateRemoval, type OrganizationEntry, type ReorganizationResult } from './recovery';
import { checkAbort, contained, digest, directory, identity } from './paths';

/** One line of the per-file report. primary: a duplicate removed; companion: its sidecar, proxy or audio file.
 * removed: set aside in the recovery store; carried: a companion the kept copy lacked, published next to it;
 * left: stays where it is (the reason says why). */
export interface RemovalReportEntry {
  group: string; strength: DuplicateStrength; role: 'primary' | 'companion';
  kept: string; file: string; size: number; sha256?: string;
  result: 'removed' | 'carried' | 'left'; reason?: string;
  /** Where a carried companion went. */
  carriedTo?: string;
}
export interface RemovalResult {
  /** The journal's id (absent when nothing was removed). */
  id?: string; root: string; result?: ReorganizationResult;
  groups: number; removed: number; bytes: number; carried: number; left: number;
  report: RemovalReportEntry[];
}

/** The companion of `from` (a companion of `primary`) as it would be named beside `keeper`: the same suffix
 * after the stem (`.xmp`, `.NEF.xmp`, `.LRF`), so a renamed keeper's companions keep matching it. */
export function companionTarget(primary: string, from: string, keeper: string): string {
  const stem = path.basename(primary, path.extname(primary)), name = path.basename(from);
  const suffix = name.toLowerCase().startsWith(stem.toLowerCase()) ? name.slice(stem.length) : path.extname(name);
  return path.join(path.dirname(keeper), path.basename(keeper, path.extname(keeper)) + suffix);
}

/** Set aside every duplicate the resolved groups remove, into the library's recovery store, with undo. The
 * hashes are read again here: a file that changed since the scan stays where it is. Companions follow their
 * primary. Never deletes anything. */
export async function removeDuplicates(rootPath: string, resolved: ResolvedGroup[], companions: Map<string, string[]>, options: { signal?: AbortSignal; onProgress?: (progress: Progress) => void } = {}): Promise<RemovalResult> {
  const root = await directory(rootPath), rootIdentity = await identity(root), signal = options.signal;
  const report: RemovalReportEntry[] = [], entries: OrganizationEntry[] = [];
  const abs = (relative: string) => path.join(root, ...relative.split('/'));
  const taken = new Set<string>();
  const work = resolved.filter(item => item.remove.length && item.keep && item.keep !== 'all');
  const total = work.reduce((sum, item) => sum + item.remove.length, 0);
  let checked = 0;
  const checking = (file: string) => options.onProgress?.({ phase: 'verifying', step: 'checking', completed: checked, total, bytes: 0, totalBytes: 0, speed: 0, file });
  const stat = async (file: string) => { await contained(file, root); const found = await fs.lstat(file, { bigint: true }); return found.isFile() && !found.isSymbolicLink() ? found : undefined; };
  let groups = 0;
  for (const item of work) {
    checkAbort(signal);
    const keepPath = abs(item.keep!), kept = await stat(keepPath).catch(() => undefined);
    const context = { group: item.group.id, strength: item.group.strength, kept: item.keep! };
    if (!kept) { for (const file of item.remove) report.push({ ...context, role: 'primary', file: file.path, size: file.size, result: 'left', reason: 'the copy to keep is missing' }); checked += item.remove.length; continue; }
    const keeperSha = await digest(keepPath, signal);
    let any = false;
    for (const file of item.remove) {
      checking(file.path);
      const source = abs(file.path), found = await stat(source).catch(() => undefined);
      const entry = { ...context, role: 'primary' as const, file: file.path, size: file.size };
      checked++;
      if (!found || found.size !== BigInt(file.size)) { report.push({ ...entry, result: 'left', reason: 'the file changed or is gone since the scan' }); continue; }
      const sha = await digest(source, signal);
      // Identical groups are proven again by content now; a lookalike group is the user's decision, made on the previews.
      if (item.group.strength === 'sha' && sha !== keeperSha) { report.push({ ...entry, sha256: sha, result: 'left', reason: 'it no longer matches the copy to keep' }); continue; }
      if (taken.has(source) || taken.has(keepPath)) { report.push({ ...entry, sha256: sha, result: 'left', reason: 'it is also part of another group' }); continue; }
      taken.add(source);
      entries.push({ source, destination: keepPath, digest: sha, size: file.size, stat: found, move: true, kept: { digest: keeperSha, size: Number(kept.size) } });
      report.push({ ...entry, sha256: sha, result: 'removed' });
      any = true;
      // Companions follow their primary.
      for (const companion of companions.get(file.path) ?? []) {
        const from = abs(companion), target = companionTarget(file.path, companion, keepPath), line = { ...context, role: 'companion' as const, file: companion };
        const own = await stat(from).catch(() => undefined);
        if (!own) { report.push({ ...line, size: 0, result: 'left', reason: 'the file changed or is gone since the scan' }); continue; }
        const ownSha = await digest(from, signal), there = await stat(target).catch(() => undefined);
        if (taken.has(from) || taken.has(target)) { report.push({ ...line, size: Number(own.size), sha256: ownSha, result: 'left', reason: 'it is also part of another group' }); continue; }
        if (there && there.size === own.size && await digest(target, signal) === ownSha) {
          taken.add(from);
          entries.push({ source: from, destination: target, digest: ownSha, size: Number(own.size), stat: own, move: true });
          report.push({ ...line, size: Number(own.size), sha256: ownSha, result: 'removed' });
        } else if (there) report.push({ ...line, size: Number(own.size), sha256: ownSha, result: 'left', reason: 'the kept copy has a different one' });
        else {
          taken.add(from); taken.add(target);
          entries.push({ source: from, destination: target, digest: ownSha, size: Number(own.size), stat: own, move: true });
          report.push({ ...line, size: Number(own.size), sha256: ownSha, result: 'carried', carriedTo: relativeTo(root, target) });
        }
      }
    }
    if (any) groups++;
  }
  const tally = () => ({ removed: report.filter(line => line.role === 'primary' && line.result === 'removed').length, bytes: report.filter(line => line.result === 'removed').reduce((sum, line) => sum + line.size, 0), carried: report.filter(line => line.result === 'carried').length, left: report.filter(line => line.result === 'left').length });
  if (!entries.length) return { root, groups: 0, ...tally(), report };
  const { id, result } = await beginDuplicateRemoval({ root, rootIdentity }, entries, signal, options.onProgress);
  // A journal that stopped on an error leaves some files where they were: the report says which.
  if (result.errors.length) for (const line of report) if ((line.result === 'removed' || line.result === 'carried') && await fs.lstat(abs(line.file)).then(() => true, () => false)) { line.result = 'left'; line.reason = result.errors[0]; }
  return { id, root, result, groups, ...tally(), report };
}
const relativeTo = (root: string, file: string) => path.relative(root, file).split(path.sep).join('/');
export type { DuplicateGroup };
