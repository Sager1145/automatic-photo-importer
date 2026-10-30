/** Path helpers for the renderer, which has no node:path. Both separators are understood. */
const segments = (p: string) => p.split(/[\\/]/).filter(Boolean);
/** The last non-empty part of a path (the path itself when it has none). */
export const basename = (p: string): string => segments(p).pop() ?? p;
/** The root itself or anything beneath it (string-based; mirrors core/paths.within). */
export function within(child: string, parent: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = norm(parent), path = norm(child);
  return path === base || path.startsWith(base + '/');
}
