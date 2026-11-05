/** Camera brands by USB vendor id, and the setting each needs before a computer can read its files over USB. Shown with a
 * USB camera that is connected but not answering, or read only in part, on every system. Vendor ids from usb.ids,
 * libgphoto2 and libmtp; settings from each maker's manuals (see docs/cross-platform.md). Leica bodies made by
 * Panasonic use Panasonic's id and settings. Without the right setting a camera connects in a mode that exposes no
 * files (tethering, webcam, RAW conversion) or nothing at all. */
export interface CameraBrand {name:string;vendors:readonly number[];/** An i18n key: the setting to choose on the camera. */hint:string}

export const cameraBrands:readonly CameraBrand[]=[
 {name:'Canon',vendors:[0x04a9],hint:'Canon: turn the camera’s Wi-Fi and Bluetooth fully off, and quit EOS Utility.'},
 {name:'Sony',vendors:[0x054c],hint:'Sony: set Setup › USB › USB Connection Mode to MTP or Mass Storage, with PC Remote off.'},
 {name:'Nikon',vendors:[0x04b0],hint:'Nikon: set Network › USB to MTP/PTP (not iPhone), and keep the camera on.'},
 {name:'Fujifilm',vendors:[0x04cb],hint:'Fujifilm: set Connection Setting › PC Connection Mode to USB Card Reader (not tethering, RAW conversion or webcam).'},
 {name:'Panasonic',vendors:[0x04da],hint:'Panasonic: set Setup › USB Mode to PC(Storage).'},
 {name:'OM System',vendors:[0x07b4,0x33a2],hint:'OM System / Olympus: set USB Settings › USB Mode to Storage or MTP.'},
 {name:'Pentax / Ricoh',vendors:[0x25fb,0x0a17,0x05ca],hint:'Pentax / Ricoh: set USB Connection to MTP or MSC before plugging the camera in.'},
 {name:'Leica',vendors:[0x1a98],hint:'Leica: set USB Mode to Mass Storage (fastest) or PTP.'},
 {name:'Sigma',vendors:[0x1003],hint:'Sigma: set USB Mode to Mass Storage before connecting.'},
 {name:'Hasselblad',vendors:[0x2756],hint:'Hasselblad: choose Mass Storage in the dialog the camera shows when it is connected.'},
 {name:'GoPro',vendors:[0x2672],hint:'GoPro: set Preferences › Connections › USB Connection to MTP.'},
 {name:'DJI',vendors:[0x2ca3],hint:'DJI: accept the connection prompt on the camera, with webcam mode off.'},
 {name:'Insta360',vendors:[0x2e1a],hint:'Insta360: choose USB Drive (U-Disk) mode on the camera.'},
];

/** The brand of a USB vendor id, when it is a known camera maker. */
export function cameraBrand(vendor:number|undefined):CameraBrand|undefined {
 return vendor===undefined?undefined:cameraBrands.find(brand=>brand.vendors.includes(vendor));
}
