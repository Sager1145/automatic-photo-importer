/** Measured lines: each full text's natural width, the width it has now, and (optionally) the sidebar width around it. */
export interface SidebarLine {natural:number;available:number;chrome?:number;}
/** The width already given to the same drives, and whether it has grown for them yet. */
export interface SidebarHold {width:number;grown:boolean;}
/**
 * Fitting from scratch (no `hold`: first layout, a drive came or went, the window resized): the sidebar grows to
 * fit its longest full line (plus the chrome around that line) within its limits.
 * Holding (the same drives): the width stays as it is. It grows only when a line does not fit, by that line's
 * shortfall, and only once for these drives; it never shrinks. A width derived again from the current width on
 * every render crept up a pixel per progress tick when one line's room did not track the sidebar's width.
 * Either way, a line that still does not fit uses the short text. `current` is the width the lines were measured at
 * (default: the new width).
 */
export function sidebarFit({lines,chrome,minimum,maximum,current,hold}:{lines:SidebarLine[];chrome:number;minimum:number;maximum:number;current?:number;hold?:SidebarHold}):{width:number;compact:boolean[];grown:boolean} {
 let width:number,grownNow=false;
 if(hold){
  const held=Math.min(maximum,Math.max(minimum,hold.width));
  const shortfall=lines.reduce((most,line)=>Math.max(most,line.natural-line.available),0);
  // Rounded up: measured widths are fractional, and rounding down would leave a line a fraction short of fitting.
  if(shortfall>0.5&&!hold.grown){width=Math.ceil(Math.min(maximum,held+shortfall));grownNow=width>held;}
  else width=held;
 }else{
  const needed=lines.reduce((most,line)=>Math.max(most,line.natural+(line.chrome??chrome)),0);
  width=Math.ceil(Math.min(maximum,Math.max(minimum,lines.length?needed:minimum)));
 }
 const grown=width-(current??width);
 return {width,compact:lines.map(line=>line.natural>line.available+grown),grown:grownNow||!!hold?.grown};
}
