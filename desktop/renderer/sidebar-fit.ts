/** "342.9 GB/2.00 TB", or "120.5/500.0 GB" when both sizes share a unit: the free/total line for a narrow sidebar. */
export function shortCapacity(free:number,total:number,bytes:(value:number)=>string):string {
 const a=bytes(free),b=bytes(total),unit=(text:string)=>text.match(/\s(\S+)$/)?.[1];
 return unit(a)!==undefined&&unit(a)===unit(b)?`${a.slice(0,-unit(a)!.length-1)}/${b}`:`${a}/${b}`;
}

/** Measured capacity lines: each full text's natural width and the width it has now. */
export interface SidebarLine {natural:number;available:number;}
/**
 * The sidebar grows to fit its longest full line (plus the chrome around it) within its limits;
 * a line that still does not fit at that width uses the short text. `current` is the width the
 * lines were measured at (default: the new width).
 */
export function sidebarFit({lines,chrome,minimum,maximum,current}:{lines:SidebarLine[];chrome:number;minimum:number;maximum:number;current?:number}):{width:number;compact:boolean[]} {
 const widest=lines.reduce((most,line)=>Math.max(most,line.natural),0);
 const width=Math.round(Math.min(maximum,Math.max(minimum,lines.length?widest+chrome:minimum)));
 const grown=width-(current??width);
 return {width,compact:lines.map(line=>line.natural>line.available+grown)};
}
