/** Folder templates: the tokens and their values, the path builder in Settings, and the rule for the folder
 * names a user types. The template stays the one stored form; core/index.ts folder() applies it to real files
 * and Settings previews it, both through templateValues/expandTemplate here. Node-free, so the renderer shares it. */
export interface FolderPath {
  /** date: <date folders>/<camera>; camera: <camera>/<date folders>. */
  order: 'date' | 'camera';
  year: boolean;
  /** full: the name repeats the year (202610); english: "10 October" instead of 10. */
  month: { on: boolean; full: boolean; english: boolean };
  /** full: the name repeats year and month (20261024). */
  day: { on: boolean; full: boolean };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** Every token's value for one capture day (read as UTC) and camera folder name. Month names are English whatever the app language; the number first keeps calendar order. */
export function templateValues(capture: Date, camera: string): Record<string, string> {
  const year = String(capture.getUTCFullYear()).padStart(4, '0'), month = String(capture.getUTCMonth() + 1).padStart(2, '0'), day = String(capture.getUTCDate()).padStart(2, '0');
  const monthName = `${month} ${MONTHS[capture.getUTCMonth()]}`;
  return { year, month, day, yyyymm: year + month, yyyyMMdd: year + month + day, monthName, yearMonthName: `${year}-${monthName}`, camera };
}
/** Fills a template's tokens; a token without a value stays as written (the caller decides whether that is an error). */
export const expandTemplate = (template: string, values: Record<string, string>) => template.replace(/\{([^{}]+)\}/g, (token, key: string) => Object.hasOwn(values, key) ? values[key]! : token);
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
/** A relative folder path every destination file system accepts: no empty, dotted, padded or reserved part. Throws otherwise. */
export function validateRelative(folder: string): void {
  if (!folder || folder.startsWith('/') || /[\\:\x00-\x1f\x7f]/u.test(folder) || folder.split('/').some(p => !p || p === '.' || p === '..' || p.trim() !== p || /[. ]$/.test(p) || /[<>"|?*]/u.test(p) || DEVICE_NAME.test(p))) {
    throw new Error(`Invalid relative folder: ${folder}`);
  }
}
/** `value` made into one folder name every destination file system accepts (a camera or drive name). */
export function safeComponent(value: string): string {
  let result = value.normalize('NFC').replace(/[\\/:\x00-\x1f\x7f<>"|?*]/gu, '-').trim().replace(/[. ]+$/u, '').slice(0, 120);
  if (!result || result === '.' || result === '..') result = 'Unknown files';
  if (DEVICE_NAME.test(result)) result = '_' + result;
  return result;
}
/** One folder name a user may choose (edited exports, unknown files): `safeComponent` leaves it unchanged (apart from the
 * Unicode form, which macOS file names do not distinguish), and it has no braces, which a template would read as a token. */
export const validFolderName = (name: unknown): name is string => typeof name === 'string' && name.normalize('NFC') === safeComponent(name) && !/[{}]/.test(name);
/** Where edited exports go: the month, the edited folder, then the camera. */
export const editedTemplate = (editedFolder: string) => `{year}/{yyyymm}/${editedFolder}/{camera}`;

export const monthToken = ({ full, english }: FolderPath['month']) => english ? (full ? '{yearMonthName}' : '{monthName}') : (full ? '{yyyymm}' : '{month}');
const dayToken = ({ full }: FolderPath['day']) => full ? '{yyyyMMdd}' : '{day}';

export function buildTemplate(value: FolderPath): string {
  const date = [...(value.year ? ['{year}'] : []), ...(value.month.on ? [monthToken(value.month)] : []), ...(value.day.on ? [dayToken(value.day)] : [])];
  return (value.order === 'date' ? [...date, '{camera}'] : ['{camera}', ...date]).join('/');
}

/** The builder settings that write `template`, or undefined for a template only the custom field can show. */
export function parseTemplate(template: string): FolderPath | undefined {
  const parts = template.split('/'), camera = parts.indexOf('{camera}');
  if (camera !== 0 && camera !== parts.length - 1) return undefined;
  const date = parts.filter((_part, index) => index !== camera);
  const month = date.find(part => ['{month}', '{yyyymm}', '{monthName}', '{yearMonthName}'].includes(part)), day = date.find(part => part === '{day}' || part === '{yyyyMMdd}');
  const value: FolderPath = {
    order: camera === 0 && date.length ? 'camera' : 'date',
    year: date.includes('{year}'),
    month: { on: !!month, full: month ? month === '{yyyymm}' || month === '{yearMonthName}' : true, english: month === '{monthName}' || month === '{yearMonthName}' },
    day: { on: !!day, full: day ? day === '{yyyyMMdd}' : true },
  };
  // Only a template the builder writes back unchanged is the builder's.
  return buildTemplate(value) === template ? value : undefined;
}
