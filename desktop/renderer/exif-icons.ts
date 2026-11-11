/** One icon per metadata field, shared by the Library browser's preview details and Full EXIF and by the Duplicates
 * page's Full EXIF, so a field looks the same everywhere. Lookup order: the field's English label (the catalog key,
 * before translation), the ExifTool tag name, a few name patterns, the ExifTool -G1 group (`GPS:`, `ExifIFD:`,
 * `MakerNotes`, `XMP-…`), and finally a default, so no field is ever without an icon. */
import {
  Aperture, Barcode, Binary, Building, Calculator, Calendar, CalendarClock, CalendarCog, CalendarPlus, Camera, CircleDot, Clock, CodeXml, Contrast,
  Copyright, Cpu, Crosshair, Eraser, Factory, File, FileArchive, FileClock, FileCode, FileDigit, FileImage, Files, FileType, Film, Flag, Focus,
  FolderOpen, Gauge, Globe, HardDrive, Hash, Image, Images, ImageUpscale, Landmark, Layers, Lens, MapPin, Mountain, MountainSnow, MoveHorizontal,
  MoveVertical, Newspaper, Palette, Ratio, RotateCw, Ruler, RulerDimensionLine, Scan, Settings, Settings2, SlidersHorizontal, Sparkles, SunMedium,
  Tag, Thermometer, Timer, User, Vibrate, Wand, Zap, ZoomIn, type LucideIcon,
} from 'lucide-react';
import { categories, type ExifCategoryId } from './exif-categories';

/** Every field that has no better match. */
export const DEFAULT_EXIF_ICON: LucideIcon = Tag;

/** The Library browser preview's details list, by English label. */
export const DETAIL_LABELS = ['Camera', 'Lens', 'Date', 'Aperture', 'Focal length', 'Shutter speed', 'ISO', 'Shutter count', 'Format', 'Size', 'RAW file', 'Companion files', 'Current path'] as const;

const byLabel: Record<string, LucideIcon> = {
  // Preview details
  Camera, Lens, Date: CalendarClock, Aperture, 'Focal length': RulerDimensionLine, 'Shutter speed': Timer, ISO: Gauge, 'Shutter count': Hash,
  Format: FileType, Size: HardDrive, 'RAW file': FileImage, 'Companion files': Files, 'Current path': FolderOpen,
  // Exposure
  'Exposure compensation': SunMedium, 'Exposure program': SlidersHorizontal, 'Exposure mode': Settings2, 'Metering mode': Crosshair,
  'White balance': Thermometer, Flash: Zap, '35 mm equivalent': Ratio, 'Subject distance': Ruler, 'Digital zoom': ZoomIn, 'Scene type': Mountain,
  // Camera & Lens
  'Camera make': Camera, 'Camera model': Camera, 'Camera serial number': Barcode, 'Internal serial number': Barcode, 'Lens make': Lens,
  'Lens ID': Lens, 'Lens serial number': Barcode, Software: Settings, Firmware: Cpu, Photographer: User, Copyright,
  // Date & Time
  Captured: CalendarClock, 'Sub-seconds': Clock, 'Time zone offset': Globe, Created: CalendarPlus, Modified: CalendarCog,
  'Creation date': CalendarPlus, 'Time zone': Globe,
  // Location
  Latitude: MapPin, Longitude: MapPin, Altitude: MountainSnow, City: Building, 'State or province': Landmark, Country: Flag,
  // Image
  Width: MoveHorizontal, Height: MoveVertical, Resolution: ImageUpscale, Orientation: RotateCw, 'Color space': Palette,
  'Bits per sample': Binary, Compression: FileArchive,
  // Maker Notes
  'Mechanical shutter count': Hash, 'Image count': Images, 'File number': FileDigit, 'Focus mode': Focus, 'Autofocus area': Scan,
  'Vibration reduction': Vibrate, 'Picture style': Wand, Quality: Sparkles, 'Noise reduction': Eraser, 'Active D-Lighting': Contrast,
  'Drive mode': Layers, 'Release mode': CircleDot,
  // File
  'File name': File, 'File type': FileType, 'MIME type': FileCode, 'File size': HardDrive, 'File modified': FileClock,
};

/** ExifTool tag names of the curated view take their label's icon, so a raw `ExifIFD:FNumber` matches the curated Aperture. */
const byTag = new Map<string, LucideIcon>();
for (const category of categories) for (const { tag, label } of category.tags) if (byLabel[label]) byTag.set(tag, byLabel[label]!);

/** Tag names outside the curated list, by pattern. */
const byName: [RegExp, LucideIcon][] = [
  [/^GPS/i, MapPin], [/Lens/i, Lens], [/Serial/i, Barcode], [/Date|Time(?!r)/i, Calendar], [/Focus|^AF/i, Focus], [/Flash/i, Zap],
  [/ISO/, Gauge], [/WhiteBalance|ColorTemp/i, Thermometer], [/Width|Height|Size$/i, ImageUpscale], [/Color|Colour/i, Palette],
];

const makerGroups = /^(?:MakerNotes|Nikon|Canon|Sony|Fujifilm|FujiFilm|Olympus|Panasonic|Pentax|Samsung|Leica|Ricoh|Sigma|Minolta|DJI|Apple|GoPro|Kodak|Casio)/;
const byGroup: [RegExp, LucideIcon][] = [
  [/^GPS/, MapPin], [/^(?:ExifIFD|EXIF|SubIFD)/, Aperture], [/^IFD\d/, Image], [makerGroups, Factory], [/^(?:File|System)$/, File],
  [/^Composite$/, Calculator], [/^XMP/, CodeXml], [/^ICC/, Palette], [/^(?:IPTC|Photoshop)/, Newspaper], [/^(?:QuickTime|Track\d|UserData|Keys|ItemList)/, Film],
  [/^(?:JFIF|JPEG|PNG|RIFF|MPF\d*|APP\d+)/, FileImage],
];

const categoryIcons: Record<ExifCategoryId, LucideIcon> = { exposure: Aperture, camera: Camera, datetime: CalendarClock, location: MapPin, image: Image, maker: Factory, file: File };

/** The icon of a field shown under an English label (the catalog key), if the label is known. */
export const labelIcon = (label: string): LucideIcon | undefined => byLabel[label];
/** The icon of a curated category's heading. */
export const categoryIcon = (id: ExifCategoryId): LucideIcon => categoryIcons[id];
/** The icon of an EXIF field: `key` is a tag name or a -G1 key such as `ExifIFD:FNumber`; `label` the curated English label, when there is one. */
export function exifIcon(key: string, label?: string): LucideIcon {
  if (label && byLabel[label]) return byLabel[label]!;
  const parts = key.split(':'), name = parts.at(-1) ?? key, group = parts.filter(part => !/^Copy\d+$/.test(part)).slice(0, -1).join(':');
  return byTag.get(name) ?? byName.find(([pattern]) => pattern.test(name))?.[1] ?? (group ? byGroup.find(([pattern]) => pattern.test(group))?.[1] : undefined) ?? DEFAULT_EXIF_ICON;
}
