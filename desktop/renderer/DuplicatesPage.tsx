import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ChevronLeft, ChevronRight, CheckCircle2, Clock3, CopyCheck, ImageOff, Info, LoaderCircle, RotateCcw, ScanSearch, Square, Trash2, FolderOpen } from 'lucide-react';
import type { Action, AppState, DuplicatesState, DuplicateFile, DuplicateGroup, DuplicateLevel, DuplicateStrength, Language, Metadata, OrganizationRecovery, Thumbnail } from '../shared';
import { exifKey, organizedPath, resolveGroups, summarize, type RemovalSummary, type ResolvedGroup } from '../duplicate-rules';
import { categorize } from './exif-categories';
import { formatCaptureDateTime, formatExposure } from './metadata-display';
import { useTranslation, type Translator } from './i18n';
import { message } from '../messages';
import { createDetailStore, type FileDetails, type Outcome } from './duplicate-details';
import { Button, CardHeader, Icon, OperationProgress, OrganizationProgress, ConfirmSheet, ReleaseConfirm, activePhases, nextConfirmStep, type DeleteRecoveryStep } from './RootApp';

type Dispatch = (action: Action) => void;
/** Groups shown per page: only these are drawn and only their previews are fetched, so thousands of groups stay responsive. */
export const GROUPS_PER_PAGE = 8;

export const duplicateLevels = (t: Translator): { level: DuplicateLevel; label: string; detail: string }[] => [
  { level: 1, label: t("Choose every keeper"), detail: t("You decide every group. Nothing is moved until you confirm Remove.") },
  { level: 2, label: t("Suggest keepers for identical files"), detail: t("Files with the same SHA-256 get a suggested keeper; you decide everything else. Nothing is moved until you confirm Remove.") },
];

export function LevelSelector({ level, onChange, disabled = false }: { level: DuplicateLevel; onChange: (level: DuplicateLevel) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  return <div className="preset-grid duplicate-levels" role="radiogroup" aria-label={t("Removal level")} data-testid="duplicate-levels">
    {duplicateLevels(t).map(item => <button key={item.level} type="button" role="radio" className={`preset ${level === item.level ? 'selected' : ''}`} aria-checked={level === item.level} disabled={disabled} data-testid={`duplicate-level-${item.level}`} onClick={() => onChange(item.level)}><span className="preset-radio">{level === item.level && <span />}</span><span><strong>{item.label}</strong><small>{item.detail}</small></span></button>)}
  </div>;
}

/** What removing would do with the current level and the user's choices. */
export function removalPlan(groups: DuplicateGroup[], level: DuplicateLevel, decisions: Record<string, string>, editedFolder?: string, earlier?: readonly string[]): { resolved: ResolvedGroup[]; summary: RemovalSummary } {
  const resolved = resolveGroups(groups, level, decisions, editedFolder);
  return { resolved, summary: summarize(resolved, earlier) };
}

const separator = (root: string) => root.includes('\\') && !root.includes('/') ? '\\' : '/';
/** The absolute path of a file whose path is relative to the scope root. */
export const absolutePath = (root: string, relative: string) => { const sep = separator(root); return root.replace(/[\\/]+$/, '') + sep + (sep === '/' ? relative : relative.replaceAll('/', sep)); };
const baseName = (path: string) => path.split('/').at(-1) ?? path;

export function strengthLabel(strength: DuplicateStrength, t: Translator): string {
  return strength === 'sha' ? t("Identical files") : strength === 'exif' ? t("Same EXIF and size") : strength === 'exif-size' ? t("Same EXIF, different size") : t("Same name and time");
}

export type FileBadge = 'sha' | 'exif' | 'size' | 'organized' | 'suggested';
/** The badges of one file within its group. */
export function fileBadges(group: DuplicateGroup, file: DuplicateFile, suggested: string, editedFolder?: string): FileBadge[] {
  const others = group.files.filter(other => other !== file);
  const badges: FileBadge[] = [];
  if (file.sha256 && others.some(other => other.sha256 === file.sha256)) badges.push('sha');
  const key = exifKey(file.exif);
  if (key && others.some(other => exifKey(other.exif) === key)) badges.push('exif');
  if (others.length && !others.some(other => other.size === file.size)) badges.push('size');
  if (organizedPath(file.path, editedFolder)) badges.push('organized');
  if (file.path === suggested) badges.push('suggested');
  return badges;
}

export function basicExif(file: DuplicateFile, metadata: Metadata | undefined, t: Translator, formatBytes: (bytes: number) => string, language: Language): [string, string][] {
  const when = formatCaptureDateTime(metadata?.date ?? file.exif?.date, language), exposure = formatExposure(metadata?.exposure, language);
  const width = metadata?.fingerprint?.width ?? file.exif?.width, height = metadata?.fingerprint?.height ?? file.exif?.height;
  const rows: [string, string | undefined][] = [
    [t("Camera"), metadata?.camera ?? file.exif?.camera], [t("Lens"), exposure.lens ?? file.exif?.lens],
    [t("Capture date"), when.date], [t("Capture time"), when.time ? `${when.time}${when.timezone ? ` ${when.timezone}` : ''}` : undefined],
    [t("Shutter speed"), exposure.shutterSpeed], [t("Aperture"), exposure.aperture], [t("ISO"), exposure.iso], [t("Focal length"), exposure.focalLength],
    [t("Dimensions"), width && height ? `${width} × ${height}` : undefined], [t("File size"), formatBytes(file.size)], [t("Path"), file.path],
  ];
  return rows.filter((row): row is [string, string] => row[1] !== undefined && row[1] !== '');
}

function Badge({ kind }: { kind: FileBadge }) {
  const { t } = useTranslation();
  const label = kind === 'sha' ? t("SHA identical") : kind === 'exif' ? t("EXIF identical") : kind === 'size' ? t("Size differs") : kind === 'organized' ? t("In organized structure") : t("Suggested keep");
  return <span className={`small-tag duplicate-badge duplicate-badge-${kind}`} data-badge={kind}>{label}</span>;
}

function Preview({ file, outcome }: { file: DuplicateFile; outcome?: Outcome<Thumbnail> }) {
  const { t } = useTranslation();
  // A preview that failed to arrive reads like an unreadable file; the file's Retry asks again.
  const thumbnail: Thumbnail | undefined = outcome && ('value' in outcome ? outcome.value : { via: 'none', problem: 'unreadable' });
  return <div className="duplicate-preview">
    {thumbnail?.src ? <img src={thumbnail.src} alt={t("Preview of {name}", { name: baseName(file.path) })} loading="lazy" /> : <div className="duplicate-preview-empty" aria-label={thumbnail ? t("No preview available") : t("Loading preview…")}>{thumbnail ? <Icon icon={ImageOff} size={28} /> : <Icon icon={LoaderCircle} size={24} />}</div>}
    {thumbnail?.problem === 'raw-unsupported' && <p className="inline-note duplicate-raw-note" role="note" data-testid="raw-unsupported"><Icon icon={Info} size={14} />{t("This Mac can't decode this RAW format yet, so the camera's embedded preview is shown. Updating macOS or converting the files with Adobe DNG Converter adds support.")}</p>}
    {thumbnail?.problem === 'unreadable' && <p className="inline-note" role="note">{t("This file's preview could not be read.")}</p>}
  </div>;
}

function FullExif({ outcome }: { outcome?: Outcome<Metadata> }) {
  const { t, formatBytes, language } = useTranslation();
  const metadata = outcome && 'value' in outcome ? outcome.value : undefined;
  const categories = useMemo(() => metadata ? categorize(metadata, language, formatBytes) : [], [metadata, language, formatBytes]);
  return <details className="duplicate-full-exif" data-testid="full-exif">
    <summary>{t("Full EXIF")}</summary>
    {outcome && 'error' in outcome ? <p className="muted">{t("This file's EXIF could not be read.")}</p> : !metadata ? <p className="muted">{t("Loading…")}</p> : categories.length === 0 ? <p className="muted">{t("No EXIF found")}</p> : categories.map(category => <section key={category.id} data-category={category.id}>
      <h4>{t(category.title)}</h4>
      <dl>{category.rows.map(row => <div key={row.tag}><dt>{t(row.label)}</dt><dd>{t(row.value)}</dd></div>)}</dl>
    </section>)}
  </details>;
}

export interface GroupViewProps {
  item: ResolvedGroup; number?: number; details: Readonly<Record<string, FileDetails>>; onRetry: (path: string) => void;
  onDecide: (id: string, keep: string) => void; disabled?: boolean; editedFolder?: string;
}
export function GroupView({ item, number, details, onRetry, onDecide, disabled = false, editedFolder }: GroupViewProps) {
  const { t, formatBytes, formatNumber, language } = useTranslation();
  const { group } = item;
  return <article className="duplicate-group" data-testid="duplicate-group" data-group-id={group.id} data-strength={group.strength} data-auto={item.auto ? 'true' : 'false'}>
    <div className="duplicate-group-heading">
      <strong>{number !== undefined ? t("Group {number}", { number: formatNumber(number) }) : t("Group")}</strong>
      <span className="small-tag">{strengthLabel(group.strength, t)}</span>
      {item.auto && <span className="small-tag" data-testid="duplicate-auto">{t("Will be set aside")}</span>}
      {item.needsDecision && <span className="small-tag duplicate-badge-undecided" data-testid="duplicate-undecided">{t("Choose a file to keep")}</span>}
      <label className="duplicate-keep duplicate-keep-all"><input type="radio" name={`keep-${group.id}`} value="all" checked={item.keep === 'all'} disabled={disabled} data-testid="keep-all" onChange={() => onDecide(group.id, 'all')} />{t("Keep all")}</label>
    </div>
    <div className="duplicate-files">{group.files.map(file => {
      const removing = item.remove.includes(file), { thumbnail, exif } = details[file.path] ?? {};
      const failed = (thumbnail && 'error' in thumbnail) || (exif && 'error' in exif);
      return <div key={file.path} className={`duplicate-file ${item.keep === file.path ? 'keeping' : ''} ${removing ? 'removing' : ''}`} data-testid="duplicate-file" data-path={file.path}>
        <Preview file={file} outcome={thumbnail} />
        <label className="duplicate-keep"><input type="radio" name={`keep-${group.id}`} value={file.path} checked={item.keep === file.path} disabled={disabled} data-testid="keep-file" onChange={() => onDecide(group.id, file.path)} /><strong>{baseName(file.path)}</strong></label>
        <div className="duplicate-badges">{fileBadges(group, file, item.suggested, editedFolder).map(badge => <Badge key={badge} kind={badge} />)}{removing && <span className="small-tag duplicate-badge-remove" data-badge="remove">{t("Will be set aside")}</span>}</div>
        <dl className="duplicate-basic" data-testid="basic-exif">{basicExif(file, exif && 'value' in exif ? exif.value : undefined, t, formatBytes, language).map(([label, value]) => <div key={label}><dt>{label}</dt><dd className={label === t("Path") ? 'recovery-root' : undefined}>{value}</dd></div>)}</dl>
        <FullExif outcome={exif} />
        {failed && <div className="rule-actions"><Button icon={RotateCcw} data-testid="details-retry" onClick={() => onRetry(file.path)}>{t("Retry")}</Button></div>}
      </div>;
    })}</div>
  </article>;
}

/** The two-step confirmation: the first sheet says what happens, the second asks again with the exact amount and Cancel focused. */
export function DuplicatesConfirm({ step, summary, name, onCancel, onConfirm }: { step: 'first' | 'second'; summary: Pick<RemovalSummary, 'groups' | 'files' | 'bytes'> & { earlier?: number }; name: string; onCancel: () => void; onConfirm: () => void }) {
  const { t, formatNumber, formatBytes } = useTranslation();
  const values = { files: formatNumber(summary.files), groups: formatNumber(summary.groups), size: formatBytes(summary.bytes), name };
  const earlierNote = summary.earlier ? <p className="field-error" data-testid="duplicates-earlier-warning">{t("{count} of these files were placed by an earlier organization; removing them ends that organization's Undo.", { count: formatNumber(summary.earlier) })}</p> : null;
  return <ConfirmSheet step={step} title={step === 'first' ? t("Remove duplicates from {name}?", { name }) : t("Remove {files} files?", values)} confirmLabel={step === 'first' ? t("Continue…") : t("Remove {files} files", values)} testId={`duplicates-confirm-${step}`} confirmTestId="duplicates-confirm-button" onCancel={onCancel} onConfirm={onConfirm}>
    {step === 'first' ? <><p>{t("{files} files in {groups} groups will be moved to the recovery area, freeing {size} once released.", values)}</p><p>{t("Nothing is deleted yet. You can undo this, and the space is freed only when you release the removed files.")}</p>{earlierNote}</> : <><p>{t("The kept file of each group is checked first. The other {files} files ({size}) move to the recovery area and can be put back with Undo.", values)}</p>{earlierNote}</>}
  </ConfirmSheet>;
}

export function RemovedDuplicates({ jobs, act, busy }: { jobs: OrganizationRecovery[]; act: Dispatch; busy: boolean }) {
  const { t, formatNumber, formatBytes } = useTranslation();
  const [releasing, setReleasing] = useState<OrganizationRecovery>();
  return <section className="organization-recovery duplicates-removed" aria-labelledby="duplicates-removed-heading" data-testid="removed-duplicates">
    <CardHeader icon={RotateCcw} id="duplicates-removed-heading" title={t("Removed duplicates")} detail={t("Set aside with undo. The space is freed when you release them.")} />
    {jobs.length === 0 ? <p className="inline-note"><Icon icon={Info} size={14} />{t("No removed duplicates in this library.")}</p> : <div className="recovery-jobs">{jobs.map(job => {
      const size = formatBytes(job.retainedBytes ?? 0), retained = job.retainedFiles ?? 0;
      return <article className="recovery-job" key={`${job.root}-${job.id}`} data-testid="removed-duplicates-job">
        <p className="recovery-root">{job.root}</p>
        <div className="recovery-job-heading"><span className={`source-status ${job.status === 'pending' ? 'queued' : 'complete'}`}><Icon icon={job.status === 'pending' ? Clock3 : CheckCircle2} size={15} />{job.status === 'undone' ? t("Undone") : job.status === 'pending' ? t("Needs recovery") : t("Removed")}</span><span className="recovery-count">{t("{count} files", { count: formatNumber(job.files) })}</span></div>
        {retained > 0 && <p className="muted"><Icon icon={Info} size={14} />{t("{count} originals ({size}) kept for undo.", { count: formatNumber(retained), size })}</p>}
        {job.error && <p className="field-error">{job.error}</p>}
        <div className="rule-actions">
          {job.undoable && <Button icon={RotateCcw} disabled={busy} data-testid="duplicates-undo" onClick={() => act({ type: 'recovery', op: 'undo', root: job.root, id: job.id })}>{t("Undo")}</Button>}
          {retained > 0 && <Button icon={Trash2} disabled={busy || !job.finalizable} data-testid="duplicates-release" onClick={() => setReleasing(job)}>{t("Release {size}", { size })}</Button>}
        </div>
      </article>;
    })}</div>}
    {releasing && <ReleaseConfirm size={formatBytes(releasing.retainedBytes ?? 0)} root={releasing.root} onCancel={() => setReleasing(undefined)} onConfirm={() => { act({ type: 'recovery', op: 'finalize', root: releasing.root, id: releasing.id }); setReleasing(undefined); }} />}
  </section>;
}

/** Fetches previews and EXIF only for the files on the page, three at a time (see duplicate-details). A new root or scan revision starts empty. */
function useFileDetails(root: string | undefined, revision: number, files: DuplicateFile[]) {
  const [store] = useState(() => createDetailStore({
    thumbnail: (base, path) => window.importer.thumbnail(absolutePath(base, path)),
    exif: (base, path) => window.importer.exif(absolutePath(base, path)),
  }));
  const view = () => store.view(root ?? '', revision);
  const details = useSyncExternalStore(store.subscribe, view, view);
  const key = files.map(file => file.path).join('\0');
  useEffect(() => root ? store.show(root, revision, key ? key.split('\0') : []) : undefined, [store, root, revision, key]);
  return { details, retry: (path: string) => { if (root) store.retry(root, revision, path); } };
}

export function Pagination({ page, pages, onPage }: { page: number; pages: number; onPage: (page: number) => void }) {
  const { t, formatNumber } = useTranslation();
  if (pages <= 1) return null;
  return <nav className="duplicate-pager" aria-label={t("Pages")} data-testid="duplicate-pager">
    <Button kind="quiet" icon={ChevronLeft} aria-label={t("Previous page")} title={t("Previous page")} disabled={page <= 0} onClick={() => onPage(page - 1)} />
    <span className="recovery-count">{t("Page {page} of {pages}", { page: formatNumber(page + 1), pages: formatNumber(pages) })}</span>
    <Button kind="quiet" icon={ChevronRight} aria-label={t("Next page")} title={t("Next page")} disabled={page >= pages - 1} onClick={() => onPage(page + 1)} />
  </nav>;
}

export function duplicatesBusy(state: AppState): boolean {
  const status = state.duplicates?.status;
  return status === 'scanning' || status === 'removing' || !!state.review || !!state.busyReview || state.jobs.some(job => activePhases.includes(job.phase) || job.phase === 'queued');
}

type Filter = 'all' | 'manual' | 'auto';

export function DuplicatesPage({ state, act, onRecovery }: { state: AppState; act: Dispatch; onRecovery?: () => void }) {
  const { t, formatNumber, formatBytes } = useTranslation();
  const dup = state.duplicates ?? { scopes: [], status: 'idle' as const, revision: 0, groups: 0, files: 0 };
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [loadError, setLoadError] = useState('');
  const [level, setLevel] = useState<DuplicateLevel>(1);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<Filter>('all');
  const [pageIndex, setPageIndex] = useState(0);
  const [confirm, setConfirm] = useState<DeleteRecoveryStep>('closed');
  const editedFolder = state.preferences.editedFolder;
  // The groups come over a separate call, only when the scan or a removal has changed them.
  useEffect(() => {
    let alive = true;
    if (!dup.root) { setGroups([]); return; }
    window.importer.duplicateGroups().then(list => {
      if (!alive) return;
      const ids = new Set(list.map(group => group.id));
      setGroups(list); setLoadError('');
      setDecisions(current => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))));
    }).catch(error => { if (alive) setLoadError(error instanceof Error ? error.message : String(error)); });
    return () => { alive = false; };
  }, [dup.revision, dup.root]);
  useEffect(() => { setPageIndex(0); }, [dup.root, dup.revision, level, filter]);
  const locked = dup.status === 'scanning' || dup.status === 'removing';
  const busy = duplicatesBusy(state);
  const plan = useMemo(() => removalPlan(groups, level, decisions, editedFolder, dup.earlier), [groups, level, decisions, editedFolder, dup.earlier]);
  const shown = useMemo(() => plan.resolved.map((item, index) => ({ item, number: index + 1 })).filter(entry => filter === 'all' || (filter === 'auto') === entry.item.auto), [plan.resolved, filter]);
  const pages = Math.max(1, Math.ceil(shown.length / GROUPS_PER_PAGE)), current = Math.min(pageIndex, pages - 1);
  const visible = shown.slice(current * GROUPS_PER_PAGE, (current + 1) * GROUPS_PER_PAGE);
  const { details, retry } = useFileDetails(dup.root, dup.revision, useMemo(() => visible.flatMap(entry => entry.item.group.files), [visible]));
  const decide = (id: string, keep: string) => setDecisions(current => ({ ...current, [id]: keep }));
  const keepSuggested = () => setDecisions(current => ({ ...current, ...Object.fromEntries(plan.resolved.filter(item => item.needsDecision).map(item => [item.group.id, item.suggested])) }));
  const removed = (state.organizationRecovery ?? []).filter(job => job.kind === 'duplicates' && job.root === dup.root);
  const running = dup.root ? state.jobs.find(job => job.organization && job.source.id === `duplicates:${dup.root}` && (activePhases.includes(job.phase) || job.phase === 'queued')) : undefined;
  const { summary } = plan;
  const choose = (choice: 'open' | 'confirm' | 'cancel') => {
    const next = nextConfirmStep(confirm, choice);
    setConfirm(next.step);
    if (next.delete) act({ type: 'duplicatesRemove', level, decisions });
  };
  const scanned = dup.scannedAt !== undefined;
  const counts = { all: plan.resolved.length, manual: plan.resolved.filter(item => !item.auto).length, auto: plan.resolved.filter(item => item.auto).length };
  return <div className="duplicates-page">
    <section className="organization-action" aria-labelledby="duplicates-scope-heading" data-testid="duplicates-scope">
      <CardHeader icon={CopyCheck} id="duplicates-scope-heading" title={t("Where to look")} detail={t("Pick a backup library or any folder. Copies are compared only inside it.")}>
        <Button icon={FolderOpen} data-testid="duplicates-choose-folder" disabled={locked} onClick={() => act({ type: 'duplicatesChooseFolder' })}>{t("Choose folder…")}</Button>
      </CardHeader>
      <label className="organization-destination-select">{t("Library")}
        <select aria-label={t("Library to look through")} data-testid="duplicates-scope-select" disabled={locked} value={dup.root ?? ''} onChange={event => event.target.value && act({ type: 'duplicatesScope', root: event.target.value })}>
          {!dup.root && <option value="">{dup.scopes.length ? t("Choose a library…") : t("No library available")}</option>}
          {dup.scopes.map(scope => <option key={scope.root} value={scope.root}>{scope.name}</option>)}
        </select>
      </label>
      {dup.root && <dl className="organization-paths"><div><dt>{t("Looking through")}</dt><dd>{dup.root}</dd></div></dl>}
      <LevelSelector level={level} onChange={setLevel} disabled={locked} />
      <div className="rule-actions">
        <Button kind="primary" icon={ScanSearch} data-testid="duplicates-scan" disabled={!dup.root || busy} onClick={() => act({ type: 'duplicatesScan' })}>{scanned ? t("Scan again") : t("Scan for duplicates")}</Button>
        <Button icon={Square} data-testid="duplicates-stop" disabled={dup.status !== 'scanning'} onClick={() => act({ type: 'duplicatesStop' })}>{t("Stop")}</Button>
      </div>
      {dup.status === 'scanning' && <div role="status" aria-live="polite"><OperationProgress progress={dup.progress} label={t("Duplicate scan progress")} testId="duplicates-progress" /></div>}
    </section>
    {running && <section className="organization-action organization-running" aria-labelledby="duplicates-running-heading" data-testid="duplicates-running"><CardHeader icon={LoaderCircle} id="duplicates-running-heading" title={t("Removing duplicates")} detail={dup.name} /><OrganizationProgress job={running} act={act} /></section>}
    {dup.result && !running && <p className="notice" role="status" data-testid="duplicates-result"><Icon icon={CheckCircle2} />{t("{count} duplicates set aside ({size}).", { count: formatNumber(dup.result.removed), size: formatBytes(dup.result.bytes) })}{dup.result.errors > 0 && ` ${t("{count} errors", { count: formatNumber(dup.result.errors) })}`}</p>}
    {dup.unread && dup.status === 'ready' && <ScanUnread unread={dup.unread} />}
    {loadError && <p className="field-error" role="alert">{loadError}</p>}
    {state.error?.key === 'error.duplicatesLibraries' && <p className="field-error" role="alert" data-testid="duplicates-libraries-error">{t(state.error)}</p>}
    {dup.root && dup.status === 'ready' && <>
      <section className="organization-action" aria-labelledby="duplicates-summary-heading" data-testid="duplicates-summary">
        <CardHeader icon={Trash2} id="duplicates-summary-heading" title={t("Before you remove")} detail={t("{groups} groups of duplicates found in {files} files.", { groups: formatNumber(groups.length), files: formatNumber(dup.files) })}>
          <Button kind="primary" icon={Trash2} data-testid="duplicates-remove" disabled={busy || summary.files === 0} onClick={() => setConfirm('first')}>{t("Remove duplicates…")}</Button>
        </CardHeader>
        <dl className="dashboard-metrics duplicate-metrics">
          <div><dt>{t("Groups to clean up")}</dt><dd data-metric="groups">{formatNumber(summary.groups)}</dd></div>
          <div><dt>{t("Files to remove")}</dt><dd data-metric="files">{formatNumber(summary.files)}</dd></div>
          <div><dt>{t("Space held for undo")}</dt><dd data-metric="bytes">{formatBytes(summary.bytes)}</dd></div>
          <div><dt>{t("Waiting for your choice")}</dt><dd data-metric="undecided">{formatNumber(summary.undecided)}</dd></div>
        </dl>
        {summary.earlier ? <p className="field-error" data-testid="duplicates-earlier-summary">{t("{count} of these files were placed by an earlier organization; removing them ends that organization's Undo.", { count: formatNumber(summary.earlier) })}</p> : null}
        <p className="inline-note"><Icon icon={Info} size={14} />{t("Removed files go to a recovery area first. Nothing is deleted until you release them.")}</p>
      </section>
      <section className="organization-action duplicate-groups" aria-labelledby="duplicates-groups-heading">
        <CardHeader icon={CopyCheck} id="duplicates-groups-heading" title={t("Groups")}>
          <Button disabled={locked || summary.undecided === 0} data-testid="duplicates-keep-suggested" onClick={keepSuggested}>{t("Keep the suggested file in every group")}</Button>
        </CardHeader>
        {groups.length > 0 && <div className="segmented" role="group" aria-label={t("Show groups")}>{([['all', t("All ({count})", { count: formatNumber(counts.all) })], ['manual', t("You decide ({count})", { count: formatNumber(counts.manual) })], ['auto', t("Automatic ({count})", { count: formatNumber(counts.auto) })]] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={filter === id} data-testid={`duplicates-filter-${id}`} onClick={() => setFilter(id)}>{label}</button>)}</div>}
        {groups.length === 0 ? <p className="inline-note" data-testid="duplicates-none"><Icon icon={CheckCircle2} size={14} />{t("No duplicates found.")}</p> : <>
          <Pagination page={current} pages={pages} onPage={setPageIndex} />
          <div className="duplicate-list" data-testid="duplicate-list">{visible.map(entry => <GroupView key={entry.item.group.id} item={entry.item} number={entry.number} details={details} onRetry={retry} onDecide={decide} disabled={locked} editedFolder={editedFolder} />)}</div>
          <Pagination page={current} pages={pages} onPage={setPageIndex} />
        </>}
      </section>
    </>}
    {dup.root && dup.status === 'idle' && !scanned && !running && <p className="inline-note" data-testid="duplicates-not-scanned"><Icon icon={Info} size={14} />{t("Scan to look for duplicates in this library.")}</p>}
    {onRecovery ? <Button icon={RotateCcw} onClick={onRecovery}>{t("Recovery & maintenance")}</Button> : dup.root && <RemovedDuplicates jobs={removed} act={act} busy={busy} />}
    {confirm !== 'closed' && <DuplicatesConfirm key={confirm} step={confirm} summary={summary} name={dup.name ?? ''} onCancel={() => choose('cancel')} onConfirm={() => choose('confirm')} />}
  </div>;
}

/** The scan's results are usable, but some files could not be read: how many, and the first few with the reason. */
export function ScanUnread({ unread }: { unread: NonNullable<DuplicatesState['unread']> }) {
  const { t } = useTranslation();
  return <div className="notice" role="status" data-testid="duplicates-unread"><Icon icon={Info} /><div>
    <p>{t(message('duplicates.unread', { count: unread.count }))}</p>
    <ul>{unread.sample.map(item => <li key={item.path}><code>{item.path}</code> {t(item.error)}</li>)}</ul>
  </div></div>;
}
