import type { Metadata, Thumbnail } from '../shared';

/** One read's result: what it returned, or why it failed. A failure is never stored as an empty success. */
export type Outcome<T> = { value: T } | { error: string };
/** The preview and EXIF of one file; a missing half is still being read (or waiting its turn). */
export interface FileDetails { thumbnail?: Outcome<Thumbnail>; exif?: Outcome<Metadata> }
type Part = keyof FileDetails;
export interface DetailReader { thumbnail(root: string, path: string): Promise<Thumbnail>; exif(root: string, path: string): Promise<Metadata> }

/** Files read at once, each with its two reads. */
const CONCURRENT_FILES = 3;
const NOTHING: Readonly<Record<string, FileDetails>> = Object.freeze({});

/** Everything known for one root at one scan revision. A new root or revision is a new generation; the old one is dropped whole. */
interface Generation { key: string; root: string; results: Readonly<Record<string, FileDetails>>; flying: Set<string> }
interface Job { generation: Generation; path: string; parts: Part[] }

const generationKey = (root: string, revision: number) => `${revision}\0${root}`;

/**
 * The previews and EXIF of the duplicate files on screen. Paths are relative to the root.
 * One pool of three files serves every page; a read that outlives its page still lands (so paging back reuses it),
 * and a read of an older generation lands nowhere. Failures stay failures until the user asks to retry.
 */
export function createDetailStore(read: DetailReader) {
  let current: Generation | undefined;
  let queue: Job[] = [];
  let active = 0;
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };

  const enter = (root: string, revision: number): Generation => {
    const key = generationKey(root, revision);
    if (current?.key !== key) { current = { key, root, results: NOTHING, flying: new Set() }; queue = []; }
    return current;
  };
  const record = (generation: Generation, path: string, part: Part, outcome: Outcome<Thumbnail> | Outcome<Metadata>) => {
    if (generation !== current) return;
    generation.results = { ...generation.results, [path]: { ...generation.results[path], [part]: outcome } };
    emit();
  };
  const start = ({ generation, path, parts }: Job) => {
    active++;
    generation.flying.add(path);
    const reads = parts.map(part => (read[part](generation.root, path) as Promise<Thumbnail | Metadata>).then(
      value => record(generation, path, part, { value } as Outcome<Thumbnail> | Outcome<Metadata>),
      (error: unknown) => record(generation, path, part, { error: error instanceof Error ? error.message : String(error) }),
    ));
    void Promise.all(reads).then(() => { generation.flying.delete(path); active--; pump(); });
  };
  const pump = () => { for (let job = active < CONCURRENT_FILES ? queue.shift() : undefined; job; job = active < CONCURRENT_FILES ? queue.shift() : undefined) start(job); };
  const waiting = (generation: Generation, path: string) => generation.flying.has(path) || queue.some(job => job.generation === generation && job.path === path);

  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** The details of this generation only: never a previous root's or revision's. The object changes only when a result lands. */
    view(root: string, revision: number): Readonly<Record<string, FileDetails>> {
      return current?.key === generationKey(root, revision) ? current.results : NOTHING;
    },
    /** Reads the details of these files that are not known yet. The returned release drops the ones still waiting, not those being read. */
    show(root: string, revision: number, paths: readonly string[]): () => void {
      const generation = enter(root, revision);
      const mine = paths.filter(path => !generation.results[path] && !waiting(generation, path)).map((path): Job => ({ generation, path, parts: ['thumbnail', 'exif'] }));
      queue.push(...mine);
      pump();
      return () => { queue = queue.filter(job => !mine.includes(job)); };
    },
    /** Reads again only the halves of this file that failed, ahead of the files waiting. */
    retry(root: string, revision: number, path: string) {
      const generation = current;
      if (generation?.key !== generationKey(root, revision) || waiting(generation, path)) return;
      const known = generation.results[path] ?? {};
      const parts = (['thumbnail', 'exif'] as const).filter(part => known[part] && 'error' in known[part]);
      if (!parts.length) return;
      const kept = { ...known };
      for (const part of parts) delete kept[part];
      generation.results = { ...generation.results, [path]: kept };
      queue.unshift({ generation, path, parts });
      emit();
      pump();
    },
  };
}
