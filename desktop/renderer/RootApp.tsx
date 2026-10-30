import { createPortal } from 'react-dom';
import {createStateReceiver} from '../state-channel';
import {driveName,pathOf,type Severity} from '../error-log';
import {buildRows,rowCounts,type ErrorRow} from '../error-groups';
import {errorTotal} from '../job-issues';
import {doneSources, ejectable, sourceInUse} from '../source-eject';
import { createTranslator, I18nProvider, useTranslation, localeNames, formatNumber as numberIn, formatSpeed } from './i18n';
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  ArrowDownToLine, ArrowRight, ArrowUpRight, Camera, Check, CheckCheck,
  CheckCircle2, ChevronDown, ChevronRight, ChevronUp, CircleAlert, Clock3, Copy,
  Eject, ExternalLink, Eye, FileImage, FileQuestion, Files, Folder, FolderCog, FolderOpen,
  Activity, EyeOff, FolderPlus, Gauge, HardDrive, History, Info, Laptop, Layers3,
  Circle, LayoutGrid, List, LoaderCircle, Maximize2, Minus, Moon, Pause, Play, Plus, Radio, RefreshCw, RotateCcw, ShieldOff,
  Save, ScanLine, Ellipsis, Settings2, ShieldCheck, Square, Sun, CopyCheck, ScanSearch, Trash2, Usb, X, ArrowUpToLine,
  type LucideIcon,
} from 'lucide-react';
import type { Accent, Action, AppState, Appearance, BackupMode, ConflictNaming, CopyMode, DestinationSpace, DriveActivity, DriveCameraRecord, Inventory, Job, Language, LogLevel, MediaLayout, Metadata, NoMetadataHandling, Preferences, Progress, Source, SourceCameraInfo } from '../shared';
import { basename, within } from './paths';
import { DEFAULT_TEXT_SCALE, isRunning, requiredDestinations } from '../shared';
import { filePath, formatMessage, message, text, type Message } from '../messages';
import { layoutFolders, mediaKindForPath } from '../media-formats';
import { buildTemplate, editedTemplate, expandTemplate, monthToken, parseTemplate, templateValues, type FolderPath } from '../folder-template';
import { formatCaptureDateTime, formatExposure, shutterNoteText } from './metadata-display';
import { sidebarFit } from './sidebar-fit';
import { DisplayHold } from '../eta-format';
import { settingsLocked } from '../settings-lock';
import { validNoMetadataFolder } from '../no-metadata';
import { DuplicatesPage, RemovedDuplicates } from './DuplicatesPage';
import { CleanupConfirmation } from './CleanupConfirmation';
import { Button, CardHeader, ConfirmSheet, Icon, ReleaseConfirm, animateInterfaceChange, interfaceSettled, interfaceTransition, motionMs, nextConfirmStep, reducedMotion, sheetOrder, showSheet, useAnimatedClose, useDismissableDetails, type DeleteRecoveryStep, type Dispatch, type InterfaceChange } from './ui';
import { EtaHolds, OperationProgress, OrganizationProgress, ProgressDisplay, Speed, allVerified, cardFraction, copyBasis, ended, formatEstimate, formatRemaining, jobFinished, jobPaused, jobStageLayers, jobTiming, layersOfPlan, organizationKinds, progressCount, progressFraction, scaledRange, shownPercent, sourceStepKinds, stagePlan, stepKind, useHeld, type SpeedInput, type StageLayer, type StagePlan, type StepKind } from './progress';
import { BrandLogo } from './BrandLogo';
import { markAppReady } from './Boot';
import { driveContext, type DriveContext } from '../drive-groups';

import { BrowserPage } from './browser/BrowserPage';
import { useBrowserConfiguration } from './browser/use-configuration';
import { reviewWorkspace, sourceImportMode, type ImportMode, type WorkspacePage } from './workspace-state';

type Page = WorkspacePage;
const pageOrder: Page[] = ['desk', 'browser', 'library', 'activity', 'settings'];
type LibraryTool = 'organize' | 'duplicates' | 'recovery';
type ActivityTab = 'jobs' | 'history' | 'issues';

export function WorkspaceNavigation({ page, onNavigate }: { page: Page; onNavigate: (page: Page) => void }) {
  const { t } = useTranslation();
  const item = (id: Page, label: string, icon: LucideIcon) => <button key={id} type="button" data-page={id} className={`nav-item ${page === id ? 'selected' : ''}`} aria-current={page === id ? 'page' : undefined} onClick={() => onNavigate(id)}><span className="nav-icon" style={{viewTransitionName:`nav-${id}-icon`}}><Icon icon={icon} /></span><span style={{viewTransitionName:`nav-${id}-text`}}>{label}</span>{page === id && <span className="nav-indicator" aria-hidden="true" />}</button>;
  return <><nav aria-label={t("Main navigation")}>{item('desk', t("Import"), ArrowDownToLine)}{item('browser', t("Library browser"), Layers3)}{item('library', t("Library tools"), FolderCog)}{item('activity', t("Activity"), Activity)}</nav><nav className="settings-navigation" aria-label={t("Settings")}>{item('settings', t("Settings"), Settings2)}</nav></>;
}

export function WorkspaceTabs<T extends string>({ label, value, items, onChange, panelId }: { panelId?: string; label: string; value: T; items: readonly { id: T; label: string; testId: string }[]; onChange: (value: T) => void }) {
  return <div className="segmented workspace-tabs" role="tablist" aria-label={label}>{items.map((item, index) => <button key={item.id} id={`tab-${item.testId}`} aria-controls={panelId} type="button" role="tab" aria-selected={value === item.id} tabIndex={value === item.id ? 0 : -1} data-testid={item.testId} onClick={() => animateInterfaceChange(() => onChange(item.id))} onKeyDown={event => { let next: number; if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % items.length; else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + items.length - 1) % items.length; else if (event.key === 'Home') next = 0; else if (event.key === 'End') next = items.length - 1; else return; event.preventDefault(); const chosen = items[next]!; animateInterfaceChange(() => onChange(chosen.id)); document.getElementById(`tab-${chosen.testId}`)?.focus(); }}>{item.label}</button>)}</div>;
}
/** Destinations are checked in the background after launch: one with no status yet is still being checked, and only a finished check that reports it unavailable makes it offline. */
export function destinationReadiness(state: Pick<AppState, 'preferences' | 'destinationStatus'>) {
  const required = requiredDestinations(state.preferences);
  const chosen = state.preferences.destinations.slice(0, required);
  const statusOf = (path: string) => state.destinationStatus?.find(disk => disk.path === path);
  return {
    ready: (state.destinationStatus ?? []).filter(disk => disk.available && chosen.includes(disk.path)),
    checking: chosen.some(path => !statusOf(path)),
    offline: chosen.some(path => statusOf(path)?.available === false),
  };
}
/** metadata: the routing read the summary shows; fields: every tag, from the full read for All metadata. */
type Preview = { path: string; metadata?: Metadata; fields?: Record<string, unknown>; loading: boolean; error?: string };

// In the order the options were asked for; 'flat' is the default.
const mediaLayouts: { value: MediaLayout; title: string; detail: string }[] = [
  { value: 'type-format', title: 'Photos and videos, then file formats', detail: 'Photos/NEF, Photos/JPEG, Videos/MOV inside the camera folder.' },
  { value: 'format', title: 'A folder for each file format', detail: 'NEF, JPEG, MOV folders inside the camera folder.' },
  { value: 'photos-flat', title: 'Photos together, videos in a folder', detail: 'Photos in the camera folder, videos in its Videos folder.' },
  { value: 'videos-flat', title: 'Videos together, photos in a folder', detail: 'Videos in the camera folder, photos in its Photos folder.' },
  { value: 'flat', title: 'Everything in the camera folder', detail: 'Photos and videos side by side.' },
  { value: 'video-root', title: 'A separate video backup folder', detail: 'Videos go to their own backup folder beside the photo backup folder.' },
];
// The Settings previews expand the templates exactly as imports do, for one sample capture.
const sampleValues = templateValues(new Date('2026-10-20T00:00:00Z'), 'Nikon Z6III');
function samplePath(template: string): string[] { return expandTemplate(template, sampleValues).split('/').filter(Boolean); }
const defaultFolderPath = parseTemplate('{year}/{yyyymm}/{camera}')!;
const monthSample = (month: FolderPath['month']) => expandTemplate(monthToken(month), sampleValues);
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
/** A destination as a drive and folder, "A006 › photobackup"; a folder on the startup disk is its folder name. */
function destinationLabel(path: string): string { const name = basename(path), drive = driveName(path, name); return drive === name ? name : `${drive} › ${name}`; }
/** Labels for a list of destinations; two that would read the same show their full paths. */
function destinationLabels(paths: string[]): string[] { const labels = paths.map(destinationLabel); return labels.map((label, index) => labels.indexOf(label) === labels.lastIndexOf(label) ? label : paths[index]!); }
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
  const formats=new Map(Object.entries(inventory.formats).map(([format,entry])=>[format,Math.max(0,entry.bytes)]));
  const usedColors=new Set<string>();
  const segments=[...formats].sort(([a],[b])=>a.localeCompare(b)).filter(([,size])=>size>0).map(([kind,size])=>{
    let hue=[...kind].reduce((hash,char)=>(hash*31+char.charCodeAt(0))>>>0,0)%360;
    let color=formatColors[kind]??`hsl(${hue.toFixed(1)} 65% 62%)`;
    while(usedColors.has(color)){hue=(hue+137.508)%360;color=`hsl(${hue.toFixed(1)} 65% 62%)`;}
    usedColors.add(color);return {kind,size,color};
  });
  formatSegmentCache.set(inventory,segments);return segments;
}
/** The one reading of a drive's total and free bytes: free is clamped into 0..total, `fraction` is the used share and `low` is above 90% used. */
export function capacityUse(total?: number, free?: number): { known: boolean; used: number; free: number; fraction: number; low: boolean } {
  if (!total || !Number.isFinite(total) || total < 0 || free === undefined || !Number.isFinite(free)) return { known: false, used: 0, free: 0, fraction: 0, low: false };
  const available = Math.max(0, Math.min(total, free)), fraction = (total - available) / total;
  return { known: true, used: total - available, free: available, fraction, low: fraction > .9 };
}
export function CapacityBar({ total, free, inventory, scanning, unavailable = 'Capacity unavailable' }: { total?: number; free?: number; inventory?: Inventory; scanning?: boolean; unavailable?: string }) {
  const { t, formatBytes: bytes } = useTranslation();
  const use = capacityUse(total, free);
  if (!use.known) return <div className="capacity-unavailable"><Icon icon={HardDrive} size={13} />{t(unavailable)}</div>;
  const { free: available, used, fraction, low } = use, size = total!;
  const classified=inventory?formatSegments(inventory):[];
  const classifiedBytes=classified.reduce((sum,item)=>sum+item.size,0);
  // Logical media sizes may exceed physical usage (compression/shared extents).
  // Keep the meter within actual used capacity; the legend reports scanned sizes.
  const scale=classifiedBytes>used&&classifiedBytes?used/classifiedBytes:1;
  const segments=[...classified.map(item=>({...item,width:item.size*scale/size*100,label:item.kind})),{kind:'other',color:'var(--storage-used)',size:Math.max(0,used-classifiedBytes*scale),width:Math.max(0,used-classifiedBytes*scale)/size*100,label:inventory?t('Other or unscanned'):t('Used')}].filter(item=>item.width>0);
  const percent=fraction*100;
  return <div className={`capacity storage-capacity ${low?'capacity-low':''}`} data-testid="storage-capacity">
    <div className="storage-track" role="meter" aria-label={t("Storage used")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-valuetext={t("{used} used, {free} free, {total} total",{used:bytes(used),free:bytes(available),total:bytes(size)})}>
      {segments.map(segment=><span key={segment.kind} className="storage-segment" data-storage-kind={segment.kind} title={`${segment.label}: ${bytes(segment.size)}`} style={{width:`${segment.width}%`,background:segment.color}} />)}
      <span className="storage-free" data-storage-kind="free" style={{width:`${available/size*100}%`}} title={t("{size} free",{size:bytes(available)})}>{available/size>=.18&&<span>{bytes(available)}</span>}</span>
    </div>
    <div className="storage-summary">
    <div className="storage-heading"><span>{t("{free} free of {total}",{free:bytes(available),total:bytes(size)})}</span>{scanning&&<span className="storage-scanning">{t("Scanning…")}</span>}</div>
    <div className="storage-legend">{segments.map(segment=><span key={segment.kind} title={`${segment.label}: ${bytes(segment.size)}`}><i style={{background:segment.color}} />{segment.label}</span>)}<span className="storage-free-label"><i />{t("{size} free",{size:bytes(available)})}</span></div>
    </div>
    {classifiedBytes>used&&<small className="storage-logical-note">{t("Media categories use scanned file sizes.")}</small>}
  </div>;
}

/** The last minute of a drive's utilization (0-100%) as a static line; it only redraws when a new reading arrives, and has no animation. */
export function Sparkline({ values }: { values: number[] }) {
  const slots = 60, shown = values.slice(-slots), offset = slots - shown.length;
  const points = shown.map((value, index) => `${offset + index},${(15 - Math.max(0, Math.min(100, value)) / 100 * 14).toFixed(1)}`);
  return <svg className="drive-sparkline" viewBox={`0 0 ${slots - 1} 16`} preserveAspectRatio="none" aria-hidden="true" focusable="false" data-testid="drive-sparkline">
    {points.length > 1 && <><polygon className="drive-sparkline-area" points={`${offset},16 ${points.join(' ')} ${slots - 1},16`} /><polyline className="drive-sparkline-line" points={points.join(' ')} /></>}
  </svg>;
}
/** How busy the drive is right now (share of time spent reading or writing), not how full it is. */
export function DriveActivityMeter({ activity }: { activity?: DriveActivity }) {
  const { t } = useTranslation();
  if (!activity) return null;
  const percent = Math.round(Math.max(0, Math.min(100, activity.utilization)));
  return <div className="drive-activity" data-testid="drive-activity" title={t("Estimated share of time the drive spent reading or writing, not its capacity")}>
    <div className="drive-activity-head"><span>{t("Drive activity")}</span><strong data-testid="drive-activity-percent">{percent}%</strong></div>
    <div className="drive-activity-graph"><span className="drive-activity-bar" role="meter" aria-label={t("Drive activity")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></span><Sparkline values={activity.history} /></div>
    <div className="drive-activity-rates" title={t("Whole disk, all apps; may include metadata and receipts")}><span>{t("Read")} <Speed value={activity.readBps} /></span><span>{t("Write")} <Speed value={activity.writeBps} /></span></div>
  </div>;
}
/** Sidebar drive row: a thin utilization bar with its percent, next to the capacity line. */
function SidebarActivity({ activity, inline = false }: { activity?: DriveActivity; inline?: boolean }) {
  const { t } = useTranslation();
  if (!activity) return null;
  const percent = Math.round(Math.max(0, Math.min(100, activity.utilization)));
  if (inline) return <small className="sidebar-activity-inline" data-testid="sidebar-activity" title={t("Estimated share of time the drive spent reading or writing, not its capacity")} role="meter" aria-label={t("Drive activity")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={t("Activity ≈{percent}", { percent: `${percent}%` })}><Icon icon={Activity} size={11} />{percent}%</small>;
  return <div className="sidebar-activity" data-testid="sidebar-activity" title={t("Estimated share of time the drive spent reading or writing, not its capacity")}><small>{t("Activity ≈{percent}", { percent: `${percent}%` })}</small><span className="sidebar-activity-bar" role="meter" aria-label={t("Drive activity")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ transform: `scaleX(${percent / 100})` }} /></span></div>;
}
/** The busiest drive in use and the combined speeds. Drives that share a disk report identical readings and count once. */
export function totalDriveActivity(state: AppState, keys: string[]): { utilization: number; readBps: number; writeBps: number; count: number } | undefined {
  const seen = new Set<string>(), found: DriveActivity[] = [];
  for (const key of keys) { const item = state.driveActivity?.[key]; if (!item) continue; const signature = JSON.stringify(item); if (seen.has(signature)) continue; seen.add(signature); found.push(item); }
  if (!found.length) return undefined;
  return { utilization: Math.max(...found.map(item => item.utilization)), readBps: found.reduce((sum, item) => sum + item.readBps, 0), writeBps: found.reduce((sum, item) => sum + item.writeBps, 0), count: found.length };
}


/** Which importer updates are interface swaps, and how they animate. Progress ticks are not: they render directly. */
export function interfaceChangeKind(previous: AppState, next: AppState): InterfaceChange | undefined {
  const a = previous.preferences, b = next.preferences;
  if (a.language !== b.language || a.appearance !== b.appearance || a.accent !== b.accent) return 'crossfade';
  // Cards and rows that come, go or move: drives, organizations, the overview, destination slots, the review.
  const layout = (state: AppState) => [state.sources.map(source => source.id).join('|'), [...new Set(state.jobs.map(job => `${job.organization ? 'organization' : 'source'}:${job.source.id}`))].sort().join('|'), state.preferences.sourceLayout, state.preferences.showDashboard, state.preferences.copyMode, state.preferences.destinations.join('|'), state.review?.id ?? !!state.busyReview].join('\n');
  return layout(previous) !== layout(next) ? 'layout' : undefined;
}

export default function RootApp() {
  const [state, setState] = useState<AppState | null>(null);
  const [stateReceiver] = useState(() => createStateReceiver());
  const [connectionError, setConnectionError] = useState('');
  const [inspectionErrors, setInspectionErrors] = useState<string[]>([]);
  const localErrorTimes = useRef(new Map<string, string>());
  const holds = useRef(new Map<string, DisplayHold>()).current;
  const [page, setPage] = useState<Page>('desk');
  const browserConfiguration = useBrowserConfiguration();
  const [browserLibraryRequest, setBrowserLibraryRequest] = useState<string>();
  const [importMode, setImportMode] = useState<ImportMode>('media');
  const [libraryTool, setLibraryTool] = useState<LibraryTool>('organize');
  const [activityTab, setActivityTab] = useState<ActivityTab>('jobs');
  const [settingsRequest, setSettingsRequest] = useState<{ category: SettingsCategory; key: number }>();
  const openSettings = (category: SettingsCategory) => navigate('settings', () => setSettingsRequest(request => ({ category, key: (request?.key ?? 0) + 1 })));
  const openOrganization = () => navigate('library', () => setLibraryTool('organize'));
  // The selected destination belongs to the Organize workspace.
  const [organizationDestination, setOrganizationDestination] = useState(0);
  // Sidebar source links jump to that source's card on the Import desk.
  const openSource = (sourceId: string) => {
    const source = state?.sources.find(source => source.id === sourceId);
    const job = state?.jobs.find(job => job.source.id === sourceId);
    if (job?.organization) openOrganization(); else navigate('desk', () => setImportMode(job ? job.backup ? 'files' : 'media' : source ? sourceImportMode(source) : 'media'));
    void interfaceSettled().then(() => { const card = document.querySelector<HTMLElement>(`article.source-row[data-source-id="${CSS.escape(sourceId)}"]`); const still = reducedMotion(); card?.scrollIntoView({ behavior: still ? 'instant' : 'smooth', block: 'center' }); if (!still) card?.animate([{ boxShadow: '0 0 0 4px var(--accent-ring)' }, { boxShadow: '0 0 0 0 transparent' }], { duration: motionMs('--slow') * 3, easing: 'ease-out' }); });
  };
  // A queue row's Show: the Import card of an import, Library › Organize for an organization.
  const openJob = (job: Job) => openSource(job.source.id);
  // Destination links open their indexed library; organization stays a separate workspace.
  const openDestination = (path: string) => {
    const index = state?.preferences.destinations.indexOf(path);
    const library = state?.catalogLibraries?.find(item => item.destinationIndex === index && item.role === 'photos');
    navigate('browser', () => setBrowserLibraryRequest(library?.libraryId));
  };
  const navigate = (next: Page, update?: () => void) => { if (next === page && !update) return; animateInterfaceChange(() => { update?.(); setPage(next); window.scrollTo({ top: 0, behavior: 'instant' }); }, next === page ? 'crossfade' : pageOrder.indexOf(next) > pageOrder.indexOf(page) ? 'forward' : 'back'); };
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [errorsTarget, setErrorsTarget] = useState<ErrorTarget>();
  // Issues live in Activity: the titlebar button, sidebar badges and the toast all land there, with the drive's filter when one was clicked.
  const openErrorsFor = (target?: ErrorTarget) => navigate('activity', () => { setErrorsTarget(target); setActivityTab('issues'); });
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
      if (event.shiftKey && event.key.toLowerCase() === 's' && state && !state.review && !state.busyReview && state.preferences.destinations.length >= requiredDestinations(state.preferences)) { event.preventDefault(); window.importer.action({ type: 'start' }).catch(error => setConnectionError(String(error))); }
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
  useEffect(() => { document.documentElement.style.setProperty('--text-scale', String(preferences?.textScale ?? DEFAULT_TEXT_SCALE)); }, [preferences?.textScale]);
  const rawAct = useCallback<Dispatch>(action => {
    window.importer.action(action).then(() => setConnectionError('')).catch(error => setConnectionError(error instanceof Error ? error.message : String(error)));
  }, []);
  const act = useCallback<Dispatch>(action => {
    if (action.type === 'cleanResidue') setCleanupOpen(true); else rawAct(action);
  }, [rawAct]);
  const inspect = useCallback((path: string) => {
    const request = ++previewSequence.current;
    setPreview({ path, loading: true });
    const update = (patch: Partial<Preview>) => { if (request === previewSequence.current) setPreview(preview => preview && { ...preview, ...patch }); };
    const diagnose = (metadata: Metadata) => { const diagnostics=Object.entries(metadata.fields).filter(([key])=>key.split(':').at(-1)==='Error').map(([,value])=>`${path}: ${String(value)}`); if(diagnostics.length)setInspectionErrors(errors=>[...new Set([...errors,...diagnostics])]); };
    const failed = (error: unknown) => { const detail=`${path}: ${String(error)}`; setInspectionErrors(errors => errors.includes(detail) ? errors : [...errors,detail]); update({ loading: false, error: String(error) }); };
    // The summary is the cached routing read; only All metadata needs every tag.
    window.importer.summary(path).then(metadata => { diagnose(metadata); update({ metadata, loading: false }); }).catch(failed);
    window.importer.exif(path).then(metadata => { diagnose(metadata); update({ fields: metadata.fields }); }).catch(failed);
  }, []);
  function closePreview() { ++previewSequence.current; setPreview(null); }
  // Hooks stay above the early return below, so every render calls the same hooks.
  const sidebarRef = useRef<HTMLElement>(null);
  useSidebarFit(sidebarRef);
  // The start-up splash finishes once the first state has been rendered (a layout effect, so the sidebar logo can be measured).
  const hasState = !!state;
  useLayoutEffect(() => { if (hasState) markAppReady(); }, [hasState]);
  if (!state) return <div className="connection-screen"><img src="./icon.png" alt="" /><h1>{t("Photo Importer")}</h1><p>{connectionError || t("Opening your camera workbench…")}</p>{connectionError && <Button icon={RefreshCw} onClick={() => location.reload()}>{t("Retry")}</Button>}</div>;
  const busy = !!state.blocked?.scan;
  const reviewOwner = reviewWorkspace(state);
  const errors = collectErrors(state, [connectionError, ...inspectionErrors].filter(Boolean).map(detail => { let at = localErrorTimes.current.get(detail); if (!at) { at = new Date().toISOString(); localErrorTimes.current.set(detail, at); } return { detail, at }; }));
  // The badge counts rows (groups needing attention), from the summaries; paths are never iterated.
  const badge = rowCounts(buildRows(errors));
  // Window-only errors clear here; the rest ask the main process, which leaves every job as it is.
  const clearErrorItems = (ids?: string[], severity?: Severity) => {
    const local = new Set((ids ?? errors.flatMap(error => error.id?.startsWith('local:') && (!severity || error.severity === severity) ? [error.id] : [])).filter(id => id.startsWith('local:')).map(id => id.slice(6)));
    for (const detail of local) localErrorTimes.current.delete(detail);
    if (local.has(connectionError)) setConnectionError('');
    setInspectionErrors(list => list.filter(detail => !local.has(detail)));
    if (!ids) act({ type: 'clearErrors', ...(severity ? { severity } : {}) }); else { const real = ids.filter(id => !id.startsWith('local:')); if (real.length) act({ type: 'clearErrors', ids: real, ...(severity ? { severity } : {}) }); }
  };
  return <I18nProvider language={language}><EtaHolds.Provider value={holds}><div className="app-shell">
    <div className={`window-titlebar ${state.platform === 'darwin' ? 'native-mac-titlebar' : ''}`}><h1 className="titlebar-page-title">{page === 'desk' ? t("Import") : page === 'library' ? t("Library tools") : page === 'browser' ? t("Library browser") : page === 'activity' ? t("Activity") : t("Settings")}</h1><TitlebarControls state={state} act={act} page={page} organizationDestination={organizationDestination} errorCount={badge.errors} warningCount={badge.warnings} onErrors={() => openErrorsFor()} />{state.platform !== 'darwin' && <div className="window-controls" aria-label={t("Window controls")}><button type="button" aria-label={t("Minimize window")} title={t("Minimize")} onClick={() => act({ type: 'window', command: 'minimize' })}><Icon icon={Minus} size={15} /></button><button type="button" aria-label={t("Maximize or restore window")} title={t("Maximize or restore")} onClick={() => act({ type: 'window', command: 'maximize' })}><Icon icon={Maximize2} size={13} /></button><button type="button" className="window-close" aria-label={t("Close window")} title={t("Close")} onClick={() => act({ type: 'window', command: 'close' })}><Icon icon={X} size={16} /></button></div>}</div>
    <aside className="sidebar" ref={sidebarRef}>
      <div className="brand"><BrandLogo className="brand-logo" /><strong>{t("Photo Importer")}</strong></div>
      <WorkspaceNavigation page={page} onNavigate={navigate} />
      <div className="sidebar-devices"><SidebarSources state={state} onOpen={openSource} errors={errors} onErrors={openErrorsFor} act={act} />
      <SidebarDestinations state={state} errors={errors} onErrors={openErrorsFor} act={act} onOpen={openDestination} /></div>
    </aside>
    <div className="main-shell">
      <main id="main-content" className="main-content">
        {(() => {
          const owner = reviewOwner;
          const shown = owner && (owner.page === 'desk' ? page === 'desk' && owner.mode === importMode : page === 'library' && libraryTool === 'organize');
          const openReview = () => { if (!owner) return; navigate(owner.page, () => { if (owner.page === 'desk') setImportMode(owner.mode); else setLibraryTool('organize'); }); };
          return owner && !shown ? <div className="pending-review notice" role="status"><Icon icon={Eye} /><span>{t("A review is waiting in its workspace.")}</span><Button onClick={openReview}>{t("Open pending review")}</Button></div> : null;
        })()}
        {page === 'desk' && <>
          <div className="import-mode-header"><WorkspaceTabs panelId="import-workspace-panel" label={t("Import mode")} value={importMode} items={[{id:'media',label:t("Media"),testId:'import-mode-media'},{id:'files',label:t("Files & folders"),testId:'import-mode-files'}]} onChange={setImportMode} /><p className="workspace-description">{importMode === 'media' ? t("File by date and camera rules.") : t("Keep the original folder structure.")}</p>{importMode === 'files' && <BackupModeLine mode={state.preferences.backupMode} onChange={() => openSettings('defaults')} />}</div>
          <section role="tabpanel" id="import-workspace-panel" aria-labelledby={`tab-import-mode-${importMode}`}>
          {reviewOwner?.page === 'desk' && reviewOwner.mode === importMode && <ReviewPanel state={state} act={act} inspect={inspect} />}
          <ImportDesk state={state} act={act} mode={importMode} onOtherMode={() => animateInterfaceChange(() => setImportMode(importMode === 'media' ? 'files' : 'media'))} needsChoice={dismissedDrives} inspect={inspect} onOrganization={openOrganization} onSettings={() => openSettings('storage')} onFolderRules={() => openSettings('folders')} onAutomatic={() => openSettings('defaults')} onActivity={() => navigate('activity', () => setActivityTab('jobs'))} /></section>
        </>}
        {page === 'browser' && <BrowserPage requestedLibraryId={browserLibraryRequest} libraries={state.catalogLibraries ?? []} statuses={state.catalogStatuses ?? {}} configuration={browserConfiguration.configuration} onConfiguration={browserConfiguration.setConfiguration} storageError={browserConfiguration.storageError} api={window.importer} onRefresh={libraryId => act({type:'catalogRefresh', libraryId})} onStop={libraryId => act({type:'catalogStop', libraryId})} onReveal={path => act({type:'reveal',path})} onOrganization={destinationIndex => navigate('library', () => { setLibraryTool('organize'); if (destinationIndex !== undefined) setOrganizationDestination(destinationIndex); })} />}
        {page === 'library' && <>
          <WorkspaceTabs panelId="library-workspace-panel" label={t("Library tools")} value={libraryTool} items={[{id:'organize',label:t("Organize"),testId:'library-organize'},{id:'duplicates',label:t("Duplicates"),testId:'library-duplicates'},{id:'recovery',label:t("Recovery & cleanup"),testId:'library-recovery'}]} onChange={setLibraryTool} />
          <section role="tabpanel" id="library-workspace-panel" aria-labelledby={`tab-library-${libraryTool}`}>{libraryTool === 'organize' ? <>{reviewOwner?.page === 'library' && <ReviewPanel state={state} act={act} inspect={inspect} />}<Organization state={state} act={act} busy={busy} selectedDestination={organizationDestination} onSelectDestination={setOrganizationDestination} onFolderRules={() => openSettings('folders')} /></> : libraryTool === 'duplicates' ? <DuplicatesPage state={state} act={act} /> : <><OrganizationRecoveryPanel state={state} act={act} busy={busy || settingsLocked(state)} /><section className="organization-action activity-maintenance"><CardHeader icon={Trash2} title={t("Maintenance")} /><LeftoverFiles state={state} act={act} busy={busy || settingsLocked(state)} /></section></>}</section>
        </>}
        {page === 'settings' && <SettingsPage state={state} act={act} busy={busy || settingsLocked(state)} requestedCategory={settingsRequest?.category} requestKey={settingsRequest?.key} onLibrary={openOrganization} />}
        {page === 'activity' && <>
          <WorkspaceTabs panelId="activity-workspace-panel" label={t("Activity")} value={activityTab} items={[{id:'jobs',label:t("Queue"),testId:'activity-jobs'},{id:'history',label:t("History"),testId:'activity-history'},{id:'issues',label:t("Issues"),testId:'activity-issues'}]} onChange={setActivityTab} />
          <section role="tabpanel" id="activity-workspace-panel" aria-labelledby={`tab-activity-${activityTab}`}>{activityTab === 'jobs' && <ActivityJobs state={state} act={act} onShow={openJob} />}
          {activityTab === 'history' && <HistoryPage state={state} onDesk={() => navigate('desk')} />}
          {activityTab === 'issues' && <ActivityPanel state={state} errors={errors} target={errorsTarget} onShowAll={() => setErrorsTarget(undefined)} act={act} onClear={clearErrorItems} onOpenSource={openSource} />}</section>
        </>}
      </main>
    </div>

    {cleanupOpen && <CleanupConfirmation residue={state.residue} busy={busy || settingsLocked(state)} act={rawAct} onCancel={() => setCleanupOpen(false)} />}
    <ErrorToast errors={errors} hidden={page === 'activity' && activityTab === 'issues'} onView={() => openErrorsFor()} />
    {promptOpen && <NewDrivePrompt state={state} act={act} skip={dismissedDrives} onDismiss={ids => { setDismissedDrives(current => [...new Set([...current, ...ids])]); setPromptOpen(false); }} onDone={() => setPromptOpen(false)} />}
    {preview && <MetadataDialog preview={preview} onClose={closePreview} act={act} />}
  </div></EtaHolds.Provider></I18nProvider>;
}

// Each drive shows its capacity and a compact 1·2·3 Scanning/Copying/Verifying status.
// The name gets the full first line; capacity bar and status share the second; free space is the third.
// An idle source (compact) puts its activity figure on the free-space line: three lines instead of four, nothing left out.
function SidebarCapacity({ total, free, unavailable, status, activity, compact = false }: { total?: number; free?: number; unavailable: string; status?: ReactNode; activity?: DriveActivity; compact?: boolean }) {
  const { t, formatBytes: bytes } = useTranslation();
  const { known, free: left, fraction: used, low } = capacityUse(total, free);
  const text = known ? (() => { const full = t("{free} free of {total}", { free: bytes(left), total: bytes(total!) }); return <small className="sidebar-capacity-text" title={full}><span className="capacity-full">{full}</span><span className="capacity-short" aria-hidden="true">{t("{size} free", { size: bytes(left) })}</span></small>; })() : <small className="sidebar-capacity-text">{unavailable}</small>;
  return <>
    <div className="sidebar-meta">{known ? <span className={`sidebar-capacity ${low ? 'is-low' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used * 100)} aria-label={t("Storage used")}><span style={{ transform: `scaleX(${used})` }} /></span> : <span className="sidebar-capacity is-unknown" />}{status}</div>
    {compact ? <div className="sidebar-detail">{text}<SidebarActivity activity={activity} inline /></div> : <>{text}<SidebarActivity activity={activity} /></>}
  </>;
}

// The sidebar widens to fit "342.9 GB free of 2.00 TB" when the window has room; a line that
// still does not fit switches to "342.9 GB free". Measured after every render and on resize,
// and applied to the DOM directly so measuring never re-renders.
function useSidebarFit(sidebar: RefObject<HTMLElement | null>) {
  const fit = useCallback(() => {
    const aside = sidebar.current; if (!aside) return;
    const root = document.documentElement, texts = [...aside.querySelectorAll<HTMLElement>('.sidebar-capacity-text')].filter(text => text.querySelector('.capacity-full'));
    // Drive names count too, measured on one line, so a name like "Fixture card 2" does not wrap when there is room.
    const names = [...aside.querySelectorAll<HTMLElement>('.sidebar-drive .sidebar-item>span')];
    if (!texts.length && !names.length) { root.style.removeProperty('--sidebar-width'); return; }
    const current = aside.getBoundingClientRect().width;
    const capacity = texts.map(text => ({ natural: text.querySelector<HTMLElement>('.capacity-full')!.getBoundingClientRect().width, available: text.clientWidth, chrome: current - text.clientWidth }));
    // Read every slot, then set every name on one line and read them all, then restore: two layouts, however many drives.
    const slots = names.map(name => { const item = name.parentElement!; return item.getBoundingClientRect().right - parseFloat(getComputedStyle(item).paddingRight) - name.getBoundingClientRect().left; });
    names.forEach(name => { name.style.whiteSpace = 'nowrap'; });
    const widths = names.map(name => Math.max(name.getBoundingClientRect().width, name.scrollWidth));
    names.forEach(name => name.style.removeProperty('white-space'));
    const named = names.map((_, index) => ({ natural: widths[index]!, available: slots[index]!, chrome: current - slots[index]! }));
    const lines = [...capacity, ...named];
    const result = sidebarFit({ lines, chrome: current - Math.min(...lines.map(line => line.available)), minimum: 190, maximum: Math.min(360, window.innerWidth * .28), current });
    root.style.setProperty('--sidebar-width', `${result.width}px`);
    texts.forEach((text, index) => text.classList.toggle('is-compact', result.compact[index]!));
  }, [sidebar]);
  useLayoutEffect(fit);
  useEffect(() => { window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit); }, [fit]);
}

function MiniSteps({ states, kinds, paused = false }: { states: StepState[]; kinds: StepKind[]; paused?: boolean }) {
  const { t } = useTranslation();
  const names = [t("Scanning"), t(kinds[1] === 'move' ? "Moving" : "Copying"), t("Verifying")];
  const labels: Record<StepState, string> = { pending: t("Waiting"), active: t("In progress"), done: t("Complete"), error: t("Needs attention"), paused: t("Paused"), skipped: t("Skipped") };
  const icons: Record<StepState, LucideIcon | null> = { pending: null, active: LoaderCircle, done: Check, error: CircleAlert, paused: Pause, skipped: Minus };
  return <span className="mini-steps" {...(paused ? { 'data-paused': '' } : {})} role="img" aria-label={states.map((state, index) => `${names[index]}: ${labels[state]}`).join(', ')} title={t("Import steps")}>{states.map((state, index) => <i key={index} data-state={state} data-step={kinds[index]}>{icons[state] ? <Icon icon={icons[state]!} size={9} /> : null}</i>)}</span>;
}

export function SidebarSources({ state, onOpen, errors, onErrors, act }: { state: AppState; onOpen: (sourceId: string) => void; errors?: DisplayError[]; onErrors?: (target: ErrorTarget) => void; act?: Dispatch }) {
  const { t } = useTranslation();
  const verifyOff = !state.preferences.verifyCopies;
  // A library or folder with a job running (an organization, a folder backup) is a source here too, while it runs.
  const running = state.jobs.filter(job => (isRunning(job) || job.phase === 'queued') && !state.sources.some(source => source.id === job.source.id)).map(job => job.source);
  const listed = [...state.sources, ...running.filter((source, index) => running.findIndex(other => other.id === source.id) === index)];
  return <section className="sidebar-section" aria-labelledby="sidebar-sources"><div className="sidebar-heading"><h2 id="sidebar-sources">{t("Sources")}</h2>{act && <Button kind="quiet" icon={RefreshCw} className="refresh-button" data-testid="refresh-sources" title={t("Refresh connected sources")} aria-label={t("Refresh connected sources")} onClick={() => act({type:'refresh'})} />}</div>
    {listed.length ? <ul>{listed.map(source => {
      const job = state.jobs.find(item => item.source.id === source.id && (!item.organization || !state.sources.some(other => other.id === source.id)));
      const scanning = !!state.scanningSources?.includes(source.id);
      const icon = source.transport === 'camera' ? Camera : source.transport === 'folder' ? Folder : Save;
      const steps = sourceStepStates(job, state.sourceInventories?.[source.id] ?? job?.inventory, scanning, verifyOff, !!state.busyReview && state.reviewSourceId === source.id);
      const drive = driveContext(source, state.sources, state.destinationStatus), sharedCapacity = !!drive && !drive.showsCapacity;
      const working = !!job && (isRunning(job) || job.phase === 'queued'), use = capacityUse(source.total, source.free);
      // An idle row is one line shorter: its activity joins the free-space line.
      const idle = !working && !scanning && use.known && !use.low && !sharedCapacity;
      return <li key={source.id} data-source-id={source.id} className={`sidebar-drive${idle ? ' is-idle' : ''}${sourceSelected(source) ? '' : ' sidebar-item-off'}`} data-testid="sidebar-source"><div className="sidebar-row"><button type="button" className="sidebar-item" title={source.path || source.name} onClick={() => onOpen(source.id)}><Icon icon={icon} size={16} /><span>{source.name}</span></button>{act && source.path && source.transport !== 'camera' && <RevealButton path={source.path} act={act} name={source.name} />}{act && ejectable(source) && state.sources.some(item => item.id === source.id) && <EjectButton source={source} act={act} busy={sourceInUse(state, source)} ejecting={!!state.ejecting?.includes(source.id)} />}<SidebarErrors errors={errors} target={{ sourceId: source.id, name: source.name }} onErrors={onErrors} /></div>
        <SidebarCapacity total={sharedCapacity ? undefined : source.total} free={sharedCapacity ? undefined : source.free} unavailable={sharedCapacity ? t("Same drive as {name}", { name: drive!.leader.name }) : source.transport === 'camera' ? t("Capacity unavailable over USB") : t("Capacity unavailable")} status={<MiniSteps states={steps} kinds={sourceStepKinds(job)} paused={!!job && jobPaused(job)} />} activity={state.driveActivity?.[source.id]} compact={idle} /></li>;
    })}</ul> : <p className="sidebar-empty">{t("No sources connected")}</p>}
  </section>;
}

/** What a destination is doing now, from state the app already holds (jobs, the folder check, duplicates, leftover cleanup). */
export type DestinationStatusKind = 'checking' | 'offline' | 'idle' | 'receiving' | 'checking-files' | 'verifying' | 'folder-check' | 'organizing' | 'cleaning';
export interface DestinationActivity { kind: DestinationStatusKind; completed: number; total: number; bytes: number; totalBytes: number; speed: number; fileRate: number; eta?: number; sources: string[]; fraction?: number; /** checking-files: the step the bar is drawn in. */layer?: StepKind; /** Every job writing here is pausing: the bar shows the paused color. */paused?: boolean }
const destinationPriority: DestinationStatusKind[] = ['receiving', 'checking-files', 'verifying', 'organizing', 'folder-check', 'cleaning'];
export function destinationActivity(state: AppState, path: string): DestinationActivity {
  const empty = { completed: 0, total: 0, bytes: 0, totalBytes: 0, speed: 0, fileRate: 0, sources: [] as string[] };
  const status = state.destinationStatus?.find(item => item.path === path);
  if (!status) return { kind: 'checking', ...empty };
  if (!status.available) return { kind: 'offline', ...empty };
  const required = requiredDestinations(state.preferences);
  const chosen = state.preferences.destinations.slice(0, required).includes(path);
  type Part = { kind: DestinationStatusKind; progress?: Progress; eta?: number; source?: string; paused?: boolean };
  const parts: Part[] = [];
  for (const job of state.jobs) {
    if (!isRunning(job)) continue;
    const step = job.progress?.step, tidy = step === 'tidying' || step === 'stashing' || step === 'releasing' || step === 'removing';
    if (job.organization) { if (within(job.source.path, path)) parts.push({ kind: tidy ? 'cleaning' : 'organizing', progress: job.progress, eta: job.eta ?? job.progress?.eta, paused: jobPaused(job) }); continue; }
    if (!chosen || job.phase === 'discovering') continue;
    // Progress left over from an earlier run (planning figures on a job already copying) says nothing about what the job does now; without any, the job's phase decides.
    const progress = job.progress && job.phase === 'copying' && job.progress.phase === 'planning' ? undefined : job.progress;
    const stage = progress?.phase ?? (job.phase === 'verifying' ? 'planning' : job.phase === 'copying' ? 'copying' : undefined);
    parts.push({ kind: tidy ? 'cleaning' : stage === 'planning' ? 'checking-files' : stage === 'verifying' ? 'verifying' : 'receiving', progress, eta: job.eta ?? progress?.eta, source: job.source.name, paused: jobPaused(job) });
  }
  const duplicates = state.duplicates;
  if (duplicates?.root && (duplicates.status === 'removing' || duplicates.status === 'scanning') && within(duplicates.root, path)) parts.push({ kind: 'organizing', progress: duplicates.progress, eta: duplicates.progress?.eta });
  if (state.misplacedProgress?.[path]) parts.push({ kind: 'folder-check', progress: state.misplacedProgress[path], eta: state.misplacedProgress[path].eta });
  if (state.residue?.progress) parts.push({ kind: 'cleaning', progress: state.residue.progress, eta: state.residue.progress.eta });
  const kind = destinationPriority.find(item => parts.some(part => part.kind === item));
  if (!kind) return { kind: 'idle', ...empty };
  const same = parts.filter(part => part.kind === kind);
  const layer = kind === 'checking-files' ? stepKind(same.find(part => part.progress)?.progress) : undefined;
  const sum = { ...empty, ...(layer ? { layer } : {}), sources: [...new Set(same.flatMap(part => part.source ? [part.source] : []))] };
  const etas: (number | undefined)[] = [];
  for (const { progress, eta } of same) {
    etas.push(eta);
    if (!progress) continue;
    const basis = copyBasis(progress), work = progress.phase === 'verifying' && progress.work?.totalBytes ? progress.work : undefined;
    sum.completed += basis.completed; sum.total += basis.total;
    sum.bytes += work ? work.bytes : progress.bytes; sum.totalBytes += work ? work.totalBytes : progress.totalBytes;
    sum.speed += progress.speed; sum.fileRate += progress.fileRate ?? 0;
  }
  // Each part's share as its own counter counts it (files for checks, bytes for copies), weighted by its files.
  const shares = same.flatMap(({ progress }) => { const value = progress && progressFraction(progress); return value === undefined ? [] : [{ value, weight: Math.max(copyBasis(progress!).total, 1) }]; });
  const fraction = shares.length ? shares.reduce((total, item) => total + item.value * item.weight, 0) / shares.reduce((total, item) => total + item.weight, 0) : undefined;
  return { kind, ...sum, eta: same.some(part => part.source) ? state.destinationEta?.[path] : etas.length && etas.every(item => item !== undefined) ? etas[0] : undefined, fraction: fraction === undefined ? undefined : Math.min(1, Math.max(0, fraction)), ...(same.length && same.every(part => part.paused) ? { paused: true } : {}) };
}
/** A destination's status in the sidebar: a coloured label, and while it works a thin bar, the counts, speed, time left and which sources write to it. Never a file name. */
function SidebarDestinationStatus({ activity, path }: { activity: DestinationActivity; path: string }) {
  const { t, formatNumber, formatBytes, language } = useTranslation();
  const eta = useHeld()(`destination:${path}`, activity.eta);
  const labels: Record<DestinationStatusKind, string> = { checking: t("Checking…"), offline: t("Offline"), idle: t("Idle"), receiving: t("Receiving files"), 'checking-files': t("Checking files"), verifying: t("Verifying"), 'folder-check': t("Checking folder layout"), organizing: t("Organizing"), cleaning: t("Cleaning up") };
  const step = ({ receiving: 'copy', 'checking-files': activity.layer ?? 'read', verifying: 'verify', 'folder-check': 'folder-check', organizing: 'move', cleaning: 'tidy' } as Partial<Record<DestinationStatusKind, string>>)[activity.kind];
  const busy = step !== undefined, percent = activity.fraction === undefined ? undefined : Math.round(activity.fraction * 100);
  // Verifying sits over the finished copy layer, as in every other bar.
  const top = Math.min(1, Math.max(0, activity.fraction ?? 0)), layers: StageLayer[] = activity.kind === 'verifying' ? [{ kind: 'copy', fraction: 1 }, { kind: 'verify', fraction: top }] : step ? [{ kind: step as StepKind, fraction: top }] : [];
  const first = activity.sources[0], more = activity.sources.length - 1;
  const from = first === undefined ? undefined : more > 0 ? t("from {name} (+{count} more)", { name: first, count: formatNumber(more) }) : t("from {name}", { name: first });
  const count = activity.total > 0 ? activity.totalBytes > 0 ? t("{completed} of {total} files · {size} of {totalSize}", { completed: formatNumber(activity.completed), total: formatNumber(activity.total), size: formatBytes(activity.bytes), totalSize: formatBytes(activity.totalBytes) }) : t("{completed} of {total} files", { completed: formatNumber(activity.completed), total: formatNumber(activity.total) }) : undefined;
  const speed = activity.speed > 0 ? formatSpeed(activity.speed, language) : activity.fileRate > 0 ? t("{count} files/s", { count: numberIn(activity.fileRate, language, { maximumSignificantDigits: 3 }) }) : undefined;
  const left = eta !== undefined ? t("{time} left", { time: formatRemaining(eta, t) }) : undefined;
  const rates = [speed, left].filter(Boolean).join(' · ');
  return <div className="sidebar-dest-status" role="group" aria-label={t("Destination status")}>
    <div className="sidebar-dest-line"><span data-testid="sidebar-destination-status" data-kind={activity.kind} {...(step ? { 'data-step': step } : {})} className="sidebar-dest-label">{labels[activity.kind]}</span>{from && <small className="sidebar-dest-from" title={activity.sources.join(', ')}>{from}</small>}{busy && percent !== undefined && <small className="sidebar-dest-percent">{formatNumber(percent)}%</small>}</div>
    {busy && <div className="sidebar-dest-progress" data-step={step} {...(activity.paused ? { 'data-paused': '' } : {})}>
      <span className="sidebar-dest-bar progress-track" role="meter" aria-label={t("Destination progress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>{layers.map((layer, index) => <span key={index} data-layer="" data-step={layer.kind} style={{ transform: `scaleX(${layer.fraction})` }} />)}</span>
      {count && <small className="sidebar-dest-detail" title={count}>{count}</small>}
      {rates && <small className="sidebar-dest-detail" title={rates}>{rates}</small>}
    </div>}
  </div>;
}

export function SidebarDestinations({ state, errors, onErrors, act, onOpen }: { state: AppState; errors?: DisplayError[]; onErrors?: (target: ErrorTarget) => void; act?: Dispatch; onOpen?: (path: string) => void }) {
  const { t } = useTranslation();
  const count = requiredDestinations(state.preferences);
  const destinations = state.preferences.destinations.slice(0, count);
  return <section className="sidebar-section" aria-labelledby="sidebar-destinations"><h2 id="sidebar-destinations">{t("Destinations")}</h2>
    {destinations.length ? <ul>{destinations.map(path => {
      const status = state.destinationStatus?.find(item => item.path === path);
      const online = status?.available !== false, name = basename(path) || path;
      const label = <><Icon icon={HardDrive} size={16} /><span>{name}</span><i className={`status-dot ${online ? 'is-online' : 'is-offline'}`} role="img" aria-label={online ? t("Destination available") : t("Drive offline")} /></>;
      return <li key={path} className="sidebar-drive sidebar-destination" title={path} data-testid="sidebar-destination"><div className="sidebar-row">{onOpen ? <button type="button" className="sidebar-item" onClick={() => onOpen(path)}>{label}</button> : <div className="sidebar-item sidebar-static">{label}</div>}{act && online && <RevealButton path={path} act={act} name={name} />}<SidebarErrors errors={errors} target={{ destination: path, name }} onErrors={onErrors} /></div>
        <SidebarDestinationStatus activity={destinationActivity(state, path)} path={path} />
        <SidebarCapacity total={status?.total} free={status?.free} unavailable={online ? t("Reading drive capacity…") : t("Drive offline")} activity={state.driveActivity?.[path]} /></li>;
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
type DisplayError = {code?: string; count?: number; items?: {path: string; detail?: string}[]; reasons?: Record<string, number>; id?: string; at?: string; drive?: string; source: string; message: Message; kind: ErrorKind; severity: Severity; sourceId?: string; jobId?: string; formatSourceId?: string; /** Old records of an earlier version on this drive: the row offers Acknowledge, and Clear does not apply. */oldDrive?: string};
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
  const all = errors ? errorsFor(errors, target) : [];
  const own = all.filter(error => error.severity === 'error'), warnings = all.filter(error => error.severity === 'warning');
  if (!all.length) return null;
  // Errors get the red count; warnings only a small amber mark that never competes with it.
  return <>{warnings.length > 0 && <button type="button" className="sidebar-warning-indicator" data-testid="sidebar-warnings" aria-label={t("{count} warnings", { count: formatNumber(warnings.length) })} title={t("Show warnings for {name}", { name: target.name })} onClick={() => onErrors?.(target)}><Icon icon={Info} size={13} /></button>}{own.length > 0 && <button type="button" className="sidebar-error-badge" data-testid="sidebar-errors" data-level="error" aria-label={t("{count} errors", { count: formatNumber(own.length) })} title={t("Show errors for {name}", { name: target.name })} onClick={() => onErrors?.(target)}><Icon icon={CircleAlert} size={13} /><span>{formatNumber(own.length)}</span></button>}</>;
}
type ErrorExplanation = { title: string; hint?: string };
// Turns a raw technical message into a plain title and a next step. Keys are translated at render time.
export function explainError(message: Message, kind: ErrorKind = 'app', language: Language = 'en'): ErrorExplanation {
  if (kind === 'format') return { title: "Unknown file formats" };
  const cause = errorCause(message);
  if (cause === 'space') return { title: "Not enough space on the destination.", hint: "Free up space or choose another destination." };
  if (cause === 'permission') return { title: "macOS didn't allow access to this location.", hint: "Check the drive's permissions, or allow the app in Privacy & Security." };
  if (cause === 'changed') return { title: "Files on the drive changed during the import.", hint: "Scan the drive again, then import." };
  if (cause === 'verify') return { title: "A copy didn't match the original.", hint: "Import again. The mismatched copy isn't kept." };
  if (cause === 'mirror') return { title: "Mirror needs your review before moving files.", hint: "Open Review on this drive." };
  if (cause === 'missing') return { title: "The drive was disconnected or a file is missing.", hint: "Reconnect the drive and try again." };
  if (cause === 'io') return { title: "The drive reported a read or write error.", hint: "Check the card or drive, or try another reader." };
  if (cause === 'timeout') return { title: "The operation took too long.", hint: "Try again. A slow or failing drive can cause this." };
  if (kind === 'metadata') return { title: "Couldn't read photo details.", hint: "The file is still copied; its date may come from the file instead." };
  return { title: formatMessage(message, language).split(/(?<=\.)\s|(?<=。)/)[0]! };
}
/** What went wrong, from the message key or, for raw text, the error code main attached (see toMessage). */
const causeByKey: Record<string, string> = { 'error.sourceChanged': 'changed', 'error.mirrorReview': 'mirror', 'error.sourceDisconnected': 'missing' };
const causeByErrno: Record<string, string> = { ENOSPC: 'space', EACCES: 'permission', EPERM: 'permission', ECHANGED: 'changed', EVERIFY: 'verify', ENOENT: 'missing', ENODEV: 'missing', ENXIO: 'missing', EIO: 'io', ETIMEDOUT: 'timeout' };
function errorCause(message: Message): string | undefined {
  if (message.key === 'text') { const errno = message.params?.errno; return typeof errno === 'string' ? causeByErrno[errno] : undefined; }
  const own = causeByKey[message.key]; if (own) return own;
  const inner = message.params?.error; return inner && typeof inner === 'object' && !Array.isArray(inner) && 'key' in inner ? errorCause(inner) : undefined;
}
export function collectErrors(state: AppState, extra: (string | LocalError | undefined)[] = []): DisplayError[] {
  const result: DisplayError[] = [];
  for (const item of extra) { const local = typeof item === 'string' ? { detail: item } : item; if (local?.detail && !result.some(error => error.id === 'local:' + local.detail)) result.push({ id: 'local:' + local.detail, source: '', drive: driveName(local.detail, ''), message: text(local.detail), kind: 'app', severity: 'error', ...(local.at ? { at: local.at } : {}) }); }
  result.push(...(state.errorLog?.entries ?? []));
  return result;
}

// A short notice when new problems appear while the error sheet is closed.
function ErrorToast({ errors, hidden, onView }: { errors: DisplayError[]; hidden: boolean; onView: () => void }) {
  const { t, formatNumber, language } = useTranslation();
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<DisplayError[]>([]);
  const toast = useRef<HTMLDivElement>(null);
  const [toastHost, setToastHost] = useState<HTMLElement>(document.body);
  // A top-layer popover outside a modal is still inert. Keep it inside the active
  // modal's DOM subtree so both its paint order and its pointer/keyboard input work.
  useLayoutEffect(() => {
    const syncHost = () => {
      const modals = [...document.querySelectorAll<HTMLDialogElement>('dialog:modal')];
      modals.sort((a, b) => (sheetOrder.get(a) ?? 0) - (sheetOrder.get(b) ?? 0));
      setToastHost(modals.at(-1) ?? document.body);
    };
    syncHost();
    const observer = new MutationObserver(syncHost);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    return () => observer.disconnect();
  }, []);
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
  useEffect(() => { if (!fresh.length) return; const timer = window.setTimeout(dismiss, fresh.some(error => error.severity === 'error') ? 7000 : 4000); return () => window.clearTimeout(timer); }, [fresh]);
  // The toast lives in the top layer, above the page, the sidebar, the titlebar and any sheet already open.
  // A View Transition draws above the top layer and takes every hit test, so one still running is finished first.
  useLayoutEffect(() => { const node = toast.current; if (node?.isConnected && !node.matches(':popover-open')) { interfaceTransition?.skipTransition(); node.showPopover(); } });
  if (!fresh.length || hidden) return null;
  // Errors take the toast; warnings alone get a calmer one that dismisses itself sooner.
  const newErrors = fresh.filter(error => error.severity === 'error'), shown = newErrors.length ? newErrors : fresh, severity: Severity = newErrors.length ? 'error' : 'warning';
  const first = explainError(shown[0]!.message, shown[0]!.kind, language);
  return createPortal(<div ref={toast} popover="manual" data-error-layer className={`error-toast is-${severity}`} data-severity={severity} role="status" data-testid={severity === 'error' ? 'error-toast' : 'warning-toast'}><Icon icon={severity === 'error' ? CircleAlert : Info} size={16} /><div><strong>{shown.length > 1 ? t(severity === 'error' ? "{count} new issues" : "{count} new warnings", { count: formatNumber(shown.length) }) : shown[0]!.count !== undefined && shown[0]!.code ? groupInfo(shown[0]!.code, shown[0]!.count, shown[0]!.drive || shown[0]!.source, t, formatNumber).title : t(first.title)}</strong>{shown[0]!.source && <span>{shown[0]!.source}</span>}</div><Button kind="quiet" onClick={() => { setFresh([]); onView(); }}>{t("View")}</Button><Button kind="quiet" icon={X} aria-label={t("Dismiss")} onClick={dismiss} /></div>, toastHost);
}

/** Work Stop everything / Stop all can end: imports, scans, the open review, folder checks and duplicate scans. */
function anyWorkToStop(state: AppState): boolean { return !!state.scanningSources?.length || !!state.review || !!state.busyReview || Object.keys(state.misplacedProgress ?? {}).length > 0 || state.duplicates?.status === 'scanning' || state.jobs.some(job => isRunning(job) || job.phase === 'queued' || job.paused); }
function organizationDestinationIndex(preferences: Preferences, selected: number): number { return preferences.destinations[selected] ? selected : 0; }

/** Each page's own actions, then All errors on every page. */
export function TitlebarControls({state, act, page = 'desk', organizationDestination = 0, errorCount, warningCount = 0, onErrors, errorLevel}: {state: AppState; act: Dispatch; page?: Page; organizationDestination?: number; errorCount: number; warningCount?: number; onErrors: () => void; errorLevel?: 'error' | 'warning'}) {
  const { t, formatNumber } = useTranslation();
  const errorsButton = <Button icon={CircleAlert} data-testid="show-errors" title={t("All errors")} aria-label={t("All errors")} onClick={onErrors}><span className="titlebar-label">{t("All errors")}</span><span key={errorCount} className="error-count" data-count={errorCount} data-level={errorLevel} aria-label={t("{count} errors", {count:formatNumber(errorCount)})}>{formatNumber(errorCount)}</span>{warningCount > 0 && <span key={`w${warningCount}`} className="error-count warning-count" data-testid="warning-count" data-count={warningCount} aria-label={t("{count} warnings", {count:formatNumber(warningCount)})}>{formatNumber(warningCount)}</span>}</Button>;
  const scanning = !!state.scanningSources?.length;
  const canStop = state.jobs.some(job => !job.organization && (isRunning(job) || job.phase === 'queued' || job.paused));
  const anythingToStop = anyWorkToStop(state);
  const stopMenu = useRef<HTMLDetailsElement>(null);
  useDismissableDetails(stopMenu);
  const configured = state.preferences.destinations.length >= requiredDestinations(state.preferences);
  const selectedCount = state.sources.filter(sourceSelected).length;
  const running = state.jobs.some(job => !job.organization && (isRunning(job) || job.phase === 'queued'));
  // Every running job is winding down after Stop or Pause: the controls say so, disabled, until it has.
  const live = state.jobs.filter(job => isRunning(job));
  const winding = live.length > 0 && live.every(job => job.stopping) && !state.jobs.some(job => job.phase === 'queued') && !scanning && !state.review && !state.busyReview;
  const stopping = winding && live.some(job => job.stopping === 'stop');
  return <div className="titlebar-actions" aria-label={t("Import controls")}>{running ? <Button kind="primary" icon={Pause} data-testid="global-start" disabled={winding} aria-busy={winding || undefined} onClick={() => act({type:'pause'})}>{winding ? (stopping ? t("Stopping…") : t("Pausing…")) : t("Pause imports")}</Button> : <Button kind="primary" icon={Play} data-testid="global-start" title={t("Starts all selected media and folder sources. Existing jobs keep their modes.")} disabled={!configured || !selectedCount || scanning || !!state.review || !!state.busyReview} onClick={() => act({type:'start'})}>{selectedCount !== state.sources.length ? t("Start all selected ({count})", { count: formatNumber(selectedCount) }) : t("Start all selected")}</Button>}<div className="split-control titlebar-stop"><Button icon={Square} data-testid="global-stop" title={t("Stops queued, paused and running media imports and file backups. Scans, reviews and library tools continue.")} disabled={!canStop || stopping} aria-busy={stopping || undefined} aria-label={stopping ? t("Stopping…") : t("Stop imports")} onClick={() => act({type:'stop',scope:'imports'})}><span className="titlebar-label">{stopping ? t("Stopping…") : t("Stop imports")}</span></Button><details className="overflow-menu" data-testid="global-stop-menu" ref={stopMenu}><summary className="button button-secondary button-icon-only stop-more" aria-label={t("More stop options")} title={t("More stop options")}><Icon icon={ChevronDown} size={16} /></summary><div className="overflow-menu-items"><Button kind="quiet" icon={Square} data-testid="global-stop-everything" title={t("Stops imports, scans and organizing, and discards the open review.")} disabled={!anythingToStop} onClick={event => { event.currentTarget.closest('details')!.open = false; act({type:'stop'}); }}>{t("Stop everything")}</Button></div></details></div>{errorsButton}</div>;
}

type Translate = ReturnType<typeof useTranslation>['t'];
/** The plain-language title and one-sentence explanation of a group of like problems. */
export function groupInfo(code: string, count: number, drive: string, t: Translate, formatNumber: (value: number) => string, reasons?: Record<string, number>): { title: string; text?: string; breakdown?: string } {
  const n = formatNumber(count), one = count === 1;
  // Unknown files: how many had no date, no camera, or could not be read, over all of them.
  const unknown = reasons && [reasons.noDate ? t("{count} without a date", { count: formatNumber(reasons.noDate) }) : '', reasons.noCamera ? t("{count} without a camera", { count: formatNumber(reasons.noCamera) }) : '', reasons.unreadable ? t("{count} unreadable", { count: formatNumber(reasons.unreadable) }) : ''].filter(Boolean).join(' · ');
  const breakdown = unknown ? { breakdown: unknown } : {};
  switch (code) {
    case 'staging-left': return { title: one ? t("1 temporary copy was left on {drive} — your photo is safe", { drive }) : t("{count} temporary copies were left on {drive} — your photos are safe", { count: n, drive }), text: t("These are scratch files from the copy step. Every real copy was checked and is complete; Clean up removes the leftovers.") };
    case 'unreadable': return { title: one ? t("1 file could not be read for photo details") : t("{count} files could not be read for photo details", { count: n }), text: t("The files are still copied; their dates may come from the file instead.") };
    case 'zero-byte': return { title: one ? t("1 empty file was left out") : t("{count} empty files were left out", { count: n }), text: t("Empty files hold no photo data.") };
    case 'copy-failed': return { title: one ? t("1 file could not be copied") : t("{count} files could not be copied", { count: n }), text: t("These files are not in the backup yet. Retry runs the job again.") };
    case 'file-skipped': return { title: one ? t("1 file was skipped because it failed") : t("{count} files were skipped because they failed", { count: n }), text: t("The other files were copied. Retry runs the job again, including these files.") };
    case 'appledouble-kept': return { title: one ? t("1 macOS ._ file was kept") : t("{count} macOS ._ files were kept", { count: n }), text: t("A ._ file may hold tags or comments, so it was left in place. Your photos are not affected.") };
    case 'kept-no-metadata': return { title: one ? t("1 unknown file was left where it is") : t("{count} unknown files were left where they are", { count: n }), text: t("They have no capture date, no camera or known origin, or could not be read. You can change this in Settings."), ...breakdown };
    case 'filed-no-metadata': return { title: one ? t("1 unknown file was filed in the unknown files folder") : t("{count} unknown files were filed in the unknown files folder", { count: n }), text: t("They have no capture date, no camera or known origin, or could not be read. You can change this in Settings."), ...breakdown };
    case 'appledouble-failed': return { title: one ? t("1 macOS ._ file or folder could not be checked") : t("{count} macOS ._ files or folders could not be checked", { count: n }), text: t("These were left as they are. Your photos are not affected.") };
    default: return { title: one ? t("1 issue needs attention") : t("{count} issues need attention", { count: n }) };
  }
}
/** The finished job (still with errors) a list of errors belongs to, when it can be marked as done. */
function skippableJob(state: AppState, list: DisplayError[]): boolean {
  const jobId = list.find(error => error.jobId)?.jobId;
  return jobId !== undefined && state.jobs.some(job => job.id === jobId && (job.phase === 'error' || job.phase === 'stopped') && !job.stopping);
}
const rowDrive = (row: ErrorRow<DisplayError>) => row.entries[0]!.drive || row.entries[0]!.source;
/** A group as text: its title, then the first paths with their technical detail. */
function rowReport(row: ErrorRow<DisplayError>, t: Translate, formatNumber: (value: number) => string): string {
  const info = groupInfo(row.code, row.count, rowDrive(row), t, formatNumber, row.reasons);
  return [`${row.entries[0]!.source || t("App")}: ${info.title}${info.breakdown ? ` (${info.breakdown})` : ''}`, ...row.items.map(item => `  ${item.path ?? ''}${(item.detail ?? (item.entry ? t(item.entry.message) : '')) ? ' — ' + (item.detail ?? t(item.entry!.message)) : ''}`)].join('\n') + (row.count > row.items.length ? `\n  ${t("and {count} more", { count: formatNumber(row.count - row.items.length) })}` : '');
}
/** The latest handlers of the panel, behind a stable ref so memoized rows do not re-render when only these change. */
type RowApi = { current: { act: Dispatch; copy: (text: string) => void; clear: (ids?: string[], severity?: Severity) => void; onOpenSource?: (sourceId: string) => void } };
const ITEM_PAGE = 200;
/** One group row: title, count, explanation and actions. Its affected paths load only when expanded, 200 at a time. */
const MergedRow = memo(function MergedRow({ row, api, retryable, skippable }: { row: ErrorRow<DisplayError>; api: RowApi; retryable: boolean; skippable: boolean }) {
  const { t, formatNumber } = useTranslation();
  const [open, setOpen] = useState(false), [shown, setShown] = useState(ITEM_PAGE);
  const first = row.entries[0]!, info = groupInfo(row.code, row.count, rowDrive(row), t, formatNumber, row.reasons);
  const visible = open ? row.items.slice(0, shown) : [];
  const copyAll = () => {
    const local = row.entries.flatMap(entry => entry.items ? [] : [pathOf(entry.message) ?? ''].filter(Boolean));
    if (row.count > row.items.length && first.jobId && window.importer?.errorPaths) void window.importer.errorPaths(first.jobId, row.code).then(paths => api.current.copy(paths.join('\n'))).catch(() => {});
    else api.current.copy((local.length ? local : row.items.map(item => item.path ?? '')).join('\n'));
  };
  return <li className={`error-item error-group-row is-${row.severity}`} data-severity={row.severity} data-testid="error-group" data-code={row.code} data-count={row.count}>
    <div className="error-summary"><Icon icon={row.severity === 'error' ? CircleAlert : Info} size={16} /><div><p className="error-title" data-testid="error-group-title">{info.title}</p>{info.breakdown && <p className="error-hint" data-testid="error-group-breakdown">{info.breakdown}</p>}{info.text && <p className="error-hint">{info.text}</p>}</div></div>
    <div className="card-actions error-group-actions">
      <Button kind="quiet" icon={Copy} data-testid="error-group-copy" onClick={() => api.current.copy(rowReport(row, t, formatNumber))}>{t("Copy details")}</Button>
      {first.sourceId && api.current.onOpenSource && <Button kind="quiet" icon={ArrowUpRight} data-testid="error-group-drive" onClick={() => { api.current.onOpenSource!(first.sourceId!); }}>{t("Show drive")}</Button>}
      {retryable && <Button kind="quiet" icon={RotateCcw} data-testid="error-group-retry" onClick={() => api.current.act({ type: 'retryJob', jobId: first.jobId! })}>{t("Retry all")}</Button>}
      {row.code === 'staging-left' && <Button kind="quiet" icon={Trash2} data-testid="error-group-cleanup" onClick={() => api.current.act({ type: 'cleanResidue' })}>{t("Clean up")}</Button>}
      {skippable && <Button kind="quiet" icon={CheckCheck} data-testid="error-group-skip" title={t("Skipping only changes the status. Nothing is deleted.")} onClick={() => api.current.act({ type: 'acknowledgeErrors', jobId: first.jobId!, codes: [row.code] })}>{t("Skip these")}</Button>}
      <Button kind="quiet" icon={X} data-testid="error-group-clear" onClick={() => api.current.clear(row.entries.flatMap(entry => entry.id ? [entry.id] : []), row.severity)}>{t("Clear group")}</Button>
      <Button kind="quiet" icon={open ? ChevronDown : ChevronRight} data-testid="error-group-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? t("Hide affected files") : t("Show affected files")}</Button>
    </div>
    {first.drive && <p className="error-meta"><span><Icon icon={HardDrive} size={13} />{first.drive}</span></p>}
    {open && <>
      <ul className="error-group-items" data-testid="error-group-items">{visible.map((item, index) => <li key={index} className="error-group-item" data-testid="error-group-item">
        <code className="error-path">{item.path ?? t(item.entry!.message)}</code>
        {item.path && <RevealButton path={item.path} act={api.current.act} />}
        <details className="error-details"><summary>{t("Technical detail")}</summary><div><p>{item.detail ?? (item.entry ? t(item.entry.message) : '')}</p></div></details>
      </li>)}</ul>
      <div className="card-actions">
        {shown < row.items.length && <Button kind="quiet" data-testid="error-group-more" onClick={() => setShown(value => value + ITEM_PAGE)}>{t("Show more")}</Button>}
        {row.count > Math.min(shown, row.items.length) && <span className="error-more" data-testid="error-group-remaining">{t("and {count} more", { count: formatNumber(row.count - Math.min(shown, row.items.length)) })}</span>}
        <Button kind="quiet" icon={Copy} data-testid="error-group-copy-paths" onClick={copyAll}>{t("Copy all paths")}</Button>
      </div>
    </>}
  </li>;
}, (a, b) => a.row.key === b.row.key && a.row.count === b.row.count && a.row.entries.length === b.row.entries.length && a.row.severity === b.row.severity && a.retryable === b.retryable && a.skippable === b.skippable && a.api === b.api);

/** The Issues list of Activity: errors, then warnings, each grouped by source or drive. */
export function ActivityPanel({state, errors: allErrors, act, onOpenSource, onClear, target, onShowAll}: {state: AppState; errors: DisplayError[]; act:Dispatch; onOpenSource?: (sourceId: string) => void; /** ids to clear; none clears all. */ onClear?: (ids?: string[], severity?: Severity) => void; /** Shows only this drive's errors. */ target?: ErrorTarget; onShowAll?: () => void}) {
  const { t, formatNumber, language } = useTranslation();
  const errors = useMemo(() => target ? errorsFor(allErrors, target) : allErrors, [allErrors, target]);
  const copy = (text: string) => { void navigator.clipboard?.writeText(text).catch(() => {}); };
  const api = useRef<RowApi['current']>(null as unknown as RowApi['current']);
  const report = (items: DisplayError[]) => buildRows(items).map(row => row.merged ? rowReport(row, t, formatNumber) : row.entries.map(error => [error.at && formatWhen(error.at, language), error.drive, `${error.source || t("App")}: ${t(error.message)}`].filter(Boolean).join(' · ')).join('\n')).join('\n');
  const clear = onClear ?? ((ids?: string[], severity?: Severity) => act({ type: 'clearErrors', ...(ids ? { ids } : {}), ...(severity ? { severity } : {}) }));
  api.current = { act, copy, clear, onOpenSource };
  const section = (severity: Severity) => {
    const items = errors.filter(error => error.severity === severity), plural = severity === 'error' ? 'errors' : 'warnings', rows = buildRows(items);
    const map = new Map<string, DisplayError[]>(); for (const error of items) map.set(error.source, [...(map.get(error.source) ?? []), error]);
    const clearable = items.some(error => error.id && !error.oldDrive);
    const clearShown = () => target ? clear(items.flatMap(error => error.id && !error.oldDrive ? [error.id] : []), severity) : clear(undefined, severity);
    const label = severity === 'error' ? (target ? t("Clear all errors for {name}", { name: target.name }) : t("Clear all errors")) : (target ? t("Clear all warnings for {name}", { name: target.name }) : t("Clear all warnings"));
    return <section className={`error-section is-${severity}`} data-testid={`${plural}-section`} data-severity={severity} aria-labelledby={`${plural}-heading`}>
      <div className="error-section-heading"><h3 id={`${plural}-heading`}>{severity === 'error' ? t("Errors") : t("Warnings")}<span className="error-section-count" data-testid={`${plural}-section-count`}>{formatNumber(rows.length)}</span></h3><div className="card-actions">{items.length > 0 && <Button kind="quiet" icon={Copy} data-testid={`${plural}-copy-all`} onClick={() => copy(report(items))}>{t("Copy all details")}</Button>}{clearable && <Button kind="quiet" icon={Trash2} data-testid={`${plural}-clear-all`} aria-label={label} onClick={clearShown}>{t("Clear all")}</Button>}</div></div>
      {items.length ? <div className="error-groups">{[...map].map(([source, list]) => <section key={source || 'app'} className="error-group">
        <div className="error-group-heading"><strong>{source || t("App")}</strong><span>{list.length === 1 ? t("1 issue") : t("{count} issues", { count: formatNumber(list.length) })}</span>{list[0]!.sourceId && onOpenSource && !list[0]!.formatSourceId && <Button kind="quiet" icon={ArrowUpRight} onClick={() => { onOpenSource(list[0]!.sourceId!); }}>{t("Show drive")}</Button>}{severity === 'error' && skippableJob(state, list) && <Button kind="quiet" icon={CheckCheck} data-testid="job-skip-all" title={t("Skipping only changes the status. Nothing is deleted.")} onClick={() => act({ type: 'acknowledgeErrors', jobId: list.find(error => error.jobId)!.jobId! })}>{t("Skip all and mark as done")}</Button>}</div>
        <ul className="all-errors">{buildRows(list).map((row, index) => {
          if (row.merged) return <MergedRow key={row.key} row={row} api={api} skippable={row.severity === 'error' && skippableJob(state, row.entries)} retryable={row.severity === 'error' && row.entries[0]!.jobId !== undefined && state.jobs.some(job => job.id === row.entries[0]!.jobId && job.phase === 'error' && !!job.retryable)} />;
          const error = row.entries[0]!;
          if (error.formatSourceId) return <li key={index} className="error-item is-warning">{sourceInventories(state).filter(item => item.source.id === error.formatSourceId).map(({source,inventory}) => <UnknownFilesPrompt key={source.id} sourceName={source.name} inventory={inventory} knownRules={{...state.preferences.unknownRules,...state.sessionUnknownRules}} act={act} />)}</li>;
          const explained = explainError(error.message, error.kind, language);
          const shown = pathOf(error.message), retryable = error.jobId !== undefined && state.jobs.some(job => job.id === error.jobId && job.phase === 'error' && !!job.retryable);
          const skippable = error.jobId !== undefined && state.jobs.some(job => job.id === error.jobId && job.phase === 'error' && !!job.skippablePath && job.skippablePath === filePath(error.message));
          return <li key={index} className={`error-item is-${error.severity}`} data-severity={error.severity}>
            <div className="error-summary"><Icon icon={error.severity === 'error' ? CircleAlert : Info} size={16} /><div><p className="error-title">{error.oldDrive ? t(error.message) : t(explained.title)}</p>{explained.hint && !error.oldDrive && <p className="error-hint">{t(explained.hint)}</p>}</div>{error.oldDrive && <Button kind="quiet" data-testid="old-records-acknowledge" aria-label={t("Acknowledge old records")} title={t("Acknowledge old records")} onClick={() => act({ type: 'acknowledgeOldRecords', drive: error.oldDrive! })}>{t("Acknowledge old records")}</Button>}{error.id && !error.oldDrive && <Button kind="quiet" icon={X} data-testid="error-clear" aria-label={t("Clear error: {title}", { title: t(explained.title) })} title={t("Clear")} onClick={() => clear([error.id!], severity)}>{t("Clear")}</Button>}{shown && <RevealButton path={shown} act={act} />}{retryable && <Button kind="quiet" icon={RotateCcw} data-testid="error-retry" title={t("Run this job again, including files that had errors")} onClick={() => act({ type: 'retryJob', jobId: error.jobId! })}>{t("Retry")}</Button>}{skippable && <><Button kind="quiet" icon={ChevronRight} data-testid="error-skip" title={t("Leave this file out and run the job again")} onClick={() => act({ type: 'skip', jobId: error.jobId!, path: filePath(error.message)! })}>{t("Skip")}</Button><Button kind="quiet" icon={Play} data-testid="error-skip-all" title={t("Run again, skipping files with errors")} onClick={() => act({ type: 'skip', all: true, jobId: error.jobId! })}>{t("Skip all")}</Button></>}</div>
            {(error.drive || error.at) && <p className="error-meta">{error.drive && <span aria-label={t("Drive: {name}", { name: error.drive })}><Icon icon={HardDrive} size={13} />{error.drive}</span>}{error.at && <time dateTime={error.at}><Icon icon={Clock3} size={13} />{formatWhen(error.at, language)}</time>}</p>}
            <details className="error-details"><summary>{t("Details")}</summary><div><p>{t(error.message)}</p><Button kind="quiet" icon={Copy} onClick={() => copy(t(error.message))}>{t("Copy")}</Button></div></details>
          </li>;
        })}</ul>
      </section>)}</div> : <p className="error-empty"><Icon icon={severity === 'error' ? CheckCircle2 : Info} size={16} />{severity === 'error' ? t("No errors to show.") : t("No warnings to show.")}</p>}
    </section>;
  };
  const contents = <>{target && <p className="error-filter" data-testid="errors-filter"><Icon icon={HardDrive} size={14} /><span>{t("Errors for {name}", { name: target.name })}</span>{onShowAll && <Button kind="quiet" onClick={onShowAll}>{t("Show all errors")}</Button>}</p>}<div className="activity-content">{section('error')}{section('warning')}</div></>;
  return <section className="activity-issues" data-testid="activity-panel" aria-label={t("Issues")}>{contents}</section>;
}

/** The combined speed of running jobs, for the overview's Transfer speed and its Total line alike. One rule: jobs moving data (copying,
 * verifying, moving, removing) count with their MB/s and files/s; planning reads the source and moves nothing, so it adds no MB/s.
 * While every job is still planning, only the files/s of its metadata checking is shown. Verification is labelled as read. */
export function combinedSpeed(jobs: Job[]): Required<Pick<SpeedInput, 'speed' | 'fileRate'>> & Pick<SpeedInput, 'phase' | 'step'> {
  const running = jobs.filter(job => job.progress);
  const moving = running.filter(job => job.progress!.phase !== 'planning');
  const counted = moving.length ? moving : running.filter(job => job.progress!.step === 'checking');
  const sum = (pick: (progress: Progress) => number | undefined) => counted.reduce((total, job) => total + (pick(job.progress!) ?? 0), 0);
  const verifying = moving.length > 0 && moving.every(job => job.progress!.phase === 'verifying' && !job.progress!.step);
  return { speed: moving.length ? sum(progress => progress.speed) : 0, fileRate: sum(progress => progress.fileRate), ...(verifying ? { phase: 'verifying' as const } : {}) };
}
// Import desk statistics. Source jobs show their own progress on their cards, so only library organization jobs are listed here.
export function ImportDashboard({state, act}: {state: AppState; act: Dispatch}) {
  const { t } = useTranslation();
  // Collapsed, one slim line stays where the overview was so it can be reopened from there.
  if (!state.preferences.showDashboard) return <section className="import-dashboard import-dashboard-collapsed" aria-label={t("Import dashboard")}><div className="dashboard-heading"><div className="dashboard-title"><h2>{t("Import overview")}</h2><Button kind="quiet" icon={ChevronDown} className="dashboard-hide" data-testid="dashboard-toggle" aria-expanded={false} aria-label={t("Show the import overview")} title={t("Show the import overview")} onClick={() => act({ type: 'preferences', patch: { showDashboard: true } })} /></div></div></section>;
  return <ImportDashboardPanel state={state} act={act} />;
}
function ImportDashboardPanel({state, act}: {state: AppState; act: Dispatch}) {
  const { t, language, formatNumber, formatBytes: bytes } = useTranslation();
  const jobs = state.jobs, active = jobs.filter(job => isRunning(job)), queued = jobs.filter(job => job.phase === 'queued');
  const latestJobs = jobs.filter((job,index) => jobs.findIndex(item => item.source.id === job.source.id) === index);
  // Bytes count only once copying starts: planning measures the source, not the transfer.
  const transferring = latestJobs.filter(job => job.progress && job.progress.phase !== 'planning' && !job.progress.renames);
  const transferred = transferring.reduce((sum,job) => sum + (job.progress?.bytes ?? 0),0), total = transferring.reduce((sum,job) => sum + (job.progress?.totalBytes ?? 0),0);
  // One rule for the Transfer speed metric and the Total line.
  const { speed, fileRate } = combinedSpeed(active);
  const startedAt = active.map(job => job.startedAt).filter(Boolean).sort()[0];
  // What the files count counts depends on the step every running job is on.
  const doing = new Set(active.map(job => { const p = job.progress; return !p ? 'processed' : p.phase === 'planning' ? 'checked' : p.phase === 'verifying' ? 'verified' : p.renames ? 'moved' : 'copied'; }));
  const filesLabel = doing.size === 1 ? ({ checked: "Files checked", verified: "Files verified", moved: "Files moved", copied: "Files copied", processed: "Files processed" } as const)[[...doing][0] as 'checked'] : "Files processed";
  // Warnings come only from the log main publishes (local window errors are errors), so this is the title badge's count.
  const warnings = (state.errorLog?.entries ?? []).filter(error => error.severity === 'warning').length;
  const lead = active.find(job => job.progress);
  // Jobs run side by side, so the longest one sets the time left; queued sources are not counted yet.
  // Jobs sharing a destination drive that is the bottleneck finish sooner together than the longest alone (the main process decides).
  const raw = active.length && active.every(job => job.eta !== undefined) ? state.etaTotal?.eta : undefined, remaining = useHeld()('total', raw);
  const needDestinations = requiredDestinations(state.preferences);
  const configured = state.preferences.destinations.length >= needDestinations;
  const { ready: readyDestinations, checking: checkingDestinations } = destinationReadiness(state);
  // Drives in use: those of running jobs and the destinations they write to; with nothing running, every connected drive.
  const driveTotal = totalDriveActivity(state, active.length ? [...active.map(job => job.source.id), ...state.preferences.destinations.slice(0, needDestinations)] : Object.keys(state.driveActivity ?? {}));
  const organizationJobs = jobs.filter(job => job.organization);
  const organizing = active.length > 0 && active.every(job => job.organization);
  // Every job's whole work (checking, copying, verifying) moves the total, each weighted by its size; 100% only when all are complete.
  const verify = state.preferences.verifyCopies;
  // The total line shows one job's counter when there is one job, or when nothing is transferred yet to count in bytes: then its percent and bar are that job's too.
  const leadOnly = !!lead?.progress && (latestJobs.length === 1 || !(total > 0 && transferred > 0));
  const overall = leadOnly ? cardFraction(lead!) : overviewFraction(latestJobs);
  // No job, no planned bytes: only "No transfer planned" is shown, with an empty bar and no percentage.
  const nothingPlanned = !(total > 0 && transferred > 0) && !lead?.progress && !active.length && overall === undefined;
  const doneFiles = (job: Job) => job.progress ? (doing.size === 1 && doing.has('copied') ? copyBasis(job.progress).completed : job.progress.completed) : 0;
  // Each overview note also serves as its own tooltip; the notes reserve two lines so the cells line up.
  const parallelNote = t("Drives at once: {count}/10", { count: formatNumber(state.preferences.parallel) });
  const speedNote = active.length ? t("Combined active sources") : t("No active transfers");
  const completeCount = formatNumber(latestJobs.filter(job=>job.phase==='complete').length), errorCount = formatNumber(latestJobs.filter(job=>job.phase==='error').length);
  const filesNote = warnings > 0 ? t("{complete} sources complete · {errors} need attention · {warnings} warnings", { complete: completeCount, errors: errorCount, warnings: formatNumber(warnings) }) : t("{complete} sources complete · {errors} need attention", { complete: completeCount, errors: errorCount });
  const destinationsNote = readyDestinations.length ? t("{size} free across destinations", { size: bytes(readyDestinations.reduce((sum,disk)=>sum+(disk.free??0),0)) }) : checkingDestinations ? t("Checking destinations…") : t("Choose a backup destination");
  return (<section className="import-dashboard" aria-label={t("Import dashboard")}>
      <div className="dashboard-heading"><div className="dashboard-title"><h2>{t("Import overview")}</h2><Button kind="quiet" icon={ChevronUp} className="dashboard-hide" data-testid="dashboard-toggle" aria-expanded aria-label={t("Hide the import overview")} title={t("Hide the import overview")} onClick={() => act({ type: 'preferences', patch: { showDashboard: false } })} /></div><span className={`status-pill ${active.length ? 'status-working' : ''}`}><Icon icon={active.length ? (organizing ? FolderCog : ArrowDownToLine) : state.review ? Eye : Pause} size={15}/>{active.length ? t(organizing ? "Organizing" : "Transfers running") : state.review ? t("Review pending") : t("Idle")}</span>{!state.preferences.verifyCopies && <span className="status-pill status-caution" data-testid="verification-off"><Icon icon={ShieldOff} size={14}/>{t("Verification after copy is off")}</span>}</div>
      <dl className="dashboard-metrics">
        <div><dt><Icon icon={Camera} size={16}/>{t("Connected sources")}</dt><dd data-metric="sources">{state.sources.length}</dd></div>
        <div><dt><Icon icon={Layers3} size={16}/>{t("Active / queued")}</dt><dd>{active.length} <span>/ {queued.length}</span></dd><small className="metric-optional" title={parallelNote}><span data-testid="parallel-summary" title={`${parallelNote} · ${t("Current copies finish before a lower limit takes effect.")}`}>{parallelNote}</span></small></div>
        <div><dt><Icon icon={Gauge} size={16}/>{t("Transfer speed")}</dt><dd>{speed > 0 ? <Speed value={speed} /> : fileRate > 0 ? <FileRate value={fileRate} /> : '—'}</dd><small className="metric-optional" title={speedNote}>{speedNote}</small></div>
        <div><dt><Icon icon={CheckCheck} size={16}/>{t(filesLabel)}</dt><dd>{latestJobs.reduce((sum,job)=>sum+doneFiles(job),0).toLocaleString(language)}</dd><small title={filesNote}>{filesNote}</small></div>
        <div><dt><Icon icon={HardDrive} size={16}/>{t("Destinations ready")}</dt><dd data-metric="destinations">{readyDestinations.length} / {needDestinations}</dd><small className="metric-optional" title={destinationsNote}>{destinationsNote}</small></div>
        {driveTotal && <div><dt><Icon icon={Activity} size={16}/>{t("Drive activity")}</dt><dd data-metric="drive-activity">{Math.round(driveTotal.utilization)}%</dd><small className="metric-optional" title={t("Whole disk, all apps; may include metadata and receipts")}>{t("Read {read} · Write {write}", { read: formatSpeed(driveTotal.readBps, language), write: formatSpeed(driveTotal.writeBps, language) })}</small></div>}
      </dl>
      <ProgressDisplay className="dashboard-total" testId="total-progress" etaTestId="total-eta" label={t("Combined copy progress")}
        heading={<strong className="dashboard-total-title">{t("Total progress")}</strong>}
        empty={nothingPlanned} fraction={overall ?? (active.length ? undefined : 0)} finished={!active.length && latestJobs.length > 0 && latestJobs.every(job => ended(job) && cardFraction(job) === 1)}
        count={leadOnly ? `${leadStatus(lead!, t)} · ${lead!.source.name} · ${progressCount(lead!.progress!, t, formatNumber, !!lead!.organization, bytes)}` : total > 0 && transferred > 0 ? `${bytes(transferred)} ${t("of {size} planned", { size: bytes(total) })}` : active.length ? undefined : t("No transfer planned")}
        speed={combinedSpeed(active)}
        startedAt={startedAt} left={remaining !== undefined ? t(queued.length ? "{time} left, not counting queued sources" : "{time} left", { time: formatEstimate(remaining, t, scaledRange(state.etaTotal && state.etaTotal.low !== undefined && state.etaTotal.high !== undefined ? { low: state.etaTotal.low, high: state.etaTotal.high } : undefined, raw!, remaining)) }) : undefined}
        step={stepKind(lead?.progress)} stages={leadOnly ? jobStageLayers(lead!, verify) : totalStageLayers(latestJobs, verify)} paused={totalPaused(latestJobs)} />
      {(!configured || readyDestinations.length < needDestinations || !!state.review) && <div className="dashboard-next-step"><Icon icon={(state.review && configured && readyDestinations.length >= needDestinations) || (configured && checkingDestinations && readyDestinations.length < needDestinations) ? Info : CircleAlert} size={17}/><p>{!configured ? t(needDestinations === 2 ? "{count} sources connected. Choose two backup destinations to enable imports." : "{count} sources connected. Choose a backup destination to enable imports.", { count: formatNumber(state.sources.length) }) : readyDestinations.length<needDestinations ? t(checkingDestinations ? "Checking destinations…" : "A destination is offline. Reconnect it to import.") : t("Apply or discard the review.")}</p>{!configured && <Button icon={Plus} onClick={()=>act({type:'chooseDestination',index:state.preferences.destinations[0]?1:0})}>{t("Choose destination")}</Button>}</div>}
      {organizationJobs.length > 0 && <ul className="progress-jobs">{organizationJobs.map(job => <li key={job.id}><div className="progress-job-heading"><strong>{t("Library organization")}</strong><span className="progress-job-place" title={organizationPlace(job, true)}>{organizationPlace(job)}</span></div><span className="progress-job-status">{organizationStatus(job, t)}</span><OrganizationProgress job={job} act={act} showFile={false} /></li>)}</ul>}
    </section>);
}

export type SettingsCategory = 'general' | 'storage' | 'folders' | 'defaults' | 'files' | 'devices' | 'performance' | 'diagnostics';
export const settingsCategories: SettingsCategory[] = ['general', 'storage', 'folders', 'defaults', 'files', 'devices', 'performance', 'diagnostics'];
function savedCategory(): SettingsCategory {
  try {
    const value = sessionStorage.getItem('settings-category');
    const legacy: Record<string, SettingsCategory> = { importing: 'defaults', destinations: 'storage', organization: 'files', drives: 'devices' };
    if (value && settingsCategories.includes(value as SettingsCategory)) return value as SettingsCategory;
    return value && Object.hasOwn(legacy, value) ? legacy[value] : 'general';
  } catch { return 'general'; }
}
// Leftovers of interrupted runs on the connected destinations, removed automatically while nothing
// runs; Clean up looks again now and also removes copies a re-import could continue.
export function LeftoverFiles({ state, act, busy }: { state: AppState; act: Dispatch; busy: boolean }) {
  const { t, formatNumber, formatBytes } = useTranslation();
  const residue = state.residue;
  const files = (count: number) => count === 1 ? t("1 leftover file") : t("{count} leftover files", { count: formatNumber(count) });
  const status = residue?.checking ? t("Looking for leftover files…") : !residue?.checkedAt ? t("Not checked yet.") : residue.files ? `${files(residue.files)} · ${formatBytes(residue.bytes)}` : t("No leftover files.");
  return <div data-testid="residue-cleanup">
    <div className="settings-row"><span>{status}</span><Button icon={Trash2} disabled={busy || !!residue?.checking} title={busy ? t("Locked while an import, organization or review is active, including paused or queued ones. Finish or stop them to change this.") : undefined} onClick={() => act({ type: 'cleanResidue' })}>{t("Clean up")}</Button></div>
    {residue?.checking && <OperationProgress progress={residue.progress} label={t("Leftover files progress")} testId="residue-progress" />}
    {!!residue?.resumable.files && <p className="settings-row-note">{t("{count} can continue when that card is imported again ({size}). Automatic cleanup keeps them; Clean up removes them too.", { count: formatNumber(residue.resumable.files), size: formatBytes(residue.resumable.bytes) })}</p>}
    {!!residue?.kept?.files && <p className="settings-row-note">{t("{count} copies could not be proven unneeded ({size}). Automatic cleanup keeps them; Clean up removes them too.", { count: formatNumber(residue.kept.files), size: formatBytes(residue.kept.bytes) })}</p>}
    {!!residue?.recoverable?.files && <p className="settings-row-note" data-testid="residue-recoverable">{t("{count} complete copies whose card file changed are kept: {folder}", { count: formatNumber(residue.recoverable.files), folder: residue.recoverable.folder ?? '' })}</p>}
    {residue?.unbound?.paths.map(file => <p key={file} className="settings-row-note" data-testid="residue-unbound">{t("A file at {path} has an old copy receipt that no longer matches it; the file is kept. Remove the receipt so imports can continue.", { path: file })} <Button disabled={busy || !!residue.checking} onClick={() => act({ type: 'removeReceipt', file })}>{t("Remove receipt")}</Button></p>)}
    {!!residue?.unbound && residue.unbound.files > residue.unbound.paths.length && <p className="settings-row-note">{t("{count} more files have an old copy receipt. Clean up removes those receipts too; the files are kept.", { count: formatNumber(residue.unbound.files - residue.unbound.paths.length) })}</p>}
    {residue?.cleaned && <p className="settings-row-note">{t("Last cleanup removed {files} ({size}).", { files: files(residue.cleaned.files), size: formatBytes(residue.cleaned.bytes) })}</p>}
    <p className="settings-row-note">{t("Staging files from interrupted imports, organization scratch copies and camera downloads are removed automatically when nothing is running. Originals kept for undo stay until you release them.")}</p>
  </div>;
}
// Settings: a category list with live summaries, and the open category's controls beside it.
export function SettingsPage({state,act,busy,requestedCategory,requestKey,onLibrary}:{state:AppState;act:Dispatch;busy:boolean;requestedCategory?:SettingsCategory;requestKey?:number;onLibrary?:()=>void}) {
  const p = state.preferences;
  const { t, formatNumber } = useTranslation();
  const [open, setOpen] = useState<SettingsCategory>(() => requestedCategory ?? savedCategory());
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
  // A repeated deep link must work while Settings remains mounted, even after a local tab change.
  useEffect(() => {
    if (requestedCategory) choose(requestedCategory, true);
  }, [requestedCategory, requestKey]);
  const copyModes: Record<CopyMode, string> = { single: t("One destination"), mirror: t("Copy to both destinations"), sequential: t("Fill first, then second") };
  const categories: { id: SettingsCategory; icon: LucideIcon; title: string; summary: string }[] = [
    { id: 'general', icon: Settings2, title: t("General"), summary: `${localeNames[p.language] ?? p.language} · ${Math.round(p.textScale * 100)}%` },
    { id: 'storage', icon: HardDrive, title: t("Storage"), summary: p.destinations.length ? `${p.destinations.map(path => basename(path)).join(' + ')} · ${copyModes[p.copyMode]}` : t("Not set") },
    { id: 'folders', icon: FolderCog, title: t("Folders"), summary: [...p.basePath.split(/[\\/]/).filter(Boolean), ...samplePath(p.template)].join(' / ') },
    { id: 'defaults', icon: ArrowDownToLine, title: t("Importing"), summary: `${p.automatic ? t("Automatic") : t("Manual")} · ${p.verifyCopies ? t("Verify each copy after copying") : t("Copying")}` },
    { id: 'files', icon: FileQuestion, title: t("File handling"), summary: t("Metadata and file rules") },
    { id: 'devices', icon: Usb, title: t("Devices"), summary: t("{count} remembered", { count: formatNumber(Object.keys(p.rememberedDevices).length) }) },
    { id: 'performance', icon: Gauge, title: t("Performance"), summary: t("{count} at once", { count: formatNumber(p.parallel) }) },
    { id: 'diagnostics', icon: Activity, title: t("Diagnostics"), summary: { off: t("Off"), normal: t("Normal"), detailed: t("Detailed"), trace: t("Trace") }[p.logLevel ?? 'normal'] },
  ];
  const lockTip = busy ? t("Locked while an import, organization or review is active, including paused or queued ones. Finish or stop them to change this.") : undefined;
  const lockId = (category: SettingsCategory) => busy ? `settings-lock-note-${category}` : undefined;
  const lockNote = (category: SettingsCategory) => busy ? <p className="source-notice settings-lock-note" id={lockId(category)} data-testid="settings-lock-note"><Icon icon={Info} size={14} />{t("Some settings are locked while work is active.")}</p> : null;
  const panels: Record<SettingsCategory, ReactNode> = {
    general: <>
      <section className="settings-section"><CardHeader icon={Settings2} title={t("General")} /><div className="settings-section-content settings-rows">
        <div className="settings-row"><label htmlFor="app-language">{t("App language")}</label><div className="select-wrap"><select id="app-language" value={p.language ?? 'en'} onChange={event => act({ type: 'preferences', patch: { language: event.target.value as Preferences['language'] } })}>{Object.entries(localeNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><Icon icon={ChevronDown} size={15} /></div></div>
        <div className="settings-row readability-settings"><label htmlFor="text-size">{t("Text size")}</label><div className="text-size-control"><input id="text-size" aria-label={t("Text size")} type="range" min="100" max="200" step="5" value={Math.round(p.textScale*100)} onChange={event=>act({type:'preferences',patch:{textScale:Number(event.target.value)/100}})} /><strong>{Math.round(p.textScale * 100)}%</strong>{p.textScale !== 1.25 && <Button kind="quiet" onClick={()=>act({type:'preferences',patch:{textScale:1.25}})}>{t("Reset text size")}</Button>}</div><small className="settings-row-note">{t("Large sizes shrink to fit small windows.")}</small></div>
        <div className="settings-row"><span>{t("Appearance")}</span><AppearanceControls preferences={p} act={act}/></div>
      </div></section>
    </>,
    storage: <>{lockNote('storage')}<fieldset className="settings-fieldset" disabled={busy} title={lockTip} aria-describedby={lockId('storage')}>
      <SettingsSection title={t("Backup location")} icon={HardDrive}><DestinationBay state={state} act={act} configure onLibrary={onLibrary} /></SettingsSection>
    </fieldset></>,
    folders: <>{lockNote('folders')}<fieldset className="settings-fieldset" disabled={busy} title={lockTip} aria-describedby={lockId('folders')}><FolderSettings state={state} act={act} /></fieldset></>,
    defaults: <>
      {lockNote('defaults')}
      <SettingsSection title={t("Starting imports")} icon={Radio}>
        <Switch checked={p.automatic} onChange={automatic => act({ type: 'preferences', patch: { automatic } })} label={t("Automatic import")} detail={t("Imports start as soon as a selected drive connects.")} />
      </SettingsSection>
      <fieldset className="settings-fieldset" disabled={busy} title={lockTip} aria-describedby={lockId('defaults')}>
        <SettingsSection title={t("Copying")} icon={ShieldCheck}>
          <Switch checked={p.verifyCopies} onChange={verifyCopies => act({ type: 'preferences', patch: { verifyCopies } })} label={t("Verify each copy after copying")} detail={t("Reads each copy back to confirm it. Off is faster.")} />
          <Switch checked={p.skipFileErrors} onChange={skipFileErrors => act({ type: 'preferences', patch: { skipFileErrors } })} label={t("Skip files with errors and continue")} detail={t("A file that can't be read or changes while it is checked is listed in All errors and left out; the other files are still copied. Off stops the import at the first such file.")} />
        </SettingsSection>
        <SettingsSection title={t("Drive backups")} icon={Copy}><BackupModeControl preferences={p} act={act} /></SettingsSection>
      </fieldset>
      {/* After an import, in the order it happens: Delete originals is offered, then the drive is ejected. */}
      <SettingsSection title={t("After an import")} icon={Trash2}>
        <h4 className="path-builder-heading">{t("Delete originals")}</h4>
        <Switch checked={p.deleteOriginalsFolders} onChange={deleteOriginalsFolders => act({ type: 'preferences', patch: { deleteOriginalsFolders } })} label={t("Offer for folders")} detail={t("After an import, offers to delete only the files verified by checksum in the backup, with a two-step confirmation.")} />
        <Switch checked={p.deleteOriginalsCards} onChange={deleteOriginalsCards => act({ type: 'preferences', patch: { deleteOriginalsCards } })} label={t("Offer for SD cards and drives")} detail={t("After an import, offers to delete only the files verified by checksum in the backup, with a two-step confirmation. Off by default.")} />
        <h4 className="path-builder-heading">{t("Ejecting drives")}</h4>
        <Switch checked={p.autoEject} onChange={autoEject => act({ type: 'preferences', patch: { autoEject } })} label={t("Eject drives automatically after a clean import")} detail={t("Cards and drives are ejected once every file is copied and verified with no errors, after Delete originals if that is offered. Folders and cameras are never ejected.")} />
      </SettingsSection>
    </>,
    files: <>{lockNote('files')}<fieldset className="settings-fieldset" disabled={busy} title={lockTip} aria-describedby={lockId('files')}>
      <SettingsSection title={t("Files without date or camera")} icon={FileQuestion}><NoMetadataSettings preferences={p} act={act} /></SettingsSection>
      <SettingsSection title={t("Unrecognized file types")} icon={FileQuestion}><FileRules preferences={p} act={act} /></SettingsSection>
      <SettingsSection title={t("Same name, different content")} icon={Files}><ConflictNamingSettings preferences={p} act={act} /></SettingsSection>
      <SettingsSection title={t("Problem files")} icon={FileQuestion}><div data-testid="collect-problem-files-setting"><Switch checked={p.collectProblemFiles} onChange={collectProblemFiles => act({ type: 'preferences', patch: { collectProblemFiles } })} label={t("Collect problem files")} detail={t("Move 0-byte files and their companions into Problem files. Undo puts them back.")} /></div><Switch checked={p.removeAppleDouble} onChange={removeAppleDouble => act({ type: 'preferences', patch: { removeAppleDouble } })} label={t("Remove macOS ._ files")} detail={t("Deletes the hidden ._ files macOS leaves beside copied and organized files on exFAT and FAT drives, only when they hold no tags or other data.")} /></SettingsSection>
    </fieldset></>,
    devices: <><RememberedDrives preferences={p} act={act} /><IgnoredDrives preferences={p} act={act} /></>,
    performance: <>
      {lockNote('performance')}
      <SettingsSection title={t("Drives at once")} icon={Radio}><div className="settings-row"><label htmlFor="settings-parallel">{t("Drives at once")}</label><div className="text-size-control"><input id="settings-parallel" type="range" min={1} max={10} step={1} value={p.parallel} onChange={event => act({ type: 'preferences', patch: { parallel: Number(event.target.value) } })} /><strong>{formatNumber(p.parallel)}</strong></div></div><p className="settings-row-note" data-testid="parallel-lower-note">{t("Current copies finish before a lower limit takes effect.")}</p></SettingsSection>
      <fieldset className="settings-fieldset" disabled={busy} title={lockTip} aria-describedby={lockId('performance')}>
        <SettingsSection title={t("CPU and memory")} icon={Gauge}><PerformanceSettings state={state} act={act} /></SettingsSection>
      </fieldset>
    </>,
    diagnostics: <SettingsSection title={t("Diagnostics")} icon={Activity}><DiagnosticsSettings state={state} act={act} /></SettingsSection>,
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
    if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); choose(settingsCategories[event.key === 'Home' ? 0 : settingsCategories.length - 1], true); return; }
    if (!step) return;
    event.preventDefault();
    choose(settingsCategories[(settingsCategories.indexOf(chosen.current) + step + settingsCategories.length) % settingsCategories.length], true);
  };
  return <div className="settings-page settings-layout">
    <nav className="settings-nav" aria-label={t("Settings categories")}><div ref={tabs} role="tablist" aria-orientation="vertical" onKeyDown={onKeyDown}>{categories.map(category => <button type="button" role="tab" key={category.id} id={`settings-tab-${category.id}`} data-testid={`settings-tab-${category.id}`} aria-selected={open === category.id} aria-controls={`settings-panel-${category.id}`} tabIndex={open === category.id ? 0 : -1} onClick={() => choose(category.id)}>{open === category.id && <span className="settings-indicator" aria-hidden="true" />}<span className="settings-nav-icon" style={{viewTransitionName:`settings-${category.id}-icon`}}><Icon icon={category.icon} size={16} /></span><span className="settings-nav-text" style={{viewTransitionName:`settings-${category.id}-text`}}><strong>{category.title}</strong><small>{category.summary}</small></span></button>)}</div></nav>
    <div className="settings-panels">{categories.map(category => <section key={category.id} className="settings-panel" role="tabpanel" id={`settings-panel-${category.id}`} aria-labelledby={`settings-tab-${category.id}`} data-testid={`settings-panel-${category.id}`} hidden={open !== category.id}><h2 className="settings-panel-title">{category.title}</h2>{panels[category.id]}</section>)}</div>
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
  const devices = Object.entries(preferences.ignoredDevices).sort(([, a], [, b]) => b.ignoredAt.localeCompare(a.ignoredAt));
  return <SettingsSection title={t("Ignored drives")} icon={EyeOff}>
    <div className="saved-rules remembered-devices" data-testid="ignored-devices">{devices.length ? devices.map(([id, device]) => <div key={id}><span className="extension-name">{device.name}</span><span className="muted">{t("Ignored {date}", { date: formatWhen(device.ignoredAt, language) })}</span><Button kind="quiet" icon={RotateCcw} aria-label={t("Stop ignoring {name}", { name: device.name })} onClick={() => forgetDevice(act, id)}>{t("Stop ignoring")}</Button></div>) : <p className="muted">{t("No ignored drives.")}</p>}</div>
  </SettingsSection>;
}

// A clearly labelled on/off control for whether a drive takes part in imports.
function SourceSelect({ source, act, disabled = false }: { source: Source; act: Dispatch; disabled?: boolean }) {
  const { t } = useTranslation();
  const on = sourceSelected(source);
  return <input type="checkbox" className="source-select" data-testid="source-select" checked={on} disabled={disabled} aria-label={on ? t("Don't import this drive") : t("Import this drive")} title={on ? t("Don't import this drive") : t("Import this drive")} onChange={() => selectSource(act, source.id, !on)} />;
}

// Same-volume organizations are renames that keep nothing but can still be undone;
// cross-filesystem ones keep originals until they are released.
export function RetainedOriginals({ job, act, busy, recoverySize }: { job: NonNullable<AppState['organizationRecovery']>[number]; act: Dispatch; busy: boolean; recoverySize?: AppState['recoverySize'] }) {
  const { t, formatNumber, formatBytes: bytes } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [deleteStep, setDeleteStep] = useState<DeleteRecoveryStep>('closed');
  const retainedFiles = job.retainedFiles ?? 0;
  const deletable = recoveryDeletable(job);
  if (!retainedFiles && !job.undoable && !job.missing && !deletable) return null;
  const measured = recoverySize?.root === job.root && recoverySize.id === job.id ? recoverySize : undefined;
  const deleteChoice = (choice: 'open' | 'confirm' | 'cancel') => {
    const next = nextConfirmStep(deleteStep, choice);
    if (choice === 'open') act({ type: 'measureOrganizationRecovery', root: job.root, id: job.id });
    setDeleteStep(next.step);
    if (next.delete) act({ type: 'recovery', op: 'delete', root: job.root, id: job.id });
  };
  const size = bytes(job.retainedBytes ?? 0);
  return <section className="organization-retained" data-testid="organization-retained">
    {retainedFiles > 0 && <p><Icon icon={Info} size={15} />{t("{count} originals ({size}) kept for undo.", { count: formatNumber(retainedFiles), size })}</p>}
    {(job.missing ?? 0) > 0 && <p><Icon icon={Info} size={15} />{t("{count} organized files are no longer where this organization put them.", { count: formatNumber(job.missing!) })}</p>}
    <div className="rule-actions">
      {job.undoable && <Button icon={RotateCcw} disabled={busy} onClick={() => act({ type: 'recovery', op: 'undo', root: job.root, id: job.id })}>{t("Undo organization")}</Button>}
      {retainedFiles > 0 && <Button icon={Trash2} disabled={busy || !job.finalizable} onClick={() => setConfirming(true)}>{t("Release {size}", { size })}</Button>}
      <Button kind="danger" icon={Trash2} data-testid="delete-recovery" disabled={busy || !deletable} title={deletable ? undefined : t("Finish or undo this organization before deleting its recovery files.")} onClick={() => deleteChoice('open')}>{t("Delete recovery files")}</Button>
    </div>
    {confirming && <ReleaseConfirm size={size} root={job.root} onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); act({ type: 'recovery', op: 'finalize', root: job.root, id: job.id }); }} />}
    {deleteStep !== 'closed' && <DeleteRecoveryConfirm key={deleteStep} step={deleteStep} root={job.root} size={measured} onCancel={() => deleteChoice('cancel')} onConfirm={() => deleteChoice('confirm')} />}
  </section>;
}


/** Only a finished, replaced or fully undone organization's recovery files can be deleted. */
export const recoveryDeletable = (job: NonNullable<AppState['organizationRecovery']>[number]) => !job.error && (job.status === 'complete' || job.status === 'superseded' || job.status === 'undone');

export function DeleteRecoveryConfirm({ step, root, size, onCancel, onConfirm }: { step: 'first' | 'second'; root: string; size?: AppState['recoverySize']; onCancel: () => void; onConfirm: () => void }) {
  const { t, formatNumber, formatBytes: bytes } = useTranslation();
  const measured = size?.files !== undefined && size.bytes !== undefined;
  const amount = measured ? { count: formatNumber(size.files!), size: bytes(size.bytes!) } : undefined;
  const detail = size?.error ? <p className="field-error">{t(size.error)}</p> : amount ? undefined : <p className="muted">{size?.progress ? t("Measuring: {completed} files", { completed: formatNumber(size.progress.completed) }) : t("Measuring recovery files…")}</p>;
  return <ConfirmSheet step={step} title={step === 'first' ? t("Delete recovery files for this organization?") : t("Delete recovery files permanently?")} confirmLabel={step === 'first' ? t("Continue…") : t("Delete permanently")} confirmDisabled={!amount} testId={`delete-recovery-${step}`} onCancel={onCancel} onConfirm={onConfirm}>
    {step === 'first' ? <><p>{t("You will no longer be able to undo it.")}</p>{amount && <p>{t("{size} will be freed.", { size: amount.size })}</p>}</> : amount && <p>{t("This permanently deletes {count} files ({size}) of recovery data. This cannot be undone.", amount)}</p>}
    {detail}<p className="recovery-root">{root}</p>
  </ConfirmSheet>;
}

// What to do with files that have no capture date, no camera and no known origin, or unreadable metadata.
export function NoMetadataSettings({ preferences: p, act }: { preferences: Preferences; act: Dispatch }) {
  const { t } = useTranslation();
  const current = p.noMetadataHandling, folder = p.noMetadataFolder;
  const [draft, setDraft] = useState(folder);
  useEffect(() => setDraft(folder), [folder]);
  const choices: { value: NonNullable<Preferences['noMetadataHandling']>; label: string; detail: string }[] = [
    { value: 'folder', label: t("Move to a folder"), detail: t("Organized or copied into one folder directly under your library, keeping their subfolders.") },
    { value: 'keep', label: t("Leave where they are"), detail: t("Not moved or copied, and Delete originals never removes them. You are warned before a job starts.") },
    { value: 'fileDate', label: t("Use file date"), detail: t("Filed by the file's modified date, in a camera folder with the folder name below.") },
  ];
  const valid = validNoMetadataFolder(draft, [p.editedFolder, p.basePath, p.videoBasePath]);
  return <div className="backup-mode" data-testid="no-metadata-settings">
    <span className="field-label">{t("Files with unknown metadata")}</span>
    <div className="segmented" role="group" aria-label={t("Files with unknown metadata")}>{choices.map(choice => <button key={choice.value} type="button" aria-pressed={current === choice.value} onClick={() => act({ type: 'preferences', patch: { noMetadataHandling: choice.value } })}>{choice.label}</button>)}</div>
    <p className="settings-explanation">{choices.find(choice => choice.value === current)!.detail}</p>
    <div className="settings-row"><label htmlFor="settings-no-metadata-folder">{t("Unknown files folder name")}</label><input id="settings-no-metadata-folder" value={draft} aria-invalid={!valid} onChange={event => setDraft(event.target.value)} onBlur={() => { if (valid && draft !== folder) act({ type: 'preferences', patch: { noMetadataFolder: draft } }); }} />{!valid && <p className="settings-explanation field-error" role="alert" data-testid="no-metadata-folder-error">{t("Use one folder name: no slashes or special characters, not a date or year, and not a folder the app uses. The saved name stays in use until this is fixed.")}</p>}</div>
  </div>;
}

function UnknownDefaultControl({ preferences, act }: { preferences: Preferences; act: Dispatch }) {
  const { t } = useTranslation();
  const current = preferences.unknownDefault;
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

// A file whose name is taken at the destination by a file with other content (imports, drive backups and organizing).
export function ConflictNamingSettings({ preferences, act }: { preferences: Preferences; act: Dispatch }) {
  const { t } = useTranslation();
  const current = preferences.conflictNaming;
  const choices: { value: ConflictNaming; label: string; detail: string }[] = [
    { value: 'folder', label: t("Conflicts folder"), detail: t("Saved with its own name in a Conflicts folder inside the camera folder, one subfolder per file.") },
    { value: 'number', label: t("Add a number"), detail: t("Saved beside the other file with a number: IMG_0001 (1).JPG, then (2). Its sidecars get the same number.") },
  ];
  return <div className="backup-mode" data-testid="conflict-naming-settings">
    <div className="segmented" role="group" aria-label={t("Same name, different content")}>{choices.map(choice => <button key={choice.value} type="button" aria-pressed={current === choice.value} onClick={() => act({ type: 'preferences', patch: { conflictNaming: choice.value } })}>{choice.label}</button>)}</div>
    <p className="settings-explanation">{choices.find(choice => choice.value === current)!.detail}</p>
  </div>;
}

function BackupModeControl({ preferences, act }: { preferences: Preferences; act: Dispatch }) {
  const { t } = useTranslation();
  const mode = preferences.backupMode;
  const mirrorBlocked = preferences.copyMode === 'sequential';
  const modes: { value: BackupMode; label: string; detail: string }[] = [
    { value: 'additive', label: t("Additive"), detail: t("Deleted files stay in the backup.") },
    { value: 'mirror', label: t("Mirror"), detail: t("Backup matches the drive. Removed files are moved aside, not deleted.") },
  ];
  return <div className="backup-mode" data-testid="backup-mode">
    <div className="segmented" role="group" aria-label={t("Drive backup mode")}>{modes.map(item => <button key={item.value} type="button" aria-pressed={mode === item.value} disabled={item.value === 'mirror' && mirrorBlocked && mode !== 'mirror'} onClick={() => act({ type: 'preferences', patch: { backupMode: item.value } })}>{item.label}</button>)}</div>
    <p className="settings-explanation">{modes.find(item => item.value === mode)!.detail}</p>
    {mirrorBlocked && <p className="inline-note"><Icon icon={Info} size={14} />{t("Mirror doesn't work with “Fill first, then second”.")}</p>}
    <PathPreview label={t("Drive backups are saved here on each destination")} parts={driveBackupFolder(preferences.basePath).split('/')} />
  </div>;
}

function AppearanceControls({ preferences, act }: { preferences: Preferences; act: Dispatch }) {
  const { t } = useTranslation();
  return <section className="appearance-controls" aria-label={t("Appearance")}><div className="segmented appearance-segments" role="group" aria-label={t("Color mode")}>
    {([{ value: 'system', label: t("System"), icon: Laptop }, { value: 'light', label: t("Light"), icon: Sun }, { value: 'dark', label: t("Dark"), icon: Moon }] as { value: Appearance; label: string; icon: LucideIcon }[]).map(mode => <button key={mode.value} type="button" aria-pressed={preferences.appearance === mode.value} onClick={() => act({ type: 'preferences', patch: { appearance: mode.value } })}><Icon icon={mode.icon} size={16} /><span>{mode.label}</span></button>)}
  </div><div className="accent-row"><span>{t("Accent")}</span><div role="group" aria-label={t("Accent color")}>{(['coral', 'ocean', 'forest'] as Accent[]).map(accent => <button type="button" key={accent} aria-label={t(`${accent[0].toUpperCase() + accent.slice(1)} accent`)} aria-pressed={preferences.accent === accent} className={`accent-button accent-${accent}`} onClick={() => act({ type: 'preferences', patch: { accent } })}><span>{preferences.accent === accent && <Icon icon={Check} size={13} />}</span></button>)}</div></div></section>;
}

/** The drive backup mode applies to every Files & folders source, so it sits in the mode's header, above them all. */
export function BackupModeLine({ mode, onChange }: { mode?: BackupMode; onChange?: () => void }) {
  const { t } = useTranslation();
  return <p className="backup-mode-line" data-testid="backup-mode-summary"><span>{t("Drive backups: {mode}", { mode: mode === 'mirror' ? t("Mirror") : t("Additive") })}</span><Button kind="quiet" onClick={onChange}>{t("Change")}</Button></p>;
}
export function ImportDesk({ state, act, inspect, onOrganization, onSettings, onActivity, onAutomatic, onOtherMode, mode = 'media', needsChoice = [] }: { mode?: ImportMode; onOtherMode?: () => void; onAutomatic?: () => void; onFolderRules?: () => void; onActivity?: () => void; state: AppState; act: Dispatch; inspect: (path: string) => void; onOrganization: () => void; onSettings: () => void; needsChoice?: string[] }) {
  const { t, formatNumber } = useTranslation();
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const jobs = state.jobs.filter(job => !job.organization && (job.backup ? 'files' : 'media') === mode);
  const active = jobs.filter(job => isRunning(job));
  // The order queued jobs will start in, as the importer publishes it; longest waiting first otherwise.
  const startOrder = state.queueOrder ?? [];
  const selectedJob = jobs.find(job => job.id === selectedJobId && !job.organization) ?? jobs.find(job => job.inventory && !job.organization);
  const latestJobs = jobs.filter((job,index)=>!job.organization && jobs.findIndex(item=>item.source.id===job.source.id)===index);
  const modeSources = state.sources.filter(source => sourceImportMode(source) === mode);
  // Sources of the other mode: the empty state says where they are, so an empty list never reads as "nothing connected".
  const otherSources = state.sources.length - modeSources.length;
  const idleSources = modeSources.filter(source => !jobs.some(job => job.source.id === source.id));
  // Organizations read a drive or folder too: each one's latest run is a card, ahead of the drives.
  const configured = state.preferences.destinations.length >= requiredDestinations(state.preferences);
  const scanning = (state.scanningSources?.length ?? 0) > 0;
  const reviewBusy = !!state.blocked?.review;
  // Starting one drive queues behind the others; only an open review blocks it.
  const startBlocked = !!state.busyReview || !!state.review;
  const unanswered = (id: string) => needsChoice.includes(id) && newDeviceIds(state).includes(id);
  // Cards follow the source order, so Move to top puts a card first.
  const position = (id: string) => { const index = state.sources.findIndex(source => source.id === id); return index < 0 ? Infinity : index; };
  const cards = [...latestJobs.map(job => ({ id: job.source.id, job, source: job.source })), ...idleSources.map(source => ({ id: source.id, job: undefined as Job | undefined, source }))].sort((a, b) => position(a.id) - position(b.id));
  // Drives and folders still connected can be ejected or removed; one in use shows the button disabled.
  const ejectState = (source: Source): 'ready' | 'busy' | 'ejecting' | undefined => ejectable(source) && state.sources.some(item => item.id === source.id) ? (state.ejecting?.includes(source.id) ? 'ejecting' : sourceInUse(state, source) ? 'busy' : 'ready') : undefined;
  const done = doneSources(state, source => containsBackup(source, state.preferences.destinations));
  const movable = (card: typeof cards[number], index: number) => index > 0 && sourceSelected(card.source) && (!card.job || card.job.phase === 'queued' || (card.job.phase === 'stopped' && !!card.job.paused));
  return <div className="desk-page">
    <ImportDashboard state={state} act={act} />
    <div className="workbench-columns"><div className="source-workspace">
      <section aria-labelledby="source-heading" className="source-section"><div className="section-heading"><h2 id="source-heading">{t("Sources & queue")}</h2><div className="source-heading-actions">{done.length > 0 && <EjectAll sources={done} act={act} />}<Button icon={FolderPlus} aria-label={mode === 'files' ? t("Back up drives or folders…") : t("Choose media folders…")} title={mode === 'files' ? t("Back up drives or folders…") : t("Choose media folders…")} disabled={!configured || !!state.review || !!state.busyReview} onClick={() => act({ type: 'chooseSource', backup: mode === 'files' })}>{t("Add folder…")}</Button><div className="source-layout-switch" role="group" aria-label={t("Source layout")}>{([{value:'list',label:t("List view"),icon:List},{value:'grid',label:t("Grid view"),icon:LayoutGrid}] as const).map(layout => <button type="button" key={layout.value} data-testid={`source-layout-${layout.value}`} aria-label={layout.label} title={layout.label} aria-pressed={(state.preferences.sourceLayout) === layout.value} onClick={() => act({type:'preferences',patch:{sourceLayout:layout.value}})}><Icon icon={layout.icon} size={18} /></button>)}</div>{<Button icon={scanning ? LoaderCircle : ScanLine} disabled={!state.sources.some(source => source.transport !== 'camera') || reviewBusy} onClick={() => act({ type: 'scan' })}>{scanning ? t("Scanning…") : t("Scan all")}</Button>}</div></div>
        <div className={`source-ledger source-layout-${state.preferences.sourceLayout}`} data-testid="source-cards">
          {latestJobs.length === 0 && idleSources.length === 0 && <div className="source-empty"><div className="empty-device-line"><Icon icon={Camera} size={32} /><span /><Icon icon={Usb} size={20} /><span /><Icon icon={Save} size={30} /></div><h3>{mode === 'files' ? t("Choose folders to back up.") : t("Connect camera storage or a memory card.")}</h3><p>{mode === 'files' ? t("Keep the original folder structure.") : t("Connect a memory card or camera to start.")}</p><Button kind="quiet" icon={Radio} className="inline-note" data-testid="empty-automatic" onClick={() => onAutomatic?.()}>{state.preferences.automatic ? t("Automatic import is watching for new connections.") : t("Automatic import is off. Use Start when you’re ready.")}</Button>{otherSources > 0 && onOtherMode && <div className="source-empty-other" data-testid="other-mode-sources"><span>{otherSources === 1 ? (mode === 'files' ? t("1 connected source is in Media.") : t("1 connected source is in Files & folders.")) : mode === 'files' ? t("{count} connected sources are in Media.", { count: formatNumber(otherSources) }) : t("{count} connected sources are in Files & folders.", { count: formatNumber(otherSources) })}</span><Button kind="quiet" icon={ArrowRight} onClick={onOtherMode}>{mode === 'files' ? t("Media") : t("Files & folders")}</Button></div>}</div>}
          {cards.map((card, index) => { const { job, source } = card; return job ? <SourceRow activity={state.driveActivity?.[source.id]} drive={driveContext(job.source, state.sources, state.destinationStatus)} canMoveUp={movable(card, index)} key={card.id} source={job.source} job={job} queuePosition={startOrder.indexOf(job.id) + 1} selected={selectedJob?.id === job.id} onSelect={() => animateInterfaceChange(() => setSelectedJobId(job.id))} act={act} configured={configured} inventory={state.sourceInventories?.[job.source.id] ?? job.inventory} scanning={state.scanningSources?.includes(job.source.id)} listing={state.scanProgress?.[job.source.id]} containsBackup={containsBackup(job.source, state.preferences.destinations)} backupFolder={state.preferences.basePath} cameraInfo={state.sourceCameraInfo?.[job.source.id]} reviewBusy={reviewBusy} eject={ejectState(job.source)} reviewing={!!state.busyReview && state.reviewSourceId === job.source.id} reviewProgress={state.reviewProgress} startBlocked={startBlocked} organizeBlocked={state.preferences.mediaLayout === 'video-root'} needsChoice={unanswered(job.source.id)} verifyOff={!state.preferences.verifyCopies} originalsSize={state.originalsSize} /> : <SourceRow drive={driveContext(source, state.sources, state.destinationStatus)} canMoveUp={movable(card, index)} key={card.id} source={source} act={act} configured={configured} inventory={state.sourceInventories?.[source.id]} scanning={state.scanningSources?.includes(source.id)} listing={state.scanProgress?.[source.id]} containsBackup={containsBackup(source, state.preferences.destinations)} backupFolder={state.preferences.basePath} cameraInfo={state.sourceCameraInfo?.[source.id]} reviewBusy={reviewBusy} eject={ejectState(source)} reviewing={!!state.busyReview && state.reviewSourceId === source.id} reviewProgress={state.reviewProgress} startBlocked={startBlocked} organizeBlocked={state.preferences.mediaLayout === 'video-root'} needsChoice={unanswered(source.id)} verifyOff={!state.preferences.verifyCopies} />; })}

        </div>
      </section>
      {selectedJob?.inventory && <InventoryPanel inventory={selectedJob.inventory} sourceName={selectedJob.source.name} backup={selectedJob.backup} inspect={inspect} act={act} />}
      {onActivity && <Button kind="quiet" icon={Activity} onClick={onActivity}>{t("View all jobs in Activity")}</Button>}

    </div><DestinationStrip state={state} act={act} onSettings={onSettings} onLibrary={onOrganization} /></div>
  </div>;
}

type ListingProgress = NonNullable<AppState['scanProgress']>[string];
// Sources without a recorded choice (manual folders) count as selected.
function selectionKnown(source: Source): boolean { return source.selected !== undefined; }
export function sourceSelected(source: Source): boolean { return source.selected !== false; }
function newDeviceIds(state: AppState): string[] { return state.newDevices ?? []; }
function rememberedDevices(preferences: Preferences) { return preferences.rememberedDevices; }
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
        <div className="new-drive-identity"><span className={`source-device ${drive.camera || drive.transport === 'camera' ? '' : 'not-camera'}`}><Icon icon={drive.camera || drive.transport === 'camera' ? Camera : HardDrive} size={21} /></span><div><h3>{returning ? drive.name : t("Import from {name}?", { name: drive.name })}</h3><small>{[drive.total ? bytes(drive.total) : '', drive.path].filter(Boolean).join(' · ')}</small></div>{unplugged && <span className="unplugged-badge" data-testid="drive-unplugged"><Icon icon={Usb} size={13} />{t("Unplugged")}</span>}</div>
        {unplugged ? <p className="new-drive-evidence">{t("Reconnect it to choose.")}</p> : <p className={`new-drive-evidence ${drive.camera || drive.transport === 'camera' ? 'camera' : ''}`}><Icon icon={drive.camera || drive.transport === 'camera' ? CheckCircle2 : Info} size={14} />{drive.transport === 'camera' ? t("Connected as a camera over USB.") : drive.camera ? t("Camera folders (DCIM) found.") : t("No camera folders (DCIM) found.")}</p>}
        {(history?.lastImportVerified || history?.lastScanCompleted) && <ul className="drive-history" data-testid="drive-history">{history.lastImportVerified && <li><Icon icon={ShieldCheck} size={13} />{t("Last import verified {date}", { date: formatWhen(history.lastImportVerified, language) })}</li>}{history.lastScanCompleted && <li><Icon icon={ScanLine} size={13} />{t("Last scan finished {date}", { date: formatWhen(history.lastScanCompleted, language) })}</li>}</ul>}
        {!unplugged && hints.length > 0 && <ul className="new-drive-hints">{hints.map(hint => <li key={`${hint.evidence}-${hint.name}`}>{hint.name}</li>)}</ul>}
        {returning ? <div className="rule-actions"><Button icon={Check} disabled={unplugged} onClick={() => act({ type: 'dismissReconnected', sourceId: drive.id })}>{t("OK")}</Button>{drive.selected === false ? <Button kind="primary" icon={ArrowDownToLine} disabled={unplugged} onClick={() => selectSource(act, drive.id, true)}>{t("Import from this drive")}</Button> : <Button kind="primary" icon={ArrowDownToLine} disabled={unplugged} onClick={() => act({ type: 'start', sourceId: drive.id })}>{t("Import now")}</Button>}</div> : <div className="rule-actions"><Button kind={drive.camera || drive.transport === 'camera' ? 'secondary' : 'primary'} icon={X} disabled={unplugged} onClick={() => selectSource(act, drive.id, false)}>{t("Don't import")}</Button><Button kind={drive.camera || drive.transport === 'camera' ? 'primary' : 'secondary'} icon={ArrowDownToLine} disabled={unplugged} onClick={() => selectSource(act, drive.id, true)}>{t("Import from this drive")}</Button></div>}
      </li>;
    })}</ul><p className="settings-explanation">{t("Change this any time in Settings › Devices.")}</p></div>
  </dialog>;
}
type StepState = 'pending' | 'active' | 'done' | 'error' | 'paused' | 'skipped';
// Scanning → Copying → Verifying for one source, derived from its latest job and read-only scan.
export function sourceStepStates(job: Job | undefined, inventory: Inventory | undefined, scanning: boolean, verifyOff: boolean, reviewing = false): StepState[] {
  const skipVerify = (state: StepState): StepState => verifyOff ? 'skipped' : state;
  // A review being built for this source is its first step at work.
  if (reviewing && (!job || !isRunning(job)) && job?.phase !== 'queued') return ['active', 'pending', skipVerify('pending')];
  if (!job || job.phase === 'queued') return [scanning ? 'active' : inventory ? 'done' : 'pending', 'pending', skipVerify('pending')];
  if (job.phase === 'complete' || ended(job) && allVerified(job)) return ['done', 'done', skipVerify('done')];
  const progressPhase = job.progress?.phase;
  const stage = progressPhase === 'verifying' ? 2 : progressPhase === 'copying' || job.phase === 'copying' ? 1 : 0;
  const current: StepState = job.phase === 'error' ? 'error' : job.phase === 'stopped' ? 'paused' : 'active';
  return [0, 1, 2].map(index => index === 2 && verifyOff ? 'skipped' : index < stage ? 'done' : index === stage ? current : 'pending');
}
/** Where a stage sits in a job's run, for comparing jobs of different kinds. */
const stageRank: Record<StepKind, number> = { scan: 0, read: 1, compare: 2, copy: 3, move: 3, verify: 4, tidy: 5, delete: 6 };
/** The whole queue is paused (or pausing): every job that is still to run or running is. Finished and failed jobs do not count. */
function totalPaused(jobs: Job[]): boolean {
  const open = jobs.filter(job => isRunning(job) || job.phase === 'queued' || jobPaused(job));
  return open.length > 0 && open.every(jobPaused);
}
/** The total bar: the layers of the least advanced job, so the top color is the stage that still holds the whole back. Jobs already past that
 * stage count as done in it, which keeps the top layer growing as the slowest job catches up. With every job finished it is full in the final stage's color.
 * When every job reports its cost, each layer is the cost done through its stage over all jobs' cost, so the bar is as long as the percent. */
export function totalStageLayers(jobs: Job[], verify = true): StageLayer[] {
  const plans = jobs.flatMap(job => { const plan = stagePlan(job, verify); return plan ? [{ job, plan }] : []; });
  if (!plans.length) return [];
  const rank = (plan: StagePlan) => stageRank[plan.kinds[plan.index]!];
  const open = plans.filter(item => !item.plan.finished);
  if (!open.length) return layersOfPlan(plans.reduce((best, item) => rank(item.plan) > rank(best.plan) ? item : best).plan);
  const least = open.reduce((best, item) => rank(item.plan) < rank(best.plan) ? item : best);
  // The top layer is the overview's percent, so the bar and the number never disagree.
  return layersOfPlan(least.plan, overviewFraction(jobs) ?? 0);
}
export function SourceSteps({ job, inventory, scanning, verifyOff, reviewing = false }: { job?: Job; inventory?: Inventory; scanning: boolean; verifyOff: boolean; reviewing?: boolean }) {
  const { t, formatNumber } = useTranslation();
  const states = sourceStepStates(job, inventory, scanning, verifyOff, reviewing), kinds = sourceStepKinds(job);
  const icons: Record<StepState, LucideIcon> = { pending: Circle, active: LoaderCircle, done: Check, error: CircleAlert, paused: Pause, skipped: Minus };
  const names = [t("Scanning"), t(job?.progress?.renames ? "Moving" : "Copying"), t("Verifying")];
  const fraction = job ? cardFraction(job) : undefined;
  // One style for every step: done is checked, the current one shows its percent, the rest wait.
  return <ol className="source-steps" aria-label={t("Import steps")} data-testid="source-steps" {...(job && jobPaused(job) ? { 'data-paused': '' } : {})}>{names.map((label, index) => {
    const state = states[index]!;
    return <li key={index} data-state={state} data-step={kinds[index]} aria-current={state === 'active' ? 'step' : undefined} title={state === 'skipped' ? t("Verification after copy is off") : undefined}><span className="step-mark"><Icon icon={icons[state]} size={12} /></span><span>{label}</span>{state === 'active' && fraction !== undefined && <span className="step-percent">{`${formatNumber(shownPercent(fraction, false))}%`}</span>}</li>;
  })}</ol>;
}

/** The quiet note beside a copy count: how many files were already in the backup. */
export function progressSkippedNote(progress: NonNullable<Job['progress']>, t: ReturnType<typeof createTranslator>, formatNumber: (value: number) => string): string | undefined {
  const skipped = copyBasis(progress).skipped || (progress.phase === 'copying' && !progress.step ? progress.work?.direct?.present ?? 0 : 0);
  return skipped > 0 ? t("{count} already in the backup", { count: formatNumber(skipped) }) : undefined;
}
/** The dashboard's total: each job's row share (its current step, as its counter counts; a finished job is full), weighted by its size, so
 * with one job it reads that job's row. Below 100% until every job is complete. */
export function overviewFraction(jobs: Job[]): number | undefined {
  if (jobs.length && jobs.every(jobFinished)) return 1;
  const measured = jobs.flatMap(job => { const fraction = cardFraction(job); return fraction === undefined ? [] : [{ fraction, weight: Math.max(job.progress?.totalBytes ?? 0, 1) }]; });
  if (measured.length === 1) return measured[0]!.fraction;
  return measured.length ? measured.reduce((sum, item) => sum + item.fraction * item.weight, 0) / measured.reduce((sum, item) => sum + item.weight, 0) : undefined;
}
/** How fast a step reads: bytes per second, or files per second while checking metadata. */
function FileRate({ value }: { value: number }) {
  const { t, language } = useTranslation();
  return <>{t("{count} files/s", { count: numberIn(value, language, { maximumSignificantDigits: 3 }) })}</>;
}
/** What a running job is doing, for the dashboard's total. */
function leadStatus(job: Job, t: ReturnType<typeof createTranslator>): string {
  if (job.organization) return organizationStatus(job, t);
  const p = job.progress;
  return p?.phase === 'planning' ? importStatus(job, t) : p?.phase === 'verifying' ? t("Verifying copied files") : p?.renames ? t("Moving files") : t("Copying files");
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
/** An import job's status line: stopping, its place in the queue, or its phase. */
function importJobStatus(job: Job, t: ReturnType<typeof createTranslator>, queuePosition?: number): string {
  if (job.stopping) return job.stopping === 'pause' ? t("Pausing…") : t("Stopping…");
  if (job.phase === 'queued') return t("Queue position {count}", { count: queuePosition ?? 0 });
  return { discovering: t("Discovering files"), verifying: importStatus(job, t), copying: job.progress?.renames ? t("Moving files") : t("Copying files"), complete: t("Complete"), stopped: t("Stopped"), error: t("Needs attention"), queued: t("Queued") }[job.phase];
}
/** What an organization reads: "A006 › photobackup + videobackup", or the full path. */
export function organizationPlace(job: Job, full = false): string {
  const place = full ? job.source.path : basename(job.source.path) || job.source.path;
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
  if (job.progress?.step === 'history') return t("Reading history");
  if (job.progress?.step === 'earlier' || job.progress?.step === 'confirming') return t("Confirming");
  if (job.progress?.renames && job.progress.step === 'moving') return t("Moving files");
  return job.progress?.phase === 'planning' ? (job.progress.step === 'reading' ? t("Reading files") : t("Checking files")) : t("Organizing");
}
/** An organization in Sources & queue: what it reads, the step it is on and its progress. */
export function OrganizationCard({ job, act }: { job: Job; act: Dispatch }) {
  const { t } = useTranslation();
  return <article data-source-id={job.source.id} data-testid="organization-card" className={`source-row organization-card ${job.phase === 'error' ? 'source-error' : ''}`}>
    <div className="source-row-top"><div className="source-device"><Icon icon={FolderCog} size={21} /></div><div className="source-identity"><h3 title={organizationPlace(job, true)}>{t("Library organization")}</h3><span className={`source-status ${job.phase}`}><span key={organizationStatus(job, t)} className="source-status-text">{organizationStatus(job, t)}</span></span></div></div>
    <p className="progress-job-place progress-job-place-action" title={organizationPlace(job, true)}><span>{organizationPlace(job, true)}</span><RevealButton path={job.source.path} act={act} /></p>
    <OrganizationProgress job={job} act={act} />
    <SkipFileNotice job={job} act={act} />
  </article>;
}
/** macOS calls its file manager Finder. */
export const revealLabel = () => /Mac/i.test(typeof navigator === 'undefined' ? '' : navigator.platform) ? "Show in Finder" : "Show in file manager";
/** Opens the Finder (file manager) at a source, destination, folder or file the app already works with. */
export function RevealButton({ path, act, name }: { path: string; act: Dispatch; name?: string }) {
  const { t } = useTranslation();
  const label = t(revealLabel());
  return <Button kind="quiet" icon={ExternalLink} data-testid="reveal" aria-label={name ? `${label}: ${name}` : label} title={`${label}: ${path}`} onClick={() => act({ type: 'reveal', path })} />;
}
/** A job that ended with errors: Retry runs it again. One stopped on a file it couldn't read or check also offers Skip (that file) and Skip all (every file that fails). */
/** Eject a drive, or remove a folder from the app, after a confirmation. Removing a folder never touches the folder or its files. */
export function EjectButton({ source, act, busy = false, ejecting = false }: { source: Source; act: Dispatch; busy?: boolean; ejecting?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const folder = source.transport === 'folder', label = folder ? t("Remove from app") : t("Eject"), tip = `${label}: ${source.name}`;
  return <>
    <Button kind="quiet" icon={ejecting ? LoaderCircle : Eject} data-testid="eject-source" aria-label={ejecting ? `${t("Ejecting…")} ${source.name}` : tip} aria-busy={ejecting || undefined} title={ejecting ? t("Ejecting…") : busy ? t("In use. Wait for it to finish first.") : tip} disabled={busy || ejecting} onClick={() => setOpen(true)} />
    {open && <ConfirmSheet title={folder ? t("Remove {name} from the app?", { name: source.name }) : t("Eject {name}?", { name: source.name })} confirmLabel={label} confirmIcon={Eject} confirmKind="primary" testId="eject-confirm" onCancel={() => setOpen(false)} onConfirm={() => { setOpen(false); act({ type: 'ejectSource', sourceId: source.id }); }}>
      <p>{folder ? t("The folder and its files stay where they are.") : t("Ejected drives can be unplugged safely.")}</p>
    </ConfirmSheet>}
  </>;
}
/** Eject all done (N): one confirmation that names every drive to eject and folder to remove. */
export function EjectAll({ sources, act }: { sources: Source[]; act: Dispatch }) {
  const { t, formatNumber } = useTranslation();
  const [open, setOpen] = useState(false);
  return <>
    <Button icon={Eject} data-testid="eject-all" title={t("Eject finished drives and remove finished folders")} onClick={() => setOpen(true)}>{t("Eject all done ({count})", { count: formatNumber(sources.length) })}</Button>
    {open && <ConfirmSheet title={t("Eject all done ({count})?", { count: formatNumber(sources.length) })} confirmLabel={t("Eject all")} confirmIcon={Eject} confirmKind="primary" testId="eject-all-confirm" onCancel={() => setOpen(false)} onConfirm={() => { setOpen(false); act({ type: 'ejectDone' }); }}>
      <p>{t("Finished drives are ejected and can be unplugged safely. Finished folders are only removed from the app; the folders and their files stay where they are.")}</p>
      <ul className="eject-list">{sources.map(source => <li key={source.id}>{source.name}</li>)}</ul>
    </ConfirmSheet>}
  </>;
}

/** Delete originals already in the backup asks twice, like Delete recovery files: the first sheet names how many
 * verified files and how much space, the second asks again with Cancel focused. Only the second confirmation deletes. */
export function OriginalsConfirm({ step, name, size, onCancel, onConfirm }: { step: 'first' | 'second'; name: string; size?: AppState['originalsSize']; onCancel: () => void; onConfirm: () => void }) {
  const { t, formatNumber, formatBytes: bytes } = useTranslation();
  const measured = size?.files !== undefined && size.bytes !== undefined;
  const amount = measured ? { count: formatNumber(size.files!), size: bytes(size.bytes!), name } : undefined;
  const none = measured && size.files === 0;
  const detail = size?.error ? <p className="field-error">{t(size.error)}</p> : amount ? undefined : <p className="muted">{t("Counting verified originals…")}</p>;
  return <ConfirmSheet step={step} title={step === 'first' ? t("Delete originals already in the backup?") : t("Delete originals permanently?")} confirmLabel={step === 'first' ? t("Continue…") : t("Delete permanently")} confirmDisabled={!amount || none} testId={`delete-originals-${step}`} onCancel={onCancel} onConfirm={onConfirm}>
    {step === 'first' ? <><p>{t("Only files that were copied and verified by checksum in the backup are deleted. Files that were not copied stay where they are.")}</p>{amount && !none && <p>{t("{count} files ({size}) will be deleted from {name}.", amount)}</p>}{none && <p>{t("No verified originals to delete.")}</p>}</> : amount && <p>{t("This permanently deletes {count} files ({size}) from {name}. Each is checked against its copy in the backup first. This cannot be undone.", amount)}</p>}
    {detail}{measured && !!size.kept && <p className="muted">{t("{count} files will stay where they are.", { count: formatNumber(size.kept) })}</p>}
  </ConfirmSheet>;
}

/** The separate "Delete originals already in the backup" step on a finished folder import's card. */
export function DeleteOriginals({ job, size, act, busy = false }: { job: Job; size?: AppState['originalsSize']; act: Dispatch; busy?: boolean }) {
  const { t, formatNumber, formatBytes: bytes } = useTranslation();
  const [step, setStep] = useState<DeleteRecoveryStep>('closed');
  const originalsLeft = useHeld()(`originals:${job.id}`, job.deletingOriginals?.eta);
  if (job.source.transport === 'camera' || job.organization || !(job.phase === 'complete' || job.phase === 'error' && errorTotal(job) === 0 && !job.failedFiles)) return null;
  const measured = size?.jobId === job.id ? size : undefined;
  const choose = (choice: 'open' | 'confirm' | 'cancel') => {
    const next = nextConfirmStep(step, choice);
    if (choice === 'open') act({ type: 'measureOriginals', jobId: job.id });
    setStep(next.step);
    if (next.delete) act({ type: 'deleteOriginals', jobId: job.id });
  };
  const done = job.originalsDeleted;
  if (!job.verifiedOriginals && !done) return null;
  return <div className="source-choice" data-testid="delete-originals">
    <p><Icon icon={Info} size={14} />{t("Import: copy, source untouched")}</p>
    {done?.stopped && <p data-testid="originals-stopped"><Icon icon={CircleAlert} size={14} />{t("Stopped after {count} originals deleted ({size}); {kept} left in place", { count: formatNumber(done.files), size: bytes(done.bytes), kept: formatNumber(done.kept) })}</p>}
    {done && !done.stopped && <p data-testid="originals-deleted"><Icon icon={CheckCircle2} size={14} />{t("{count} originals deleted ({size}); {kept} left in place; {folders} empty folders removed", { count: formatNumber(done.files), size: bytes(done.bytes), kept: formatNumber(done.kept), folders: formatNumber(done.folders ?? 0) })}</p>}
    {job.deletingOriginals && <p role="status"><Icon icon={LoaderCircle} size={14} />{job.deletingOriginals.folders ? t("Removing empty folders: {completed} of {total}", { completed: formatNumber(job.deletingOriginals.folders.completed), total: formatNumber(job.deletingOriginals.folders.total) }) : t("Deleting originals: {completed} of {total}", { completed: formatNumber(job.deletingOriginals.completed), total: formatNumber(job.deletingOriginals.total) })}{originalsLeft !== undefined && ` · ${t("{time} left", { time: formatRemaining(originalsLeft, t) })}`}</p>}
    {!!job.verifiedOriginals && <div className="rule-actions"><Button kind="danger" icon={Trash2} data-testid="delete-originals-button" disabled={busy || !!job.deletingOriginals} title={t("Deletes only source files verified in the backup")} onClick={() => choose('open')}>{t("Delete originals already in the backup")}</Button></div>}
    {step !== 'closed' && <OriginalsConfirm key={step} step={step} name={job.source.name} size={measured} onCancel={() => choose('cancel')} onConfirm={() => choose('confirm')} />}
  </div>;
}

function SkipFileNotice({ job, act }: { job: Job; act: Dispatch }) {
  const { t, formatNumber } = useTranslation();
  if (job.phase === 'complete' && job.acknowledged) return <div className="source-choice job-skipped-note" data-testid="job-skipped-note"><details><summary><Icon icon={CheckCircle2} size={14} />{job.acknowledged.errorCount === 1 ? t("1 issue skipped") : t("{count} issues skipped", { count: formatNumber(job.acknowledged.errorCount) })}</summary><ul>{job.acknowledged.groups.map(group => <li key={group.severity + group.code}>{groupInfo(group.code, group.count, job.source.name, t, formatNumber).title}</li>)}</ul><p>{t("Skipping only changes the status. Nothing is deleted.")}</p></details></div>;
  if (job.phase !== 'error') return null;
  const skipAll = <Button icon={CheckCheck} data-testid="job-card-skip-all" title={t("Skipping only changes the status. Nothing is deleted.")} onClick={() => act({ type: 'acknowledgeErrors', jobId: job.id })}>{t("Skip all and mark as done")}</Button>;
  const retry = job.retryable ? <Button icon={RotateCcw} data-testid="retry-button" title={t("Run this job again, including files that had errors")} onClick={() => act({ type: 'retryJob', jobId: job.id })}>{t("Retry")}</Button> : null;
  if (!job.skippablePath) return <div className="source-choice" data-testid="retry-job"><p><Icon icon={CircleAlert} size={14} />{t("This job ended with errors.")}</p><div className="rule-actions">{retry}{skipAll}</div></div>;
  const file = job.skippablePath;
  return <div className="source-choice" data-testid="skip-file"><p title={file}><Icon icon={CircleAlert} size={14} />{t("{file} stopped this job.", { file: basename(file) })}<RevealButton path={file} act={act} /></p><div className="rule-actions">{retry}{skipAll}<Button icon={ChevronRight} data-testid="skip-file-button" title={t("Leave this file out and run the job again")} onClick={() => act({ type: 'skip', jobId: job.id, path: file })}>{t("Skip")}</Button><Button kind="primary" icon={Play} data-testid="skip-all-button" title={t("Run again, skipping files with errors")} onClick={() => act({ type: 'skip', all: true, jobId: job.id })}>{t("Skip all")}</Button></div></div>;
}

/** Files checked (or read) before anything is written: import and organization reviews, the backup folder check. */
export function PlanningProgress({ progress, label }: { progress: Progress; label: string }) {
  return <OperationProgress progress={progress} label={label} testId="planning-progress" className="progress-planning" />;
}
// Listing: the estimated share listed (main measures it, see listing-estimate.ts). Metadata: share of media files read.
export function ScanProgress({ sourceName, sourceId, listing, cameraInfo }: { sourceName: string; /** Names its time-left hold; two cards can share a name. */sourceId?: string; listing?: ListingProgress; cameraInfo?: SourceCameraInfo }) {
  const { t, formatNumber, formatBytes: bytes } = useTranslation();
  const reading = cameraInfo?.status === 'reading', eta = useHeld()(`${reading ? 'camera' : 'scan'}:${sourceId ?? sourceName}`, reading ? cameraInfo.eta : listing?.eta);
  const fraction = reading ? (cameraInfo.total ? cameraInfo.checked / cameraInfo.total : undefined) : listing?.share;
  const count = reading ? t("Reading camera metadata: {checked}/{total}", { checked: formatNumber(cameraInfo.checked), total: formatNumber(cameraInfo.total) }) : listing ? t("Listing files…") : undefined;
  return <ProgressDisplay testId="scan-progress" className="progress-scan" step={reading ? 'read' : 'scan'} label={t("{name} scanning", { name: sourceName })} fraction={fraction}
    count={count}
    speed={reading ? { speed: 0, fileRate: cameraInfo.fileRate } : listing ? { speed: 0, fileRate: listing.fileRate } : undefined}
    startedAt={reading ? cameraInfo.startedAt : listing?.startedAt} left={eta !== undefined ? t("{time} left", { time: formatRemaining(eta, t) }) : fraction !== undefined ? t("Estimating time left…") : undefined}
    file={reading ? undefined : listing?.file}
    extra={!reading && listing ? <strong className="scan-found">{t("{count} files found · {size}", { count: formatNumber(listing.files), size: bytes(listing.bytes) })}</strong> : undefined} />;
}

/** The drive a chosen folder is on, with a Same drive tag when other folders share it. */
export function DriveLabel({ drive }: { drive: DriveContext }) {
  const { t } = useTranslation();
  return <span className="source-drive" data-testid="source-drive"><Icon icon={HardDrive} size={12} /><span>{drive.name}</span>{drive.shared > 0 && <span className="small-tag" data-testid="same-drive-tag">{t("Same drive")}</span>}</span>;
}
/** Folders on one drive share its capacity, shown once on the first of them. */
export function SharedCapacityNote({ drive }: { drive: DriveContext }) {
  const { t } = useTranslation();
  return <span className="source-quiet-note" data-testid="shared-capacity"><Icon icon={Info} size={13} />{t("Same drive as {name}. Its capacity is shown there.", { name: drive.leader.name })}</span>;
}
/** A folder on the drive that also holds the backup: copying uses space here, organizing in place does not. */
export function SameDriveNotice({ sourceId, act, disabled = false, organizeBlocked = false }: { sourceId: string; act: Dispatch; disabled?: boolean; organizeBlocked?: boolean }) {
  const { t } = useTranslation();
  return <div className="source-notice source-same-drive" data-testid="same-drive-destination"><p><Icon icon={Info} size={14} />{t("This folder is on the same drive as your backup. Importing copies the files, which uses space on this drive.")}</p><Button icon={FolderCog} disabled={disabled || organizeBlocked} data-testid="organize-instead" onClick={() => act({ type: 'organizeFolder', sourceId })}>{t("Organize instead (move, no extra space)")}</Button>{organizeBlocked && <OrganizeFolderLayoutNote />}</div>;
}
/** Why organizing a folder in place is unavailable: it keeps one folder, so a separate video folder cannot apply. */
export function OrganizeFolderLayoutNote() {
  const { t } = useTranslation();
  return <p className="inline-note" data-testid="organize-folder-layout-note"><Icon icon={Info} size={14} />{t("Organizing a folder in place cannot be used with a separate video folder. Change the media layout in Settings → Folders.")}</p>;
}

// A drive or folder that holds a backup destination: planning leaves the backup folder out.
function containsBackup(source: Source, destinations: string[]): boolean {
  if (!source.path) return false;
  const root = source.path;
  return destinations.some(destination => within(destination, root));
}

export function SourceRow({ reviewing = false, reviewProgress, drive, source, job, queuePosition, selected, onSelect, act, configured, reviewBusy, inventory, scanning, listing, cameraInfo, verifyOff = false, containsBackup: holdsBackup = false, backupFolder, startBlocked = false, organizeBlocked = false, needsChoice = false, canMoveUp = false, originalsSize, activity, eject }: { eject?: 'ready' | 'busy' | 'ejecting'; activity?: DriveActivity; reviewing?: boolean; reviewProgress?: Progress; originalsSize?: AppState['originalsSize']; drive?: DriveContext; canMoveUp?: boolean; verifyOff?: boolean; containsBackup?: boolean; backupFolder?: string; startBlocked?: boolean; organizeBlocked?: boolean; needsChoice?: boolean; source: Source; job?: Job; queuePosition?: number; selected?: boolean; onSelect?: () => void; act: Dispatch; configured: boolean; reviewBusy?: boolean; inventory?: Inventory; scanning?: boolean; listing?: ListingProgress; cameraInfo?: SourceCameraInfo }) {
  const { language, t, formatNumber, formatBytes: bytes } = useTranslation();
  const held = useHeld();
  const [detailsOpen, setDetailsOpen] = useState(false), detailsId = `source-details-${useId()}`;
  const backup = job ? job.backup : sourceImportMode(source) === 'files';
  const active = !!job && isRunning(job);
  const queued = job?.phase === 'queued';
  const progress = job?.progress;
  const status = reviewing && !active && !queued ? t("Building review…") : !job ? backup ? t("Ready to back up") : t("Ready to import") : importJobStatus(job, t, queuePosition);
  const icon = source.transport === 'camera' ? Camera : source.transport === 'folder' ? Folder : Save;
  const paused = job?.phase === 'stopped' && !!job.paused;
  const already = job?.phase === 'complete' && !!job.alreadyImported;
  const mirrorReview = job?.phase === 'error' && job.errors.some(error => error.key === 'error.mirrorReview');
  const statusIcon = job?.phase === 'error' ? CircleAlert : job?.phase === 'complete' ? CheckCircle2 : queued ? Clock3 : active ? ArrowDownToLine : CheckCircle2;
  const moreMenu = useRef<HTMLDetailsElement>(null);
  useDismissableDetails(moreMenu);
  const included = sourceSelected(source), excluded = !included && !job;
  const statusText = excluded ? t("Not selected · won't be imported") : paused ? t("Paused") : already ? t("Already imported") : status;
  return <article data-source-id={source.id} className={`source-row ${selected ? 'source-selected' : ''} ${job?.phase === 'error' ? 'source-error' : ''} ${excluded ? 'source-unselected' : selectionKnown(source) ? 'source-included' : ''} ${already ? 'source-already' : ''} ${needsChoice ? 'source-needs-choice' : ''}`}>
    <div className="source-row-top"><div className="source-device"><Icon icon={icon} size={21} /></div><div className="source-identity"><h3 title={source.name}>{source.name}</h3><span className={`source-status ${excluded ? 'unselected' : paused ? 'paused' : already ? 'already' : job?.phase ?? 'ready'}`}><Icon icon={excluded ? Pause : paused ? Pause : already ? CheckCheck : statusIcon} size={13} /><span key={statusText} className="source-status-text">{statusText}</span>{backup && <span className="small-tag">{t("Folder backup")}</span>}</span>{drive && <DriveLabel drive={drive} />}</div><div className="source-row-actions">{selectionKnown(source) && <SourceSelect source={source} act={act} disabled={active || queued} />}{active || queued ? <><Button icon={Pause} disabled={!!job?.stopping} aria-label={t("Pause {name}", { name: source.name })} onClick={() => act({ type: 'pause', sourceId: source.id })}>{t("Pause")}</Button><Button kind="quiet" icon={Square} disabled={job?.stopping === 'stop'} aria-label={t("Stop source")} title={t("Stop source")} onClick={() => act({ type: 'stop', jobId: job!.id })} /></> : <Button icon={paused ? Play : ArrowDownToLine} disabled={excluded || !configured || startBlocked} onClick={() => act({ type: 'start', sourceId: source.id })}>{paused ? t("Continue") : backup ? t("Back up") : t("Import")}</Button>}{!active && !queued && <Button kind={mirrorReview ? 'primary' : 'secondary'} icon={Eye} disabled={excluded || !configured || reviewBusy} aria-label={t("Review import from {name}", { name: source.name })} title={t("Review files before copying")} onClick={() => act({ type: 'preview', sourceId: source.id })}>{t("Review")}</Button>}{eject && <EjectButton source={source} act={act} busy={eject === 'busy'} ejecting={eject === 'ejecting'} />}<details className="overflow-menu" data-testid="source-more" ref={moreMenu}><summary className="button button-quiet button-icon-only" aria-label={t("More actions for {name}", { name: source.name })} title={t("More actions")}><Icon icon={Ellipsis} size={18} /></summary><div className="overflow-menu-items"><Button kind="quiet" icon={scanning ? LoaderCircle : ScanLine} disabled={excluded || source.transport === 'camera' || reviewBusy || active || queued || scanning} aria-label={t("Scan media on {name}", { name: source.name })} title={source.transport === 'camera' ? t("Use Review for USB cameras.") : t("Read photo and video formats without copying files")} onClick={event => { event.currentTarget.closest('details')!.open = false; act({ type: 'scan', sourceId: source.id }); }}>{scanning ? t("Scanning…") : t("Scan media")}</Button>{canMoveUp && <Button kind="quiet" icon={ArrowUpToLine} data-testid="move-to-top" aria-label={t("Move {name} to the top", { name: source.name })} title={t("Move to the top")} onClick={event => { event.currentTarget.closest('details')!.open = false; act({ type: 'moveToTop', sourceId: source.id }); }}>{t("Move to the top")}</Button>}</div></details></div></div>
    {already && <ProgressDisplay calm className="progress-in-card" testId="already-imported" fraction={1} finished label={t("{name} copy progress", { name: source.name })} count={progress?.total ? t("All {count} files are in the backup and verified", { count: formatNumber(progress.total) }) : t("All files are in the backup and verified")} />}
    {needsChoice && <div className="source-choice" data-testid="needs-choice"><p><Icon icon={CircleAlert} size={14} />{t("Choose whether to import this drive.")}</p><div className="rule-actions"><Button icon={X} onClick={() => selectSource(act, source.id, false)}>{t("Don't import")}</Button><Button kind="primary" icon={ArrowDownToLine} onClick={() => selectSource(act, source.id, true)}>{t("Import")}</Button></div></div>}
    {drive?.onDestination && <SameDriveNotice sourceId={source.id} act={act} disabled={active || queued || !!reviewBusy} organizeBlocked={organizeBlocked} />}
    {holdsBackup && <p className="source-quiet-note" data-testid="backup-excluded"><Icon icon={Info} size={13} />{backupFolder ? t("The backup folder {folder} isn't scanned as a source", { folder: backupFolder }) : t("The backup folder isn't scanned as a source")}</p>}
    {progress && !already && <ProgressDisplay className="progress-in-card" label={t("{name} copy progress", { name: source.name })} fraction={job ? cardFraction(job) : progressFraction(progress)} finished={!!job && jobFinished(job)}
      count={<>{progressCount(progress, t, formatNumber, false, progress.step === 'comparing' ? bytes : undefined)}{progress.failed ? <em className="progress-failed"> · {t("{count} failed", { count: formatNumber(progress.failed) })}</em> : null}</>}
      speed={active ? progress : undefined} {...(job ? jobTiming(job, t, held) : {})} file={active ? progress.file : undefined} step={stepKind(progress)} stages={job ? jobStageLayers(job, !verifyOff) : undefined} paused={!!job && jobPaused(job)}
      extra={job?.phase === 'complete' ? <strong>{t("Verified")}</strong> : undefined} />}
    {progress && !already && progressSkippedNote(progress, t, formatNumber) && <p className="source-quiet-note" data-testid="already-in-backup"><Icon icon={CheckCheck} size={13} />{progressSkippedNote(progress, t, formatNumber)}</p>}
    {mirrorReview && <p className="source-notice"><Icon icon={Eye} size={14} />{t("Review what Mirror will move to continue.")}</p>}
    {job && <SkipFileNotice job={job} act={act} />}
    {job && <DeleteOriginals job={job} size={originalsSize} act={act} busy={!!reviewBusy} />}
    {reviewing && !active && !queued && <OperationProgress progress={reviewProgress} label={t("Review progress")} testId="source-review-progress" className="progress-in-card" />}
    <div className="source-step-row" data-testid="source-step-row">
      <SourceSteps job={job} inventory={inventory} scanning={!!scanning} verifyOff={verifyOff} reviewing={reviewing} />
      <button type="button" className="source-disclosure-toggle" data-testid="drive-details-toggle" aria-expanded={detailsOpen} aria-controls={detailsId} onClick={() => setDetailsOpen(value => !value)}><span className="source-disclosure-label">{t("Drive details")}<Icon icon={ChevronDown} size={16} /></span></button>
    </div>
    {job?.space && !already && (job.phase === 'queued' || isRunning(job)) && <SourceSpace space={job.space} />}
    {scanning && <ScanProgress sourceName={source.name} sourceId={source.id} listing={listing} cameraInfo={cameraInfo} />}
    {active && !progress && <ProgressDisplay className="progress-in-card" step="scan" label={t("{name} scanning", { name: source.name })} startedAt={job?.startedAt} />}
    {job?.detail && active && (!progress || job.detail.key === 'job.destinationLabel') && <p className="source-detail" title={t(job.detail)}>{t(job.detail)}</p>}
    <details className="source-disclosure" id={detailsId} open={detailsOpen} onToggle={event => setDetailsOpen(event.currentTarget.open)}>
      <summary><div className="source-compact-capacity">{drive && !drive.showsCapacity ? <SharedCapacityNote drive={drive} /> : <CapacityBar total={source.total} free={source.free} inventory={inventory} scanning={scanning} unavailable={source.transport === 'camera' ? t("Capacity unavailable over USB") : t("Capacity unavailable")} />}<DriveActivityMeter activity={activity} /></div></summary>
      <div className="source-expanded-details">
        <dl className="source-location"><div><dt>{t("Drive path")}</dt><dd>{source.path || t("Connected USB camera")}{source.path && source.transport !== 'camera' && <RevealButton path={source.path} act={act} name={source.name} />}</dd></div></dl>
        {job?.detail && !active && job.phase !== 'error' && <p className="source-detail">{t(job.detail)}</p>}
        <SourceMediaSummary source={source} inventory={inventory} scanning={scanning} />
        {inventory && <SkippedFilesNotice inventory={inventory} />}
        {job?.problemFiles && !job.organization && <ProblemFilesReview review={{ kind: 'import', problems: job.problemFiles }} act={act} />}
        {cameraInfo && <SourceCameraInformation sourceId={source.id} info={cameraInfo} />}
        {job?.inventory && <button type="button" className="inventory-open" aria-pressed={selected} onClick={onSelect}><Icon icon={Files} size={15} /><span>{t("{count} included files", { count: job.inventory.files.filter(file => file.included).length.toLocaleString(language) })}</span><span>{bytes(job.inventory.bytes)}</span><Icon icon={ChevronRight} size={15} /></button>}
      </div>
    </details>
  </article>;
}

/** Space an import needs on each destination once its plan exists: files already there are skipped and not counted. */
export function SourceSpace({ space }: { space: DestinationSpace[] }) {
  const { t, formatBytes: bytes } = useTranslation();
  return <>{space.map((item, index) => <p key={index} className="source-quiet-note" data-testid="source-space"><Icon icon={HardDrive} size={13} />{space.length > 1 ? `${index + 1} · ` : ''}{item.sameDrive ? t("Needs {needed} of {free} free on this same drive", { needed: bytes(item.needed), free: bytes(item.free) }) : item.existing > 0 ? t("Needs {needed} of {free} free ({existing} already on the destination)", { needed: bytes(item.needed), free: bytes(item.free), existing: bytes(item.existing) }) : t("Needs {needed} of {free} free", { needed: bytes(item.needed), free: bytes(item.free) })}</p>)}</>;
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
    for (const file of inventory.files) if (file.system && !kinds.has(file.system.id)) kinds.set(file.system.id, { vendor: file.system.vendor, label: file.system.label, count: inventory.systemKinds[file.system.id] ?? 0 });
    return [...kinds.values()].sort((a, b) => b.count - a.count);
  }, [inventory]);
  const { copied, skipped } = inventory.unknownFiles, unknown = { length: copied + skipped };
  const emptyPrimary = (inventory.skipped ?? []).filter(item => item.reason === 'emptyPrimary');
  const system = inventory.system ?? 0, empty = inventory.empty ?? 0;
  if (!system && !unknown.length && !empty && !emptyPrimary.length) return null;
  const names = systemKinds.slice(0, 2).map(kind => `${kind.vendor} ${kind.label}`).join(', ') + (systemKinds.length > 2 ? ', …' : '');
  const summary = [
    system > 0 && t("Skipped {count} camera system files ({names})", { count: formatNumber(system), names }),
    empty > 0 && t(message('inventory.emptySkipped', { count: empty })),
    emptyPrimary.length > 0 && t(message('inventory.emptyPrimarySkipped', { count: emptyPrimary.length })),
    skipped > 0 && t("{count} unknown files skipped", { count: formatNumber(skipped) }),
    copied > 0 && t("{count} unknown files copied to other folders", { count: formatNumber(copied) }),
  ].filter(Boolean).join(' · ');
  return <details className="skipped-files" data-testid="skipped-files">
    <summary><Icon icon={Info} size={14} /><span>{summary}</span><Icon icon={ChevronDown} size={14} /></summary>
    <div className="skipped-files-content">
      {systemKinds.length > 0 && <div><h4>{t("Camera system files")}</h4><p>{t("Index files the camera writes. Not needed.")}</p><dl>{systemKinds.map(kind => <div key={`${kind.vendor}-${kind.label}`}><dt>{kind.label}<small>{kind.vendor}</small></dt><dd>{formatNumber(kind.count)}</dd></div>)}</dl></div>}
      {empty > 0 && <div><h4>{t(message('inventory.emptyFile'))}</h4><dl>{(inventory.skipped ?? []).filter(item => item.reason === 'empty').slice(0, 20).map(item => <div key={item.path}><dt>{basename(item.path)}</dt></div>)}</dl></div>}
      {emptyPrimary.length > 0 && <div><h4>{t(message('inventory.emptyPrimaryFile'))}</h4><dl>{emptyPrimary.slice(0, 20).map(item => <div key={item.path}><dt>{basename(item.path)}</dt></div>)}</dl></div>}
      {unknown.length > 0 && <div><h4>{t("Unknown files")}</h4><p>{t("Not photos or videos. Change this in Settings.")}</p><dl>{Object.entries(inventory.unknownExtensions).sort(([, a], [, b]) => b - a).map(([extension, count]) => <div key={extension}><dt className="extension-name">{extension ? `.${extension}` : t("No extension")}</dt><dd>{formatNumber(count)}</dd></div>)}</dl></div>}
    </div>
  </details>;
}

function SourceMediaSummary({ source, inventory, scanning }: { source: Source; inventory?: Inventory; scanning?: boolean }) {
  const { t, formatNumber, formatBytes: bytes } = useTranslation();
  const summary = useMemo(() => {
    const photos = {count:0, size:0, formats:new Map<string,{count:number;size:number}>()};
    const videos = {count:0, size:0, formats:new Map<string,{count:number;size:number}>()};
    for (const [extension, entry] of Object.entries(inventory?.formats ?? {})) {
      const group = entry.video ? videos : photos;
      group.count += entry.files; group.size += entry.bytes; group.formats.set(extension, { count: entry.files, size: entry.bytes });
    }
    return {photos,videos};
  }, [inventory]);
  if (!inventory) return <p className="source-scan-prompt" aria-live="polite"><Icon icon={scanning ? LoaderCircle : ScanLine} size={15} />{scanning ? t("Reading media formats and counts…") : source.transport === 'camera' ? t("Use Review for USB cameras.") : t("Scan to see formats and counts")}</p>;
  const {photos,videos} = summary;
  return <section className="source-media" aria-label={t("Media summary for {name}", { name: source.name })} data-testid="source-media-summary" data-source-id={source.id}><div className="source-media-total"><strong>{t("{count} photos & videos", { count: formatNumber(photos.count + videos.count) })}</strong><span>{t("{size} media", { size: bytes(photos.size + videos.size) })}</span>{scanning && <span aria-live="polite">{t("Updating scan…")}</span>}</div><div className="source-media-groups">{([{ label: t("Photos"), value: photos }, { label: t("Videos"), value: videos }]).map(group => <div className="source-media-group" key={group.label}><div className="source-media-heading"><strong>{group.label}</strong><span>{t("{count} files · {size}", { count: formatNumber(group.value.count), size: bytes(group.value.size) })}</span></div>{group.value.count > 0 ? <dl className="source-formats">{[...group.value.formats].sort(([a],[b])=>a.localeCompare(b)).map(([extension, format]) => <div key={extension}><dt>{extension || t("No extension")}</dt><dd><span>{formatNumber(format.count)}</span><span>{bytes(format.size)}</span></dd></div>)}</dl> : <p>{t(group.value === photos ? "No photos found." : "No videos found.")}</p>}</div>)}</div></section>;
}

export function DestinationBay({ state, act, onLibrary, configure = false }: { onLibrary?: () => void; state: AppState; act: Dispatch; configure?: boolean }) {
  const { t, formatNumber } = useTranslation();
  const { preferences } = state;
  const descriptions: Record<CopyMode, string> = { single: t("One verified copy."), mirror: t("A verified copy on both drives."), sequential: t("Fill the first drive, then use the second.") };
  return <aside className="destination-bay" aria-labelledby="destination-heading"><div className="section-heading"><h2 id="destination-heading">{t("Destinations")}</h2><Icon icon={HardDrive} size={19} /></div><div className="destination-panel"><div className="copy-policy">{configure ? <><label htmlFor="copy-policy">{t("Copy policy")}</label><div className="select-wrap"><select id="copy-policy" disabled={state.jobs.some(job => isRunning(job)) || !!state.review || !!state.busyReview} value={preferences.copyMode} onChange={event => act({ type: 'preferences', patch: { copyMode: event.target.value as CopyMode } })}><option value="single">{t("One destination")}</option><option value="mirror">{t("Copy to both destinations")}</option><option value="sequential" disabled={preferences.backupMode === 'mirror'}>{t("Fill first, then second")}</option></select><Icon icon={ChevronDown} size={15} /></div></> : <div className="copy-policy-summary"><strong>{t("Copy policy")}</strong><span>{{ single: t("One destination"), mirror: t("Copy to both destinations"), sequential: t("Fill first, then second") }[preferences.copyMode]}</span></div>}{configure && <p>{descriptions[preferences.copyMode]}</p>}{configure && preferences.backupMode === 'mirror' && <small>{t("Not available with Mirror.")}</small>}</div>{Array.from({ length: preferences.copyMode === 'single' ? 1 : 2 }, (_, index) => {
    const path = preferences.destinations[index];
    const status = state.destinationStatus?.find(item => item.path === path);
    const busy = state.jobs.some(job => isRunning(job)) || !!state.review || !!state.busyReview;
    const wait = state.blocked?.backupCheck;
    return <section className="destination-slot" key={index} {...(path ? { 'data-destination-path': path } : {})}><div className="destination-slot-label"><span className="destination-number">{index + 1}</span><span>{index === 0 ? t("First destination") : t("Second destination")}</span><span className={`connection-dot ${path && status?.available !== false ? 'connected' : ''}`} aria-label={!path ? t("Not selected") : status?.available === false ? t("Offline") : t("Selected")} /></div><div className="destination-drive"><Icon icon={HardDrive} size={30} /><h3>{path ? basename(path) : t("Choose a backup drive")}</h3></div>{path ? <p className="destination-path" title={path}><bdi>{path}{preferences.basePath ? ` / ${preferences.basePath}` : ''}</bdi></p> : <p className="destination-path">{t("A drive or folder for your verified copies.")}</p>}{path && <><CapacityBar total={status?.total} free={status?.free} unavailable={status?.available === false ? t("Drive offline") : t("Reading drive capacity…")} />{state.driveActivity?.[path] && <DriveActivityMeter activity={state.driveActivity[path]} />}<div className={`destination-health ${status?.available === false ? 'offline' : ''}`}><Icon icon={status?.available === false ? CircleAlert : CheckCircle2} size={13} /><span>{status?.available === false ? t("Reconnect this drive before importing.") : status?.available ? t("Destination available") : t("Checking destination…")}</span></div></>}{path && state.misplacedProgress?.[path] && <PlanningProgress progress={state.misplacedProgress[path]} label={t("Checking the backup folder")} />}{path && !state.misplacedFiles?.[path]?.missing && (state.misplacedFiles?.[path]?.count ?? 0) > 0 && <div className="destination-misplaced" data-testid="destination-misplaced"><Icon icon={CircleAlert} size={13} /><span>{misplacedText(state.misplacedFiles![path].count, t, formatNumber)}</span>{configure && onLibrary && <Button kind="quiet" onClick={onLibrary}>{t("Open in Library")}</Button>}</div>}{path && state.misplacedFiles?.[path]?.missing && !state.misplacedProgress?.[path] && <p className="destination-note" data-testid="destination-folder-missing" role="status">{t("No backup folder yet. The first import creates it.")}</p>}{path && wait && !state.misplacedFiles?.[path] && !state.misplacedProgress?.[path] && status?.available && <small className="destination-note" role="status">{t(message(wait))}</small>}<div className="destination-buttons">{configure && <Button icon={path ? FolderOpen : Plus} kind={path ? 'secondary' : 'primary'} disabled={busy} onClick={() => act({ type: 'chooseDestination', index })}>{path ? t("Change…") : t("Choose location…")}</Button>}<div className="destination-check-actions">{path && <Button kind="quiet" icon={ExternalLink} aria-label={t(index === 0 ? "Show first destination in file manager" : "Show second destination in file manager")} title={t("Show in file manager")} onClick={() => act({ type: 'reveal', path })} />}</div></div>{configure && index === 1 && path && <Button kind="quiet" icon={Trash2} className="remove-destination" disabled={busy} onClick={() => act({ type: 'removeDestination', index })}>{t("Remove destination")}</Button>}</section>;
  })}</div></aside>;
}

/** The Import desk's destinations: one compact line each. The folder layout check starts here while a destination has no result, and details live in Library. */
export function DestinationStrip({ state, act, onSettings, onLibrary }: { state: AppState; act: Dispatch; onSettings?: () => void; onLibrary?: () => void }) {
  const { t, formatNumber, formatBytes } = useTranslation();
  const { preferences } = state;
  const policy = { single: t("One destination"), mirror: t("Copy to both destinations"), sequential: t("Fill first, then second") }[preferences.copyMode];
  const queuedOrganization = state.jobs.some(job => job.organization && job.phase === 'queued');
  return <aside className="destination-strip" aria-labelledby="destination-heading"><div className="section-heading"><h2 id="destination-heading">{t("Destinations")}</h2><Icon icon={HardDrive} size={19} /></div><div className="destination-panel"><div className="copy-policy destination-strip-policy"><div className="copy-policy-summary"><strong>{t("Copy policy")}</strong><span>{policy}</span></div>{onSettings && <Button kind="quiet" icon={Settings2} onClick={onSettings}>{t("Change")}</Button>}</div>{Array.from({ length: requiredDestinations(preferences) }, (_, index) => {
    const path = preferences.destinations[index];
    const status = state.destinationStatus?.find(item => item.path === path);
    const found = path ? state.misplacedFiles?.[path] : undefined;
    const running = !!(path && state.misplacedProgress?.[path]);
    const wait = state.blocked?.backupCheck;
    const online = status?.available === true;
    if (!path) return <section className="destination-slot destination-strip-line" key={index}><div className="destination-strip-head"><span className="destination-number">{index + 1}</span><strong>{t("Choose a backup drive")}</strong></div></section>;
    return <section className="destination-slot destination-strip-line" key={index} data-destination-path={path}>
      <div className="destination-strip-head"><span className="destination-number">{index + 1}</span><strong title={path}>{basename(path)}</strong><i className={`status-dot ${status?.available === undefined ? 'is-checking' : status.available ? 'is-online' : 'is-offline'}`} role="img" aria-label={status?.available === undefined ? t("Checking destination…") : status.available ? t("Destination available") : t("Drive offline")} /><small className="destination-strip-free">{status?.free !== undefined && status.available ? t("{size} free", { size: formatBytes(status.free) }) : status?.available === false ? t("Drive offline") : t("Reading drive capacity…")}</small></div>
      <SidebarDestinationStatus activity={destinationActivity(state, path)} path={path} />
      {state.driveActivity?.[path] && <DriveActivityMeter activity={state.driveActivity[path]} />}
      <div className="destination-check-actions">{online && !found && !running && <Button icon={FolderCog} className="destination-check" data-testid={`destination-check-backup-folder-${index}`} disabled={!!wait || queuedOrganization} onClick={() => act({ type: 'checkBackupFolder', destinationIndex: index })}>{t("Check folder layout")}</Button>}{running && <Button kind="quiet" icon={X} data-testid={`destination-stop-backup-check-${index}`} onClick={() => act({ type: 'stopBackupCheck' })}>{t("Stop")}</Button>}<Button kind="quiet" icon={ExternalLink} aria-label={t(index === 0 ? "Show first destination in file manager" : "Show second destination in file manager")} title={t("Show in file manager")} onClick={() => act({ type: 'reveal', path })} /></div>
      {running && state.misplacedProgress?.[path] && <PlanningProgress progress={state.misplacedProgress[path]} label={t("Checking the backup folder")} />}
      {found && !running && (found.missing ? <p className="destination-note" data-testid="destination-folder-missing" role="status">{t("No backup folder yet. The first import creates it.")}</p> : <div className={found.count > 0 ? 'destination-misplaced' : 'destination-misplaced is-clean'} data-testid={found.count > 0 ? 'destination-misplaced' : 'destination-in-order'} role="status"><Icon icon={found.count > 0 ? CircleAlert : CheckCircle2} size={13} /><span>{found.count > 0 ? misplacedText(found.count, t, formatNumber) : t("Backup folder is in order.")}</span>{onLibrary && <Button kind="quiet" onClick={onLibrary}>{t("Open in Library")}</Button>}</div>)}
      {online && wait && !found && !running && <small className="destination-note" role="status">{t(message(wait))}</small>}
    </section>;
  })}</div></aside>;
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
    <div className="file-table-scroll"><table className="file-table"><thead><tr><th scope="col">{t("File")}</th><th scope="col">{t("Type")}</th><th scope="col">{t("Size")}</th><th scope="col">{t("Import")}</th></tr></thead><tbody>{visible.slice(0, 500).map(file => <tr key={file.path}><td><button className="file-preview-button" type="button" onClick={() => inspect(file.path)} title={t("Show metadata for {name}", { name: file.relative })}><Icon icon={file.kind === 'Other' ? Files : FileImage} size={15} /><span>{file.relative}</span></button>{file.companionOf && <span className="companion-label">{t("Companion to {name}", { name: basename(file.companionOf) })}</span>}</td><td>{t(file.kind)}</td><td>{bytes(file.size)}</td><td><span className={`file-inclusion ${file.included ? 'included' : ''}`}><Icon icon={file.included ? Check : Pause} size={13} />{file.included ? t("Included") : t("Ignored")}</span></td></tr>)}</tbody></table>{visible.length === 0 && <p className="table-empty">{t("No files match this filter.")}</p>}</div>{visible.length > 500 && <p className="inline-note">{t("Showing 500 matches. Search to narrow.")}</p>}</section>;
});

export function UnknownFilesPrompt({ sourceName, inventory, knownRules = {}, act }: { sourceName: string; inventory: Inventory; knownRules?: Preferences['unknownRules']; act: Dispatch }) {
  const { t, formatNumber } = useTranslation();
  const unresolved = Object.fromEntries(Object.entries(inventory.unknownExtensions).filter(([extension]) => !Object.hasOwn(knownRules, extension)));
  const signature = useMemo(() => JSON.stringify(inventory.unknownExtensions), [inventory]);
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

/** CPU thread and memory limits: defaults keep the importer from taking over the machine; a change applies to the next import. */
export function PerformanceSettings({ state, act }: { state: AppState; act: Dispatch }) {
  const { t, formatNumber } = useTranslation();
  const p = state.preferences, use = state.resources;
  const cores = use?.cores ?? Math.max(p.maxCpuThreads, 16), memoryMax = use ? use.memoryMaxMB : Math.max(p.memoryLimitMB, 16384);
  const threads = p.maxCpuThreads, memory = p.memoryLimitMB;
  const atDefaults = !use || (threads === use.defaultThreads && memory === use.defaultMemoryMB);
  return <>
    <div className="settings-row"><label htmlFor="settings-cpu-threads">{t("CPU threads")}</label><div className="text-size-control"><input id="settings-cpu-threads" data-testid="settings-cpu-threads" type="range" min={1} max={cores} step={1} value={Math.min(threads, cores)} onChange={event => act({ type: 'preferences', patch: { maxCpuThreads: Number(event.target.value) } })} /><strong>{t("{count} threads", { count: formatNumber(threads) })}</strong></div><p className="settings-row-note">{t("The most threads each kind of work (checksums, reading photo details, thumbnails) uses at once; it is a limit per task, not a total. Lower it to keep the Mac responsive. Applies to the next import; file reading adjusts after you restart the app.")}</p></div>
    <div className="settings-row"><label htmlFor="settings-memory-limit">{t("Memory limit")}</label><div className="text-size-control"><input id="settings-memory-limit" data-testid="settings-memory-limit" type="range" min={512} max={memoryMax} step={256} value={Math.min(memory, memoryMax)} onChange={event => act({ type: 'preferences', patch: { memoryLimitMB: Number(event.target.value) } })} /><strong>{t("{count} MB", { count: formatNumber(memory) })}</strong></div><p className="settings-row-note">{t("A soft budget for buffers, caches and the app itself. Near the limit new files wait for running ones; nothing is stopped. Applies to the next import.")}</p></div>
    <div className="settings-row"><span className="performance-readout" data-testid="performance-readout" role="status">{use ? t("Limit {threads} threads per task · {used} MB of {limit} MB budget", { threads: formatNumber(use.threads), used: formatNumber(use.memoryMB), limit: formatNumber(use.limitMB) }) : ''}</span><Button kind="quiet" icon={RotateCcw} data-testid="performance-reset" disabled={atDefaults} onClick={() => use && act({ type: 'preferences', patch: { maxCpuThreads: use.defaultThreads, memoryLimitMB: use.defaultMemoryMB } })}>{t("Reset to defaults")}</Button></div>
    {use?.warning && <p className="source-notice" data-testid="memory-warning"><Icon icon={Info} size={14} />{t("Memory use is above the limit. New files wait until it drops; running work continues.")}</p>}
  </>;
}
/** The diagnostic log: how much it records (applies at once, even while jobs run), where it is, and how to hand it over. */
export function DiagnosticsSettings({ state, act }: { state: AppState; act: Dispatch }) {
  const { t, formatBytes } = useTranslation();
  const level: LogLevel = state.preferences.logLevel, info = state.logInfo;
  const labels: Record<LogLevel, string> = { off: t("Off"), normal: t("Normal"), detailed: t("Detailed"), trace: t("Trace") };
  const explanations: Record<LogLevel, string> = { off: t("Nothing is recorded."), normal: t("Records settings changes, job phases, every file the app deletes, and errors."), detailed: t("Also records each file's steps and decisions, drives, memory and timing."), trace: t("Also records every routing decision and journal entry. Large; for troubleshooting.") };
  return <>
    <div className="settings-row"><label htmlFor="settings-log-level">{t("Log detail")}</label><div className="select-wrap"><select id="settings-log-level" data-testid="settings-log-level" value={level} onChange={event => act({ type: 'preferences', patch: { logLevel: event.target.value as LogLevel } })}>{(Object.keys(labels) as LogLevel[]).map(value => <option key={value} value={value}>{labels[value]}</option>)}</select><Icon icon={ChevronDown} size={15} /></div></div>
    <p className="diagnostics-note" data-testid="log-level-explanation">{explanations[level]}</p>
    <div className="diagnostics-actions"><span className="diagnostics-size" data-testid="log-size" role="status">{t("Log size: {size}", { size: formatBytes(info?.bytes ?? 0) })}</span>
      <Button icon={FolderOpen} data-testid="log-open-folder" onClick={() => act({ type: 'logOpenFolder' })}>{t("Open log folder")}</Button>
      <Button icon={Copy} data-testid="log-copy-path" onClick={() => act({ type: 'logCopyPath' })}>{t("Copy latest log path")}</Button>
      <Button icon={ArrowUpRight} data-testid="log-export" onClick={() => act({ type: 'logExport' })}>{t("Export logs…")}</Button>
    </div>
    <p className="diagnostics-note">{t("Logs stay on this Mac. They never include file contents or recovery keys.")}</p>
  </>;
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
/** Why Check folder layout cannot start now: another destination's check, or other work (the backend refuses the same cases). */
function misplacedText(count: number, t: ReturnType<typeof createTranslator>, formatNumber: (value: number) => string): string {
  return count === 1 ? t("1 file outside your folder structure") : t("{count} files outside your folder structure", { count: formatNumber(count) });
}
// Checks only when the user clicks: finds files placed outside the folder structure inside the backup folder, then offers to move them into place.
export function BackupCheck({ state, act, destinationIndex }: { state: AppState; act: Dispatch; destinationIndex: number }) {
  const { t, formatNumber, formatBytes, language } = useTranslation();
  const destination = state.preferences.destinations[destinationIndex];
  const found = state.misplacedFiles?.[destination];
  const misplaced = !!found && found.count > 0;
  const running = !!state.misplacedProgress?.[destination];
  const status = state.destinationStatus?.find(item => item.path === destination);
  const away = status?.available !== true;
  const wait = state.blocked?.backupCheck;
  const blocked = !!wait || running || away;
  const noFolder = !!found?.missing;
  const check = (kind: 'primary' | 'secondary', label: string) => <Button kind={kind} icon={FolderCog} data-testid="check-backup-folder" disabled={blocked} onClick={() => act({ type: 'checkBackupFolder', destinationIndex })}>{label}</Button>;
  const reveal = <Button kind="quiet" icon={ExternalLink} aria-label={t("Show in file manager")} title={t("Show in file manager")} onClick={() => act({ type: 'reveal', path: destination })} />;
  return <section className="backup-check" aria-labelledby="backup-check-heading" data-testid="backup-check"><div className="card-title"><h4 id="backup-check-heading">{t("Check folder layout")}</h4><p>{t("The folder layout is checked only when you click Check folder layout.")}</p></div>
    {state.misplacedProgress?.[destination] && <p className="folder-check-label" data-step="folder-check" data-testid="folder-check-label" role="status">{t("Checking {drive} folder layout", { drive: driveName(destination, basename(destination)) })}</p>}
    {state.misplacedProgress?.[destination] && <OperationProgress progress={state.misplacedProgress[destination]} label={t("Backup folder check progress")} testId="misplaced-progress" holdKey={`misplaced:${destination}`} />}
    {noFolder && !running && <p className="backup-check-note" data-testid="backup-folder-missing" role="status">{t("No backup folder yet. The first import creates it.")}</p>}
    {found && !noFolder && (misplaced ? <p className="misplaced-files" data-testid="misplaced-files" role="status"><Icon icon={CircleAlert} size={15} /><span>{misplacedText(found.count, t, formatNumber)} · {formatBytes(found.bytes)}</span></p> : <p className="misplaced-files is-clean" role="status"><Icon icon={CheckCircle2} size={15} /><span>{t("Backup folder is in order.")}</span></p>)}
    {found && !noFolder && <p className="backup-check-note" data-testid="checked-at">{t("Checked {time}", { time: formatWhen(found.checkedAt, language) })}</p>}
    {noFolder && !running ? null : !found && !running ? <div className="backup-check-prompt" data-testid="backup-check-prompt"><p>{t("Check whether every file in this backup is in the folder your rules give it.")}</p><div className="backup-check-actions">{check('secondary', t("Check folder layout"))}{reveal}</div></div> : <div className="backup-check-actions">{check('secondary', running ? t("Checking…") : t("Check again"))}{running && <Button kind="quiet" icon={X} data-testid="stop-backup-check" onClick={() => act({ type: 'stopBackupCheck' })}>{t("Stop")}</Button>}{reveal}</div>}
    {!away && wait && !running && <p className="backup-check-note" role="status">{t(message(wait))}</p>}
    {away && <p className="backup-check-note" role="status">{status?.available === false ? t("Reconnect this drive to check its folder layout.") : t("Checking destination…")}</p>}
  </section>;
}
export function Organization({ state, act, busy, selectedDestination = 0, onSelectDestination = () => {}, onFolderRules }: { onFolderRules?: () => void; state: AppState; act: Dispatch; busy: boolean; selectedDestination?: number; onSelectDestination?: (index: number) => void }) {
  const { t } = useTranslation();
  const p = state.preferences;
  const [chosenScopes, setChosenScopes] = useState<Record<string, 'backup' | 'whole'>>({});
  const destinationIndex = organizationDestinationIndex(p, selectedDestination);
  const destination = p.destinations[destinationIndex];
  const chosenScope = destination ? chosenScopes[destination] : undefined;
  const selectedFolders = destination ? state.organizationFolders?.[destination] : undefined;
  const targetFolder = destination ? [destination.replace(/[\\/]$/, ''), p.basePath].filter(Boolean).join('/') : '';
  const runningOrganization = state.jobs.find(job => job.organization && (isRunning(job) || job.phase === 'queued'));
  const organizing = !!state.blocked?.organize;
  // The backup folder is the default scope; picked folders always win, and without a backup folder the whole destination is the only other whole scope.
  const scope: 'backup' | 'whole' | 'chosen' = selectedFolders ? 'chosen' : chosenScope === 'whole' || !p.basePath ? 'whole' : 'backup';
  const pickScope = (next: 'backup' | 'whole') => { if (destination) setChosenScopes(scopes => ({ ...scopes, [destination]: next })); if (selectedFolders) act({ type: 'resetOrganizationFolders', destinationIndex }); };
  const videoTarget = p.mediaLayout === 'video-root' ? [destination?.replace(/[\\/]$/, ''), p.videoBasePath].filter(Boolean).join('/') : '';
  // An open organize review runs with its own options: the switches show those, never the next run's.
  const organizeOptions = (state.review?.kind === 'reorganize' ? state.review.options : undefined) ?? state.organizeOptions;
  return <div className="organization-page">
    {/* Two independent stacks: a card's height never moves the cards in the other column. */}
    <div className="organization-column">
    {runningOrganization && <section className="organization-action organization-running" aria-labelledby="organization-running-heading"><CardHeader icon={LoaderCircle} id="organization-running-heading" title={t("Organizing now")} detail={organizationPlace(runningOrganization, true)} /><OrganizationProgress job={runningOrganization} act={act} /></section>}
    <section className="organization-action" aria-labelledby="organize-existing-heading"><CardHeader icon={FolderCog} id="organize-existing-heading" title={t("Organize backup")} detail={t("Move existing files into your folder structure.")} />{p.destinations.length > 1 && <label className="organization-destination-select">{t("Destination")}<div className="select-wrap"><select aria-label={t("Organization destination")} disabled={busy} value={destinationIndex} onChange={event => { const index = Number(event.target.value); animateInterfaceChange(() => onSelectDestination(index)); }}>{destinationLabels(p.destinations).map((label,index) => <option key={p.destinations[index]} value={index}>{label}</option>)}</select><Icon icon={ChevronDown} size={14} /></div>{destination && <small className="organization-destination-path" title={destination}><bdi>{destination}</bdi></small>}</label>}{destination ? <><fieldset className="organization-scope"><legend>{t("Organize scope")}</legend><div className="organization-scope-options" role="radiogroup"><label><input type="radio" name="organization-scope" checked={scope === 'backup'} disabled={busy || !p.basePath} onChange={() => pickScope('backup')} />{t("Backup folder")}</label><label><input type="radio" name="organization-scope" checked={scope === 'whole'} disabled={busy} onChange={() => pickScope('whole')} />{t("Whole destination")}</label><label><input type="radio" name="organization-scope" checked={scope === 'chosen'} disabled={busy} onChange={() => { if (scope !== 'chosen') act({ type: 'chooseOrganizationFolders', destinationIndex }); }} />{t("Chosen folders")}</label></div>{scope === 'chosen' && <div className="rule-actions"><Button icon={FolderOpen} disabled={busy} onClick={() => act({ type: 'chooseOrganizationFolders', destinationIndex })}>{t("Choose folders…")}</Button><Button kind="quiet" disabled={busy} onClick={() => pickScope('whole')}>{t("Use whole destination")}</Button></div>}{scope === 'chosen' && <p>{t("Only the selected folders will be scanned.")}</p>}{scope === 'whole' && <p>{t("All folders on this destination will be scanned.")}</p>}{selectedFolders && <ul aria-label={t("Selected organization folders")}>{selectedFolders.map(folder => <li key={folder}>{folder}</li>)}</ul>}</fieldset><dl className="organization-paths"><div><dt>{t("Scan existing files in")}</dt><dd>{scope === 'backup' ? targetFolder : destination}{scope === 'backup' && videoTarget && <><br />{videoTarget}</>}</dd></div><div><dt>{t("New structure under")}</dt><dd>{targetFolder}{videoTarget && <><br />{videoTarget}</>}</dd></div></dl><BackupCheck state={state} act={act} destinationIndex={destinationIndex} /></> : <p className="inline-note">{t("Choose a backup location in Settings to begin.")}</p>}<div className="organization-option" data-testid="remove-empty-folders"><Switch checked={organizeOptions.removeEmptyFolders} disabled={busy} onChange={removeEmptyFolders => act({ type: 'organizeOptions', removeEmptyFolders })} label={t("Remove emptied source folders")} detail={t("Folders left empty after organizing are removed. Folders with files are kept.")} /></div><div className="organization-option" data-testid="release-duplicates"><Switch checked={organizeOptions.releaseDuplicates} disabled={busy} onChange={releaseDuplicates => act({ type: 'organizeOptions', releaseDuplicates })} label={t("Remove confirmed duplicates")} detail={t("After organizing finishes without errors, originals already present at their destination are checked again and removed instead of kept for undo.")} /></div><p className="inline-note" data-testid="organize-default"><Icon icon={Info} size={14} />{t("Organize: move, source removed")}</p><div className="rule-actions organization-execute" data-testid="organization-execute">{onFolderRules && <Button kind="quiet" className="organization-rules" icon={Settings2} onClick={onFolderRules}>{t("Edit folder rules")}</Button>}<Button icon={Eye} data-testid="review-changes" disabled={busy || !destination || (scope === 'backup' && !!state.misplacedFiles?.[destination]?.missing)} onClick={() => act({ type: 'previewOrganization', destinationIndex, ...(scope === 'backup' ? { scope: 'backup' as const } : {}) })}>{t("Review changes…")}</Button><Button kind="primary" icon={FolderCog} data-testid="organize-now" disabled={organizing || !destination || (scope === 'backup' && !!state.misplacedFiles?.[destination]?.missing)} onClick={() => act({ type: scope === 'backup' ? 'organizeBackup' : 'organize', destinationIndex })}>{t("Organize now")}</Button></div></section>
    </div>
    <div className="organization-column">
    <section className="organization-action" aria-labelledby="organize-folder-heading" data-testid="organize-folder"><CardHeader icon={FolderOpen} id="organize-folder-heading" title={t("Organize a folder")} detail={t("Sorts a folder's files into your folder structure, inside that folder.")} />{p.mediaLayout === 'video-root' && <OrganizeFolderLayoutNote />}<p className="inline-note"><Icon icon={Info} size={14} />{t("Organize: move, source removed")}</p><div className="rule-actions"><Button icon={FolderOpen} disabled={organizing || p.mediaLayout === 'video-root'} onClick={() => act({ type: 'organizeFolder' })}>{t("Choose folder…")}</Button></div></section>

    </div>

  </div>;
}

export function OrganizationRecoveryPanel({ state, act, busy }: { state: AppState; act: Dispatch; busy: boolean }) {
  const { t, formatNumber } = useTranslation();
  const recovery = (state.organizationRecovery ?? []).filter(job => job.kind !== 'duplicates');
  const duplicates = (state.organizationRecovery ?? []).filter(job => job.kind === 'duplicates');
  return <><section className="organization-recovery" aria-labelledby="organization-recovery-heading"><CardHeader icon={RotateCcw} id="organization-recovery-heading" title={t("Organization recovery")}><Button icon={RefreshCw} disabled={busy} onClick={() => act({ type: 'refreshOrganization' })}>{t("Refresh list")}</Button></CardHeader>{recovery.length > 0 ? <div className="recovery-jobs">{recovery.map(job => <article className="recovery-job" key={`${job.root}-${job.id}`}><div className="recovery-job-heading"><span className={`source-status ${job.status === 'pending' ? 'queued' : 'complete'}`}><Icon icon={job.status === 'pending' ? Clock3 : CheckCircle2} size={15} />{job.missingRoot ? t("Library folder not found") : job.status === 'complete' ? t("Last completed") : job.status === 'superseded' ? t("Replaced by a later organization") : job.status === 'undone' ? t("Undone") : t("Needs recovery")}</span>{(job.status === 'complete' || job.status === 'pending') && !job.missingRoot && <Button icon={job.status === 'complete' ? RefreshCw : Play} disabled={busy} onClick={() => act({ type: 'recovery', op: 'resume', id: job.id, root: job.root })}>{job.status === 'complete' ? t("Recheck") : t("Resume & recheck")}</Button>}{job.status === 'complete' && <Button kind="quiet" disabled={busy} title={t("Reads every organized file again, not only those changed since the last recheck.")} onClick={() => act({ type: 'recovery', op: 'resume', id: job.id, root: job.root, full: true })}>{t("Full recheck")}</Button>}</div><p className="recovery-root">{job.root}</p>{job.status === 'complete' || job.status === 'pending' ? <p className="recovery-count">{t("Last verified: {completed} of {total} files", { completed: formatNumber(job.completed), total: formatNumber(job.files) })}</p> : <p className="recovery-count">{t("{count} files", { count: formatNumber(job.files) })}</p>}<RetainedOriginals job={job} act={act} busy={busy} recoverySize={state.recoverySize} /></article>)}</div> : <p className="recovery-empty">{state.organizationRecoveryLoading ? t("Reading organization history…") : state.organizationRecoveryPaused ? t("Reading organization history is paused while a job uses the drive. It continues afterwards.") : t("No organization history.")}</p>}{state.organizationRecoveryLoading && <OperationProgress progress={state.organizationRecoveryProgress} label={t("Organization history progress")} testId="recovery-progress" />}</section>{duplicates.length > 0 && <RemovedDuplicates jobs={duplicates} act={act} busy={busy} />}</>;
}

/** Activity › Queue: every job as one compact row; the full card stays on the Import desk or in Library › Organize. */
export function ActivityJobs({ state, act, onShow }: { state: AppState; act: Dispatch; onShow?: (job: Job) => void }) {
  const { t } = useTranslation();
  return <div className="activity-jobs" data-testid="activity-job-list">
    <div className="rule-actions activity-jobs-bar">{!state.jobs.length && <p className="inline-note">{t("No jobs yet.")}</p>}<Button icon={Square} data-testid="activity-stop-all" title={t("Stops imports, scans and organizing, and discards the open review.")} disabled={!anyWorkToStop(state)} onClick={() => act({type:'stop'})}>{t("Stop all")}</Button></div>
    {state.jobs.length ? <ul className="queue-list">{state.jobs.map(job => <QueueRow key={job.id} job={job} act={act} queuePosition={(state.queueOrder ?? []).indexOf(job.id) + 1} verifyOff={!state.preferences.verifyCopies} onShow={onShow} />)}</ul> : null}
  </div>;
}
/** One job in the queue: name, status, a thin progress bar with its moving counter, Pause/Stop, and Show. */
function QueueRow({ job, act, queuePosition, verifyOff, onShow }: { job: Job; act: Dispatch; queuePosition: number; verifyOff: boolean; onShow?: (job: Job) => void }) {
  const { t, formatNumber, formatBytes } = useTranslation();
  const held = useHeld();
  const organization = !!job.organization, source = job.source, progress = job.progress;
  const active = isRunning(job), queued = job.phase === 'queued', paused = job.phase === 'stopped' && !!job.paused;
  const name = organization ? t("Library organization") : source.name;
  const status = organization ? organizationStatus(job, t) : paused ? t("Paused") : importJobStatus(job, t, queuePosition);
  const icon = organization ? FolderCog : source.transport === 'camera' ? Camera : source.transport === 'folder' ? Folder : Save;
  return <li className={`queue-row ${job.phase === 'error' ? 'is-error' : ''}`} data-source-id={source.id} data-job-id={job.id} data-testid={organization ? "organization-card" : "queue-row"} data-phase={job.phase}>
    <div className="queue-row-head">
      <Icon icon={icon} size={18} />
      <div className="queue-row-name"><strong title={organization ? organizationPlace(job, true) : source.name}>{name}</strong>{organization && <small title={organizationPlace(job, true)}>{organizationPlace(job, true)}</small>}<span className={`source-status ${paused ? 'paused' : job.phase}`}><span key={status} className="source-status-text">{status}</span>{job.backup && !organization && <span className="small-tag">{t("Folder backup")}</span>}</span></div>
      <div className="queue-row-actions">
        {(active || queued) && <><Button icon={Pause} disabled={!!job.stopping} aria-label={t("Pause {name}", { name })} onClick={() => act({ type: 'pause', sourceId: source.id })}>{t("Pause")}</Button><Button kind="quiet" icon={Square} disabled={job.stopping === 'stop'} aria-label={t("Stop {name}", { name })} title={t("Stop")} onClick={() => act({ type: 'stop', jobId: job.id })} /></>}
        {paused && <Button icon={Play} onClick={() => act(organization ? { type: 'continueOrganization', jobId: job.id } : { type: 'start', sourceId: source.id })}>{organization ? t("Resume") : t("Continue")}</Button>}
        {onShow && <Button kind="quiet" icon={ArrowUpRight} aria-label={t("Show {name}", { name })} title={organization ? t("Show in Library") : t("Show on the Import desk")} onClick={() => onShow(job)}>{t("Show")}</Button>}
      </div>
    </div>
    {((progress && !queued) || active) && <ProgressDisplay className="queue-progress" label={t("{name} copy progress", { name })} fraction={queued ? 0 : cardFraction(job)} finished={jobFinished(job)}
      count={job.stopping ? (job.stopping === 'pause' ? t("Pausing…") : t("Stopping…")) : progress ? progressCount(progress, t, formatNumber, organization, organization || progress.step === 'comparing' ? formatBytes : undefined) : undefined}
      speed={active && progress ? progress : undefined} {...jobTiming(job, t, held)} step={!progress ? 'scan' : stepKind(progress)} stages={jobStageLayers(job, !verifyOff)} paused={jobPaused(job)} />}
    {job.detail && !(job.phase === 'error') && <p className="source-detail" title={t(job.detail)}>{t(job.detail)}</p>}
    <SkipFileNotice job={job} act={act} />
  </li>;
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
  const editedFolder = p.editedFolder;
  return <div className="folder-settings" data-testid="folder-settings">
      <SettingsSection title={t("Backup folders")} icon={HardDrive}>
        <TextPreference label={t("Backup folder")} value={p.basePath} placeholder="photobackup" onSave={basePath => act({ type: 'preferences', patch: { basePath } })} description={t("Leave empty to use the drive itself.")} />
        {videoRoot && <TextPreference label={t("Video backup folder")} value={p.videoBasePath} placeholder="videobackup" onSave={videoBasePath => act({ type: 'preferences', patch: { videoBasePath } })} description={t("Created beside the photo backup folder on each destination.")} />}
      </SettingsSection>
      <SettingsSection title={t("Folder structure")} icon={FolderCog}>
        {videoRoot && <h4 className="path-builder-heading">{t("Photo folders")}</h4>}
        <FolderPathBuilder template={p.template} onChange={template => act({ type: 'preferences', patch: { template } })} testId="photo-path-builder" />
        <h4 className="path-builder-heading">{t("Then sort by file type")}</h4>
        <div className="preset-grid" role="radiogroup" aria-label={t("Media layout")}>{mediaLayouts.map(layout => <button type="button" role="radio" key={layout.value} className={`preset ${p.mediaLayout === layout.value ? 'selected' : ''}`} aria-checked={p.mediaLayout === layout.value} onClick={() => act({ type: 'preferences', patch: { mediaLayout: layout.value } })}><span className="preset-radio">{p.mediaLayout === layout.value && <span />}</span><span><strong>{t(layout.title)}</strong><small>{t(layout.detail)}</small></span></button>)}</div>
        {videoRoot && <><h4 className="path-builder-heading">{t("Video folders")}</h4><Switch checked={!p.videoTemplate} onChange={same => act({ type: 'preferences', patch: { videoTemplate: same ? '' : p.template } })} label={t("Use the photo folder path for videos")} />{!!p.videoTemplate && <FolderPathBuilder template={p.videoTemplate} onChange={videoTemplate => act({ type: 'preferences', patch: { videoTemplate } })} testId="video-path-builder" />}</>}
        <PathPreview label={t("Your next photo lands here")} parts={[...folders(p.basePath), ...samplePath(p.template), ...layoutFolders(p.mediaLayout, false, 'NEF'), 'DSC_0001.NEF']} testId="photo-preview" />
        <PathPreview label={t("Your next video lands here")} parts={[...folders(videoRoot ? p.videoBasePath : p.basePath), ...samplePath(videoRoot && p.videoTemplate ? p.videoTemplate : p.template), ...layoutFolders(p.mediaLayout, true, 'MOV'), 'DSC_0002.MOV']} testId="video-preview" />
        <details className="path-advanced" data-testid="custom-template"><summary>{t("Advanced: custom template")}</summary>
          <TextPreference label={t(videoRoot ? "Photo folder template" : "Folder template")} value={p.template} onSave={template => template && act({ type: 'preferences', patch: { template } })} description={t("Available tokens: {year}, {yyyymm}, {month}, {monthName}, {yearMonthName}, {day}, {yyyyMMdd}, {camera}")} />
          {videoRoot && !!p.videoTemplate && <TextPreference label={t("Video folder template")} value={p.videoTemplate} onSave={videoTemplate => videoTemplate && act({ type: 'preferences', patch: { videoTemplate } })} description={t("Available tokens: {year}, {yyyymm}, {month}, {monthName}, {yearMonthName}, {day}, {yyyyMMdd}, {camera}")} />}
        </details>
      </SettingsSection>
      <SettingsSection title={t("Edited exports folder")} icon={Folder}>
        <TextPreference label={t("Edited exports folder")} value={editedFolder} placeholder="editied" onSave={editedFolder => act({type:'preferences',patch:{editedFolder}})} description={t("Edited exports go here, inside each month folder.")} />
        <PathPreview label={t("Your edited export lands here")} parts={[...folders(p.basePath), ...samplePath(editedTemplate(editedFolder)), 'DSC_0001.jpg']} testId="edited-export-preview" />
      </SettingsSection>
  </div>;
}

function HistoryPage({ state, onDesk }: { state: AppState; onDesk: () => void }) {
  const { t, language } = useTranslation();
  return <div className="history-page"><div className="page-toolbar"><span className="session-count">{state.history.length === 1 ? t("1 session") : t("{count} sessions", { count: state.history.length })}</span></div>{state.history.length === 0 ? <div className="history-empty"><div><Icon icon={History} size={38} /></div><h3>{t("Your collection starts here.")}</h3><p>{t("Finished operations appear here.")}</p><Button kind="primary" icon={ArrowDownToLine} onClick={onDesk}>{t("Go to Import")}</Button></div> : <ol className="history-timeline">{state.history.map(record => {
    const attention = record.outcome === 'attention', stopped = record.outcome === 'stopped';
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
  const fields = Object.entries(preview.fields ?? {}).filter(([key, value]) => key.split(':').at(-1)!=='Error' && `${key} ${metadataText(value)}`.toLowerCase().includes(query.toLowerCase()));
  return <dialog className="metadata-dialog" ref={dialog} aria-labelledby="metadata-heading" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="dialog-heading"><div><span className="dialog-kicker"><Icon icon={FileImage} size={15} />{t("File metadata")}</span><h2 id="metadata-heading">{basename(preview.path)}</h2></div><Button kind="quiet" icon={X} data-testid="metadata-close" aria-label={t("Close metadata")} onClick={close} /></div>
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
        {!video && <section className="capture-shutter"><dl><div><dt>{t("Shutter count")}</dt><dd data-testid="metadata-shutter-count">{metadata?.shutterCount !== undefined ? formatNumber(metadata.shutterCount) : t("Not available")}</dd></div></dl></section>}
        <details className="metadata-details" key={preview.path} data-testid="metadata-details"><summary><Icon icon={ChevronDown} size={17} /><span>{t("All metadata")}</span><small>{preview.fields && t("{count} fields", { count: formatNumber(Object.keys(preview.fields).length) })}</small></summary><div className="metadata-details-content">
          {!video && metadata?.shutterNote && <p className="shutter-note"><Icon icon={Info} size={14} />{t(shutterNoteText(metadata.shutterNote))}</p>}
          <input type="search" placeholder={t("Find a metadata field…")} aria-label={t("Search metadata fields")} value={query} onChange={event => setQuery(event.target.value)} />
          <dl className="metadata-fields">{fields.map(([key, value]) => <div key={key}><dt>{key.replace(/([a-z])([A-Z])/g, '$1 $2')}</dt><dd>{metadataText(value)}</dd></div>)}</dl>
          {preview.fields && fields.length === 0 && <p className="metadata-empty">{query ? t("No metadata fields match your search.") : t("No metadata fields were returned for this file.")}</p>}
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

/** Rows of a long list drawn only where they are scrolled to, so thousands of files cost a screenful. */
export function VirtualList<T>({ items, render, rowHeight = 28, height = 224, label }: { items: readonly T[]; render: (item: T) => ReactNode; rowHeight?: number; height?: number; label: string }) {
  const [top, setTop] = useState(0);
  const start = Math.max(0, Math.floor(top / rowHeight) - 4), end = Math.min(items.length, Math.ceil((top + height) / rowHeight) + 4);
  return <div className="virtual-list" role="list" aria-label={label} style={{ height: Math.min(height, items.length * rowHeight) }} onScroll={event => setTop(event.currentTarget.scrollTop)}>
    <div style={{ height: items.length * rowHeight, position: 'relative' }}>{items.slice(start, end).map((item, offset) => <div role="listitem" key={start + offset} className="virtual-row" style={{ top: (start + offset) * rowHeight, height: rowHeight }}>{render(item)}</div>)}</div>
  </div>;
}

/** What choosing each option for unknown files asks the app to do (for this review only). */
export const noMetadataChoiceAction = (handling: NoMetadataHandling): Action => ({ type: 'reviewNoMetadata', handling });

/** The warning before a job that leaves or files apart unknown files (no date, no camera, or unreadable). Nothing starts until Continue. */
export function NoMetadataNotice({ review, act, busy = false, defaultOpen = false, library }: { library?: string; review: Pick<NonNullable<AppState['review']>, 'kind' | 'source' | 'noMetadata' | 'destinationIndex' | 'collectProblemFiles' | 'noMetadataHandling' | 'fileDated'>; act: Dispatch; busy?: boolean; defaultOpen?: boolean }) {
  const { t, formatNumber } = useTranslation();
  const [listing, setListing] = useState(defaultOpen);
  const found = review.noMetadata ?? review.fileDated;
  if (!found) return null;
  const organizing = review.kind === 'reorganize', count = formatNumber(found.count);
  const active: NoMetadataHandling = review.noMetadataHandling ?? found.handling;
  const where = library ? `${library}/${found.folder}` : found.folder;
  const headline = active === 'fileDate'
    ? t("{count} unknown files will be filed by their file date.", { count })
    : active === 'keep'
    ? organizing ? t("{count} unknown files will be left where they are.", { count }) : t("{count} unknown files will not be copied; they stay on the source.", { count })
    : organizing ? t("{count} unknown files will be moved to {folder}.", { count, folder: found.folder }) : t("{count} unknown files will be copied to {folder}.", { count, folder: found.folder });
  const reasons = [
    found.counts.noDate > 0 && t("{count} without a date", { count: formatNumber(found.counts.noDate) }),
    found.counts.noCamera > 0 && t("{count} without a camera", { count: formatNumber(found.counts.noCamera) }),
    found.counts.unreadable > 0 && t("{count} unreadable", { count: formatNumber(found.counts.unreadable) }),
  ].filter(Boolean).join(', ');
  const reasonName = (reason: 'noDate' | 'noCamera' | 'unreadable') => reason === 'noDate' ? t("No capture date") : reason === 'noCamera' ? t("No camera") : t("Could not be read");
  const choices: { handling: NoMetadataHandling; label: string }[] = [
    { handling: 'folder', label: organizing ? t("Move to {folder}", { folder: found.folder }) : t("Copy to {folder}", { folder: found.folder }) },
    { handling: 'keep', label: t("Leave where they are") },
    { handling: 'fileDate', label: t("Use file date") },
  ];
  return <section className="no-metadata-notice" role="alert" data-testid="no-metadata-notice">
    <div className="no-metadata-heading"><Icon icon={CircleAlert} size={18} /><div><strong>{headline}</strong><p>{reasons}</p><p>{t("They have no capture date, no camera or known origin, or could not be read, such as screenshots, edited exports and files from messaging apps. Nothing starts until you apply the review.")}</p></div></div>
    <div className="no-metadata-actions">
      <Button onClick={() => setListing(open => !open)} aria-expanded={listing}>{listing ? t("Hide files") : t("Show files")}</Button>
      <div className="segmented" role="group" aria-label={t("What to do with these files")}>{choices.map(choice => <button key={choice.handling} type="button" disabled={busy} aria-pressed={active === choice.handling} onClick={() => { if (active !== choice.handling) act(noMetadataChoiceAction(choice.handling)); }}>{choice.label}</button>)}</div>
    </div>
    {listing && <div data-testid="no-metadata-files"><VirtualList label={t("Unknown files")} items={found.files} render={item => <><span className="virtual-name" title={item.relative}>{item.relative}</span><span className="virtual-reason">{reasonName(item.reason)}</span></>} />{found.count > found.files.length && <p>{t("and {count} more", { count: formatNumber(found.count - found.files.length) })}</p>}</div>}
  </section>;
}

export function ProblemFilesReview({ review, act, busy = false }: { review: Pick<NonNullable<AppState['review']>, 'kind' | 'problems' | 'collectProblemFiles' | 'destinationIndex' | 'scope'>; act: Dispatch; busy?: boolean }) {
  const { t, formatNumber } = useTranslation();
  const problems = review.problems ?? [];
  if (!problems.length) return null;
  const organizing = review.kind === 'reorganize';
  const collected = problems.filter(item => item.collected), left = problems.length - collected.length;
  const groups = (['empty', 'unreadable'] as const).map(group => ({ group, count: problems.filter(item => item.group === group).length })).filter(item => item.count > 0);
  const groupName = (group: 'empty' | 'unreadable') => group === 'empty' ? t("Empty files") : t("Unreadable files");
  const reasonName = (reason: 'empty' | 'emptyPrimary' | 'unreadable') => reason === 'unreadable' ? t("Could not be read") : t(message(reason === 'empty' ? 'inventory.emptyFile' : 'inventory.emptyPrimaryFile'));
  const shown = problems.slice(0, 200);
  const summary = [
    organizing && collected.length > 0 && t("{count} problem files will be collected into Problem files/…", { count: formatNumber(collected.length) }),
    organizing && left > 0 && t("{count} problem files will stay where they are", { count: formatNumber(left) }),
    !organizing && t("{count} problem files are skipped and not copied", { count: formatNumber(problems.length) }),
  ].filter(Boolean).join(' · ');
  return <section className="problem-files" data-testid="problem-files">
    <details className="skipped-files">
      <summary><Icon icon={Info} size={14} /><span>{summary}</span><Icon icon={ChevronDown} size={14} /></summary>
      <div className="skipped-files-content">
        <div><dl>{groups.map(item => <div key={item.group}><dt>{groupName(item.group)}</dt><dd>{formatNumber(item.count)}</dd></div>)}</dl></div>
        <div><dl>{shown.map(item => <div key={item.path}><dt>{item.relative}</dt><dd>{reasonName(item.reason)}</dd></div>)}</dl>{problems.length > shown.length && <p>{t("and {count} more", { count: formatNumber(problems.length - shown.length) })}</p>}</div>
      </div>
    </details>
    {organizing && review.destinationIndex !== undefined && <div data-testid="collect-problem-files-review"><Switch checked={review.collectProblemFiles !== false} disabled={busy} onChange={collectProblemFiles => act({ type: 'previewOrganization', destinationIndex: review.destinationIndex!, collectProblemFiles, ...(review.scope === 'backup' ? { scope: 'backup' as const } : {}) })} label={t("Collect problem files")} detail={t("Move 0-byte files and their companions into Problem files. Undo puts them back.")} /></div>}
  </section>;
}

export function ReviewPanel({ state, act, inspect }: { state: AppState; act: Dispatch; inspect: (path: string) => void }) {
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
  return <section className="review-panel" aria-labelledby="review-heading"><div className="review-heading"><div><span className="review-kicker"><Icon icon={Eye} size={16} />{t(review.kind === 'reorganize' ? "Review before reorganizing" : "Review before copying")}</span><h2 id="review-heading">{review.kind === 'reorganize' ? t("Review your new folder structure") : t(review.backup ? "{name}: backup preview" : "{name}: import preview", { name: review.source.name })}</h2><p>{review.kind === 'reorganize' ? t("Nothing moves until you apply.") : t("Copying starts when you apply.")}</p><p className="review-mode" data-testid="review-mode"><strong>{review.kind === 'reorganize' ? t("Organize: move, source removed") : t(review.backup ? "Backup: copy, source untouched" : "Import: copy, source untouched")}</strong>{review.kind === 'reorganize' && review.options && <> · {review.options.removeEmptyFolders ? t("Emptied source folders are removed") : t("Emptied source folders are kept")} · {review.options.releaseDuplicates ? t("Confirmed duplicates are released") : t("Confirmed duplicates are kept for undo")}</>}</p></div><span className="status-pill"><Icon icon={CheckCircle2} size={14} />{t("Ready to review")}</span></div><div className="review-summary"><span>{t(review.kind === 'reorganize' ? "{count} files to organize" : "{count} copies to write", { count: formatNumber(changed.length) })}</span><span>{t("{count} already verified", { count: formatNumber(verified) })}</span><span>{t(review.kind === 'reorganize' ? "{size} to organize" : "{size} to copy", { size: bytes(changed.reduce((sum, entry) => sum + entry.size, 0)) })}</span>{review.backup && <span className="small-tag">{t("Folder backup")}</span>}</div>{review.kind === 'import' && driveContext(review.source, state.sources, state.destinationStatus)?.onDestination && <SameDriveNotice sourceId={review.source.id} act={act} organizeBlocked={state.preferences.mediaLayout === 'video-root'} />}<div className="review-destinations">{review.plans.map((plan, index) => <div key={`${index}-${plan.root}`}><Icon icon={HardDrive} size={14} /><span>{review.plans.length > 1 ? t("Destination {count}: ", { count: index + 1 }) : ''}{[plan.root, ...(plan.videos ? [plan.videos.root] : [])].join(' · ')}</span></div>)}</div><MirrorRemovals review={review} /><NoMetadataNotice review={review} library={review.plans[0] && basename(review.plans[0].root)} act={act} busy={!!state.busyReview || state.jobs.some(job => ['discovering', 'verifying', 'copying'].includes(job.phase))} /><ProblemFilesReview review={review} act={act} busy={!!state.busyReview} /><div className="review-toolbar"><label><Icon icon={Files} size={15} /><span>{t("{count} files", { count: formatNumber(visible.length) })}</span></label><input type="search" placeholder={t("Find a source, destination or checksum…")} aria-label={t("Search reviewed files")} value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></div><div className="review-table-scroll"><table className="review-table"><thead><tr><th scope="col">{review.kind === 'reorganize' ? t("Existing path") : t("Source")}</th><th scope="col">{review.kind === 'reorganize' ? t("New path") : t("Destination")}</th><th scope="col">{t("Type / size")}</th><th scope="col">{t("Action")}</th><th scope="col">{t("Checksum")}</th></tr></thead><tbody>{visible.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(entry => <tr key={`${entry.destinationIndex}-${entry.id}`}><td><button type="button" className="review-source-button" onClick={() => inspect(entry.source)} title={t("Show metadata for {name}", { name: basename(entry.source) })}><Icon icon={entry.kind === 'Other' ? Files : FileImage} size={14} /><span>{entry.source}</span></button></td><td><span className="review-destination-path">{entry.destination}</span></td><td><span>{t(entry.kind)}</span><small>{bytes(entry.size)}</small></td><td><span className={`file-inclusion ${entry.skip ? 'included' : ''}`}><Icon icon={entry.skip ? CheckCheck : review.kind === 'reorganize' ? ArrowRight : Copy} size={13} />{entry.skip ? t("Keep verified") : review.kind === 'reorganize' ? t("Organize") : t("Copy")}</span></td><td>{entry.digest ? <span className="review-checksum" title={entry.digest}>{entry.digest.slice(0, 12)}{entry.digest.length > 12 ? '…' : ''}</span> : <span className="review-checksum review-checksum-pending">{t("Computed during copy")}</span>}</td></tr>)}</tbody></table>{visible.length === 0 && <p className="table-empty">{entries.length === 0 ? t("No files need to be processed.") : t("No files match this search.")}</p>}</div>{visible.length > pageSize && <div className="review-pagination"><span>{t("Files {start}–{end} of {total}", { start: formatNumber(currentPage * pageSize + 1), end: formatNumber(Math.min((currentPage + 1) * pageSize, visible.length)), total: formatNumber(visible.length) })}</span><div><Button disabled={currentPage === 0} onClick={() => animateInterfaceChange(() => setPage(currentPage - 1))}>{t("Previous")}</Button><Button disabled={currentPage === lastPage} onClick={() => animateInterfaceChange(() => setPage(currentPage + 1))}>{t("Next")}</Button></div></div>}<div className="review-footer"><span><Icon icon={ShieldCheck} size={16} /></span><div><Button disabled={state.busyReview} onClick={() => act({ type: 'discardReview' })}>{t("Discard review")}</Button><Button kind="primary" icon={review.kind === 'reorganize' ? ArrowRight : Copy} disabled={state.busyReview || (entries.length === 0 && !review.plans.some(plan => plan.removals?.length))} onClick={() => act({ type: 'applyReview' })}>{review.kind === 'reorganize' ? t("Apply reviewed organization") : t("Copy reviewed files")}</Button></div></div></section>;
}
