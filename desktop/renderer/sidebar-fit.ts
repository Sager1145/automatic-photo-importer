/** Measured lines: each full text's natural width, the width it has now, and (optionally) the sidebar width around it. */
export interface SidebarLine {natural:number;available:number;chrome?:number;}
/**
 * The sidebar grows to fit its longest full line (plus the chrome around that line) within its limits;
 * a line that still does not fit at that width uses the short text. `current` is the width the
 * lines were measured at (default: the new width). `floor` is the width already given to the same drives: the
 * sidebar does not shrink below it, so figures that change while copying (free space, speed) never make the
 * sidebar and the page beside it move back and forth.
 */
export function sidebarFit({lines,chrome,minimum,maximum,current,floor}:{lines:SidebarLine[];chrome:number;minimum:number;maximum:number;current?:number;floor?:number}):{width:number;compact:boolean[]} {
 const needed=lines.reduce((most,line)=>Math.max(most,line.natural+(line.chrome??chrome)),0);
 // Rounded up: measured widths are fractional, and rounding down would leave a line a fraction short of fitting.
 const fitted=Math.ceil(Math.min(maximum,Math.max(minimum,lines.length?needed:minimum)));
 const width=floor===undefined?fitted:Math.max(fitted,Math.min(maximum,floor));
 const grown=width-(current??width);
 return {width,compact:lines.map(line=>line.natural>line.available+grown)};
}
