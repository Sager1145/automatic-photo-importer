// Settings › Devices › Drive formats: each connected drive's file system, whether this computer reads and writes it
// without extra software, and for a format it cannot write, the open-source drivers people can install themselves.
// The app never downloads or installs a driver; a driver's page opens in the user's browser (main allows only these links).
import { ExternalLink, HardDrive, Info } from 'lucide-react';
import type { AppState, ConnectedFormat } from '../shared';
import { driveFormat, driverOptions, formatLabel, FORMAT_TRAITS, nativeAccess, type Access, type DriveFormat, type DriverOption } from '../core/drive-formats';
import { useTranslation } from './i18n';
import { Button, CardHeader, Icon, type Dispatch } from './ui';

/** The formats people bring, in the order the list shows them. */
const COMMON: DriveFormat[] = ['exfat', 'fat', 'ntfs', 'apfs', 'hfs', 'ext', 'btrfs'];

function useAccessText() {
  const { t } = useTranslation();
  return (access: Access, readOnly?: boolean) => readOnly && access === 'readwrite' ? t("Mounted read-only") : access === 'readwrite' ? t("Reads and writes here") : access === 'read' ? t("Read only here") : t("Not readable here without a driver");
}

function Drivers({ format, platform, act }: { format: DriveFormat; platform: string; act: Dispatch }) {
  const { t } = useTranslation();
  const options = driverOptions(format, platform);
  if (!options.length) return <p className="settings-row-note drive-format-none">{t("No open-source driver can write this format on this computer. Use the drive on a computer that can, or copy the photos to an exFAT drive.")}</p>;
  return <ul className="drive-format-drivers" data-testid={`drive-format-drivers-${format}`}>{options.map(option => <DriverRow key={option.id} option={option} act={act} />)}</ul>;
}

function DriverRow({ option, act }: { option: DriverOption; act: Dispatch }) {
  const { t } = useTranslation();
  const risk = { low: t("Low risk"), medium: t("Some risk: back up first"), high: t("High risk: not for backups") }[option.risk];
  return <li data-testid="drive-format-driver" data-driver={option.id}>
    <div className="drive-format-driver-heading">
      <Button kind="quiet" icon={ExternalLink} onClick={() => act({ type: 'openDriverLink', url: option.url })} title={option.url}>{option.name}</Button>
      <span className="muted">{option.access === 'readwrite' ? t("Read and write") : t("Read only")} · {option.license} · {risk}</span>
    </div>
    <p className="settings-row-note">{t(option.note)}</p>
    {option.install.length > 0 && <ol className="drive-format-install">{option.install.map(step => <li key={step}><code>{step}</code></li>)}</ol>}
  </li>;
}

function ConnectedDrive({ drive, platform, act }: { drive: ConnectedFormat; platform: string; act: Dispatch }) {
  const { t } = useTranslation();
  const accessText = useAccessText();
  const format = driveFormat(drive.fsType), access = nativeAccess(format, platform);
  const writable = access === 'readwrite' && !drive.readOnly;
  return <li data-testid="drive-format-connected" data-format={format ?? 'unknown'} data-access={access}>
    <div className="drive-format-driver-heading"><strong>{drive.name}</strong><span className="muted">{drive.path} · {formatLabel(format, drive.fsType)}{drive.system ? ` · ${t("This computer's disk")}` : ''}</span><span className={writable ? 'drive-format-ok' : 'drive-format-warn'}>{accessText(access, drive.readOnly)}</span></div>
    {format === 'fat' && <p className="settings-row-note">{t("FAT32 cannot hold a file larger than 4 GB. An import with such a file is refused before anything is copied.")}</p>}
    {format === 'fuse' && <p className="settings-row-note">{t("Mounted by a FUSE driver. Before it is used as a destination, the app writes, reads back, renames and deletes a test file on it.")}</p>}
    {!writable && access !== 'readwrite' && format && format !== 'fuse' && format !== 'other' && <Drivers format={format} platform={platform} act={act} />}
  </li>;
}

export function DriveFormats({ state, act }: { state: AppState; act: Dispatch }) {
  const { t } = useTranslation();
  const accessText = useAccessText();
  const platform = state.platform, drives = state.driveFormats ?? [];
  return <section className="settings-section" data-testid="drive-formats"><CardHeader icon={HardDrive} title={t("Drive formats")} /><div className="settings-section-content">
    <p className="settings-explanation"><Icon icon={Info} size={14} />{t("exFAT is read and written by macOS, Windows and Linux without extra software: the best format for a drive that moves between them.")}</p>
    <h4 className="path-builder-heading">{t("Connected drives")}</h4>
    {drives.length ? <ul className="drive-format-list">{drives.map(drive => <ConnectedDrive key={drive.path} drive={drive} platform={platform} act={act} />)}</ul> : <p className="muted">{t("No drives found.")}</p>}
    <details className="drive-format-all" data-testid="drive-format-all">
      <summary>{t("All common formats on this computer")}</summary>
      <ul className="drive-format-list">{COMMON.map(format => {
        const access = nativeAccess(format, platform), limit = FORMAT_TRAITS[format].maxFileBytes;
        return <li key={format} data-testid="drive-format-row" data-format={format} data-access={access}>
          <div className="drive-format-driver-heading"><strong>{FORMAT_TRAITS[format].label}</strong><span className={access === 'readwrite' ? 'drive-format-ok' : 'drive-format-warn'}>{accessText(access)}</span>{limit !== undefined && <span className="muted">{t("Files up to 4 GB")}</span>}</div>
          {access !== 'readwrite' && <Drivers format={format} platform={platform} act={act} />}
        </li>;
      })}</ul>
    </details>
    <p className="settings-row-note">{t("The app never downloads or installs drivers and never changes security settings. Install a driver yourself from its project page, which opens in your browser. Third-party drivers can lose data: keep another copy, and the app tests every destination before using it.")}</p>
  </div></section>;
}
