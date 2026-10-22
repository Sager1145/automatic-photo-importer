/** One folder name per DJI product. Photos record a camera code as EXIF Model ("PP-101",
 * "FC8482", Hasselblad "L1D-20c"); videos record the product in their Encoder with varying spelling
 * ("DJI OsmoPocket3", "DJI Mini5Pro", "DJI DJIMavic3 Enterprise"). Both reach one product name, so a
 * product's photos and videos share one folder. Multi-camera drones list every camera's code.
 *
 * Codes: every row with a real code in https://commons.wikimedia.org/wiki/DJI_camera_model_names
 * (fetched 2026-10-22; rows marked "?", "TBA" or "CAMERANAME" are left out: Matrice 4, Osmo Nano,
 * Osmo 360 and Pocket 4 codes, Phantom 4 RTK SE, Phantom FC40, Inspire 1 Zenmuse Z3). Additions from
 * real EXIF on Wikimedia Commons: AC006 (Category:Taken with DJI Osmo Action 6) and "Osmo 360"
 * (Category:Taken with DJI Osmo 360). Video Encoder names: a real A006 Osmo Pocket 3 clip, winnow
 * PR #295 and published Mini 5 Pro, Action 4/5 Pro/6 and Mavic 3 Enterprise samples. */
const products:[name:string,codes:string[]][]=[
 // Air
 ['DJI Mavic Air',['FC230','FC2103']],
 ['DJI Mavic Air 2',['FC3170']],
 ['DJI Air 2S',['FC3411']],
 ['DJI Air 3',['FC8282','FC8284']],
 ['DJI Air 3S',['FC9113','FC9184']],
 // Avata, Flip, FPV
 ['DJI Avata',['FC8183']],
 ['DJI Avata 2',['FC8485']],
 ['DJI Avata 360',['OQ001E']],
 ['DJI Flip',['FC8582']],
 ['DJI FPV',['FC3305']],
 // Inspire (Zenmuse cameras)
 ['DJI Inspire 1',['FC350','FC550','FC550RAW']],
 ['DJI Inspire 2',['FC6510','FC6520','FC6540']],
 ['DJI Inspire 3',['FC4280']],
 // Lito
 ['DJI Lito 1',['FC9670']],
 ['DJI Lito X1',['FC9589']],
 // Mavic
 ['DJI Mavic Pro',['FC220']],
 ['DJI Mavic 2 Pro',['L1D-20c']],
 ['DJI Mavic 2 Zoom',['FC2220']],
 ['DJI Mavic 2 Enterprise',['FC2204']],
 ['DJI Mavic 2 Enterprise Dual',['FC2403']],
 ['DJI Mavic 2 Enterprise Advanced',['MAVIC2-ENTERPRISE-ADVANCED']],
 ['DJI Mavic 3',['L2D-20c','FC4170']],
 ['DJI Mavic 3 Pro',['FC4382','FC4370']],
 ['DJI Mavic 3 Enterprise',['M3E']],
 ['DJI Mavic 3 Multispectral',['M3M']],
 ['DJI Mavic 3 Thermal',['M3T']],
 ['DJI Mavic 4 Pro',['L3D-100c','FC9284','FC9287']],
 // Mini
 ['DJI Mavic Mini',['FC7203']],
 ['DJI Mini 2',['FC7303']],
 ['DJI Mini 2 SE',['FC7503']],
 ['DJI Mini 4K',['FC7703']],
 ['DJI Mini 3',['FC3682']],
 ['DJI Mini 3 Pro',['FC3582']],
 ['DJI Mini 4 Pro',['FC8482']],
 ['DJI Mini 5 Pro',['FC9313']],
 // Neo, Phantom, Spark, Tello
 ['DJI Neo',['FC8671']],
 ['DJI Neo 2',['FC9470']],
 ['DJI Phantom 2 Vision',['PHANTOM VISION FC200']],
 ['DJI Phantom 3 Advanced',['FC300S']],
 ['DJI Phantom 3 Professional',['FC300X']],
 ['DJI Phantom 3 Standard',['FC300C']],
 ['DJI Phantom 3 4K',['FC300XW']],
 ['DJI Phantom 3 SE',['FC300SE']],
 ['DJI Phantom 4',['FC330']],
 ['DJI Phantom 4 Pro (Advanced)',['FC6310']], // the table lists Phantom 4 Advanced and Pro for one camera
 ['DJI Phantom 4 Pro V2.0',['FC6310S']],
 ['DJI Phantom 4 RTK',['FC6310R']],
 ['DJI P4 Multispectral',['FC6360']],
 ['DJI Spark',['FC1102']],
 ['DJI Ryze Tello',['RZ001']],
 // Osmo handhelds
 ['DJI Osmo Action',['Osmo Action']],
 ['DJI Action 2',['MC211']],
 ['DJI Osmo Action 3',['AC002']],
 ['DJI Osmo Action 4',['AC003']],
 ['DJI Osmo Action 5 Pro',['AC004']],
 ['DJI Osmo Action 6',['AC006']],
 ['DJI Osmo Pocket',['Osmo Pocket']],
 ['DJI Pocket 2',['DJI Pocket']],
 ['DJI Osmo Pocket 3',['PP-101']],
 ['DJI Osmo 360',['Osmo 360']],
];

/** Spelling-insensitive: case, spaces, punctuation and a doubled leading "DJI" are ignored. */
const key=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]/g,'').replace(/^(?:dji)+/,'');
const byCode=new Map<string,string>(),byName=new Map<string,string>();
for(const [name,codes] of products){byName.set(key(name),name);for(const code of codes)byCode.set(key(code),name);}

/** The product for a camera code (any maker: Mavic 2 Pro and Mavic 3 photos say Hasselblad) or, in a
 * DJI context only, for a product name such as a video encoder's, so another maker's "Flip" stays. */
export function djiProduct(value:string,dji:boolean):string|undefined {
  return byCode.get(key(value))??(dji?byName.get(key(value)):undefined);
}
