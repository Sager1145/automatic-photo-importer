import type { AppState, Source } from '../shared';
export type ImportMode = 'media' | 'files';
export type WorkspacePage = 'desk' | 'library' | 'activity' | 'settings';
export type ReviewWorkspace = { page: 'desk'; mode: ImportMode } | { page: 'library'; tool: 'organize' };
/** Published source mode describes the next run. A job/review owns its own immutable mode. */
export function sourceImportMode(source: Source & { backup?: boolean }): ImportMode { return source.backup ? 'files' : 'media'; }
export function reviewWorkspace(state: Pick<AppState, 'review' | 'busyReview' | 'reviewSourceId' | 'sources'>): ReviewWorkspace | undefined {
  if (state.review) return state.review.kind === 'reorganize' ? { page: 'library', tool: 'organize' } : { page: 'desk', mode: state.review.backup ? 'files' : 'media' };
  if (!state.busyReview) return undefined;
  if (state.reviewSourceId?.startsWith('library:')) return { page: 'library', tool: 'organize' };
  const source = state.sources.find(source => source.id === state.reviewSourceId);
  return { page: 'desk', mode: source ? sourceImportMode(source) : 'media' };
}
