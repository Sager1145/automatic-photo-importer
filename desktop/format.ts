// Number and size formatting shared by the main process (messages) and the renderer. Node-free.
type Locale = string;
const formats = new Map<string, Intl.NumberFormat>();
/** One Intl.NumberFormat per language and options: building one is far slower than formatting with it. */
export function formatNumber(value: number, language: Locale, options?: Intl.NumberFormatOptions): string {
  const key = language + (options ? JSON.stringify(options) : '');
  let format = formats.get(key);
  if (!format) { format = new Intl.NumberFormat(language, options); formats.set(key, format); }
  return format.format(value);
}
export function formatBytes(value = 0, language: Locale = 'en'): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const n = Math.max(0, Math.min(Math.floor(Math.log(value) / Math.log(1000)), 4));
  // Large sizes always keep their decimals ("1.00 TB", "994.7 GB") so capacity differences stay visible.
  const digits = n === 4 ? 2 : n > 1 ? 1 : 0;
  return `${formatNumber(value / 1000 ** n, language, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[n]}`;
}
