import type {DuplicateOperation,DuplicateRemovalPlan,OrganizeOptions,Preferences,Review,Source} from './shared';

/** Remove confirmed duplicates, per kind of run (Settings › After a run): on for library organization and for drive
 * transfers, off for camera imports. Nothing on a camera or camera card is deleted whatever the camera setting says. */
export const duplicateRemovalDefaults:Readonly<Record<DuplicateOperation,boolean>>=Object.freeze({organize:true,drive:true,camera:false});
const duplicateKeys={organize:'removeDuplicatesOrganize',drive:'removeDuplicatesDrive',camera:'removeDuplicatesCamera'} as const satisfies Record<DuplicateOperation,keyof Preferences>;
/** The saved Remove confirmed duplicates choice for one kind of run (its default when none is saved). */
export function duplicateSetting(prefs:Partial<Pick<Preferences,'removeDuplicatesOrganize'|'removeDuplicatesDrive'|'removeDuplicatesCamera'>>|undefined,operation:DuplicateOperation):boolean {
  const value=prefs?.[duplicateKeys[operation]];
  return typeof value==='boolean'?value:duplicateRemovalDefaults[operation];
}

/** A camera import: a USB camera (MTP/PTP) or a card the app lists as camera media (a card with a camera's folders, or
 * removable flash), or any source whose files turn out to be on such a card (`onCameraMedia`, the platform's card test,
 * which also catches a folder reached through a link). Every other import is a drive transfer. */
export function importOperation(source:Pick<Source,'transport'|'camera'|'drive'>,onCameraMedia:boolean):'drive'|'camera' {
  return onCameraMedia||source.transport!=='folder'||source.camera===true||source.drive?.kind==='card'?'camera':'drive';
}

/** What a run does to the files it reads. An import copies and never touches its source. Organizing a
 * folder moves its files (after verification) and removes the originals. The per-run organize options start from
 * Settings (Remove confirmed duplicates for library organization); emptied folders are removed by default. */
export const organizeDefaults:Readonly<OrganizeOptions>=Object.freeze({removeEmptyFolders:true,releaseDuplicates:duplicateRemovalDefaults.organize});
export const freshOrganizeOptions=(prefs?:Partial<Pick<Preferences,'removeDuplicatesOrganize'>>):OrganizeOptions=>({...organizeDefaults,releaseDuplicates:duplicateSetting(prefs,'organize')});

export interface SourcePolicy {
  /** copy: the source is left exactly as it was. move: files are renamed into place and the originals no longer exist at the source. */
  sourceAction:'copy'|'move';
  /** Remove source folders left without user files. */
  removeEmptySourceFolders:boolean;
  /** Remove confirmed duplicates instead of keeping them for undo. */
  releaseDuplicates:boolean;
  /** An import: the default of its review's "delete from the source" checkbox (importDuplicateRemoval). Only a drive
   * transfer is ever asked; a camera import never is. Deleting itself needs the review applied (reviewConfirmsDeletion). */
  removeSourceDuplicates:boolean;
  verifyCopies:boolean;
}
/** `operation`: what kind of import this is (importOperation); unknown counts as a camera import, which deletes nothing. */
export function sourcePolicy(kind:'import'|'reorganize',options:OrganizeOptions=organizeDefaults,prefs?:Partial<Pick<Preferences,'verifyCopies'|'removeDuplicatesDrive'>>,operation?:'drive'|'camera'):SourcePolicy {
  const verifyCopies=prefs?.verifyCopies!==false;
  if(kind==='import') return {sourceAction:'copy',removeEmptySourceFolders:false,releaseDuplicates:false,removeSourceDuplicates:operation==='drive'&&duplicateSetting(prefs,'drive'),verifyCopies};
  return {sourceAction:'move',removeEmptySourceFolders:options.removeEmptyFolders,releaseDuplicates:options.releaseDuplicates,removeSourceDuplicates:false,verifyCopies};
}

/** What an import's review says about its source duplicates (`planned`: the photos and videos already in the library, by the
 * plan). A drive transfer is asked with a checkbox ticked from its setting; a camera import is never asked. */
export function importDuplicateRemoval(operation:'drive'|'camera',policy:Pick<SourcePolicy,'removeSourceDuplicates'>,prefs:Partial<Pick<Preferences,'removeDuplicatesCamera'>>,planned:{files:number;bytes:number}):DuplicateRemovalPlan {
  if(operation==='camera') return {operation,enabled:prefs.removeDuplicatesCamera===true,files:0,bytes:0};
  return {operation,enabled:policy.removeSourceDuplicates,files:planned.files,bytes:planned.bytes,remove:policy.removeSourceDuplicates&&planned.files>0};
}
/** Whether applying this review lets the import delete from its source: only an import review of a drive transfer, shown with
 * files to delete and applied with its box ticked. Nothing else ever does: no automatic, queued or unreviewed import. */
export function reviewConfirmsDeletion(review:Pick<Review,'kind'|'duplicateRemoval'>):boolean {
  const plan=review.kind==='import'?review.duplicateRemoval:undefined;
  return plan?.operation==='drive'&&plan.remove===true&&(plan.files??0)>0;
}
