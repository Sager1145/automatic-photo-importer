/** A capture time as the camera recorded it: `day` (YYYY-MM-DD) is the camera's calendar day and is never moved
 * through UTC. `clock` (YYYY-MM-DDTHH:MM:SS) is absent for a day inferred from neighbouring files; `zone` is `Z` or
 * ±HH:MM when an offset was recorded; `fraction` holds the sub-second digits as written. */
export interface CaptureClock {day:string;clock?:string;fraction:string;zone?:string;}

/** Reads Metadata.date (or a date-only day). Folders, comparisons, timestamps and the display all read it here. */
export function parseCapture(value:string|undefined):CaptureClock|undefined {
  const match=value?.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?)?$/);
  if(!match)return undefined;
  const [,year,month,day,hour,minute,second,fraction='',zone]=match;
  const calendar=`${year}-${month}-${day}`,date=new Date(`${calendar}T00:00:00Z`);
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==calendar)return undefined;
  if(hour===undefined)return {day:calendar,fraction:''};
  if(+hour>23||+minute!>59||+second!>59)return undefined;
  const offset=zone===undefined||zone==='Z'?zone:`${zone.slice(0,3)}:${zone.slice(-2)}`;
  if(offset&&offset!=='Z'&&(+offset.slice(1,3)>23||+offset.slice(4)>59))return undefined;
  return {day:calendar,clock:`${calendar}T${hour}:${minute}:${second}`,fraction,...(offset?{zone:offset}:{})};
}

/** The one conversion of a capture time to an instant; a day without a clock is not one.
 * A missing offset describes the user's local camera wall clock. Resolve it at
 * review time and persist the instant so later recovery does not depend on TZ.
 */
export function captureTimestamp(value:string|undefined):number|undefined {
  const capture=parseCapture(value);
  if(!capture?.clock)return undefined;
  const instant=Date.parse(capture.clock+(capture.fraction?'.'+capture.fraction:'')+(capture.zone??''));
  if(!Number.isFinite(instant))return undefined;
  // Reject nonexistent local wall clocks rather than letting Date normalize a DST gap.
  if(!capture.zone){const local=new Date(instant),[year,month,day,hour,minute,second]=capture.clock.split(/[-T:]/).map(Number);if(local.getFullYear()!==year||local.getMonth()+1!==month||local.getDate()!==day||local.getHours()!==hour||local.getMinutes()!==minute||local.getSeconds()!==second)return undefined;}
  return instant;
}
