import { flushSync } from 'react-dom';
import {createStateReceiver} from '../state-channel';
import {driveName,gatherErrors} from '../error-log';
import { createTranslator, I18nProvider, useTranslation, localeNames } from './i18n';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  ArrowDownToLine, ArrowRight, ArrowUpRight, Camera, Check, CheckCheck,
  CheckCircle2, ChevronDown, ChevronRight, CircleAlert, Clock3, Copy,
  ExternalLink, Eye, FileImage, FileQuestion, Files, Folder, FolderCog, FolderOpen,
  EyeOff, FolderPlus, Gauge, HardDrive, History, Info, Laptop, Layers3,
  LayoutGrid, List, ListOrdered, LoaderCircle, Maximize2, Minus, Moon, Pause, Play, Plus, Radio, RefreshCw, RotateCcw, ShieldOff,
  Save, ScanLine, Settings2, ShieldCheck, Square, Sun, Timer, Trash2, Usb, X, ArrowUpToLine,
  type LucideIcon,
} from 'lucide-react';
import type { Accent, Action, AppState, Appearance, AutoOrganizeBackup, BackupMode, CopyMode, DestinationSpace, DriveCameraRecord, Inventory, InventoryFile, Job, Language, MediaLayout, Metadata, Preferences, Progress, Source, SourceCameraInfo } from '../shared';
import { filePath, formatMessage, text, type Message } from '../messages';
import { layoutFolders, mediaKindForPath } from '../media-formats';
import { buildTemplate, parseTemplate, type FolderPath } from '../folder-template';
import { formatCaptureDateTime, formatExposure } from './metadata-display';

type Page = 'desk' | 'drives' | 'organization' | 'history' | 'settings';
const pageOrder: Page[] = ['desk', 'drives', 'organization', 'history', 'settings'];
type Dispatch = (action: Action) => void;
type Preview = { path: string; metadata?: Metadata; loading: boolean; error?: string };
const activePhases = ['discovering', 'verifying', 'copying'];

// In the order the options were asked for; 'flat' is the default.
const mediaLayouts: { value: MediaLayout; title: string; detail: string }[] = [
  { value: 'type-format', title: 'Photos and videos, then file formats', detail: 'Photos/NEF, Photos/JPEG, Videos/MOV inside the camera folder.' },
  { value: 'format', title: 'A folder for each file format', detail: 'NEF, JPEG, MOV folders inside the camera folder.' },
  { value: 'photos-flat', title: 'Photos together, videos in a folder', detail: 'Photos in the camera folder, videos in its Videos folder.' },
  { value: 'videos-flat', title: 'Videos together, photos in a folder', detail: 'Videos in the camera folder, photos in its Photos folder.' },
  { value: 'flat', title: 'Everything in the camera folder', detail: 'Photos and videos side by side.' },
  { value: 'video-root', title: 'A separate video backup folder', detail: 'Videos go to their own backup folder beside the photo backup folder.' },
];
function samplePath(template: string): string[] { return template.replaceAll('{yearMonthName}', '2026-10 October').replaceAll('{monthName}', '10 October').replaceAll('{year}', '2026').replaceAll('{yyyymm}', '202610').replaceAll('{month}', '10').replaceAll('{day}', '20').replaceAll('{yyyyMMdd}', '20261020').replaceAll('{camera}', 'Nikon Z6III').split('/').filter(Boolean); }
const defaultFolderPath = parseTemplate('{year}/{yyyymm}/{camera}')!;
const monthSample = ({ full, english }: FolderPath['month']) => english ? (full ? '2026-10 October' : '10 October') : (full ? '202610' : '10');
/** Date first or camera first, then a toggle per date level. It edits the folder template, the one stored form. */
function FolderPathBuilder({ template, onChange, testId }: { template: string; onChange: (template: string) => void; testId: string }) {
  const { t } = useTranslation();
  const value = parseTemplate(template);
  if (!value) return <div className="notice" data-testid={testId}><Icon icon={Info} /><span>{t("This folder path is a custom template. Edit it under Advanced, or start again with the folder builder.")}</span><Button kind="quiet" onClick={() => onChange(buildTemplate(defaultFolderPath))}>{t("Use the folder builder")}</Button></div>;
  const set = (next: Partial<FolderPath>) => onChange(buildTemplate({ ...value, ...next }));
  return <div className="path-builder" data-testid={testId}>
    <div className="backup-mode"><span className="field-label">{t("Organize first by")}</span><div className="segmented" role="group" aria-label={t("Organize first by")}>{(['date', 'camera'] as const).map(order => <button key={order} type="button" aria-pressed={value.order === order} onClick={() => set({ order })}>{t(order === 'date' ? "Date, then camera" : "Camera, then date")}</button>)}</div></div>
    <Switch checked={value.year} onChange={year => set({ year })} label={t("Year folder")} detail="2026" />
    <Switch checked={value.month.on} onChange={on => set({ month: { ...value.month, on } })} label={t("Month folder")} detail={monthSample(value.month)} />
    {value.month.on && <div className="path-level-options"><Switch checked={value.month.full} onChange={full => set({ month: { ...value.month, full } })} label={t("Include the year in the name")} /><div className="segmented" role="group" aria-label={t("Month names")}>{[false, true].map(english => <button key={String(english)} type="button" aria-pressed={value.month.english === english} onClick={() => set({ month: { ...value.month, english } })}>{english ? t("English") : t("Numbers")}</button>)}</div></div>}
    <Switch checked={value.day.on} onChange={on => set({ day: { ...value.day, on } })} label={t("Day folder")} detail={value.day.full ? '20261020' : '20'} />
    {value.day.on && <div className="path-level-options"><Switch checked={value.day.full} onChange={full => set({ day: { ...value.day, full } })} label={t("Include the year and month in the name")} /></div>}
  </div>;
}
function PathPreview({ label, parts, testId }: { label: string; parts: string[]; testId?: string }) {
  return <div className="folder-preview" data-testid={testId}><span><Icon icon={Folder} size={17} />{label}</span><div>{parts.map((part, index) => <span key={`${index}-${part}`}>{index > 0 && <Icon icon={ChevronRight} size={13} />}<span>{part}</span></span>)}</div></div>;
}
function driveBackupFolder(basePath: string): string { return [...basePath.split(/[\\/]/).filter(Boolean), 'Drive backups', '<drive name>'].join('/'); }
function filename(path: string): string { return path.split(/[\\/]/).filter(Boolean).pop() ?? path; }
function Icon({ icon: IconComponent, size = 18, className = '' }: { icon: LucideIcon; size?: number; className?: string }) {
  return <IconComponent size={size} strokeWidth={1.8} aria-hidden="true" className={className} />;
}
function Button({ children, icon, kind = 'secondary', className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: LucideIcon; kind?: 'primary' | 'secondary' | 'quiet' | 'danger' }) {
  return <button type="button" className={`button button-${kind} ${children === undefined || children === null || children === false ? 'button-icon-only' : ''} ${className}`} {...props}>{icon && <Icon icon={icon} />}{children}</button>;
}
function Switch({ checked, onChange, label, detail, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; detail?: string; disabled?: boolean }) {
  return <label className={`switch-row ${disabled ? 'is-disabled' : ''}`}>
    <span className="switch-copy"><span>{label}</span>{detail && <small>{detail}</small>}</span>
    <span className="switch-control"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} disabled={disabled} /><span className="switch-track" /></span>
  </label>;
}
// Inventories are immutable and shared by reference, so each one's per-format sizes are computed once.
const formatColors:Record<string,string>={NEF:'#a78bda',ARW:'#e87982',CR3:'#8bbd68',JPG:'#ff9b54',JPEG:'#e9b15c',PNG:'#e5c65b',HEIC:'#de8abe',HEIF:'#b8a6ef',MP4:'#66a4ef',MOV:'#5fc5b5',MTS:'#83afcd',TIFF:'#cba578'};
const formatSegmentCache=new WeakMap<Inventory,{kind:string;size:number;color:string}[]>();
function formatSegments(inventory:Inventory){
  const cached=formatSegmentCache.get(inventory);if(cached)return cached;
  const formats=new Map<string,number>();
  for(const file of inventory.files)if(file.kind!=='Other'){const format=filename(file.path).match(/\.([^.]*)$/)?.[1].toUpperCase()??file.kind;formats.set(format,(formats.get(format)??0)+Math.max(0,file.size));}
  const usedColors=new Set<string>();
  const segments=[...formats].sort(([a],[b])=>a.localeCompare(b)).filter(([,size])=>size>0).map(([kind,size])=>{
    let hue=[...kind].reduce((hash,char)=>(hash*31+char.charCodeAt(0))>>>0,0)%360;
    let color=formatColors[kind]??`hsl(${hue.toFixed(1)} 65% 62%)`;
    while(usedColors.has(color)){hue=(hue+137.508)%360;color=`hsl(${hue.toFixed(1)} 65% 62%)`;}
    usedColors.add(color);return {kind,size,color};
  });
  formatSegmentCache.set(inventory,segments);return segments;
}
export function CapacityBar({ total, free, inventory, scanning, unavailable = 'Capacity unavailable' }: { total?: number; free?: number; inventory?: Inventory; scanning?: boolean; unavailable?: string }) {
  const { t, formatBytes: bytes } = useTranslation();
  if (!total || !Number.isFinite(total) || total < 0 || free === undefined || !Number.isFinite(free)) return <div className="capacity-unavailable"><Icon icon={HardDrive} size={13} />{t(unavailable)}</div>;
  const available = Math.max(0,Math.min(total,free)), used=total-available;
  const classified=inventory?formatSegments(inventory):[];
  const classifiedBytes=classified.reduce((sum,item)=>sum+item.size,0);
  // Logical media sizes may exceed physical usage (compression/shared extents).
  // Keep the meter within actual used capacity; the legend reports scanned sizes.
  const scale=classifiedBytes>used&&classifiedBytes?used/classifiedBytes:1;
  const segments=[...classified.map(item=>({...item,width:item.size*scale/total*100,label:item.kind})),{kind:'other',color:'var(--storage-used)',size:Math.max(0,used-classifiedBytes*scale),width:Math.max(0,used-classifiedBytes*scale)/total*100,label:inventory?t('Other or unscanned'):t('Used')}].filter(item=>item.width>0);
  const percent=used/total*100;
  return <div className={`capacity storage-capacity ${percent>90?'capacity-low':''}`} data-testid="storage-capacity">
    <div className="storage-heading"><span>{t("{used} of {total} used",{used:bytes(used),total:bytes(total)})}</span>{scanning&&<span className="storage-scanning">{t("Scanning…")}</span>}</div>
    <div className="storage-track" role="meter" aria-label={t("Storage used")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-valuetext={t("{used} used, {free} free, {total} total",{used:bytes(used),free:bytes(available),total:bytes(total)})}>
      {segments.map(segment=><span key={segment.kind} className="storage-segment" data-storage-kind={segment.kind} title={`${segment.label}: ${bytes(segment.size)}`} style={{width:`${segment.width}%`,background:segment.color}} />)}
      <span className="storage-free" data-storage-kind="free" style={{width:`${available/total*100}%`}} title={t("{size} free",{size:bytes(available)})}>{available/total>=.18&&<span>{bytes(available)}</span>}</span>
    </div>
    <div className="storage-legend">{segments.map(segment=><span key={segment.kind} title={`${segment.label}: ${bytes(segment.size)}`}><i style={{background:segment.color}} />{segment.label}</span>)}<span className="storage-free-label"><i />{t("{size} free",{size:bytes(available)})}</span></div>
    {classifiedBytes>used&&<small className="storage-logical-note">{t("Media categories use scanned file sizes.")}</small>}
  </div>;
}

function ProgressBar({ value, label, indeterminate = false }: { value: number; label: string; indeterminate?: boolean }) {
  const { t, language } = useTranslation();
  return <div className={`progress-track ${indeterminate ? 'progress-discovering' : ''}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} {...(!indeterminate ? { 'aria-valuenow': Math.round(Math.max(0, Math.min(1, value)) * 100) } : {})}><span style={indeterminate ? { width: '24%' } : { transform: `scaleX(${Math.max(0, Math.min(1, value))})` }} /></div>;
}

// Motion: one set of durations and curves, defined in styles.css (:root) and read here. See docs/motion-audit.md.
export function reducedMotion(): boolean { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
function motionToken(name: '--quick' | '--base' | '--slow' | '--ease-ios'): string { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
const motionMs = (name: '--quick' | '--base' | '--slow') => parseFloat(motionToken(name)) || 0;
/** Pages slide in the direction of travel, Settings panels rise or fall, cards morph to their new place, everything else crossfades. */
export type InterfaceChange = 'crossfade' | 'layout' | 'forward' | 'back' | 'category-forward' | 'category-back';
let interfaceTransition: ViewTransition | undefined;
/** Runs a DOM change as a View Transition; a newer change skips the running one, and reduced motion applies it directly. */
export function animateInterfaceChange(change: () => void, kind: InterfaceChange = 'crossfade') {
  if (!document.startViewTransition || reducedMotion()) { change(); return; }
  document.documentElement.dataset.transition = kind;
  const transition = interfaceTransition = document.startViewTransition(() => flushSync(change));
  void transition.finished.catch(() => {}).then(() => { if (interfaceTransition === transition) { interfaceTransition = undefined; delete document.documentElement.dataset.transition; } });
}
const interfaceSettled = () => interfaceTransition?.finished.catch(() => {}) ?? Promise.resolve();
/** Which importer updates are interface swaps, and how they animate. Progress ticks are not: they render directly. */
export function interfaceChangeKind(previous: AppState, next: AppState): InterfaceChange | undefined {
  const a = previous.preferences, b = next.preferences;
  if (a.language !== b.language || a.appearance !== b.appearance || a.accent !== b.accent) return 'crossfade';
  // Cards and rows that come, go or move: drives, organizations, the overview, destination slots, the review.
  const layout = (state: AppState) => [state.sources.map(source => source.id).join('|'), [...new Set(state.jobs.map(job => `${job.organization ? 'organization' : 'source'}:${job.source.id}`))].sort().join('|'), state.preferences.sourceLayout ?? 'list', state.preferences.showDashboard !== false, state.preferences.copyMode, state.preferences.destinations.join('|'), state.review?.id ?? !!state.busyReview].join('\n');
  return layout(previous) !== layout(next) ? 'layout' : undefined;
}
// A sheet opened mid-transition would render beneath the page snapshots, so finish the transition first.
function showSheet(dialog: HTMLDialogElement | null) {
  interfaceTransition?.skipTransition();
  dialog?.showModal();
}
/** Plays the exit of something React is about to remove (a sheet, the toast), then removes it. onClose returns false when new content arrived meanwhile: the element then stays, fully shown. */
function useAnimatedClose(element: RefObject<HTMLElement | null>, onClose: () => void | false) {
  const closing = useRef(false);
  return useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const done = () => { closing.current = false; if (onClose() === false) for (const animation of element.current?.getAnimations() ?? []) animation.cancel(); };
    const node = element.current;
    if (!node || reducedMotion()) { done(); return; }
    const animation = node.animate([{opacity:1,transform:'none'},{opacity:0,transform:'translateY(10px) scale(.97)'}],{duration:motionMs('--quick'),easing:motionToken('--ease-ios'),fill:'forwards'});
    void animation.finished.catch(() => {}).then(done);
  },[element,onClose]);
}

export default function RootApp() {
  const [state, setState] = useState<AppState | null>(null);
  const [stateReceiver] = useState(() => createStateReceiver());
  const [connectionError, setConnectionError] = useState('');
  const [inspectionErrors, setInspectionErrors] = useState<string[]>([]);
  const localErrorTimes = useRef(new Map<string, string>());
  const [page, setPage] = useState<Page>('desk');
  // The Organization page and the top bar act on the same destination.
  const [organizationDestination, setOrganizationDestination] = useState(0);
  // Sidebar source links jump to that source's card on the Import desk.
  const openSource = (sourceId: string) => {
    if (page !== 'desk') navigate('desk');
    void interfaceSettled().then(() => { const card = document.querySelector<HTMLElement>(`article.source-row[data-source-id="${CSS.escape(sourceId)}"]`); const still = reducedMotion(); card?.scrollIntoView({ behavior: still ? 'instant' : 'smooth', block: 'center' }); if (!still) card?.animate([{ boxShadow: '0 0 0 4px var(--accent-ring)' }, { boxShadow: '0 0 0 0 transparent' }], { duration: motionMs('--slow') * 3, easing: 'ease-out' }); });
  };
  const navigate = (next: Page) => { if (next === page) return; animateInterfaceChange(() => { setPage(next); window.scrollTo({ top: 0, behavior: 'instant' }); }, pageOrder.indexOf(next) > pageOrder.indexOf(page) ? 'forward' : 'back'); };
  const [errorsOpen, setErrorsOpen] = useState(false);
  const [errorsTarget, setErrorsTarget] = useState<ErrorTarget>();
  const openErrorsFor = (target?: ErrorTarget) => { setErrorsTarget(target); setErrorsOpen(true); };
  // New-drive prompt: closing it does not answer; unanswered drives are marked on their cards.
  const [dismissedDrives, setDismissedDrives] = useState<string[]>([]);
  const [promptOpen, setPromptOpen] = useState(false);
  const promptKey = [...(state?.newDevices ?? []), ...(state?.reconnectedDevices ?? [])].filter(id => !dismissedDrives.includes(id) && state?.sources.some(source => source.id === id)).join('|');
  useEffect(() => { if (promptKey) setPromptOpen(true); }, [promptKey]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const previewSequence = useRef(0);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const shown = useRef<AppState | null>(null);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const change = () => animateInterfaceChange(() => setSystemDark(media.matches));
    media.addEventListener('change', change);
    let alive = true;
    // Interface swaps animate as their state arrives; the transition renders the newest state, not the one that started it.
    const show = (next: AppState | null | undefined) => {
      if (!alive || !next) return;
      const kind = shown.current ? interfaceChangeKind(shown.current, next) : undefined;
      shown.current = next;
      if (kind) animateInterfaceChange(() => setState(shown.current), kind); else setState(next);
    };
    const unsubscribe = window.importer.subscribe(update => show(stateReceiver.apply(update)));
    window.importer.state().then(update => show(stateReceiver.apply(update))).catch(error => { if (alive) setConnectionError(String(error)); });
    return () => { alive = false; unsubscribe(); media.removeEventListener('change', change); };
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (event.key.toLowerCase() === 'r') { event.preventDefault(); window.importer.action({ type: 'refresh' }).catch(error => setConnectionError(String(error))); }
      if (event.shiftKey && event.key.toLowerCase() === 's' && state && !state.review && !state.busyReview && state.preferences.destinations.length >= (state.preferences.copyMode === 'single' ? 1 : 2)) { event.preventDefault(); window.importer.action({ type: 'start' }).catch(error => setConnectionError(String(error))); }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [state]);
  const preferences = state?.preferences;
  const language = preferences?.language ?? 'en';
  const t = createTranslator(language);
  // Layout effects, so a crossfade's new snapshot already has the new language and colours.
  useLayoutEffect(() => { document.documentElement.lang = language; }, [language]);
  const dark = preferences?.appearance === 'dark' || (preferences?.appearance !== 'light' && systemDark);
  useLayoutEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; document.documentElement.dataset.accent = preferences?.accent ?? 'coral'; }, [dark, preferences?.accent]);
  useEffect(() => { document.documentElement.style.setProperty('--text-scale', String(preferences?.textScale ?? 1.25)); }, [preferences?.textScale]);
  const act = useCallback<Dispatch>(action => {
    window.importer.action(action).then(() => setConnectionError('')).catch(error => setConnectionError(error instanceof Error ? error.message : String(error)));
  }, []);
  const inspect = useCallback((path: string) => {
    const request = ++previewSequence.current;
    setPreview({ path, loading: true });
    window.importer.inspect(path).then(metadata => { const diagnostics=Object.entries(metadata.fields).filter(([key])=>key.split(':').at(-1)==='Error').map(([,value])=>`${path}: ${String(value)}`); if(diagnostics.length)setInspectionErrors(errors=>[...new Set([...errors,...diagnostics])]); if (request === previewSequence.current) setPreview({ path, metadata, loading: false }); })
      .catch(error => { const detail=`${path}: ${String(error)}`; setInspectionErrors(errors => errors.includes(detail) ? errors : [...errors,detail]); if (request === previewSequence.current) setPreview({ path, loading: false, error: String(error) }); });
  }, []);
  function closePreview() { ++previewSequence.current; setPreview(null); }
  if (!state) return <div className="connection-screen"><img src="./icon.png" alt="" /><h1>{t("Photo Importer")}</h1><p>{connectionError || t("Opening your camera workbench…")}</p>{connectionError && <Button icon={RefreshCw} onClick={() => location.reload()}>{t("Try again")}</Button>}</div>;
  const busy = pageBusy(state);
  const errors = collectErrors(state, [connectionError, ...inspectionErrors].filter(Boolean).map(detail => { let at = localErrorTimes.current.get(detail); if (!at) { at = new Date().toISOString(); localErrorTimes.current.set(detail, at); } return { detail, at }; }));
  // Window-only errors clear here; the rest ask the main process, which leaves every job as it is.
  const clearErrorItems = (ids?: string[]) => {
    const local = new Set((ids ?? errors.flatMap(error => error.id?.startsWith('local:') ? [error.id] : [])).filter(id => id.startsWith('local:')).map(id => id.slice(6)));
    for (const detail of local) localErrorTimes.current.delete(detail);
    if (local.has(connectionError)) setConnectionError('');
    setInspectionErrors(list => list.filter(detail => !local.has(detail)));
    if (!ids) act({ type: 'clearErrors' }); else for (const id of ids) if (!id.startsWith('local:')) act({ type: 'clearError', id });
  };
  return <I18nProvider language={language}><div className="app-shell">
    <div className={`window-titlebar ${state.platform === 'darwin' ? 'native-mac-titlebar' : ''}`}><h1 className="titlebar-page-title">{page === 'desk' ? t("Import desk") : page === 'drives' ? t("Drives") : page === 'organization' ? t("Organization") : page === 'settings' ? t("Settings") : t("Import history")}</h1><TitlebarControls state={state} act={act} page={page} organizationDestination={organizationDestination} errorCount={errors.length} errorLevel={errors.some(error => explainError(error.message, error.kind).severity === 'error') ? 'error' : errors.length ? 'warning' : undefined} onErrors={() => openErrorsFor()} />{state.platform !== 'darwin' && <div className="window-controls" aria-label={t("Window controls")}><button type="button" aria-label={t("Minimize window")} title={t("Minimize")} onClick={() => act({ type: 'window', command: 'minimize' })}><Icon icon={Minus} size={15} /></button><button type="button" aria-label={t("Maximize or restore window")} title={t("Maximize or restore")} onClick={() => act({ type: 'window', command: 'maximize' })}><Icon icon={Maximize2} size={13} /></button><button type="button" className="window-close" aria-label={t("Close window")} title={t("Close")} onClick={() => act({ type: 'window', command: 'close' })}><Icon icon={X} size={16} /></button></div>}</div>
    <aside className="sidebar">
      <div className="brand"><img src="./icon.png" alt="" /><strong>{t("Photo Importer")}</strong></div>
      <nav aria-label={t("Main navigation")}>
        {([{ id: 'desk', label: t("Import desk"), icon: ArrowDownToLine }, { id: 'drives', label: t("Drives"), icon: Usb }, { id: 'organization', label: t("Organization"), icon: FolderCog }, { id: 'history', label: t("History"), icon: History }, { id: 'settings', label: t("Settings"), icon: Settings2 }] as const).map(item =>
          <button key={item.id} type="button" className={`nav-item ${page === item.id ? 'selected' : ''}`} aria-current={page === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><Icon icon={item.icon} /><span>{item.label}</span>{page === item.id && <span className="nav-indicator" aria-hidden="true" />}</button>)}
      </nav>
      <SidebarSources state={state} onOpen={openSource} errors={errors} onErrors={openErrorsFor} />
      <SidebarDestinations state={state} errors={errors} onErrors={openErrorsFor} />
    </aside>
    <div className="main-shell">
      <main id="main-content" className="main-content">
        {(state.review || state.busyReview) && <ReviewPanel state={state} act={act} inspect={inspect} />}
        {page === 'desk' && <ImportDesk state={state} act={act} needsChoice={dismissedDrives} inspect={inspect} onOrganization={() => navigate('organization')} onSettings={() => navigate('settings')} />}
        {page === 'organization' && <Organization state={state} act={act} busy={busy} selectedDestination={organizationDestination} onSelectDestination={setOrganizationDestination} />}
        {page === 'drives' && <DrivesPage state={state} act={act} />}
        {page === 'settings' && <SettingsPage state={state} act={act} busy={busy} />}
        {page === 'history' && <HistoryPage state={state} onDesk={() => navigate('desk')} />}
      </main>
    </div>
    {errorsOpen && <ActivityPanel state={state} errors={errors} target={errorsTarget} onShowAll={() => setErrorsTarget(undefined)} act={act} onClear={clearErrorItems} onClose={() => setErrorsOpen(false)} onOpenSource={openSource} />}
    <ErrorToast errors={errors} hidden={errorsOpen} onView={() => setErrorsOpen(true)} />
    {promptOpen && <NewDrivePrompt state={state} act={act} skip={dismissedDrives} onDismiss={ids => { setDismissedDrives(current => [...new Set([...current, ...ids])]); setPromptOpen(false); }} onDone={() => setPromptOpen(false)} />}
    {preview && <MetadataDialog preview={preview} onClose={closePreview} act={act} />}
  </div></I18nProvider>;
}

// Each drive shows its capacity and a compact 1·2·3 Scanning/Copying/Verifying status.
// The name gets the full first line; capacity bar and status share the second; free space is the third.
function SidebarCapacity({ total, free, unavailable, status }: { total?: number; free?: number; unavailable: string; status?: ReactNode }) {
  const { t, formatBytes: bytes } = useTranslation();
  const known = !!total && free !== undefined && Number.isFinite(total) && Number.isFinite(free);
  const used = known ? Math.min(1, Math.max(0, 1 - free! / total!)) : 0;
  return <>
    <div className="sidebar-meta">{known ? <span className={`sidebar-capacity ${used > .9 ? 'is-low' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used * 100)} aria-label={t("Storage used")}><span style={{ transform: `scaleX(${used})` }} /></span> : <span className="sidebar-capacity is-unknown" />}{status}</div>
    <small className="sidebar-capacity-text">{known ? t("{free} free of {total}", { free: bytes(free), total: bytes(total) }) : unavailable}</small>
  </>;
}

function MiniSteps({ states }: { states: StepState[] }) {
  const { t } = useTranslation();
  const names = [t("Scanning"), t("Copying"), t("Verifying")];
  const labels: Record<StepState, string> = { pending: t("Waiting"), active: t("In progress"), done: t("Complete"), error: t("Needs attention"), paused: t("Paused"), skipped: t("Skipped") };
  return <span className="mini-steps" role="img" aria-label={states.map((state, index) => `${names[index]}: ${labels[state]}`).join(', ')} title={t("Import steps")}>{states.map((state, index) => <i key={index} data-state={state}>{state === 'done' ? <Icon icon={Check} size={9} /> : state === 'error' ? '!' : state === 'skipped' ? '–' : index + 1}</i>)}</span>;
}

export function SidebarSources({ state, onOpen, errors, onErrors }: { state: AppState; onOpen: (sourceId: string) => void; errors?: DisplayError[]; onErrors?: (target: ErrorTarget) => void }) {
  const { t } = useTranslation();
  const verifyOff = state.preferences.verifyCopies === false;
  return <section className="sidebar-section" aria-labelledby="sidebar-sources"><h2 id="sidebar-sources">{t("Sources")}</h2>
    {state.sources.length ? <ul>{state.sources.map(source => {
      const job = state.jobs.find(item => !item.organization && item.source.id === source.id);
      const scanning = !!state.scanningSources?.includes(source.id);
      const icon = source.transport === 'camera' ? Camera : source.transport === 'folder' ? Folder : Save;
      const steps = sourceStepStates(job, state.sourceInventories?.[source.id] ?? job?.inventory, scanning, verifyOff);
      return <li key={source.id} data-source-id={source.id} className={`sidebar-drive ${sourceSelected(source) ? '' : 'sidebar-item-off'}`} data-testid="sidebar-source"><div className="sidebar-row"><button type="button" className="sidebar-item" title={source.path || source.name} onClick={() => onOpen(source.id)}><Icon icon={icon} size={16} /><span>{source.name}</span></button><SidebarErrors errors={errors} target={{ sourceId: source.id, name: source.name }} onErrors={onErrors} /></div>
        <SidebarCapacity total={source.total} free={source.free} unavailable={source.transport === 'camera' ? t("Capacity unavailable over USB") : t("Capacity unavailable")} status={<MiniSteps states={steps} />} /></li>;
    })}</ul> : <p className="sidebar-empty">{t("No sources connected")}</p>}
  </section>;
}

export function SidebarDestinations({ state, errors, onErrors }: { state: AppState; errors?: DisplayError[]; onErrors?: (target: ErrorTarget) => void }) {
  const { t } = useTranslation();
  const count = state.preferences.copyMode === 'single' ? 1 : 2;
  const destinations = state.preferences.destinations.slice(0, count);
  return <section className="sidebar-section" aria-labelledby="sidebar-destinations"><h2 id="sidebar-destinations">{t("Destinations")}</h2>
    {destinations.length ? <ul>{destinations.map(path => {
      const status = state.destinationStatus?.find(item => item.path === path);
      const online = status?.available !== false;
      return <li key={path} className="sidebar-drive sidebar-destination" title={path} data-testid="sidebar-destination"><div className="sidebar-item sidebar-static"><Icon icon={HardDrive} size={16} /><span>{filename(path) || path}</span><i className={`status-dot ${online ? 'is-online' : 'is-offline'}`} role="img" aria-label={online ? t("Destination available") : t("Drive offline")} /><SidebarErrors errors={errors} target={{ destination: path, name: filename(path) || path }} onErrors={onErrors} /></div>
        <SidebarCapacity total={status?.total} free={status?.free} unavailable={online ? t("Reading drive capacity…") : t("Drive offline")} /></li>;
    })}</ul> : <p className="sidebar-empty">{t("Choose a backup destination")}</p>}
  </section>;
}

function sourceInventories(state: AppState) {
  const sources = new Map(state.sources.map(source => [source.id, source]));
  for (const job of state.jobs) if (!job.organization && !sources.has(job.source.id)) sources.set(job.source.id, job.source);
  return [...sources.values()].flatMap(source => {
    const job = state.jobs.find(job => !job.organization && job.source.id === source.id);
    const inventory = state.sourceInventories?.[source.id] ?? job?.inventory;
    return inventory ? [{source, inventory, backup: !!job?.backup}] : [];
  });
}
type ErrorKind = 'app' | 'source' | 'destination' | 'organization' | 'metadata' | 'format';
/** id: what Clear removes ('local:' ids live only in this window); at: when it appeared; drive: the volume it came from. */
type DisplayError = {id?: string; at?: string; drive?: string; source: string; message: Message; kind: ErrorKind; sourceId?: string; jobId?: string; formatSourceId?: string};
/** A problem only this window saw, such as a failed request or a file it couldn't read. */
export type LocalError = {detail: string; at?: string};
/** A sidebar drive whose errors All errors can show on their own. */
export type ErrorTarget = {sourceId: string; name: string} | {destination: string; name: string};
/** A source's errors carry its id; a destination's are its own status and the organizations on that drive. */
export function errorsFor(errors: DisplayError[], target: ErrorTarget): DisplayError[] {
  if ('sourceId' in target) return errors.filter(error => error.sourceId === target.sourceId);
  const drive = driveName(target.destination, target.destination);
  return errors.filter(error => error.source === target.destination || ((error.kind === 'destination' || error.kind === 'organization') && error.drive === drive));
}
function SidebarErrors({ errors, target, onErrors }: { errors?: DisplayError[]; target: ErrorTarget; onErrors?: (target: ErrorTarget) => void }) {
  const { t, formatNumber } = useTranslation();
  const own = errors ? errorsFor(errors, target) : [];
  if (!own.length) return null;
  const level = own.some(error => explainError(error.message, error.kind).severity === 'error') ? 'error' : 'warning';
  return <button type="button" className="sidebar-error-badge" data-testid="sidebar-errors" data-level={level} aria-label={t("{count} errors", { count: formatNumber(own.length) })} title={t("Show errors for {name}", { name: target.name })} onClick={() => onErrors?.(target)}><Icon icon={CircleAlert} size={13} /><span>{formatNumber(own.length)}</span></button>;
}
type ErrorExplanation = { title: string; hint?: string; severity: 'error' | 'warning' };
// Turns a raw technical message into a plain title, a next step and a severity. Keys are translated at render time.
export function explainError(message: Message, kind: ErrorKind = 'app', language: Language = 'en'): ErrorExplanation {
  const text = formatMessage(message, 'en').toLowerCase();
  if (kind === 'format') return { title: "Unknown file formats", severity: 'warning' };
  if (/enospc|no space|not enough space|disk full/.test(text)) return { title: "Not enough space on the destination.", hint: "Free up space or choose another destination.", severity: 'error' };
  if (/eacces|eperm|permission|not permitted|operation not allowed/.test(text)) return { title: "macOS didn't allow access to this location.", hint: "Check the drive's permissions, or allow the app in Privacy & Security.", severity: 'error' };
  if (/source changed|scan again/.test(text)) return { title: "Files on the drive changed during the import.", hint: "Scan the drive again, then import.", severity: 'error' };
  if (/verification failed|did not match|checksum|digest mismatch/.test(text)) return { title: "A copy didn't match the original.", hint: "Import again. The mismatched copy isn't kept.", severity: 'error' };
  if (message.key === 'error.mirrorReview') return { title: "Mirror needs your review before moving files.", hint: "Open Review on this drive.", severity: 'warning' };
  if (/enoent|enodev|enxio|disconnected|offline|not mounted|no such file/.test(text)) return { title: "The drive was disconnected or a file is missing.", hint: "Reconnect the drive and try again.", severity: 'error' };
  if (/eio|i\/o error|input\/output|read error|write error/.test(text)) return { title: "The drive reported a read or write error.", hint: "Check the card or drive, or try another reader.", severity: 'error' };
  if (/timed? ?out|etimedout/.test(text)) return { title: "The operation took too long.", hint: "Try again. A slow or failing drive can cause this.", severity: 'error' };
  if (kind === 'metadata') return { title: "Couldn't read photo details.", hint: "The file is still copied; its date may come from the file instead.", severity: 'warning' };
  return { title: formatMessage(message, language).split(/(?<=\.)\s|(?<=。)/)[0]!, severity: 'error' };
}
export function collectErrors(state: AppState, extra: (string | LocalError | undefined)[] = []): DisplayError[] {
  const result: DisplayError[] = [];
  for (const item of extra) { const local = typeof item === 'string' ? { detail: item } : item; if (local?.detail && !result.some(error => error.id === 'local:' + local.detail)) result.push({ id: 'local:' + local.detail, source: '', drive: driveName(local.detail, ''), message: text(local.detail), kind: 'app', ...(local.at ? { at: local.at } : {}) }); }
  const cleared = new Set(state.errorLog?.cleared ?? []);
  for (const error of gatherErrors(state)) { const at = state.errorLog?.at[error.id]; if (!cleared.has(error.id)) result.push({ ...error, ...(at ? { at } : {}) }); }
  const t = createTranslator(state.preferences.language);
  for (const {source,inventory,backup} of sourceInventories(state)) {
    if (!backup && (state.preferences.unknownDefault ?? 'skip') === 'ask' && Object.keys(inventory.unknownExtensions).some(extension => !Object.hasOwn({...state.preferences.unknownRules,...state.sessionUnknownRules}, extension))) {
      result.push({source:source.name,drive:driveName(source.path,source.name),message:text(t("Unknown file formats")),kind:'format',sourceId:source.id,formatSourceId:source.id});
    }
  }
  return result;
}

// A short notice when new problems appear while the error sheet is closed.
function ErrorToast({ errors, hidden, onView }: { errors: DisplayError[]; hidden: boolean; onView: () => void }) {
  const { t, formatNumber, language } = useTranslation();
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<DisplayError[]>([]);
  const toast = useRef<HTMLDivElement>(null);
  // Issues that arrive while the toast is leaving keep it on screen.
  const latest = useRef(fresh), leaving = useRef(fresh);
  latest.current = fresh;
  const exit = useAnimatedClose(toast, () => latest.current === leaving.current ? setFresh([]) : false);
  const dismiss = () => { leaving.current = latest.current; exit(); };
  useEffect(() => {
    const keys = errors.map(error => `${error.source}|${JSON.stringify(error.message)}`);
    if (known.current === null) { known.current = new Set(keys); return; }
    const added = errors.filter((error, index) => !known.current!.has(keys[index]!));
    known.current = new Set(keys);
    if (added.length && !hidden) setFresh(added);
  }, [errors, hidden]);
  useEffect(() => { if (!fresh.length) return; const timer = window.setTimeout(dismiss, 7000); return () => window.clearTimeout(timer); }, [fresh]);
  if (!fresh.length || hidden) return null;
  const first = explainError(fresh[0]!.message, fresh[0]!.kind, language);
  return <div ref={toast} className={`error-toast is-${first.severity}`} role="status" data-testid="error-toast"><Icon icon={first.severity === 'error' ? CircleAlert : Info} size={16} /><div><strong>{fresh.length > 1 ? t("{count} new issues", { count: formatNumber(fresh.length) }) : t(first.title)}</strong>{fresh[0]!.source && <span>{fresh[0]!.source}</span>}</div><Button kind="quiet" onClick={() => { setFresh([]); onView(); }}>{t("View")}</Button><Button kind="quiet" icon={X} aria-label={t("Dismiss")} onClick={dismiss} /></div>;
}

/** Copying, planning a review, showing one, or scanning sources: pages lock the settings these depend on. */
function pageBusy(state: AppState): boolean { return state.jobs.some(job => activePhases.includes(job.phase)) || !!state.busyReview || !!state.review || !!state.scanningSources?.length; }
function organizeBusy(state: AppState): boolean { return !!state.review || !!state.busyReview || !!state.scanningSources?.length || state.jobs.some(job => job.organization && (activePhases.includes(job.phase) || job.phase === 'queued')); }
function organizationDestinationIndex(preferences: Preferences, selected: number): number { return preferences.destinations[selected] ? selected : 0; }

/** Each page's own actions, then All errors on every page. */
export function TitlebarControls({state, act, page = 'desk', organizationDestination = 0, errorCount, onErrors, errorLevel}: {state: AppState; act: Dispatch; page?: Page; organizationDestination?: number; errorCount: number; onErrors: () => void; errorLevel?: 'error' | 'warning'}) {
  const { t, formatNumber } = useTranslation();
  const errorsButton = <Button icon={CircleAlert} data-testid="show-errors" title={t("All errors")} aria-label={t("All errors")} onClick={onErrors}><span className="titlebar-label">{t("All errors")}</span><span key={errorCount} className="error-count" data-count={errorCount} data-level={errorLevel} aria-label={t("{count} errors", {count:formatNumber(errorCount)})}>{formatNumber(errorCount)}</span></Button>;
  if (page === 'drives') return <div className="titlebar-actions" aria-label={t("Drive controls")}>{errorsButton}<Button kind="quiet" icon={RefreshCw} className="refresh-button" data-testid="refresh-drives" title={t("Refresh drives")} aria-label={t("Refresh drives")} onClick={() => act({type:'refresh'})} /></div>;
  if (page === 'organization') {
    const destinationIndex = organizationDestinationIndex(state.preferences, organizationDestination);
    const destination = state.preferences.destinations[destinationIndex];
    return <div className="titlebar-actions" aria-label={t("Organization controls")}><Button icon={Eye} data-testid="titlebar-review-organization" disabled={pageBusy(state) || !destination} onClick={() => act({ type: 'previewOrganization', destinationIndex })}>{t("Review changes…")}</Button><Button kind="primary" icon={FolderCog} data-testid="titlebar-organize" disabled={organizeBusy(state) || !destination} onClick={() => act({ type: 'organize', destinationIndex })}>{t("Organize now")}</Button>{errorsButton}</div>;
  }
  if (page !== 'desk') return <div className="titlebar-actions">{errorsButton}</div>;
  const scanning = !!state.scanningSources?.length;
  const canStop = scanning || !!state.review || !!state.busyReview || state.jobs.some(job => activePhases.includes(job.phase) || job.phase === 'queued');
  const configured = state.preferences.destinations.length >= (state.preferences.copyMode === 'single' ? 1 : 2);
  const selectedCount = state.sources.filter(sourceSelected).length;
  const running = state.jobs.some(job => !job.organization && (activePhases.includes(job.phase) || job.phase === 'queued'));
  // Every running job is winding down after Stop or Pause: the controls say so, disabled, until it has.
  const live = state.jobs.filter(job => activePhases.includes(job.phase));
  const winding = live.length > 0 && live.every(job => job.stopping) && !state.jobs.some(job => job.phase === 'queued') && !scanning && !state.review && !state.busyReview;
  const stopping = winding && live.some(job => job.stopping === 'stop');
  return <div className="titlebar-actions" aria-label={t("Import controls")}>{running ? <Button kind="primary" icon={Pause} data-testid="global-start" disabled={winding} aria-busy={winding || undefined} onClick={() => act({type:'pause'})}>{winding ? (stopping ? t("Stopping…") : t("Pausing…")) : t("Pause")}</Button> : <Button kind="primary" icon={Play} data-testid="global-start" disabled={!configured || !selectedCount || scanning || !!state.review || !!state.busyReview} onClick={() => act({type:'start'})}>{selectedCount !== state.sources.length ? t("Start imports ({count})", { count: formatNumber(selectedCount) }) : t("Start imports")}</Button>}<Button icon={Square} data-testid="global-stop" disabled={!canStop || stopping} aria-busy={stopping || undefined} onClick={() => act({type:'stop'})}>{stopping ? t("Stopping…") : t("Stop")}</Button><Button className="automatic-button" icon={state.preferences.automatic ? Check : Radio} data-testid="global-automatic" aria-pressed={state.preferences.automatic} onClick={() => act({type:'preferences',patch:{automatic:!state.preferences.automatic}})}>{t("Automatic")}</Button>{errorsButton}<Button kind="quiet" icon={RefreshCw} className="refresh-button" title={t("Refresh connected sources")} aria-label={t("Refresh connected sources")} onClick={() => act({type:'refresh'})} /></div>;
}

export function ActivityPanel({state, errors: allErrors, act, onClose, onOpenSource, onClear, target, onShowAll}: {state: AppState; errors: DisplayError[]; act:Dispatch; onClose:()=>void; onOpenSource?: (sourceId: string) => void; /** ids to clear; none clears all. */ onClear?: (ids?: string[]) => void; /** Shows only this drive's errors. */ target?: ErrorTarget; onShowAll?: () => void}) {
  const { t, formatNumber, language } = useTranslation();
  const errors = useMemo(() => target ? errorsFor(allErrors, target) : allErrors, [allErrors, target]);
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useAnimatedClose(dialog,onClose);
  useEffect(() => { const element = dialog.current; showSheet(element); return () => element?.close(); }, []);
  const groups = useMemo(() => { const map = new Map<string, DisplayError[]>(); for (const error of errors) map.set(error.source, [...(map.get(error.source) ?? []), error]); return [...map]; }, [errors]);
  const copy = (text: string) => { void navigator.clipboard?.writeText(text).catch(() => {}); };
  const report = () => errors.map(error => [error.at && formatWhen(error.at, language), error.drive, `${error.source || t("App")}: ${t(error.message)}`].filter(Boolean).join(' · ')).join('\n');
  const clear = onClear ?? ((ids?: string[]) => { if (!ids) act({ type: 'clearErrors' }); else for (const id of ids) act({ type: 'clearError', id }); });
  const clearable = errors.some(error => error.id);
  const clearShown = () => target ? clear(errors.flatMap(error => error.id ? [error.id] : [])) : clear();
  return <dialog className="activity-dialog" ref={dialog} aria-labelledby="activity-heading" data-testid="activity-panel" onCancel={event => {event.preventDefault();close();}}>
    <div className="dialog-heading"><h2 id="activity-heading">{t("All errors")}</h2><div className="card-actions">{errors.length > 0 && <Button kind="quiet" icon={Copy} onClick={() => copy(report())}>{t("Copy all details")}</Button>}{clearable && <Button kind="quiet" icon={Trash2} data-testid="errors-clear-all" aria-label={target ? t("Clear all errors for {name}", { name: target.name }) : t("Clear all errors")} onClick={clearShown}>{t("Clear all")}</Button>}<Button kind="quiet" icon={X} data-testid="activity-close" aria-label={t("Close panel")} onClick={close} /></div></div>
    {target && <p className="error-filter" data-testid="errors-filter"><Icon icon={HardDrive} size={14} /><span>{t("Errors for {name}", { name: target.name })}</span>{onShowAll && <Button kind="quiet" onClick={onShowAll}>{t("Show all errors")}</Button>}</p>}
    <div className="activity-content">{errors.length ? <div className="error-groups">{groups.map(([source, items]) => <section key={source || 'app'} className="error-group">
      <div className="error-group-heading"><strong>{source || t("App")}</strong><span>{t("{count} issues", { count: formatNumber(items.length) })}</span>{items[0]!.sourceId && onOpenSource && !items[0]!.formatSourceId && <Button kind="quiet" icon={ArrowUpRight} onClick={() => { onOpenSource(items[0]!.sourceId!); close(); }}>{t("Show drive")}</Button>}</div>
      <ul className="all-errors">{items.map((error, index) => {
        if (error.formatSourceId) return <li key={index} className="error-item is-warning">{sourceInventories(state).filter(item => item.source.id === error.formatSourceId).map(({source,inventory}) => <UnknownFilesPrompt key={source.id} sourceName={source.name} inventory={inventory} knownRules={{...state.preferences.unknownRules,...state.sessionUnknownRules}} act={act} />)}</li>;
        const explained = explainError(error.message, error.kind, language);
        const skippable = error.jobId !== undefined && state.jobs.some(job => job.id === error.jobId && job.phase === 'error' && !!job.skippablePath && job.skippablePath === filePath(error.message));
        return <li key={index} className={`error-item is-${explained.severity}`} data-severity={explained.severity}>
          <div className="error-summary"><Icon icon={explained.severity === 'error' ? CircleAlert : Info} size={16} /><div><p className="error-title">{t(explained.title)}</p>{explained.hint && <p className="error-hint">{t(explained.hint)}</p>}</div>{error.id && <Button kind="quiet" icon={X} data-testid="error-clear" aria-label={t("Clear error: {title}", { title: t(explained.title) })} title={t("Clear")} onClick={() => clear([error.id!])}>{t("Clear")}</Button>}{skippable && <><Button kind="quiet" icon={ChevronRight} data-testid="error-skip" title={t("Leave this file out and run the job again")} onClick={() => act({ type: 'skipFile', jobId: error.jobId!, path: filePath(error.message)! })}>{t("Skip")}</Button><Button kind="quiet" icon={Play} data-testid="error-skip-all" title={t("Run again, skipping files with errors")} onClick={() => act({ type: 'skipAndContinue', jobId: error.jobId! })}>{t("Skip all")}</Button></>}</div>
          {(error.drive || error.at) && <p className="error-meta">{error.drive && <span aria-label={t("Drive: {name}", { name: error.drive })}><Icon icon={HardDrive} size={13} />{error.drive}</span>}{error.at && <time dateTime={error.at}><Icon icon={Clock3} size={13} />{formatWhen(error.at, language)}</time>}</p>}
          <details className="error-details"><summary>{t("Details")}</summary><div><p>{t(error.message)}</p><Button kind="quiet" icon={Copy} onClick={() => copy(t(error.message))}>{t("Copy")}</Button></div></details>
        </li>;
      })}</ul>
    </section>)}</div> : <p className="error-empty"><Icon icon={CheckCircle2} size={16} />{t("No errors to show.")}</p>}</div>
  </dialog>;
}

// Import desk statistics. Source jobs show their own progress on their cards, so only library organization jobs are listed here.
export function ImportDashboard({state, act}: {state: AppState; act: Dispatch}) {
  const { t, language, formatNumber, formatBytes: bytes } = useTranslation();
  const jobs = state.jobs, active = jobs.filter(job => activePhases.includes(job.phase)), queued = jobs.filter(job => job.phase === 'queued');
  const latestJobs = jobs.filter((job,index) => jobs.findIndex(item => item.source.id === job.source.id) === index);
  // Bytes count only once copying starts: planning measures the source, not the transfer.
  const transferring = latestJobs.filter(job => job.progress && job.progress.phase !== 'planning');
  const transferred = transferring.reduce((sum,job) => sum + (job.progress?.bytes ?? 0),0), total = transferring.reduce((sum,job) => sum + (job.progress?.totalBytes ?? 0),0);
  const speed = active.reduce((sum,job) => sum + (job.progress?.speed ?? 0),0);
  // Jobs run side by side, so the longest one sets the time left; queued sources are not counted yet.
  const remaining = active.length && active.every(job => job.eta !== undefined) ? Math.max(...active.map(job => job.eta!)) : undefined;
  const requiredDestinations = state.preferences.copyMode === 'single' ? 1 : 2;
  const configured = state.preferences.destinations.length >= requiredDestinations;
  const readyDestinations = (state.destinationStatus ?? []).filter(disk => disk.available && state.preferences.destinations.slice(0,requiredDestinations).includes(disk.path));
  const organizationJobs = jobs.filter(job => job.organization), runningOrganization = organizationJobs.find(job => activePhases.includes(job.phase));
  const organizing = active.length > 0 && active.every(job => job.organization), planningJob = active.find(job => !job.organization && job.progress?.phase === 'planning');
  // Every job's whole work (checking, copying, verifying) moves the total, each weighted by its size; 100% only when all are complete.
  const verify = state.preferences.verifyCopies !== false;
  const measured = latestJobs.flatMap(job => { const fraction = job.organization ? organizationFraction(job) : importFraction(job, verify); return fraction === undefined ? [] : [{ fraction, weight: Math.max(job.progress?.totalBytes ?? 0, 1) }]; });
  const overall = measured.length ? measured.reduce((sum, item) => sum + item.fraction * item.weight, 0) / measured.reduce((sum, item) => sum + item.weight, 0) : undefined;
  return (<section className="import-dashboard" aria-label={t("Import dashboard")}>
      <div className="dashboard-heading"><div className="dashboard-title"><h2>{t("Import overview")}</h2><Button kind="quiet" icon={EyeOff} className="dashboard-hide" aria-label={t("Hide the import overview")} title={t("Hide the import overview")} onClick={() => act({ type: 'preferences', patch: { showDashboard: false } })} /></div><span className={`status-pill ${active.length ? 'status-working' : ''}`}><Icon icon={active.length ? (organizing ? FolderCog : ArrowDownToLine) : state.review ? Eye : Pause} size={15}/>{active.length ? t(organizing ? "Organizing" : "Transfers running") : state.review ? t("Review pending") : t("Idle")}</span>{state.preferences.verifyCopies === false && <span className="status-pill status-caution" data-testid="verification-off"><Icon icon={ShieldOff} size={14}/>{t("Verification after copy is off")}</span>}</div>
      <dl className="dashboard-metrics">
        <div><dt><Icon icon={Camera} size={16}/>{t("Connected sources")}</dt><dd data-metric="sources">{state.sources.length}</dd></div>
        <div><dt><Icon icon={Layers3} size={16}/>{t("Active / queued")}</dt><dd>{active.length} <span>/ {queued.length}</span></dd><small className="metric-optional">{t("Limit: {count} simultaneous", { count: formatNumber(state.preferences.parallel) })}</small></div>
        <div><dt><Icon icon={Gauge} size={16}/>{t("Transfer speed")}</dt><dd>{speed > 0 ? `${bytes(speed)}/s` : '—'}</dd><small className="metric-optional">{active.length ? t("Combined active sources") : t("No active transfers")}</small></div>
        <div><dt><Icon icon={CheckCheck} size={16}/>{t("Files checked")}</dt><dd>{latestJobs.reduce((sum,job)=>sum+(job.progress?.completed??0),0).toLocaleString(language)}</dd><small>{t("{complete} sources complete · {errors} need attention", { complete: formatNumber(latestJobs.filter(job=>job.phase==='complete').length), errors: formatNumber(latestJobs.filter(job=>job.phase==='error').length) })}</small></div>
        <div><dt><Icon icon={HardDrive} size={16}/>{t("Destinations ready")}</dt><dd data-metric="destinations">{readyDestinations.length} / {requiredDestinations}</dd><small className="metric-optional">{readyDestinations.length ? t("{size} free across destinations", { size: bytes(readyDestinations.reduce((sum,disk)=>sum+(disk.free??0),0)) }) : t("Choose a backup destination")}</small></div>
      </dl>
      <div className="dashboard-total" data-testid="total-progress">
        <div><strong>{t("Total progress")}</strong><span>{overall !== undefined ? `${formatNumber(shownPercent(overall, !active.length && latestJobs.every(job => job.phase === 'complete')))}%` : '—'}</span><small>{total > 0 ? `${bytes(transferred)} ${t("of {size} planned", { size: bytes(total) })}` : planningJob?.progress ? `${importStatus(planningJob, t)} · ${planningJob.source.name} · ${progressCount(planningJob.progress, t, formatNumber, false, bytes)}` : runningOrganization ? `${organizationStatus(runningOrganization, t)} · ${organizationPlace(runningOrganization)}${runningOrganization.progress ? ` · ${progressCount(runningOrganization.progress, t, formatNumber, true, bytes)}` : ''}` : t("No transfer planned")}</small>{remaining !== undefined && <em className="progress-eta" data-testid="total-eta">{t(queued.length ? "{time} left, not counting queued sources" : "{time} left", { time: formatRemaining(remaining, t) })}</em>}</div>
        <ProgressBar value={overall ?? 0} indeterminate={active.length > 0 && overall === undefined} label={t("Combined copy progress")} />
      </div>
      {(!configured || readyDestinations.length < requiredDestinations || !!state.review) && <div className="dashboard-next-step"><Icon icon={state.review && configured && readyDestinations.length >= requiredDestinations ? Info : CircleAlert} size={17}/><p>{!configured ? t(requiredDestinations === 2 ? "{count} sources connected. Choose two backup destinations to enable imports." : "{count} sources connected. Choose a backup destination to enable imports.", { count: formatNumber(state.sources.length) }) : readyDestinations.length<requiredDestinations ? t("A destination is offline. Reconnect it to import.") : t("Apply or discard the review.")}</p>{!configured && <Button icon={Plus} onClick={()=>act({type:'chooseDestination',index:state.preferences.destinations[0]?1:0})}>{t("Choose destination")}</Button>}</div>}
      {organizationJobs.length > 0 && <ul className="progress-jobs">{organizationJobs.map(job => <li key={job.id}><div className="progress-job-heading"><strong>{t("Library organization")}</strong><span className="progress-job-place" title={organizationPlace(job, true)}>{organizationPlace(job)}</span></div><span className="progress-job-status">{organizationStatus(job, t)}</span><OrganizationProgress job={job} act={act} /></li>)}</ul>}
    </section>);
}

type SettingsCategory = 'importing' | 'destinations' | 'folders' | 'organization' | 'drives' | 'general';
const settingsCategories: SettingsCategory[] = ['importing', 'destinations', 'folders', 'organization', 'drives', 'general'];
function savedCategory(): SettingsCategory {
  try { const value = sessionStorage.getItem('settings-category') as SettingsCategory | null; return value && settingsCategories.includes(value) ? value : 'importing'; } catch { return 'importing'; }
}
// Leftovers of interrupted runs on the connected destinations, removed automatically while nothing
// runs; Clean up looks again now and also removes copies a re-import could continue.
function LeftoverFiles({ state, act, busy }: { state: AppState; act: Dispatch; busy: boolean }) {
  const { t, formatNumber, formatBytes } = useTranslation();
  const residue = state.residue;
  const files = (count: number) => count === 1 ? t("1 leftover file") : t("{count} leftover files", { count: formatNumber(count) });
  const status = residue?.checking ? t("Looking for leftover files…") : !residue?.checkedAt ? t("Not checked yet.") : residue.files ? `${files(residue.files)} · ${formatBytes(residue.bytes)}` : t("No leftover files.");
  return <div data-testid="residue-cleanup">
    <div className="settings-row"><span>{status}</span><Button icon={Trash2} disabled={busy || !!residue?.checking} onClick={() => act({ type: 'cleanResidue' })}>{t("Clean up")}</Button></div>
    {!!residue?.resumable.files && <p className="settings-row-note">{t("{count} can continue when that card is imported again ({size}). Automatic cleanup keeps them; Clean up removes them too.", { count: formatNumber(residue.resumable.files), size: formatBytes(residue.resumable.bytes) })}</p>}
    {residue?.cleaned && <p className="settings-row-note">{t("Last cleanup removed {files} ({size}).", { files: files(residue.cleaned.files), size: formatBytes(residue.cleaned.bytes) })}</p>}
    <p className="settings-row-note">{t("Staging files from interrupted imports, organization scratch copies and camera downloads are removed automatically when nothing is running. Originals kept for undo stay until you release them.")}</p>
  </div>;
}
// Settings: a category list with live summaries, and the open category's controls beside it.
export function SettingsPage({state,act,busy}:{state:AppState;act:Dispatch;busy:boolean}) {
  const p = state.preferences;
  const { t, formatNumber } = useTranslation();
  const [open, setOpen] = useState<SettingsCategory>(savedCategory);
  const tabs = useRef<HTMLDivElement>(null);
  // The panel rises or falls in list order while the selection glides to the new category.
  // Rapid keys step from the latest choice, which may not have rendered yet.
  const chosen = useRef(open);
  const choose = (id: SettingsCategory, focus = false) => {
    const from = chosen.current;
    chosen.current = id;
    try { sessionStorage.setItem('settings-category', id); } catch {}
    const select = () => { setOpen(id); if (focus) tabs.current?.querySelector<HTMLElement>(`#settings-tab-${id}`)?.focus(); };
    if (id === from) select(); else animateInterfaceChange(select, settingsCategories.indexOf(id) > settingsCategories.indexOf(from) ? 'category-forward' : 'category-back');
  };
  const copyModes: Record<CopyMode, string> = { single: t("One destination"), mirror: t("Copy to both destinations"), sequential: t("Fill first, then second") };
  const backupCheck = { off: t("Off"), ask: t("Ask"), auto: t("Automatic") }[p.autoOrganizeBackup ?? 'ask'];
  const categories: { id: SettingsCategory; icon: LucideIcon; title: string; summary: string }[] = [
    { id: 'importing', icon: ArrowDownToLine, title: t("Importing"), summary: `${p.automatic ? t("Automatic") : t("Manual")} · ${t("{count} at once", { count: formatNumber(p.parallel) })}` },
    { id: 'destinations', icon: HardDrive, title: t("Destinations"), summary: p.destinations.length ? `${p.destinations.map(path => filename(path)).join(' + ')} · ${copyModes[p.copyMode]}` : t("Not set") },
    { id: 'folders', icon: FolderCog, title: t("Folders"), summary: samplePath(p.template).join(' / ') },
    { id: 'organization', icon: FolderOpen, title: t("Organization"), summary: `${t("Backup folder check")}: ${backupCheck}` },
    { id: 'drives', icon: Usb, title: t("Drives"), summary: t("{count} remembered", { count: formatNumber(Object.keys(p.rememberedDevices ?? {}).length) }) },
    { id: 'general', icon: Settings2, title: t("General"), summary: `${localeNames[p.language] ?? p.language} · ${Math.round(p.textScale * 100)}%` },
  ];
  const locked = busy && <div className="notice"><Icon icon={Info} />{t("Settings are locked while importing or reviewing.")}</div>;
  const panels: Record<SettingsCategory, ReactNode> = {
    importing: <>
      <SettingsSection title={t("Starting imports")} icon={Radio}>
        <Switch checked={p.automatic} onChange={automatic => act({ type: 'preferences', patch: { automatic } })} label={t("Automatic import")} detail={t("Imports start as soon as a selected drive connects.")} />
        <div className="settings-row"><label htmlFor="settings-parallel">{t("Drives at once")}</label><div className="text-size-control"><input id="settings-parallel" type="range" min={1} max={10} step={1} value={p.parallel} onChange={event => act({ type: 'preferences', patch: { parallel: Number(event.target.value) } })} /><strong>{formatNumber(p.parallel)}</strong></div></div>
      </SettingsSection>
      {locked}
      <fieldset className="settings-fieldset" disabled={busy}>
        <SettingsSection title={t("Copying")} icon={ShieldCheck}>
          <Switch checked={p.verifyCopies !== false} onChange={verifyCopies => act({ type: 'preferences', patch: { verifyCopies } })} label={t("Verify each copy after copying")} detail={t("Reads each copy back to confirm it. Off is faster.")} />
          <Switch checked={p.skipFileErrors !== false} onChange={skipFileErrors => act({ type: 'preferences', patch: { skipFileErrors } })} label={t("Skip files with errors and continue")} detail={t("A file that can't be read or changes while it is checked is listed in All errors and left out; the other files are still copied. Off stops the import at the first such file.")} />
          <Switch checked={p.allowFolderSource} onChange={allowFolderSource => act({ type: 'preferences', patch: { allowFolderSource } })} label={t("Enable media folder selection")} detail={t("Lets you choose a folder of photos as a source.")} />
        </SettingsSection>
        <SettingsSection title={t("Drive backups")} icon={Copy}><BackupModeControl preferences={p} act={act} /></SettingsSection>
        <SettingsSection title={t("Other file rules")} icon={FileQuestion}><FileRules preferences={p} act={act} /></SettingsSection>
      </fieldset>
    </>,
    destinations: <>{locked}<fieldset className="settings-fieldset" disabled={busy}>
      <SettingsSection title={t("Backup location")} icon={HardDrive}><DestinationBay state={state} act={act} configure /><TextPreference label={t("Backup folder")} value={p.basePath} placeholder="photobackup" onSave={basePath => act({ type: 'preferences', patch: { basePath } })} description={t("Leave empty to use the drive itself.")} /></SettingsSection>
    </fieldset></>,
    folders: <>{locked}<fieldset className="settings-fieldset" disabled={busy}><FolderSettings state={state} act={act} /></fieldset></>,
    organization: <>
      <SettingsSection title={t("After organizing")} icon={FolderCog}><div data-testid="remove-empty-folders-setting"><Switch checked={p.removeEmptySourceFolders !== false} disabled={busy} onChange={removeEmptySourceFolders => act({ type: 'preferences', patch: { removeEmptySourceFolders } })} label={t("Remove emptied source folders")} detail={t("Folders left empty after organizing are removed. Folders with files are kept.")} /></div><div data-testid="release-duplicates-setting"><Switch checked={p.releaseDuplicatesAfterOrganizing !== false} disabled={busy} onChange={releaseDuplicatesAfterOrganizing => act({ type: 'preferences', patch: { releaseDuplicatesAfterOrganizing } })} label={t("Remove confirmed duplicates")} detail={t("After organizing finishes without errors, originals already present at their destination are checked again and removed instead of kept for undo.")} /></div></SettingsSection>
      <SettingsSection title={t("Backup folder check")} icon={ShieldCheck}>
        <div className="segmented" role="group" aria-label={t("Check the backup folder")}>{(['off', 'ask', 'auto'] as const).map(mode => <button key={mode} type="button" aria-pressed={(p.autoOrganizeBackup ?? 'ask') === mode} disabled={busy} onClick={() => act({ type: 'preferences', patch: { autoOrganizeBackup: mode } })}>{{ off: t("Off"), ask: t("Ask"), auto: t("Automatic") }[mode]}</button>)}</div>
        <p className="settings-row-note">{p.autoOrganizeBackup === 'auto' ? t("Misplaced files are moved into place after each import.") : p.autoOrganizeBackup === 'off' ? t("Not checked automatically.") : t("Checked after each import. You choose when to move files.")}</p>
      </SettingsSection>
      <SettingsSection title={t("Leftover files")} icon={Trash2}><LeftoverFiles state={state} act={act} busy={busy} /></SettingsSection>
    </>,
    drives: <><RememberedDrives preferences={p} act={act} /><IgnoredDrives preferences={p} act={act} /></>,
    general: <>
      <section className="settings-section"><CardHeader icon={Settings2} title={t("General")} /><div className="settings-section-content settings-rows">
        <div className="settings-row"><label htmlFor="app-language">{t("App language")}</label><div className="select-wrap"><select id="app-language" value={p.language ?? 'en'} onChange={event => act({ type: 'preferences', patch: { language: event.target.value as Preferences['language'] } })}>{Object.entries(localeNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><Icon icon={ChevronDown} size={15} /></div></div>
        <div className="settings-row readability-settings"><label htmlFor="text-size">{t("Text size")}</label><div className="text-size-control"><input id="text-size" aria-label={t("Text size")} type="range" min="100" max="200" step="5" value={Math.round(p.textScale*100)} onChange={event=>act({type:'preferences',patch:{textScale:Number(event.target.value)/100}})} /><strong>{Math.round(p.textScale * 100)}%</strong>{p.textScale !== 1.25 && <Button kind="quiet" onClick={()=>act({type:'preferences',patch:{textScale:1.25}})}>{t("Reset text size")}</Button>}</div><small className="settings-row-note">{t("Large sizes shrink to fit small windows.")}</small></div>
        <div className="settings-row"><span>{t("Appearance")}</span><AppearanceControls preferences={p} act={act}/></div>
      </div></section>
      <SettingsSection title={t("Import desk")} icon={Gauge}><div data-testid="show-dashboard"><Switch checked={p.showDashboard !== false} onChange={showDashboard => act({ type: 'preferences', patch: { showDashboard } })} label={t("Show the import overview")} detail={t("Totals, speed and progress at the top of the Import desk.")} /></div></SettingsSection>
    </>,
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
    if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); choose(settingsCategories[event.key === 'Home' ? 0 : settingsCategories.length - 1], true); return; }
    if (!step) return;
    event.preventDefault();
    choose(settingsCategories[(settingsCategories.indexOf(chosen.current) + step + settingsCategories.length) % settingsCategories.length], true);
  };
  return <div className="settings-page settings-layout">
    <nav className="settings-nav" aria-label={t("Settings categories")}><div ref={tabs} role="tablist" aria-orientation="vertical" onKeyDown={onKeyDown}>{categories.map(category => <button type="button" role="tab" key={category.id} id={`settings-tab-${category.id}`} data-testid={`settings-tab-${category.id}`} aria-selected={open === category.id} aria-controls={`settings-panel-${category.id}`} tabIndex={open === category.id ? 0 : -1} onClick={() => choose(category.id)}>{open === category.id && <span className="settings-indicator" aria-hidden="true" />}<span className="settings-nav-icon"><Icon icon={category.icon} size={16} /></span><span className="settings-nav-text"><strong>{category.title}</strong><small>{category.summary}</small></span></button>)}</div></nav>
    <div className="settings-panels">{categories.map(category => <section key={category.id} className="settings-panel" role="tabpanel" id={`settings-panel-${category.id}`} aria-labelledby={`settings-tab-${category.id}`} data-testid={`settings-panel-${category.id}`} hidden={open !== category.id}><h2 className="settings-panel-title">{category.title}</h2>{panels[category.id]}</section>)}</div>
  </div>;
}

// Drives tab: choose which connected drives are imported, and manage remembered and ignored drives.
export function DrivesPage({ state, act }: { state: AppState; act: Dispatch }) {
  const { t, formatBytes: bytes } = useTranslation();
  return <div className="drives-page">
    <section className="settings-section" aria-labelledby="connected-drives"><CardHeader icon={Usb} id="connected-drives" title={t("Connected drives")} /><div className="settings-section-content">
      {state.sources.length ? <ul className="drive-list">{state.sources.map(source => <li key={source.id} data-source-id={source.id} className={sourceSelected(source) ? 'is-selected' : 'is-unselected'}><Icon icon={source.transport === 'camera' ? Camera : source.transport === 'folder' ? Folder : Save} size={18} /><div><strong>{source.name}</strong><small>{[source.total ? bytes(source.total) : '', source.path].filter(Boolean).join(' · ')}</small></div><SelectionChip source={source} act={act} disabled={state.jobs.some(job => !job.organization && job.source.id === source.id && (activePhases.includes(job.phase) || job.phase === 'queued'))} /></li>)}</ul> : <p className="muted">{t("No sources connected")}</p>}
    </div></section>
    <RememberedDrives preferences={state.preferences} act={act} />
    <IgnoredDrives preferences={state.preferences} act={act} />
  </div>;
}

export function formatWhen(value: string, language: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(date); }

export function RememberedDrives({ preferences, act }: { preferences: Preferences; act: Dispatch }) {
  const { t, language } = useTranslation();
  const devices = Object.entries(rememberedDevices(preferences)).sort(([, a], [, b]) => b.lastSelected.localeCompare(a.lastSelected));
  return <SettingsSection title={t("Remembered drives")} icon={CheckCircle2}>
    <div className="saved-rules remembered-devices" data-testid="remembered-devices">{devices.length ? devices.map(([id, device]) => <div key={id}><span className="extension-name">{device.name}</span><span className="muted">{t("Last selected {date}", { date: formatWhen(device.lastSelected, language) })}</span><Button kind="quiet" icon={Trash2} aria-label={t("Forget {name}", { name: device.name })} onClick={() => forgetDevice(act, id)}>{t("Forget")}</Button><RememberedDriveDetails id={id} name={device.name} cameras={preferences.deviceHistory?.[id]?.cameras} /></div>) : <p className="muted">{t("No remembered drives.")}</p>}</div>
  </SettingsSection>;
}

// What the drive's last scan confirmed from EXIF, kept in the device history so it shows while the drive is unplugged.
function RememberedDriveDetails({ id, name, cameras }: { id: string; name: string; cameras?: DriveCameraRecord }) {
  const { t, language, formatNumber, formatBytes: bytes } = useTranslation();
  const progress = cameras && { checked: formatNumber(cameras.checked), total: formatNumber(cameras.total) };
  const tally = (items: DriveCameraRecord['models'], testid: string) => <ul className="remembered-drive-cameras" data-testid={testid}>{items.map(item => <li key={item.name} data-camera-bytes={item.bytes}><span>{item.name}</span><small>{t("{count} files", { count: formatNumber(item.files) })} · {bytes(item.bytes)}</small></li>)}</ul>;
  return <details className="remembered-drive-details" data-testid="remembered-drive-details" data-device-id={id}>
    <summary aria-label={t("Camera details for {name}", { name })}><Icon icon={Camera} size={14} />{t("Details")}<Icon icon={ChevronDown} size={14} /></summary>
    {cameras && progress ? <div className="remembered-drive-content">
      <ul className="drive-history"><li data-testid="drive-scan-time"><Icon icon={ScanLine} size={13} />{t("Last scan finished {date}", { date: formatWhen(cameras.scanned, language) })}</li><li><Icon icon={Files} size={13} />{cameras.status === 'stopped' ? t("Camera metadata scan stopped: {checked}/{total}", progress) : cameras.status === 'error' ? t("Camera metadata scan incomplete: {checked}/{total}", progress) : t("Camera metadata checked: {checked}/{total}", progress)}</li></ul>
      <div><h4>{t("Confirmed by EXIF metadata")}</h4>{cameras.models.length ? tally(cameras.models, 'remembered-drive-models') : <p className="muted">{t("No camera models confirmed in checked files.")}</p>}{cameras.unknown > 0 && <p className="muted">{t("{count} files without a camera model", { count: formatNumber(cameras.unknown) })}</p>}</div>
      {!!cameras.lenses?.length && <div><h4>{t("Lenses from EXIF metadata")}</h4>{tally(cameras.lenses, 'remembered-drive-lenses')}</div>}
    </div> : <p className="muted">{t("No camera data from a scan yet. Scan this drive to see its cameras.")}</p>}
  </details>;
}

export function IgnoredDrives({ preferences, act }: { preferences: Preferences; act: Dispatch }) {
  const { t, language } = useTranslation();
  const devices = Object.entries(preferences.ignoredDevices ?? {}).sort(([, a], [, b]) => b.ignoredAt.localeCompare(a.ignoredAt));
  return <SettingsSection title={t("Ignored drives")} icon={EyeOff}>
    <div className="saved-rules remembered-devices" data-testid="ignored-devices">{devices.length ? devices.map(([id, device]) => <div key={id}><span className="extension-name">{device.name}</span><span className="muted">{t("Ignored {date}", { date: formatWhen(device.ignoredAt, language) })}</span><Button kind="quiet" icon={RotateCcw} aria-label={t("Stop ignoring {name}", { name: device.name })} onClick={() => forgetDevice(act, id)}>{t("Stop ignoring")}</Button></div>) : <p className="muted">{t("No ignored drives.")}</p>}</div>
  </SettingsSection>;
}

// A clearly labelled on/off control for whether a drive takes part in imports.
function SelectionChip({ source, act, disabled = false }: { source: Source; act: Dispatch; disabled?: boolean }) {
  const { t } = useTranslation();
  const on = sourceSelected(source);
  return <button type="button" className={`selection-chip ${on ? 'is-on' : 'is-off'}`} data-testid="source-select" aria-pressed={on} disabled={disabled} title={on ? t("Don't import this drive") : t("Import this drive")} onClick={() => selectSource(act, source.id, !on)}><Icon icon={on ? Check : Plus} size={14} />{on ? t("Selected") : t("Select")}</button>;
}

// Same-volume organizations are renames that keep nothing but can still be undone;
// cross-filesystem ones keep originals until they are released.
export function RetainedOriginals({ job, act, busy }: { job: NonNullable<AppState['organizationRecovery']>[number]; act: Dispatch; busy: boolean }) {
  const { t, formatNumber, formatBytes: bytes } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const retainedFiles = job.retainedFiles ?? 0;
  if (!retainedFiles && !job.undoable && !job.missing) return null;
  const size = bytes(job.retainedBytes ?? 0);
  return <section className="organization-retained" data-testid="organization-retained">
    {retainedFiles > 0 && <p><Icon icon={Info} size={15} />{t("{count} originals ({size}) kept for undo.", { count: formatNumber(retainedFiles), size })}</p>}
    {(job.missing ?? 0) > 0 && <p><Icon icon={Info} size={15} />{t("{count} organized files are no longer where this organization put them.", { count: formatNumber(job.missing!) })}</p>}
    <div className="rule-actions">
      {job.undoable && <Button icon={RotateCcw} disabled={busy} onClick={() => act({ type: 'undoOrganization', root: job.root, id: job.id })}>{t("Undo organization")}</Button>}
      {retainedFiles > 0 && <Button icon={Trash2} disabled={busy || !job.finalizable} onClick={() => setConfirming(true)}>{t("Release {size}", { size })}</Button>}
    </div>
    {confirming && <ReleaseConfirm size={size} root={job.root} onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); act({ type: 'finalizeOrganization', root: job.root, id: job.id }); }} />}
  </section>;
}

export function ReleaseConfirm({ size, root, onCancel, onConfirm }: { size: string; root: string; onCancel: () => void; onConfirm: () => void }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useAnimatedClose(dialog, onCancel);
  useEffect(() => { const element = dialog.current; showSheet(element); return () => element?.close(); }, []);
  return <dialog className="activity-dialog confirm-dialog" ref={dialog} aria-labelledby="release-heading" data-testid="release-confirm" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="dialog-heading"><h2 id="release-heading">{t("Release {size}?", { size })}</h2></div>
    <div className="activity-content"><p>{t("This deletes the kept originals. Undo won't be possible.")}</p><p className="recovery-root">{root}</p></div>
    <div className="dialog-footer"><Button onClick={close}>{t("Cancel")}</Button><Button kind="danger" icon={Trash2} onClick={onConfirm}>{t("Release {size}", { size })}</Button></div>
  </dialog>;
}

function UnknownDefaultControl({ preferences, act }: { preferences: Preferences; act: Dispatch }) {
  const { t } = useTranslation();
  const current = preferences.unknownDefault ?? 'skip';
  const choices: { value: NonNullable<Preferences['unknownDefault']>; label: string; detail: string }[] = [
    { value: 'skip', label: t("Skip automatically"), detail: t("Unknown files are not copied.") },
    { value: 'other', label: t("Copy to Other files folder"), detail: t("Copied to an Other files folder.") },
    { value: 'ask', label: t("Ask me"), detail: t("You'll be asked in All errors.") },
  ];
  return <div className="backup-mode" data-testid="unknown-default">
    <span className="field-label">{t("Unknown files")}</span>
    <div className="segmented" role="group" aria-label={t("Unknown files")}>{choices.map(choice => <button key={choice.value} type="button" aria-pressed={current === choice.value} onClick={() => act({ type: 'preferences', patch: { unknownDefault: choice.value } })}>{choice.label}</button>)}</div>
    <p className="settings-explanation">{choices.find(choice => choice.value === current)!.detail}</p>
  </div>;
}

function BackupModeControl({ preferences, act }: { preferences: Preferences; act: Dispatch }) {
  const { t } = useTranslation();
  const mode = preferences.backupMode ?? 'additive';
  const mirrorBlocked = preferences.copyMode === 'sequential';
  const modes: { value: BackupMode; label: string; detail: string }[] = [
    { value: 'additive', label: t("Additive"), detail: t("Deleted files stay in the backup.") },
    { value: 'mirror', label: t("Mirror"), detail: t("Backup matches the drive. Removed files are moved aside, not deleted.") },
  ];
  return <div className="backup-mode" data-testid="backup-mode">
    <div className="segmented" role="group" aria-label={t("Drive backup mode")}>{modes.map(item => <button key={item.value} type="button" aria-pressed={mode === item.value} disabled={item.value === 'mirror' && mirrorBlocked && mode !== 'mirror'} onClick={() => act({ type: 'preferences', patch: { backupMode: item.value } })}>{item.label}</button>)}</div>
    <p className="settings-explanation">{modes.find(item => item.value === mode)!.detail}</p>
    {mirrorBlocked && <p className="inline-note"><Icon icon={Info} size={14} />{t("Mirror doesn't work with “Fill first, then second”.")}</p>}
    <div className="folder-preview"><span><Icon icon={Folder} size={17} />{t("Drive backups are saved here on each destination")}</span><div>{driveBackupFolder(preferences.basePath).split('/').map((part, index) => <span key={`${index}-${part}`}>{index > 0 && <Icon icon={ChevronRight} size={13} />}<span>{part}</span></span>)}</div></div>
  </div>;
}

function AppearanceControls({ preferences, act }: { preferences: Preferences; act: Dispatch }) {
  const { t } = useTranslation();
  return <section className="appearance-controls" aria-label={t("Appearance")}><div className="segmented appearance-segments" role="group" aria-label={t("Color mode")}>
    {([{ value: 'system', label: t("System"), icon: Laptop }, { value: 'light', label: t("Light"), icon: Sun }, { value: 'dark', label: t("Dark"), icon: Moon }] as { value: Appearance; label: string; icon: LucideIcon }[]).map(mode => <button key={mode.value} type="button" aria-pressed={preferences.appearance === mode.value} onClick={() => act({ type: 'preferences', patch: { appearance: mode.value } })}><Icon icon={mode.icon} size={16} /><span>{mode.label}</span></button>)}
  </div><div className="accent-row"><span>{t("Accent")}</span><div role="group" aria-label={t("Accent color")}>{(['coral', 'ocean', 'forest'] as Accent[]).map(accent => <button type="button" key={accent} aria-label={t(`${accent[0].toUpperCase() + accent.slice(1)} accent`)} aria-pressed={preferences.accent === accent} className={`accent-button accent-${accent}`} onClick={() => act({ type: 'preferences', patch: { accent } })}><span>{preferences.accent === accent && <Icon icon={Check} size={13} />}</span></button>)}</div></div></section>;
}

export function ImportDesk({ state, act, inspect, onOrganization, onSettings, needsChoice = [] }: { state: AppState; act: Dispatch; inspect: (path: string) => void; onOrganization: () => void; onSettings: () => void; needsChoice?: string[] }) {
  const { language, t, formatNumber, formatBytes: bytes } = useTranslation();
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const jobs = state.jobs;
  const active = jobs.filter(job => activePhases.includes(job.phase));
  const queued = jobs.slice().reverse().filter(job => job.phase === 'queued');
  // The order queued jobs will start in, as the importer publishes it; longest waiting first otherwise.
  const startOrder = state.queueOrder ?? queued.map(job => job.id);
  const selectedJob = jobs.find(job => job.id === selectedJobId && !job.organization) ?? jobs.find(job => job.inventory && !job.organization);
  const latestJobs = jobs.filter((job,index)=>!job.organization && jobs.findIndex(item=>item.source.id===job.source.id)===index);
  const progressJobs = latestJobs;
  const transferred = progressJobs.reduce((sum, job) => sum + (job.progress?.bytes ?? 0), 0);
  const total = progressJobs.reduce((sum, job) => sum + (job.progress?.totalBytes ?? 0), 0);
  const speed = active.reduce((sum, job) => sum + (job.progress?.speed ?? 0), 0);
  const idleSources = state.sources.filter(source => !jobs.some(job => job.source.id === source.id));
  // Organizations read a drive or folder too: each one's latest run is a card, ahead of the drives.
  const organizationCards = jobs.filter((job, index) => job.organization && jobs.findIndex(item => item.organization && item.source.id === job.source.id) === index);
  const configured = state.preferences.destinations.length >= (state.preferences.copyMode === 'single' ? 1 : 2);
  const scanning = (state.scanningSources?.length ?? 0) > 0;
  const reviewBusy = !!state.busyReview || !!state.review || active.length > 0 || scanning;
  // Starting one drive queues behind the others; only an open review blocks it.
  const startBlocked = !!state.busyReview || !!state.review;
  const unanswered = (id: string) => needsChoice.includes(id) && newDeviceIds(state).includes(id);
  // Cards follow the source order, so Move to top puts a card first.
  const position = (id: string) => { const index = state.sources.findIndex(source => source.id === id); return index < 0 ? Infinity : index; };
  const cards = [...latestJobs.map(job => ({ id: job.source.id, job, source: job.source })), ...idleSources.map(source => ({ id: source.id, job: undefined as Job | undefined, source }))].sort((a, b) => position(a.id) - position(b.id));
  const movable = (card: typeof cards[number], index: number) => index > 0 && sourceSelected(card.source) && (!card.job || card.job.phase === 'queued' || (card.job.phase === 'stopped' && !!card.job.paused));
  const requiredDestinations = state.preferences.copyMode==='single'?1:2;
  const readyDestinations=(state.destinationStatus??[]).filter(disk=>disk.available&&state.preferences.destinations.slice(0,requiredDestinations).includes(disk.path));
  return <div className="desk-page">
    {state.preferences.showDashboard !== false && <ImportDashboard state={state} act={act} />}
    <div className="workbench-columns"><div className="source-workspace">
      <section aria-labelledby="source-heading" className="source-section"><div className="section-heading"><h2 id="source-heading">{t("Sources & queue")}</h2><div className="source-heading-actions">{state.preferences.showDashboard === false && <Button kind="quiet" icon={Gauge} data-testid="show-dashboard-desk" aria-label={t("Show the import overview")} title={t("Show the import overview")} onClick={() => act({ type: 'preferences', patch: { showDashboard: true } })} />}<div className="source-layout-switch" role="group" aria-label={t("Source layout")}>{([{value:'list',label:t("List view"),icon:List},{value:'grid',label:t("Grid view"),icon:LayoutGrid}] as const).map(layout => <button type="button" key={layout.value} data-testid={`source-layout-${layout.value}`} aria-label={layout.label} title={layout.label} aria-pressed={(state.preferences.sourceLayout ?? 'list') === layout.value} onClick={() => act({type:'preferences',patch:{sourceLayout:layout.value}})}><Icon icon={layout.icon} size={18} /></button>)}</div><label className="parallel-source-control" title={t("Current copies finish before a lower limit takes effect.")}><span className="parallel-source-label">{t("Parallel sources")}</span><input id="parallel-source-limit" aria-label={t("Maximum parallel sources")} type="range" min={1} max={10} step={1} value={state.preferences.parallel} onChange={event => act({type:'preferences',patch:{parallel:Number(event.target.value)}})} /><output htmlFor="parallel-source-limit">{t("{count} of 10",{count:state.preferences.parallel})}</output></label><span className="connected-count">{t("{count} connected", { count: state.sources.length })}</span><Button icon={scanning ? LoaderCircle : ScanLine} disabled={!state.sources.some(source => source.transport !== 'camera') || reviewBusy} onClick={() => act({ type: 'scanSources' })}>{scanning ? t("Scanning…") : t("Scan all")}</Button></div></div>
        <div className={`source-ledger source-layout-${state.preferences.sourceLayout ?? 'list'}`} data-testid="source-cards">
          {latestJobs.length === 0 && organizationCards.length === 0 && idleSources.length === 0 && <div className="source-empty"><div className="empty-device-line"><Icon icon={Camera} size={32} /><span /><Icon icon={Usb} size={20} /><span /><Icon icon={Save} size={30} /></div><h3>{t("Connect camera storage or a memory card.")}</h3><p>{t("Connect a memory card or camera to start.")}</p><span className="inline-note"><Icon icon={Radio} size={14} />{state.preferences.automatic ? t("Automatic import is watching for new connections.") : t("Automatic import is off. Use Start when you’re ready.")}</span></div>}
          {organizationCards.map(job => <OrganizationCard key={job.id} job={job} act={act} />)}
          {cards.map((card, index) => { const { job, source } = card; return job ? <SourceRow canMoveUp={movable(card, index)} key={card.id} source={job.source} job={job} queuePosition={startOrder.indexOf(job.id) + 1} selected={selectedJob?.id === job.id} onSelect={() => animateInterfaceChange(() => setSelectedJobId(job.id))} act={act} configured={configured} inventory={state.sourceInventories?.[job.source.id] ?? job.inventory} scanning={state.scanningSources?.includes(job.source.id)} listing={state.scanProgress?.[job.source.id]} containsBackup={containsBackup(job.source, state.preferences.destinations)} cameraInfo={state.sourceCameraInfo?.[job.source.id]} reviewBusy={reviewBusy} startBlocked={startBlocked} needsChoice={unanswered(job.source.id)} knownRules={state.preferences.unknownRules} verifyOff={state.preferences.verifyCopies === false} /> : <SourceRow canMoveUp={movable(card, index)} key={card.id} source={source} act={act} configured={configured} inventory={state.sourceInventories?.[source.id]} scanning={state.scanningSources?.includes(source.id)} listing={state.scanProgress?.[source.id]} containsBackup={containsBackup(source, state.preferences.destinations)} cameraInfo={state.sourceCameraInfo?.[source.id]} reviewBusy={reviewBusy} startBlocked={startBlocked} needsChoice={unanswered(source.id)} knownRules={state.preferences.unknownRules} verifyOff={state.preferences.verifyCopies === false} />; })}
          <div className="source-footer"><Switch label={t("Enable media folder selection")} checked={state.preferences.allowFolderSource} disabled={active.length > 0 || !!state.review || !!state.busyReview} onChange={allowFolderSource => act({ type: 'preferences', patch: { allowFolderSource } })} /><Button icon={FolderPlus} disabled={!configured || !state.preferences.allowFolderSource || !!state.review || !!state.busyReview} onClick={() => act({ type: 'chooseSource', backup: false })}>{t("Choose media folders…")}</Button></div>
        </div>
      </section>
      {selectedJob?.inventory && <InventoryPanel inventory={selectedJob.inventory} sourceName={selectedJob.source.name} backup={selectedJob.backup} inspect={inspect} act={act} />}
      <section className="backup-action"><CardHeader icon={HardDrive} title={t("Bring an entire drive, too.")} detail={t("Copy every file, keeping its folders.")}><Button icon={Copy} disabled={!configured || !!state.review || !!state.busyReview} onClick={() => act({ type: 'chooseSource', backup: true })}>{t("Back up drives or folders…")}</Button></CardHeader>{state.preferences.backupMode === 'mirror' && <small>{t("Mirror is on: removed files are moved aside after review.")}</small>}</section>
    </div><DestinationBay state={state} act={act} onOrganization={onOrganization} onSettings={onSettings} /></div>
  </div>;
}

type ListingProgress = NonNullable<AppState['scanProgress']>[string];
// Sources without a recorded choice (manual folders) count as selected.
function selectionKnown(source: Source): boolean { return source.selected !== undefined; }
export function sourceSelected(source: Source): boolean { return source.selected !== false; }
function newDeviceIds(state: AppState): string[] { return state.newDevices ?? []; }
function rememberedDevices(preferences: Preferences) { return preferences.rememberedDevices ?? {}; }
function selectSource(act: Dispatch, sourceId: string, selected: boolean) { act({ type: 'selectSource', sourceId, selected }); }
function forgetDevice(act: Dispatch, deviceId: string) { act({ type: 'forgetDevice', deviceId }); }

// One sheet lists every newly connected drive; each needs an explicit answer, and dismissing means "Don't import".
export function NewDrivePrompt({ state, act, skip = [], onDismiss, onDone }: { state: AppState; act: Dispatch; skip?: string[]; onDismiss?: (ids: string[]) => void; onDone?: () => void }) {
  const { t, language, formatBytes: bytes } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = newDeviceIds(state).filter(id => !skip.includes(id));
  // Drives seen before (remembered, or with a finished scan or import) that already have a choice.
  const back = (state.reconnectedDevices ?? []).filter(id => !pending.includes(id) && !skip.includes(id));
  const shown = [...pending, ...back];
  // Remember every drive shown here, so one unplugged while the sheet is open stays visible as "Unplugged".
  const seen = useRef(new Map<string, Source>());
  for (const source of state.sources) if (shown.includes(source.id)) seen.current.set(source.id, source);
  const connected = (id: string) => state.sources.some(source => source.id === id);
  const rows = [...seen.current.values()].filter(drive => shown.includes(drive.id) || !connected(drive.id));
  const actionable = rows.filter(drive => connected(drive.id) && shown.includes(drive.id));
  const close = useAnimatedClose(dialog, () => {
    for (const drive of actionable) if (back.includes(drive.id)) act({ type: 'dismissReconnected', sourceId: drive.id });
    onDismiss?.(actionable.filter(drive => pending.includes(drive.id)).map(drive => drive.id));
  });
  const unanswered = useRef(0);
  unanswered.current = actionable.length;
  const finish = useAnimatedClose(dialog, () => unanswered.current ? false : onDone?.());
  const choosing = rows.some(drive => !back.includes(drive.id));
  useEffect(() => { const element = dialog.current; showSheet(element); return () => element?.close(); }, []);
  // Nothing left to answer (all answered or unplugged): close by itself after a moment.
  useEffect(() => { if (actionable.length) return; const timer = window.setTimeout(finish, rows.length ? 2200 : 0); return () => window.clearTimeout(timer); }, [actionable.length, rows.length]);
  return <dialog className="activity-dialog new-drive-dialog" ref={dialog} aria-labelledby="new-drive-heading" data-testid="new-drive-prompt" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="dialog-heading"><div><span className="dialog-kicker"><Icon icon={Usb} size={15} />{choosing ? t("Choose drives to import") : t("Drives")}</span><h2 id="new-drive-heading">{choosing ? (rows.length > 1 ? t("New drives connected") : t("New drive connected")) : rows.length > 1 ? t("Drives reconnected") : t("Drive reconnected")}</h2></div><Button kind="quiet" icon={X} data-testid="new-drive-close" aria-label={t("Decide later")} title={t("Decide later")} onClick={close} /></div>
    <div className="activity-content"><ul className="new-drives">{rows.map(drive => {
      const hints = state.sourceCameraInfo?.[drive.id]?.hints ?? [];
      const unplugged = !connected(drive.id);
      const returning = back.includes(drive.id);
      const history = state.preferences.deviceHistory?.[drive.id];
      return <li key={drive.id} data-source-id={drive.id} className={unplugged ? 'is-unplugged' : ''}>
        <div className="new-drive-identity"><span className={`source-device ${drive.camera ? '' : 'not-camera'}`}><Icon icon={drive.camera ? Camera : HardDrive} size={21} /></span><div><h3>{returning ? drive.name : t("Import from {name}?", { name: drive.name })}</h3><small>{[drive.total ? bytes(drive.total) : '', drive.path].filter(Boolean).join(' · ')}</small></div>{unplugged && <span className="unplugged-badge" data-testid="drive-unplugged"><Icon icon={Usb} size={13} />{t("Unplugged")}</span>}</div>
        {unplugged ? <p className="new-drive-evidence">{t("Reconnect it to choose.")}</p> : <p className={`new-drive-evidence ${drive.camera ? 'camera' : ''}`}><Icon icon={drive.camera ? CheckCircle2 : Info} size={14} />{drive.camera ? t("Camera folders (DCIM) found.") : t("No camera folders (DCIM) found.")}</p>}
        {(history?.lastImportVerified || history?.lastScanCompleted) && <ul className="drive-history" data-testid="drive-history">{history.lastImportVerified && <li><Icon icon={ShieldCheck} size={13} />{t("Last import verified {date}", { date: formatWhen(history.lastImportVerified, language) })}</li>}{history.lastScanCompleted && <li><Icon icon={ScanLine} size={13} />{t("Last scan finished {date}", { date: formatWhen(history.lastScanCompleted, language) })}</li>}</ul>}
        {!unplugged && hints.length > 0 && <ul className="new-drive-hints">{hints.map(hint => <li key={`${hint.evidence}-${hint.name}`}>{hint.name}</li>)}</ul>}
        {returning ? <div className="rule-actions"><Button icon={Check} disabled={unplugged} onClick={() => act({ type: 'dismissReconnected', sourceId: drive.id })}>{t("OK")}</Button>{drive.selected === false ? <Button kind="primary" icon={ArrowDownToLine} disabled={unplugged} onClick={() => selectSource(act, drive.id, true)}>{t("Import from this drive")}</Button> : <Button kind="primary" icon={ArrowDownToLine} disabled={unplugged} onClick={() => act({ type: 'start', sourceId: drive.id })}>{t("Import now")}</Button>}</div> : <div className="rule-actions"><Button kind={drive.camera ? 'secondary' : 'primary'} icon={X} disabled={unplugged} onClick={() => selectSource(act, drive.id, false)}>{t("Don't import")}</Button><Button kind={drive.camera ? 'primary' : 'secondary'} icon={ArrowDownToLine} disabled={unplugged} onClick={() => selectSource(act, drive.id, true)}>{t("Import from this drive")}</Button></div>}
      </li>;
    })}</ul><p className="settings-explanation">{t("Change this any time in Drives.")}</p></div>
  </dialog>;
}
type StepState = 'pending' | 'active' | 'done' | 'error' | 'paused' | 'skipped';
// Scanning → Copying → Verifying for one source, derived from its latest job and read-only scan.
export function sourceStepStates(job: Job | undefined, inventory: Inventory | undefined, scanning: boolean, verifyOff: boolean): StepState[] {
  const skipVerify = (state: StepState): StepState => verifyOff ? 'skipped' : state;
  if (!job || job.phase === 'queued') return [scanning ? 'active' : inventory ? 'done' : 'pending', 'pending', skipVerify('pending')];
  if (job.phase === 'complete') return ['done', 'done', skipVerify('done')];
  const progressPhase = job.progress?.phase;
  const stage = progressPhase === 'verifying' ? 2 : progressPhase === 'copying' || job.phase === 'copying' ? 1 : 0;
  const current: StepState = job.phase === 'error' ? 'error' : job.phase === 'stopped' ? 'paused' : 'active';
  return [0, 1, 2].map(index => index === 2 && verifyOff ? 'skipped' : index < stage ? 'done' : index === stage ? current : 'pending');
}
export function SourceSteps({ job, inventory, scanning, verifyOff }: { job?: Job; inventory?: Inventory; scanning: boolean; verifyOff: boolean }) {
  const { t } = useTranslation();
  const states = sourceStepStates(job, inventory, scanning, verifyOff);
  const icons: Record<StepState, LucideIcon | null> = { pending: null, active: LoaderCircle, done: Check, error: CircleAlert, paused: Pause, skipped: Minus };
  return <ol className="source-steps" aria-label={t("Import steps")} data-testid="source-steps">{[t("Scanning"), t("Copying"), t("Verifying")].map((label, index) => {
    const state = states[index]!, icon = icons[state];
    return <li key={index} data-state={state} aria-current={state === 'active' ? 'step' : undefined} title={state === 'skipped' ? t("Verification after copy is off") : undefined}><span className="step-mark">{icon ? <Icon icon={icon} size={12} /> : index + 1}</span><span>{label}</span></li>;
  })}</ol>;
}

// A scan first lists the card's files, then reads camera metadata from each media file.
// A library organization: planning first (files checked), then moving and verifying, with n of x and %.
// Share done: planning reads use bytes, planning checks and verification use files, copying uses bytes.
/** 100% only once the work is finished: the last file can still be in progress at 99.9%. */
export function shownPercent(fraction: number, finished: boolean): number {
  return finished ? 100 : Math.min(99, Math.floor(Math.max(0, fraction) * 100));
}
function progressFraction(progress: NonNullable<Job['progress']>): number | undefined {
  const files = progress.total ? progress.completed / progress.total : undefined, data = progress.totalBytes ? progress.bytes / progress.totalBytes : undefined;
  if (progress.phase === 'planning') return progress.step === 'reading' ? data ?? files : files ?? data;
  return progress.phase === 'verifying' ? files ?? data : data ?? files;
}
function progressCount(progress: NonNullable<Job['progress']>, t: ReturnType<typeof createTranslator>, formatNumber: (value: number) => string, organization = false, formatBytes?: (value: number) => string): string {
  const counts = { completed: formatNumber(progress.completed), total: formatNumber(progress.total) };
  // While listing, the size found so far is the only other measure.
  if (progress.phase === 'planning' && progress.step === 'listing' && formatBytes) return t("{completed} files found · {size}", { ...counts, size: formatBytes(progress.bytes) });
  if (progress.phase === 'planning' && progress.step === 'reading' && formatBytes && progress.totalBytes) return t("{completed} of {total} files read · {size} of {totalSize}", { ...counts, size: formatBytes(progress.bytes), totalSize: formatBytes(progress.totalBytes) });
  if (progress.step === 'earlier') return t("Checking the earlier organization: {completed} of {total} records", counts);
  if (progress.step === 'confirming') return t("Confirming files before moving: {completed} of {total}", counts);
  if (progress.step === 'comparing') return progress.bytes > 0 && formatBytes ? t("Checking the destination: {completed} of {total} files · {size} read", { ...counts, size: formatBytes(progress.bytes) }) : t("Checking the destination: {completed} of {total} files", counts);
  if (progress.step === 'existing') return t("Confirming files already on the destination: {completed} of {total}", counts);
  if (progress.phase === 'planning') return t(progress.step === 'listing' ? "{completed} files found" : progress.step === 'reading' ? "{completed} of {total} files read" : "{completed} of {total} files checked", counts);
  return t(progress.phase === 'verifying' ? "{completed} of {total} files verified" : organization ? "{completed} of {total} files organized" : "{completed} of {total} files copied", counts);
}
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, sec = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
// Ticks once a second only while running, so just this label re-renders.
function Elapsed({ job }: { job: Job }) {
  const { t } = useTranslation();
  const running = activePhases.includes(job.phase), finished = job.phase === 'complete' || job.phase === 'error' || job.phase === 'stopped';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!running) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [running]);
  if (!job.startedAt || (!running && !finished) || (finished && !job.phaseStartedAt)) return null;
  const time = formatDuration((finished ? Date.parse(job.phaseStartedAt!) : now) - Date.parse(job.startedAt));
  return <span className="progress-elapsed" data-testid="elapsed"><Icon icon={Timer} size={12} />{finished ? t("Took {time}", { time }) : t("{time} elapsed", { time })}</span>;
}
/** Humane time left: "under a minute", "about 12 min", "about 2 h 15 min", "about 14 h". Minutes round to 5 past 10 min. */
export function formatRemaining(seconds: number, t: ReturnType<typeof createTranslator>): string {
  if (seconds < 60) return t("under a minute");
  const minutes = Math.round(seconds / 60), rounded = minutes <= 10 ? minutes : Math.round(minutes / 5) * 5;
  if (rounded < 60) return t("about {minutes} min", { minutes: rounded });
  const hours = Math.floor(rounded / 60), rest = rounded % 60;
  return hours >= 10 ? t("about {hours} h", { hours: Math.round(rounded / 60) }) : rest ? t("about {hours} h {minutes} min", { hours, minutes: rest }) : t("about {hours} h", { hours });
}
/** Time left for a running job, and for its current step when that ends well before the job does. */
function Remaining({ job }: { job: Job }) {
  const { t } = useTranslation();
  const progress = job.progress;
  if (!activePhases.includes(job.phase) || !progress) return null;
  const step = progress.eta, all = job.eta ?? step;
  if (all === undefined) return progress.total > 0 ? <em className="progress-eta" data-testid="eta">{t("Estimating time left…")}</em> : null;
  const text = t("{time} left", { time: formatRemaining(all, t) }) + (step !== undefined && all - step >= 60 ? ` · ${t("{time} left in this step", { time: formatRemaining(step, t) })}` : '');
  return <em className="progress-eta" data-testid="eta">{text}</em>;
}
/** How far an organization is. Its moves are renames, so bytes stay at 0: count files; a finished one is 100%. */
function organizationFraction(job: Job): number | undefined {
  const progress = job.progress;
  return job.phase === 'complete' ? 1 : !progress ? undefined : progress.phase === 'planning' ? progressFraction(progress) : progress.total ? progress.completed / progress.total : progressFraction(progress);
}
/** How far a whole import is: reading the source's metadata 10%, comparing with the destinations 10%,
 * then copying, and verifying the last 10% when it runs. Bytes drive the copy; a finished import is 100%. */
export function importFraction(job: Job, verify = true): number | undefined {
  const progress = job.progress;
  if (job.phase === 'complete') return 1;
  if (!progress) return undefined;
  const share = progressFraction(progress) ?? 0, copied = verify ? .9 : 1;
  if (progress.phase === 'planning') return progress.step === 'listing' ? 0 : progress.step === 'comparing' ? .1 + .05 * share : progress.step === 'existing' ? .15 + .05 * share : .1 * share;
  return progress.phase === 'verifying' ? copied + (1 - copied) * share : .2 + (copied - .2) * share;
}
/** The step an import is on before copying, or its verification. */
function importStatus(job: Job, t: ReturnType<typeof createTranslator>): string {
  const step = job.progress?.phase === 'planning' ? job.progress.step : undefined;
  if (job.progress?.phase === 'verifying') return t("Verifying copied files");
  if (step === 'listing') return t("Listing files");
  if (step === 'checking') return job.backup ? t("Checking files") : t("Reading metadata");
  if (step === 'reading') return t("Reading files");
  return t("Checking existing files");
}
/** What an organization reads: "A006 › photobackup + videobackup", or the full path. */
export function organizationPlace(job: Job, full = false): string {
  const place = full ? job.source.path : filename(job.source.path) || job.source.path;
  return job.folders?.length ? `${place} › ${job.folders.join(' + ')}` : place;
}
/** The step an organization is on, for its status label. */
function organizationStatus(job: Job, t: ReturnType<typeof createTranslator>): string {
  if (job.stopping) return job.stopping === 'pause' ? t("Pausing…") : t("Stopping…");
  if (job.phase === 'error') return t("Needs attention");
  if (job.phase === 'queued') return t("Queued");
  if (job.phase === 'complete') return t("Complete");
  if (job.phase === 'stopped') return job.paused ? t("Paused") : t("Stopped");
  if (job.phase === 'discovering' || job.progress?.step === 'listing') return t("Listing files");
  if (job.progress?.step === 'earlier' || job.progress?.step === 'confirming') return t("Confirming");
  return job.progress?.phase === 'planning' ? (job.progress.step === 'reading' ? t("Reading files") : t("Checking files")) : t("Organizing");
}
/** An organization in Sources & queue: what it reads, the step it is on and its progress. */
export function OrganizationCard({ job, act }: { job: Job; act: Dispatch }) {
  const { t } = useTranslation();
  return <article data-source-id={job.source.id} data-testid="organization-card" className={`source-row organization-card ${job.phase === 'error' ? 'source-error' : ''}`}>
    <div className="source-row-top"><div className="source-device"><Icon icon={FolderCog} size={21} /></div><div className="source-identity"><h3 title={organizationPlace(job, true)}>{t("Library organization")}</h3><span className={`source-status ${job.phase}`}><span key={organizationStatus(job, t)} className="source-status-text">{organizationStatus(job, t)}</span></span></div></div>
    <p className="progress-job-place" title={organizationPlace(job, true)}>{organizationPlace(job, true)}</p>
    <OrganizationProgress job={job} act={act} />
    <SkipFileNotice job={job} act={act} />
  </article>;
}
/** A job stopped on one file it couldn't read or check: Skip leaves that file out, Skip all every file that fails. Both run the job again. */
function SkipFileNotice({ job, act }: { job: Job; act: Dispatch }) {
  const { t } = useTranslation();
  if (job.phase !== 'error' || !job.skippablePath) return null;
  const file = job.skippablePath;
  return <div className="source-choice" data-testid="skip-file"><p title={file}><Icon icon={CircleAlert} size={14} />{t("{file} stopped this job.", { file: file.split(/[\\/]/).pop() ?? file })}</p><div className="rule-actions"><Button icon={ChevronRight} data-testid="skip-file-button" title={t("Leave this file out and run the job again")} onClick={() => act({ type: 'skipFile', jobId: job.id, path: file })}>{t("Skip")}</Button><Button kind="primary" icon={Play} data-testid="skip-all-button" title={t("Run again, skipping files with errors")} onClick={() => act({ type: 'skipAndContinue', jobId: job.id })}>{t("Skip all")}</Button></div></div>;
}
export function OrganizationProgress({ job, act }: { job: Job; act?: Dispatch }) {
  const { t, formatNumber, formatBytes } = useTranslation();
  const progress = job.progress, running = activePhases.includes(job.phase) || job.phase === 'queued', paused = job.phase === 'stopped' && !!job.paused;
  const fraction = organizationFraction(job);
  const label = job.stopping ? (job.stopping === 'pause' ? t("Pausing…") : t("Stopping…")) : !progress ? (job.phase === 'queued' ? t("Queued") : t("Preparing organization…")) : progressCount(progress, t, formatNumber, true, formatBytes);
  return <div className="organization-progress" data-testid="organization-progress">
    <div className="organization-progress-line"><span>{label}</span><Elapsed job={job} /><Remaining job={job} />{fraction !== undefined && <strong>{formatNumber(shownPercent(fraction, job.phase === 'complete'))}%</strong>}{act && running && <Button kind="quiet" icon={Pause} disabled={!!job.stopping} aria-label={t("Pause")} title={t("Pause")} onClick={() => act({ type: 'pause', sourceId: job.source.id })} />}{act && paused && <Button kind="quiet" icon={Play} aria-label={t("Resume")} title={t("Resume")} onClick={() => act({ type: 'continueOrganization', jobId: job.id })} />}{act && running && <Button kind="quiet" icon={Square} disabled={job.stopping === 'stop'} aria-label={t("Stop")} title={t("Stop")} onClick={() => act({ type: 'stop', jobId: job.id })} />}</div>
    {(running || paused) && <ProgressBar value={fraction ?? 0} indeterminate={fraction === undefined} label={t("{name} copy progress", { name: job.source.name })} />}
    {job.detail && <small>{t(job.detail)}</small>}
  </div>;
}

/** What a listing is measured against: a drive's used space, or for a folder the bytes its last listing found. */
export function scanTotalBytes(source: Source, previous?: Inventory): number | undefined {
  if (source.transport !== 'folder' && source.total !== undefined && source.free !== undefined) return source.total - source.free;
  const listed = previous?.files.reduce((sum, file) => sum + file.size, 0);
  return listed ? listed : undefined;
}
/** Files checked (or read) before anything is written: import and organization reviews, the backup folder check. */
export function PlanningProgress({ progress, label }: { progress: Progress; label: string }) {
  const { t, formatNumber } = useTranslation();
  const fraction = progressFraction(progress);
  return <div className="source-progress" data-testid="planning-progress"><ProgressBar value={fraction ?? 0} indeterminate={fraction === undefined} label={label} /><div><span>{progress.total ? progressCount(progress, t, formatNumber) : t("Listing files…")}</span>{progress.eta !== undefined && <em className="progress-eta" data-testid="eta">{t("{time} left", { time: formatRemaining(progress.eta, t) })}</em>}<strong>{filename(progress.file)}</strong></div></div>;
}
// Listing: share of the drive's used space already listed. Metadata: share of media files read.
export function ScanProgress({ sourceName, listing, cameraInfo, usedBytes }: { sourceName: string; listing?: ListingProgress; cameraInfo?: SourceCameraInfo; usedBytes?: number }) {
  const { t, formatNumber, formatBytes: bytes } = useTranslation();
  const reading = cameraInfo?.status === 'reading';
  const fraction = reading ? (cameraInfo.total ? cameraInfo.checked / cameraInfo.total : undefined) : listing && usedBytes && usedBytes > 0 ? Math.min(.99, listing.bytes / usedBytes) : undefined;
  return <div className="source-scan-progress" data-testid="scan-progress" aria-live="polite">
    <div><span>{reading ? t("Reading camera metadata: {checked}/{total}", { checked: formatNumber(cameraInfo.checked), total: formatNumber(cameraInfo.total) }) : t("Listing files…")}{fraction !== undefined && <b className="scan-percent"> {t("{percent}% scanned", { percent: formatNumber(Math.floor(fraction * 100)) })}</b>}</span>{(reading ? cameraInfo.eta : listing?.eta) !== undefined && <em className="progress-eta" data-testid="eta">{t("{time} left", { time: formatRemaining((reading ? cameraInfo.eta : listing?.eta)!, t) })}</em>}{!reading && listing && <strong>{t("{count} files found · {size}", { count: formatNumber(listing.files), size: bytes(listing.bytes) })}</strong>}</div>
    <ProgressBar value={fraction ?? 0} indeterminate={fraction === undefined} label={t("{name} scanning", { name: sourceName })} />
  </div>;
}

// A drive or folder that holds a backup destination: planning leaves the backup folder out.
function containsBackup(source: Source, destinations: string[]): boolean {
  if (!source.path) return false;
  const root = source.path.replace(/[\\/]+$/, '');
  return destinations.some(destination => destination === root || destination.startsWith(root + '/') || destination.startsWith(root + '\\'));
}

function SourceRow({ source, job, queuePosition, selected, onSelect, act, configured, reviewBusy, inventory, scanning, listing, cameraInfo, knownRules, verifyOff = false, containsBackup: holdsBackup = false, startBlocked = false, needsChoice = false, canMoveUp = false }: { canMoveUp?: boolean; verifyOff?: boolean; containsBackup?: boolean; startBlocked?: boolean; needsChoice?: boolean; source: Source; job?: Job; queuePosition?: number; selected?: boolean; onSelect?: () => void; act: Dispatch; configured: boolean; reviewBusy?: boolean; inventory?: Inventory; scanning?: boolean; listing?: ListingProgress; cameraInfo?: SourceCameraInfo; knownRules?: Preferences['unknownRules'] }) {
  const { language, t, formatNumber, formatBytes: bytes } = useTranslation();
  const active = !!job && activePhases.includes(job.phase);
  const queued = job?.phase === 'queued';
  const progress = job?.progress;
  const status = !job ? t("Ready to import") : job.stopping ? (job.stopping === 'pause' ? t("Pausing…") : t("Stopping…")) : queued ? t("Queue position {count}", { count: queuePosition ?? 0 }) : { discovering: t("Discovering files"), verifying: importStatus(job, t), copying: t("Copying files"), complete: t("Complete"), stopped: t("Stopped"), error: t("Needs attention"), queued: t("Queued") }[job.phase];
  const icon = source.transport === 'camera' ? Camera : source.transport === 'folder' ? Folder : Save;
  const paused = job?.phase === 'stopped' && !!job.paused;
  const already = job?.phase === 'complete' && !!job.alreadyImported;
  const mirrorReview = job?.phase === 'error' && job.errors.some(error => error.key === 'error.mirrorReview');
  const statusIcon = job?.phase === 'error' ? CircleAlert : job?.phase === 'complete' ? CheckCircle2 : queued ? Clock3 : active ? ArrowDownToLine : CheckCircle2;
  const included = sourceSelected(source), excluded = !included && !job;
  const statusText = excluded ? t("Not selected · won't be imported") : paused ? t("Paused") : already ? t("Already imported") : status;
  return <article data-source-id={source.id} className={`source-row ${selected ? 'source-selected' : ''} ${job?.phase === 'error' ? 'source-error' : ''} ${excluded ? 'source-unselected' : selectionKnown(source) ? 'source-included' : ''} ${already ? 'source-already' : ''} ${needsChoice ? 'source-needs-choice' : ''}`}>
    <div className="source-row-top"><div className="source-device"><Icon icon={icon} size={21} /></div><div className="source-identity"><h3 title={source.name}>{source.name}</h3><span className={`source-status ${excluded ? 'unselected' : paused ? 'paused' : already ? 'already' : job?.phase ?? 'ready'}`}><Icon icon={excluded ? Pause : paused ? Pause : already ? CheckCheck : statusIcon} size={13} /><span key={statusText} className="source-status-text">{statusText}</span>{job?.backup && <span className="small-tag">{t("Folder backup")}</span>}</span></div><div className="source-row-actions">{canMoveUp && <Button kind="quiet" icon={ArrowUpToLine} data-testid="move-to-top" aria-label={t("Move {name} to the top", { name: source.name })} title={t("Move to the top")} onClick={() => act({ type: 'moveToTop', sourceId: source.id })} />}{selectionKnown(source) && <SelectionChip source={source} act={act} disabled={active || queued} />}<Button kind="quiet" icon={scanning ? LoaderCircle : ScanLine} disabled={excluded || source.transport === 'camera' || reviewBusy || active || queued || scanning} aria-label={t("Scan media on {name}", { name: source.name })} title={source.transport === 'camera' ? t("Use Review for USB cameras.") : t("Read photo and video formats without copying files")} onClick={() => act({ type: 'scanSource', sourceId: source.id })}>{scanning ? t("Scanning…") : t("Scan media")}</Button>{!active && !queued && <Button kind={mirrorReview ? 'primary' : 'quiet'} icon={Eye} disabled={excluded || !configured || reviewBusy} aria-label={t("Review import from {name}", { name: source.name })} title={t("Review files before copying")} onClick={() => act({ type: 'preview', sourceId: source.id })}>{t("Review")}</Button>}{active || queued ? <><Button icon={Pause} disabled={!!job?.stopping} aria-label={t("Pause {name}", { name: source.name })} onClick={() => act({ type: 'pause', sourceId: source.id })}>{t("Pause")}</Button><Button kind="quiet" icon={Square} disabled={job?.stopping === 'stop'} aria-label={t("Stop source")} title={t("Stop source")} onClick={() => act({ type: 'stop', jobId: job!.id })} /></> : <Button icon={paused ? Play : ArrowDownToLine} kind={paused ? 'primary' : 'secondary'} disabled={excluded || !configured || startBlocked} onClick={() => act({ type: 'start', sourceId: source.id })}>{paused ? t("Continue") : t("Import")}</Button>}</div></div>
    {already && <div className="source-progress source-progress-calm" data-testid="already-imported"><ProgressBar value={1} label={t("{name} copy progress", { name: source.name })} /><div><span>{progress?.total ? t("All {count} files are in the backup and verified", { count: formatNumber(progress.total) }) : t("All files are in the backup and verified")}</span></div></div>}
    {needsChoice && <div className="source-choice" data-testid="needs-choice"><p><Icon icon={CircleAlert} size={14} />{t("Choose whether to import this drive.")}</p><div className="rule-actions"><Button icon={X} onClick={() => selectSource(act, source.id, false)}>{t("Don't import")}</Button><Button kind="primary" icon={ArrowDownToLine} onClick={() => selectSource(act, source.id, true)}>{t("Import")}</Button></div></div>}
    {holdsBackup && <p className="source-quiet-note" data-testid="backup-excluded"><Icon icon={Info} size={13} />{t("Your backup folder is left out of this drive")}</p>}
    {progress && !already && <div className="source-progress"><ProgressBar value={progressFraction(progress) ?? 0} label={t("{name} copy progress", { name: source.name })} /><div><span>{progressCount(progress, t, formatNumber, false, progress.step === 'comparing' ? bytes : undefined)}{progress.failed ? <em className="progress-failed"> · {t("{count} failed", { count: formatNumber(progress.failed) })}</em> : null}</span>{job && <Elapsed job={job} />}{job && <Remaining job={job} />}<strong>{progress.speed > 0 && active ? `${bytes(progress.speed)}/s` : job?.phase === 'complete' ? t("Verified") : '—'}</strong></div></div>}
    {mirrorReview && <p className="source-notice"><Icon icon={Eye} size={14} />{t("Review what Mirror will move to continue.")}</p>}
    {job && <SkipFileNotice job={job} act={act} />}
    <SourceSteps job={job} inventory={inventory} scanning={!!scanning} verifyOff={verifyOff} />
    {job?.space && !already && <SourceSpace space={job.space} />}
    {scanning && <ScanProgress sourceName={source.name} listing={listing} cameraInfo={cameraInfo} usedBytes={scanTotalBytes(source, inventory)} />}
    {active && !progress && <ProgressBar value={0} indeterminate label={t("{name} scanning", { name: source.name })} />}
    {job?.detail && active && <p className="source-detail" title={t(job.detail)}>{t(job.detail)}</p>}
    <details className="source-disclosure">
      <summary aria-label={t("Drive details")}><div className="source-compact-capacity"><CapacityBar total={source.total} free={source.free} inventory={inventory} scanning={scanning} unavailable={source.transport === 'camera' ? t("Capacity unavailable over USB") : t("Capacity unavailable")} /></div><span className="source-disclosure-label">{t("Drive details")}<Icon icon={ChevronDown} size={16} /></span></summary>
      <div className="source-expanded-details">
        <dl className="source-location"><div><dt>{t("Drive path")}</dt><dd>{source.path || t("Connected USB camera")}</dd></div></dl>
        {job?.detail && !active && job.phase !== 'error' && <p className="source-detail">{t(job.detail)}</p>}
        <SourceMediaSummary source={source} inventory={inventory} scanning={scanning} />
        {inventory && <SkippedFilesNotice inventory={inventory} />}
        {cameraInfo && <SourceCameraInformation sourceId={source.id} info={cameraInfo} />}
        {job?.inventory && <button type="button" className="inventory-open" aria-pressed={selected} onClick={onSelect}><Icon icon={Files} size={15} /><span>{t("{count} included files", { count: job.inventory.files.filter(file => file.included).length.toLocaleString(language) })}</span><span>{bytes(job.inventory.bytes)}</span><Icon icon={ChevronRight} size={15} /></button>}
      </div>
    </details>
  </article>;
}

/** Space an import needs on each destination once its plan exists: files already there are skipped and not counted. */
export function SourceSpace({ space }: { space: DestinationSpace[] }) {
  const { t, formatBytes: bytes } = useTranslation();
  return <>{space.map((item, index) => <p key={index} className="source-quiet-note" data-testid="source-space"><Icon icon={HardDrive} size={13} />{space.length > 1 ? `${index + 1} · ` : ''}{item.existing > 0 ? t("Needs {needed} of {free} free ({existing} already on the destination)", { needed: bytes(item.needed), free: bytes(item.free), existing: bytes(item.existing) }) : t("Needs {needed} of {free} free", { needed: bytes(item.needed), free: bytes(item.free) })}</p>)}</>;
}

export function SourceCameraInformation({ sourceId, info }: { sourceId: string; info: SourceCameraInfo }) {
  const { t, formatNumber } = useTranslation();
  const lenses = info.lenses ?? [];
  const evidenceLabels = { 'drive-name': 'Drive name', 'file-type': 'File type', 'camera-layout': 'Camera folder layout' };
  const progressValues = { checked: formatNumber(info.checked), total: formatNumber(info.total) };
  return <section className="source-camera-info" aria-label={t("Media camera information")} data-testid="source-camera-info" data-source-id={sourceId}>
    <div className="source-camera-heading"><strong><Icon icon={Camera} size={15} />{t("Camera metadata")}</strong><span aria-live="polite">{info.status === 'reading' ? t("Reading camera metadata: {checked}/{total}", progressValues) : info.status === 'stopped' ? t("Camera metadata scan stopped: {checked}/{total}", progressValues) : info.status === 'error' ? t("Camera metadata scan incomplete: {checked}/{total}", progressValues) : t("Camera metadata checked: {checked}/{total}", progressValues)}</span></div>
    {info.hints.length > 0 && <div className="source-camera-hints"><h4>{t("Camera hints — unconfirmed")}</h4><ul>{info.hints.map((hint, index) => <li key={`${hint.evidence}-${hint.name}-${index}`}><span>{hint.name}</span><small>{t(evidenceLabels[hint.evidence])}</small></li>)}</ul></div>}
    <div className="source-camera-models"><h4>{t("Confirmed by EXIF metadata")}</h4>{info.models.length > 0 ? <ul className="source-camera-names">{info.models.map(model => <li key={model.name}>{model.name}</li>)}</ul> : <p>{t(info.status === 'reading' ? "No camera models confirmed yet." : "No camera models confirmed in checked files.")}</p>}</div>
    <div className="source-camera-models" data-testid="source-lenses"><h4>{t("Lenses from EXIF metadata")}</h4>{lenses.length > 0 ? <ul className="source-camera-names">{lenses.map(lens => <li key={lens.name}>{lens.name}</li>)}</ul> : <p>{t(info.status === 'reading' ? "No lenses identified yet." : "No lens information in checked files.")}</p>}</div>
  </section>;
}

// Camera housekeeping files and unknown formats are expected on cards, so they are explained here rather than reported as errors.
export function SkippedFilesNotice({ inventory }: { inventory: Inventory }) {
  const { t, formatNumber } = useTranslation();
  const systemKinds = useMemo(() => {
    const kinds = new Map<string, { vendor: string; label: string; count: number }>();
    for (const file of inventory.files) if (file.system && !kinds.has(file.system.id)) kinds.set(file.system.id, { vendor: file.system.vendor, label: file.system.label, count: inventory.systemKinds?.[file.system.id] ?? inventory.files.filter(item => item.system?.id === file.system!.id).length });
    return [...kinds.values()].sort((a, b) => b.count - a.count);
  }, [inventory]);
  const unknown = useMemo(() => inventory.files.filter(file => file.kind === 'Other' && !file.companionOf && !file.system), [inventory]);
  const copied = unknown.filter(file => file.included).length, skipped = unknown.length - copied;
  const system = inventory.system ?? 0;
  if (!system && !unknown.length) return null;
  const names = systemKinds.slice(0, 2).map(kind => `${kind.vendor} ${kind.label}`).join(', ') + (systemKinds.length > 2 ? ', …' : '');
  const summary = [
    system > 0 && t("Skipped {count} camera system files ({names})", { count: formatNumber(system), names }),
    skipped > 0 && t("{count} unknown files skipped", { count: formatNumber(skipped) }),
    copied > 0 && t("{count} unknown files copied to other folders", { count: formatNumber(copied) }),
  ].filter(Boolean).join(' · ');
  return <details className="skipped-files" data-testid="skipped-files">
    <summary><Icon icon={Info} size={14} /><span>{summary}</span><Icon icon={ChevronDown} size={14} /></summary>
    <div className="skipped-files-content">
      {systemKinds.length > 0 && <div><h4>{t("Camera system files")}</h4><p>{t("Index files the camera writes. Not needed.")}</p><dl>{systemKinds.map(kind => <div key={`${kind.vendor}-${kind.label}`}><dt>{kind.label}<small>{kind.vendor}</small></dt><dd>{formatNumber(kind.count)}</dd></div>)}</dl></div>}
      {unknown.length > 0 && <div><h4>{t("Unknown files")}</h4><p>{t("Not photos or videos. Change this in Settings.")}</p><dl>{Object.entries(inventory.unknownExtensions).sort(([, a], [, b]) => b - a).map(([extension, count]) => <div key={extension}><dt className="extension-name">{extension ? `.${extension}` : t("No extension")}</dt><dd>{formatNumber(count)}</dd></div>)}</dl></div>}
    </div>
  </details>;
}

function SourceMediaSummary({ source, inventory, scanning }: { source: Source; inventory?: Inventory; scanning?: boolean; cameraInfo?: SourceCameraInfo }) {
  const { language, t, formatNumber, formatBytes: bytes } = useTranslation();
  const summary = useMemo(() => {
    const photos = {count:0, size:0, formats:new Map<string,{count:number;size:number}>()};
    const videos = {count:0, size:0, formats:new Map<string,{count:number;size:number}>()};
    for (const file of inventory?.files ?? []) {
      if (file.kind === 'Other') continue;
      const group = file.kind === 'Videos' ? videos : photos;
      const extension = filename(file.path).match(/\.([^.]*)$/)?.[1].toUpperCase() || '';
      const format = group.formats.get(extension) ?? {count:0,size:0};
      group.count++; group.size += file.size; format.count++; format.size += file.size; group.formats.set(extension,format);
    }
    return {photos,videos};
  }, [inventory]);
  if (!inventory) return <p className="source-scan-prompt" aria-live="polite"><Icon icon={scanning ? LoaderCircle : ScanLine} size={15} />{scanning ? t("Reading media formats and counts…") : source.transport === 'camera' ? t("Use Review for USB cameras.") : t("Scan to see formats and counts")}</p>;
  const {photos,videos} = summary;
  return <section className="source-media" aria-label={t("Media summary for {name}", { name: source.name })} data-testid="source-media-summary" data-source-id={source.id}><div className="source-media-total"><strong>{t("{count} photos & videos", { count: formatNumber(photos.count + videos.count) })}</strong><span>{t("{size} media", { size: bytes(photos.size + videos.size) })}</span>{scanning && <span aria-live="polite">{t("Updating scan…")}</span>}</div><div className="source-media-groups">{([{ label: t("Photos"), value: photos }, { label: t("Videos"), value: videos }]).map(group => <div className="source-media-group" key={group.label}><div className="source-media-heading"><strong>{group.label}</strong><span>{t("{count} files · {size}", { count: formatNumber(group.value.count), size: bytes(group.value.size) })}</span></div>{group.value.count > 0 ? <dl className="source-formats">{[...group.value.formats].sort(([a],[b])=>a.localeCompare(b)).map(([extension, format]) => <div key={extension}><dt>{extension || t("No extension")}</dt><dd><span>{formatNumber(format.count)}</span><span>{bytes(format.size)}</span></dd></div>)}</dl> : <p>{t(group.value === photos ? "No photos found." : "No videos found.")}</p>}</div>)}</div></section>;
}

function DestinationBay({ state, act, onOrganization, onSettings, configure = false }: { state: AppState; act: Dispatch; onOrganization?: () => void; onSettings?: () => void; configure?: boolean }) {
  const { t, formatNumber } = useTranslation();
  const { preferences } = state;
  const descriptions: Record<CopyMode, string> = { single: t("One verified copy."), mirror: t("A verified copy on both drives."), sequential: t("Fill the first drive, then use the second.") };
  return <aside className="destination-bay" aria-labelledby="destination-heading"><div className="section-heading"><h2 id="destination-heading">{t("Destinations")}</h2><Icon icon={HardDrive} size={19} /></div><div className="destination-panel"><div className="copy-policy">{configure ? <><label htmlFor="copy-policy">{t("Copy policy")}</label><div className="select-wrap"><select id="copy-policy" disabled={state.jobs.some(job => activePhases.includes(job.phase)) || !!state.review || !!state.busyReview} value={preferences.copyMode} onChange={event => act({ type: 'preferences', patch: { copyMode: event.target.value as CopyMode } })}><option value="single">{t("One destination")}</option><option value="mirror">{t("Copy to both destinations")}</option><option value="sequential" disabled={preferences.backupMode === 'mirror'}>{t("Fill first, then second")}</option></select><Icon icon={ChevronDown} size={15} /></div></> : <div className="copy-policy-summary"><strong>{t("Copy policy")}</strong><span>{{ single: t("One destination"), mirror: t("Copy to both destinations"), sequential: t("Fill first, then second") }[preferences.copyMode]}</span></div>}{configure && <p>{descriptions[preferences.copyMode]}</p>}{configure && preferences.backupMode === 'mirror' && <small>{t("Not available with Mirror.")}</small>}</div>{Array.from({ length: preferences.copyMode === 'single' ? 1 : 2 }, (_, index) => {
    const path = preferences.destinations[index];
    const status = state.destinationStatus?.find(item => item.path === path);
    const busy = state.jobs.some(job => activePhases.includes(job.phase)) || !!state.review || !!state.busyReview;
    return <section className="destination-slot" key={index}><div className="destination-slot-label"><span className="destination-number">{index + 1}</span><span>{index === 0 ? t("First destination") : t("Second destination")}</span><span className={`connection-dot ${path && status?.available !== false ? 'connected' : ''}`} aria-label={!path ? t("Not selected") : status?.available === false ? t("Offline") : t("Selected")} /></div><div className="destination-drive"><Icon icon={HardDrive} size={30} /><h3>{path ? filename(path) || path : t("Choose a backup drive")}</h3></div>{path ? <p className="destination-path" title={path}>{path}{preferences.basePath ? ` / ${preferences.basePath}` : ''}</p> : <p className="destination-path">{t("A drive or folder for your verified copies.")}</p>}{path && <><CapacityBar total={status?.total} free={status?.free} unavailable={status?.available === false ? t("Drive offline") : t("Reading drive capacity…")} /><div className={`destination-health ${status?.available === false ? 'offline' : ''}`}><Icon icon={status?.available === false ? CircleAlert : CheckCircle2} size={13} /><span>{status?.available === false ? t("Reconnect this drive before importing.") : status?.available ? t("Destination available") : t("Checking destination…")}</span></div></>}{path && state.misplacedProgress?.[path] && <PlanningProgress progress={state.misplacedProgress[path]} label={t("Checking the backup folder")} />}{path && (preferences.autoOrganizeBackup ?? 'ask') !== 'off' && (state.misplacedFiles?.[path]?.count ?? 0) > 0 && <div className="destination-misplaced" data-testid="destination-misplaced"><Icon icon={CircleAlert} size={13} /><span>{misplacedText(state.misplacedFiles![path].count, t, formatNumber)}</span><Button kind="quiet" icon={FolderCog} disabled={busy || state.jobs.some(job => job.organization && (activePhases.includes(job.phase) || job.phase === 'queued'))} onClick={() => act({ type: 'organizeBackup', destinationIndex: index })}>{t("Organize")}</Button></div>}<div className="destination-buttons">{configure && <Button icon={path ? FolderOpen : Plus} kind={path ? 'secondary' : 'primary'} disabled={busy} onClick={() => act({ type: 'chooseDestination', index })}>{path ? t("Change…") : t("Choose location…")}</Button>}{path && <Button kind="quiet" icon={ExternalLink} aria-label={t(index === 0 ? "Show first destination in file manager" : "Show second destination in file manager")} title={t("Show in file manager")} onClick={() => act({ type: 'reveal', path })} />}</div>{configure && index === 1 && path && <Button kind="quiet" icon={Trash2} className="remove-destination" disabled={busy} onClick={() => act({ type: 'removeDestination', index })}>{t("Remove destination")}</Button>}</section>;
  })}</div>{(onSettings || onOrganization) && <div className="bay-actions">{onSettings && <Button icon={Settings2} onClick={onSettings}>{t("Settings")}</Button>}{onOrganization && <Button icon={FolderCog} onClick={onOrganization}>{t("Folder organization")}</Button>}</div>}</aside>;
}

export const InventoryPanel = memo(function InventoryPanel({ inventory, sourceName, backup, inspect, act }: { inventory: Inventory; sourceName: string; backup: boolean; inspect: (path: string) => void; act: Dispatch }) {
  const { t, formatNumber, formatBytes: bytes } = useTranslation();
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [rulesOpen, setRulesOpen] = useState(false);
  const visible = useMemo(() => inventory.files.filter(file => (filter === 'all' || filter === 'included' && file.included || file.kind === filter) && file.relative.toLowerCase().includes(query.toLowerCase())), [inventory, filter, query]);
  const kinds = useMemo(() => [...new Set(inventory.files.map(file => file.kind))], [inventory]);
  return <section className="inventory-panel"><CardHeader icon={Files} title={backup ? t("Folder backup inventory") : t("Source inventory")} detail={sourceName}><span className="card-meta">{bytes(inventory.bytes)}</span></CardHeader><div className="inventory-summary"><span><Icon icon={FileImage} size={15} />{t("{count} photos & videos", { count: formatNumber(inventory.media) })}</span><span><Icon icon={Layers3} size={15} />{t("{count} companions", { count: formatNumber(inventory.companions) })}</span>{inventory.unknown > 0 && <button type="button" onClick={() => setRulesOpen(value => !value)} aria-expanded={rulesOpen}><Icon icon={FileQuestion} size={15} />{t("{count} other files", { count: inventory.unknown })}<Icon icon={Settings2} size={14} /></button>}</div>{rulesOpen && <UnknownRules extensions={inventory.unknownExtensions} act={act} />}
    <div className="inventory-toolbar"><div className="select-wrap"><select aria-label={t("Filter inventory files")} value={filter} onChange={event => setFilter(event.target.value)}><option value="all">{t("All files")}</option><option value="included">{t("Included files")}</option>{kinds.map(kind => <option key={kind} value={kind}>{t(kind)}</option>)}</select><Icon icon={ChevronDown} size={14} /></div><input type="search" aria-label={t("Search inventory files")} placeholder={t("Find a file…")} value={query} onChange={event => setQuery(event.target.value)} /><span>{t("{count} files", { count: formatNumber(visible.length) })}</span></div>
    <div className="file-table-scroll"><table className="file-table"><thead><tr><th scope="col">{t("File")}</th><th scope="col">{t("Type")}</th><th scope="col">{t("Size")}</th><th scope="col">{t("Import")}</th></tr></thead><tbody>{visible.slice(0, 500).map(file => <tr key={file.path}><td><button className="file-preview-button" type="button" onClick={() => inspect(file.path)} title={t("Show metadata for {name}", { name: file.relative })}><Icon icon={file.kind === 'Other' ? Files : FileImage} size={15} /><span>{file.relative}</span></button>{file.companionOf && <span className="companion-label">{t("Companion to {name}", { name: filename(file.companionOf) })}</span>}</td><td>{t(file.kind)}</td><td>{bytes(file.size)}</td><td><span className={`file-inclusion ${file.included ? 'included' : ''}`}><Icon icon={file.included ? Check : Pause} size={13} />{file.included ? t("Included") : t("Ignored")}</span></td></tr>)}</tbody></table>{visible.length === 0 && <p className="table-empty">{t("No files match this filter.")}</p>}</div>{visible.length > 500 && <p className="inline-note">{t("Showing 500 matches. Search to narrow.")}</p>}</section>;
});

export function UnknownFilesPrompt({ sourceName, inventory, knownRules = {}, act }: { sourceName: string; inventory: Inventory; knownRules?: Preferences['unknownRules']; act: Dispatch }) {
  const { t, formatNumber } = useTranslation();
  const unresolved = Object.fromEntries(Object.entries(inventory.unknownExtensions).filter(([extension]) => !Object.hasOwn(knownRules, extension)));
  const signature = useMemo(() => JSON.stringify(inventory.files.filter(file => file.kind === 'Other' && !file.companionOf).map(file => [file.path, file.size])), [inventory]);
  const [dismissed, setDismissed] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const [remember, setRemember] = useState(true);
  if (!inventory.unknown || !Object.keys(unresolved).length || dismissed === signature) return null;
  return <section className="unknown-rules" aria-label={t("Unknown file formats")} data-testid="unknown-files-prompt"><h3>{t("Unknown file formats")}</h3><p>{t("{name}: {count} unknown files skipped.", { name: sourceName, count: formatNumber(Object.values(unresolved).reduce((sum, count) => sum + count, 0)) })}</p><div className="rule-actions"><Button icon={Check} onClick={() => { for (const extension of Object.keys(unresolved)) act({ type: 'unknownRule', extension, folder: null, remember }); setDismissed(signature); }}>{t("Keep unknown files excluded")}</Button><Button icon={Camera} onClick={() => { for (const extension of Object.keys(unresolved)) act({ type: 'unknownRule', extension, folder: { action: 'camera' }, remember }); setDismissed(signature); }}>{t("Copy to camera folders")}</Button><Button kind="quiet" icon={Settings2} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{t("Other file rules")}</Button></div><label className="checkbox-label"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />{t("Remember for these extensions")}</label>{expanded && <UnknownRules extensions={unresolved} act={act} />}</section>;
}

function UnknownRules({ extensions, act }: { extensions: Record<string, number>; act: Dispatch }) {
  const { t } = useTranslation();
  const choices = Object.keys(extensions).sort();
  const [extension, setExtension] = useState(choices[0] ?? '');
  const [action, setAction] = useState<'ignore' | 'copy' | 'camera'>('ignore');
  const [folder, setFolder] = useState('Other files');
  const [remember, setRemember] = useState(true);
  const valid = !!folder.trim() && !folder.startsWith('/') && !folder.includes('\\') && !folder.includes(':') && folder.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.trim() === part);
  return <div className="unknown-rules"><h3>{t("Other file rules")}</h3><div className="rule-fields"><label>{t("Extension")}<div className="select-wrap"><select value={extension} onChange={event => { setExtension(event.target.value); }}>{choices.map(ext => <option key={ext} value={ext}>{ext ? `.${ext}` : t("No extension")} ({extensions[ext]})</option>)}</select><Icon icon={ChevronDown} size={14} /></div></label><label>{t("Action")}<div className="select-wrap"><select value={action} onChange={event => { setAction(event.target.value as typeof action); }}><option value="ignore">{t("Ignore")}</option><option value="camera">{t("Copy to camera folders")}</option><option value="copy">{t("Copy to folder")}</option></select><Icon icon={ChevronDown} size={14} /></div></label></div>{action === 'copy' && <label className="field-label">{t("Folder beneath each destination")}<input value={folder} onChange={event => { setFolder(event.target.value); }} placeholder="Documents/Camera notes" />{!valid && <span className="field-error">{t("Use a relative folder without empty components, . or ..")}</span>}</label>}<div className="rule-actions"><label className="checkbox-label"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />{t("Remember for this extension")}</label><Button icon={Check} disabled={action === 'copy' && !valid} onClick={() => { act({ type: 'unknownRule', extension, folder: action === 'camera' ? { action: 'camera' } : action === 'copy' ? folder : null, remember }); }}>{t("Apply rule")}</Button></div></div>;
}

function CardHeader({ icon, title, id, detail, children }: { icon: LucideIcon; title: string; id?: string; detail?: ReactNode; children?: ReactNode }) {
  return <div className="card-header"><span className="card-icon"><Icon icon={icon} size={17} /></span><div className="card-title"><h3 id={id}>{title}</h3>{detail && <p>{detail}</p>}</div>{children && <div className="card-actions">{children}</div>}</div>;
}
function SettingsSection({ title, icon, children }: { title: string; icon: LucideIcon; children: ReactNode }) {
  return <section className="settings-section"><CardHeader icon={icon} title={title} /><div className="settings-section-content">{children}</div></section>;
}
function TextPreference({ label, value, onSave, placeholder, description }: { label: string; value: string; onSave: (value: string) => void; placeholder?: string; description?: string }) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  return <div className="field-label"><label className="field-label">{label}<input value={draft} placeholder={placeholder} onFocus={() => { focused.current = true; }} onChange={event => setDraft(event.target.value)} onBlur={event => { focused.current = false; const next=event.currentTarget.value; setDraft(next); if (next !== value) onSave(next); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>{description && <small>{description}</small>}</div>;
}
function misplacedText(count: number, t: ReturnType<typeof createTranslator>, formatNumber: (value: number) => string): string {
  return count === 1 ? t("1 file outside your folder structure") : t("{count} files outside your folder structure", { count: formatNumber(count) });
}
// Finds files placed outside the folder structure inside the backup folder and moves them into place.
function BackupCheck({ state, act, busy, organizeBusy, destinationIndex }: { state: AppState; act: Dispatch; busy: boolean; organizeBusy: boolean; destinationIndex: number }) {
  const { t, formatNumber, formatBytes } = useTranslation();
  const mode = state.preferences.autoOrganizeBackup ?? 'ask';
  const destination = state.preferences.destinations[destinationIndex];
  const found = mode === 'off' ? undefined : state.misplacedFiles?.[destination];
  const misplaced = !!found && found.count > 0;
  const modes: { value: AutoOrganizeBackup; label: string }[] = [{ value: 'off', label: t("Off") }, { value: 'ask', label: t("Ask") }, { value: 'auto', label: t("Automatic") }];
  return <section className="organization-action backup-check" aria-labelledby="backup-check-heading" data-testid="backup-check"><CardHeader icon={FolderCog} id="backup-check-heading" title={t("Backup folder")} detail={mode === 'auto' ? t("Misplaced files are moved into place after each import.") : mode === 'ask' ? t("Checked after each import. You choose when to move files.") : t("Not checked automatically.")}><Button kind={misplaced ? 'primary' : 'secondary'} icon={FolderCog} disabled={organizeBusy} onClick={() => act({ type: 'organizeBackup', destinationIndex })}>{t("Organize backup")}</Button></CardHeader>
    <div className="segmented" role="group" aria-label={t("Check the backup folder")}>{modes.map(item => <button key={item.value} type="button" aria-pressed={mode === item.value} disabled={busy} onClick={() => act({ type: 'preferences', patch: { autoOrganizeBackup: item.value } })}>{item.label}</button>)}</div>
    {found && (misplaced ? <p className="misplaced-files" data-testid="misplaced-files" role="status"><Icon icon={CircleAlert} size={15} /><span>{misplacedText(found.count, t, formatNumber)} · {formatBytes(found.bytes)}</span></p> : <p className="misplaced-files is-clean" role="status"><Icon icon={CheckCircle2} size={15} /><span>{t("Backup folder is in order.")}</span></p>)}
  </section>;
}
export function Organization({ state, act, busy, selectedDestination = 0, onSelectDestination = () => {} }: { state: AppState; act: Dispatch; busy: boolean; selectedDestination?: number; onSelectDestination?: (index: number) => void }) {
  const { t, formatNumber } = useTranslation();
  const p = state.preferences;
  const destinationIndex = organizationDestinationIndex(p, selectedDestination);
  const destination = p.destinations[destinationIndex];
  const selectedFolders = destination ? state.organizationFolders?.[destination] : undefined;
  const targetFolder = destination ? [destination.replace(/[\\/]$/, ''), p.basePath].filter(Boolean).join('/') : '';
  const recovery = state.organizationRecovery ?? [];
  const runningOrganization = state.jobs.find(job => job.organization && (activePhases.includes(job.phase) || job.phase === 'queued'));
  const organizing = organizeBusy(state);
  return <div className="organization-page">
    {/* Two independent stacks: a card's height never moves the cards in the other column. */}
    <div className="organization-column">
    {runningOrganization && <section className="organization-action organization-running" aria-labelledby="organization-running-heading"><CardHeader icon={LoaderCircle} id="organization-running-heading" title={t("Organizing now")} detail={organizationPlace(runningOrganization, true)} /><OrganizationProgress job={runningOrganization} act={act} /></section>}
    <section className="organization-action" aria-labelledby="organize-existing-heading"><CardHeader icon={FolderCog} id="organize-existing-heading" title={t("Existing files, new structure")} detail={t("Move existing files into your folder structure.")}><Button icon={Eye} disabled={busy || !destination} onClick={() => act({ type: 'previewOrganization', destinationIndex })}>{t("Review changes…")}</Button><Button kind="primary" icon={FolderCog} disabled={organizing || !destination} onClick={() => act({ type: 'organize', destinationIndex })}>{t("Organize now")}</Button></CardHeader>{p.destinations.length > 1 && <label className="organization-destination-select">{t("Destination")}<select aria-label={t("Organization destination")} disabled={busy} value={destinationIndex} onChange={event => { const index = Number(event.target.value); animateInterfaceChange(() => onSelectDestination(index)); }}>{p.destinations.map((path,index) => <option key={path} value={index}>{path}</option>)}</select></label>}{destination ? <dl className="organization-paths"><div><dt>{t("Scan existing files in")}</dt><dd>{destination}</dd></div><div><dt>{t("New structure under")}</dt><dd>{targetFolder}</dd></div></dl> : <p className="inline-note">{t("Choose a backup location in Settings to begin.")}</p>}<div className="organization-option" data-testid="remove-empty-folders"><Switch checked={p.removeEmptySourceFolders !== false} disabled={busy} onChange={removeEmptySourceFolders => act({ type: 'preferences', patch: { removeEmptySourceFolders } })} label={t("Remove emptied source folders")} detail={t("Folders left empty after organizing are removed. Folders with files are kept.")} /></div>{destination && <div className="organization-scope"><div className="rule-actions"><Button icon={FolderOpen} disabled={busy} onClick={() => act({ type: 'chooseOrganizationFolders', destinationIndex })}>{t("Choose folders…")}</Button>{selectedFolders && <Button kind="quiet" disabled={busy} onClick={() => act({ type: 'resetOrganizationFolders', destinationIndex })}>{t("Use whole destination")}</Button>}</div><p>{selectedFolders ? t("Only the selected folders will be scanned.") : t("All folders on this destination will be scanned.")}</p>{selectedFolders && <ul aria-label={t("Selected organization folders")}>{selectedFolders.map(folder => <li key={folder}>{folder}</li>)}</ul>}</div>}</section>
    <section className="organization-action" aria-labelledby="organize-folder-heading" data-testid="organize-folder"><CardHeader icon={FolderOpen} id="organize-folder-heading" title={t("Organize a folder")} detail={t("Sorts a folder's files into your folder structure, inside that folder.")}><Button icon={FolderOpen} disabled={organizing} onClick={() => act({ type: 'organizeFolder' })}>{t("Choose folder…")}</Button></CardHeader></section>
    {state.busyReview && <div role="status" aria-live="polite"><p className="notice"><Icon icon={LoaderCircle} />{state.reviewProgress ? t("Checking organization files: {count} · {file}", { count: formatNumber(state.reviewProgress.completed), file: state.reviewProgress.file }) : t("Preparing organization review…")}</p>{state.reviewProgress && <PlanningProgress progress={state.reviewProgress} label={t("Organization review progress")} />}</div>}
    </div>
    <div className="organization-column">
    {destination && <BackupCheck state={state} act={act} busy={busy} organizeBusy={organizing} destinationIndex={destinationIndex} />}
    <section className="organization-recovery" aria-labelledby="organization-recovery-heading"><CardHeader icon={RotateCcw} id="organization-recovery-heading" title={t("Organization recovery")}><Button icon={RefreshCw} disabled={busy} onClick={() => act({ type: 'refreshOrganization' })}>{t("Refresh list")}</Button></CardHeader>{recovery.length > 0 ? <div className="recovery-jobs">{recovery.map(job => <article className="recovery-job" key={`${job.root}-${job.id}`}><div className="recovery-job-heading"><span className={`source-status ${job.status === 'complete' ? 'complete' : 'queued'}`}><Icon icon={job.status === 'complete' ? CheckCircle2 : Clock3} size={15} />{job.status === 'complete' ? t("Last completed") : t("Needs recovery")}</span><Button icon={job.status === 'complete' ? RefreshCw : Play} disabled={busy} onClick={() => act({ type: 'resumeOrganization', id: job.id, root: job.root })}>{job.status === 'complete' ? t("Recheck") : t("Resume & recheck")}</Button>{job.status === 'complete' && <Button kind="quiet" disabled={busy} title={t("Reads every organized file again, not only those changed since the last recheck.")} onClick={() => act({ type: 'resumeOrganization', id: job.id, root: job.root, full: true })}>{t("Full recheck")}</Button>}</div><p className="recovery-root">{job.root}</p><p className="recovery-count">{t("Last verified: {completed} of {total} files", { completed: formatNumber(job.completed), total: formatNumber(job.files) })}</p><RetainedOriginals job={job} act={act} busy={busy} /></article>)}</div> : <p className="recovery-empty">{state.organizationRecoveryLoading ? t("Reading organization history…") : t("No organization history.")}</p>}</section>
    </div>

  </div>;
}

// Unknown file formats: the default, saved rules, and an editor for one extension's rule.
function FileRules({ preferences: p, act }: { preferences: Preferences; act: Dispatch }) {
  const { t } = useTranslation();
  const [ruleExtension, setRuleExtension] = useState('');
  const [ruleFolder, setRuleFolder] = useState('Other files');
  const [ruleAction, setRuleAction] = useState<'ignore' | 'copy' | 'camera'>('ignore');
  const extensionValid = /^[a-zA-Z0-9_-]*$/.test(ruleExtension.replace(/^\./, ''));
  const folderValid = ruleFolder.length > 0 && !ruleFolder.startsWith('/') && !/[\\:\x00-\x1f]/.test(ruleFolder) && ruleFolder.split('/').every(part => part && part !== '.' && part !== '..' && part.trim() === part);
  function saveRule() { act({ type: 'unknownRule', extension: ruleExtension.replace(/^\./, '').toLowerCase(), folder: ruleAction === 'camera' ? { action: 'camera' } : ruleAction === 'copy' ? ruleFolder : null, remember: true }); }
  return <><UnknownDefaultControl preferences={p} act={act} />{Object.keys(p.unknownRules).length > 0 ? <div className="saved-rules">{Object.entries(p.unknownRules).map(([extension, folder]) => <div key={extension}><span className="extension-name">{extension ? `.${extension}` : t("No extension")}</span><span>{folder === null ? t("Ignore") : typeof folder === 'string' ? t("Copy to {folder}", { folder }) : t("Copy to camera folders")}</span><Button kind="quiet" icon={Settings2} aria-label={t("Edit rule for {extension}", { extension: extension || t("files without an extension") })} onClick={() => { setRuleExtension(extension); setRuleFolder(typeof folder === 'string' ? folder : 'Other files'); setRuleAction(folder === null ? 'ignore' : typeof folder === 'string' ? 'copy' : 'camera'); }}>{t("Edit")}</Button></div>)}</div> : <p className="muted">{t("No saved rules.")}</p>}<div className="rule-editor"><div className="rule-fields"><label className="field-label">{t("File extension")}<input value={ruleExtension} onChange={event => setRuleExtension(event.target.value)} placeholder={t("For example, PDF")} /><small>{t("Leave empty for files without an extension.")}</small></label><label className="field-label">{t("Action")}<div className="select-wrap"><select value={ruleAction} onChange={event => setRuleAction(event.target.value as typeof ruleAction)}><option value="camera">{t("Copy to camera folders")}</option><option value="copy">{t("Copy to custom folder")}</option><option value="ignore">{t("Ignore")}</option></select><Icon icon={ChevronDown} size={14} /></div></label></div>{ruleAction === 'copy' && <label className="field-label">{t("Relative folder")}<input value={ruleFolder} onChange={event => setRuleFolder(event.target.value)} placeholder="Documents/Camera notes" />{!folderValid && <span className="field-error">{t("Use a relative folder without empty components, . or ..")}</span>}</label>}<div className="rule-actions"><Button icon={Check} disabled={!extensionValid || ruleAction === 'copy' && !folderValid} onClick={saveRule}>{t("Save rule")}</Button></div></div></>;
}

// Folder structure, photo/video layout, where the next files land, and the edited exports folder.
function FolderSettings({ state, act }: { state: AppState; act: Dispatch }) {
  const { t } = useTranslation();
  const p = state.preferences;
  const folders = (folder: string) => folder.split(/[\\/]/).filter(Boolean), videoRoot = p.mediaLayout === 'video-root';
  const editedFolder = p.editedFolder ?? 'editied';
  return <div className="folder-settings" data-testid="folder-settings">
      <SettingsSection title={t("Folder structure")} icon={FolderCog}>
        {videoRoot && <h4 className="path-builder-heading">{t("Photo folders")}</h4>}
        <FolderPathBuilder template={p.template} onChange={template => act({ type: 'preferences', patch: { template } })} testId="photo-path-builder" />
        <h4 className="path-builder-heading">{t("Then sort by file type")}</h4>
        <div className="preset-grid" role="radiogroup" aria-label={t("Media layout")}>{mediaLayouts.map(layout => <button type="button" role="radio" key={layout.value} className={`preset ${p.mediaLayout === layout.value ? 'selected' : ''}`} aria-checked={p.mediaLayout === layout.value} onClick={() => act({ type: 'preferences', patch: { mediaLayout: layout.value } })}><span className="preset-radio">{p.mediaLayout === layout.value && <span />}</span><span><strong>{t(layout.title)}</strong><small>{t(layout.detail)}</small></span></button>)}</div>
        {videoRoot && <><h4 className="path-builder-heading">{t("Video folders")}</h4><TextPreference label={t("Video backup folder")} value={p.videoBasePath} placeholder="videobackup" onSave={videoBasePath => act({ type: 'preferences', patch: { videoBasePath } })} description={t("Created beside the photo backup folder on each destination.")} /><Switch checked={!p.videoTemplate} onChange={same => act({ type: 'preferences', patch: { videoTemplate: same ? '' : p.template } })} label={t("Use the photo folder path for videos")} />{!!p.videoTemplate && <FolderPathBuilder template={p.videoTemplate} onChange={videoTemplate => act({ type: 'preferences', patch: { videoTemplate } })} testId="video-path-builder" />}</>}
        <PathPreview label={t("Your next photo lands here")} parts={[...folders(p.basePath), ...samplePath(p.template), ...layoutFolders(p.mediaLayout, false, 'NEF'), 'DSC_0001.NEF']} testId="photo-preview" />
        <PathPreview label={t("Your next video lands here")} parts={[...folders(videoRoot ? p.videoBasePath : p.basePath), ...samplePath(videoRoot && p.videoTemplate ? p.videoTemplate : p.template), ...layoutFolders(p.mediaLayout, true, 'MOV'), 'DSC_0002.MOV']} testId="video-preview" />
        <details className="path-advanced" data-testid="custom-template"><summary>{t("Advanced: custom template")}</summary>
          <TextPreference label={t(videoRoot ? "Photo folder template" : "Folder template")} value={p.template} onSave={template => template && act({ type: 'preferences', patch: { template } })} description={t("Available tokens: {year}, {yyyymm}, {month}, {monthName}, {yearMonthName}, {day}, {yyyyMMdd}, {camera}")} />
          {videoRoot && !!p.videoTemplate && <TextPreference label={t("Video folder template")} value={p.videoTemplate} onSave={videoTemplate => videoTemplate && act({ type: 'preferences', patch: { videoTemplate } })} description={t("Available tokens: {year}, {yyyymm}, {month}, {monthName}, {yearMonthName}, {day}, {yyyyMMdd}, {camera}")} />}
        </details>
      </SettingsSection>
      <SettingsSection title={t("Edited exports folder")} icon={Folder}>
        <TextPreference label={t("Edited exports folder")} value={editedFolder} placeholder="editied" onSave={editedFolder => act({type:'preferences',patch:{editedFolder}})} description={t("Edited exports go here, inside each month folder.")} />
        <PathPreview label={t("Your edited export lands here")} parts={[...folders(p.basePath),'2026','202610',editedFolder,'Nikon Z6III','DSC_0001.jpg']} testId="edited-export-preview" />
      </SettingsSection>
  </div>;
}

function HistoryPage({ state, onDesk }: { state: AppState; onDesk: () => void }) {
  const { t, language } = useTranslation();
  return <div className="history-page"><div className="page-toolbar"><span className="session-count">{t("{count} sessions", { count: state.history.length })}</span></div>{state.history.length === 0 ? <div className="history-empty"><div><Icon icon={History} size={38} /></div><h3>{t("Your collection starts here.")}</h3><p>{t("Finished imports appear here.")}</p><Button kind="primary" icon={ArrowDownToLine} onClick={onDesk}>{t("Go to import desk")}</Button></div> : <ol className="history-timeline">{state.history.map(record => {
    const title = formatMessage(record.title, 'en'), detail = formatMessage(record.detail, 'en');
    const attention = /attention|error|fail/i.test(title) || /\b[1-9][\d,]* errors?\b/i.test(detail);
    const stopped = /stop|cancel/i.test(title + ' ' + detail);
    const date = new Date(record.date);
    return <li key={record.id} className={attention ? 'history-attention' : stopped ? 'history-stopped' : ''}><span className="timeline-glyph"><Icon icon={attention ? CircleAlert : stopped ? Pause : CheckCircle2} size={21} /></span><article><div className="history-record-heading"><h3>{t(record.title)}</h3><time dateTime={record.date}>{Number.isNaN(date.valueOf()) ? record.date : new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)}</time></div><p>{t(record.detail)}</p><span className="history-record-state"><Icon icon={attention ? CircleAlert : stopped ? Pause : ShieldCheck} size={13} />{attention ? t("Needs attention") : stopped ? t("Stopped by user") : t("Session recorded")}</span></article></li>;
  })}</ol>}</div>;
}

function metadataText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}
export function MetadataDialog({ preview, onClose, act }: { preview: Preview; onClose: () => void; act: Dispatch }) {
  const { t, formatNumber, language } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useAnimatedClose(dialog,onClose);
  const [query, setQuery] = useState('');
  useEffect(() => { const element = dialog.current; showSheet(element); return () => element?.close(); }, []);
  useEffect(() => { setQuery(''); }, [preview.path]);
  const metadata = preview.metadata;
  const video = mediaKindForPath(preview.path) === 'Videos';
  const captured = formatCaptureDateTime(metadata?.date, language);
  const exposure = formatExposure(metadata?.exposure, language);
  const fields = Object.entries(metadata?.fields ?? {}).filter(([key, value]) => key.split(':').at(-1)!=='Error' && `${key} ${metadataText(value)}`.toLowerCase().includes(query.toLowerCase()));
  return <dialog className="metadata-dialog" ref={dialog} aria-labelledby="metadata-heading" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="dialog-heading"><div><span className="dialog-kicker"><Icon icon={FileImage} size={15} />{t("File metadata")}</span><h2 id="metadata-heading">{filename(preview.path)}</h2></div><Button kind="quiet" icon={X} data-testid="metadata-close" aria-label={t("Close metadata")} onClick={close} /></div>
    <div className="metadata-content">
      <section className="metadata-inspector" aria-label={t("Capture information")}>
        <div className="metadata-file"><span title={preview.path}>{preview.path}</span><Button kind="quiet" icon={ExternalLink} aria-label={t("Show this file in file manager")} onClick={() => act({ type: 'reveal', path: preview.path })} /></div>
        {preview.loading && <p className="metadata-status" aria-live="polite"><Icon icon={LoaderCircle} size={15} />{t("Reading photo metadata…")}</p>}
        {preview.error && <p className="metadata-status metadata-status-error"><Icon icon={CircleAlert} size={15} />{t("Could not read this file")} · {t("See All errors for details.")}</p>}
        <dl className="capture-summary"><div className="capture-camera"><dt><Icon icon={Camera} size={17} />{t("Camera")}</dt><dd>{metadata?.camera || t("Not recorded")}</dd></div>
          <div><dt>{t("Capture date")}</dt><dd>{captured.date || t("Not recorded")}</dd></div>
          <div><dt>{t("Capture time")}</dt><dd data-testid="metadata-capture-time">{captured.time || t("Not recorded")}</dd></div>
          <div className="capture-timezone"><dt>{t("Time zone")}</dt><dd data-testid="metadata-timezone">{captured.timezone || t("Not recorded")}</dd></div>
        </dl>
        <section className="exposure-summary" data-testid="metadata-exposure" aria-labelledby="exposure-heading"><h3 id="exposure-heading">{t("Exposure settings")}</h3><dl>
          <div className="exposure-lens"><dt>{t("Lens")}</dt><dd>{exposure.lens || t("Not recorded")}</dd></div>
          <div><dt>{t("Aperture")}</dt><dd>{exposure.aperture || t("Not recorded")}</dd></div>
          <div><dt>{t("ISO")}</dt><dd>{exposure.iso || t("Not recorded")}</dd></div>
          <div><dt>{t("Shutter speed")}</dt><dd>{exposure.shutterSpeed || t("Not recorded")}</dd></div>
          <div><dt>{t("Focal length")}</dt><dd>{exposure.focalLength || t("Not recorded")}</dd></div>
          <div><dt>{t("Exposure compensation")}</dt><dd>{exposure.exposureCompensation || t("Not recorded")}</dd></div>
        </dl></section>
        {!video && <section className="capture-shutter"><dl><div><dt>{t("Shutter count")}</dt><dd data-testid="metadata-shutter-count">{metadata?.shutterCount || t("Not available")}</dd></div></dl></section>}
        <details className="metadata-details" key={preview.path} data-testid="metadata-details"><summary><Icon icon={ChevronDown} size={17} /><span>{t("All metadata")}</span><small>{t("{count} fields", { count: formatNumber(Object.keys(metadata?.fields ?? {}).length) })}</small></summary><div className="metadata-details-content">
          {!video && metadata?.shutterNote && <p className="shutter-note"><Icon icon={Info} size={14} />{metadata.shutterNote}</p>}
          <input type="search" placeholder={t("Find a metadata field…")} aria-label={t("Search metadata fields")} value={query} onChange={event => setQuery(event.target.value)} />
          <dl className="metadata-fields">{fields.map(([key, value]) => <div key={key}><dt>{key.replace(/([a-z])([A-Z])/g, '$1 $2')}</dt><dd>{metadataText(value)}</dd></div>)}</dl>
          {!preview.loading && fields.length === 0 && <p className="metadata-empty">{query ? t("No metadata fields match your search.") : t("No metadata fields were returned for this file.")}</p>}
        </div></details>
      </section>
    </div>
    <div className="dialog-footer"><Button onClick={close}>{t("Done")}</Button></div>
  </dialog>;
}

export function MirrorRemovals({ review }: { review: NonNullable<AppState['review']> }) {
  const { t, formatNumber, formatBytes: bytes } = useTranslation();
  const plans = review.plans.map((plan, index) => ({ plan, index, removals: plan.removals ?? [] })).filter(item => item.removals.length);
  if (!plans.length) return null;
  const all = plans.flatMap(item => item.removals);
  return <section className="mirror-removals" data-testid="mirror-removals" aria-labelledby="mirror-removals-heading">
    <div className="mirror-removals-heading"><h3 id="mirror-removals-heading">{t("{count} files will be moved to Removed by mirror", { count: formatNumber(all.length) })}</h3><span>{bytes(all.reduce((sum, item) => sum + item.size, 0))}</span></div>
    <p>{t("Nothing is deleted; files go to Removed by mirror.")}</p>
    {plans.map(({ plan, index, removals }) => <div key={`${index}-${plan.root}`} className="mirror-removals-plan">
      {(review.plans.length > 1 || plan.drive) && <h4>{review.plans.length > 1 ? t("Destination {count}: ", { count: index + 1 }) : ''}{plan.drive ? t("Drive folder: {folder}", { folder: plan.drive.folder }) : plan.root}</h4>}
      <div className="review-table-scroll"><table className="review-table"><thead><tr><th scope="col">{t("File")}</th><th scope="col">{t("Reason")}</th><th scope="col">{t("Size")}</th></tr></thead><tbody>{removals.map(removal => <tr key={removal.path}><td><span className="review-destination-path">{removal.path}</span></td><td><span className={`removal-reason removal-${removal.reason}`}>{removal.reason === 'missing' ? t("No longer on the drive") : t("Replaced by a newer version")}</span></td><td>{bytes(removal.size)}</td></tr>)}</tbody></table></div>
    </div>)}
  </section>;
}

function ReviewPanel({ state, act, inspect }: { state: AppState; act: Dispatch; inspect: (path: string) => void }) {
  const { t, formatNumber, formatBytes: bytes } = useTranslation();
  const review = state.review;
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  useEffect(() => { setQuery(''); setPage(0); }, [review?.id]);
  const entries = useMemo(() => review?.plans.flatMap((plan, destinationIndex) => [...plan.entries, ...plan.videos?.entries ?? []].map(entry => ({ ...entry, destinationIndex }))) ?? [], [review]);
  const changed = useMemo(() => entries.filter(entry => !entry.skip), [entries]);
  const visible = useMemo(() => entries.filter(entry => `${entry.source} ${entry.destination} ${entry.kind} ${entry.digest ?? ''}`.toLowerCase().includes(query.toLowerCase())), [entries, query]);
  if (!review) return <section className="review-panel review-loading" aria-live="polite"><Icon icon={ScanLine} size={24} /><div><h2>{t("Building your file review…")}</h2><p>{t("Checking files. Nothing is copied yet.")}</p>{state.reviewProgress && <PlanningProgress progress={state.reviewProgress} label={t("Review progress")} />}</div><Button onClick={() => act({ type: 'discardReview' })}>{t("Cancel review")}</Button></section>;
  const verified = entries.length - changed.length;
  const pageSize = 100;
  const lastPage = Math.max(0, Math.ceil(visible.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  return <section className="review-panel" aria-labelledby="review-heading"><div className="review-heading"><div><span className="review-kicker"><Icon icon={Eye} size={16} />{t(review.kind === 'reorganize' ? "Review before reorganizing" : "Review before copying")}</span><h2 id="review-heading">{review.kind === 'reorganize' ? t("Review your new folder structure") : t("{name}: import preview", { name: review.source.name })}</h2><p>{review.kind === 'reorganize' ? t("Nothing moves until you apply.") : t("Copying starts when you apply.")}</p></div><span className="status-pill"><Icon icon={CheckCircle2} size={14} />{t("Ready to review")}</span></div><div className="review-summary"><span>{t(review.kind === 'reorganize' ? "{count} files to organize" : "{count} copies to write", { count: formatNumber(changed.length) })}</span><span>{t("{count} already verified", { count: formatNumber(verified) })}</span><span>{t(review.kind === 'reorganize' ? "{size} to organize" : "{size} to copy", { size: bytes(changed.reduce((sum, entry) => sum + entry.size, 0)) })}</span>{review.backup && <span className="small-tag">{t("Folder backup")}</span>}</div><div className="review-destinations">{review.plans.map((plan, index) => <div key={`${index}-${plan.root}`}><Icon icon={HardDrive} size={14} /><span>{review.plans.length > 1 ? t("Destination {count}: ", { count: index + 1 }) : ''}{[plan.root, ...(plan.videos ? [plan.videos.root] : [])].join(' · ')}</span></div>)}</div><MirrorRemovals review={review} /><div className="review-toolbar"><label><Icon icon={Files} size={15} /><span>{t("{count} files", { count: formatNumber(visible.length) })}</span></label><input type="search" placeholder={t("Find a source, destination or checksum…")} aria-label={t("Search reviewed files")} value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></div><div className="review-table-scroll"><table className="review-table"><thead><tr><th scope="col">{review.kind === 'reorganize' ? t("Existing path") : t("Source")}</th><th scope="col">{review.kind === 'reorganize' ? t("New path") : t("Destination")}</th><th scope="col">{t("Type / size")}</th><th scope="col">{t("Action")}</th><th scope="col">{t("Checksum")}</th></tr></thead><tbody>{visible.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(entry => <tr key={`${entry.destinationIndex}-${entry.id}`}><td><button type="button" className="review-source-button" onClick={() => inspect(entry.source)} title={t("Show metadata for {name}", { name: filename(entry.source) })}><Icon icon={entry.kind === 'Other' ? Files : FileImage} size={14} /><span>{entry.source}</span></button></td><td><span className="review-destination-path">{entry.destination}</span></td><td><span>{t(entry.kind)}</span><small>{bytes(entry.size)}</small></td><td><span className={`file-inclusion ${entry.skip ? 'included' : ''}`}><Icon icon={entry.skip ? CheckCheck : review.kind === 'reorganize' ? ArrowRight : Copy} size={13} />{entry.skip ? t("Keep verified") : review.kind === 'reorganize' ? t("Organize") : t("Copy")}</span></td><td>{entry.digest ? <span className="review-checksum" title={entry.digest}>{entry.digest.slice(0, 12)}{entry.digest.length > 12 ? '…' : ''}</span> : <span className="review-checksum review-checksum-pending">{t("Computed during copy")}</span>}</td></tr>)}</tbody></table>{visible.length === 0 && <p className="table-empty">{entries.length === 0 ? t("No files need to be processed.") : t("No files match this search.")}</p>}</div>{visible.length > pageSize && <div className="review-pagination"><span>{t("Files {start}–{end} of {total}", { start: formatNumber(currentPage * pageSize + 1), end: formatNumber(Math.min((currentPage + 1) * pageSize, visible.length)), total: formatNumber(visible.length) })}</span><div><Button disabled={currentPage === 0} onClick={() => animateInterfaceChange(() => setPage(currentPage - 1))}>{t("Previous")}</Button><Button disabled={currentPage === lastPage} onClick={() => animateInterfaceChange(() => setPage(currentPage + 1))}>{t("Next")}</Button></div></div>}<div className="review-footer"><span><Icon icon={ShieldCheck} size={16} /></span><div><Button disabled={state.busyReview} onClick={() => act({ type: 'discardReview' })}>{t("Discard review")}</Button><Button kind="primary" icon={review.kind === 'reorganize' ? ArrowRight : Copy} disabled={state.busyReview || (entries.length === 0 && !review.plans.some(plan => plan.removals?.length))} onClick={() => act({ type: 'applyReview' })}>{review.kind === 'reorganize' ? t("Apply reviewed organization") : t("Copy reviewed files")}</Button></div></div></section>;
}
