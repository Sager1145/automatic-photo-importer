import * as fs from 'node:fs/promises';
import type { SystemFile } from '../shared';

// Files cameras and card devices write for their own bookkeeping. Each pattern is
// anchored to the vendor's folder layout, so the same extension elsewhere on a
// card (a user's .dat, .db or .xml) stays an unknown file the user decides on.
const catalog:(SystemFile & {pattern:RegExp})[]=[
  {id:'nikon-file-list',vendor:'Nikon',label:'Nikon folder file list',pattern:/(?:^|\/)NC_FLLST\.DAT$/i},
  {id:'nikon-card-index',vendor:'Nikon',label:'Nikon card index',pattern:/(?:^|\/)NIKON\d{3}\.DSC$/i},
  {id:'sony-body-data',vendor:'Sony',label:'Sony camera body data',pattern:/(?:^|\/)BODYDATA\.DAT$/i},
  {id:'sony-avf-info',vendor:'Sony',label:'Sony AVCHD/still index',pattern:/(?:^|\/)AVF_INFO\/AVIN\d{4}\.(?:BNP|INP|INT)$/i},
  {id:'sony-database',vendor:'Sony',label:'Sony card database',pattern:/(?:^|\/)PRIVATE\/DATABASE\/DATABASE\.BIN$/i},
  {id:'sony-card-index',vendor:'Sony',label:'Sony card identifier',pattern:/(?:^|\/)(?:PRIVATE\/)?SONY\/SONYCARD\.IND$/i},
  {id:'sony-clip-catalog',vendor:'Sony',label:'Sony XAVC clip catalog',pattern:/(?:^|\/)(?:PRIVATE\/)?M4ROOT\/MEDIAPRO\.XML$/i},
  {id:'fujifilm-transfer',vendor:'Fujifilm',label:'Fujifilm transfer list',pattern:/(?:^|\/)FFDB\/FFXFER\.DAT$/i},
  {id:'fujifilm-database',vendor:'Fujifilm',label:'Fujifilm camera database',pattern:/(?:^|\/)FFDB\/FFDB_[^/]+\.db$/i},
  {id:'canon-catalog',vendor:'Canon',label:'Canon card catalog',pattern:/(?:^|\/)(?:EOSMISC|CANONMSC)\/[^/]+\.CTG$/i},
  {id:'dpof-print-order',vendor:'Other device',label:'Print order (DPOF)',pattern:/(?:^|\/)MISC\/[^/]+\.MRK$/i},
  {id:'sony-xavc-thumbnail',vendor:'Sony',label:'Sony XAVC clip thumbnail',pattern:/(?:^|\/)PRIVATE\/M4ROOT\/THMBNL\/[^/]*T01\.JPG$/i},
  {id:'p2-icon',vendor:'Panasonic',label:'Panasonic P2 clip icon',pattern:/(?:^|\/)CONTENTS\/ICON\/[^/]+\.BMP$/i},
  {id:'p2-last-clip',vendor:'Panasonic',label:'Panasonic P2 last clip',pattern:/(?:^|\/)CONTENTS\/LASTCLIP\.TXT$/i},
  {id:'avchd-index',vendor:'AVCHD',label:'AVCHD playlist and clip index',pattern:/(?:^|\/)BDMV\/(?:BACKUP\/)?(?:CLIPINF\/[^/]+\.CPI|PLAYLIST\/[^/]+\.MPL|INDEX\.BDM|MOVIEOBJ\.BDM)$/i},
  {id:'canon-xf-index',vendor:'Canon',label:'Canon XF clip index',pattern:/(?:^|\/)CONTENTS\/(?:CLIPS\d+\/[^/]+\.(?:CIF|SIF)|INDEX\.MIF)$/i},
  {id:'device-license',vendor:'Other device',label:'Device license text',pattern:/(?:^|\/)PMHOME\/LICENSE\/[^/]+\.(?:TXT|RST)$/i},
];
const finderAlias:SystemFile={id:'macos-alias',vendor:'macOS',label:'Finder alias'};
const aliasMagic=Buffer.from('book\0\0\0\0mark','latin1');

/** Match a source-relative path (either separator) against the catalog. */
export function knownSystemFile(relative:string):SystemFile|undefined {
  const normalized=relative.split('\\').join('/');
  const match=catalog.find(entry=>entry.pattern.test(normalized));
  return match && {id:match.id,vendor:match.vendor,label:match.label};
}
/** Finder aliases are small bookmark files; only their first 12 bytes are read. */
export async function finderAliasFile(file:string,size:number):Promise<SystemFile|undefined> {
  if(size<aliasMagic.length || size>1024*1024) return undefined;
  const handle=await fs.open(file,'r');
  try {
    const head=Buffer.alloc(aliasMagic.length);
    const {bytesRead}=await handle.read(head,0,head.length,0);
    return bytesRead===head.length && head.equals(aliasMagic) ? finderAlias : undefined;
  } finally { await handle.close(); }
}
