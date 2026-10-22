/** The folder path builder in Settings. It only writes and reads folder templates: the template
 * stays the one stored form, and core/index.ts folder() is the one place that applies it. */
export interface FolderPath {
  /** date: <date folders>/<camera>; camera: <camera>/<date folders>. */
  order: 'date' | 'camera';
  year: boolean;
  /** full: the name repeats the year (202610); english: "10 October" instead of 10. */
  month: { on: boolean; full: boolean; english: boolean };
  /** full: the name repeats year and month (20261024). */
  day: { on: boolean; full: boolean };
}

const monthToken = ({ full, english }: FolderPath['month']) => english ? (full ? '{yearMonthName}' : '{monthName}') : (full ? '{yyyymm}' : '{month}');
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
