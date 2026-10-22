import type {OrganizeOptions,Preferences} from './shared';

/** What a run does to the files it reads. An import copies and never touches its source. Organizing a
 * folder moves its files (after verification) and removes the originals. Neither default is read from
 * saved preferences, so an old setting can never flip them; only an explicit choice for one run can. */
export const organizeDefaults:Readonly<OrganizeOptions>=Object.freeze({removeEmptyFolders:true,releaseDuplicates:true});
export const freshOrganizeOptions=():OrganizeOptions=>({...organizeDefaults});

export interface SourcePolicy {
  /** copy: the source is left exactly as it was. move: files are renamed into place and the originals no longer exist at the source. */
  sourceAction:'copy'|'move';
  strategy:'copy'|'rename';
  /** Remove source folders left without user files. */
  removeEmptySourceFolders:boolean;
  /** Remove confirmed duplicates instead of keeping them for undo. */
  releaseDuplicates:boolean;
  verifyCopies:boolean;
}
export function sourcePolicy(kind:'import'|'reorganize',options:OrganizeOptions=organizeDefaults,prefs?:Pick<Preferences,'verifyCopies'>):SourcePolicy {
  const verifyCopies=prefs?.verifyCopies!==false;
  if(kind==='import') return {sourceAction:'copy',strategy:'copy',removeEmptySourceFolders:false,releaseDuplicates:false,verifyCopies};
  return {sourceAction:'move',strategy:'rename',removeEmptySourceFolders:options.removeEmptyFolders,releaseDuplicates:options.releaseDuplicates,verifyCopies};
}
