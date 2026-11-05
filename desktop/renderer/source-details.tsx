import type { CardContents, Source } from '../shared';
import { mediaKindForPath } from '../media-formats';
import { useTranslation } from './i18n';
import { mediaLabels, sourceKind } from './media-icons';
import { shutterNoteText } from './metadata-display';

/** Below this battery level a camera import may stop before it ends. */
export const LOW_BATTERY = 20;

/** A card's contents by kind, most first: RAW, JPEG, HEIF, other photos, videos, other files. */
export function contentGroups(contents: CardContents): { key: string; files: number; bytes: number }[] {
  const groups = new Map<string, { files: number; bytes: number }>();
  for (const [extension, [files, bytes]] of Object.entries(contents.extensions)) {
    const kind = mediaKindForPath(`file.${extension}`);
    const key = kind === 'RAW' ? '{count} RAW' : kind === 'JPEG' ? '{count} JPEG' : kind === 'HEIF' ? '{count} HEIF' : kind === 'Images' ? '{count} other photos' : kind === 'Videos' ? '{count} videos' : '{count} other files';
    const group = groups.get(key) ?? { files: 0, bytes: 0 };
    group.files += files; group.bytes += bytes; groups.set(key, group);
  }
  const order = ['{count} RAW', '{count} JPEG', '{count} HEIF', '{count} other photos', '{count} videos', '{count} other files'];
  return [...groups].map(([key, group]) => ({ key, ...group })).sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

/** Rows of a source's Drive details: what it is, its room, what its card holds and when it was shot, the camera's
 * battery, shutter count and serial, and a drive's file system and write protection. Only what is known is shown. */
/** `slot`: one card slot inside its camera's card, which shows the camera's own details (battery, shutter count,
 * serial) once: the slot shows its card and storage only. */
export function SourceDetailRows({ source, slot = false }: { source: Source; slot?: boolean }) {
  const { t, language, formatNumber, formatBytes } = useTranslation();
  const details = source.details ?? {};
  const kind = slot ? (source.media ? mediaLabels[source.media] : 'Memory card') : sourceKind(source);
  const date = (ms: number) => new Date(ms).toLocaleDateString(language, { year: 'numeric', month: 'short', day: 'numeric' });
  const contents = details.contents;
  const groups = contents ? contentGroups(contents) : [];
  const files = groups.reduce((sum, group) => sum + group.files, 0), bytes = groups.reduce((sum, group) => sum + group.bytes, 0);
  const rows: [string, string, string][] = [];
  if (kind) rows.push(['kind', t("Type"), t(kind)]);
  if (source.total !== undefined && source.free !== undefined) rows.push(['space', t("Space"), t("{free} free of {total}", { free: formatBytes(source.free), total: formatBytes(source.total) })]);
  if (details.freeImages !== undefined) rows.push(['room', t("Room for"), t("About {count} more photos, as the camera estimates", { count: formatNumber(details.freeImages) })]);
  if (contents) rows.push(['contents', t("On the card"), files ? `${groups.map(group => t(group.key, { count: formatNumber(group.files) })).join(' · ')} · ${formatBytes(bytes)}` : t("No files")]);
  if (contents?.first !== undefined && contents.last !== undefined) rows.push(['dates', t("Taken"), contents.first === contents.last || date(contents.first) === date(contents.last) ? date(contents.first) : `${date(contents.first)} – ${date(contents.last)}`]);
  if (!slot && details.battery !== undefined) rows.push(['battery', t("Battery"), details.battery < LOW_BATTERY ? `${formatNumber(details.battery)} % — ${t("Low: charge or change the battery before a long import.")}` : `${formatNumber(details.battery)} %`]);
  if (!slot && details.shutterCount !== undefined) rows.push(['shutter', t("Shutter count"), `${formatNumber(details.shutterCount)}${details.shutterNote && details.shutterNote !== 'none' ? ` — ${t(shutterNoteText(details.shutterNote))}` : ''}`]);
  if (!slot && details.serial) rows.push(['serial', t("Serial number"), details.serial]);
  if (details.fileSystem) rows.push(['fs', t("File system"), details.fileSystem === 'msdos' ? 'FAT' : details.fileSystem === 'exfat' ? 'exFAT' : details.fileSystem.toUpperCase()]);
  if (details.readOnly) rows.push(['readonly', t("Write-protected"), t("Files can be copied but not deleted from it.")]);
  return <>{rows.map(([key, label, value]) => <div key={key} data-detail={key}><dt>{label}</dt><dd>{value}</dd></div>)}</>;
}
