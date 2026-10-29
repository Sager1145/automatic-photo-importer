/** Measured lines: each full text's natural width, the width it has now, and (optionally) the sidebar width around it. */
export interface SidebarLine {natural:number;available:number;chrome?:number;}
/**
 * The sidebar grows to fit its longest full line (plus the chrome around that line) within its limits;
 * a line that still does not fit at that width uses the short text. `current` is the width the
 * lines were measured at (default: the new width).
 */
export function sidebarFit({lines,chrome,minimum,maximum,current}:{lines:SidebarLine[];chrome:number;minimum:number;maximum:number;current?:number}):{width:number;compact:boolean[]} {
 const needed=lines.reduce((most,line)=>Math.max(most,line.natural+(line.chrome??chrome)),0);
 // Rounded up: measured widths are fractional, and rounding down would leave a line a fraction short of fitting.
 const width=Math.ceil(Math.min(maximum,Math.max(minimum,lines.length?needed:minimum)));
 const grown=width-(current??width);
 return {width,compact:lines.map(line=>line.natural>line.available+grown)};
}
