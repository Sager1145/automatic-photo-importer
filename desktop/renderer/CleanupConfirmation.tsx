import type {Action,ResidueStatus} from '../shared';
import {ConfirmSheet} from './ui';
import {OperationProgress} from './progress';
import {useTranslation} from './i18n';

type Dispatch=(action:Action)=>void;
/** The scan total includes unbound receipts (zero bytes) and complete recovery copies.
 * Only the remaining files/folders are candidates for removal; cleanup rechecks them. */
export function cleanupPreview(residue:ResidueStatus){
 const resumable=residue.resumable,kept=residue.kept??{files:0,bytes:0},recoverable=residue.recoverable??{files:0,bytes:0},receipts=residue.unbound?.files??0;
 const removable={files:Math.max(0,residue.files-recoverable.files-receipts),bytes:Math.max(0,residue.bytes-recoverable.bytes)};
 return {removable,other:{files:Math.max(0,removable.files-resumable.files-kept.files),bytes:Math.max(0,removable.bytes-resumable.bytes-kept.bytes)},resumable,kept,receipts,recoverable};
}
const locked=(residue:ResidueStatus|undefined,busy:boolean)=>busy||!residue?.checkedAt||!!residue.checking;
/** Called only by the confirmation button, with the latest state shown in the sheet. */
export function confirmCleanup(residue:ResidueStatus|undefined,busy:boolean,act:Dispatch):boolean{
 if(locked(residue,busy))return false;
 act({type:'cleanResidue'});return true;
}
export function CleanupPreview({residue}:{residue?:ResidueStatus}){
 const {t,formatNumber,formatBytes}=useTranslation();
 if(!residue?.checkedAt)return <p>{t("Not checked yet.")}</p>;
 const preview=cleanupPreview(residue);
 return <div data-testid="cleanup-preview">
  <p>{t("Estimated removable files: {count} ({size}).",{count:formatNumber(preview.removable.files),size:formatBytes(preview.removable.bytes)})}</p>
  <dl className="organization-paths">
   <div><dt>{t("Other leftover files and folders")}</dt><dd>{formatNumber(preview.other.files)} · {formatBytes(preview.other.bytes)}</dd></div>
   <div><dt>{t("Resumable staging copies")}</dt><dd>{formatNumber(preview.resumable.files)} · {formatBytes(preview.resumable.bytes)}</dd></div>
   <div><dt>{t("Kept staging copies")}</dt><dd>{formatNumber(preview.kept.files)} · {formatBytes(preview.kept.bytes)}</dd></div>
   <div><dt>{t("Old copy receipts")}</dt><dd>{t("{count} receipts cleared; named files kept",{count:formatNumber(preview.receipts)})}</dd></div>
   <div><dt>{t("Recoverable complete copies")}</dt><dd>{t("{count} retained ({size})",{count:formatNumber(preview.recoverable.files),size:formatBytes(preview.recoverable.bytes)})}</dd></div>
  </dl>
  {preview.recoverable.folder&&<p className="recovery-root">{preview.recoverable.folder}</p>}
  <p>{t("Manual cleanup also deletes resumable and kept staging copies. Re-importing will need to copy them again.")}</p>
  <p>{t("The files named by old copy receipts are kept. Recoverable complete copies are retained.")}</p>
  <p>{t("These amounts come from the latest check. Cleanup checks again and may leave files that changed or are in use.")}</p>
 </div>;
}
/** Pass the raw backend dispatcher here; entry-point buttons should only open this sheet. */
export function CleanupConfirmation({residue,busy,act,onCancel}:{residue?:ResidueStatus;busy:boolean;act:Dispatch;onCancel:()=>void}){
 const {t}=useTranslation();
 return <ConfirmSheet step="second" title={t("Clean up leftover files?")} confirmLabel={t("Delete leftovers and clear receipts")} confirmDisabled={locked(residue,busy)} testId="cleanup-confirmation" confirmTestId="cleanup-confirm" onCancel={onCancel} onConfirm={()=>{if(confirmCleanup(residue,busy,act))onCancel();}}>
  <CleanupPreview residue={residue}/>
  {busy&&<p>{t("Locked while an import, organization or review is active, including paused or queued ones. Finish or stop them to change this.")}</p>}
  {residue?.checking&&<OperationProgress progress={residue.progress} label={t("Leftover files progress")} testId="cleanup-confirm-progress"/>}
 </ConfirmSheet>;
}
