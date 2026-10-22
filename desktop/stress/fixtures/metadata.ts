import path from 'node:path';
import type {Metadata} from '../../shared';
/** Fake routing metadata for stress fixtures (no ExifTool): the camera from the name, a month from its length. */
export const metadata=async(file:string):Promise<Metadata>=>({camera:/DJI/.test(path.basename(file))?'DJI Mini 4 Pro':'Nikon Z6III',date:`2026-${String(1+path.basename(file).length%12).padStart(2,'0')}-03T12:00:00`,fields:{}});
