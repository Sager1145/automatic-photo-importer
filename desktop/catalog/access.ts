import fs from 'node:fs/promises';
import path from 'node:path';
import type {Catalog} from './types';
import {bindingUnchanged,type LibraryBinding} from './coordinator';
import {within} from '../core/paths';
/** Resolves opaque ids using current main-process authorization; no renderer path is accepted. */
export async function resolveCatalogFile(catalog:Catalog,binding:LibraryBinding|undefined,fileId:unknown,validate:(binding:LibraryBinding)=>Promise<boolean>):Promise<string>{
 if(!binding||typeof fileId!=='string'||!fileId||!await bindingUnchanged(binding)||!await validate(binding))throw new Error('Library is unavailable.');
 const record=await catalog.file(binding.library.libraryId,fileId);
 if(!record||record.libraryId!==binding.library.libraryId||!record.relativePath||record.relativePath.includes('\\')||path.posix.isAbsolute(record.relativePath)||record.relativePath.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('File is not in this library.');
 const candidate=path.resolve(binding.root,record.relativePath);if(!within(candidate,binding.root))throw new Error('File is outside the library.');
 const target=await fs.realpath(candidate),stat=await fs.lstat(candidate,{bigint:true});
 if(target!==candidate||!within(target,binding.root)||!stat.isFile()||stat.isSymbolicLink()||!await bindingUnchanged(binding)||!await validate(binding))throw new Error('Library file is unavailable.');
 return target;
}
