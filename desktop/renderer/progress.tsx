import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pause, Play, Square, Timer } from 'lucide-react';
import type { Job, Progress } from '../shared';
import { isRunning } from '../shared';
import { DisplayHold, remainingBucket, remainingRange } from '../eta-format';
import { createTranslator, useTranslation, formatNumber as numberIn, formatSpeed, speedUnit, type SpeedUnit } from './i18n';
import { Button, Icon, type Dispatch } from './ui';

/** The one progress layout every operation uses, and the reading of a job's progress it draws. */
/** A long path cut in the middle so both its folder and its file name stay readable. */
export function truncateMiddle(value: string, max = 56): string {
  if (value.length <= max) return value;
  const keep = max - 1, head = Math.ceil(keep * .4), tail = keep - head;
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}
/** The file a step is on, as the path relative to the source root, with its full path as the tooltip. */
/** The kinds of step a progress bar can show; each has one color (--step-<kind> in styles.css) everywhere it is drawn. */
export type StepKind = 'scan' | 'read' | 'compare' | 'copy' | 'verify' | 'move' | 'tidy' | 'delete';
export function stepKind(progress?: Pick<Progress, 'phase' | 'step' | 'renames'>): StepKind | undefined {
  if (!progress) return undefined;
  switch (progress.step) {
    case 'listing': case 'scanning': return 'scan';
    case 'checking': case 'reading': case 'history': case 'earlier': case 'later': case 'records': case 'journals': case 'preparing': case 'index': return 'read';
    case 'comparing': case 'locating': case 'existing': case 'confirming': case 'mirroring': return 'compare';
    case 'moving': return 'move';
    case 'stashing': case 'tidying': case 'releasing': case 'restoring': case 'removing': case 'cleaning': case 'measuring': return 'tidy';
    case 'deleting': return 'delete';
    case 'downloading': return 'copy';
  }
  return progress.phase === 'verifying' ? 'verify' : progress.renames ? 'move' : progress.phase === 'planning' ? 'read' : 'copy';
}
/** The file in progress sits on its own full-width line below the stats, so a longer name never moves them. */
function ProgressFile({ file }: { file?: string }) {
  return file ? <span className="progress-file" data-testid="progress-file" title={file}>{truncateMiddle(file)}</span> : null;
}
/** The one progress layout every operation uses: the bar, then "{done} of {total} {unit}" with the percent, the speed,
 * elapsed and time left, and the file it is on. Indeterminate only before the first event (or while no estimate exists),
 * and never full before the work has ended. */
export interface ProgressDisplayProps {
  label: string; fraction?: number; finished?: boolean; count?: ReactNode; speed?: SpeedInput;
  startedAt?: string; endedAt?: string; left?: string; etaTestId?: string; file?: string;
  heading?: ReactNode; extra?: ReactNode; actions?: ReactNode; className?: string; testId?: string; calm?: boolean; step?: StepKind;
  /** The bar's layers, first stage first: each fills its own color from the left over the stages before it. Without it, `step` draws one layer. */
  stages?: StageLayer[];
  /** Paused or pausing: every layer shows the paused color; the widths stay. */
  paused?: boolean;
  /** Nothing is planned: an empty bar and no percentage. */
  empty?: boolean;
}
export function ProgressDisplay(props: ProgressDisplayProps) {
  const { t, formatNumber } = useTranslation();
  const known = props.fraction !== undefined;
  const shown = known ? (props.finished ? 1 : Math.min(.99, Math.max(0, props.fraction!))) : 0;
  const staged: StageLayer[] = props.stages?.length ? props.stages : props.step ? [{ kind: props.step, fraction: shown }] : !known && !props.empty ? [{ kind: 'scan', fraction: shown }] : [];
  // A finished bar is full in every layer; a running one never shows its last layer full.
  const layers = staged.map((layer, index) => ({ kind: layer.kind, fraction: props.finished ? 1 : Math.min(index === staged.length - 1 ? .99 : 1, Math.max(0, layer.fraction)) }));
  return <div className={`progress-display ${props.className ?? ''} ${props.calm ? 'source-progress-calm' : ''}`} data-progress-display="" {...(props.step ? { 'data-step': props.step } : {})} {...(props.paused ? { 'data-paused': '' } : {})} {...(props.testId ? { 'data-testid': props.testId } : {})}>
    {props.heading}
    <ProgressBar value={shown} indeterminate={!known && !props.empty} label={props.label} layers={layers} />
    <div className="progress-display-line">
      <span className="progress-count" data-testid="progress-count">{props.count ?? t("Starting…")}</span>
      {known && !props.empty && <strong className="progress-percent">{`${formatNumber(shownPercent(props.fraction!, !!props.finished))}%`}</strong>}
      {props.speed && <ProgressSpeed progress={props.speed} />}
      <ProgressTiming startedAt={props.startedAt} endedAt={props.endedAt} left={props.left} etaTestId={props.etaTestId} />
      {props.extra}{props.actions}
    </div>
    <ProgressFile file={props.file} />
  </div>;
}
/** The time-left display holds of this window, one per job id (or other timed operation), so every place that shows a time left shows
 * the same held, rounded value (eta-format's DisplayHold). The main process sends the model's seconds. Without a provider (a component
 * rendered on its own) a time is shown as given. */
export const EtaHolds = createContext<Map<string, DisplayHold> | undefined>(undefined);
type Held = (key: string, seconds: number | undefined) => number | undefined;
export function useHeld(): Held {
  const holds = useContext(EtaHolds);
  return (key, seconds) => {
    if (!holds) return seconds;
    if (seconds === undefined) { holds.delete(key); return undefined; }
    let hold = holds.get(key);
    if (!hold) { hold = new DisplayHold(); holds.set(key, hold); }
    return hold.next(seconds, Date.now());
  };
}
/** Time left for an operation that is not a job (a review, a check, a listing). */
function progressLeft(progress: Pick<Progress, 'eta' | 'total' | 'share'>, t: ReturnType<typeof createTranslator>, eta = progress.eta): string | undefined {
  return eta !== undefined ? t("{time} left", { time: formatRemaining(eta, t) }) : progress.total > 0 || progress.share !== undefined ? t("Estimating time left…") : undefined;
}
/** An operation that is not a job, shown with the shared layout: a review, the backup folder check, the leftover check, the recovery listing.
 * `holdKey` names it for the time-left hold; by default its test id and label. */
export function OperationProgress({ progress, label, testId, className, holdKey }: { progress?: Progress; label: string; testId?: string; className?: string; holdKey?: string }) {
  const { t, formatNumber, formatBytes } = useTranslation();
  const eta = useHeld()(holdKey ?? `${testId ?? ''}:${label}`, progress?.eta);
  if (!progress) return <ProgressDisplay label={label} testId={testId} className={className} />;
  return <ProgressDisplay label={label} testId={testId} className={className} fraction={progressFraction(progress)} count={progressCount(progress, t, formatNumber, false, formatBytes)} speed={progress} startedAt={progress.startedAt} left={progressLeft(progress, t, eta)} file={progress.file} step={stepKind(progress)} />;
}
/** What a stage is called, for the bar's spoken value. */
function stageName(kind: StepKind | 'folder-check', t: ReturnType<typeof createTranslator>): string {
  return { scan: t("Scanning"), read: t("Reading"), compare: t("Comparing"), copy: t("Copying"), move: t("Moving"), verify: t("Verifying"), tidy: t("Tidying"), delete: t("Deleting"), 'folder-check': t("Checking folder") }[kind];
}
/** One fill layer per stage, stacked in the track in order: a finished stage keeps its full-width color and the next one grows over it. */
function ProgressBar({ value, label, indeterminate = false, layers = [] }: { value: number; label: string; indeterminate?: boolean; layers?: StageLayer[] }) {
  const { t, formatNumber } = useTranslation();
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100), top = layers.at(-1);
  return <div className={`progress-track ${indeterminate ? 'progress-discovering' : ''}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} {...(!indeterminate ? { 'aria-valuenow': percent } : {})} {...(!indeterminate && top ? { 'aria-valuetext': t("{stage}, {percent}%", { stage: stageName(top.kind, t), percent: formatNumber(percent) }) } : {})}>{layers.length
    ? layers.map((layer, index) => <span key={index} data-layer="" data-step={layer.kind} style={indeterminate ? { width: '24%' } : { transform: `scaleX(${Math.max(0, Math.min(1, layer.fraction))})` }} />)
    : <span style={indeterminate ? { width: '24%' } : { transform: `scaleX(${Math.max(0, Math.min(1, value))})` }} />}</div>;
}
/** The job has stopped for good: finished, failed or stopped. */
export const ended = (job: Job) => job.phase === 'complete' || job.phase === 'error' || job.phase === 'stopped';
/** Every file was verified and none failed: whatever else ended the job (cleanup leftovers), the copy itself is done. */
export function allVerified(job: Job): boolean {
  const progress = job.progress;
  return !!progress && progress.phase === 'verifying' && !progress.step && progress.total > 0 && progress.completed === progress.total && !progress.failed;
}
/** Complete, or ended with an error only after every file was verified. */
export const jobFinished = (job: Job) => job.phase === 'complete' || (job.phase === 'error' && allVerified(job));
/** The color kind of Scanning, Copying (or Moving) and Verifying; Scanning takes the kind of the sub-step it is on (reading metadata, comparing). */
export function sourceStepKinds(job?: Job): [StepKind, StepKind, StepKind] {
  const lead = job?.progress && job.progress.phase !== 'copying' && job.progress.phase !== 'verifying' ? stepKind(job.progress) : undefined;
  return [lead ?? 'scan', job?.progress?.renames ? 'move' : 'copy', 'verify'];
}
/** One stage of a progress bar: its color kind and how far it is (0 to 1). */
export interface StageLayer { kind: StepKind; fraction: number }
/** The steps of an organization or other job that is not a plain import, in the order they run. */
export const organizationKinds: StepKind[] = ['scan', 'read', 'compare', 'move', 'copy', 'verify', 'tidy', 'delete'];
export const jobPaused = (job: Job) => (job.phase === 'stopped' && !!job.paused) || job.stopping === 'pause';
export interface StagePlan { kinds: StepKind[]; index: number; fraction: number; finished: boolean }
/** The stage a job is on, the stages it passes, and how far the current one is (the step progress the step list uses). */
export function stagePlan(job: Job, verify: boolean): StagePlan | undefined {
  const progress = job.progress, finished = job.phase === 'complete' || jobFinished(job);
  if (!progress && !finished) return undefined;
  if (job.organization || progress?.renames) {
    const index = Math.max(0, organizationKinds.indexOf(stepKind(progress) ?? 'move'));
    return { kinds: organizationKinds, index, fraction: finished ? 1 : progress ? progressFraction(progress) ?? 0 : 0, finished };
  }
  const kinds: StepKind[] = sourceStepKinds(job).filter((_, index) => verify || index < 2);
  const index = finished ? kinds.length - 1 : progress?.phase === 'verifying' ? 2 : progress?.phase === 'copying' || job.phase === 'copying' ? 1 : 0;
  return { kinds, index: Math.min(index, kinds.length - 1), fraction: finished ? 1 : progress ? progressFraction(progress) ?? 0 : 0, finished };
}
export const layersOfPlan = (plan: StagePlan, top = plan.fraction): StageLayer[] => plan.kinds.slice(0, plan.index + 1).map((kind, index) => ({ kind, fraction: index < plan.index ? 1 : top }));
/** A job's bar: one layer per stage up to the one it is on; finished stages are full and the current one is as far as its counter (the percent shown). */
export function jobStageLayers(job: Job, verify = true): StageLayer[] {
  const plan = stagePlan(job, verify);
  return plan ? layersOfPlan(plan) : [];
}
// A scan first lists the card's files, then reads camera metadata from each media file.
// A library organization: planning first (files checked), then moving and verifying, with n of x and %.
// Share done: planning reads use bytes, planning checks and verification use files, copying uses bytes.
/** 100% only once the work is finished: the last file can still be in progress at 99.9%. */
export function shownPercent(fraction: number, finished: boolean): number {
  return finished ? 100 : Math.min(99, Math.floor(Math.max(0, fraction) * 100));
}
/** Steps that count files, not bytes: a rename moves no data, and checks, deletes and downloads read none. */
const fileSteps = ['history', 'earlier', 'later', 'records', 'journals', 'cleaning', 'measuring', 'preparing', 'mirroring', 'confirming', 'existing', 'checking', 'releasing', 'restoring', 'deleting', 'removing', 'stashing', 'tidying', 'downloading'];
/** How far a step is, the same number the count and the percent show. Undefined only while nothing can be estimated. */
export function progressFraction(progress: NonNullable<Job['progress']>): number | undefined {
  const basis = copyBasis(progress);
  // Bytes at zero say nothing yet (a rename moves none): then the files are the measure.
  const files = basis.total ? basis.completed / basis.total : undefined, data = progress.totalBytes && progress.bytes > 0 ? progress.bytes / progress.totalBytes : undefined;
  // Looking for files elsewhere in the backup first lists it: no total yet.
  if (progress.phase === 'planning' && progress.step === 'locating' && !progress.total) return 0;
  // A listing's (or a look-through's) total is an estimate: its share stays below 100% until the step ends and the next begins.
  if (progress.phase === 'planning' && (progress.step === 'listing' || progress.step === 'scanning' || progress.step === 'measuring')) { const share = progress.share ?? files ?? data; return share === undefined ? undefined : Math.min(.99, share); }
  if (progress.phase === 'planning') return progress.step === 'reading' ? data ?? files : files ?? data;
  // A direct copy also confirms the files already in the backup as it goes: its counter counts files, and so does its share.
  return progress.phase === 'verifying' || progress.renames || (progress.step && fileSteps.includes(progress.step)) || confirming(progress) ? files ?? data : data ?? files;
}
/** A copy that confirms files already in the backup as it goes (a direct destination): they are counted in its work. */
const confirming = (progress: NonNullable<Job['progress']>) => progress.phase === 'copying' && !progress.step && !progress.renames && (progress.work?.direct?.present ?? 0) > 0;
/** Copying counts only the files being copied: those already verified on the destination are skipped and shown apart. */
export function copyBasis(progress: NonNullable<Job['progress']>): { completed: number; total: number; skipped: number } {
  const copying = progress.phase === 'copying' && !progress.step && !progress.renames, skipped = copying ? Math.min(progress.skipped ?? 0, progress.total) : 0;
  return { completed: Math.max(0, progress.completed - skipped), total: progress.total - skipped, skipped };
}
export function progressCount(progress: NonNullable<Job['progress']>, t: ReturnType<typeof createTranslator>, formatNumber: (value: number) => string, organization = false, formatBytes?: (value: number) => string): string {
  const basis = copyBasis(progress), counts = { completed: formatNumber(basis.completed), total: formatNumber(basis.total) };
  // While listing, the size found so far is the only other measure.
  if (progress.phase === 'planning' && progress.step === 'listing' && formatBytes) return t("{completed} files found · {size}", { ...counts, size: formatBytes(progress.bytes) });
  if (progress.phase === 'planning' && progress.step === 'reading' && formatBytes && progress.totalBytes) return t("{completed} of {total} files read · {size} of {totalSize}", { ...counts, size: formatBytes(progress.bytes), totalSize: formatBytes(progress.totalBytes) });
  if (progress.step === 'downloading') return t("{completed} of {total} files downloaded", counts);
  if (progress.step === 'removing') return t("{completed} of {total} extra files set aside", counts);
  if (progress.step === 'scanning') return t("{completed} files looked at", counts);
  if (progress.step === 'stashing') return t("Setting aside duplicates: {completed} of {total}", counts);
  if (progress.step === 'fingerprinting') return t("Reading metadata: {completed} of {total} files", counts);
  if (progress.step === 'candidates') return t("Confirming possible duplicates: {completed} of {total} files", counts);
  if (progress.step === 'collisions') return t("Looking for identical files: {completed} of {total} files", counts);
  if (progress.step === 'tidying') return t("Finishing up: {completed} of {total}", counts);
  if (progress.step === 'releasing') return t("{completed} of {total} files released", counts);
  if (progress.step === 'restoring') return t("{completed} of {total} files put back", counts);
  if (progress.step === 'deleting') return t("{completed} of {total} files deleted", counts);
  if (progress.step === 'history') return t("Reading organization history: {completed} of {total} files", counts);
  if (progress.step === 'earlier') return t("Checking the earlier organization: {completed} of {total} records", counts);
  if (progress.step === 'later') return t("Reading later organizations: {completed} of {total}", counts);
  if (progress.step === 'records') return t("Reading earlier organization records: {completed} of {total}", counts);
  if (progress.step === 'journals') return t("Reading earlier organizations: journal {journal} of {journals}, records {completed} of {total}", { ...counts, journal: formatNumber(progress.journal?.index ?? 1), journals: formatNumber(progress.journal?.count ?? 1) });
  if (progress.step === 'cleaning') return t("Removing old record files: {completed} of {total}", counts);
  if (progress.step === 'measuring') return t("Measuring: {completed} files", counts);
  if (progress.step === 'preparing') return t("Preparing destinations: {completed} of {total}", counts);
  if (progress.step === 'mirroring') return t("Comparing the backup with the drive: {completed} of {total}", counts);
  if (progress.step === 'index') return t("Loading the destination index: {size} of {totalSize}", { size: formatBytes ? formatBytes(progress.bytes) : counts.completed, totalSize: formatBytes ? formatBytes(progress.totalBytes) : counts.total });
  if (progress.step === 'confirming') return t("Confirming files before moving: {completed} of {total}", counts);
  if (progress.step === 'comparing') return progress.bytes > 0 && formatBytes ? t("Checking the destination: {completed} of {total} files · {size} read", { ...counts, size: formatBytes(progress.bytes) }) : t("Checking the destination: {completed} of {total} files", counts);
  if (progress.step === 'locating') return progress.total ? t("Looking for files already in the backup: {completed} of {total}", counts) : t("{completed} files found", counts);
  if (progress.step === 'existing') return t("Confirming files already on the destination: {completed} of {total}", counts);
  if (progress.phase === 'planning') return t(progress.step === 'listing' ? "{completed} files found" : progress.step === 'reading' ? "{completed} of {total} files read" : "{completed} of {total} files checked", counts);
  // Verifying also shows how many bytes of the copied files are published.
  if (progress.phase === 'verifying' && progress.work?.totalBytes && formatBytes) return t("{completed} of {total} files verified · {size} of {totalSize}", { ...counts, size: formatBytes(progress.work.bytes), totalSize: formatBytes(progress.work.totalBytes) });
  if (confirming(progress)) return t("{completed} of {total} files copied or confirmed", counts);
  return t(progress.phase === 'verifying' ? "{completed} of {total} files verified" : progress.renames ? "{completed} of {total} files moved" : organization ? "{completed} of {total} files organized" : "{completed} of {total} files copied", counts);
}
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, sec = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
/** Elapsed time and time left side by side: "12:03 elapsed · about 8 min left". Ticks once a second only while
 * running, so just this label re-renders; endedAt shows the total time instead ("Took 1:02:05"). */
export function ProgressTiming({ startedAt, endedAt, left, etaTestId = 'eta' }: { startedAt?: string; endedAt?: string; left?: string; etaTestId?: string }) {
  const { t } = useTranslation();
  const ticking = !!startedAt && !endedAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!ticking) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [ticking]);
  if (!startedAt && !left) return null;
  const time = startedAt ? formatDuration((endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt)) : undefined;
  return <span className="progress-elapsed" data-testid="timing"><Icon icon={Timer} size={12} />{time && <span data-testid="elapsed">{endedAt ? t("Took {time}", { time }) : t("{time} elapsed", { time })}</span>}{time && left && ' · '}{left && <em className="progress-eta" data-testid={etaTestId}>{left}</em>}</span>;
}
/** A job's elapsed time with its time left, and its total time once it ends. */
export function jobTiming(job: Job, t: ReturnType<typeof createTranslator>, held: Held): { startedAt?: string; endedAt?: string; left?: string } {
  const running = isRunning(job), finished = job.phase === 'complete' || job.phase === 'error' || job.phase === 'stopped';
  const startedAt = running || (finished && job.phaseStartedAt) ? job.startedAt : undefined;
  const left = jobRemaining(job, t, held, running);
  return { startedAt, endedAt: finished ? job.phaseStartedAt : undefined, left };
}
/** How far a job's row is: its current step's share, the same work its counter counts (the time left is the whole job's); a finished job is
 * full. Undefined while nothing is measured, so the bar is indeterminate rather than guessed. */
export function cardFraction(job: Job): number | undefined {
  if (job.phase === 'complete' || ended(job) && allVerified(job)) return 1;
  // A listing's total is only an estimate and its counter shows none: no share of the job is claimed yet.
  if (!job.progress || job.progress.phase === 'planning' && job.progress.step === 'listing') return undefined;
  // Full only once finished: a step at its end (or one that failed its last file) is not a finished job.
  const fraction = progressFraction(job.progress);
  return fraction === undefined ? undefined : Math.min(.99, fraction);
}
/** Humane time left: "under a minute", "about 12 min", "about 2 h 15 min", "about 14 h". Minutes round to 5 past 10 min. */
export function formatRemaining(seconds: number, t: ReturnType<typeof createTranslator>): string {
  const bucket = remainingBucket(seconds);
  if (bucket.unit === 'under') return t("under a minute");
  if (bucket.unit === 'min') return t("about {minutes} min", { minutes: bucket.minutes });
  return bucket.unit === 'hm' ? t("about {hours} h {minutes} min", { hours: bucket.hours, minutes: bucket.minutes }) : t("about {hours} h", { hours: bucket.hours });
}
/** A time left as "about 12 min", or "about 2–4 h" while the estimate is still wide. */
export function formatEstimate(seconds: number, t: ReturnType<typeof createTranslator>, range?: { low: number; high: number }): string {
  const wide = range && remainingRange(seconds, range.low, range.high);
  if (!wide) return formatRemaining(seconds, t);
  return wide.unit === 'min' ? t("about {low}–{high} min", { low: wide.low, high: wide.high }) : t("about {low}–{high} h", { low: wide.low, high: wide.high });
}
/** Time left for a running job, held per job id: the job's, or its current step's while the job's is still being estimated
 * (held apart: a step's time is not the job's). A job that is not running lets its holds go. */
function jobRemaining(job: Job, t: ReturnType<typeof createTranslator>, held: Held, running: boolean): string | undefined {
  const progress = running ? job.progress : undefined;
  const all = held(job.id, progress && job.eta), step = held(`${job.id}:step`, progress && job.eta === undefined ? progress.eta : undefined);
  if (!progress) return undefined;
  if (all === undefined && step === undefined) return progress.total > 0 ? t("Estimating time left…") : undefined;
  return t("{time} left", { time: all === undefined ? formatRemaining(step!, t) : formatEstimate(all, t, scaledRange(job.etaRange, job.eta!, all)) });
}
/** The model's range around `raw`, in proportion around the held value shown instead. */
export function scaledRange(range: { low: number; high: number } | undefined, raw: number, shown: number): { low: number; high: number } | undefined {
  const ratio = raw > 0 ? shown / raw : 1;
  return range && { low: range.low * ratio, high: range.high * ratio };
}
/** A speed whose unit holds near a boundary while this display stays on screen (see speedUnit). */
export function Speed({ value }: { value: number }) {
  const { language } = useTranslation();
  const shown = useRef<SpeedUnit | undefined>(undefined);
  const unit = speedUnit(value, shown.current);
  useEffect(() => { shown.current = unit; });
  return <>{formatSpeed(value, language, unit)}</>;
}
/** What a speed display needs: the rates, and the step when it is verification (its bytes are bytes read, so it is labelled). */
export type SpeedInput = Pick<Progress, 'speed' | 'fileRate'> & Partial<Pick<Progress, 'phase' | 'step'>>;
/** Bytes per second with files per second beside it where the step reports both; files per second alone before bytes have a measure. */
function ProgressSpeed({ progress }: { progress: SpeedInput }) {
  const { t, language } = useTranslation();
  const rate = progress.fileRate && progress.fileRate > 0 ? t("{count} files/s", { count: numberIn(progress.fileRate, language, { maximumSignificantDigits: 3 }) }) : undefined;
  if (progress.speed > 0) return <span className="progress-speed" data-testid="speed">{progress.phase === 'verifying' && !progress.step && <>{t("Verify read")} </>}<Speed value={progress.speed} />{rate && <> · <span data-testid="file-rate">{rate}</span></>}</span>;
  return rate ? <span className="progress-speed" data-testid="speed">{rate}</span> : null;
}
export function OrganizationProgress({ job, act, showFile = true }: { job: Job; act?: Dispatch; showFile?: boolean }) {
  const { t, formatNumber, formatBytes } = useTranslation();
  const progress = job.progress, working = isRunning(job), queued = job.phase === 'queued', running = working || queued, paused = job.phase === 'stopped' && !!job.paused;
  const held = useHeld(), fraction = queued ? 0 : cardFraction(job);
  const count = job.stopping ? (job.stopping === 'pause' ? t("Pausing…") : t("Stopping…")) : queued ? t("Queued") : !progress ? undefined : progressCount(progress, t, formatNumber, true, formatBytes);
  const actions = <>{act && running && <Button kind="quiet" icon={Pause} disabled={!!job.stopping} aria-label={t("Pause")} title={t("Pause")} onClick={() => act({ type: 'pause', sourceId: job.source.id })} />}{act && paused && <Button kind="quiet" icon={Play} aria-label={t("Resume")} title={t("Resume")} onClick={() => act({ type: 'continueOrganization', jobId: job.id })} />}{act && running && <Button kind="quiet" icon={Square} disabled={job.stopping === 'stop'} aria-label={t("Stop")} title={t("Stop")} onClick={() => act({ type: 'stop', jobId: job.id })} />}</>;
  return <div className="organization-progress" data-testid="organization-progress">
    <ProgressDisplay label={t("{name} copy progress", { name: job.source.name })} fraction={fraction} finished={jobFinished(job)} count={count}
      speed={working && progress ? progress : undefined} {...jobTiming(job, t, held)} file={showFile && working && progress ? progress.file : undefined} actions={actions} step={job.phase === 'discovering' && !progress ? 'scan' : stepKind(progress)} stages={jobStageLayers(job)} paused={jobPaused(job)} />
    {job.detail && <small>{t(job.detail)}</small>}
  </div>;
}
