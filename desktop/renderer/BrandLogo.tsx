import { useId } from 'react';
import { arrowPath, arrowStroke, brandColors, cardPath, contactPath, contactStroke, contactXs, foldPath, tileRadius, trayPath } from './brand-geometry';

/** The app logo as five vector parts (tile, card, contacts, arrow, tray). The sidebar and the boot animation share it. */
export function BrandLogo({ className }: { className?: string }) {
  const gradient = `logo-tile-${useId().replace(/:/g, '')}`;
  return <svg className={className} viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
    <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={brandColors.tileTop} /><stop offset="1" stopColor={brandColors.tileBottom} /></linearGradient></defs>
    <rect className="logo-tile" width="1024" height="1024" rx={tileRadius} fill={`url(#${gradient})`} />
    <g className="logo-card"><path d={cardPath} fill={brandColors.card} /><path d={foldPath} fill={brandColors.fold} /></g>
    <g className="logo-contacts" fill="none" stroke={brandColors.contact} strokeWidth={contactStroke} strokeLinecap="round">{contactXs.map((x, index) => <path key={x} className="logo-contact" style={{ '--i': index } as React.CSSProperties} d={contactPath(x)} />)}</g>
    <path className="logo-arrow" d={arrowPath} fill="none" stroke={brandColors.arrow} strokeWidth={arrowStroke} strokeLinecap="round" strokeLinejoin="round" />
    <path className="logo-tray" d={trayPath} fill="none" stroke={brandColors.arrow} strokeWidth={arrowStroke} strokeLinecap="round" />
  </svg>;
}
