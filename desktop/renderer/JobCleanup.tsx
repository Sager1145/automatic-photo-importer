import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { Action, Job, JobLeftovers } from '../shared';
import { cleanupOffered, cleanupWork, leftoverTotal } from '../job-cleanup';
import { Button, ConfirmSheet } from './ui';
import { OperationProgress } from './progress';
import { useTranslation } from './i18n';

type Dispatch = (action: Action) => void;
/** Ready to remove: measured, not measuring or removing, nothing locked, and something to do. */
export const canConfirmJobCleanup = (leftovers: JobLeftovers | undefined, locked: boolean) => !locked && !!leftovers?.checkedAt && !leftovers.checking && !leftovers.cleaning && !leftovers.cleaned && cleanupWork(leftovers);
/** Called only by the confirmation button, with the latest measurement shown in the sheet. */
export function confirmJobCleanup(job: Job, locked: boolean, act: Dispatch): boolean {
  if (!canConfirmJobCleanup(job.leftovers, locked)) return false;
  act({ type: 'cleanJob', jobId: job.id }); return true;
}
/** What Clean up will remove for this job, group by group, as last measured. */
export function JobLeftoversList({ job }: { job: Job }) {
  const { t, formatNumber, formatBytes } = useTranslation();
  const leftovers = job.leftovers;
  if (leftovers?.checking) return <OperationProgress progress={leftovers.progress} label={t("Checking what this job left…")} testId="job-cleanup-progress" />;
  if (leftovers?.error) return <p className="inline-note" data-testid="job-cleanup-error">{t(leftovers.error)}</p>;
  if (!leftovers?.checkedAt) return <p>{t("Not checked yet.")}</p>;
  const total = leftoverTotal(leftovers);
  const row = (label: string, group: { files: number; bytes: number }, id: string) => <div data-testid={`job-cleanup-${id}`}><dt>{label}</dt><dd>{formatNumber(group.files)} · {formatBytes(group.bytes)}</dd></div>;
  return <div data-testid="job-cleanup-preview">
    {cleanupWork(leftovers) ? <p>{t("This deletes {count} files ({size}) that this job made.", { count: formatNumber(total.files), size: formatBytes(total.bytes) })}</p> : <p>{t("This job left nothing to clean up.")}</p>}
    <dl className="organization-paths">
      {row(t("Unfinished copies at the destination"), leftovers.direct, 'direct')}
      {row(t("Staged copies in the records folder"), leftovers.staged, 'staged')}
      {row(t("Organization scratch files"), leftovers.organization, 'organization')}
      {row(t("Camera temporary folders"), leftovers.temporary, 'temporary')}
      <div data-testid="job-cleanup-receipts"><dt>{t("Copy receipts closed")}</dt><dd>{formatNumber(leftovers.receipts)}</dd></div>
    </dl>
    {leftovers.recoverable.files > 0 && <p data-testid="job-cleanup-recoverable">{t("{count} complete copies whose card file changed are kept ({size}).", { count: formatNumber(leftovers.recoverable.files), size: formatBytes(leftovers.recoverable.bytes) })}</p>}
  </div>;
}
/** The confirmation: exactly what will go, and what happens to the job after. */
export function JobCleanupSheet({ job, locked, act, onCancel }: { job: Job; locked: boolean; act: Dispatch; onCancel: () => void }) {
  const { t } = useTranslation();
  const organization = !!job.organization;
  return <ConfirmSheet step="second" title={t("Clean up what this job left?")} confirmLabel={t("Delete leftovers")} confirmDisabled={!canConfirmJobCleanup(job.leftovers, locked)} testId="job-cleanup-confirmation" confirmTestId="job-cleanup-confirm" onCancel={onCancel} onConfirm={() => { if (confirmJobCleanup(job, locked, act)) onCancel(); }}>
    <JobLeftoversList job={job} />
    <p>{t("Only files this job made are removed. Verified copies, the originals and files of other jobs are never touched.")}</p>
    <p data-testid="job-cleanup-after">{organization ? t("Afterwards this organization can't be continued here. Its moves stay recorded in Organization recovery, where you can resume or undo them.") : t("Afterwards this job is stopped. Importing again starts over; files already verified aren't copied again.")}</p>
    {locked && <p data-testid="job-cleanup-locked">{t("Locked while an import, organization or review is running or queued.")}</p>}
  </ConfirmSheet>;
}
/** Clean up on a stopped or paused job's card (and its Activity row): measures, then asks. Disabled while anything runs. */
export function JobCleanup({ job, locked, act }: { job: Job; locked: boolean; act: Dispatch }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!cleanupOffered(job)) return null;
  const busy = !!job.leftovers?.checking || !!job.leftovers?.cleaning;
  return <>
    <Button kind="quiet" icon={Trash2} data-testid="job-cleanup" disabled={locked || busy} title={locked ? t("Locked while an import, organization or review is running or queued.") : t("Remove the partial copies and temporary files this job left")} onClick={() => { act({ type: 'measureJobCleanup', jobId: job.id }); setOpen(true); }}>{job.leftovers?.cleaning ? t("Cleaning up…") : t("Clean up")}</Button>
    {open && <JobCleanupSheet job={job} locked={locked} act={act} onCancel={() => setOpen(false)} />}
  </>;
}
