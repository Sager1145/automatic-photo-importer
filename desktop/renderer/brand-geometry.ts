// The app logo in 1024-unit icon space. Icon.icon/Assets (the Icon Composer layers) and the React <BrandLogo>
// draw exactly these shapes; desktop/tests/brand-logo.test.ts keeps them identical.
export const brandColors = { card: '#FFF3DA', fold: '#FFD6A3', contact: '#B56A27', contactOff: '#EAD6B4', arrow: '#D45C3D', tileTop: '#F57A52', tileBottom: '#E3522A' } as const;
/** Card 440 x 600 centred on (512, 512); the clipped corner is 72 units. */
export const cardPath = 'M356 212H660L732 284V748A64 64 0 0 1 668 812H356A64 64 0 0 1 292 748V276A64 64 0 0 1 356 212Z';
export const foldPath = 'M660 212V268A16 16 0 0 0 676 284H732Z';
/** Four contacts, 90 apart and centred on x = 512; each is a 28-wide round-capped stroke. */
export const contactXs = [377, 467, 557, 647] as const;
export const contactStroke = 28;
export const contactPath = (x: number) => `M${x} 314V354`;
export const contactsPath = contactXs.map(contactPath).join('');
/** Arrow and tray: 49-wide round strokes. The tray is as wide as the arrow head. */
export const arrowStroke = 49;
export const arrowPath = 'M512 490V632M424 544L512 632L600 544';
export const trayPath = 'M424 695H600';
export const tileRadius = 229;
