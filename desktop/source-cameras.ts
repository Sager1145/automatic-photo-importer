import type { Inventory, InventoryFile, Metadata, Source, SourceCameraInfo } from './shared';

type CameraHint = SourceCameraInfo['hints'][number];
const vendors:Record<string,string> = {
  NEF:'Nikon', NRW:'Nikon', ARW:'Sony', SR2:'Sony', SRF:'Sony',
  CR2:'Canon', CR3:'Canon', CRW:'Canon', RAF:'Fujifilm', ORF:'Olympus',
  RW2:'Panasonic', PEF:'Pentax',
};
const makers:Record<string,string> = {
  nikon:'Nikon', sony:'Sony', canon:'Canon', fujifilm:'Fujifilm', fuji:'Fujifilm',
  olympus:'Olympus', 'om system':'OM System', panasonic:'Panasonic', lumix:'Panasonic',
  pentax:'Pentax', ricoh:'Ricoh', leica:'Leica', hasselblad:'Hasselblad',
  gopro:'GoPro', dji:'DJI', sigma:'Sigma', kodak:'Kodak',
};
function mediaFiles(inventory:Inventory):InventoryFile[] {
  return inventory.files.filter(file => file.kind !== 'Other' && !file.companionOf);
}
function driveCameraName(label:string):string|undefined {
  const normalized = label.replace(/_/g,' ').replace(/\s+/g,' ').trim();
  const maker = /(?:^|[^a-z0-9])(nikon|sony|canon|fujifilm|fuji|olympus|om system|panasonic|lumix|pentax|ricoh|leica|hasselblad|gopro|dji|sigma|kodak)(?=$|[^a-z0-9])/i.exec(normalized);
  if (!maker) return undefined;
  // Keep the complete volume label: this is an unconfirmed drive-name hint,
  // and valid models can contain single letters or a user-added volume suffix.
  const start = maker.index + maker[0].length - maker[1].length;
  return normalized.slice(0,start) + makers[maker[1].toLowerCase()] + normalized.slice(start + maker[1].length);
}

/** Hints describe the drive and format evidence; they never confirm a camera model. */
export function inferCameraHints(source:Source, inventory:Inventory):CameraHint[] {
  const hints:CameraHint[] = [];
  const seen = new Set<string>();
  function add(name:string,evidence:CameraHint['evidence']) {
    const key = `${evidence}:${name.toLowerCase()}`;
    if (!seen.has(key)) { seen.add(key); hints.push({name,evidence}); }
  }
  const driveName = driveCameraName(source.name);
  if (driveName) add(driveName,'drive-name');
  for (const file of mediaFiles(inventory)) {
    const extension = file.relative.match(/\.([^.\\/]+)$/)?.[1].toUpperCase();
    if (extension && vendors[extension]) add(vendors[extension],'file-type');
  }
  for (const file of inventory.files) {
    const components = file.relative.split(/[\\/]/);
    if (components.slice(0,-1).some(part => /^(M4ROOT|XDROOT)$/i.test(part))) add('Sony','camera-layout');
    if (/^NIKON001\.DSC$/i.test(components.at(-1) ?? '')) add('Nikon','camera-layout');
  }
  return hints;
}

/** Read each media file once. The supplied reader must disable preview extraction. */
export async function analyzeSourceCameras(
  source:Source,
  inventory:Inventory,
  readMetadata:(path:string)=>Promise<Metadata>,
  signal?:AbortSignal,
  onUpdate?:(summary:SourceCameraInfo)=>void,
):Promise<SourceCameraInfo> {
  const files = mediaFiles(inventory);
  const hints = inferCameraHints(source,inventory);
  const models = new Map<string,SourceCameraInfo['models'][number]>();
  const lenses = new Map<string,SourceCameraInfo['models'][number]>();
  let noLens = 0;
  let checked = 0;
  let lastUpdate = Date.now();
  let unknown = 0;
  let failures = 0;
  const issues: {path:string;message:string}[] = [];
  function summary(status:SourceCameraInfo['status']):SourceCameraInfo {
    return {status,...(issues.length?{issues:issues.map(issue=>({...issue}))}:{}),hints:hints.map(hint=>({...hint})),models:[...models.values()].map(model=>({...model})).sort((a,b)=>a.name.localeCompare(b.name)),lenses:[...lenses.values()].map(lens=>({...lens})).sort((a,b)=>b.files-a.files||a.name.localeCompare(b.name)),noLens,checked,total:files.length,unknown,...(failures ? {error:`${failures} media ${failures === 1 ? 'file' : 'files'} could not be read.`} : {})};
  }
  onUpdate?.(summary('reading'));
  for (const file of files) {
    if (signal?.aborted) break;
    let metadata:Metadata|undefined;
    try { metadata = await readMetadata(file.path); const error=Object.entries(metadata.fields).find(([key])=>key.split(':').at(-1)==='Error')?.[1]; if(error)throw new Error(String(error)); }
    catch (error) {
      if (signal?.aborted) break;
      failures += 1; issues.push({path:file.path,message:error instanceof Error?error.message:String(error)});
    }
    const name = metadata?.camera?.trim().replace(/\s+/g,' ');
    if (name && !/^(unknown(?: camera)?|not (available|recorded)|n\/a)$/i.test(name)) {
      const key = name.toLowerCase();
      const model = models.get(key) ?? {name,files:0,bytes:0};
      model.files += 1; model.bytes += file.size; models.set(key,model);
    } else unknown += 1;
    // Exact lens strings only: different LensID/LensModel spellings are not merged.
    const lens = metadata?.exposure?.lens?.trim().replace(/\s+/g,' ');
    if (lens) {
      const key = lens.toLowerCase();
      const entry = lenses.get(key) ?? {name:lens,files:0,bytes:0};
      entry.files += 1; entry.bytes += file.size; lenses.set(key,entry);
    } else noLens += 1;
    checked += 1;
    if (checked % 8 === 0 || Date.now()-lastUpdate>1000) {lastUpdate=Date.now();onUpdate?.(summary('reading'));}
  }
  const result = summary(signal?.aborted ? 'stopped' : failures ? 'error' : 'complete');
  onUpdate?.(result);
  return result;
}
