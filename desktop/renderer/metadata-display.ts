import type { Exposure, Language, ShutterNote } from '../shared';
import { parseCapture } from '../capture-time';

export interface CaptureDateTime {date?:string;time?:string;timezone?:string;}
/** Format recorded components without converting the capture offset or using the host timezone. */
export function formatCaptureDateTime(value:string|undefined, language:Language):CaptureDateTime {
  const capture = parseCapture(value);
  if (!capture) return {};
  const [year,month,day,hour=0,minute=0,second=0] = (capture.clock ?? capture.day).split(/[-T:]/).map(Number) as number[];
  const calendar = new Date(0);
  calendar.setUTCFullYear(year!,month!-1,day!);
  calendar.setUTCHours(hour,minute,second,0);
  const date = new Intl.DateTimeFormat(language,{dateStyle:'medium',calendar:'gregory',timeZone:'UTC'}).format(calendar);
  if (!capture.clock) return {date};
  const time = new Intl.DateTimeFormat(language,{hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZone:'UTC'}).format(calendar)+(capture.fraction ? '.'+capture.fraction : '');
  return {date,time,...(capture.zone ? {timezone:capture.zone === 'Z' || capture.zone === '+00:00' ? 'UTC' : `UTC${capture.zone}`} : {})};
}

/** What a shutter count means, as an English catalog key the caller translates. */
export function shutterNoteText(note:ShutterNote):string {
  switch (note) {
    case 'mechanical': return 'Reported mechanical shutter actuations at capture time. Total exposures can be higher.';
    case 'mechanical-total-conflict': return 'Reported mechanical shutter actuations at capture time. Total exposures can be higher. The separate total ShutterCount values disagree.';
    case 'mechanical-conflict': return 'Conflicting mechanical shutter counters were found. Review the individual metadata values.';
    case 'total': return 'Reported ShutterCount at capture time. Its meaning varies by camera and may include electronic exposures; it is not necessarily mechanical actuations.';
    case 'sony-total': return 'Reported ShutterCount at capture time, read with the corrected Sony decoder; not necessarily mechanical actuations.';
    case 'total-conflict': return 'Conflicting ShutterCount values were found across metadata sources.';
    case 'sony-unverified': return 'Shutter count unavailable for this ILCE-7M5 photo: validating its Sony counter requires ExifTool 13.44 or newer and an identified Sony tag.';
    case 'image-count': return 'Shutter count unavailable. Image count is shown separately and does not establish mechanical shutter actuations.';
    case 'none': return 'Shutter count unavailable: no supported counter was exposed in this file’s metadata.';
  }
}

export interface ExposureDisplay {lens?:string;aperture?:string;iso?:string;shutterSpeed?:string;focalLength?:string;exposureCompensation?:string;}
export function formatExposure(exposure:Exposure|undefined, language:Language):ExposureDisplay {
  if (!exposure) return {};
  const number = (value:number,options:Intl.NumberFormatOptions={}) => new Intl.NumberFormat(language,{useGrouping:false,maximumFractionDigits:2,...options}).format(value);
  const positive = (value:number|undefined):value is number => value !== undefined && Number.isFinite(value) && value > 0;
  const display:ExposureDisplay = {};
  if (exposure.lens?.trim()) display.lens = exposure.lens.trim();
  if (positive(exposure.aperture)) display.aperture = `f/${number(exposure.aperture)}`;
  if (positive(exposure.iso)) display.iso = number(exposure.iso);
  if (positive(exposure.focalLength)) display.focalLength = `${number(exposure.focalLength)} mm`;
  if (positive(exposure.exposureTime)) {
    const seconds = exposure.exposureTime;
    const denominator = Math.round(1/seconds);
    const fraction = denominator >= 2 && Math.abs(1/denominator-seconds)/seconds <= 0.001;
    display.shutterSpeed = fraction ? `1/${number(denominator,{maximumFractionDigits:0})} s` : `${number(seconds,{maximumSignificantDigits:4})} s`;
  }
  if (exposure.exposureCompensation !== undefined && Number.isFinite(exposure.exposureCompensation)) display.exposureCompensation = `${number(exposure.exposureCompensation,{signDisplay:'exceptZero'})} EV`;
  return display;
}
