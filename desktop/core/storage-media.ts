/** What kind of medium a mounted drive is, for its icon and description: a memory card by type, a USB flash drive, an
 * external disk, an optical disc or a floppy disk. The same rules on every system; each system's adapter
 * (platform/volumes.ts) supplies what it knows: the model and bus names it reports, whether the medium is removable,
 * its file system and size. A card's type is read from its reader's or its own name ("SDXC Reader", "CFexpress Type B
 * Card", "USB3.0 CRW-SD"); a card the reader does not name stays a memory card. */
export type StorageMedia='camera'|'sd'|'microsd'|'cf'|'cfast'|'cfexpress-a'|'cfexpress-b'|'cfexpress'|'xqd'|'card'|'usb-drive'|'external-disk'|'optical'|'floppy';

export interface MediaEvidence {
 /** Model, product and media names the system reports for the drive, its reader or its medium, joined. */
 model?:string;
 /** The bus or protocol: "USB", "Secure Digital", "mmc", "SD", "ATAPI"... */
 bus?:string;
 /** The medium can be taken out (a card, a stick, a disc). */
 removable?:boolean;
 /** Connected from outside the computer (USB, Thunderbolt, a card slot). */
 external?:boolean;
 /** The system reports an optical drive or disc. */
 optical?:boolean;
 /** The system reports a floppy drive. */
 floppy?:boolean;
 /** The system reports a memory card slot (a card bus, an SD reader). */
 cardSlot?:boolean;
 fsType?:string;
 /** Size in bytes. */
 total?:number;
}

/** The largest floppy disk (2.88 MB), with room for how systems round it. */
const FLOPPY_MAX=3_000_000;

export function storageMedia(evidence:MediaEvidence):StorageMedia|undefined {
 const text=` ${evidence.model??''} ${evidence.bus??''} `.toLowerCase().replace(/[_]/g,' ');
 const fs=(evidence.fsType??'').toLowerCase();
 if(evidence.optical||/cd9660|udf|iso9660|cdfs/.test(fs)||/\b(dvd|cd-?rom|cd-?rw|bd-?(rom|re)|blu-?ray|superdrive|optical)\b/.test(text))return 'optical';
 if(evidence.floppy||/\b(floppy|fdd)\b/.test(text)||/^(fat12|msdos|fat)$/.test(fs)&&evidence.total!==undefined&&evidence.total>0&&evidence.total<=FLOPPY_MAX)return 'floppy';
 // A camera connected as a USB drive (mass storage mode) names itself: "Sony DSC", "Panasonic DMC", "Canon EOS".
 if(/\b(dsc|dmc|digital camera|camera|eos|lumix|olympus|om system|gopro|hero\d+|insta360|osmo|ricoh gr|pentax|hasselblad|leica)\b/.test(text)&&!/reader/.test(text))return 'camera';
 if(/cf\s*express[^a-z0-9]*(type[^a-z0-9]*)?b\b|\bcfe[\s-]?b\b/.test(text))return 'cfexpress-b';
 if(/cf\s*express[^a-z0-9]*(type[^a-z0-9]*)?a\b|\bcfe[\s-]?a\b/.test(text))return 'cfexpress-a';
 if(/cf\s*express|\bcfe\b/.test(text))return 'cfexpress';
 if(/\bxqd\b/.test(text))return 'xqd';
 if(/\bcfast\b/.test(text))return 'cfast';
 if(/micro\s*-?sd|\btf\b|t-?flash|transflash/.test(text))return 'microsd';
 if(/compact\s*flash|(^|[\s/-])cf([\s/-]|$)|cf card/.test(text))return 'cf';
 if(/secure digital|(^|[\s/-])sd(hc|xc|uc)?([\s/-]|$)|sd\/mmc|(^|[\s/-])mmc([\s/-]|$)|sdxc|sdhc/.test(text))return 'sd';
 if(evidence.cardSlot)return 'sd';
 if(/memory\s*stick|xd-?picture|card\s*reader|cardreader|\bcrw\b|multi[\s-]*card|reader/.test(text))return 'card';
 if(evidence.removable&&evidence.external!==false)return 'usb-drive';
 if(evidence.external)return 'external-disk';
 return undefined;
}

/** Memory cards of every type. */
export const isMemoryCard=(media:StorageMedia|undefined)=>!!media&&!['camera','usb-drive','external-disk','optical','floppy'].includes(media);
