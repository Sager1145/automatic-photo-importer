/** One folder name per DJI product. Photos record a hardware code as EXIF Model ("PP-101",
 * "FC8482"); videos record the product in their Encoder with varying spelling ("DJI OsmoPocket3",
 * "DJI Mini5Pro", "DJI DJIMavic3 Enterprise"). A code is listed only where a real photo shows it as
 * EXIF Model and a curated source names the product. Codes not listed keep their recorded value,
 * including codes two products share: AC003 (Osmo Action 3 and 4), FC7203 (Mavic Mini and Mini
 * SE), "DJI Pocket" (Pocket 1 and 2) and FC2204/FC2220 (Mavic 2 Zoom vs Enterprise).
 *
 * Sources: Wikimedia Commons "Category:Taken with DJI <code>" (real EXIF) and "Category:DJI <code>"
 * (product), RawTherapee camconst.json, isc.sans.edu/diary/31014, forum.dji.com/thread-136586,
 * winnow PR #295 and a real A006 Osmo Pocket 3 clip (video Encoder names). */
const products:[name:string,photoCodes:string[]][]=[
 // Drones
 ['DJI Mavic Pro',['FC220']],
 ['DJI Mavic Air',['FC2103']], // also RawTherapee camconst, DJI forum DNG
 ['DJI Mavic Air 2',['FC3170']], // also RawTherapee camconst
 ['DJI Air 2S',['FC3411']],
 ['DJI Air 3',['FC8282','FC8284']], // wide and tele
 ['DJI Air 3S',['FC9113','FC9184']],
 ['DJI Mavic 3 Pro',['FC4370','FC4382']],
 ['DJI Mavic 3 Enterprise',[]], // video Encoder "DJI DJIMavic3 Enterprise"
 ['DJI Mavic 4 Pro',['FC9284','FC9287']],
 ['DJI Mini 2',['FC7303']],
 ['DJI Mini 2 SE',['FC7503']],
 ['DJI Mini 3',['FC3682']],
 ['DJI Mini 3 Pro',['FC3582']],
 ['DJI Mini 4K',['FC7703']],
 ['DJI Mini 4 Pro',['FC8482']], // also isc.sans.edu/diary/31014; video Encoder "DJI Mini4 Pro"
 ['DJI Mini 5 Pro',['FC9313']], // video Encoder "DJI Mini5Pro"
 ['DJI Phantom 4',['FC330']],
 ['DJI Avata',['FC8183']],
 ['DJI Avata 2',['FC8485']],
 ['DJI FPV',['FC3305']],
 ['DJI Flip',['FC8582']],
 // Handhelds
 ['DJI Osmo Pocket 3',['PP-101']], // Commons File:DJI_20260105170531_0109_D.jpg; video Encoder "DJI OsmoPocket3"
 ['DJI Osmo Action',[]], // photos record "DJI Osmo Action"
 ['DJI Action 2',['MC211']],
 ['DJI Osmo Action 4',[]], // video Encoder "DJI OsmoAction4"
 ['DJI Osmo Action 5 Pro',['AC004']], // video Encoder "DJI OsmoAction5 Pro"
 ['DJI Osmo Action 6',['AC006']], // video Encoder "DJI OsmoAction6"
 ['DJI Osmo 360',[]], // photos record "Osmo 360"
];

/** Spelling-insensitive: case, spaces, punctuation and a doubled leading "DJI" are ignored. */
const key=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]/g,'').replace(/^(?:dji)+/,'');
const names=new Map<string,string>();
for(const [name,codes] of products)for(const value of [name,...codes])names.set(key(value),name);

/** The product name for a DJI photo code or video encoder name, if known. */
export function djiProduct(value:string):string|undefined {return names.get(key(value));}
