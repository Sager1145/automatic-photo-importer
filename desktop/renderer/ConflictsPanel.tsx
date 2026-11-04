import { useEffect, useState } from 'react';
import { ChevronDown, CircleAlert, CheckCircle2, CopyPlus, FolderOpen, LoaderCircle, Replace, SkipForward, Square, Undo2 } from 'lucide-react';
import { isLive, type ConflictChoice, type ConflictSummary, type ImportConflict, type Job, type Thumbnail } from '../shared';
import { useTranslation } from './i18n';
import { Button, Icon, type Dispatch } from './ui';

/** Rows shown at first, and added by Show more: an import found again holds thousands. */
export const CONFLICT_PAGE = 200;
const baseName = (file: string) => file.split(/[\\/]/).filter(Boolean).at(-1) ?? file;
const folderOf = (file: string) => { const parts = file.split(/[\\/]/); parts.pop(); return parts.join(file.includes('\\') ? '\\' : '/'); };

/** How long the line confirming a bulk choice stays. */
export const BULK_STATUS_MS = 5000;
const allChosen: Record<ConflictChoice, string> = { skip: "Skip is now chosen for every file ({count}).", overwrite: "Overwrite is now chosen for every file ({count}).", keep: "Keep both is now chosen for every file ({count})." };
const someChosen: Record<ConflictChoice, string> = { skip: "Skip is now chosen for {chosen} of {count} files; files already applied keep their result.", overwrite: "Overwrite is now chosen for {chosen} of {count} files; files already applied keep their result.", keep: "Keep both is now chosen for {chosen} of {count} files; files already applied keep their result." };
/** The line shown after Skip all, Overwrite all or Keep both for all: what the conflicts hold now, so a click that changed
 * nothing (Skip is the default) still says it took. Files already applied keep their choice. */
export function bulkChoiceStatus(summary: Pick<ConflictSummary, 'count' | ConflictChoice>, choice: ConflictChoice): { text: string; params: Record<string, number> } {
  return summary[choice] >= summary.count ? { text: allChosen[choice], params: { count: summary.count } } : { text: someChosen[choice], params: { chosen: summary[choice], count: summary.count } };
}

/** Files of an import whose name the library already holds with the same bytes: not copied, listed one per row while
 * the import runs and after it. Skip is the default; Overwrite and Keep both apply once the import has ended. Nothing waits on the user. */
export function ConflictsPanel({ job, act }: { job: Job; act: Dispatch }) {
  const { t, formatNumber } = useTranslation();
  const summary = job.conflicts;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ImportConflict[]>([]);
  const [shown, setShown] = useState(CONFLICT_PAGE);
  const revision = summary?.revision;
  /** The bulk choice just clicked; `at` restarts the timer when the same button is clicked again. */
  const [bulk, setBulk] = useState<{ choice: ConflictChoice; at: number }>();
  useEffect(() => {
    if (!open || !window.importer?.conflicts) return;
    let current = true;
    void window.importer.conflicts(job.id).then(list => { if (current) setItems(list); }).catch(() => {});
    return () => { current = false; };
  }, [open, job.id, revision]);
  useEffect(() => {
    if (!bulk) return;
    const timer = setTimeout(() => setBulk(undefined), BULK_STATUS_MS);
    return () => clearTimeout(timer);
  }, [bulk]);
  if (!summary?.count) return null;
  const choose = (choice: ConflictChoice, ids?: string[]) => act({ type: 'conflictChoice', jobId: job.id, choice, ...(ids ? { ids } : {}) });
  const chooseAll = (choice: ConflictChoice) => { choose(choice); setBulk({ choice, at: Date.now() }); };
  const status = bulk && bulkChoiceStatus(summary, bulk.choice);
  const running = isLive(job), progress = summary.progress;
  return <section className="conflicts-panel" data-testid="conflicts-panel" aria-label={t("Same name, same contents")}>
    <p className="conflicts-title"><Icon icon={CircleAlert} size={14} />{summary.count === 1 ? t("1 file is already in the library with the same name and contents") : t("{count} files are already in the library with the same name and contents", { count: formatNumber(summary.count) })}</p>
    <p className="conflicts-detail">{running ? t("They are not copied. The import goes on; choose for any of them now, and it is done when the import ends.") : t("They were not copied. Choose for any of them; Overwrite keeps the replaced file in recovery storage until you undo or release it.")}</p>
    <p className="conflicts-counts" data-testid="conflicts-counts">{t("Skip {skip} · Overwrite {overwrite} · Keep both {keep}", { skip: formatNumber(summary.skip), overwrite: formatNumber(summary.overwrite), keep: formatNumber(summary.keep) })}{summary.done > 0 && ` · ${t("{count} done", { count: formatNumber(summary.done) })}`}{summary.failed > 0 && ` · ${t("{count} failed", { count: formatNumber(summary.failed) })}`}</p>
    {summary.applying && <p role="status" data-testid="conflicts-applying"><Icon icon={LoaderCircle} size={14} />{progress?.total ? t("Applying your choices: {completed} of {total}", { completed: formatNumber(progress.completed), total: formatNumber(progress.total) }) : t("Applying your choices…")}</p>}
    {!running && !summary.applying && summary.waiting > 0 && <p data-testid="conflicts-waiting">{t("{count} choices wait to be applied", { count: formatNumber(summary.waiting) })}</p>}
    {summary.stopped && <p data-testid="conflicts-stopped">{t("Stopped: every conflict not applied yet is skipped.")}</p>}
    <div className="rule-actions conflicts-bulk">
      <Button icon={SkipForward} data-testid="conflicts-skip-all" aria-pressed={summary.skip >= summary.count} onClick={() => chooseAll('skip')}>{t("Skip all")}</Button>
      <Button icon={Replace} data-testid="conflicts-overwrite-all" aria-pressed={summary.overwrite >= summary.count} title={t("The library files go to recovery storage; Undo puts them back")} onClick={() => chooseAll('overwrite')}>{t("Overwrite all")}</Button>
      <Button icon={CopyPlus} data-testid="conflicts-keep-all" aria-pressed={summary.keep >= summary.count} title={t("Copies each file under a new name")} onClick={() => chooseAll('keep')}>{t("Keep both for all")}</Button>
      <Button kind="quiet" icon={Square} data-testid="conflicts-stop-all" disabled={!running && !summary.applying} title={t("Skips every conflict not applied yet and stops the import")} onClick={() => act({ type: 'conflictStopAll', jobId: job.id })}>{t("Stop all")}</Button>
    </div>
    <p className="conflicts-bulk-status" role="status" aria-live="polite" data-testid="conflicts-bulk-status">{status && <><Icon icon={CheckCircle2} size={14} />{t(status.text, Object.fromEntries(Object.entries(status.params).map(([key, value]) => [key, formatNumber(value)])))}</>}</p>
    <button type="button" className="source-disclosure-toggle conflicts-toggle" data-testid="conflicts-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}><span className="source-disclosure-label">{open ? t("Hide the files") : t("Show the files")}<Icon icon={ChevronDown} size={16} /></span></button>
    {open && <ul className="conflicts-list" data-testid="conflicts-list">
      {items.slice(0, shown).map(item => <ConflictRow key={item.id} item={item} act={act} jobId={job.id} choose={choose} />)}
    </ul>}
    {open && items.length > shown && <Button kind="quiet" data-testid="conflicts-more" onClick={() => setShown(value => value + CONFLICT_PAGE)}>{t("Show {count} more", { count: formatNumber(Math.min(CONFLICT_PAGE, items.length - shown)) })}</Button>}
  </section>;
}

function ConflictRow({ item, act, jobId, choose }: { item: ImportConflict; act: Dispatch; jobId: string; choose: (choice: ConflictChoice, ids?: string[]) => void }) {
  const { t, formatBytes, language } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [thumbnail, setThumbnail] = useState<Thumbnail>();
  useEffect(() => {
    if (!expanded || thumbnail || !window.importer?.thumbnail) return;
    let current = true;
    void window.importer.thumbnail(item.existing).then(value => { if (current) setThumbnail(value); }).catch(() => {});
    return () => { current = false; };
  }, [expanded, item.existing, thumbnail]);
  const locked = item.state === 'applying' || item.state === 'done';
  const options: [ConflictChoice, string][] = [['skip', t("Skip")], ['overwrite', t("Overwrite")], ['keep', t("Keep both")]];
  const status = item.state === 'applying' ? t("Applying…") : item.state === 'done' ? (item.choice === 'overwrite' ? t("Overwritten") : t("Kept both")) : item.state === 'failed' ? t("Failed") : item.undone ? t("Undone") : undefined;
  return <li className="conflict-row" data-testid="conflict-row" data-conflict-id={item.id} data-state={item.state} data-choice={item.choice}>
    <div className="conflict-row-head">
      <button type="button" className="conflict-row-name" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} title={item.relative}><Icon icon={ChevronDown} size={14} className={expanded ? 'is-open' : ''} /><strong>{baseName(item.relative)}</strong><small>{formatBytes(item.size)}</small></button>
      <div className="conflict-choices" role="group" aria-label={t("Choice for {name}", { name: baseName(item.relative) })}>
        {options.map(([choice, label]) => <button key={choice} type="button" className="conflict-choice" aria-pressed={item.choice === choice} disabled={locked} data-choice={choice} onClick={() => choose(choice, [item.id])}>{label}</button>)}
      </div>
      {status && <span className={`conflict-status is-${item.state}`} data-testid="conflict-status">{item.state === 'done' && <Icon icon={CheckCircle2} size={13} />}{status}</span>}
    </div>
    {item.error && <p className="conflict-error">{item.error}</p>}
    {expanded && <div className="conflict-details" data-testid="conflict-details">
      {thumbnail?.src && <img className="conflict-thumbnail" src={thumbnail.src} alt="" />}
      <dl>
        <div><dt>{t("Incoming file")}</dt><dd>{item.relative}</dd></div>
        <div><dt>{t("In the library")}</dt><dd>{item.existing}<Button kind="quiet" icon={FolderOpen} aria-label={t("Show in folder")} onClick={() => act({ type: 'reveal', path: item.existing })} /></dd></div>
        <div><dt>{t("Folder")}</dt><dd>{folderOf(item.existing)}</dd></div>
        <div><dt>{t("Size")}</dt><dd>{formatBytes(item.size)}</dd></div>
        {item.captureTimeMs !== undefined && <div><dt>{t("Taken")}</dt><dd>{new Date(item.captureTimeMs).toLocaleString(language)}</dd></div>}
        {item.camera && <div><dt>{t("Camera")}</dt><dd>{item.camera}</dd></div>}
        <div><dt>{t("Checked")}</dt><dd title={item.sha256}>{t("Same size and same SHA-256 ({hash}…)", { hash: item.sha256.slice(0, 12) })}</dd></div>
        {item.copy && <div><dt>{t("Copy")}</dt><dd>{item.copy}</dd></div>}
      </dl>
      {item.state === 'done' && item.journal && <Button icon={Undo2} data-testid="conflict-undo" title={t("Puts back the library files this overwrite replaced")} onClick={() => act({ type: 'conflictUndo', jobId, journal: item.journal! })}>{t("Undo overwrite")}</Button>}
    </div>}
  </li>;
}
