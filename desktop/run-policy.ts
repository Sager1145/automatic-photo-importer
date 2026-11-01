import type {DuplicateOperation,OrganizeOptions,Preferences,Source} from './shared';

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
  /** An import: after it finished clean, delete the source files it found already in the library (each checked again
   * at the source and in the library first). Only a drive transfer ever does; a camera import never does. */
  removeSourceDuplicates:boolean;
  verifyCopies:boolean;
}
/** `operation`: what kind of import this is (importOperation); unknown counts as a camera import, which deletes nothing. */
export function sourcePolicy(kind:'import'|'reorganize',options:OrganizeOptions=organizeDefaults,prefs?:Partial<Pick<Preferences,'verifyCopies'|'removeDuplicatesDrive'>>,operation?:'drive'|'camera'):SourcePolicy {
  const verifyCopies=prefs?.verifyCopies!==false;
  if(kind==='import') return {sourceAction:'copy',removeEmptySourceFolders:false,releaseDuplicates:false,removeSourceDuplicates:operation==='drive'&&duplicateSetting(prefs,'drive'),verifyCopies};
  return {sourceAction:'move',removeEmptySourceFolders:options.removeEmptyFolders,releaseDuplicates:options.releaseDuplicates,removeSourceDuplicates:false,verifyCopies};
}
